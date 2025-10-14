# 幂等性实现文档

## 概述

本系统实现了端到端的幂等性保证，确保重复请求不会导致副作用（如重复插入数据库记录）。幂等性在以下三个层面实现：

1. **前端**：生成并发送唯一的 `requestId`
2. **后端**：内存缓存 + Temporal Update ID
3. **数据库**：唯一索引 + 幂等性检查

---

## 架构设计

```
┌─────────────┐         ┌─────────────┐         ┌──────────────┐
│   Frontend  │ ──1──▶ │   Backend   │ ──2──▶ │   Temporal   │
│             │         │  (wsRouter) │         │   Workflow   │
└─────────────┘         └─────────────┘         └──────────────┘
   requestId              requestId                  Update ID
                        idempotency                      │
                           cache                         │ 3
                                                         ▼
                                                    ┌──────────┐
                                                    │Activities│
                                                    └─────┬────┘
                                                          │ 4
                                                          ▼
                                                    ┌──────────┐
                                                    │ Database │
                                                    │ (unique  │
                                                    │  index)  │
                                                    └──────────┘
```

---

## 1. 前端层（Request ID 生成）

### 实现位置
- `frontend/src/hooks/useChat.ts`
- `frontend/src/hooks/useLedger.ts`
- `frontend/src/utils/websocket.ts`

### 实现方式
```typescript
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

// 发送消息时附加 requestId
sendWebSocketMessage(ws, {
  type: 'user_message',
  sessionId,
  userId,
  message: input.trim(),
  requestId: generateRequestId(), // 🔑 幂等性关键
});
```

### 支持的操作
- `user_message` - 用户消息
- `confirm_ledger` - 确认记账
- `cancel` - 取消操作

---

## 2. 后端层（内存缓存 + Temporal）

### 实现位置
- `backend/src/services/wsRouter.ts`

### 2.1 内存缓存（快速去重）

```typescript
// 全局幂等性缓存
const idempotencyCache = new Map<string, { result: string; timestamp: number }>();
const IDEMPOTENCY_CACHE_TTL = 5 * 60 * 1000; // 5分钟过期

// 检查幂等性
function checkIdempotency(requestId?: string): string | null {
  if (!requestId) return null;
  const cached = idempotencyCache.get(requestId);
  if (cached) {
    console.log(`[Idempotency] Cache hit: ${requestId}`);
    return cached.result;
  }
  return null;
}

// 缓存结果
function cacheIdempotencyResult(requestId: string | undefined, result: string): void {
  if (!requestId) return;
  idempotencyCache.set(requestId, {
    result,
    timestamp: Date.now(),
  });
}
```

**优点**：
- ✅ 快速响应（内存查询，无需调用 Temporal）
- ✅ 减轻 Temporal 负载
- ✅ 自动过期清理（5分钟 TTL）

### 2.2 Temporal Update ID（分布式幂等性）

```typescript
const reply = await executeWorkflowOperation(sessionId, (handle) =>
  handle.executeUpdate('sendMessage', {
    args: [{ ...userMessage, startedAtMs: now, requestId: data.requestId }],
    updateId: data.requestId, // 🔑 Temporal 内置幂等性
  })
);
```

**Temporal 保证**：
- ✅ 同一个 `updateId` 的 Update 操作只会执行一次
- ✅ 重复请求会返回相同结果（不会重新执行）
- ✅ 跨 Worker 实例生效（分布式环境）

---

## 3. Workflow 层（Activities 去重）

### 实现位置
- `backend/src/temporal/workflows.ts`

### 实现方式
```typescript
async function processMessage(item: QueueItem): Promise<void> {
  // 生成唯一的消息 ID
  const userMessageId = item.requestId ? `user-${item.requestId}` : undefined;
  
  // 保存用户消息（带 messageId）
  await acts.saveMessage({
    sessionId: item.sessionId,
    role: 'user',
    content: item.text,
    timestamp: item.startedAtMs,
    messageId: userMessageId, // 🔑 传递到数据库层
  });
  
  // ... AI 处理 ...
  
  // 保存 AI 回复（带 messageId）
  const assistantMessageId = item.requestId ? `assistant-${item.requestId}` : undefined;
  await acts.saveMessage({
    sessionId: item.sessionId,
    role: 'assistant',
    content: reply,
    timestamp: Date.now(),
    messageId: assistantMessageId, // 🔑 传递到数据库层
  });
}
```

### 记账幂等性
```typescript
setHandler(confirmLedgerUpdate, async (args: ConfirmLedgerArgs): Promise<string> => {
  return await acts.saveLedger({
    userId: args.userId,
    sessionId: args.sessionId,
    title: args.proposal.title,
    amountCents: args.proposal.amountCents,
    occurredAtMs: args.proposal.occurredAtMs,
    requestId: args.requestId, // 🔑 传递到 Activity
  });
});
```

---

## 4. 数据库层（唯一索引 + 检查）

