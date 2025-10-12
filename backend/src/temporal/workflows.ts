import { proxyActivities, defineSignal, defineUpdate, setHandler, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation } from '@temporalio/workflow';
import { Capability, SendMessageParams, SaveLedgerInput, StartSessionParams, QueueItem, ParsedLedgerProposalResult, SaveMessageArgs, InitializeSessionArgs } from '../types';

/**
 * 工作流模式說明：
 * 
 * 採用 Entity/Virtual Actor 模式，每個 sessionId 對應一個長駐 Workflow 實體。
 * 
 * 設計原則：
 * - Workflow 只負責決策與協調（確定性邏輯）
 * - 所有 I/O 操作（OpenAI、DB）都委派給 Activities
 * - 使用內存佇列 + condition 串行處理訊息，確保順序一致性
 * - 支持幂等性：使用 requestId 防止重複處理
 */

// ==================== 常量配置 ====================
const ACTIVITY_CONFIG = {
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    backoffCoefficient: 2
  }
} as const;

const IDEMPOTENCY_CONFIG = {
  maxCachedRequestIds: 1000,
  maxStateSizeBytes: 100000,
  duplicateMessage: '该消息已处理',
} as const;

// ==================== Activity 介面定義 ====================
interface ChatActivities {
  decideCapability: (userMessage: string) => Promise<Capability>;
  chatReply: (userMessage: string) => Promise<string>;
  weatherReply: (userMessage: string) => Promise<string>;
  parseLedgerProposal: (args: SendMessageParams) => Promise<ParsedLedgerProposalResult>;
  saveLedger: (args: SaveLedgerInput) => Promise<string>;
  queryLedgerRange: (args: SendMessageParams) => Promise<string>;
  saveMessage: (params: SaveMessageArgs) => Promise<void>;
  initializeSession: (params: InitializeSessionArgs) => Promise<void>;
}

const activities = proxyActivities<ChatActivities>(ACTIVITY_CONFIG);

// ==================== Update 和 Signal 定義 ====================
const sendMessageUpdate = defineUpdate<string, [SendMessageParams]>('sendMessage');
const cancelSignal = defineSignal('cancel');

// ==================== 工具函數（Workflow 外部）====================

/**
 * 判斷是否為業務錯誤
 */
function isBusinessError(msg: string): boolean {
  return msg.includes('Not a ledger')
    || msg.includes('Invalid date')
    || msg.includes('Unsupported range');
}

/**
 * 儲存系統訊息（取消/錯誤）
 */
async function saveSystemMessage(
  sessionId: string,
  content: string,
  timestamp: number
): Promise<void> {
  await activities.saveMessage({
    sessionId,
    role: 'system',
    content,
    timestamp
  });
}

/**
 * 錯誤處理
 */
async function handleError(err: any, item: QueueItem): Promise<void> {
  // 取消錯誤
  if (isCancellation(err)) {
    item.completion.resolve('已取消');
    await saveSystemMessage(item.sessionId, '已取消', item.startedAtMs);
    return;
  }

  // 一般錯誤
  const msg = String(err?.message ?? 'Unknown error');
  const errorMsg = isBusinessError(msg) ? `處理失敗：${msg}` : `系統錯誤：${msg}`;

  await saveSystemMessage(item.sessionId, errorMsg, item.startedAtMs);
  item.completion.resolve(errorMsg);
}

/**
 * 根據能力生成回覆
 */
async function generateReply(
  capability: Capability,
  item: QueueItem,
  timestamp: number
): Promise<string> {
  switch (capability) {
    case 'weather':
      return await activities.weatherReply(item.text);

    case 'ledger_proposal': {
      const ledger = await activities.parseLedgerProposal({
        userId: item.userId,
        sessionId: item.sessionId,
        text: item.text,
        startedAtMs: timestamp,
        requestId: item.requestId,
      });
      return JSON.stringify({
        __kind: 'ledger_proposal',
        proposal: {
          userId: ledger.userId,
          sessionId: ledger.sessionId,
          title: ledger.title,
          amountCents: ledger.amountCents,
          occurredAtMs: ledger.occurredAtMs,
        },
        explain: ledger.explain
      });
    }

    case 'ledger_query':
      return await activities.queryLedgerRange(item);

    case 'chat':
    default:
      return await activities.chatReply(item.text);
  }
}

