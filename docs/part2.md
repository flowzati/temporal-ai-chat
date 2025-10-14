# AI 對話平台 - 整合 Temporal 與 AI Agents (中)

在上一篇文章中，先展開了 Workflow 和 AI Agent 的本質差異，以及為什麼企業級 Workflow 能成為連線兩者的完美橋樑。

本篇將鳥瞰本專案的整體架構，理解一個 AI 對話平台是如何組織的，並為下一篇的深入程式碼實作做好鋪墊。

## 1. 專案概覽

### 1.1 核心定位

這是一個**具備記帳功能的 AI 對話平台**，AI 會自動判斷使用者意圖並路由到對應處理，使用者可以：

1. **日常聊天** (`chat`)：與 AI 進行日常對話
2. **天氣查詢** (`weather`)：查詢城市天氣資訊
3. **記帳新增** (`ledger_proposal`)：透過自然語言收支記帳（「今天買了午餐花了 120 元」）
4. **記帳查詢** (`ledger_query`)：查詢記帳特定時間範圍的收支（「本月花了多少」）
5. **記帳撤銷** (`ledger_undo`)：撤銷最近一筆記帳

### 1.2 系統模組總覽

系統分為五個主要模組，各司其職：

| 模組 | 核心職責 | 關鍵技術 |
|------|---------|---------|
| **WebSocket 通訊層** | 維持長連線、路由訊息、管理 Temporal Client | Handle 快取、冪等性快取 |
| **Workflow 協調層** | 編排對話流程、處理錯誤 | Entity Pattern、順序處理、ContinueAsNew |
| **AI 決策層** | 意圖判斷、資料解析、自然語言回覆 | OpenAI Agents SDK、結構化輸出 |
| **資料持久化層** | 保存會話/訊息、記帳 CRUD | 唯一約束、時間範圍查詢 |
| **前端狀態管理** | 管理連線、處理訊息收發、本地狀態 | 自定義 Hooks、樂觀更新 |

### 1.3 技術堆疊

