# Temporal AI Chat

A full-stack AI chat application using Temporal (with Search Attributes), OpenAI, WebSockets, and a React frontend.

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
SQLITE_DB_PATH=./backend/chat.db
OPENAI_API_KEY=

VITE_WS_URL=ws://localhost:4000/ws
VITE_API_URL=http://localhost:4000
```

Both backend and frontend read this root `.env`. Do not commit local `.env` files or SQLite database files (`*.db`, `*.db-shm`, `*.db-wal`).

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

### Temporal Search Attributes
This app upserts the following Search Attributes for each chat turn workflow:
- `SessionId` (Keyword)
- `UserId` (Keyword)
- `UserMessage` (Text)
- `MessageLength` (Int)
- `StartedAt` (Datetime)

Register these Search Attributes in your Temporal namespace (one-time). Example using `tctl` for namespace `default`:

```bash
# Keyword attributes
tctl --namespace default sa create --name SessionId --type Keyword
tctl --namespace default sa create --name UserId --type Keyword

# Text attribute
tctl --namespace default sa create --name UserMessage --type Text

# Int attribute
tctl --namespace default sa create --name MessageLength --type Int

# Datetime attribute
tctl --namespace default sa create --name StartedAt --type Datetime
```

After registration, you can filter/search runs in Temporal Web by these attributes.

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
- The backend starts `chatTurnWorkflow` on task queue `chat-ai`.
- The workflow upserts Search Attributes and calls an activity that uses OpenAI.
- The backend awaits the workflow result and sends `assistant_message` back via WebSocket.

### Notes
- Streaming tokens is not implemented; responses are sent when the workflow completes. You can extend this by using workflow signals or backend-side streaming.
