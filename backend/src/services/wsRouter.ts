import { Client, WorkflowHandle } from '@temporalio/client';
import WebSocket, { RawData } from 'ws';
import { randomUUID } from 'crypto';
import { UserMessage } from '../types';

// ==================== 常量定义 ====================
const MESSAGE_TYPES = {
  USER_MESSAGE: 'user_message',
  CONFIRM_LEDGER: 'confirm_ledger',
  CANCEL: 'cancel',
  ASSISTANT_MESSAGE: 'assistant_message',
  ERROR: 'error',
} as const;

const WORKFLOW_CONFIG = {
  NAME: 'chatSessionWorkflow',
  TASK_QUEUE: 'chat-ai',
  ID_PREFIX: 'chat-session-',
} as const;

// ==================== 类型定义 ====================
// 消息类型
export interface BaseMessage {
  type: string;
  [key: string]: any;
}

export interface UserMessageData extends BaseMessage {
  type: typeof MESSAGE_TYPES.USER_MESSAGE;
  userId: string;
  sessionId?: string;
  message: string;
}

export interface ConfirmLedgerData extends BaseMessage {
  type: typeof MESSAGE_TYPES.CONFIRM_LEDGER;
  userId: string;
  sessionId: string;
  proposal: {
    title: string;
    amountCents: number;
    occurredAtMs: number;
  };
}

export interface CancelData extends BaseMessage {
  type: typeof MESSAGE_TYPES.CANCEL;
  sessionId: string;
}

// 响应类型
interface AssistantMessageResponse {
  type: typeof MESSAGE_TYPES.ASSISTANT_MESSAGE;
  sessionId: string;
  userId: string;
  message: string;
  isNewSession?: boolean;
}

interface ErrorResponse {
  type: typeof MESSAGE_TYPES.ERROR;
  error: string;
  sessionId?: string;
}

// Handler 上下文
export interface MessageHandlerContext {
  ws: WebSocket;
  sendResponse: (response: AssistantMessageResponse | ErrorResponse) => void;
  sendError: (error: string, sessionId?: string) => void;
}

// 消息处理器类型
export type MessageHandler<T extends BaseMessage = BaseMessage> = (
  data: T,
  context: MessageHandlerContext
) => Promise<void>;

// ==================== 全局单例 ====================
let globalTemporalClient: Client | null = null;
const globalWorkflowCache = new Map<string, WorkflowHandle>();

/**
 * 初始化全局 Temporal Client（在服务器启动时调用一次）
 */
export function initializeRouter(temporalClient: Client): void {
  globalTemporalClient = temporalClient;
}

// ==================== 工具函数 ====================
/**
 * 生成 workflow ID
 */
function getWorkflowId(sessionId: string): string {
  return `${WORKFLOW_CONFIG.ID_PREFIX}${sessionId}`;
}

/**
 * 检查错误是否为 workflow 不存在
 */
function isWorkflowNotFoundError(error: any): boolean {
  return (
    error.message?.includes('not found') ||
    error.message?.includes('workflow execution already completed')
  );
}

/**
 * 获取或创建 session ID
 */
function getOrGenSessionId(sessionId: string) {
  const isNewSession = !sessionId || sessionId === 'new' || sessionId === '';
  if (isNewSession) {
    sessionId = randomUUID();
    console.log(`[handleUserMessage] Created new session: ${sessionId}`);
  }
  return { sessionId, isNewSession };
}

/**
 * 获取 workflow handle（从缓存或创建新 handle）
 */
function getWorkflowHandle(sessionId: string): WorkflowHandle {
  const workflowId = getWorkflowId(sessionId);
  
  let handle = globalWorkflowCache.get(workflowId);
  if (!handle) {
    handle = globalTemporalClient!.workflow.getHandle(workflowId);
    globalWorkflowCache.set(workflowId, handle);
  }
  
  return handle;
}

/**
 * 创建新的 workflow 实例
 */
async function createWorkflow(
  sessionId: string,
  startedAtMs: number
): Promise<WorkflowHandle> {
  const workflowId = getWorkflowId(sessionId);
  
  const handle = await globalTemporalClient!.workflow.start(WORKFLOW_CONFIG.NAME, {
    args: [{ sessionId, startedAtMs }],
    taskQueue: WORKFLOW_CONFIG.TASK_QUEUE,
    workflowId,
  });
  
  globalWorkflowCache.set(workflowId, handle);
  return handle;
}

/**
 * 执行 workflow 操作（自动处理 workflow 不存在的情况）
 */
async function executeWorkflowOperation<T>(
  sessionId: string,
  operation: (handle: WorkflowHandle) => Promise<T>
): Promise<T> {
  let handle = getWorkflowHandle(sessionId);
  
  try {
    return await operation(handle);
  } catch (error: any) {
    if (isWorkflowNotFoundError(error)) {
      console.log(`[executeWorkflowOperation] Workflow not found, creating: ${sessionId}`);
      handle = await createWorkflow(sessionId, Date.now());
      return await operation(handle);
    }
    throw error;
  }
}

// ==================== 消息处理器 ====================
/**
 * 处理用户消息
 */
