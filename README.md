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
Create `.env` files based on the examples:

- Backend: `backend/.env` (create this file in your local dev environment)
```
PORT=4000
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_NAMESPACE=default
OPENAI_API_KEY=sk-...
```

- Frontend: `frontend/.env.development` (optional; default is fine)
```
VITE_WS_URL=ws://localhost:4000/ws
```

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
- Start backend server and frontend together:
```bash
npm start
```

- Start everything including the Temporal worker:
```bash
npm run start:all
```

- Start pieces individually:
```bash
npm run start:backend
npm run start:worker
npm run start:frontend
```

Backend WebSocket endpoint: `ws://localhost:4000/ws`

### Flow
- The frontend sends `user_message` over WebSocket.
- The backend starts `chatTurnWorkflow` on task queue `chat-ai`.
- The workflow upserts Search Attributes and calls an activity that uses OpenAI.
- The backend awaits the workflow result and sends `assistant_message` back via WebSocket.

### Notes
- Streaming tokens is not implemented; responses are sent when the workflow completes. You can extend this by using workflow signals or backend-side streaming.
