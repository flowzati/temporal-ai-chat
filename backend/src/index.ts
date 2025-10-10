import { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';
import { Connection, Client } from '@temporalio/client';
import { loadConfig } from './utils/env';
import { getMessages, insertMessage, listSessions, sessionExists, upsertSession } from './utils/db';

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

  const server = http.createServer((req, res) => {
    // Very small JSON REST without external deps
    const parsed = req?.url ? url.parse(req.url, true) : { pathname: '' as string, query: {} as any };
    const method = req?.method ?? 'GET';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === 'GET' && parsed.pathname === '/api/sessions') {
      const items = listSessions(200);
      res.end(JSON.stringify({ items }));
      return;
    }

    if (method === 'GET' && parsed.pathname?.startsWith('/api/sessions/') && parsed.pathname?.endsWith('/messages')) {
      const parts = parsed.pathname.split('/');
      const sessionId = parts[3] || '';
      if (!sessionId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Missing sessionId' }));
        return;
      }
      const items = getMessages(sessionId, 1000);
      res.end(JSON.stringify({ items }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
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
          const now = Date.now();
          // Upsert session and persist user message
          const title = sessionExists(sessionId) ? null : args.userMessage; // first user message as title
          upsertSession(sessionId, title, now);
          insertMessage(sessionId, 'user', args.userMessage, now);

          // 取得或啟動該 session 的工作流（entity）
          const sessionHandle = await ensureSessionWorkflow(temporalClient, sessionId, now);

          // 透過 Update 執行單次訊息處理並取得回覆（以 options.args 傳遞）
          const reply: string = await sessionHandle.executeUpdate('sendMessage', { args: [args] });

          // persist assistant message
          insertMessage(sessionId, 'assistant', reply, Date.now());

          ws.send(JSON.stringify({ type: 'assistant_message', sessionId, userId: args.userId, message: reply }));
        } else if (data?.type === 'confirm_ledger') {
          const sessionId = String(data.sessionId ?? 'unknown');
          const userId = String(data.userId ?? 'anonymous');
          const proposal = data.proposal;
          if (!proposal || typeof proposal?.title !== 'string' || typeof proposal?.amountCents !== 'number' || typeof proposal?.occurredAtMs !== 'number') {
            ws.send(JSON.stringify({ type: 'error', error: 'Invalid proposal' }));
            return;
          }

          const sessionHandle = await ensureSessionWorkflow(temporalClient, sessionId, Date.now());
          const reply: string = await sessionHandle.executeUpdate('confirmLedger', {
            args: [{ userId, sessionId, proposal }],
          });

          ws.send(JSON.stringify({ type: 'assistant_message', sessionId, userId, message: reply }));
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
