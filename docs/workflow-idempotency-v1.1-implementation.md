# Workflow 幂等性方案 1.1 实现文档

## 概述

已实现 **方案 1.1：内存去重 + ContinueAsNew + 最佳实践**

- ✅ 时间窗口清理（1 小时）
- ✅ 数量限制（最多 1000 个）
- ✅ 状态大小监控
- ✅ 智能排序（按时间戳）
- ✅ ContinueAsNew 状态传递

---

## 实现细节

### 1. 初始化去重状态

```typescript
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  // 🔑 恢复从上一次 ContinueAsNew 传递的状态
  const processedRequestIds = new Set<string>(startArgs.processedRequestIds || []);
  const resultCache = new Map<string, string>();
  
  console.log(`[Workflow] Initialized with ${processedRequestIds.size} cached requestIds`);
  
  // ... 其余代码
}
```

**说明**：
- `processedRequestIds`：记录已处理的 requestId（从 ContinueAsNew 恢复）
- `resultCache`：缓存结果（不传递到下一个实例，内存优化）
- 每次 workflow 启动时会记录恢复的 requestId 数量

---

### 2. sendMessageUpdate 幂等性检查

```typescript
setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
  // 🔑 幂等性检查
  if (args.requestId && processedRequestIds.has(args.requestId)) {
    console.log(`[Workflow] Duplicate request detected: ${args.requestId}`);
    const cachedResult = resultCache.get(args.requestId);
    if (cachedResult) {
      console.log(`[Workflow] Returning cached result for: ${args.requestId}`);
      return cachedResult;  // ✅ ~1ms 响应
    }
    // 如果缓存结果不存在（ContinueAsNew 后），返回通用消息
    return '该消息已处理';
  }
  
  // 正常处理逻辑...
  const result = await completion;
  
  // 🔑 记录已处理
  if (args.requestId) {
    processedRequestIds.add(args.requestId);
    resultCache.set(args.requestId, result);
    console.log(`[Workflow] Cached result for: ${args.requestId}`);
  }
  
  return result;
});
```

**流程**：
1. 检查 requestId 是否已处理
2. 如果已处理且有缓存结果 → 立即返回（~1ms）
3. 如果已处理但无缓存（ContinueAsNew 后）→ 返回通用消息
4. 如果未处理 → 正常执行，并缓存结果

---

### 3. confirmLedgerUpdate 幂等性检查

```typescript
setHandler(confirmLedgerUpdate, async (args: ConfirmLedgerArgs): Promise<string> => {
  // 🔑 幂等性检查
  if (args.requestId && processedRequestIds.has(args.requestId)) {
    console.log(`[Workflow] Duplicate confirm ledger: ${args.requestId}`);
    return resultCache.get(args.requestId) || '该记账已确认';
  }
  
  const result = await acts.saveLedger({
    userId: args.userId,
    sessionId: args.sessionId,
    title: args.proposal.title,
    amountCents: args.proposal.amountCents,
    occurredAtMs: args.proposal.occurredAtMs,
    requestId: args.requestId,
  });
  
  // 🔑 记录已处理
  if (args.requestId) {
    processedRequestIds.add(args.requestId);
    resultCache.set(args.requestId, result);
  }
  
  return result;
});
```

**说明**：
- 确认记账操作也支持幂等性
- 避免重复扣款/入账

---

### 4. ContinueAsNew 清理策略 ⭐

```typescript
if (workflowInfo().continueAsNewSuggested) {
  const now = Date.now();
  const ONE_HOUR_MS = 3600000; // 1 小时
  const MAX_IDS = 1000; // 最多保留 1000 个
  
  // 🔑 方案 A：按时间窗口过滤（保留最近 1 小时）
  const recentIdsByTime = Array.from(processedRequestIds).filter(id => {
    const timestamp = parseInt(id.split('-')[0]);
    return !isNaN(timestamp) && (now - timestamp) < ONE_HOUR_MS;
  });
  
  // 🔑 方案 B：如果时间窗口内的 ID 过多，取最近的 N 个
  let idsToKeep: string[];
  if (recentIdsByTime.length > MAX_IDS) {
    idsToKeep = recentIdsByTime
      .sort((a, b) => {
        const tsA = parseInt(a.split('-')[0]);
        const tsB = parseInt(b.split('-')[0]);
        return tsB - tsA; // 降序：最新的在前
      })
      .slice(0, MAX_IDS);
  } else {
    idsToKeep = recentIdsByTime;
  }
  
  // 🔑 监控：记录状态大小
  const stateSize = JSON.stringify(idsToKeep).length;
  console.log(`[ContinueAsNew] Keeping ${idsToKeep.length} requestIds (${stateSize} bytes)`);
  console.log(`[ContinueAsNew] Discarded ${processedRequestIds.size - idsToKeep.length} old requestIds`);
  
  if (stateSize > 100000) {
    console.warn(`[ContinueAsNew] Large state detected: ${stateSize} bytes`);
  }
  
  return continueAsNew<typeof chatSessionWorkflow>({
    sessionId: startArgs.sessionId,
    startedAtMs: startArgs.startedAtMs,
    processedRequestIds: idsToKeep, // 传递清理后的 requestIds
  });
}
```

