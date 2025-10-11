import { 
  proxyActivities, 
  defineSignal, 
  defineUpdate, 
  setHandler, 
  continueAsNew, 
  workflowInfo, 
  condition, 
  Trigger, 
  CancellationScope, 
  isCancellation 
} from '@temporalio/workflow';
import { 
  Capability, 
  SendMessageParams, 
  SaveLedgerInput, 
  StartSessionParams, 
  ConfirmLedgerArgs, 
  QueueItem, 
  ParsedLedgerProposalResult, 
  SaveMessageArgs, 
  InitializeSessionArgs 
} from '../types';

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
  saveLedger: (args: SaveLedgerInput) => Promise<string>;
  parseLedgerProposal: (args: SendMessageParams) => Promise<ParsedLedgerProposalResult>;
  queryLedgerRange: (args: SendMessageParams) => Promise<string>;
  saveMessage: (params: SaveMessageArgs) => Promise<void>;
  initializeSession: (params: InitializeSessionArgs) => Promise<void>;
}

const activities = proxyActivities<ChatActivities>(ACTIVITY_CONFIG);

// ==================== Update 和 Signal 定義 ====================
const sendMessageUpdate = defineUpdate<string, [SendMessageParams]>('sendMessage');
const confirmLedgerUpdate = defineUpdate<string, [ConfirmLedgerArgs]>('confirmLedger');
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
  try {
    await activities.saveMessage({
      sessionId,
      role: 'system',
      content,
      timestamp
    });
  } catch {}
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

// ==================== 主工作流 ====================

/**
 * 聊天會話工作流
 */
export async function chatSessionWorkflow(startSessionParams: StartSessionParams): Promise<void> {
  // -------------------- 狀態初始化 --------------------
  const pendingQueue: QueueItem[] = [];
  const processedRequestIds = new Set<string>(startSessionParams.processedRequestIds || []);
  const resultCache = new Map<string, string>();
  let currentScope: CancellationScope | null = null;
  let sessionInitialized = false;

  // -------------------- 幂等性輔助函數 --------------------
  function checkIdempotency(requestId?: string): string | null {
    if (!requestId || !processedRequestIds.has(requestId)) return null;
    return resultCache.get(requestId) || IDEMPOTENCY_CONFIG.duplicateMessage;
  }

  function recordResult(requestId: string | undefined, result: string): void {
    if (requestId) {
      processedRequestIds.add(requestId);
      resultCache.set(requestId, result);
    }
  }

  // -------------------- Update Handler: 發送訊息 --------------------
  setHandler(sendMessageUpdate, async (params: SendMessageParams): Promise<string> => {
    const cached = checkIdempotency(params.requestId);
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
    recordResult(params.requestId, result);
    return result;
  });

  // -------------------- Update Handler: 確認記帳 --------------------
  setHandler(confirmLedgerUpdate, async (args: ConfirmLedgerArgs): Promise<string> => {
    const cached = checkIdempotency(args.requestId);
    if (cached) return cached;
    
    const result = await activities.saveLedger({
      userId: args.userId,
      sessionId: args.sessionId,
      title: args.proposal.title,
      amountCents: args.proposal.amountCents,
      occurredAtMs: args.proposal.occurredAtMs,
      requestId: args.requestId,
    });
    
    recordResult(args.requestId, result);
    return result;
  });

  // -------------------- Signal Handler: 取消 --------------------
  setHandler(cancelSignal, () => {
    currentScope?.cancel();
  });

  // -------------------- 訊息處理 --------------------
  async function processMessage(item: QueueItem): Promise<void> {
    const timestamp = item.startedAtMs;
    
    // 初始化 session（僅首次）
    if (!sessionInitialized) {
      await activities.initializeSession({
        sessionId: item.sessionId,
        title: item.text,
        timestamp
      });
      sessionInitialized = true;
    }
    
    // 儲存用戶訊息
    await activities.saveMessage({
      sessionId: item.sessionId,
      role: 'user',
      content: item.text,
      timestamp,
      messageId: `user-${item.requestId}`,
    });

    // 判斷能力並生成回覆
    const capability = await activities.decideCapability(item.text);
    const reply = await generateReply(capability, item, timestamp);
    
    // 儲存 AI 回覆
    await activities.saveMessage({
      sessionId: item.sessionId,
      role: 'assistant',
      content: reply,
      timestamp,
      messageId: `assistant-${item.requestId}`,
    });
    
    item.completion.resolve(reply);
  }

  async function processNextMessage(): Promise<void> {
    const item = pendingQueue.shift();
    if (!item) return;
    
    try {
      currentScope = new CancellationScope();
      await currentScope.run(() => processMessage(item));
    } catch (err: any) {
      await handleError(err, item);
    } finally {
      currentScope = null;
    }
  }

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

  // -------------------- 主事件循環 --------------------
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 等待佇列有內容或需要 ContinueAsNew
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);
    
    // 優先檢查 ContinueAsNew
    if (workflowInfo().continueAsNewSuggested && pendingQueue.length === 0) {
      const allIds = Array.from(processedRequestIds);
      const idsToKeep = allIds.slice(-IDEMPOTENCY_CONFIG.maxCachedRequestIds);
      const stateSize = JSON.stringify(idsToKeep).length;
      
      console.log(`[ContinueAsNew] ${idsToKeep.length}/${allIds.length} IDs (${stateSize} bytes)`);
      
      if (stateSize > IDEMPOTENCY_CONFIG.maxStateSizeBytes) {
        console.warn(`[ContinueAsNew] Large state: ${stateSize} bytes`);
      }
      
      return continueAsNew<typeof chatSessionWorkflow>({
        sessionId: startSessionParams.sessionId,
        startedAtMs: startSessionParams.startedAtMs,
        processedRequestIds: idsToKeep,
      });
    }
    
    // 處理佇列中的訊息
    while (pendingQueue.length > 0) {
      await processNextMessage();
    }
  }
}
