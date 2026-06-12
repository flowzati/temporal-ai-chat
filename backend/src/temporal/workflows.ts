import { proxyActivities, defineSignal, defineUpdate, setHandler, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation, patched } from '@temporalio/workflow';
import { Capability, SendMessageParams, SaveLedgerInput, StartSessionParams, QueueItem, ParsedLedgerProposalResult, SaveMessageArgs, InitializeSessionArgs, LedgerQueryRangeResult, LedgerEntryRow } from '../types';
import * as ledger from '../utils/ledger';
/**
 * Workflow模式說明：
 * 
 * 採用 Entity/Virtual Actor 模式，每個 sessionId 對應一個長駐 Workflow 實體。
 * 
 * 設計原則：
 * - Workflow 只負責決策與編排（確定性邏輯）
 * - 所有 I/O 操作（OpenAI、DB）都委派給 Activities
 * - 使用記憶體 Queue + condition 串行處理訊息，確保順序一致性
 * - 支持幂等性：使用 requestId 防止重複處理
 */

// ==================== 常數配置 ====================

const IDEMPOTENCY_CONFIG = {
  maxCachedRequestIds: 1000,
  maxStateSizeBytes: 100000,
  duplicateMessage: '訊息已處理',
} as const;
const LEGACY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// ==================== Activity 介面定義 ====================
interface ChatActivities {
  // 決策能力：聊天、查天氣、記帳、查帳 (@openai/agents)
  decideCapability: (userMessage: string) => Promise<Capability>;
  // 回覆能力：聊天 (@openai/agents)
  chatReply: (userMessage: string) => Promise<string>;
  // 回覆能力：查天氣
  weatherReply: (userMessage: string) => Promise<string>;
  // 回覆能力：記帳
  parseLedgerProposal: (args: SendMessageParams) => Promise<ParsedLedgerProposalResult>;
  parseLedgerQuery: (text: string) => Promise<LedgerQueryRangeResult>;
  getLedgerEntries: (params: { userId: string; startMs: number; endMs: number }) => Promise<LedgerEntryRow[]>;
  saveLedger: (args: SaveLedgerInput) => Promise<string>;
  undoLastLedger: (args: SendMessageParams) => Promise<string>;
  saveMessage: (params: SaveMessageArgs) => Promise<void>;
  initializeSession: (params: InitializeSessionArgs) => Promise<void>;
}

// SDK 代理 Activity 搭配開箱即用的 API 設定超時、重試機制
const activities = proxyActivities<ChatActivities>({
  startToCloseTimeout: '1 minute', // 活動執行時間上限 1 分鐘
  retry: {
    maximumAttempts: 3, // 最多重試 3 次
    initialInterval: '5s', // 初始間隔 5 秒
    backoffCoefficient: 2, // 指數退避 (5s, 10s, 20s)
    maximumInterval: '40s', // 最大間隔 40 秒
  }
});

// ==================== Update 和 Signal 定義 ====================
const sendMessageUpdate = defineUpdate<string, [SendMessageParams]>('sendMessage');
const cancelSignal = defineSignal('cancel');
const closeSignal = defineSignal<[number]>('close');

// ==================== Helper Classes ====================

/**
 * 幂等性管理器
 * 
 * 用於管理已處理的請求 ID 和結果緩存，防止重複處理相同請求。
 * 當 Workflow 重放或收到重複請求時，可直接返回緩存結果。
 */
class IdempotencyManager {
  private processedIds: Set<string>;
  private resultCache: Map<string, string>;

  constructor(initialIds: string[] = []) {
    this.processedIds = new Set(initialIds);
    this.resultCache = new Map();
  }

  /**
   * 獲取緩存的處理結果
   * 
   * @param requestId - 請求唯一標識
   * @returns 如果已處理則返回緩存結果，否則返回 null
   */
  getCached(requestId?: string): string | null {
    if (!requestId || !this.processedIds.has(requestId)) return null;
    return this.resultCache.get(requestId) || IDEMPOTENCY_CONFIG.duplicateMessage;
  }

  /**
   * 記錄請求處理結果到緩存
   * 
   * @param requestId - 請求唯一標識
   * @param result - 處理結果
   */
  putCached(requestId: string | undefined, result: string): void {
    if (requestId) {
      this.processedIds.add(requestId);
      this.resultCache.set(requestId, result);
    }
  }

  /**
   * 取得用於 ContinueAsNew 的狀態
   * 
   * 回傳需要傳遞到新 Workflow 實例的幂等性狀態，
   * 會自動限制數量以控制狀態大小。
   * 
   * @returns 縮減後的 ID 列表
   */
  getIdsForContinueAsNew(): string[] {
    const allIds = Array.from(this.processedIds);
    const idsToKeep = allIds.slice(-IDEMPOTENCY_CONFIG.maxCachedRequestIds);
    console.log(`[ContinueAsNew] ${idsToKeep.length}/${allIds.length} IDs (${JSON.stringify(idsToKeep).length} bytes)`);
    return idsToKeep;
  }
}

