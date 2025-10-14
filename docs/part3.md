# AI 對話平台 - Temporal 與 AI Agents 協作 (下)

## 前言

前兩篇文章中，我們討論了 Workflow 與 AI Agent 的本質差異及優勢（上），以及本專案的架構全景（中）。

本篇要深入程式碼的實作細節了，逐行理解 Temporal 如何在實際專案中與 AI Agent 協作，以及那些讓系統變得可靠、可擴展的工程重點。

---

## 1. Workflow 核心實作：chatSessionWorkflow

### 1.1 整體結構

這個 Workflow 採用了 Entity Pattern，讓我們從 `workflows.ts` 的主入口開始：

```typescript
// /backend/src/temporal/workflows.ts
export async function chatSessionWorkflow(startSessionParams: StartSessionParams): Promise<void> {
  // -------------------- 初始化 Helper Classes --------------------
  const idempotency = new IdempotencyManager(startSessionParams.processedRequestIds);
  const messageQueue = new MessageQueue();
  const messageProcessor = new MessageProcessor(new ReplyGenerator());
  const cancellationManager = new CancellationManager();
  
  // -------------------- Update Handler: 訊息處理 --------------------
  setHandler(sendMessageUpdate, async (params: SendMessageParams): Promise<string> => {
    const cached = idempotency.getCached(params.requestId);
    if (cached) return cached;

    const completion = messageQueue.enqueue(params);
    const result = await completion;
    idempotency.putCached(params.requestId, result);
    return result;
  });
  
  // -------------------- Signal Handler: 取消 --------------------
  setHandler(cancelSignal, () => {
    cancellationManager.cancel();
  });
  
  // -------------------- 主事件循環 --------------------
  while (true) {
    // 等待佇列有內容或需要 ContinueAsNew
    await condition(() => !messageQueue.isEmpty() || workflowInfo().continueAsNewSuggested);
    
    // 處理佇列中的訊息
    while (!messageQueue.isEmpty()) {
      const message = messageQueue.dequeue()!;
      try {
        await cancellationManager.runCancellable(() =>
          messageProcessor.processMessage(message)
        );
      } catch (err: any) {
        await messageProcessor.handleError(err, message);
      }
    }
    
    // 執行 ContinueAsNew
    if (workflowInfo().continueAsNewSuggested) {
      const idsToKeep = idempotency.getIdsForContinueAsNew();
      performContinueAsNew(idsToKeep, startSessionParams.sessionId, startSessionParams.startedAtMs);
    }
  }
}
```

利用事件迴圈來做成的 **Entity Pattern**

- **Helper Classes**：使用 `IdempotencyManager`、`MessageQueue`、`MessageProcessor` 等類別封裝邏輯
- **外層迴圈**：等待 Queue 有內容或需要重新啟動（ContinueAsNew）
- **內層迴圈**：逐條處理訊息
- **非阻塞接收**：Update Handler 可以隨時接收新訊息

### 1.2 為什麼用 Queue + Condition？

為什麼不直接在 Update Handler 裡處理訊息？

```typescript
// ❌ 錯誤示範：併發處理
setHandler(sendMessageUpdate, async (params) => {
  // 問題：多個訊息同時呼叫，會併發執行
  const reply = await activities.getAIReply(params.text);
  return reply;
  // 結果：訊息亂序、競態條件、AI 上下文混亂
});
```

**正確做法**：佇列 + 主迴圈保證序列

```typescript
// ✅ 正確做法：順序處理
// 初始化 MessageQueue
const messageQueue = new MessageQueue();

setHandler(sendMessageUpdate, async (params) => {
  const cached = idempotency.getCached(params.requestId);
  if (cached) return cached;
  
  // 使用 MessageQueue 的 enqueue 方法
  const completion = messageQueue.enqueue(params);
  // 等待主迴圈處理完成
  const result = await completion;
  
  idempotency.putCached(params.requestId, result);
  return result;
});

// 主迴圈：一次只處理一條訊息
while (!messageQueue.isEmpty()) {
  const message = messageQueue.dequeue()!;
  await messageProcessor.processMessage(message); // 序列執行
  // processMessage 內部會 resolve completion
}
```

**優點**：