async function handleUserMessage(
  data: UserMessageData,
  context: MessageHandlerContext
): Promise<void> {
  console.log('[handleUserMessage]', { userId: data.userId, sessionId: data.sessionId });
  
  // 验证数据
  if (!data.userId || !data.message) {
    return context.sendError('Invalid message data');
  }
  
  // 处理 session ID
  var { sessionId, isNewSession } = getOrGenSessionId(data.sessionId!);
  
  const userMessage: UserMessage = {
    userId: data.userId,
    sessionId: sessionId,
    text: data.message,
  };
  
  try {
    const now = Date.now();
    const reply = await executeWorkflowOperation(sessionId, (handle) =>
      handle.executeUpdate('sendMessage', {
        args: [{ ...userMessage, startedAtMs: now }],
      })
    ) as string;
    
    context.sendResponse({
      type: MESSAGE_TYPES.ASSISTANT_MESSAGE,
      sessionId: sessionId,
      userId: data.userId,
      message: reply,
      isNewSession,
    });
    
    console.log(`[handleUserMessage] Success: ${sessionId}`);
  } catch (error: any) {
    console.error(`[handleUserMessage] Error:`, error);
    context.sendError(`處理訊息失敗：${error?.message ?? 'Unknown error'}`, sessionId);
  }
}

/**
 * 处理记账确认
 */
async function handleConfirmLedger(
  data: ConfirmLedgerData,
  context: MessageHandlerContext
): Promise<void> {
  console.log('[handleConfirmLedger]', { sessionId: data.sessionId });
  
  const { sessionId, userId, proposal } = data;
  
  // 验证 proposal 数据
  if (
    !proposal ||
    typeof proposal.title !== 'string' ||
    typeof proposal.amountCents !== 'number' ||
    typeof proposal.occurredAtMs !== 'number'
  ) {
    return context.sendError('Invalid proposal', sessionId);
  }
  
  try {
    const reply = await executeWorkflowOperation(sessionId, (handle) =>
      handle.executeUpdate('confirmLedger', { args: [{ userId, sessionId, proposal }] })
    ) as string;
    
    context.sendResponse({
      type: MESSAGE_TYPES.ASSISTANT_MESSAGE,
      sessionId,
      userId,
      message: reply,
    });
    
    console.log(`[handleConfirmLedger] Success: ${sessionId}`);
  } catch (error: any) {
    console.error(`[handleConfirmLedger] Error:`, error);
    context.sendError(`確認記帳失敗：${error?.message ?? 'Unknown error'}`, sessionId);
  }
}

/**
 * 处理取消操作
 */
async function handleCancel(
  data: CancelData,
  context: MessageHandlerContext
): Promise<void> {
  console.log('[handleCancel]', { sessionId: data.sessionId });
  
  const { sessionId } = data;
  
  try {
    await executeWorkflowOperation(sessionId, (handle) => handle.signal('cancel'));
    // 工作流会自行回复取消消息，避免重复传送
    console.log(`[handleCancel] Success: ${sessionId}`);
  } catch (error: any) {
    console.error(`[handleCancel] Error:`, error);
    context.sendError(`取消操作失敗：${error?.message ?? 'Unknown error'}`, sessionId);
  }
}

// ==================== WebSocket 路由器 ====================
/**
 * WebSocket 消息路由器（优化版：类型安全、全局资源、简化上下文）
 */
export class WebSocketRouter {
  private handlers: Map<string, MessageHandler> = new Map();
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    if (!globalTemporalClient) {
      throw new Error('Router not initialized. Call initializeRouter() first.');
    }
    this.ws = ws;
    this.registerHandlers();
  }

  /**
   * 注册消息处理器
   */
  private registerHandlers(): void {
    this.handlers.set(MESSAGE_TYPES.USER_MESSAGE, handleUserMessage as MessageHandler);
    this.handlers.set(MESSAGE_TYPES.CONFIRM_LEDGER, handleConfirmLedger as MessageHandler);
    this.handlers.set(MESSAGE_TYPES.CANCEL, handleCancel as MessageHandler);
  }

  /**
   * 发送 JSON 响应
   */
  private send(data: object): void {
    this.ws.send(JSON.stringify(data));
  }

  /**
   * 创建消息处理上下文
   */
  private createContext(): MessageHandlerContext {
    return {
      ws: this.ws,
      sendResponse: (response) => this.send(response),
      sendError: (error, sessionId) =>
        this.send({
          type: MESSAGE_TYPES.ERROR,
          error,
          ...(sessionId && { sessionId }),
        }),
    };
  }

  /**
   * 分发消息到对应的处理器
   */
  async dispatch(raw: RawData): Promise<void> {
    try {
      const data: BaseMessage = JSON.parse(String(raw));
      const handler = this.handlers.get(data.type);

      if (!handler) {
        return this.send({
          type: MESSAGE_TYPES.ERROR,
          error: `Unknown message type: ${data.type}`,
        });
      }

      const context = this.createContext();
      await handler(data, context);
    } catch (err: any) {
      console.error('[WebSocketRouter] Dispatch error:', err);
      this.send({
        type: MESSAGE_TYPES.ERROR,
        error: err?.message ?? 'Unknown error',
      });
    }
  }
}

