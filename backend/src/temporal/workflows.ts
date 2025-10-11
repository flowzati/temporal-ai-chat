import { proxyActivities, defineSignal, defineUpdate, setHandler, continueAsNew, workflowInfo, condition, Trigger, CancellationScope, isCancellation } from '@temporalio/workflow';
import { Capability, SendMessageArgs, SaveLedgerInput, StartSessionArgs, ConfirmLedgerArgs, QueueItem, ParsedLedgerProposalResult, SaveMessageArgs, InitializeSessionArgs } from '../types';

// 說明：本工作流採用 Entity/Virtual Actor 模式（每個 sessionId 對應一個長駐實體）。
// - Workflow 僅負責決策與協調（決定性），所有 I/O 交由 Activities 執行（避免非決定性）。
// - 以內存佇列 + condition 等待的方式串行處理訊息，確保順序與一致性。
export interface ChatActivities {
  decideCapability: (userMessage: string) => Promise<Capability>;
  chatReply: (userMessage: string) => Promise<string>;
  weatherReply: (userMessage: string) => Promise<string>;
  saveLedger: (args: SaveLedgerInput) => Promise<string>;
  parseLedgerProposal: (args: SendMessageArgs) => Promise<ParsedLedgerProposalResult>;
  queryLedgerRange: (args: SendMessageArgs) => Promise<string>;
  saveMessage: (params: SaveMessageArgs) => Promise<void>;
  initializeSession: (params: InitializeSessionArgs) => Promise<void>;
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
  let sessionInitialized = false; // 記錄 session 是否已初始化（避免重複 DB 查詢）
  
  // 🔑 幂等性：内存去重（方案 1.1）
  // 恢复从上一次 ContinueAsNew 传递的状态
  const processedRequestIds = new Set<string>(startArgs.processedRequestIds || []);
  const resultCache = new Map<string, string>();
  
  console.log(`[Workflow] Initialized with ${processedRequestIds.size} cached requestIds`);

  // Update：將訊息入列並等待主循環處理結果（以 Trigger 實現 deferred）
  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    console.log('sendMessageUpdate', args);
    
    // 🔑 幂等性检查：如果 requestId 已处理，直接返回缓存结果
    if (args.requestId && processedRequestIds.has(args.requestId)) {
      console.log(`[Workflow] Duplicate request detected: ${args.requestId}`);
      const cachedResult = resultCache.get(args.requestId);
      if (cachedResult) {
        console.log(`[Workflow] Returning cached result for: ${args.requestId}`);
        return cachedResult;
      }
      // 如果缓存结果不存在（ContinueAsNew 后），返回通用消息
      return '该消息已处理';
    }
    
    const completion = new Trigger<string>();
    pendingQueue.push({
      userId: args.userId,
      sessionId: args.sessionId,
      text: args.text,
      startedAtMs: args.startedAtMs,
      requestId: args.requestId,
      completion
    });
    
    const result = await completion;
    
    // 🔑 记录已处理的 requestId 和结果
    if (args.requestId) {
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
      console.log(`[Workflow] Cached result for: ${args.requestId}`);
    }
    