- ✅ 訊息嚴格按順序處理
- ✅ 避免 **Race Condition**
- ✅ AI 呼叫不會互相干擾
- ✅ 新訊息可以繼續進 Queue（不會因為處理中而 blocking）

### 1.3 Update vs Signal：何時用哪個？

Temporal 提供兩種與 Workflow 通訊的方式：

#### Update（同步，等待結果）

```typescript
// Workflow 端
const sendMessageUpdate = defineUpdate<string, [SendMessageParams]>('sendMessage');
setHandler(sendMessageUpdate, async (params) => {
  // 處理邏輯
  return reply; // 回傳結果
});

// 使用者端
const reply = await handle.executeUpdate('sendMessage', {
  args: [{ text: 'Hello', requestId: 'req-123' }],
  updateId: 'req-123', // 冪等性關鍵
});
// reply = "Hi there!" (同步獲得結果)
```

**特點**：

- 等待 Workflow 處理完成
- 回傳處理結果
- 支援冪等性（updateId）
- 適合：需要立即回覆的場景

#### Signal（非同步，不等待結果）

```typescript
// Workflow 端
const cancelSignal = defineSignal('cancel');
setHandler(cancelSignal, () => {
  currentScope?.cancel(); // 取消當前操作
});

// 使用者端
await handle.signal('cancel');
// 立即回傳，不等待處理結果
```

**特點**：

- 非同步發送，立即回傳
- 不回傳處理結果
- 適合：通知、取消、觸發狀態變化

**本專案的使用**：

- **Update**：使用者發送訊息（需要等待 AI 回覆）
- **Signal**：使用者取消操作（不需要等待結果）

### 1.4 CancellationScope：優雅的取消機制

如何實作「使用者點擊取消，立即停止 AI 呼叫」？

```typescript
// 初始化 CancellationManager
const cancellationManager = new CancellationManager();

// 主迴圈
while (!messageQueue.isEmpty()) {
  const message = messageQueue.dequeue()!;
  try {
    // 使用 CancellationManager 執行可取消的操作
    await cancellationManager.runCancellable(() =>
      messageProcessor.processMessage(message)
    );
  } catch (err: any) {
    // MessageProcessor.handleError 會處理取消和錯誤
    await messageProcessor.handleError(err, message);
  }
}

// Signal Handler 觸發取消
setHandler(cancelSignal, () => {
  cancellationManager.cancel();
});
```

**工作原理**：

1. `CancellationManager` 封裝了 `CancellationScope` 的管理邏輯
2. 使用者點擊取消 → 前端發送 `cancel` Signal
3. Signal Handler 呼叫 `cancellationManager.cancel()`
4. 正在執行的 Activity 呼叫被中斷
5. `MessageProcessor.handleError()` 使用 `isCancellation(err)` 判斷是取消操作
6. 回傳「已取消」訊息

**注意**：

- Activity 呼叫被取消時，Temporal 會自動清理資源
- 不需要手動處理「取消一半」的狀態
- 重放時不會重新執行被取消的 Activity

## 2. 冪等性實作：防止重複處理

### 2.1 為什麼需要多層冪等性？

在分散式系統中，重複請求無處不在：

- 使用者雙擊「發送」按鈕
- 網路抖動導致重試
- 前端與後端狀態不同步
- Workflow 重放時重新執行程式碼

**目標**：同一個請求（requestId）只處理一次，回傳相同的結果

### 2.2 Layer 1: Temporal 內建冪等性

```typescript
// 使用者端：使用 updateId
await handle.executeUpdate('sendMessage', {
  args: [{ text: 'Hello', requestId: 'req-123' }],
  updateId: 'req-123', // 關鍵！
});

// 如果再次呼叫相同的 updateId
await handle.executeUpdate('sendMessage', {
  args: [{ text: 'Hello', requestId: 'req-123' }],
  updateId: 'req-123',
});
// Temporal 會直接回傳第一次的結果，不會重新執行
```

**Temporal 如何實作？**

- Update 執行時，記錄 `updateId` 到事件歷史
- 再次收到相同 `updateId` → 查找事件歷史 → 回傳之前的結果
- 這是**確定性**的（重播時行為一致）

