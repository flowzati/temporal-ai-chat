import WebSocket, { RawData } from 'ws';
import { randomUUID } from 'crypto';
import { SendMessageParams } from '../types';
import { ChatWorkflowClient } from '../temporal/chatWorkflowClient';

// ==================== 常量定义 ====================
const MESSAGE_TYPES = {
  USER_MESSAGE: 'user_message',
  CANCEL: 'cancel',
  ASSISTANT_MESSAGE: 'assistant_message',
  ERROR: 'error',
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
  requestId?: string; // 幂等性：请求唯一标识
}

export interface CancelData extends BaseMessage {
  type: typeof MESSAGE_TYPES.CANCEL;
  sessionId: string;
  requestId?: string; // 幂等性：请求唯一标识
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
  workflowClient: ChatWorkflowClient;
  sendResponse: (response: AssistantMessageResponse | ErrorResponse) => void;
  sendError: (error: string, sessionId?: string) => void;
}

// 消息处理器类型
export type MessageHandler<T extends BaseMessage = BaseMessage> = (
  data: T,
  context: MessageHandlerContext
) => Promise<void>;

// 幂等性缓存：requestId -> { result, timestamp }
const idempotencyCache = new Map<string, { result: string; timestamp: number }>();
const IDEMPOTENCY_CACHE_TTL = 5 * 60 * 1000; // 5分钟过期
let idempotencyCleanupStarted = false;

/**
 * 啟動 requestId 快取清理器（在服务器启动时调用一次）
 */
export function startIdempotencyCacheCleanup(): void {
  if (idempotencyCleanupStarted) return;
  idempotencyCleanupStarted = true;

  setInterval(() => {
    const now = Date.now();
    for (const [requestId, record] of idempotencyCache.entries()) {
      if (now - record.timestamp > IDEMPOTENCY_CACHE_TTL) {
        idempotencyCache.delete(requestId);
      }
    }
  }, 60 * 1000); // 每分钟清理一次
}

// ==================== 工具函数 ====================
/**
 * 检查请求是否已处理（幂等性）
 */
function checkIdempotency(requestId?: string): string | null {
  if (!requestId) return null;
  
  const cached = idempotencyCache.get(requestId);
  if (cached) {
    console.log(`[Idempotency] Cache hit for requestId: ${requestId}`);
    return cached.result;
  }
  
  return null;
}

/**
 * 缓存请求结果（幂等性）
 */
function cacheIdempotencyResult(requestId: string | undefined, result: string): void {
  if (!requestId) return;
  
  idempotencyCache.set(requestId, {
    result,
    timestamp: Date.now(),
  });
  console.log(`[Idempotency] Cached result for requestId: ${requestId}`);
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

// ==================== 消息处理器 ====================
/**
 * 处理用户消息
 */
async function handleUserMessage(
  data: UserMessageData,
  context: MessageHandlerContext
): Promise<void> {
  console.log('[handleUserMessage]', { 
    userId: data.userId, 
    sessionId: data.sessionId,
    requestId: data.requestId 
  });
  
  // 验证数据
  if (!data.userId || !data.message) {
    return context.sendError('Invalid message data');
  }
  
  // 幂等性检查
  const cachedResult = checkIdempotency(data.requestId);
  if (cachedResult) {
    const { sessionId, isNewSession } = getOrGenSessionId(data.sessionId!);
    return context.sendResponse({
      type: MESSAGE_TYPES.ASSISTANT_MESSAGE,
      sessionId,
      userId: data.userId,
      message: cachedResult,
      isNewSession,
    });
  }
  
  // 处理 session ID
  var { sessionId, isNewSession } = getOrGenSessionId(data.sessionId!);
  
  try {
    const userMessage: SendMessageParams = {
      userId: data.userId,
      sessionId: sessionId,
      text: data.message,
      startedAtMs: Date.now(),
      requestId: data.requestId,
    };
    const reply = await context.workflowClient.sendMessage(userMessage);
    
    // 缓存结果
    cacheIdempotencyResult(data.requestId, reply);
    
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
 * 处理取消操作
 */
async function handleCancel(
  data: CancelData,
  context: MessageHandlerContext
): Promise<void> {
  console.log('[handleCancel]', { 
    sessionId: data.sessionId,
    requestId: data.requestId 
  });
  
  const { sessionId } = data;
  
  // 幂等性检查（对于 cancel，如果已处理则直接返回）
  const cachedResult = checkIdempotency(data.requestId);
  if (cachedResult) {
    console.log(`[handleCancel] Already processed: ${sessionId}`);
    return;
  }
  
  try {
    await context.workflowClient.cancelSession(sessionId);
    
    // 缓存结果（标记为已处理）
    cacheIdempotencyResult(data.requestId, 'cancelled');
    
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
  private workflowClient: ChatWorkflowClient;

  constructor(ws: WebSocket, workflowClient: ChatWorkflowClient) {
    this.ws = ws;
    this.workflowClient = workflowClient;
    this.registerHandlers();
  }

  /**
   * 注册消息处理器
   */
  private registerHandlers(): void {
    this.handlers.set(MESSAGE_TYPES.USER_MESSAGE, handleUserMessage as MessageHandler);
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
      workflowClient: this.workflowClient,
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