### 实现位置
- `backend/src/utils/db.ts`
- `backend/src/temporal/activities.ts`

### 4.1 数据库 Schema

```sql
-- messages 表
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  message_id TEXT,  -- 🔑 幂等性字段
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- 唯一索引（WHERE message_id IS NOT NULL 避免 NULL 值冲突）
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id 
  ON messages(message_id) WHERE message_id IS NOT NULL;

-- ledger_entries 表
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  ledger_id TEXT  -- 🔑 幂等性字段
);

-- 唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_ledger_id 
  ON ledger_entries(ledger_id) WHERE ledger_id IS NOT NULL;
```

### 4.2 幂等性插入

```typescript
// messages 表
export function insertMessage(
  sessionId: string, 
  role: 'user' | 'assistant' | 'system', 
  content: string, 
  createdAtMs: number,
  messageId?: string | null
): void {
  const db = getDb();
  
  // 🔑 幂等性检查
  if (messageId) {
    const existing = db.prepare('SELECT id FROM messages WHERE message_id = ?').get(messageId);
    if (existing) {
      console.log(`[insertMessage] Message already exists: ${messageId}`);
      return; // 跳过插入
    }
  }
  
  db.prepare('INSERT INTO messages (session_id, role, content, created_at_ms, message_id) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, role, content, createdAtMs, messageId ?? null);
}

// ledger_entries 表
export function insertLedgerEntry(params: {
  userId: string;
  sessionId?: string | null;
  title: string;
  amountCents: number;
  occurredAtMs: number;
  createdAtMs: number;
  ledgerId?: string | null;
}): void {
  const db = getDb();
  
  // 🔑 幂等性检查
  if (params.ledgerId) {
    const existing = db.prepare('SELECT id FROM ledger_entries WHERE ledger_id = ?').get(params.ledgerId);
    if (existing) {
      console.log(`[insertLedgerEntry] Ledger already exists: ${params.ledgerId}`);
      return; // 跳过插入
    }
  }
  
  db.prepare(
    'INSERT INTO ledger_entries (user_id, session_id, title, amount_cents, occurred_at_ms, created_at_ms, ledger_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    params.userId, 
    params.sessionId ?? null, 
    params.title, 
    params.amountCents, 
    params.occurredAtMs, 
    params.createdAtMs,
    params.ledgerId ?? null
  );
}
```

---

## 5. 幂等性流程示例

### 场景 1：用户发送消息

```
1. 前端生成 requestId: "1704067200000-abc123"
   └─▶ 发送 { type: 'user_message', requestId: "1704067200000-abc123", ... }

2. 后端 wsRouter 接收
   ├─▶ checkIdempotency("1704067200000-abc123") → null (首次请求)
   ├─▶ 调用 Temporal Update with updateId="1704067200000-abc123"
   └─▶ cacheIdempotencyResult("1704067200000-abc123", reply)

3. Temporal Workflow 处理
   ├─▶ saveMessage with messageId="user-1704067200000-abc123"
   ├─▶ AI 处理...
   └─▶ saveMessage with messageId="assistant-1704067200000-abc123"

4. Activity (Database)
   ├─▶ insertMessage 检查 message_id="user-1704067200000-abc123"
   │   └─▶ 不存在，插入成功 ✅
   └─▶ insertMessage 检查 message_id="assistant-1704067200000-abc123"
       └─▶ 不存在，插入成功 ✅
```

### 场景 2：重复请求（网络重试）

```
1. 前端重发相同 requestId: "1704067200000-abc123"
   └─▶ 发送 { type: 'user_message', requestId: "1704067200000-abc123", ... }

2. 后端 wsRouter 接收
   └─▶ checkIdempotency("1704067200000-abc123") → "cached reply" ✅
   └─▶ 直接返回缓存结果，不调用 Temporal

结果：🎉 快速响应，无副作用
```

### 场景 3：重复请求（缓存过期后）

```
1. 前端重发相同 requestId: "1704067200000-abc123" (缓存已过期)
   └─▶ 发送 { type: 'user_message', requestId: "1704067200000-abc123", ... }

2. 后端 wsRouter 接收
   ├─▶ checkIdempotency("1704067200000-abc123") → null (缓存过期)
   └─▶ 调用 Temporal Update with updateId="1704067200000-abc123"

3. Temporal 层
   └─▶ Update ID 已存在，返回之前的结果 ✅

结果：🎉 Temporal 保证幂等性（稍慢但安全）
```

### 场景 4：确认记账

```
1. 前端生成 requestId: "1704067200000-def456"
   └─▶ 发送 { type: 'confirm_ledger', requestId: "1704067200000-def456", proposal: {...} }

2. 后端处理
   └─▶ 调用 Temporal Update with updateId="1704067200000-def456"

3. Workflow
   └─▶ saveLedger with requestId="1704067200000-def456"

4. Activity
   └─▶ insertLedgerEntry with ledgerId="ledger-1704067200000-def456"

5. Database
   ├─▶ 检查 ledger_id="ledger-1704067200000-def456"
   └─▶ 不存在，插入成功 ✅

重复请求：
   └─▶ Database 检查发现已存在，跳过插入 ✅
```