/**
 * 管理待處理的訊息 Queue，確保訊息按順序處理。
 */
class MessageQueue {
  private queue: QueueItem[] = [];

  /**
   * 將新訊息加入 Queue
   * 
   * @param params - 發送訊息參數
   * @returns 完成觸發器，用於等待處理結果
   */
  enqueue(params: SendMessageParams): Trigger<string> {
    const completion = new Trigger<string>();
    this.queue.push({
      userId: params.userId,
      sessionId: params.sessionId,
      text: params.text,
      startedAtMs: params.startedAtMs,
      requestId: params.requestId,
      completion
    });
    return completion;
  }

  /**
   * 從 Queue 取出下一個訊息
   * 
   * @returns Queue Item 或 undefined
   */
  dequeue(): QueueItem | undefined {
    return this.queue.shift();
  }

  /**
   * 檢查佇列是否為空
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

}

// Activity 封装外部服務的呼叫，由 Workflow 呼叫並推進流程
// 看到這邊的 Workflow 程式碼相當簡潔
// 是因為剛剛在 Activity 已經設定了重試、超時規則
// 並且由 Temporal Server 自動配合執行而得來的
class ReplyGenerator {
  async generateReply(message: QueueItem): Promise<string> {
    // 根據不同的能力類型生成對應的回覆：天氣、記帳、查帳、聊天
    const capability = await activities.decideCapability(message.text);
    switch (capability) {
      case 'weather':
        return activities.weatherReply(message.text);
      case 'ledger_proposal':
        return this.handleLedgerProposal(message);
      case 'ledger_undo':
        return this.handleLedgerUndo(message);
      case 'ledger_query':
        return this.handleLedgerQuery(message);
      case 'chat':
      default:
        return activities.chatReply(message.text);
    }
  }

  private async handleLedgerProposal(message: QueueItem): Promise<string> {
    // 解析記帳提議
    const ledgerProposal = await activities.parseLedgerProposal({
      userId: message.userId,
      sessionId: message.sessionId,
      text: message.text,
      startedAtMs: message.startedAtMs,
      requestId: message.requestId,
    });

    // 直接執行記帳
    await activities.saveLedger({
      userId: ledgerProposal.userId,
      sessionId: ledgerProposal.sessionId,
      title: ledgerProposal.title,
      amountCents: ledgerProposal.amountCents,
      occurredAtMs: ledgerProposal.occurredAtMs,
      requestId: message.requestId,
    });

    // 返回記帳確認訊息
    return `已記帳：${ledgerProposal.explain}`;
  }

  private async handleLedgerUndo(message: QueueItem): Promise<string> {
    return await activities.undoLastLedger({
      userId: message.userId,
      sessionId: message.sessionId,
      text: message.text,
      startedAtMs: message.startedAtMs,
      requestId: message.requestId,
    });
  }

  private async handleLedgerQuery(message: QueueItem): Promise<string> {
    // 1. 解析查詢範圍（AI 調用）
    const range = await activities.parseLedgerQuery(message.text);

    // 2. 查詢記帳條目（DB 查詢）
    const entries = await activities.getLedgerEntries({
      userId: message.userId,
      startMs: range.startMs,
      endMs: range.endMs,
    });

    // 3. 格式化輸出（純函數，在 Workflow 中執行）
    return ledger.formatLedgerSummary(entries, new Date(range.startMs), new Date(range.endMs));
  }
}

/**
 * 取消管理器
 * 
 * 管理可取消的操作範圍。
 */
class CancellationManager {
  private currentScope: CancellationScope | null = null;

  /**
   * 在可取消的範圍內執行函數
   * 
   * @param fn - 要執行的函數
   * @returns 函數執行結果
   */
  async runCancellable<T>(fn: () => Promise<T>): Promise<T> {
    this.currentScope = new CancellationScope();
    try {
      return await this.currentScope.run(fn);
    } finally {
      this.currentScope = null;
    }
  }

  /**
   * 取消當前操作
   */
  cancel(): void {
    this.currentScope?.cancel();
  }
}

/**
 * 訊息處理器
 * 
 * 負責處理訊息的完整流程，包括初始化、保存、生成回覆和錯誤處理。
 */
class MessageProcessor {
  private sessionInitialized: boolean;
  private replyGenerator: ReplyGenerator;

  constructor(replyGenerator: ReplyGenerator) {
    this.sessionInitialized = false;
    this.replyGenerator = replyGenerator;
  }

