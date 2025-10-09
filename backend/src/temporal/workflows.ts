import { proxyActivities, defineSignal, defineUpdate, setHandler, sleep, upsertSearchAttributes } from '@temporalio/workflow';

// 代理活動：定義可在工作流中呼叫的活動函式（會在 worker 上執行）
const { generateReply } = proxyActivities<{ generateReply: (args: { userMessage: string }) => Promise<string> }>({
  startToCloseTimeout: '2 minute',
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

// 可選：提供取消訊號（保留未用）
export const cancelSignal = defineSignal('cancel');

// 定義 Update：單次訊息處理，回傳助理回覆（泛型順序為 <Return, [Args]>）
export const sendMessageUpdate = defineUpdate<string, [SendMessageArgs]>('sendMessage');

// Entity 風格的長駐工作流：每個 sessionId 對應一個工作流實體
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 初始化：可記錄初始搜尋屬性，以利後續查詢
  // await upsertSearchAttributes({
  //   SessionId: [startArgs.sessionId],
  //   StartedAt: [new Date(startArgs.startedAtMs)],
  // });

  let cancelled = false;
  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  // 設定 Update 處理邏輯：每次呼叫都可更新搜尋屬性並產生活動回覆
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    if (cancelled) return 'Request cancelled';

    // await upsertSearchAttributes({
    //   SessionId: [startArgs.sessionId],
    //   UserId: [args.userId],
    //   UserMessage: [args.userMessage],
    //   MessageLength: [args.userMessage.length],
    //   StartedAt: [new Date(args.startedAtMs)],
    // });

    const reply = await generateReply({ userMessage: args.userMessage });
    return reply;
  });

  // 保持工作流存活，等待更新（Updates）
  // 工作流在 sleep 期間仍能接收並處理 Update
  // 若要釋出資源，可設計閒置逾時後關閉或 ContinueAsNew
  // 這裡先簡化以長時間 sleep 方式維持存活
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep('30 days');
  }
}
