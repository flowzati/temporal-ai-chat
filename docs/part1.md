# AI 對話平台 - Temporal 與 AI Agents 協作 (上)

## 前言

在 AI 應用開發的浪潮中，我們常常聽到兩個核心概念：**Workflow（工作流）** 和 **AI Agent（智慧代理）**。它們分別代表了應用開發中的兩種不同思維模式，但當它們結合在一起時，卻能創造出遠超單獨使用的強大能力。本文將深入探討這兩個概念的本質、優劣，以及為什麼 Temporal 能成為連接它們的完美橋樑。

## 一、理解 Workflow：可靠協調的藝術

### 什麼是 Workflow？

Workflow（工作流）是一種將複雜業務流程分解為多個步驟、並確保這些步驟按預期順序執行的編程模式。在傳統軟體開發中，我們常用狀態機、消息隊列、或手寫協調邏輯來實現類似功能。

但 Workflow 不僅僅是「按順序執行代碼」這麼簡單。一個真正的 Workflow 系統需要解決以下問題：

1. **持久性（Durability）**：即使程序崩潰或機器重啟，執行狀態也不會丟失
2. **可靠性（Reliability）**：自動重試失敗的步驟，直到成功
3. **可觀察性（Observability）**：清楚知道每個步驟的執行狀態和歷史
4. **確定性（Determinism）**：重放（Replay）時能產生相同的結果

### Workflow 的優勢

#### 1. **天生的可靠性**
```typescript
// 傳統方式：需要手動處理各種異常
async function processOrder(orderId: string) {
  let step = loadCheckpoint(orderId); // 手動持久化
  try {
    if (step < 1) {
      await chargePayment(orderId);
      saveCheckpoint(orderId, 1); // 手動保存進度
    }
    if (step < 2) {
      await sendConfirmEmail(orderId);
      saveCheckpoint(orderId, 2);
    }
    if (step < 3) {
      await updateInventory(orderId);
      saveCheckpoint(orderId, 3);
    }
  } catch (error) {
    // 需要自己處理重試邏輯
    scheduleRetry(orderId, step);
  }
}

// Workflow 方式：框架自動處理
async function processOrderWorkflow(orderId: string) {
  await activities.chargePayment(orderId);    // 自動重試、持久化
  await activities.sendConfirmEmail(orderId); // 崩潰也不怕
  await activities.updateInventory(orderId);  // 狀態自動保存
}
```

#### 2. **強大的協調能力**
Workflow 擅長協調多個異步操作：
- **串行執行**：等待前一步完成再執行下一步
- **並行執行**：同時執行多個獨立任務
- **條件分支**：根據結果決定執行路徑
- **等待外部事件**：可以暫停等待用戶輸入、審批流程等

#### 3. **時間旅行能力**
通過事件溯源（Event Sourcing）機制，Workflow 可以：
- 重放任何時間點的執行狀態
- 調試複雜的異步問題
- 審計完整的執行歷史

### Workflow 的局限性

#### 1. **確定性約束**
為了保證可重放性，Workflow 代碼必須是確定性的：
```typescript
// ❌ 不能在 Workflow 中做這些
async function myWorkflow() {
  const now = Date.now();          // 每次重放會不同
  const random = Math.random();    // 不確定性
  await fetch('https://api.com');  // 外部 I/O
  await db.query('SELECT ...');    // 資料庫操作
}

// ✅ 必須委派給 Activity
async function myWorkflow() {
  const now = await activities.getCurrentTime();
  const random = await activities.getRandomNumber();
  const data = await activities.fetchAPI();
  const result = await activities.queryDB();
}
```

#### 2. **不適合處理動態決策**
Workflow 的邏輯在編寫時就固定了，難以處理需要「理解語義」的場景：
- 自然語言理解
- 圖像識別
- 複雜推理
- 個性化回應

#### 3. **學習曲線**
開發者需要理解新的編程模型：
- Event Sourcing 概念
- 確定性 vs 非確定性
- Activity vs Workflow 的邊界
- 重放機制的原理

---

## 二、理解 AI Agent：智能決策的力量

### 什麼是 AI Agent？

AI Agent（智慧代理）是一種能夠感知環境、做出決策、並採取行動的智能系統。在 OpenAI 的 Agents 框架中，一個 Agent 通常由以下部分組成：

