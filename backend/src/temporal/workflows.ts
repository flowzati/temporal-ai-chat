import { proxyActivities, defineSignal, defineUpdate, setHandler, upsertSearchAttributes, continueAsNew, workflowInfo, condition, Trigger } from '@temporalio/workflow';
// 說明：本工作流採用 Entity/Virtual Actor 模式（每個 sessionId 對應一個長駐實體）。
// - Workflow 僅負責決策與協調（決定性），所有 I/O 交由 Activities 執行（避免非決定性）。
// - 以內存佇列 + condition 等待的方式串行處理訊息，確保順序與一致性。

export interface Activities {
  decideCapability: (args: { text: string }) => Promise<'chat' | 'weather' | 'ledger_proposal' | 'ledger_query'>;
  generateReply: (args: { userMessage: string }) => Promise<string>;
  generateReplyWithTools: (args: { userMessage: string }) => Promise<string>;
  saveLedger: (args: { proposal: { userId: string; sessionId?: string | null; title: string; amountCents: number; occurredAtMs: number } }) => Promise<string>;
  parseLedgerIntent: (args: { userId: string; sessionId?: string | null; text: string; nowMs?: number }) => Promise<
    | { type: 'none' }
    | { type: 'proposal'; proposal: { userId: string; sessionId?: string | null; title: string; amountCents: number; occurredAtMs: number }; explain: string }
    | { type: 'query'; resultText: string }
  >;
}

// 代理活動：定義在 Worker 執行的函式（OpenAI、DB 存取等 I/O）
const acts = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5, backoffCoefficient: 2 },
});

export interface StartSessionArgs {
  sessionId: string; // 會話 ID（實體主鍵）
  startedAtMs: number; // 工作流起始時間（決定性來源於伺服器）
  // 小型內存佇列狀態（可選，供 ContinueAsNew 繼承）
  recentMessages?: { role: 'user' | 'assistant'; content: string }[];
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

// 定義 Update：單次訊息處理，回傳助理回覆（泛型順序為 <Return, [Args]>）
export const sendMessageUpdate = defineUpdate<string, [SendMessageArgs]>('sendMessage');
// 定義 Update：確認記帳
export const confirmLedgerUpdate = defineUpdate<string, [ConfirmLedgerArgs]>('confirmLedger');

// Entity 風格的長駐工作流：每個 sessionId 對應一個工作流實體
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 以小型內存佇列保留最近 N 則訊息（僅 user/assistant，system 不存）
  const MAX_RECENT = 20;

  let recentMessages: { role: 'user' | 'assistant'; content: string }[] = startArgs.recentMessages ?? [];
  // 執行期佇列：Update 只入列，主循環負責出列處理
  const pendingQueue: { userMessage: string; completion: Trigger<string>; userId: string }[] = [];

  // Helpers：維護最近訊息緩衝 & 統一回覆結束
  function addRecent(role: 'user' | 'assistant', content: string) {
    recentMessages.push({ role, content });
    if (recentMessages.length > MAX_RECENT) {
      recentMessages = recentMessages.slice(recentMessages.length - MAX_RECENT);
    }
  }

  function finalize(item: { userMessage: string; completion: Trigger<string> }, assistantContent: string) {
    addRecent('user', item.userMessage);
    addRecent('assistant', assistantContent);
    item.completion.resolve(assistantContent);
  }

  // Consolidated handlers：將各分支處理封裝，便於擴充與測試
  async function handleChat(item: { userMessage: string; completion: Trigger<string> }) {
    const reply = await acts.generateReply({ userMessage: item.userMessage });
    finalize(item, reply);
  }

  async function handleWeather(item: { userMessage: string; completion: Trigger<string> }) {
    const reply = await acts.generateReplyWithTools({ userMessage: item.userMessage });
    finalize(item, reply);
  }

  async function handleLedgerProposal(item: { userMessage: string; completion: Trigger<string>; userId: string }) {
    const ledger = await acts.parseLedgerIntent({ userId: item.userId, sessionId: startArgs.sessionId, text: item.userMessage, nowMs: Date.now() });
    if (ledger.type === 'proposal') {
      const payload = JSON.stringify({ __kind: 'ledger_proposal', proposal: ledger.proposal, explain: ledger.explain });
      finalize(item, payload);
      return;
    }
    await handleChat(item);
  }

  async function handleLedgerQuery(item: { userMessage: string; completion: Trigger<string>; userId: string }) {
    const ledger = await acts.parseLedgerIntent({ userId: item.userId, sessionId: startArgs.sessionId, text: item.userMessage, nowMs: Date.now() });
    if (ledger.type === 'query') {
      finalize(item, ledger.resultText);
      return;
    }
    await handleChat(item);
  }

  // 初始化：可記錄初始搜尋屬性（目前關閉，保留示例）
  // await upsertSearchAttributes({
  //   SessionId: [startArgs.sessionId],
  //   StartedAt: [new Date(startArgs.startedAtMs)],
  // });

  // Update：將訊息入列並等待主循環處理結果（以 Trigger 實現 deferred）
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    const completion = new Trigger<string>();
    pendingQueue.push({ userMessage: args.userMessage, completion, userId: args.userId });
    return await completion;
  });

  // 確認記帳（Confirm）：直接呼叫 Activity 寫 DB，不入列避免阻塞緒列
  setHandler(confirmLedgerUpdate, async (args: { userId: string; sessionId: string; proposal: { title: string; amountCents: number; occurredAtMs: number } }): Promise<string> => {
    const out = await acts.saveLedger({ proposal: { userId: args.userId, sessionId: args.sessionId, title: args.proposal.title, amountCents: args.proposal.amountCents, occurredAtMs: args.proposal.occurredAtMs } });
    // 更新小型緩衝
    addRecent('user', `確認記帳：${args.proposal.title}`);
    addRecent('assistant', out);
    return out;
  });

  // 保持工作流存活，等待更新（Updates）
  // 工作流在 sleep 期間仍能接收並處理 Update
  // 若要釋出資源，可設計閒置逾時後關閉或 ContinueAsNew
  // 這裡先簡化以長時間 sleep 方式維持存活
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const info = workflowInfo();
    // 等待：佇列有內容或 Server 建議 ContinueAsNew（history 大小/長度門檻）
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);

    // 處理佇列（FIFO）
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift()!;

      // 由 OpenAI 決策選擇功能：chat / weather / ledger_proposal / ledger_query（集中式路由）
      const capability = await acts.decideCapability({ text: item.userMessage });
      switch (capability) {
        case 'chat':
          await handleChat(item);
          continue;
        case 'ledger_proposal':
          await handleLedgerProposal(item);
          continue;
        case 'ledger_query':
          await handleLedgerQuery(item);
          continue;
        case 'weather':
        default:
          await handleWeather(item);
          continue;
      }
    }

    if (info.continueAsNewSuggested) {
      // 僅攜帶小型緩衝至新 run，避免 history 膨脹，提升重播效率
      return continueAsNew<typeof chatSessionWorkflow>({
        sessionId: startArgs.sessionId,
        startedAtMs: startArgs.startedAtMs,
        recentMessages,
      });
    }
  }
}
