import { WebSocketServer } from 'ws';
import { Client } from '@temporalio/client';
import http from 'http';
import { WebSocketRouter } from './wsRouter';

/**
 * 创建并配置 WebSocket 服务器
 */
export function setupWebSocketServer(server: http.Server, temporalClient: Client): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // 为每个 WebSocket 连接创建一个路由器实例
    const router = new WebSocketRouter({
      temporalClient: temporalClient,
      ws
    });

    // 使用路由器分发消息
    ws.on('message', (raw) => router.dispatch(raw));
  });

  return wss;
}

