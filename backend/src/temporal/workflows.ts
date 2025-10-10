import { proxyActivities, defineSignal, defineUpdate, setHandler, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation } from '@temporalio/workflow';

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
  sessionId: string;
}

// 定義 Update：單次訊息處理，回傳助理回覆（泛型順序為 <Return, [Args]>）
export const sendMessageUpdate = defineUpdate<string, [SendMessageArgs]>('sendMessage');
// 定義 Update：確認記帳
export const confirmLedgerUpdate = defineUpdate<string, [ConfirmLedgerArgs]>('confirmLedger');
// 定義 Signal：取消訊號
export const cancelSignal = defineSignal('cancel');

async function handleChat(item: QueueItem) {
  const reply = await acts.chatReply({ userMessage: item.userMessage });
  item.completion.resolve(reply);
}

async function handleWeather(item: QueueItem) {
  const reply = await acts.weatherReply({ userMessage: item.userMessage });
  item.completion.resolve(reply);
}

async function handleLedgerProposal(item: QueueItem) {
  const ledger = await acts.parseLedgerProposal({ userId: item.userId, sessionId: item.sessionId, text: item.userMessage });
  const payload = JSON.stringify({ __kind: 'ledger_proposal', proposal: ledger.proposal, explain: ledger.explain });
  item.completion.resolve(payload);
}

async function handleLedgerQuery(item: QueueItem) {
  const ledger = await acts.queryLedgerRange({ userId: item.userId, text: item.userMessage });
  item.completion.resolve(ledger.resultText);
}


// Entity 風格的長駐工作流：每個 sessionId 對應一個工作流實體
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 執行期佇列：Update 只入列，主循環負責出列處理
  const pendingQueue: QueueItem[] = [];
  let currentScope: CancellationScope | null = null;

  // Update：將訊息入列並等待主循環處理結果（以 Trigger 實現 deferred）
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    const completion = new Trigger<string>();
    pendingQueue.push({ userMessage: args.userMessage, completion, userId: args.userId, sessionId: startArgs.sessionId });
    return await completion;
  });

  // 確認記帳（Confirm）：直接呼叫 Activity 寫 DB，不入列避免阻塞緒列
  setHandler(confirmLedgerUpdate, async (args: { userId: string; sessionId: string; proposal: { title: string; amountCents: number; occurredAtMs: number } }): Promise<string> => {
    return await acts.saveLedger({ proposal: { userId: args.userId, sessionId: args.sessionId, title: args.proposal.title, amountCents: args.proposal.amountCents, occurredAtMs: args.proposal.occurredAtMs } });
  });

  // 取消訊號：將當前佇列中的請求標記為取消
  setHandler(cancelSignal, () => {
    // 取消當前作用域，讓等待中的 Activity/計時器立即拋出取消錯誤
    currentScope?.cancel();
  });
  
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
      // 由 OpenAI 決策選擇功能：chat / weather / ledger_proposal / ledger_query（集中式路由）
      try {
        currentScope = new CancellationScope();
        await currentScope.run(async () => {
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
        if (isCancellation(err)) {
          item.completion.resolve('已取消');
          continue;
        }
        const msg = String(err?.message ?? '');
        if (msg.includes('Not a ledger') || msg.includes('Invalid date') || msg.includes('Unsupported range')) {
          item.completion.resolve(`處理失敗：${msg}`);
          continue;
        }
        throw err;
      } finally {
        currentScope = null;
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