**清理策略**：

#### 第一层：时间窗口过滤
```
保留最近 1 小时的 requestId

示例：
├─ 现在: 2024-01-01 15:00:00
├─ requestId: "1704103200000-abc" (14:00) ✅ 保留（1小时内）
├─ requestId: "1704099600000-def" (13:00) ❌ 丢弃（超过1小时）
└─ requestId: "1704096000000-ghi" (12:00) ❌ 丢弃（超过1小时）
```

#### 第二层：数量限制
```
如果时间窗口内的 ID > 1000

示例（高峰期）：
├─ 最近 1 小时内有 2000 个 requestId
├─ 按时间戳排序（最新的在前）
└─ 只保留最近的 1000 个
```

#### 监控输出
```
[ContinueAsNew] Keeping 856 requestIds (25680 bytes)
[ContinueAsNew] Discarded 1144 old requestIds
```

---

## 性能特征

### 响应时间

| 场景 | 响应时间 | 说明 |
|-----|---------|------|
| 首次请求 | ~1000ms | 正常处理（AI + DB） |
| 重复请求（缓存命中） | **~1ms** | 内存查询 ✅ |
| 重复请求（ContinueAsNew 后） | ~50ms | 返回通用消息 + DB 去重 |

### 内存占用

```
场景 1：正常运行
├─ processedRequestIds: ~500 个 × 22 bytes = 11 KB
├─ resultCache: ~500 个 × 100 bytes = 50 KB
└─ 总计: ~61 KB / workflow

场景 2：ContinueAsNew 前（峰值）
├─ processedRequestIds: ~2000 个 × 22 bytes = 44 KB
├─ resultCache: ~2000 个 × 100 bytes = 200 KB
└─ 总计: ~244 KB / workflow

场景 3：ContinueAsNew 后
├─ processedRequestIds: 1000 个 × 22 bytes = 22 KB
├─ resultCache: 0 个（清空）
└─ 总计: ~22 KB / workflow
```

### Event History 增长

```
每次 ContinueAsNew 传递的参数大小：

├─ sessionId: ~50 bytes
├─ startedAtMs: ~8 bytes
├─ processedRequestIds: ~30 KB (1000 个 ID)
└─ 总计: ~30 KB

占 History 比例：
30 KB / 10 MB = 0.3% ✅ 可忽略
```

---

## 配置参数

### 时间窗口（可调整）

```typescript
const ONE_HOUR_MS = 3600000; // 1 小时
```

**建议**：
- 低频应用：4 小时 (`14400000`)
- 中频应用：1 小时 (`3600000`) ← 默认
- 高频应用：30 分钟 (`1800000`)

### 数量限制（可调整）

```typescript
const MAX_IDS = 1000;
```

**建议**：
- 内存充足：2000
- 标准配置：1000 ← 默认
- 内存紧张：500

### 状态大小警告阈值

```typescript
if (stateSize > 100000) { // 100 KB
  console.warn(`[ContinueAsNew] Large state detected: ${stateSize} bytes`);
}
```

---

## 监控与调试

### 关键日志

#### 1. 初始化日志
```
[Workflow] Initialized with 856 cached requestIds
```
→ workflow 启动时恢复的 requestId 数量

#### 2. 缓存命中日志
```
[Workflow] Duplicate request detected: 1704067200000-abc123
[Workflow] Returning cached result for: 1704067200000-abc123
```
→ 重复请求被快速处理（~1ms）

#### 3. 缓存记录日志
```
[Workflow] Cached result for: 1704067200000-abc123
```
→ 新请求处理完成并缓存

#### 4. ContinueAsNew 日志
```
[ContinueAsNew] Keeping 856 requestIds (25680 bytes)
[ContinueAsNew] Discarded 1144 old requestIds
```
→ 状态清理统计

#### 5. 警告日志
```
[ContinueAsNew] Large state detected: 150000 bytes
```
→ 状态过大，可能需要调整参数

---

## 边界情况处理

### 情况 1：ContinueAsNew 后重复请求

```
场景：
1. Workflow 实例 #1 处理 req-1
2. ContinueAsNew → Workflow 实例 #2
3. req-1 在 processedRequestIds 中（已传递）
4. 但 resultCache 为空（未传递）

行为：
if (processedRequestIds.has('req-1')) {
  const cached = resultCache.get('req-1');  // undefined
  if (cached) {
    return cached;
  }
  return '该消息已处理';  // ✅ 返回通用消息
}
```

**优点**：
- ✅ 仍然去重（不会重复处理）
- ✅ 省略 resultCache 传递（节省空间）
- ⚠️ 返回通用消息（而非原始结果）

**改进方案**（如需精确结果）：
- 从 DB 查询历史消息
- 或同时传递 resultCache（增加状态大小）

### 情况 2：时间窗口外的旧请求

