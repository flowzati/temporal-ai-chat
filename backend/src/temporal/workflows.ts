import { proxyActivities, defineSignal, defineUpdate, setHandler, sleep, upsertSearchAttributes, continueAsNew, workflowInfo, condition, Trigger } from '@temporalio/workflow';

// 代理活動：定義可在工作流中呼叫的活動函式（會在 worker 上執行）
const { generateReply, generateReplyWithTools, decideUseTools } = proxyActivities<{
  generateReply: (args: { userMessage: string }) => Promise<string>;
  generateReplyWithTools: (args: { userMessage: string }) => Promise<string>;
  decideUseTools: (args: { userMessage: string }) => Promise<boolean>;
}>({
  startToCloseTimeout: '2 minute',
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

// 可選：提供取消訊號（保留未用）
export const cancelSignal = defineSignal('cancel');

// 定義 Update：單次訊息處理，回傳助理回覆（泛型順序為 <Return, [Args]>）
export const sendMessageUpdate = defineUpdate<string, [SendMessageArgs]>('sendMessage');

// Entity 風格的長駐工作流：每個 sessionId 對應一個工作流實體
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 以小型內存佇列保留最近 N 則訊息（僅 user/assistant，system 不存）
  const MAX_RECENT = 20;

  let recentMessages: { role: 'user' | 'assistant'; content: string }[] = startArgs.recentMessages ?? [];
  // 執行期佇列：Update 只入列，主循環負責出列處理
  const pendingQueue: { userMessage: string; completion: Trigger<string> }[] = [];

  // 初始化：可記錄初始搜尋屬性，以利後續查詢
  // await upsertSearchAttributes({
  //   SessionId: [startArgs.sessionId],
  //   StartedAt: [new Date(startArgs.startedAtMs)],
  // });

  let cancelled = false;
  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  // 設定 Update：入列後等待主循環處理完成
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    if (cancelled) return 'Request cancelled';
    const completion = new Trigger<string>();
    pendingQueue.push({ userMessage: args.userMessage, completion });
    return await completion;
  });

  // 保持工作流存活，等待更新（Updates）
  // 工作流在 sleep 期間仍能接收並處理 Update
  // 若要釋出資源，可設計閒置逾時後關閉或 ContinueAsNew
  // 這裡先簡化以長時間 sleep 方式維持存活
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const info = workflowInfo();
    // 等待：佇列有內容或建議 CAＮ
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);

    // 處理佇列（FIFO）
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift()!;

      const shouldUseTools = await decideUseTools({ userMessage: item.userMessage });
      const reply = shouldUseTools
        ? await generateReplyWithTools({ userMessage: item.userMessage })
        : await generateReply({ userMessage: item.userMessage });

      // 更新小型緩衝
      recentMessages.push({ role: 'user', content: item.userMessage });
      recentMessages.push({ role: 'assistant', content: reply });
      if (recentMessages.length > MAX_RECENT) {
        recentMessages = recentMessages.slice(recentMessages.length - MAX_RECENT);
      }

      item.completion.resolve(reply);
    }

    if (info.continueAsNewSuggested) {
      return continueAsNew<typeof chatSessionWorkflow>({
        sessionId: startArgs.sessionId,
        startedAtMs: startArgs.startedAtMs,
        recentMessages,
      });
    }
  }
}
