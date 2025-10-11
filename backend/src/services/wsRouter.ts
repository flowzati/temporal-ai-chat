import { Client, WorkflowHandle } from '@temporalio/client';
import WebSocket, { RawData } from 'ws';
import { randomUUID } from 'crypto';
import { UserMessage } from '../types';

// 消息处理器的上下文
export interface MessageHandlerContext {
  temporalClient: Client;
  ws: WebSocket;
  workflowHandleCache: Map<string, WorkflowHandle>; // 緩存 workflow handles
}

// 所有消息的基础接口
export interface BaseMessage {
  type: string;
  [key: string]: any;
}

// 消息处理器类型
export type MessageHandler = (data: any, context: MessageHandlerContext) => Promise<void>;

/**
 * 獲取或創建 session workflow（使用緩存優化性能）
 * 
 * @param client - Temporal 客戶端
 * @param sessionId - Session ID
 * @param startedAtMs - 啟動時間戳
 * @param cache - Workflow handle 緩存
 * @returns Workflow handle
 */
async function getOrCreateWorkflow(
  client: Client,
  sessionId: string,
  startedAtMs: number,
  cache: Map<string, WorkflowHandle>
): Promise<WorkflowHandle> {
  const workflowId = `chat-session-${sessionId}`;
  
  // 1. 先檢查緩存（避免重複的網絡請求）
  let handle = cache.get(workflowId);
  if (handle) {
    return handle;
  }
  
  // 2. 創建 handle（不立即驗證是否存在，樂觀執行）
  handle = client.workflow.getHandle(workflowId);
  cache.set(workflowId, handle);
  
  return handle;
}

/**
 * 創建新的 workflow 實例
 */
async function createWorkflow(
  client: Client,
  sessionId: string,
  startedAtMs: number,
  cache: Map<string, WorkflowHandle>
): Promise<WorkflowHandle> {
  const workflowId = `chat-session-${sessionId}`;
  
  const handle = await client.workflow.start(
    'chatSessionWorkflow', // workflow 函數名稱（需與 workflows.ts 中導出的函數名稱一致）
    {
      // 傳遞給 workflow 的參數列表（對應 workflow 函數的參數）
      args: [{ sessionId, startedAtMs }],
      
      // 指定 worker 監聽的任務隊列名稱（需與 worker.ts 中的 taskQueue 一致）
      taskQueue: 'chat-ai',
      
      // workflow 實例的唯一 ID，用於標識和查詢此 workflow
      // 格式：chat-session-${sessionId}，確保每個 session 只有一個 workflow 實例
      workflowId,
    }
  );
  
  // 更新緩存
  cache.set(workflowId, handle);
  return handle;
}

/**
 * 处理用户消息（優化版：移除 DB 操作，由 workflow 處理）
 */
async function handleUserMessage(data: any, context: MessageHandlerContext): Promise<void> {
  const { temporalClient, ws, workflowHandleCache } = context;
  let sessionId = String(data.sessionId ?? 'unknown');
  
  // 檢測是否需要創建新 session
  const isNewSession = sessionId === 'new' || sessionId === '' || sessionId === 'unknown';
  if (isNewSession) {
    sessionId = randomUUID(); // 生成新的 UUID
    console.log(`[handleUserMessage] Created new session: ${sessionId}`);
  }
  
  const args: UserMessage = {
    userId: String(data.userId ?? 'anonymous'),
    sessionId: sessionId,
    userMessage: String(data.message ?? '')
  };

  if (!args.userMessage) {
    console.log('[handleUserMessage] Empty message rejected');
    ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
    return;
  }

  const now = Date.now();

  try {
    // 1. 獲取 workflow handle（使用緩存）
    let sessionHandle = await getOrCreateWorkflow(temporalClient, sessionId, now, workflowHandleCache);
    
    // 2. 執行 workflow update（樂觀執行）
    let reply: string;
    try {
      reply = await sessionHandle.executeUpdate('sendMessage', { 
        args: [{ ...args, startedAtMs: now }] 
      });
    } catch (error: any) {
      // 如果 workflow 不存在，創建它然後重試
      if (error.message?.includes('not found') || error.message?.includes('workflow execution already completed')) {
        console.log(`[handleUserMessage] Workflow not found, creating new workflow for session: ${sessionId}`);
        sessionHandle = await createWorkflow(temporalClient, sessionId, now, workflowHandleCache);
        
        // 重試
        reply = await sessionHandle.executeUpdate('sendMessage', { 
          args: [{ ...args, startedAtMs: now }] 
        });
      } else {
        throw error;
      }
    }
    
    // 3. 發送回覆給前端（DB 已由 workflow 處理）
    ws.send(JSON.stringify({ 
      type: 'assistant_message', 
      sessionId: sessionId,
      userId: args.userId, 
      message: reply,
      isNewSession
    }));
    
    console.log(`[handleUserMessage] Message processed successfully for session: ${sessionId}`);
    
  } catch (error: any) {
    console.error(`[handleUserMessage] Error processing message for session ${sessionId}:`, error);
    
    // 通知前端錯誤
    ws.send(JSON.stringify({ 
      type: 'error', 
      error: `處理訊息失敗：${error?.message ?? 'Unknown error'}`,
      sessionId
    }));
  }
}

