import { WebSocketServer } from 'ws';
import http from 'http';
import { ChatWorkflowGateway } from '../types';
import { WebSocketRouter, startIdempotencyCacheCleanup } from './wsRouter';

/**
 * 创建并配置 WebSocket 服务器
 */
export function setupWebSocketServer(
  server: http.Server,
  workflowClient: ChatWorkflowGateway
): WebSocketServer {
  // 初始化 requestId 快取清理器（只执行一次）
  startIdempotencyCacheCleanup();
  
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // 为每个 WebSocket 连接创建一个轻量级路由器实例
    const router = new WebSocketRouter(ws, workflowClient);

    // 使用路由器分发消息
    ws.on('message', (raw) => router.dispatch(raw));
  });

  return wss;
}