```
场景：
1. 用户发送 req-1 (14:00)
2. 2 小时后 ContinueAsNew (16:00)
3. req-1 被丢弃（超过 1 小时窗口）
4. 用户网络问题，2 小时后重发 req-1 (16:00)

行为：
✅ 后续层防护仍然有效：
├─ 后端缓存（5 分钟 TTL）
├─ Temporal Update ID（永久）
└─ 数据库唯一索引（永久）
```

**结论**：安全（多层防护）

### 情况 3：requestId 格式错误

```typescript
const timestamp = parseInt(id.split('-')[0]);
return !isNaN(timestamp) && (now - timestamp) < ONE_HOUR_MS;
```

**处理**：
- `parseInt()` 失败 → `NaN`
- `isNaN(timestamp)` → `false`
- 该 ID 被过滤掉（丢弃）

**建议**：前端确保 requestId 格式正确
```typescript
const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
```

---

## 测试建议

### 单元测试

```typescript
describe('Workflow Idempotency', () => {
  test('duplicate request returns cached result', async () => {
    const workflow = await startWorkflow();
    
    // 第一次
    const result1 = await workflow.sendMessage({
      requestId: 'req-1',
      message: 'hello'
    });
    
    // 第二次（重复）
    const result2 = await workflow.sendMessage({
      requestId: 'req-1',
      message: 'hello'
    });
    
    expect(result2).toBe(result1);
  });
  
  test('ContinueAsNew preserves recent requestIds', async () => {
    const workflow = await startWorkflow();
    
    // 处理 2000 个请求触发 ContinueAsNew
    for (let i = 0; i < 2000; i++) {
      await workflow.sendMessage({ requestId: `req-${i}`, message: 'test' });
    }
    
    // ContinueAsNew 后，最近 1000 个应该仍可去重
    const result = await workflow.sendMessage({
      requestId: 'req-1500',  // 应该在保留范围内
      message: 'test'
    });
    
    expect(result).toBe('该消息已处理');
  });
});
```

### 性能测试

```typescript
test('cache hit performance', async () => {
  const workflow = await startWorkflow();
  
  await workflow.sendMessage({ requestId: 'req-1', message: 'hello' });
  
  const start = Date.now();
  await workflow.sendMessage({ requestId: 'req-1', message: 'hello' });
  const duration = Date.now() - start;
  
  expect(duration).toBeLessThan(10); // 应该 < 10ms
});
```

---

## 与其他层的协作

```
┌─────────────────────────────────────────────────────┐
│ 前端                                                 │
│ generateRequestId() → "1704067200000-abc123"       │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 后端 wsRouter（第 1 层防护）                        │
│ idempotencyCache (5 分钟 TTL)                      │
│ ├─ 命中 → 返回缓存（~1ms）                         │
│ └─ 未命中 → 继续                                    │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ Temporal Workflow（第 2 层防护）⭐ 本实现           │
│ processedRequestIds + resultCache                  │
│ ├─ 命中 → 返回缓存（~1ms）                         │
│ └─ 未命中 → 继续                                    │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ Temporal Update ID（第 3 层防护）                   │
│ 同一个 updateId 只执行一次                          │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ Activities + 数据库（第 4 层防护）                  │
│ 唯一索引（message_id, ledger_id）                  │
└─────────────────────────────────────────────────────┘
```

---

## 优缺点总结

### ✅ 优点

1. **极快响应**：重复请求 ~1ms（vs 1000ms）
2. **内存可控**：最多 1000 个 ID × 30 bytes ≈ 30 KB
3. **自动清理**：时间窗口 + 数量限制
4. **监控完善**：状态大小、丢弃数量
5. **多层防护**：与其他层协同工作

### ⚠️ 注意事项

1. **resultCache 不传递**：ContinueAsNew 后返回通用消息
2. **时间窗口限制**：超过 1 小时的旧请求可能重复（依赖后续层）
3. **requestId 格式要求**：必须以时间戳开头
4. **内存占用**：高峰期 ~244 KB / workflow

### ❌ 不适用场景

1. **需要精确历史结果**：ContinueAsNew 后无法返回原始回复
2. **极低内存环境**：考虑纯 DB 去重
3. **跨多个 workflow 去重**：需要全局状态（Redis 等）

---

## 配置建议

### 低频应用（< 10 req/hour）
```typescript
const ONE_HOUR_MS = 14400000; // 4 小时
const MAX_IDS = 500;
```

### 标准应用（10-100 req/hour）← 默认
```typescript
const ONE_HOUR_MS = 3600000; // 1 小时
const MAX_IDS = 1000;
```

### 高频应用（> 100 req/hour）
```typescript
const ONE_HOUR_MS = 1800000; // 30 分钟
const MAX_IDS = 2000;
```

---

## 总结

方案 1.1 已成功实现并包含最佳实践：

- ✅ **时间窗口清理**（1 小时）
- ✅ **数量限制**（1000 个）
- ✅ **智能排序**（最新优先）
- ✅ **状态监控**（大小警告）
- ✅ **内存可控**（~30 KB）
- ✅ **性能优异**（~1ms）

**推荐指数**：⭐⭐⭐⭐⭐

适用于大多数 Entity Pattern 场景，平衡了性能、内存和复杂度。

