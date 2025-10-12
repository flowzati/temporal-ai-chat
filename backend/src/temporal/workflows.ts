import { proxyActivities, defineSignal, defineUpdate, setHandler, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation } from '@temporalio/workflow';
import { Capability, SendMessageParams, SaveLedgerInput, StartSessionParams, QueueItem, ParsedLedgerProposalResult, SaveMessageArgs, InitializeSessionArgs, LedgerQueryRangeResult, LedgerEntryRow } from '../types';

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
  parseLedgerQuery: (text: string) => Promise<LedgerQueryRangeResult>;
  getLedgerEntries: (params: { userId: string; startMs: number; endMs: number }) => Promise<LedgerEntryRow[]>;
  saveLedger: (args: SaveLedgerInput) => Promise<string>;
  undoLastLedger: (args: SendMessageParams) => Promise<string>;
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
 * 格式化記帳摘要（純函數，可在 Workflow 中執行）
 */
function formatLedgerSummary(entries: LedgerEntryRow[], start: Date, end: Date): string {
  let incomeCents = 0;
  let expenseCents = 0;

  const lines = entries.map((entry: LedgerEntryRow) => {
    const sign = entry.amount_cents >= 0 ? '+' : '-';
    if (entry.amount_cents >= 0) {
      incomeCents += entry.amount_cents;
    } else {
      expenseCents += entry.amount_cents;
    }
    const amountAbs = Math.abs(entry.amount_cents) / 100;
    const occurredAt = new Date(entry.occurred_at_ms).toLocaleString();
    return `${occurredAt} ${entry.title} ${sign}$${amountAbs.toFixed(2)}`;
  });

  const income = (incomeCents / 100).toFixed(2);
  const expense = (Math.abs(expenseCents) / 100).toFixed(2);
  const net = ((incomeCents + expenseCents) / 100).toFixed(2);

  const header = `範圍：${start.toISOString().slice(0, 10)} 至 ${end.toISOString().slice(0, 10)}\n收入：$${income}  支出：-$${expense}  淨額：$${net}`;
  const body = lines.length ? lines.join('\n') : '（無資料）';
  return `${header}\n${body}`;
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
    case 'weather': {
      return await activities.weatherReply(item.text);
    }
    case 'ledger_proposal': {
      // 解析記帳提議
      const ledger = await activities.parseLedgerProposal({
        userId: item.userId,
        sessionId: item.sessionId,
        text: item.text,
        startedAtMs: timestamp,
        requestId: item.requestId,
      });
      
      // 直接執行記帳
      await activities.saveLedger({
        userId: ledger.userId,
        sessionId: ledger.sessionId,
        title: ledger.title,
        amountCents: ledger.amountCents,
        occurredAtMs: ledger.occurredAtMs,
        requestId: item.requestId,
      });
      
      // 返回記帳確認訊息
      return `已記帳：${ledger.explain}`;
    }

    case 'ledger_undo': {
      // 撤銷最近一筆記帳
      return await activities.undoLastLedger({
        userId: item.userId,
        sessionId: item.sessionId,
        text: item.text,
        startedAtMs: timestamp,
        requestId: item.requestId,
      });
    }

    case 'ledger_query': {
      // 1. 解析查詢範圍（AI 調用）
      const range = await activities.parseLedgerQuery(item.text);
      
      // 2. 查詢記帳條目（DB 查詢）
      const entries = await activities.getLedgerEntries({
        userId: item.userId,
        startMs: range.startMs,
        endMs: range.endMs,
      });
      
      // 3. 格式化輸出（純函數，在 Workflow 中執行）
      return formatLedgerSummary(entries, new Date(range.startMs), new Date(range.endMs));
    }

    case 'chat':
    default:
      return await activities.chatReply(item.text);
  }
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

    // 1.儲存用戶訊息
    await activities.saveMessage({
      sessionId: item.sessionId,
      role: 'user',
      content: item.text,
      timestamp,
      messageId: `user-${item.requestId}`,
    });

    // 2.判斷能力並生成回覆
    const capability = await activities.decideCapability(item.text);

    // 3.生成回覆
    const reply = await generateReply(capability, item, timestamp);

    // 4.儲存 AI 回覆
    await activities.saveMessage({
      sessionId: item.sessionId,
      role: 'assistant',
      content: reply,
      timestamp,
      messageId: `assistant-${item.requestId}`,
    });

    // 5. 返回回覆
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