/**
 * 處理確認記帳訊息
 * 
 * @param item - 佇列項目（包含確認記帳的特殊格式訊息）
 * @param timestamp - 訊息時間戳
 * @returns 記帳確認結果
 */
async function processConfirmLedger(item: QueueItem, timestamp: number): Promise<string> {
  // 解析 proposal 數據
  const proposalJson = item.text.substring('__CONFIRM_LEDGER__:'.length);
  const proposal = JSON.parse(proposalJson) as {
    userId: string;
    sessionId: string;
    title: string;
    amountCents: number;
    occurredAtMs: number;
  };

  // 儲存用戶確認訊息（顯示為"確認記帳"）
  await activities.saveMessage({
    sessionId: item.sessionId,
    role: 'user',
    content: '確認記帳',
    timestamp,
    messageId: `user-${item.requestId}`,
  });

  // 執行記帳
  const result = await activities.saveLedger({
    userId: proposal.userId,
    sessionId: proposal.sessionId,
    title: proposal.title,
    amountCents: proposal.amountCents,
    occurredAtMs: proposal.occurredAtMs,
    requestId: item.requestId,
  });

  // 儲存確認結果訊息
  await activities.saveMessage({
    sessionId: item.sessionId,
    role: 'assistant',
    content: result,
    timestamp,
    messageId: `assistant-${item.requestId}`,
  });

  return result;
}

function performContinueAsNew(idsToKeep: string[], originalTotal: number, sessionId: string, startedAtMs: number) {
  const kept = idsToKeep.length;
  const size = JSON.stringify(idsToKeep).length;
  console.log(`[ContinueAsNew] ${kept}/${originalTotal} IDs (${size} bytes)`);

  if (size > IDEMPOTENCY_CONFIG.maxStateSizeBytes) {
    console.warn(`[ContinueAsNew] Large state: ${size} bytes`);
  }

  continueAsNew<typeof chatSessionWorkflow>({
    sessionId: sessionId,
    startedAtMs: startedAtMs,
    processedRequestIds: idsToKeep,
  });
}

// -------------------- 幂等性管理器 --------------------

/**
 * 創建幂等性管理器
 * 
 * 用於管理已處理的請求 ID 和結果緩存，防止重複處理相同請求。
 * 當 Workflow 重放或收到重複請求時，可直接返回緩存結果。
 * 
 * @param initialIds - 初始的 requestId 列表（來自 ContinueAsNew 傳遞的狀態）
 */
function createIdempotencyManager(initialIds: string[] = []) {
  // 已處理的請求 ID 集合（用於快速查找）
  const processedIds = new Set<string>(initialIds);

  // 結果緩存（存儲實際返回值，用於精確幂等）
  const resultCache = new Map<string, string>();

  return {
    /**
     * 獲取緩存的處理結果
     * 
     * @param requestId - 請求唯一標識
     * @returns 如果已處理則返回緩存結果，否則返回 null
     */
    getCached(requestId?: string): string | null {
      if (!requestId || !processedIds.has(requestId)) return null;
      return resultCache.get(requestId) || IDEMPOTENCY_CONFIG.duplicateMessage;
    },

    /**
     * 記錄請求處理結果到緩存
     * 
     * @param requestId - 請求唯一標識
     * @param result - 處理結果
     */
    putCached(requestId: string | undefined, result: string): void {
      if (requestId) {
        processedIds.add(requestId);
        resultCache.set(requestId, result);
      }
    },

    /**
     * 獲取用於 ContinueAsNew 的狀態
     * 
     * 返回需要傳遞到新 Workflow 實例的幂等性狀態，
     * 會自動限制數量以控制狀態大小。
     * 
     * @returns 包含 ID 列表和統計信息的狀態對象
     */
    getStateForContinueAsNew() {
      const allIds = Array.from(processedIds);
      const idsToKeep = allIds.slice(-IDEMPOTENCY_CONFIG.maxCachedRequestIds);

      return {
        idsToKeep,        // 要傳遞的 requestId 列表
        originalTotal: allIds.length   // 當前總數（用於日誌）
      };
    }
  };
}

