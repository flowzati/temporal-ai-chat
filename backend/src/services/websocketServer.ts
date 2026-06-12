import { WebSocketServer } from 'ws';
import { Client } from '@temporalio/client';
import http from 'http';
import { WebSocketRouter, initializeRouter } from './wsRouter';

/**
 * 创建并配置 WebSocket 服务器
 */
export function setupWebSocketServer(
  server: http.Server,
  temporalClient: Client,
  temporalTaskQueue: string
): WebSocketServer {
  // 初始化全局路由器（只执行一次）
  initializeRouter(temporalClient, temporalTaskQueue);
  
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // 为每个 WebSocket 连接创建一个轻量级路由器实例
    const router = new WebSocketRouter(ws);

    // 使用路由器分发消息
    ws.on('message', (raw) => router.dispatch(raw));
  });

  return wss;
}
