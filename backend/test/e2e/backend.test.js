const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-ai-chat-e2e-'));
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.SQLITE_DB_PATH = path.join(tempDir, 'chat.db');
process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233';
process.env.TEMPORAL_NAMESPACE = 'default';
process.env.TEMPORAL_TASK_QUEUE = 'chat-ai';
process.env.TEMPORAL_SESSION_IDLE_TIMEOUT = '30m';
process.env.TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL = '1m';

const { createHttpRequestHandler } = require('../../dist/services/httpRouter');
const { setupWebSocketServer } = require('../../dist/services/websocketServer');
const { sweepIdleSessions } = require('../../dist/services/sessionIdleSweeper');
const db = require('../../dist/utils/db');

function createWorkflowClient() {
  const calls = {
    messages: [],
    cancels: [],
  };

  return {
    calls,
    client: {
      async sendMessage(params) {
        calls.messages.push(params);
        return `echo:${params.text}`;
      },
      async cancelSession(sessionId) {
        calls.cancels.push(sessionId);
      },
    },
  };
}

async function createTestServer(workflowClient) {
  const server = http.createServer(createHttpRequestHandler());
  const wss = setupWebSocketServer(server, workflowClient);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const body = await response.json();
  return { response, body };
}

async function sendWsMessage(wsUrl, message) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for WebSocket response'));
    }, 5000);

    ws.once('open', () => {
      ws.send(JSON.stringify(message));
    });

    ws.once('message', (data) => {
      clearTimeout(timeout);
      ws.close();
      resolve(JSON.parse(String(data)));
    });

    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function sendWsWithoutResponse(wsUrl, message) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 100);

    ws.once('open', () => {
      ws.send(JSON.stringify(message));
    });

    ws.once('message', () => {
      clearTimeout(timeout);
      ws.close();
      reject(new Error('Expected no WebSocket response'));
    });

    ws.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test('HTTP API lists sessions and messages from SQLite', async () => {
  const { client } = createWorkflowClient();
  const app = await createTestServer(client);

  try {
    db.upsertSession('session-http', 'HTTP fixture', 1000);
    db.insertMessage('session-http', 'user', 'hello', 1001, 'user-http-1');
    db.insertMessage('session-http', 'assistant', 'hi there', 1002, 'assistant-http-1');

    const sessions = await getJson(app.baseUrl, '/api/sessions');
    assert.equal(sessions.response.status, 200);
    assert.ok(sessions.body.items.some((item) => item.session_id === 'session-http'));

    const messages = await getJson(app.baseUrl, '/api/sessions/session-http/messages');
    assert.equal(messages.response.status, 200);
    assert.deepEqual(
      messages.body.items.map((item) => ({ role: item.role, content: item.content })),
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]
    );
  } finally {
    await app.close();
  }
});

test('HTTP API returns CORS preflight and not found responses', async () => {
  const { client } = createWorkflowClient();
  const app = await createTestServer(client);

  try {
    const options = await fetch(`${app.baseUrl}/api/sessions`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), '*');

    const missing = await getJson(app.baseUrl, '/api/unknown');
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, 'Not found');
  } finally {
    await app.close();
  }
});

test('WebSocket user_message starts a new session and returns assistant response', async () => {
  const { client, calls } = createWorkflowClient();
  const app = await createTestServer(client);

  try {
    const response = await sendWsMessage(app.wsUrl, {
      type: 'user_message',
      userId: 'user-e2e',
      sessionId: 'new',
      message: 'hello websocket',
      requestId: 'ws-new-session',
    });

    assert.equal(response.type, 'assistant_message');
    assert.equal(response.userId, 'user-e2e');
    assert.equal(response.message, 'echo:hello websocket');
    assert.equal(response.isNewSession, true);
    assert.notEqual(response.sessionId, 'new');
    assert.match(response.sessionId, /^[0-9a-f-]{36}$/);

    assert.equal(calls.messages.length, 1);
    assert.equal(calls.messages[0].sessionId, response.sessionId);
    assert.equal(calls.messages[0].requestId, 'ws-new-session');
    assert.equal(typeof calls.messages[0].startedAtMs, 'number');
  } finally {
    await app.close();
  }
});

test('WebSocket requestId cache returns the first result for duplicate requests', async () => {
  const { client, calls } = createWorkflowClient();
  const app = await createTestServer(client);
  const requestId = `ws-duplicate-${Date.now()}`;

  try {
    const first = await sendWsMessage(app.wsUrl, {
      type: 'user_message',
      userId: 'user-e2e',
      sessionId: 'session-cache',
      message: 'first',
      requestId,
    });

    const second = await sendWsMessage(app.wsUrl, {
      type: 'user_message',
      userId: 'user-e2e',
      sessionId: 'session-cache',
      message: 'second',
      requestId,
    });

    assert.equal(first.message, 'echo:first');
    assert.equal(second.message, 'echo:first');
    assert.equal(calls.messages.length, 1);
  } finally {
    await app.close();
  }
});

test('WebSocket returns errors for invalid messages', async () => {
  const { client, calls } = createWorkflowClient();
  const app = await createTestServer(client);

  try {
    const invalid = await sendWsMessage(app.wsUrl, {
      type: 'user_message',
      userId: '',
      sessionId: 'session-invalid',
      message: '',
    });

    assert.equal(invalid.type, 'error');
    assert.equal(invalid.error, 'Invalid message data');

    const unknown = await sendWsMessage(app.wsUrl, {
      type: 'unknown',
    });

    assert.equal(unknown.type, 'error');
    assert.equal(unknown.error, 'Unknown message type: unknown');
    assert.deepEqual(calls.messages, []);
  } finally {
    await app.close();
  }
});

test('WebSocket cancel signals the workflow client without sending a duplicate response', async () => {
  const { client, calls } = createWorkflowClient();
  const app = await createTestServer(client);

  try {
    await sendWsWithoutResponse(app.wsUrl, {
      type: 'cancel',
      sessionId: 'session-cancel',
      requestId: `cancel-${Date.now()}`,
    });
  } finally {
    assert.deepEqual(calls.cancels, ['session-cancel']);
    await app.close();
  }
});

test('session idle sweeper closes only idle open sessions', async () => {
  const nowMs = 10_000_000;
  const idleTimeoutMs = 30 * 60 * 1000;
  const cutoffMs = nowMs - idleTimeoutMs;
  const closedSessions = [];
  const closeCutoffs = [];

  db.upsertSession('session-idle-sweeper', 'Idle', nowMs - idleTimeoutMs - 1);
  db.upsertSession('session-active-sweeper', 'Active', nowMs);

  const closedCount = await sweepIdleSessions(
    {
      async closeSessionIfRunning(sessionId, closeCutoffMs) {
        closedSessions.push(sessionId);
        closeCutoffs.push(closeCutoffMs);
        return true;
      },
    },
    { idleTimeoutMs, nowMs }
  );

  assert.equal(closedCount, closedSessions.length);
  assert.ok(closedSessions.includes('session-idle-sweeper'));
  assert.ok(!closedSessions.includes('session-active-sweeper'));
  assert.ok(closeCutoffs.every((value) => value === cutoffMs));

  const stillIdle = db
    .listIdleOpenSessions(cutoffMs, 10)
    .map((session) => session.session_id);
  assert.ok(!stillIdle.includes('session-idle-sweeper'));
  assert.ok(!stillIdle.includes('session-active-sweeper'));
});