**局限性**：

- 只在 Workflow 執行期間有效
- ContinueAsNew 後歷史被清空（需要額外機制）

### 2.3 Layer 2: Workflow 記憶體快取

```typescript:backend/src/temporal/workflows.ts
class IdempotencyManager {
  private processedIds: Set<string>;
  private resultCache: Map<string, string>;

  constructor(initialIds: string[] = []) {
    this.processedIds = new Set(initialIds);
    this.resultCache = new Map();
  }

  getCached(requestId?: string): string | null {
    if (!requestId || !this.processedIds.has(requestId)) return null;
    return this.resultCache.get(requestId) || IDEMPOTENCY_CONFIG.duplicateMessage;
  }

  putCached(requestId: string | undefined, result: string): void {
    if (requestId) {
      this.processedIds.add(requestId);
      this.resultCache.set(requestId, result);
    }
  }

  getIdsForContinueAsNew(): string[] {
    const allIds = Array.from(this.processedIds);
    const idsToKeep = allIds.slice(-IDEMPOTENCY_CONFIG.maxCachedRequestIds);
    console.log(`[ContinueAsNew] ${idsToKeep.length}/${allIds.length} IDs`);
    return idsToKeep;
  }
}
```

**使用方式**：

```typescript
// 初始化（接收 ContinueAsNew 傳遞的狀態）
const idempotency = new IdempotencyManager(startSessionParams.processedRequestIds);

// Update Handler 中檢查
setHandler(sendMessageUpdate, async (params: SendMessageParams): Promise<string> => {
  const cached = idempotency.getCached(params.requestId);
  if (cached) return cached; // 重放時立即回傳

  const completion = messageQueue.enqueue(params);
  const result = await completion;
  idempotency.putCached(params.requestId, result);
  return result;
});
```

**為什麼需要這層？**

- Workflow 重放時，Update Handler 會重新執行
- 如果不快取，會重複呼叫 Activity（浪費 AI 呼叫成本）
- 快取後，重放時直接回傳結果（不呼叫 Activity）

### 2.4 Layer 3: 後端記憶體快取

```typescript:backend/src/services/wsRouter.ts
const idempotencyCache = new Map<string, { result: string; timestamp: number }>();
const IDEMPOTENCY_CACHE_TTL = 5 * 60 * 1000; // 5分鐘

function checkIdempotency(requestId?: string): string | null {
  if (!requestId) return null;
  
  const cached = idempotencyCache.get(requestId);
  if (cached) {
    console.log(`[Idempotency] Cache hit for requestId: ${requestId}`);
    return cached.result;
  }
  
  return null;
}

function cacheIdempotencyResult(requestId: string | undefined, result: string): void {
  if (!requestId) return;
  
  idempotencyCache.set(requestId, {
    result,
    timestamp: Date.now(),
  });
}
```

**使用場景**：

```typescript
async function handleUserMessage(data, context) {
  // 1. 先檢查快取
  const cached = checkIdempotency(data.requestId);
  if (cached) {
    return context.sendResponse({ message: cached }); // 直接回傳，不呼叫 Workflow
  }
  
  // 2. 呼叫 Workflow
  const reply = await handle.executeUpdate('sendMessage', {
    args: [{ text: data.message, requestId: data.requestId }],
    updateId: data.requestId,
  });
  
  // 3. 快取結果
  cacheIdempotencyResult(data.requestId, reply);
  
  return context.sendResponse({ message: reply });
}
```

**為什麼需要這層？**

- 減少 Workflow Update 呼叫（提升響應速度）
- 短期內的重複請求（如雙擊）可以立即回傳
- 5分鐘 TTL 避免記憶體無限增長

**與 Layer 2 的區別**：

- Layer 3 在後端記憶體（跨 Workflow）
- Layer 2 在 Workflow 記憶體（單個 Workflow）
- Layer 3 有過期時間，Layer 2 持續到 ContinueAsNew

### 2.5 Layer 4: 資料庫唯一約束