    return result;
  });

  // 確認記帳（Confirm）：直接呼叫 Activity 寫 DB，不入列避免阻塞緒列（支持幂等性）
  setHandler(confirmLedgerUpdate, async (args: ConfirmLedgerArgs): Promise<string> => {
    // 🔑 幂等性检查
    if (args.requestId && processedRequestIds.has(args.requestId)) {
      console.log(`[Workflow] Duplicate confirm ledger: ${args.requestId}`);
      return resultCache.get(args.requestId) || '该记账已确认';
    }
    
    const result = await acts.saveLedger({
      userId: args.userId,
      sessionId: args.sessionId,
      title: args.proposal.title,
      amountCents: args.proposal.amountCents,
      occurredAtMs: args.proposal.occurredAtMs,
      requestId: args.requestId, // 幂等性：传递 requestId
    });
    
    // 🔑 记录已处理
    if (args.requestId) {
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
    }
    
    return result;
  });

  // 取消訊號：取消當前作用域，讓等待中的 Activity/計時器立即拋出取消錯誤
  setHandler(cancelSignal, () => {
    currentScope?.cancel();
  });

  async function processMessage(item: QueueItem): Promise<void> {
    // 1. 初始化 session（只在第一條訊息時執行）
    if (!sessionInitialized) {
      await acts.initializeSession({
        sessionId: item.sessionId,
        title: item.text, // 首條訊息作為 session 標題
        timestamp: item.startedAtMs
      });
      sessionInitialized = true;
    }
    
    // 2. 保存用戶訊息到 DB（幂等性：使用 requestId 作为 messageId）
    const userMessageId = item.requestId ? `user-${item.requestId}` : undefined;
    await acts.saveMessage({
      sessionId: item.sessionId,
      role: 'user',
      content: item.text,
      timestamp: item.startedAtMs,
      messageId: userMessageId,
    });
    
    // 3. 根據能力分發處理
    const capability = await acts.decideCapability(item.text);
    let reply: string;
    
    switch (capability) {
      case 'weather': {
        reply = await acts.weatherReply(item.text);
        break;
      }
      case 'ledger_proposal': {
        console.log('parseLedgerProposal', item);
        const ledger = await acts.parseLedgerProposal({
          userId: item.userId,
          sessionId: item.sessionId,
          text: item.text,
          startedAtMs: item.startedAtMs,
          requestId: item.requestId,
        });
        reply = JSON.stringify({
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
        break;
      }
      case 'ledger_query': {
        reply = await acts.queryLedgerRange(item);
        break;
      }
      case 'chat':
      default: {
        reply = await acts.chatReply(item.text);
        break;
      }
    }
    
    // 4. 保存 AI 回覆到 DB（幂等性：使用 requestId 作为 messageId）
    await acts.saveMessage({
      sessionId: item.sessionId,
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
      messageId: `assistant-${item.requestId}`,
    });
    
    // 5. 返回結果給調用者
    item.completion.resolve(reply);
  }

  // 保持工作流存活，等待更新（Updates）
  // 若要釋出資源，可設計閒置逾時後關閉或 ContinueAsNew
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const info = workflowInfo()
    // 等待：佇列有內容或 Server 建議 ContinueAsNew（history 大小/長度門檻）
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);

    // 處理佇列（FIFO）
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift()!;
      try {
        currentScope = new CancellationScope();
        await currentScope.run(() => processMessage(item));
      } catch (err: any) {
        if (isCancellation(err)) {
          item.completion.resolve('已取消');
          
          // 保存取消訊息到 DB
          try {
            await acts.saveMessage({
              sessionId: item.sessionId,
              role: 'system',
              content: '已取消',
              timestamp: Date.now()
            });
          } catch {}
          continue;
        }
        
        // 錯誤處理
        const msg = String(err?.message ?? 'Unknown error');
        const errorMsg = msg.includes('Not a ledger') || msg.includes('Invalid date') || msg.includes('Unsupported range')
          ? `處理失敗：${msg}`
          : `系統錯誤：${msg}`;
        
        // 保存錯誤訊息到 DB
        try {
          await acts.saveMessage({
            sessionId: item.sessionId,
            role: 'system',
            content: errorMsg,
            timestamp: Date.now()
          });
        } catch (saveErr: any) {
          console.error('Failed to save error message:', saveErr);
        }
        
        item.completion.resolve(errorMsg);
      } finally {
        currentScope = null;
      }
    }

    if (info.continueAsNewSuggested) {
      // 🔑 清理并传递去重状态（时间窗口过滤）
      
      const now = Date.now();
      const ONE_HOUR_MS = 3600000; // 1 小时
      
      // 按时间窗口过滤（保留最近 1 小时）
      const idsToKeep = Array.from(processedRequestIds).filter(id => {
        const timestamp = parseInt(id.split('-')[0]);
        return !isNaN(timestamp) && (now - timestamp) < ONE_HOUR_MS;
      });
      
      // 🔑 监控：记录状态大小
      const stateSize = JSON.stringify(idsToKeep).length;
      console.log(`[ContinueAsNew] Keeping ${idsToKeep.length} requestIds (${stateSize} bytes)`);
      console.log(`[ContinueAsNew] Discarded ${processedRequestIds.size - idsToKeep.length} old requestIds`);
      
      if (stateSize > 100000) {
        console.warn(`[ContinueAsNew] Large state detected: ${stateSize} bytes`);
      }
      
      return continueAsNew<typeof chatSessionWorkflow>({
        sessionId: startArgs.sessionId,
        startedAtMs: startArgs.startedAtMs,
        processedRequestIds: idsToKeep, // 传递清理后的 requestIds
      });
    }
  }
}