- 後端
  - **Runtime**: Node.js 18+ + TypeScript
  - **Workflow Engine**: Temporal（核心協調層）- 提供「業務邏輯即程式碼」+「分散式可靠性」的流程引擎
  - **AI Framework**: OpenAI Agents SDK（智慧決策層）- 官方 SDK，支援 Function Calling、工具呼叫、結構化輸出
  - **Communication**: WebSocket (`ws`）- 雙向即時通訊，適合對話場景
  - **HTTP Server**: Node.js 原生 `http` 模組
  - **Database**: SQLite（輕量級持久化方案）
- 前端
  - **Framework**: React 18
  - **Build Tool**: Vite
  - **Communication**: WebSocket API

## 2. 架構全景圖

```text
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  ┌───────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐ │
│  │  useChat  │  │ useWebSocket│ │useMessages│ │  useSessions │ │
│  └─────┬─────┘  └──────┬──────┘ └────┬─────┘ └──────┬───────┘ │
│        │                │              │              │          │
│        └────────────────┴──────────────┴──────────────┘          │
│                          │                                        │
└──────────────────────────┼────────────────────────────────────────┘
                           │ WebSocket (ws://localhost:4000/ws)
                           │
┌──────────────────────────┼────────────────────────────────────────┐
│                      Backend (Node.js)                            │
│                          │                                        │
│  ┌───────────────────────▼─────────────────────────────┐         │
│  │          WebSocket Server (websocketServer.ts)      │         │
│  │  ┌──────────────────────────────────────────────┐  │         │
│  │  │     WebSocket Router (wsRouter.ts)           │  │         │
│  │  │  ┌────────────────┐  ┌───────────────────┐  │  │         │
│  │  │  │ handleUserMsg  │  │   handleCancel    │  │  │         │
│  │  │  └───────┬────────┘  └────────┬──────────┘  │  │         │
│  │  └──────────┼──────────────────────┼─────────────┘  │         │
│  └─────────────┼──────────────────────┼────────────────┘         │
│                │                      │                           │
│                ▼                      ▼                           │
│  ┌───────────────────────────────────────────────────┐           │
│  │         Temporal Client                           │           │
│  │  workflow.executeUpdate('sendMessage')            │           │
│  │  workflow.signal('cancel')                        │           │
│  └─────────────────────┬─────────────────────────────┘           │
└────────────────────────┼───────────────────────────────────────────┘
                         │ gRPC (localhost:7233)
                         │
┌────────────────────────▼───────────────────────────────────────────┐
│                  Temporal Server (Cluster)                         │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  Workflow Execution Engine                                │     │
│  │  - Event History Store                                    │     │
│  │  - Task Queue Dispatcher                                  │     │
│  │  - State Machine Manager                                  │     │
│  └──────────────────────────────────────────────────────────┘     │
└────────────────────────┬───────────────────────────────────────────┘
                         │ Task Queue: "chat-ai"
                         │
┌────────────────────────▼───────────────────────────────────────────┐
│                 Temporal Worker (worker.ts)                        │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  Workflows (workflows.ts)                                 │     │
│  │  ┌────────────────────────────────────────────────────┐  │     │
│  │  │  chatSessionWorkflow                                │  │     │
│  │  │  - Message Queue Management                         │  │     │
│  │  │  - Idempotency Control                              │  │     │
│  │  │  - Error Handling                                   │  │     │
│  │  │  - ContinueAsNew Logic                              │  │     │
│  │  └────────────────────────────────────────────────────┘  │     │
│  └─────────────────────────┬────────────────────────────────┘     │
│                            │ Activity Calls                        │
│  ┌─────────────────────────▼────────────────────────────────┐     │
│  │  Activities (activities.ts)                               │     │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐  │     │
│  │  │ AI Activities    │  │  DB Activities               │  │     │
│  │  │ - decideCapability│ │  - saveMessage              │  │     │
│  │  │ - chatReply       │ │  - initializeSession        │  │     │
│  │  │ - weatherReply    │ │  - saveLedger               │  │     │
│  │  │ - parseLedger...  │ │  - getLedgerEntries         │  │     │
│  │  └────────┬──────────┘  └────────┬────────────────────┘  │     │
│  └───────────┼──────────────────────┼───────────────────────┘     │
└──────────────┼──────────────────────┼─────────────────────────────┘
               │                      │
               ▼                      ▼
      ┌──────────────────┐   ┌──────────────────┐
      │  OpenAI API      │   │  SQLite DB       │
      │  (GPT-4)         │   │  - sessions      │
      │                  │   │  - messages      │
      │                  │   │  - ledger_entries│
      └──────────────────┘   └──────────────────┘
```

## 3. 資料流向：一條訊息的旅程

當使用者發送「今天買了午餐花了120元」，系統會經歷以下流程：

```text
前端 (React)
  ↓ 1. 產生 requestId，發送 WebSocket 訊息
  ↓
後端 (WebSocket Router)
  ↓ 2. 冪等性檢查 → 呼叫 Workflow.executeUpdate()
  ↓
Temporal Server
  ↓ 3. 路由到對應的 Workflow 實例
  ↓
Workflow (Worker)
  ↓ 4. Update Handler 接收 → 加入 Queue → 主迴圈處理
  ↓ 5. 呼叫 Activity: decideCapability() → 判斷為 'ledger_proposal'
  ↓ 6. 呼叫 Activity: parseLedgerProposal() → AI 解析記帳資訊
  ↓ 7. 呼叫 Activity: saveLedger() → 存入資料庫
  ↓ 8. 呼叫 Activity: saveMessage() → 存入對話記錄
  ↓ 9. 回傳結果給 Update Handler
  ↓
後端 (WebSocket Router)
  ↓ 10. 快取結果 → 發送 WebSocket 訊息
  ↓
前端 (React)
  ↓ 11. 顯示 AI 回覆：「已記帳：午餐 -120.00，時間 2025-10-11 12:00」
```

**關鍵特性**：

- **冪等性**：requestId 在多層確保不重複處理
- **順序性**：Queue 機制保證訊息按順序處理
- **可靠性**：每個步驟(Activity)都有重試和錯誤處理
- **可觀測性**：Temporal 記錄完整的執行歷史

---

## 4. 核心設計模式

### 4.1 Entity Pattern / Virtual Actor Pattern

**概念**：每個使用者會話（Session）對應一個獨立的長駐 Workflow 實例

**實作方式**：

- 使用會話 `sessionId` 作為 `workflowId`，確保一對一對應
- 首次訊息時啟動 Workflow，後續訊息透過 Update/Signal 與同一實例互動
- Workflow 在記憶體中維護會話狀態（已處理的 requestId、Queue 等）

**優點**：

- ✅ **狀態隔離**：不同使用者的對話互不干擾
- ✅ **順序保證**：同一使用者的訊息嚴格按順序處理
- ✅ **脈絡保持**：無需外部狀態儲存，Workflow 記憶體即狀態

### 4.2 記憶體 Queue + Condition 模式

**概念**：使用 Workflow 內建的記憶體 Queue 順序處理訊息，避免併發問題

**實作方式**：

- Update Handler 接收訊息後，立即加入 Queue 並回傳 Promise
- 主事件迴圈使用 `condition()` 等待 Queue 有內容
- 逐一處理訊息，完成後 `resolve()` 對應的 Promise，回傳結果

**為什麼不用並行處理？**

- AI 呼叫有上下文依賴（需要知道之前的對話）
- 記帳操作需要原子性（避免同時寫入造成資料不一致）
- 使用者期望看到「有序」的回覆

### 4.3 Workflow & Activity 邊界劃分

**原則**：Workflow 只做協調與決策，所有 I/O 和不確定性操作委派給 Activity

**在 Workflow 中可以做**：

- 條件判斷、分支邏輯
- 呼叫 Activity 並處理結果
- 純函式計算（如格式化、統計）
- 使用 Temporal API（condition、sleep、CancellationScope）

**必須在 Activity 中做**：

- 外部 API 呼叫（OpenAI、天氣 API）
- 資料庫操作（讀寫）
- 任何不確定性操作（Date.now()、Math.random()）
- 檔案系統操作

### 4.4 多層冪等性保證

**設計思維**：每一層都假設前一層可能失效，逐層防護

| 層級 | 位置 | 有效期 | 作用 |
|------|------|--------|------|
| **Layer 1** | Temporal Server | Workflow 執行期 | Update 的 `updateId` 提供精確一次語義 |
| **Layer 2** | Workflow 記憶體 | ContinueAsNew 間隔 | 避免重播時重複呼叫 Activity |
| **Layer 3** | Backend 記憶體 | 5分鐘 TTL | 減少 Workflow 呼叫壓力，快速回應重複請求 |
| **Layer 4** | 資料庫 | 永久 | 使用唯一約束（ledgerId/messageId）作為最後防線 |

**協同工作**：

- 使用者雙擊發送 → Layer 3 攔截，直接回傳快取
- Workflow 重放 → Layer 2 攔截，避免重複呼叫 AI
- Activity 重試 → Layer 4 攔截，資料庫拒絕重複插入

### 4.5 ContinueAsNew 模式

**問題**：長駐 Workflow 的事件歷史會無限增長，影響重放效能

**解決方案**：

- 當 Temporal 建議時（`continueAsNewSuggested`），主動重新啟動 Workflow
- 傳遞必要的狀態（如最近 1000 個 requestId）
- 歷史事件歸檔，新實例從乾淨的狀態開始

**優點**：

- ✅ 歷史事件保持在合理範圍（重放速度快）
- ✅ 狀態持續性（冪等性資訊不丟失）
- ✅ 對外部透明（使用者無感知，workflowId 不變）

## 5. 可靠性保障

### 5.1 分層錯誤處理

系統採用**四層防護策略**，從前端到 Activity 逐層處理不同類型的錯誤：

- **前端層**：顯示友善訊息，不中斷使用者體驗
- **WebSocket 層**：攔截連線和驗證錯誤，記錄日誌
- **Workflow 層**：區分取消操作、業務錯誤、系統錯誤，回傳對應訊息
- **Activity 層**：統一包裝 I/O 錯誤，由 Temporal 自動重試（最多5次）

### 5.2 可觀測性

**Temporal Web UI** 提供完整的監控能力：

- 查看所有 Workflow 執行記錄和狀態
- 追蹤每個 Activity 的輸入輸出、執行時間
- 完整的事件歷史，可重放除錯
- 錯誤追蹤與重試記錄

**應用層日誌** 記錄關鍵操作和效能指標，輔助問題排查

## 6. 效能與擴充性

### 6.1 效能優化

系統透過多層快取和狀態管理實現高效運作：

- **多層冪等性快取**：減少重複計算和 AI 呼叫成本
- **Handle 複用**：避免重複建立連線
- **ContinueAsNew**：定期清理歷史，保持重放速度
- **佇列序列處理**：避免並發競爭

### 6.2 擴充性設計

**水平擴展**（Scale Out）：

- Worker 層和 Backend 層都可以啟動多個實例
- Temporal 自動分配任務，每個 Session 獨立的 Workflow 天然隔離

**垂直擴展**（Scale Up）：

- 增加 Worker 資源提升 AI 處理速度
- 資料庫索引優化查詢效能

**核心優勢**：無狀態 Backend + 有狀態 Workflow，實現彈性擴展與自動容錯

## 結語

本篇概覽了整個專案，展示 Temporal 如何與 AI Agent 協作：AI 負責判斷意圖、解析資料，Temporal 負責保證順序、防止重複、自動重試。Entity Pattern、多層冪等性等設計模式，讓 AI 的智慧決策能被可靠地執行。

下一篇將追蹤完整的記帳流程，看這些設計如何從架構落地到代碼。