```typescript:backend/src/temporal/activities.ts
export async function saveLedger(proposal: SaveLedgerInput): Promise<string> {
  db.insertLedgerEntry({
    userId: proposal.userId,
    sessionId: proposal.sessionId ?? null,
    title: proposal.title,
    amountCents: proposal.amountCents,
    occurredAtMs: proposal.occurredAtMs,
    createdAtMs: Date.now(),
    ledgerId: `ledger-${proposal.requestId}`, // 唯一鍵
  });
  return '已存入記帳';
}
```

**資料庫 Schema**：

```sql
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id TEXT UNIQUE NOT NULL, -- 防止重複插入
  user_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
```

**工作原理**：

- 第一次插入：成功
- 重複插入相同 `ledgerId`：資料庫拒絕（UNIQUE 約束）
- Activity 捕捉錯誤，回傳「已存入」（冪等性）

**為什麼需要這層？**

- 最後的防線（即使前面三層都失效）
- 跨行程、跨重新啟動的冪等性
- 資料完整性保證

### 2.6 四層冪等性總結

| 層級 | 位置 | 有效期 | 作用 |
|------|------|--------|------|
| **Layer 1** | Temporal Server | Workflow 執行期 | Update 層級的精確一次語義 |
| **Layer 2** | Workflow 記憶體 | ContinueAsNew 間隔 | 避免重放時重複呼叫 Activity |
| **Layer 3** | Backend 記憶體 | 5分鐘 | 減少 Workflow 呼叫壓力 |
| **Layer 4** | 資料庫 | 永久 | 最終的資料完整性保證 |

**設計哲學**：
> 每一層都假設前一層可能失效，逐層防護，確保系統可靠性

## 3. AI Agent 整合：智慧決策的實作

### 3.1 Activity 邊界設計

在 Temporal 中，所有不確定性操作都必須封裝為 Activity：

```typescript
// /backend/src/temporal/activities.ts
export async function decideCapability(text: string): Promise<Capability> {
  try {
    return await ai.decideCapability(text); // 委派給 AI 模組
  } catch (err: any) {
    throw new Error(`decideCapability failed: ${err?.message ?? 'unknown error'}`);
  }
}
```

**為什麼要封裝？**

- AI 呼叫是不確定性的（同樣輸入可能不同輸出）
- 網路請求是 I/O 操作（Workflow 禁止）
- Activity 自動支援重試、超時、錯誤處理

### 3.2 能力路由：decideCapability

**核心任務**：判斷使用者訊息屬於哪種意圖

```typescript
// /backend/src/utils/ai.ts
export async function decideCapability(userMessage: string): Promise<Capability> {
  const schema = z.object({ 
    type: z.enum(['chat', 'weather', 'ledger_proposal', 'ledger_query', 'ledger_undo']) 
  });
  
  const agent = new Agent({
    name: 'Capability Router',
    instructions:
      '請判斷使用者訊息應該走哪個功能，僅輸出 JSON：{"type":"chat|weather|ledger_proposal|ledger_query|ledger_undo"}。\n' +
      '- 一般對話 → chat\n' +
      '- 問天氣、氣溫、下雨、晴、°C → weather\n' +
      '- 記帳新增/扣除 → ledger_proposal\n' +
      '- 查詢當日/昨日/特定日期/當月花費 → ledger_query\n' +
      '- 撤銷/刪除最近一筆記帳（例如：「撤銷」、「刪除上一筆」、「取消記帳」、「記錯了」） → ledger_undo',
  });
  
  const out = await run(agent, userMessage);
  const parsed = schema.parse(
    typeof out.finalOutput === 'string' ? JSON.parse(out.finalOutput) : out.finalOutput
  );
  
  return parsed.type as Capability;
}
```

**設計亮點**：

#### 結構化輸出 + Zod 驗證

```typescript
// AI 輸出（JSON 字串或對象）
const out = await run(agent, "台北天氣如何？");
// out.finalOutput = '{"type":"weather"}' 或 { type: 'weather' }

// 使用 Zod 驗證和解析
const parsed = schema.parse(
  typeof out.finalOutput === 'string' ? JSON.parse(out.finalOutput) : out.finalOutput
);
// 如果格式錯誤，Zod 會拋出例外（被 Activity 捕捉並重試）
```

**優點**：

- 類型安全（TypeScript 編譯時檢查）
- 執行時驗證（避免 AI 回傳非法值）
- 自動錯誤處理（格式錯誤 → Activity 重試）