---

## 6. 性能考虑

### 缓存策略
- **TTL**: 5 分钟（可配置）
- **清理**: 每分钟自动清理过期条目
- **内存占用**: 每个请求 ~100 bytes（估算）
  - 10,000 个请求 ≈ 1MB

### 数据库索引
- **唯一索引**: `WHERE message_id IS NOT NULL` 避免 NULL 冲突
- **性能**: O(log n) 查询时间

### Temporal 优势
- **Update 幂等性**: 内置支持，无额外开销
- **分布式**: 跨 Worker 实例生效
- **持久化**: Update ID 存储在 Event History

---

## 7. 测试建议

### 单元测试
```typescript
// 测试幂等性检查
test('checkIdempotency returns cached result', () => {
  const requestId = 'test-123';
  cacheIdempotencyResult(requestId, 'cached');
  expect(checkIdempotency(requestId)).toBe('cached');
});

// 测试数据库幂等性
test('insertMessage is idempotent', () => {
  const messageId = 'msg-123';
  insertMessage('session-1', 'user', 'hello', Date.now(), messageId);
  insertMessage('session-1', 'user', 'hello', Date.now(), messageId); // 重复
  
  const messages = getMessages('session-1');
  expect(messages.length).toBe(1); // 只有一条
});
```

### 集成测试
```typescript
// 测试端到端幂等性
test('duplicate user message is handled correctly', async () => {
  const requestId = 'req-123';
  
  // 第一次请求
  const result1 = await sendMessage({ requestId, message: 'hello' });
  
  // 第二次请求（相同 requestId）
  const result2 = await sendMessage({ requestId, message: 'hello' });
  
  expect(result1).toEqual(result2); // 结果相同
  
  const dbMessages = await getMessagesFromDB(sessionId);
  expect(dbMessages.length).toBe(2); // user + assistant（各一条）
});
```

---

## 8. 监控与日志

### 关键日志点
```typescript
console.log(`[Idempotency] Cache hit: ${requestId}`);
console.log(`[insertMessage] Message already exists: ${messageId}`);
console.log(`[insertLedgerEntry] Ledger already exists: ${ledgerId}`);
console.log(`[executeWorkflowOperation] Workflow not found, creating: ${workflowId}`);
```

### 监控指标
- **缓存命中率**: `cache_hits / total_requests`
- **重复请求数**: 检测频繁重试的客户端
- **数据库去重次数**: 监控 `message_id` / `ledger_id` 冲突

---

## 9. 最佳实践

### ✅ DO
- 始终在前端生成 `requestId`
- 在所有写操作中传递 `requestId`
- 定期清理过期的缓存
- 监控重复请求的频率

### ❌ DON'T
- 不要在后端生成 `requestId`（客户端控制幂等性）
- 不要忽略数据库约束冲突错误
- 不要无限期保留缓存（内存泄漏）
- 不要在无状态操作中使用幂等性（如查询）

---

## 10. 故障处理

### 场景：数据库唯一索引冲突
```typescript
try {
  db.insertMessage(...);
} catch (error) {
  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    // 预期的重复插入，正常情况（幂等性生效）
    console.log('[insertMessage] Duplicate detected (idempotency working)');
  } else {
    throw error; // 其他错误需要处理
  }
}
```

### 场景：缓存失效
- **问题**: 服务器重启导致内存缓存丢失
- **解决**: Temporal Update ID 作为后备（分布式幂等性）
- **影响**: 轻微性能下降（需调用 Temporal）

### 场景：Temporal 不可用
- **问题**: Temporal Server 宕机
- **解决**: 后端返回错误，前端重试（幂等性保证安全）
- **影响**: 服务暂时不可用

---

## 总结

本系统通过**多层防护**实现端到端幂等性：

1. **前端**: 生成唯一 `requestId`
2. **后端缓存**: 5分钟内快速去重（内存）
3. **Temporal**: Update ID 分布式幂等性（持久化）
4. **数据库**: 唯一索引 + 检查（最后防线）

**保证**：
- ✅ 重复请求不会产生副作用
- ✅ 分布式环境下安全
- ✅ 高性能（缓存优化）
- ✅ 容错性强（多层防护）

**适用范围**：
- ✅ 用户消息发送
- ✅ 记账确认
- ✅ 取消操作
- ✅ 所有写操作

---

## 参考资料

- [Temporal Update Idempotency](https://docs.temporal.io/workflows#updates)
- [SQLite Unique Constraints](https://www.sqlite.org/lang_createindex.html)
- [RFC 5789: Idempotent Methods](https://www.rfc-editor.org/rfc/rfc5789)

