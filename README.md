# Temporal AI Chat

這是一個使用 Temporal、OpenAI、WebSocket 與 React/Vite 建立的 AI 聊天範例專案。後端用 Temporal workflow 管理每個聊天 session，前端透過 WebSocket 傳送訊息並接收回覆。

## 技術棧

- Backend：Node.js、TypeScript、Temporal Workflow/Worker、OpenAI SDK、SQLite、WebSocket (`ws`)
- Frontend：React、Vite
- Workflow engine：Temporal

## 前置需求

- Node.js 18+
- npm workspaces
- 可連線的 Temporal server
  - 本機 Temporal dev server 或 Temporal Cloud 都可以
- OpenAI API key

## 環境變數

專案統一讀取 repo root 的 `.env`。先從範例建立本機設定：

```bash
cp .env.example .env
```

再填入 `OPENAI_API_KEY`，並視需要調整 Temporal、SQLite 或 frontend endpoint：

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

Backend 和 frontend 都讀取這個 root `.env`。請不要 commit 本機 `.env`、SQLite DB、build output 或 dependency 目錄；目前 `.gitignore` 已排除 `.env`、`*.db`、`*.db-shm`、`*.db-wal`、`dist/`、`node_modules/` 等檔案。

## 安裝

在 repo root 執行：

```bash
npm install --workspaces
```

## 啟動

啟動前請先確認 Temporal server 已經在 `TEMPORAL_ADDRESS` 指定的位置運行。

同時啟動 backend server、Temporal worker 和 frontend：

```bash
npm start
```

等同於：

```bash
npm run start:all
```

只啟動 backend 兩個程序：

```bash
npm run start:backend
```

分別啟動各程序：

```bash
npm run start:server
npm run start:temporal-worker
npm run start:frontend
```

啟動後預設位址：

- Frontend：`http://localhost:5173/`
- Backend REST API：`http://localhost:4000/api/*`
- Backend WebSocket：`ws://localhost:4000/ws`

## Backend 程序說明

Backend 開發模式會啟動兩個 Node.js process：

- `backend/src/server.ts`：HTTP API、WebSocket server、idle session sweeper
- `backend/src/temporalWorker.ts`：Temporal worker，負責執行 workflow task 和 activity

Temporal worker 不會佔用 HTTP port。它透過 Temporal task queue (`TEMPORAL_TASK_QUEUE`) 接工作；HTTP/WebSocket port 只由 `server.ts` 使用。

## Session 與 idle cleanup

每個聊天 session 會對應到一個 `chatSessionWorkflow`。前端送出 `user_message` 後，backend 會對該 session workflow 發送 update，workflow 會依序處理訊息並呼叫 activities。

Session idle 關閉採用 DB-backed sweeper：

- `TEMPORAL_SESSION_IDLE_TIMEOUT`：session 最後活動後多久視為 idle，預設 `30m`
- `TEMPORAL_SESSION_IDLE_SWEEP_INTERVAL`：backend server 多久掃描一次 SQLite，預設 `1m`
- sweeper 找出超過 timeout 且尚未關閉的 session
- sweeper 對對應 workflow 發送 `close` signal
- workflow 收到 signal 後完成執行
- DB 會以 `closed_at_ms` 記錄 session 已關閉

這個設計避免每次訊息都在 Temporal workflow 裡建立新的 30 分鐘 timer。舊版本已存在的 workflow 仍保留 legacy timeout 路徑，用來避免 Temporal history replay 出現不相容。

## 資料儲存

預設 SQLite 檔案位置：

```text
./backend/chat.db
```

主要資料：

- `sessions`：session metadata、最後更新時間、關閉時間
- `messages`：使用者、assistant、system 訊息
- `ledger_entries`：記帳功能的資料

SQLite 檔案與 WAL sidecar 檔案只屬於本機資料，不應 commit。

## 測試與建置

Backend typecheck：

```bash
npm run typecheck -w backend
```

完整 build：

```bash
npm run build
```

Backend E2E 測試：

```bash
npm run test:e2e -w backend
```

E2E 測試會啟動暫時的 HTTP/WebSocket server 並使用暫存 SQLite DB，不會使用本機 `backend/chat.db`。

## 訊息流程

1. Frontend 透過 WebSocket 傳送 `user_message`
2. Backend 驗證訊息並決定 session id
3. Backend 對 `chatSessionWorkflow` 發送 `sendMessage` update
4. Workflow 將訊息排入 queue，確保同一個 session 內依序處理
5. Workflow 呼叫 activities 儲存訊息、判斷能力、呼叫 OpenAI 或查詢資料
6. Backend 等待 workflow update 結果
7. Backend 透過 WebSocket 回傳 `assistant_message`

## 目前限制

- 尚未實作 token streaming；回覆會在 workflow update 完成後一次送回。
- 本機開發需要 Temporal server、backend server、Temporal worker、frontend 都正常啟動。
