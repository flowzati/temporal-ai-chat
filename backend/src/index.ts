import http from 'http';
import { loadConfig } from './utils/env';
import { createTemporalClient } from './utils/temporal';
import { createHttpRequestHandler } from './services/httpRouter';
import { setupWebSocketServer } from './services/websocketServer';
import { ChatWorkflowClient } from './temporal/chatWorkflowClient';

/**
 * 主程序：组合并启动 HTTP/WebSocket 服务器
 * 
 * 说明：
 * - HTTP REST API：提供 sessions / messages 读取（供前端载入历史）
 * - WebSocket：双向即时通讯，前端发送 user_message / confirm_ledger，后端回复 assistant_message
 */
async function main() {
  const config = loadConfig();

  // 创建 HTTP 服务器
  const httpHandler = createHttpRequestHandler();
  const server = http.createServer(httpHandler);

  // 初始化 Temporal Client
  const temporalClient = await createTemporalClient(config.temporalAddress, config.temporalNamespace);
  const workflowClient = new ChatWorkflowClient(temporalClient, config.temporalTaskQueue);

  // 设置 WebSocket 服务器
  setupWebSocketServer(server, workflowClient);

  // 启动服务器
  server.listen(config.port, () => {
    console.log(`[server] HTTP & WebSocket server listening on http://localhost:${config.port}`);
    console.log(`[server] - REST API: http://localhost:${config.port}/api/*`);
    console.log(`[server] - WebSocket: ws://localhost:${config.port}/ws`);
  });
}

main().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
