# Frontend 重構總結

## 概述

將原本 327 行的單一 `App.tsx` 組件重構為模組化、可維護的架構。

## 重構原則

1. **單一職責原則（SRP）**：每個組件和 hook 只負責一個功能
2. **關注點分離**：UI、邏輯、狀態管理分開
3. **可重用性**：創建可在其他地方使用的通用組件
4. **可測試性**：小型、獨立的模組更容易測試

## 架構變更

### 1. Types 定義 (`src/types.ts`)

集中管理所有 TypeScript 介面：
- `ChatMessage`：聊天訊息
- `SessionItem`：會話項目
- `LedgerProposal`：記帳提議
- `PendingLedger`：待確認的記帳

### 2. 自定義 Hooks (`src/hooks/`)

#### `useWebSocket.ts`
- 管理 WebSocket 連接生命週期
- 提供連接狀態和 WebSocket 引用

#### `useSessions.ts`
- 載入和管理會話列表
- 自動每 5 秒刷新

#### `useMessages.ts`
- 管理聊天訊息歷史
- 處理記帳提議的解析
- 根據 sessionId 自動載入歷史

#### `useChat.ts`
- 處理聊天輸入和發送
- 管理等待回覆狀態
- 處理 WebSocket 訊息接收
- 提供取消功能

#### `useLedger.ts`
- 管理記帳確認和取消邏輯
- 與 WebSocket 通信

### 3. UI 組件 (`src/components/`)

#### `Sidebar.tsx`
- 顯示會話列表
- 顯示連接狀態
- 處理會話切換和新建

#### `ChatMessage.tsx`
- 渲染單一聊天訊息
- 根據角色（user/assistant/system）顯示不同樣式

#### `ChatMessages.tsx`
- 訊息列表容器
- 自動捲動到最新訊息
- 整合記帳確認卡片

#### `MessageInput.tsx`
- 訊息輸入框
- 處理中文輸入法
- Enter 鍵發送
- 動態按鈕（送出/取消）

#### `LedgerConfirmCard.tsx`
- 記帳確認界面
- 確認/取消按鈕

### 4. Utilities (`src/utils/`)

#### `websocket.ts`
- WebSocket 消息類型定義
- 發送消息的輔助函數

## 主 App 組件變更

**之前**：327 行，包含所有邏輯
**之後**：約 90 行，只負責組合

### App.tsx 現在只做：
1. 管理頂層狀態（sessionId, userId, sidebarOpen）
2. 組合自定義 hooks
3. 渲染組件
4. 提供環境配置

## 優勢

### 1. 可維護性
- 每個文件職責清晰
- 容易找到和修改特定功能
- 減少單一文件的複雜度

### 2. 可重用性
- `ChatMessage` 可在其他聊天界面使用
- `useWebSocket` 可用於其他 WebSocket 功能
- `Sidebar` 可適配其他列表需求

### 3. 可測試性
- 每個 hook 可獨立測試
- 組件可用 mock props 測試
- 邏輯和 UI 分離

### 4. 可讀性
- 代碼組織清晰
- 職責明確
- 易於新成員理解

### 5. 可擴展性
- 新增功能時只需修改對應模組
- 不影響其他功能
- 遵循開放封閉原則

## 文件結構

```
frontend/src/
├── App.tsx                          # 主組件（簡化版）
├── main.tsx
├── types.ts                         # 類型定義
├── hooks/
│   ├── index.ts
│   ├── useWebSocket.ts             # WebSocket 連接
│   ├── useSessions.ts              # 會話管理
│   ├── useMessages.ts              # 訊息管理
│   ├── useChat.ts                  # 聊天邏輯
│   └── useLedger.ts                # 記帳邏輯
├── components/
│   ├── index.ts
│   ├── Sidebar.tsx                 # 側邊欄
│   ├── ChatMessage.tsx             # 單一訊息
│   ├── ChatMessages.tsx            # 訊息列表
│   ├── MessageInput.tsx            # 輸入框
│   └── LedgerConfirmCard.tsx       # 記帳確認卡片
└── utils/
    └── websocket.ts                # WebSocket 工具

```

## 代碼行數對比

| 文件 | 行數 | 職責 |
|------|------|------|
| **之前** |
| App.tsx | 327 | 所有功能 |
| **之後** |
| App.tsx | ~90 | 組合與配置 |
| types.ts | 18 | 類型定義 |
| hooks/* | ~250 | 狀態邏輯 |
| components/* | ~220 | UI 渲染 |
| utils/* | 30 | 工具函數 |
| **總計** | ~608 | 模組化架構 |

雖然總行數增加，但每個文件都更小、更專注，大大提升了代碼質量和可維護性。

## 設計模式應用

1. **自定義 Hook 模式**：封裝可重用的狀態邏輯
2. **組件組合模式**：小組件組合成大功能
3. **關注點分離**：邏輯、UI、數據分離
4. **單一職責原則**：每個模組一個職責
5. **依賴注入**：通過 props 傳遞依賴

## 未來改進建議

1. 添加單元測試
2. 使用狀態管理庫（如 Zustand 或 Redux）
3. 添加錯誤邊界
4. 實現 loading 狀態
5. 添加 TypeScript 嚴格模式
6. 實現消息搜索功能
7. 添加主題切換功能

