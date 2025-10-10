import { proxyActivities, defineSignal, defineUpdate, setHandler, upsertSearchAttributes, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation } from '@temporalio/workflow';
import { Capability } from './activities';
// 說明：本工作流採用 Entity/Virtual Actor 模式（每個 sessionId 對應一個長駐實體）。
// - Workflow 僅負責決策與協調（決定性），所有 I/O 交由 Activities 執行（避免非決定性）。
// - 以內存佇列 + condition 等待的方式串行處理訊息，確保順序與一致性。

export interface ChatActivities {
  decideCapability: (args: { text: string }) => Promise<Capability>;
  chatReply: (args: { userMessage: string }) => Promise<string>;
  weatherReply: (args: { userMessage: string }) => Promise<string>;
  saveLedger: (args: { proposal: { userId: string; sessionId?: string | null; title: string; amountCents: number; occurredAtMs: number } }) => Promise<string>;
  parseLedgerProposal: (args: { userId: string; sessionId?: string | null; text: string; nowMs?: number }) => Promise<
    { proposal: { userId: string; sessionId?: string | null; title: string; amountCents: number; occurredAtMs: number }; explain: string }
  >;
  queryLedgerRange: (args: { userId: string; text: string; nowMs?: number }) => Promise<{ resultText: string }>;
}

// 代理活動：定義在 Worker 執行的函式（OpenAI、DB 存取等 I/O）
const acts = proxyActivities<ChatActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    backoffCoefficient: 2
  },
});

export interface StartSessionArgs {
  sessionId: string; // 會話 ID（實體主鍵）
  startedAtMs: number; // 工作流起始時間（決定性來源於伺服器）
}

export interface SendMessageArgs {
  userId: string; // 使用者 ID
  userMessage: string; // 使用者訊息
  startedAtMs: number; // 此次訊息的開始時間（決定性來源於伺服器）
}

export interface ConfirmLedgerArgs {
  userId: string; // 使用者 ID
  sessionId: string; // 會話 ID
  proposal: { title: string; amountCents: number; occurredAtMs: number }; // 記帳提案
}

export interface QueueItem {
  userMessage: string;
  completion: Trigger<string>;
  userId: string;
  resolved: boolean;
  sessionId: string;
}

// 定義 Update：單次訊息處理，回傳助理回覆（泛型順序為 <Return, [Args]>）
export const sendMessageUpdate = defineUpdate<string, [SendMessageArgs]>('sendMessage');
// 定義 Update：確認記帳
export const confirmLedgerUpdate = defineUpdate<string, [ConfirmLedgerArgs]>('confirmLedger');
export const cancelSignal = defineSignal('cancel');

// Entity 風格的長駐工作流：每個 sessionId 對應一個工作流實體
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 執行期佇列：Update 只入列，主循環負責出列處理
  const pendingQueue: QueueItem[] = [];
  const MAX_QUEUE = 100; // 簡單背壓：避免佇列過長
  let cancelled = false;
  let currentScope: CancellationScope | null = null;
  let currentItem: QueueItem | null = null;

  // Update：將訊息入列並等待主循環處理結果（以 Trigger 實現 deferred）
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    if (pendingQueue.length >= MAX_QUEUE) {
      return '系統忙碌中，請稍後再試';
    }
    const completion = new Trigger<string>();
    pendingQueue.push({ userMessage: args.userMessage, completion, userId: args.userId, resolved: false, sessionId: startArgs.sessionId });
    return await completion;
  });

  // 確認記帳（Confirm）：直接呼叫 Activity 寫 DB，不入列避免阻塞緒列
  setHandler(confirmLedgerUpdate, async (args: { userId: string; sessionId: string; proposal: { title: string; amountCents: number; occurredAtMs: number } }): Promise<string> => {
    return await acts.saveLedger({ proposal: { userId: args.userId, sessionId: args.sessionId, title: args.proposal.title, amountCents: args.proposal.amountCents, occurredAtMs: args.proposal.occurredAtMs } });
  });

  // 取消訊號：將當前佇列中的請求標記為取消
  setHandler(cancelSignal, () => {
    cancelled = true;
    // 立即嘗試標記目前處理中的項目為已取消，避免後續重複 resolve
    if (currentItem && !currentItem.resolved) {
      currentItem.resolved = true;
      currentItem.completion.resolve('已取消');
    }
    // 取消當前作用域，讓等待中的 Activity/計時器立即拋出取消錯誤
    currentScope?.cancel();
  });

  // Consolidated handlers：將各分支處理封裝，便於擴充與測試
  function safeResolve(item: QueueItem, value: string) {
    if (item.resolved) return;
    item.resolved = true;
    item.completion.resolve(value);
  }

  async function handleChat(item: QueueItem) {
    const reply = await acts.chatReply({ userMessage: item.userMessage });
    item.completion.resolve(reply);
  }

  async function handleWeather(item: QueueItem) {
    const reply = await acts.weatherReply({ userMessage: item.userMessage });
    item.completion.resolve(reply);
  }

  async function handleLedgerProposal(item: QueueItem) {
    const ledger = await acts.parseLedgerProposal({ userId: item.userId, sessionId: startArgs.sessionId, text: item.userMessage, nowMs: Date.now() });
    const payload = JSON.stringify({ __kind: 'ledger_proposal', proposal: ledger.proposal, explain: ledger.explain });
    item.completion.resolve(payload);
  }

  async function handleLedgerQuery(item: QueueItem) {
    const ledger = await acts.queryLedgerRange({ userId: item.userId, text: item.userMessage, nowMs: Date.now() });
    item.completion.resolve(ledger.resultText);
  }

  // 初始化：可記錄初始搜尋屬性（目前關閉，保留示例）
  // await upsertSearchAttributes({
  //   SessionId: [startArgs.sessionId],
  //   StartedAt: [new Date(startArgs.startedAtMs)],
  // });

  // 保持工作流存活，等待更新（Updates）
  // 若要釋出資源，可設計閒置逾時後關閉或 ContinueAsNew
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const info = workflowInfo();
    // 等待：佇列有內容或 Server 建議 ContinueAsNew（history 大小/長度門檻）
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);

    // 處理佇列（FIFO）
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift()!;
      currentItem = item;
      // 由 OpenAI 決策選擇功能：chat / weather / ledger_proposal / ledger_query（集中式路由）
      try {
        await (currentScope = new CancellationScope()).run(async () => {
          const capability = await acts.decideCapability({ text: item.userMessage });
          if (capability === 'weather') {
            await handleWeather(item);
            return;
          }
          if (capability === 'ledger_proposal') {
            await handleLedgerProposal(item);
            return;
          }
          if (capability === 'ledger_query') {
            await handleLedgerQuery(item);
            return;
          }
          await handleChat(item);
        });
      } catch (err: any) {
        if (isCancellation(err) || cancelled) {
          safeResolve(item, '已取消');
          cancelled = false;
          continue;
        }
        const msg = String(err?.message ?? '');
        if (msg.includes('Not a ledger') || msg.includes('Invalid date') || msg.includes('Unsupported range')) {
          safeResolve(item, `處理失敗：${msg}`);
          continue;
        }
        throw err;
      } finally {
        currentScope = null;
        currentItem = null;
      }
    }

    if (info.continueAsNewSuggested) {
      return continueAsNew<typeof chatSessionWorkflow>({
        sessionId: startArgs.sessionId,
        startedAtMs: startArgs.startedAtMs,
      });
    }
  }
}
