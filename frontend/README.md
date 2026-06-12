# Frontend - Temporal AI Chat

React + TypeScript + Vite 構建的聊天前端應用。

## 架構概覽

### 📁 項目結構

```
src/
├── App.tsx                  # 主應用組件（簡化版，約90行）
├── main.tsx                # 應用入口
├── types.ts                # TypeScript 類型定義
│
├── hooks/                  # 自定義 React Hooks
│   ├── useWebSocket.ts    # WebSocket 連接管理
│   ├── useSessions.ts     # 會話列表管理
│   ├── useMessages.ts     # 訊息歷史管理
│   ├── useChat.ts         # 聊天邏輯（發送/接收）
│   ├── useLedger.ts       # 記帳邏輯
│   └── index.ts           # Hook 導出
│
├── components/             # UI 組件
│   ├── Sidebar.tsx        # 側邊欄（會話列表）
│   ├── ChatMessage.tsx    # 單一訊息組件
│   ├── ChatMessages.tsx   # 訊息列表容器
│   ├── MessageInput.tsx   # 訊息輸入框
│   ├── LedgerConfirmCard.tsx  # 記帳確認卡片
│   └── index.ts           # 組件導出
│
└── utils/                  # 工具函數
    └── websocket.ts       # WebSocket 相關工具
```

## 設計原則

### 1. 關注點分離
- **Hooks**：處理業務邏輯和狀態
- **Components**：處理 UI 渲染
- **Utils**：處理純函數工具
- **Types**：集中管理類型定義

### 2. 單一職責
每個文件/組件只負責一個明確的功能：
- `useWebSocket`：只管理 WebSocket 連接
- `ChatMessage`：只渲染單一訊息
- `Sidebar`：只處理側邊欄 UI

### 3. 可重用性
組件和 hooks 設計為可在其他場景重用：
- `useWebSocket` 可用於任何 WebSocket 需求
- `ChatMessage` 可用於任何聊天界面

## 開發指南

### 安裝依賴

```bash
npm install
```

### 啟動開發伺服器

```bash
npm run dev
```

### 構建生產版本

```bash
npm run build
```

### 預覽生產版本

```bash
npm run preview
```

## 環境變數

在 `frontend/` 目錄建立 `.env.development`，或從 `frontend/.env.example` 複製：

```env
VITE_WS_URL=ws://localhost:4000/ws
VITE_API_URL=http://localhost:4000
```

## 主要功能模組

### 🔌 WebSocket 管理 (`useWebSocket`)

管理 WebSocket 連接的生命週期：

```typescript
const { wsRef, connected } = useWebSocket(wsUrl);
```

### 💬 聊天邏輯 (`useChat`)

處理用戶輸入、發送訊息、接收回覆：

```typescript
const { input, setInput, waitingReply, canSend, sendMessage, cancelAll } = useChat({
  wsRef,
  sessionId,
  userId,
  setMessages,
  setPendingLedger,
});
```

### 📋 會話管理 (`useSessions`)

自動載入和刷新會話列表：

```typescript
const sessions = useSessions(apiUrl);
```

### 📝 訊息管理 (`useMessages`)

根據 sessionId 載入歷史訊息：

```typescript
const { messages, setMessages, pendingLedger, setPendingLedger } = useMessages(apiUrl, sessionId);
```

### 💰 記帳功能 (`useLedger`)

處理記帳確認和取消：

```typescript
const { confirmLedger, cancelLedger } = useLedger({
  wsRef,
  sessionId,
  userId,
  pendingLedger,
  setPendingLedger,
  setMessages,
});
```

## UI 組件說明

### Sidebar
顯示會話列表，支持：
- 切換會話
- 創建新會話
- 顯示連接狀態
- 收起/展開

### ChatMessages
訊息列表容器，功能：
- 渲染所有訊息
- 自動捲動到最新
- 顯示記帳確認卡片

### MessageInput
訊息輸入框，特性：
- Enter 鍵發送
- 支持中文輸入法
- 動態按鈕（送出/取消）
- 禁用狀態管理

### LedgerConfirmCard
記帳確認界面，提供：
- 顯示記帳說明
- 確認按鈕
- 取消按鈕

## 添加新功能

### 添加新的 Hook

1. 在 `src/hooks/` 創建新文件
2. 導出自定義 hook
3. 在 `src/hooks/index.ts` 導出

```typescript
// src/hooks/useNewFeature.ts
export function useNewFeature() {
  // 你的邏輯
  return { /* 返回值 */ };
}

// src/hooks/index.ts
export { useNewFeature } from './useNewFeature';
```

### 添加新的組件

1. 在 `src/components/` 創建新文件
2. 定義 Props 介面
3. 在 `src/components/index.ts` 導出

```typescript
// src/components/NewComponent.tsx
interface NewComponentProps {
  // props 定義
}

export function NewComponent({ ... }: NewComponentProps) {
  return <div>...</div>;
}

// src/components/index.ts
export { NewComponent } from './NewComponent';
```

## 狀態管理流程

```
用戶輸入
  ↓
MessageInput 觸發 onSend
  ↓
useChat.sendMessage()
  ↓
WebSocket 發送訊息
  ↓
更新 messages 狀態
  ↓
ChatMessages 重新渲染
  ↓
自動捲動到底部
```

## 重構前後對比

| 指標 | 重構前 | 重構後 |
|------|--------|--------|
| App.tsx 行數 | 327 | ~90 |
| 文件數量 | 1 | 14 |
| 可測試性 | ❌ 困難 | ✅ 容易 |
| 可維護性 | ⚠️ 中等 | ✅ 優秀 |
| 可重用性 | ❌ 無 | ✅ 高 |
| 代碼組織 | ❌ 混亂 | ✅ 清晰 |

## 技術棧

- **React 18**：UI 框架
- **TypeScript**：類型安全
- **Vite**：構建工具
- **WebSocket**：實時通信

## 常見問題

### Q: 為什麼分這麼多文件？
A: 遵循單一職責原則，每個文件專注一個功能，提升可維護性和可測試性。

### Q: Hook 和 Component 的區別？
A: Hook 處理邏輯和狀態，Component 處理 UI 渲染。

### Q: 如何調試 WebSocket？
A: 打開瀏覽器開發者工具 → Network → WS，可以看到所有 WebSocket 訊息。

### Q: 訊息不自動捲動怎麼辦？
A: 檢查 `ChatMessages.tsx` 中的 `useEffect`，確保 `messages` 作為依賴項。

## 貢獻指南

1. 保持每個函數/組件的單一職責
2. 添加 TypeScript 類型定義
3. 遵循現有的命名慣例
4. 更新相關文檔

## 相關文檔

- [重構總結](../docs/frontend-refactoring.md)
- [測試指南](../docs/testing-guide.md)
- [項目架構](../docs/architecture.md)

## 授權

MIT
