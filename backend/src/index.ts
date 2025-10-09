import { WebSocketServer } from 'ws';
import http from 'http';
import { Connection, Client } from '@temporalio/client';
import { loadConfig } from './utils/env';

// 與工作流更新對應的參數型別
type SendMessageArgs = {
  userId: string;
  userMessage: string;
  startedAtMs: number;
};

async function createTemporalClient(address: string, namespace: string): Promise<Client> {
  const connection = await Connection.connect({ address });
  return new Client({ connection, namespace });
}

async function ensureSessionWorkflow(client: Client, sessionId: string, startedAtMs: number) {
  const workflowId = `chat-session-${sessionId}`;
  const handle = client.workflow.getHandle(workflowId);
  try {
    await handle.describe();
    return handle;
  } catch {
    // 不存在則啟動新的 session 工作流（entity）
    const newHandle = await client.workflow.start('chatSessionWorkflow', {
      args: [{ sessionId, startedAtMs }],
      taskQueue: 'chat-ai',
      workflowId,
    });
    return newHandle;
  }
}

async function main() {
  const config = loadConfig();

  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/ws' });

  const temporalClient = await createTemporalClient(config.temporalAddress, config.temporalNamespace);

  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data?.type === 'user_message') {
          const sessionId = String(data.sessionId ?? 'unknown');
          const args: SendMessageArgs = {
            userId: String(data.userId ?? 'anonymous'),
            userMessage: String(data.message ?? ''),
            startedAtMs: Date.now(),
          };

          if (!args.userMessage) {
            ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
            return;
          }

          // 取得或啟動該 session 的工作流（entity）
          const sessionHandle = await ensureSessionWorkflow(temporalClient, sessionId, Date.now());

          // 透過 Update 執行單次訊息處理並取得回覆（以 options.args 傳遞）
          const reply: string = await sessionHandle.executeUpdate('sendMessage', { args: [args] });

          ws.send(
            JSON.stringify({
              type: 'assistant_message',
              sessionId,
              userId: args.userId,
              message: reply,
            })
          );
        }
      } catch (err: any) {
        ws.send(JSON.stringify({ type: 'error', error: err?.message ?? 'Unknown error' }));
      }
    });
  });

  server.listen(config.port, () => {
    console.log(`[server] Listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