#### 明確的 Instructions

```typescript
instructions:
  '請判斷使用者訊息應該走哪個功能，僅輸出 JSON：...\n' +
  '- 一般對話 → chat\n' +
  '- 問天氣、氣溫、下雨、晴、°C → weather\n' +
  // ...
```

**為什麼這樣寫？**

- 明確要求 JSON 格式（減少解析失敗）
- 列舉所有可能的類別（減少歧義）
- 給出判斷依據（提升準確度）

#### 錯誤處理

```typescript
export async function decideCapability(text: string): Promise<Capability> {
  try {
    return await ai.decideCapability(text);
  } catch (err: any) {
    throw new Error(`decideCapability failed: ${err?.message ?? 'unknown error'}`);
  }
}
```

**Activity 的重試配置**：

```typescript
const ACTIVITY_CONFIG = {
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,        // 最多重試 5 次
    backoffCoefficient: 2      // 指數退避（1s, 2s, 4s, 8s, 16s）
  }
} as const;

const activities = proxyActivities<ChatActivities>(ACTIVITY_CONFIG);
```

**如果 AI 呼叫失敗**：

1. 第一次失敗 → 等待 1 秒 → 重試
2. 第二次失敗 → 等待 2 秒 → 重試
3. ...
4. 第五次失敗 → 拋出例外到 Workflow
5. Workflow 回傳錯誤訊息給使用者

### 3.3 天氣查詢：weatherReply

```typescript:backend/src/utils/ai.ts
export async function weatherReply(userMessage: string): Promise<string> {
  const CitySchema = z.object({ city: z.string().min(1) });
  
  // 第一步：提取城市名稱
  const extractor = new Agent({
    name: 'City Extractor',
    instructions: '從使用者訊息中抽取欲查詢天氣的城市，只輸出 JSON:{"city":"Taipei"}；若無則 {"city":""}。',
  });
  
  const raw = String((await run(extractor, userMessage)).finalOutput || '').trim();
  let city = '';
  try {
    const parsed = CitySchema.safeParse(JSON.parse(raw));
    city = parsed.success ? parsed.data.city : '';
  } catch {
    city = '';
  }
  
  if (!city) return '請提供要查詢天氣的城市名稱，例如：台北天氣如何？';
  
  // 第二步：呼叫天氣 API
  const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`).then((r) => r.json());
  const weather = res?.current_condition?.[0];
  
  if (!weather) throw new Error(`無法取得 ${city} 的天氣資訊`);
  
  const desc = weather.weatherDesc?.[0]?.value ?? '';
  const temp = weather.temp_C ?? '?';
  
  return `${city} 現在約 ${temp}°C，天氣狀況：${desc}`;
}
```

**設計亮點**：

#### 1. 兩階段處理

- **階段 1**：AI 提取城市名稱（語義理解）
- **階段 2**：呼叫真實天氣 API（工具使用）

**為什麼不讓 AI 直接呼叫 API？**

- OpenAI Agents SDK 支援 Function Calling，但：
  - 需要額外配置工具定義
  - AI 可能判斷錯誤（不呼叫工具）
  - 兩階段方式更可控、可偵錯

#### 2. 容錯處理

```typescript
try {
  const parsed = CitySchema.safeParse(JSON.parse(raw));
  city = parsed.success ? parsed.data.city : '';
} catch {
  city = ''; // JSON 解析失敗 → 當作沒提取到
}

if (!city) return '請提供要查詢天氣的城市名稱...';
```

**錯誤情況**：

- AI 回傳非 JSON 格式 → catch → 提示使用者
- AI 回傳 `{"city":""}` → 檢查空字串 → 提示使用者
- 天氣 API 失敗 → Activity 重試 → 最後回傳錯誤

---

## 4. 實戰案例：追蹤一筆記帳的完整生命週期

讓我們追蹤這條訊息的完整旅程：

**使用者輸入**：「昨天中午買了午餐花了120元」

### 4.1 前端 (Frontend)

```typescript
// 1. 使用者點擊發送
sendMessage(); // hooks/useChat.ts

// 2. 產生 requestId
const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
// → "1697123456789-abc123def"

