import { Client } from '@temporalio/client';
import WebSocket, { RawData } from 'ws';
import { randomUUID } from 'crypto';
import { UserMessage } from '../types';
import * as db from '../utils/db';


// 消息处理器的上下文
export interface MessageHandlerContext {
  temporalClient: Client;
  ws: WebSocket;
}

// 所有消息的基础接口
export interface BaseMessage {
  type: string;
  [key: string]: any;
}

// 消息处理器类型
export type MessageHandler = (data: any, context: MessageHandlerContext) => Promise<void>;

/**
 * 确保 session workflow 存在
 */
async function ensureSessionWorkflow(client: Client, sessionId: string, startedAtMs: number) {
  const workflowId = `chat-session-${sessionId}`;
  const handle = client.workflow.getHandle(workflowId);
  try {
    await handle.describe();
    return handle;
  } catch {
    // 若尚未存在，启动一个 entity workflow 实例
    const newHandle = await client.workflow.start(
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
    return newHandle;
  }
}

/**
 * 处理用户消息
 */
async function handleUserMessage(data: any, context: MessageHandlerContext): Promise<void> {
  const { temporalClient, ws } = context;
  let sessionId = String(data.sessionId ?? 'unknown');
  
  // 檢測是否需要創建新 session
  const isNewSession = sessionId === 'new' || sessionId === '' || sessionId === 'unknown';
  if (isNewSession) {
    sessionId = randomUUID(); // 生成新的 UUID
    console.log(`Created new session: ${sessionId}`);
  }
  
  const args: UserMessage = {
    userId: String(data.userId ?? 'anonymous'),
    sessionId: sessionId,
    userMessage: String(data.message ?? '')
  };

  if (!args.userMessage) {
    console.log('Empty message');
    ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
    return;
  }

  // 实体工作流：确保 session workflow 存在，并执行 Update
  const now = Date.now();
  const title = db.sessionExists(sessionId) ? null : args.userMessage; // 首则消息作为预设标题
  db.upsertSession(sessionId, title, now);
  db.insertMessage(sessionId, 'user', args.userMessage, now);

  // 实体工作流：确保 session workflow 存在，并执行 Update
  const sessionHandle = await ensureSessionWorkflow(temporalClient, sessionId, now);

  const reply: string = await sessionHandle.executeUpdate('sendMessage', { args: [{ ...args, startedAtMs: now }] });

  db.insertMessage(sessionId, 'assistant', reply, Date.now());
  ws.send(JSON.stringify({ 
    type: 'assistant_message', 
    sessionId: sessionId,
    userId: args.userId, 
    message: reply,
    isNewSession
  }));
}

/**
 * 处理记账确认
 */
async function handleConfirmLedger(data: any, context: MessageHandlerContext): Promise<void> {
  const { temporalClient, ws } = context;
  const sessionId = String(data.sessionId ?? 'unknown');
  const userId = String(data.userId ?? 'anonymous');
  const proposal = data.proposal as { title: string; amountCents: number; occurredAtMs: number };
  
  if (!proposal || typeof proposal.title !== 'string' || typeof proposal.amountCents !== 'number' || typeof proposal.occurredAtMs !== 'number') {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid proposal' }));
    return;
  }
  
  const sessionHandle = await ensureSessionWorkflow(temporalClient, sessionId, Date.now());
  const reply: string = await sessionHandle.executeUpdate('confirmLedger', { args: [{ userId, sessionId, proposal }] });
  ws.send(JSON.stringify({ type: 'assistant_message', sessionId, userId, message: reply }));
}

/**
 * 处理取消操作
 */
async function handleCancel(data: any, context: MessageHandlerContext): Promise<void> {
  const { temporalClient, ws } = context;
  const sessionId = String(data.sessionId ?? 'unknown');
  const sessionHandle = await ensureSessionWorkflow(temporalClient, sessionId, Date.now());
  await sessionHandle.signal('cancel');
  // 工作流会自行回复取消消息，避免重复传送
}

/**
 * WebSocket 消息路由器
 */
export class WebSocketRouter {
  private handlers: Map<string, MessageHandler> = new Map();
  private context: MessageHandlerContext;

  constructor(context: MessageHandlerContext) {
    this.context = context;
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