/**
 * 处理记账确认
 */
async function handleConfirmLedger(data: any, context: MessageHandlerContext): Promise<void> {
  const { temporalClient, ws, workflowHandleCache } = context;
  const sessionId = String(data.sessionId ?? 'unknown');
  const userId = String(data.userId ?? 'anonymous');
  const proposal = data.proposal as { title: string; amountCents: number; occurredAtMs: number };
  
  if (!proposal || typeof proposal.title !== 'string' || typeof proposal.amountCents !== 'number' || typeof proposal.occurredAtMs !== 'number') {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid proposal' }));
    return;
  }
  
  try {
    const sessionHandle = await getOrCreateWorkflow(temporalClient, sessionId, Date.now(), workflowHandleCache);
    const reply: string = await sessionHandle.executeUpdate('confirmLedger', { args: [{ userId, sessionId, proposal }] });
    ws.send(JSON.stringify({ type: 'assistant_message', sessionId, userId, message: reply }));
  } catch (error: any) {
    console.error(`[handleConfirmLedger] Error:`, error);
    ws.send(JSON.stringify({ 
      type: 'error', 
      error: `確認記帳失敗：${error?.message ?? 'Unknown error'}`,
      sessionId
    }));
  }
}

/**
 * 处理取消操作
 */
async function handleCancel(data: any, context: MessageHandlerContext): Promise<void> {
  const { temporalClient, ws, workflowHandleCache } = context;
  const sessionId = String(data.sessionId ?? 'unknown');
  
  try {
    const sessionHandle = await getOrCreateWorkflow(temporalClient, sessionId, Date.now(), workflowHandleCache);
    await sessionHandle.signal('cancel');
    // 工作流会自行回复取消消息，避免重复传送
  } catch (error: any) {
    console.error(`[handleCancel] Error:`, error);
    ws.send(JSON.stringify({ 
      type: 'error', 
      error: `取消操作失敗：${error?.message ?? 'Unknown error'}`,
      sessionId
    }));
  }
}

/**
 * WebSocket 消息路由器（優化版：添加 workflow handle 緩存）
 */
export class WebSocketRouter {
  private handlers: Map<string, MessageHandler> = new Map();
  private context: MessageHandlerContext;

  constructor(temporalClient: Client, ws: WebSocket) {
    this.context = {
      temporalClient,
      ws,
      workflowHandleCache: new Map(), // 初始化緩存
    };
    this.registerDefaultHandlers();
  }

  /**
   * 注册默认的消息处理器
   */
  private registerDefaultHandlers(): void {
    this.handlers.set('user_message', handleUserMessage);
    this.handlers.set('confirm_ledger', handleConfirmLedger);
    this.handlers.set('cancel', handleCancel);
  }

  /**
   * 处理接收到的消息
   */
  async dispatch(raw: RawData): Promise<void> {
    const { ws } = this.context;
    try {
      const data: BaseMessage = JSON.parse(String(raw));
      const handler = this.handlers.get(data.type);

      if (!handler) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: `Unknown message type: ${data.type}` 
        }));
        return;
      }

      await handler(data, this.context);
    } catch (err: any) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        error: err?.message ?? 'Unknown error' 
      }));
    }
  }
}