// 3. 發送 WebSocket 訊息
sendWebSocketMessage(wsRef.current, {
  type: 'user_message',
  sessionId: 'session-456',
  userId: 'user-789',
  message: '昨天中午買了午餐花了120元',
  requestId: requestId,
});

// 4. 樂觀更新 UI（立即顯示使用者訊息）
setMessages((prev) => [
  ...prev,
  { role: 'user', content: '昨天中午買了午餐花了120元' },
]);
setWaitingReply(true); // 顯示載入動畫
```

### 4.2 後端 - WebSocket Router (Backend)

```typescript
// services/wsRouter.ts

// 1. 接收 WebSocket 訊息
async function handleUserMessage(data, context) {
  console.log('[handleUserMessage]', { 
    userId: 'user-789', 
    sessionId: 'session-456',
    requestId: '1697123456789-abc123def' 
  });
  
  // 2. 冪等性檢查（記憶體快取）
  const cached = checkIdempotency('1697123456789-abc123def');
  if (cached) {
    return context.sendResponse({ message: cached }); // 快取命中，直接回傳
  }
  
  // 3. 獲取 Workflow Handle
  const handle = getWorkflowHandle('session-456');
  // → workflowId = "chat-session-session-456"
  
  // 4. 呼叫 Workflow Update
  try {
    const reply = await handle.executeUpdate('sendMessage', {
      args: [{
        userId: 'user-789',
        sessionId: 'session-456',
        text: '昨天中午買了午餐花了120元',
        startedAtMs: Date.now(),
        requestId: '1697123456789-abc123def',
      }],
      updateId: '1697123456789-abc123def', // Temporal 冪等性
    });
    
    // 5. 快取結果
    cacheIdempotencyResult('1697123456789-abc123def', reply);
    
    // 6. 回傳給前端
    context.sendResponse({
      type: 'assistant_message',
      sessionId: 'session-456',
      userId: 'user-789',
      message: reply, // "已記帳：午餐 -120.00，時間 2024-10-11 12:00"
    });
  } catch (error) {
    context.sendError(`處理訊息失敗：${error.message}`);
  }
}
```

### 4.3 Workflow - Update Handler (Worker)

```typescript
// temporal/workflows.ts

// 1. Update Handler 被呼叫
setHandler(sendMessageUpdate, async (params) => {
  console.log('[sendMessageUpdate]', params.requestId);
  
  // 2. 冪等性檢查（Workflow 記憶體）
  const cached = idempotency.getCached(params.requestId);
  if (cached) {
    console.log('[sendMessageUpdate] Cache hit:', cached);
    return cached; // 重放時會走到這裡
  }
  
  // 3. 加入佇列
  const completion = new Trigger<string>();
  pendingQueue.push({
    userId: params.userId,
    sessionId: params.sessionId,
    text: params.text,
    startedAtMs: params.startedAtMs,
    requestId: params.requestId,
    completion: completion,
  });
  console.log('[sendMessageUpdate] Enqueued, queue length:', pendingQueue.length);
  
  // 4. 等待主迴圈處理
  const result = await completion;
  
  // 5. 快取結果
  idempotency.putCached(params.requestId, result);
  
  return result;
});
```

### 4.4 Workflow - 主迴圈處理 (Worker)

```typescript
// 主迴圈檢測到佇列有內容
while (true) {
  await condition(() => !messageQueue.isEmpty());
  
  // 處理佇列中的訊息
  while (!messageQueue.isEmpty()) {
    const message = messageQueue.dequeue()!;
    console.log('[mainLoop] Processing:', message.text);
    
    try {
      await cancellationManager.runCancellable(() =>
        messageProcessor.processMessage(message)
      );
    } catch (err: any) {
      await messageProcessor.handleError(err, message);
    }
  }
}

// MessageProcessor.processMessage 方法
class MessageProcessor {
  private sessionInitialized: boolean;
  private replyGenerator: ReplyGenerator;