1. **Instructions（指令）**：定義 Agent 的角色和目標
2. **Tools（工具）**：Agent 可以呼叫的外部能力（如搜索、計算）
3. **Context（上下文）**：對話歷史、知識庫等
4. **LLM（大語言模型）**：理解和生成的核心

### AI Agent 的優勢

#### 1. **語義理解能力**
```typescript
// 傳統方式：硬編碼規則
function decideCategory(message: string) {
  if (message.includes('天氣') || message.includes('氣溫')) {
    return 'weather';
  }
  if (message.includes('記帳') || message.includes('花費')) {
    return 'ledger';
  }
  return 'chat';
}

// AI Agent 方式：理解語義
const agent = new Agent({
  instructions: `判斷用戶意圖：
    - 天氣相關 → weather
    - 財務相關 → ledger
    - 其他 → chat`
});
const intent = await run(agent, userMessage);
// 能理解：「今天會冷嗎？」→ weather
// 能理解：「昨天買了什麼」→ ledger
```

#### 2. **動態適應能力**
AI Agent 可以根據上下文調整行為：
- 記住對話歷史
- 學習用戶偏好
- 處理模糊輸入
- 提供個性化回應

#### 3. **工具使用能力**
現代 AI Agent（如 OpenAI Agents）支持 Function Calling：
```typescript
const agent = new Agent({
  name: 'Weather Assistant',
  tools: [
    {
      name: 'get_weather',
      description: '獲取指定城市的天氣',
      parameters: { city: 'string' }
    }
  ]
});
// Agent 會自動判斷何時需要呼叫工具
```

### AI Agent 的局限性

#### 1. **不可靠性**
```typescript
// AI 呼叫可能失敗
try {
  const reply = await agent.run(userMessage);
} catch (error) {
  // Rate limit、網路錯誤、模型過載...
  // 需要手動處理重試邏輯
}
```

#### 2. **無狀態管理**
AI Agent 本身不負責：
- 持久化對話歷史
- 管理長時間運行的任務
- 處理並發請求
- 保證冪等性

#### 3. **不確定性**
```typescript
// 同樣的輸入，可能產生不同的輸出
const result1 = await agent.run('記帳100元');
// → "已記錄支出 100 元"

const result2 = await agent.run('記帳100元');
// → "好的，已記錄 100 元的支出"
// 內容相同但文字不同 → 難以做精確的業務判斷
```

#### 4. **成本與延遲**
- 每次 LLM 呼叫都有成本（按 token 計費）
- 響應時間不可控（幾百毫秒到幾秒）
- 無法做到「瞬間」決策

---

## 三、為什麼需要結合？互補的完美組合

### 各自的角色定位

| 維度 | Workflow | AI Agent |
|------|----------|----------|
| **核心能力** | 可靠的協調與執行 | 智慧的理解與決策 |
| **適合場景** | 固定流程、狀態管理 | 語義理解、動態推理 |
| **確定性** | 高（可重放） | 低（每次可能不同） |
| **可靠性** | 高（自動重試） | 低（需要手動處理） |
| **靈活性** | 低（需要編碼） | 高（自然語言即可） |

### 結合模式：指揮官與顧問

想像一個軍事指揮系統：
- **Workflow = 指揮官**：負責整體戰略、調度資源、確保執行
- **AI Agent = 參謀/顧問**：提供情報分析、建議決策方案

```typescript
// Workflow 是協調者
async function chatSessionWorkflow() {
  // 1. Workflow 接收用戶消息
  const userMessage = await waitForMessage();
  
  // 2. 委派 AI Agent 分析意圖
  const intent = await activities.analyzeIntent(userMessage);
  
  // 3. Workflow 根據意圖決定流程
  switch (intent) {
    case 'weather':
      // 4. 再次委派 AI Agent 處理天氣查詢
      const weather = await activities.getWeatherInfo(userMessage);
      await activities.saveMessage(weather);
      break;
      
    case 'ledger':
      // 5. 複雜的記帳流程（AI + 確定性邏輯）
      const proposal = await activities.parseLedgerProposal(userMessage);
      // Workflow 負責確保記帳的原子性和可靠性
      await activities.saveLedger(proposal);
      await activities.sendConfirmation();
      break;
  }
}
```

### 實際案例：記帳功能

假設用戶說：「昨天中午買了午餐花了 120 元」

