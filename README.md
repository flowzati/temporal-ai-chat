# Temporal AI Chat

A full-stack AI chat application using Temporal, OpenAI, WebSockets, and a React frontend.

### Stack
- Backend: Node.js, TypeScript, Temporal (Workflows/Worker), OpenAI SDK, WebSocket (`ws`)
- Frontend: React + Vite

### Prerequisites
- Node.js 18+
- Temporal cluster
  - Local dev server or Temporal Cloud
- OpenAI API key

### Environment
Create a root `.env` file based on the example:

```bash
cp .env.example .env
```

Then fill in `OPENAI_API_KEY` and adjust any local endpoints:

```env
PORT=4000
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=chat-ai
TEMPORAL_SESSION_IDLE_TIMEOUT=30m
TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL=1m
SQLITE_DB_PATH=./backend/chat.db
OPENAI_API_KEY=

VITE_WS_URL=ws://localhost:4000/ws
VITE_API_URL=http://localhost:4000
```

Both backend and frontend read this root `.env`. Do not commit local `.env` files or SQLite database files (`*.db`, `*.db-shm`, `*.db-wal`).

`TEMPORAL_SESSION_IDLE_TIMEOUT` controls how long a session can stay idle after its last saved activity before the backend closes it. `TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL` controls how often the backend server scans SQLite for idle open sessions and sends a `close` signal to the matching workflow.

### Install
From the repo root:

```bash
npm install --workspaces
```

If your npm doesn't support workspaces, run:
```bash
npm --prefix backend install
npm --prefix frontend install
```

### Run (dev)
- Start backend processes and frontend together:
```bash
npm start
```

- Start everything explicitly:
```bash
npm run start:all
```

- Start both backend processes together:
```bash
npm run start:backend
```

- Start pieces individually:
```bash
npm run start:server
npm run start:temporal-worker
npm run start:frontend
```

The backend entrypoints are named by process:
- `backend/src/server.ts` starts the HTTP/WebSocket server.
- `backend/src/temporalWorker.ts` starts the Temporal worker.

Backend WebSocket endpoint: `ws://localhost:4000/ws`

### Flow
- The frontend sends `user_message` over WebSocket.
- The backend sends an update to `chatSessionWorkflow` on task queue `chat-ai`.
- The workflow serializes messages for the session and delegates I/O to activities.
- Activities save chat history in SQLite and call OpenAI when a reply is needed.
- The backend awaits the workflow result and sends `assistant_message` back via WebSocket.
- The backend idle sweeper closes sessions that have been inactive longer than `TEMPORAL_SESSION_IDLE_TIMEOUT`.

### Notes
- Streaming tokens is not implemented; responses are sent when the workflow completes. You can extend this by using workflow signals or backend-side streaming.