  async processMessage(message: QueueItem): Promise<void> {
    // 0. 初始化 session（僅首次）
    if (!this.sessionInitialized) {
      await activities.initializeSession({
        sessionId: message.sessionId,
        title: message.text,
        timestamp: message.startedAtMs
      });
      this.sessionInitialized = true;
    }

    // 1. 儲存用戶訊息
    await activities.saveMessage({
      sessionId: message.sessionId,
      role: 'user',
      content: message.text,
      timestamp: message.startedAtMs,
      messageId: `user-${message.requestId}`,
    });

    // 2. 判斷能力並生成回覆（由 ReplyGenerator 處理）
    const reply = await this.replyGenerator.generateReply(message);
    // → "已記帳：午餐 -120.00，時間 2024-10-11 12:00"

    // 3. 儲存 AI 回覆
    await activities.saveMessage({
      sessionId: message.sessionId,
      role: 'assistant',
      content: reply,
      timestamp: message.startedAtMs,
      messageId: `assistant-${message.requestId}`,
    });

    // 4. 返回回覆
    message.completion.resolve(reply);
  }
}
```

### 4.5 Workflow - 記帳處理 (Worker)

```typescript
// ReplyGenerator 類別處理不同能力
class ReplyGenerator {
  async generateReply(message: QueueItem): Promise<string> {
    const capability = await activities.decideCapability(message.text);
    switch (capability) {
      case 'ledger_proposal':
        return this.handleLedgerProposal(message);
      case 'weather':
        return this.handleWeather(message);
      // ... 其他能力
    }
  }

  private async handleLedgerProposal(message: QueueItem): Promise<string> {
    // 1. 解析記帳提議（AI 呼叫）
    const ledgerProposal = await activities.parseLedgerProposal({
      userId: message.userId,
      sessionId: message.sessionId,
      text: message.text, // "昨天中午買了午餐花了120元"
      startedAtMs: message.startedAtMs,
      requestId: message.requestId,
    });
    // → {
    //   title: '午餐',
    //   amountCents: -12000,
    //   occurredAtMs: 1697011200000, // 昨天中午 12:00
    //   explain: '午餐 -120.00，時間 2024-10-11 12:00'
    // }

    // 2. 直接執行記帳（DB 操作）
    await activities.saveLedger({
      userId: ledgerProposal.userId,
      sessionId: ledgerProposal.sessionId,
      title: ledgerProposal.title,
      amountCents: ledgerProposal.amountCents,
      occurredAtMs: ledgerProposal.occurredAtMs,
      requestId: message.requestId,
    });

    // 3. 返回記帳確認訊息
    return `已記帳：${ledgerProposal.explain}`;
  }
}
```

### 4.6 Activity - AI 解析 (Worker)

```typescript
// temporal/activities.ts → utils/ai.ts

export async function parseLedgerProposal(params) {
  const now = new Date(); // 當前時間
  const agent = new Agent({
    name: 'Ledger Parser',
    instructions: `
      解析記帳資訊...
      當前時間：${now.toISOString()}
      昨天中午12點：${new Date(now.getTime() - 24*60*60*1000 + 12*60*60*1000).getTime()}
    `,
  });
  
  // AI 呼叫
  const result = await run(agent, '昨天中午買了午餐花了120元');
  // AI 輸出：
  // {
  //   kind: 'sub',
  //   item: '午餐',
  //   amount: 120,
  //   occurredAtMs: 1697011200000
  // }
  
  const parsed = JSON.parse(result.finalOutput);
  
  // 驗證和建構
  const built = ledger.buildLedgerProposalFields({
    parsed,
    userId: params.userId,
    sessionId: params.sessionId,
    now,
  });
  
  return {
    userId: built.userId,
    sessionId: built.sessionId,
    title: built.title, // '午餐'
    amountCents: built.amountCents, // -12000
    occurredAtMs: built.occurredAtMs, // 1697011200000
    explain: built.explain, // '午餐 -120.00，時間 2024-10-11 12:00'
  };
}
```

### 4.7 Activity - 資料庫儲存 (Worker)

```typescript
// temporal/activities.ts → utils/db.ts