#### 純 AI Agent 方案的問題
```typescript
async function handleLedger(message: string) {
  // 1. AI 解析
  const parsed = await agent.parse(message);
  // parsed = { date: '昨天', item: '午餐', amount: 120 }
  
  // 2. 保存到資料庫
  await db.insert(parsed); // ❌ 如果這裡崩潰怎麼辦？
  
  // 3. 發送確認
  await sendNotification(parsed); // ❌ 重試時會重複記帳
}
```

**問題**：
- AI 解析成功，但資料庫崩潰 → 用戶需要重新輸入
- 網路抖動導致重試 → 可能重複記帳
- 無法追蹤執行狀態 → 調試困難

#### Workflow + AI Agent 方案
```typescript
async function ledgerWorkflow(message: string) {
  // 1. 持久化用戶原始消息
  await activities.saveUserMessage(message);
  
  // 2. AI 解析（Activity 自動重試）
  const parsed = await activities.parseLedgerProposal(message);
  // 如果 AI 失敗，自動重試；成功後狀態自動保存
  
  // 3. 保存記帳（Activity 確保冪等性）
  await activities.saveLedger(parsed);
  // 即使崩潰，重啟後會從這裡繼續
  
  // 4. 發送確認
  await activities.sendConfirmation(parsed);
  // 所有步驟都有完整的執行記錄
}
```

**優勢**：
- ✅ 每一步都自動持久化
- ✅ 失敗自動重試（避免重複呼叫 AI）
- ✅ 冪等性保證（不會重複記帳）
- ✅ 完整的執行歷史可追溯

---

## 四、為什麼是 Temporal？獨特的價值主張

### 1. 業務邏輯即代碼

**傳統架構的痛點**：
```typescript
// 需要多個服務協作
await messageQueue.publish('parse-ledger', { userId, message });
// 等待回調...
messageQueue.subscribe('ledger-parsed', async (data) => {
  await db.saveLedger(data);
  // 再等待回調...
  messageQueue.publish('send-confirmation', { userId });
});
// 業務邏輯分散在多個地方，難以理解和維護
```

**Temporal 的方式**：
```typescript
// 業務邏輯清晰可見
async function ledgerWorkflow(userId: string, message: string) {
  const parsed = await activities.parseLedger(message);
  await activities.saveLedger(parsed);
  await activities.sendConfirmation(userId);
}
// 像寫普通代碼一樣，但擁有分佈式系統的所有保證
```

### 2. 內置的可靠性機制

#### 自動重試
```typescript
// 配置 Activity 重試策略
const activities = proxyActivities<ChatActivities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,        // 最多重試 5 次
    backoffCoefficient: 2,     // 指數退避
    initialInterval: '1s',     // 初始間隔 1 秒
  }
});

// AI 呼叫失敗？自動重試
const intent = await activities.analyzeIntent(userMessage);
// 不需要手動 try-catch，框架會處理
```

#### 自動持久化
```typescript
async function chatWorkflow() {
  await activities.saveUserMessage(msg);  // 執行完畢，狀態自動保存
  // ⚡️ 即使這裡程序崩潰...
  const reply = await activities.getAIReply(msg);
  // ✅ 重啟後會從這裡繼續，不會重複執行上一步
  await activities.saveAssistantMessage(reply);
}
```

### 3. 強大的並發控制

#### 串行消息處理
```typescript
async function chatSessionWorkflow() {
  const messageQueue: QueueItem[] = [];
  
  // 設置 Update Handler（類似 HTTP endpoint）
  setHandler(sendMessageUpdate, async (params) => {
    const completion = new Trigger<string>();
    messageQueue.push({ message: params.text, completion });
    return await completion; // 等待處理完成
  });
  
  // 主循環：串行處理消息
  while (true) {
    await condition(() => messageQueue.length > 0);
    const item = messageQueue.shift()!;
    
    // AI 處理可能需要幾秒，但不會阻塞新消息進隊列
    const reply = await activities.getAIReply(item.message);
    item.completion.resolve(reply);
  }
}
```

**優勢**：
- ✅ 同一 session 的消息嚴格按順序處理
- ✅ 不會因為並發導致消息亂序
- ✅ 新消息可以繼續進隊列（不會丟失）

### 4. 長時間運行的 Workflow

AI 對話系統可能需要：
- 一個 session 持續數小時甚至數天
- 處理成百上千條消息
- 維護完整的對話上下文