  /**
   * 處理單個訊息
   */
  async processMessage(message: QueueItem): Promise<void> {
    // 0. 初始化 session（僅首次）
    if (!this.sessionInitialized) {
      await activities.initializeSession({
        sessionId: message.sessionId,
        title: message.text,
        timestamp: message.startedAtMs
      });
      this.sessionInitialized = true;
    }

    // 1. 儲存用戶訊息
    await activities.saveMessage({
      sessionId: message.sessionId,
      role: 'user',
      content: message.text,
      timestamp: message.startedAtMs,
      messageId: `user-${message.requestId}`,
    });

    // 2. 判斷能力並生成回覆
    const reply = await this.replyGenerator.generateReply(message);

    // 3. 儲存 AI 回覆
    await activities.saveMessage({
      sessionId: message.sessionId,
      role: 'assistant',
      content: reply,
      timestamp: message.startedAtMs,
      messageId: `assistant-${message.requestId}`,
    });

    // 4. 返回回覆
    message.completion.resolve(reply);
  }

  /**
   * 處理錯誤
   */
  async handleError(err: any, message: QueueItem): Promise<void> {
    let content: string;
    if (isCancellation(err)) {
      // 取消錯誤
      content = '已取消';
    } else {
      // 一般錯誤
      const msg = String(err?.message ?? 'Unknown error');
      content = this.isBusinessError(msg) ? `處理失敗：${msg}` : `系統錯誤：${msg}`;
    }
    await activities.saveMessage({ sessionId: message.sessionId, role: 'system', content, timestamp: message.startedAtMs });
    message.completion.resolve(content);
  }

  /**
   * 判斷是否為業務錯誤
   */
  private isBusinessError(msg: string): boolean {
    return msg.includes('Not a ledger')
      || msg.includes('Invalid date')
      || msg.includes('Unsupported range');
  }
}

// ==================== 工具函數 ====================
function performContinueAsNew(
  idsToKeep: string[],
  sessionId: string,
  startedAtMs: number,
  lastActivityMs: number,
  idleTimeoutMs?: number
) {
  const size = JSON.stringify(idsToKeep).length;
  if (size > IDEMPOTENCY_CONFIG.maxStateSizeBytes) {
    console.warn(`[ContinueAsNew] Large state: ${size} bytes`);
  }

  continueAsNew<typeof chatSessionWorkflow>({
    sessionId: sessionId,
    startedAtMs: startedAtMs,
    lastActivityMs,
    idleTimeoutMs,
    processedRequestIds: idsToKeep,
  });
}

// ==================== 主工作流 ====================
export async function chatSessionWorkflow(startSessionParams: StartSessionParams): Promise<void> {
  // -------------------- 初始化 Helper Classes --------------------
  const idempotency = new IdempotencyManager(startSessionParams.processedRequestIds);
  const messageQueue = new MessageQueue();
  const messageProcessor = new MessageProcessor(new ReplyGenerator());
  const cancellationManager = new CancellationManager();
  const useExternalIdleClose = patched('external-session-idle-close-v1');
  let lastActivityMs = startSessionParams.lastActivityMs ?? startSessionParams.startedAtMs;
  let closeRequested = false;

  const hasWorkflowEvent = () =>
    closeRequested || !messageQueue.isEmpty() || workflowInfo().continueAsNewSuggested;

  const waitForWorkflowEvent = async (): Promise<boolean> => {
    if (useExternalIdleClose) {
      await condition(hasWorkflowEvent);
      return true;
    }

    return await condition(
      hasWorkflowEvent,
      startSessionParams.idleTimeoutMs ?? LEGACY_IDLE_TIMEOUT_MS
    );
  };

  // -------------------- Update Handler: 訊息處理 --------------------
  setHandler(sendMessageUpdate, async (params: SendMessageParams): Promise<string> => {
    const cached = idempotency.getCached(params.requestId);
    if (cached) return cached;

    lastActivityMs = Math.max(lastActivityMs, params.startedAtMs);
    const completion = messageQueue.enqueue(params);
    const result = await completion;
    idempotency.putCached(params.requestId, result);
    return result;
  });

  // -------------------- Signal Handler: 取消 --------------------
  setHandler(cancelSignal, () => {
    cancellationManager.cancel();
  });

  // -------------------- Signal Handler: 關閉閒置 Session --------------------
  setHandler(closeSignal, (cutoffMs: number) => {
    if (lastActivityMs > cutoffMs) {
      return;
    }

    closeRequested = true;
    cancellationManager.cancel();
  });

  // -------------------- 主事件循環 --------------------
  while (true) {
    const hasWork = await waitForWorkflowEvent();
    if ((!hasWork || closeRequested) && messageQueue.isEmpty()) {
      return;
    }

    // 處理佇列中的訊息
    while (!messageQueue.isEmpty()) {
      const message = messageQueue.dequeue()!;
      try {
        await cancellationManager.runCancellable(() =>
          messageProcessor.processMessage(message)
        );
      } catch (err: any) {
        await messageProcessor.handleError(err, message);
      }
    }

    if (closeRequested) {
      return;
    }

    // 執行 ContinueAsNew
    if (workflowInfo().continueAsNewSuggested) {
      const idsToKeep = idempotency.getIdsForContinueAsNew();
      performContinueAsNew(
        idsToKeep,
        startSessionParams.sessionId,
        startSessionParams.startedAtMs,
        lastActivityMs,
        startSessionParams.idleTimeoutMs
      );
    }
  }
}