export async function saveLedger(proposal) {
  db.insertLedgerEntry({
    userId: proposal.userId, // 'user-789'
    sessionId: proposal.sessionId, // 'session-456'
    title: proposal.title, // '午餐'
    amountCents: proposal.amountCents, // -12000
    occurredAtMs: proposal.occurredAtMs, // 1697011200000
    createdAtMs: Date.now(),
    ledgerId: `ledger-${proposal.requestId}`, // 'ledger-1697123456789-abc123def'
  });
  
  // SQL:
  // INSERT INTO ledger_entries (ledger_id, user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms)
  // VALUES ('ledger-1697123456789-abc123def', 'user-789', 'session-456', '午餐', -12000, 1697011200000, 1697123456789)
  
  return '已存入記帳';
}
```

### 4.8 前端 - 接收回覆 (Frontend)

```typescript
// hooks/useChat.ts

// WebSocket 收到訊息
ws.addEventListener('message', (evt) => {
  const data = JSON.parse(evt.data);
  
  if (data.type === 'assistant_message') {
    console.log('[useChat] Received reply:', data.message);
    
    // 1. 停止載入動畫
    setWaitingReply(false);
    
    // 2. 顯示 AI 回覆
    setMessages((prev) => [
      ...prev,
      { 
        role: 'assistant', 
        content: data.message // "已記帳：午餐 -120.00，時間 2024-10-11 12:00"
      },
    ]);
  }
});
```

### 4.9 完整時間線

```text
T+0ms    前端：使用者點擊發送，產生 requestId
T+5ms    前端：發送 WebSocket 訊息，樂觀更新 UI
T+10ms   後端：接收訊息，冪等性檢查（未命中）
T+15ms   後端：呼叫 Workflow.executeUpdate
T+20ms   Workflow：Update Handler 加入佇列
T+25ms   Workflow：主迴圈取出佇列
T+30ms   Activity：初始化 session（首次）
T+50ms   Activity：儲存使用者訊息到 DB
T+100ms  Activity：呼叫 AI 判斷能力（OpenAI API）
T+150ms  Workflow：收到 capability = 'ledger_proposal'
T+200ms  Activity：呼叫 AI 解析記帳（OpenAI API）
T+250ms  Workflow：收到解析結果
T+300ms  Activity：儲存記帳到 DB
T+350ms  Activity：儲存 AI 回覆到 DB
T+400ms  Workflow：解鎖 Update Handler，回傳結果
T+450ms  後端：收到 Workflow 回傳，快取結果
T+500ms  後端：發送 WebSocket 訊息給前端
T+550ms  前端：收到回覆，更新 UI
```

**總耗時**：約 550ms（其中 AI 呼叫佔 200ms）

---

## 5. Activity 重試策略

```typescript
const ACTIVITY_CONFIG = {
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    backoffCoefficient: 2
  }
} as const;

const activities = proxyActivities<ChatActivities>(ACTIVITY_CONFIG);
```

**重試時間線**：

- 第1次失敗 → 等待 1s  → 第2次嘗試
- 第2次失敗 → 等待 2s  → 第3次嘗試
- 第3次失敗 → 等待 4s  → 第4次嘗試
- 第4次失敗 → 等待 8s  → 第5次嘗試
- 第5次失敗 → 拋出錯誤到 Workflow

**哪些錯誤會重試？**

- ✅ 網路超時
- ✅ OpenAI API rate limit
- ✅ 資料庫暫時不可用
- ❌ 業務錯誤（如「Not a ledger」）→ 不重試

**如何讓業務錯誤不重試？**

```typescript
// Activity 中拋出 ApplicationFailure
import { ApplicationFailure } from '@temporalio/common';

export async function parseLedgerProposal(params) {
  // ...
  if (!parsed || (parsed.kind !== 'add' && parsed.kind !== 'sub')) {
    throw ApplicationFailure.nonRetryable('Not a ledger proposal');
  }
  // ...
}
```

## 結語

Temporal 和 AI Agents 的結合，代表了一種新的應用程式開發典範：

> **用程式碼表達業務邏輯，用 AI 增強智慧，用 Workflow 保證可靠性**

這不僅僅是技術上的創新，更是思維方式的轉變：

- 從「如何實作」到「做什麼」
- 從「手動處理錯誤」到「聲明式可靠性」
- 從「分散的服務」到「集中的流程」

希望這三篇文章能幫助你理解這個強大的架構模式，並在自己的專案中應用。