```typescript
// Temporal 支持無限期運行的 Workflow
async function chatSessionWorkflow(sessionId: string) {
  // 這個 Workflow 可以運行幾天、幾個月
  while (true) {
    const message = await waitForMessage(); // 可以等待任意長時間
    await processMessage(message);
    
    // 當歷史事件過多時，自動 ContinueAsNew
    if (workflowInfo().continueAsNewSuggested) {
      continueAsNew<typeof chatSessionWorkflow>({ sessionId });
    }
  }
}
```

### 5. 冪等性保證

AI 應用中的冪等性挑戰：
- 用戶重複點擊「發送」
- 網路抖動導致重試
- 前端/後端不同步

```typescript
// Temporal 的 Update 機制天生支持冪等性
setHandler(sendMessageUpdate, async (params: SendMessageParams) => {
  // 使用 requestId 檢查是否已處理
  const cached = idempotency.getCached(params.requestId);
  if (cached) return cached; // 直接返回之前的結果
  
  // 處理新請求
  const reply = await activities.getAIReply(params.text);
  idempotency.putCached(params.requestId, reply);
  return reply;
});

// 呼叫方指定 updateId 實現精確一次語義
await handle.executeUpdate('sendMessage', {
  args: [{ text: 'Hello', requestId: 'req-123' }],
  updateId: 'req-123', // Temporal 確保同一個 updateId 只執行一次
});
```

### 6. 可觀察性與調試

```typescript
// Temporal Web UI 可以看到：
// - 每個 Workflow 的執行歷史
// - 每個 Activity 的輸入輸出
// - 重試次數和失敗原因
// - 完整的事件時間線

// 可以在生產環境重放任意 Workflow
// 排查「為什麼用戶的消息沒回覆？」
// 排查「為什麼記帳失敗了？」
```

---

## 五、對比：不同架構方案

### 方案 A：純 AI Agent
```typescript
// 簡單但不可靠
app.post('/chat', async (req, res) => {
  const reply = await agent.run(req.body.message);
  res.json({ reply });
});
```
**問題**：無狀態、無重試、無歷史、難擴展

### 方案 B：傳統消息隊列 + AI Agent
```typescript
// 複雜但仍然脆弱
await queue.publish('chat-request', { userId, message });

queue.subscribe('chat-request', async (data) => {
  const reply = await agent.run(data.message);
  await queue.publish('chat-reply', { reply });
});
```
**問題**：
- 狀態分散（DB、Redis、隊列）
- 需要手動處理故障恢復
- 難以調試（消息鏈路追蹤困難）
- 冪等性需要自己實現

### 方案 C：Temporal + AI Agent（本項目）
```typescript
// 簡單且可靠
async function chatWorkflow(message: string) {
  const intent = await activities.analyzeIntent(message);
  const reply = await activities.generateReply(intent, message);
  await activities.saveMessage(reply);
  return reply;
}

// 呼叫方
const handle = await client.workflow.start(chatWorkflow, {
  args: [userMessage],
  taskQueue: 'chat-ai',
  workflowId: `chat-${sessionId}`,
});
const reply = await handle.result();
```
**優勢**：
- ✅ 業務邏輯清晰（像寫同步代碼）
- ✅ 自動持久化和重試
- ✅ 完整的執行歷史
- ✅ 內置冪等性支持

---

## 六、總結

### Workflow 和 AI Agent 是互補關係

- **Workflow** 提供：可靠的協調、狀態管理、錯誤處理
- **AI Agent** 提供：智能決策、語義理解、動態適應

它們的結合形成了一個強大的模式：
> **用 Workflow 組織流程，用 AI Agent 增強智能**

### Temporal 的獨特價值

1. **降低複雜度**：將分佈式系統的複雜性隱藏在框架中
2. **提升可靠性**：自動處理重試、持久化、恢復
3. **改善可維護性**：業務邏輯集中在 Workflow 代碼中
4. **增強可觀察性**：完整的執行歷史和調試能力

### 適用場景

這種架構特別適合：
- **AI 對話系統**：需要管理長時間會話
- **多步驟 AI 流程**：如文檔處理（OCR → 分類 → 抽取 → 審核）
- **需要人機協作**：AI 提供建議，人工審批
- **高可靠性要求**：金融、醫療等領域的 AI 應用

---

**下一篇預告**：我們將鳥瞰本專案的具體架構，看看 Temporal 和 AI Agents 如何在一個真實的對話平台中協同工作，以及有哪些設計亮點值得深入學習。