// ==================== 主工作流 ====================
export async function chatSessionWorkflow(startSessionParams: StartSessionParams): Promise<void> {
  // -------------------- 狀態初始化 --------------------
  const pendingQueue: QueueItem[] = [];
  const idempotency = createIdempotencyManager(startSessionParams.processedRequestIds);
  let currentScope: CancellationScope | null = null;
  let sessionInitialized = false;

  // -------------------- Update Handler: 發送訊息 --------------------
  setHandler(sendMessageUpdate, async (params: SendMessageParams): Promise<string> => {
    const cached = idempotency.getCached(params.requestId);
    if (cached) return cached;

    const completion = new Trigger<string>();
    pendingQueue.push({
      userId: params.userId,
      sessionId: params.sessionId,
      text: params.text,
      startedAtMs: params.startedAtMs,
      requestId: params.requestId,
      completion
    });

    const result = await completion;
    idempotency.putCached(params.requestId, result);
    return result;
  });

  // -------------------- Signal Handler: 取消 --------------------
  setHandler(cancelSignal, () => {
    currentScope?.cancel();
  });

  // -------------------- 訊息處理 --------------------
  async function processMessage(item: QueueItem): Promise<void> {
    const timestamp = item.startedAtMs;

    // 0.初始化 session（僅首次）
    if (!sessionInitialized) {
      await activities.initializeSession({
        sessionId: item.sessionId,
        title: item.text,
        timestamp
      });
      sessionInitialized = true;
    }

    // 1. 檢測是否為確認記帳訊息
    if (item.text.startsWith('__CONFIRM_LEDGER__:')) {
      try {
        const result = await processConfirmLedger(item, timestamp);
        item.completion.resolve(result);
        return;
      } catch (err: any) {
        const errorMsg = `確認記帳失敗：${err?.message ?? 'Unknown error'}`;
        await saveSystemMessage(item.sessionId, errorMsg, timestamp);
        item.completion.resolve(errorMsg);
        return;
      }
    }

    // 2.儲存用戶訊息（正常消息）
    await activities.saveMessage({
      sessionId: item.sessionId,
      role: 'user',
      content: item.text,
      timestamp,
      messageId: `user-${item.requestId}`,
    });

    // 3.判斷能力並生成回覆
    const capability = await activities.decideCapability(item.text);

    // 4.生成回覆
    const reply = await generateReply(capability, item, timestamp);

    // 5.儲存 AI 回覆
    await activities.saveMessage({
      sessionId: item.sessionId,
      role: 'assistant',
      content: reply,
      timestamp,
      messageId: `assistant-${item.requestId}`,
    });

    // 6. 返回回覆
    item.completion.resolve(reply);
  }

  // -------------------- 主事件循環 --------------------
  while (true) {
    // 等待佇列有內容或需要 ContinueAsNew
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);

    // 處理佇列中的訊息
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift()!;
      try {
        currentScope = new CancellationScope();
        await currentScope.run(() => processMessage(item));
      } catch (err: any) {
        await handleError(err, item);
      } finally {
        currentScope = null;
      }
    }

    if (workflowInfo().continueAsNewSuggested) {
      const { idsToKeep, originalTotal } = idempotency.getStateForContinueAsNew();
      performContinueAsNew(idsToKeep, originalTotal, startSessionParams.sessionId, startSessionParams.startedAtMs);
    }
  }
}
