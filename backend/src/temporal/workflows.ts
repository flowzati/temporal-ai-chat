import { proxyActivities, defineSignal, defineUpdate, setHandler, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation } from '@temporalio/workflow';
import { Capability, SendMessageArgs, SaveLedgerInput, StartSessionArgs, ConfirmLedgerArgs, QueueItem, ParsedLedgerProposalFlat } from '../types';

// 說明：本工作流採用 Entity/Virtual Actor 模式（每個 sessionId 對應一個長駐實體）。
// - Workflow 僅負責決策與協調（決定性），所有 I/O 交由 Activities 執行（避免非決定性）。
// - 以內存佇列 + condition 等待的方式串行處理訊息，確保順序與一致性。
export interface ChatActivities {
  decideCapability: (userMessage: string) => Promise<Capability>;
  chatReply: (userMessage: string) => Promise<string>;
  weatherReply: (userMessage: string) => Promise<string>;
  saveLedger: (args: SaveLedgerInput) => Promise<string>;
  parseLedgerProposal: (args: SendMessageArgs) => Promise<ParsedLedgerProposalFlat>;
  queryLedgerRange: (args: SendMessageArgs) => Promise<string>;
}

// 代理活動：定義在 Worker 執行的函式（OpenAI、DB 存取等 I/O）
const acts = proxyActivities<ChatActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    backoffCoefficient: 2
  },
});

// 定義 Update：單次訊息處理，回傳助理回覆（泛型順序為 <Return, [Args]>）
export const sendMessageUpdate = defineUpdate<string, [SendMessageArgs]>('sendMessage');
// 定義 Update：確認記帳
export const confirmLedgerUpdate = defineUpdate<string, [ConfirmLedgerArgs]>('confirmLedger');
// 定義 Signal：取消訊號
export const cancelSignal = defineSignal('cancel');

// Entity 風格的長駐工作流：每個 sessionId 對應一個工作流實體
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 執行期佇列：Update 只入列，主循環負責出列處理
  const pendingQueue: QueueItem[] = [];
  let currentScope: CancellationScope | null = null;

  // Update：將訊息入列並等待主循環處理結果（以 Trigger 實現 deferred）
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    console.log('sendMessageUpdate', args);
    const completion = new Trigger<string>();
    pendingQueue.push({
      userId: args.userId,
      sessionId: args.sessionId,
      userMessage: args.userMessage,
      startedAtMs: args.startedAtMs,
      completion
    });
    return await completion;
  });

  // 確認記帳（Confirm）：直接呼叫 Activity 寫 DB，不入列避免阻塞緒列
  setHandler(confirmLedgerUpdate, async (args: ConfirmLedgerArgs): Promise<string> => {
    return await acts.saveLedger({
      userId: args.userId,
      sessionId: args.sessionId,
      title: args.proposal.title,
      amountCents: args.proposal.amountCents,
      occurredAtMs: args.proposal.occurredAtMs
    });
  });

  // 取消訊號：取消當前作用域，讓等待中的 Activity/計時器立即拋出取消錯誤
  setHandler(cancelSignal, () => {
    currentScope?.cancel();
  });

  async function dispatchByCapability(item: QueueItem): Promise<void> {
    const capability = await acts.decideCapability(item.userMessage);
    switch (capability) {
      case 'weather': {
        const reply = await acts.weatherReply(item.userMessage);
        item.completion.resolve(reply);
        return;
      }
      case 'ledger_proposal': {
        console.log('parseLedgerProposal', item);
        const ledger = await acts.parseLedgerProposal({
          userId: item.userId,
          sessionId: item.sessionId,
          userMessage: item.userMessage,
          startedAtMs: item.startedAtMs
        });
        const payload = JSON.stringify({
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
        item.completion.resolve(payload);
        return;
      }
      case 'ledger_query': {
        const resultText = await acts.queryLedgerRange(item);
        item.completion.resolve(resultText);
        return;
      }
      case 'chat':
      default: {
        const reply = await acts.chatReply(item.userMessage);
        item.completion.resolve(reply);
        return;
      }
    }
  }

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
      try {
        currentScope = new CancellationScope();
        await currentScope.run(() => dispatchByCapability(item));
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
