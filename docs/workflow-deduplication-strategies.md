# Workflow 去重策略对比

## 当前实现：Temporal Update ID + Activities 去重

```typescript
// 当前方案：依赖 Temporal Update ID 和 Activities 层去重
setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
  const completion = new Trigger<string>();
  pendingQueue.push({ ...args, completion });
  return await completion;
});
```

**特点**：
- ✅ Update ID 由 Temporal 保证幂等性
- ✅ Activities 层通过数据库唯一索引去重
- ❌ 重复请求仍会进入队列（被处理）

---

## 方案 1：Workflow 内存去重（推荐）⭐

### 实现

```typescript
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  const pendingQueue: QueueItem[] = [];
  let currentScope: CancellationScope | null = null;
  let sessionInitialized = false;
  
  // 🔑 去重：维护已处理的 requestId 集合
  const processedRequestIds = new Set<string>();
  // 🔑 缓存结果（用于返回相同结果）
  const resultCache = new Map<string, string>();

  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    // 🔑 幂等性检查
    if (args.requestId && processedRequestIds.has(args.requestId)) {
      console.log(`[Workflow] Duplicate request: ${args.requestId}`);
      return resultCache.get(args.requestId) || '已处理';
    }
    
    const completion = new Trigger<string>();
    pendingQueue.push({ ...args, completion });
    const result = await completion;
    
    // 🔑 记录已处理
    if (args.requestId) {
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
    }
    
    return result;
  });

  // ... 其余代码
}
```

**优点**：
- ✅ 最快响应（内存查询，不调用 Activities）
- ✅ 不会重复入队
- ✅ 返回缓存结果（幂等性完美）
- ✅ 简单直观

**缺点**：
- ❌ 内存占用（每个 requestId ~50 bytes）
- ❌ ContinueAsNew 后需要传递状态（见方案 1.1）

---

## 方案 1.1：Workflow 内存去重 + ContinueAsNew 优化

### 处理 ContinueAsNew（传递去重状态）

```typescript
export async function chatSessionWorkflow(
  startArgs: StartSessionArgs,
  processedIds?: Set<string>  // 🔑 接收已处理的 ID
): Promise<void> {
  const processedRequestIds = processedIds || new Set<string>();
  const resultCache = new Map<string, string>();
  
  // ... handler 同方案 1 ...

  while (true) {
    await condition(() => pendingQueue.length > 0 || workflowInfo().continueAsNewSuggested);

    // 处理队列
    while (pendingQueue.length > 0) {
      const item = pendingQueue.shift()!;
      // ... 处理逻辑 ...
    }

    if (workflowInfo().continueAsNewSuggested) {
      // 🔑 传递去重状态（只保留最近的，避免无限增长）
      const recentIds = new Set(
        Array.from(processedRequestIds).slice(-1000) // 只保留最近 1000 个
      );
      
      return continueAsNew<typeof chatSessionWorkflow>({
        sessionId: startArgs.sessionId,
        startedAtMs: startArgs.startedAtMs,
      }, recentIds);
    }
  }
}
```

**优化**：
- ✅ 保留最近 1000 个 requestId（防止内存泄漏）
- ✅ ContinueAsNew 后去重仍然生效
- ⚠️ 超过 1000 个后的旧请求可能重复（可接受，后续层防护）

---

## 方案 2：队列入队前去重

### 实现

```typescript
setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
  // 🔑 检查是否已在队列中
  if (args.requestId) {
    const existing = pendingQueue.find(item => item.requestId === args.requestId);
    if (existing) {
      console.log(`[Workflow] Request already in queue: ${args.requestId}`);
      return await existing.completion; // 等待同一个 completion
    }
  }
  
  const completion = new Trigger<string>();
  pendingQueue.push({ ...args, completion });
  return await completion;
});
```

**优点**：
- ✅ 简单实现
- ✅ 防止并发重复入队

**缺点**：
- ❌ 只能防止"同时"进入队列的重复
- ❌ 已处理的请求再次进来仍会重复

---

## 方案 3：使用 Workflow Query 查询去重状态

### 实现

```typescript
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  const processedRequestIds = new Set<string>();
  const resultCache = new Map<string, string>();

  // 🔑 定义 Query：查询是否已处理
  const isProcessedQuery = defineQuery<boolean, [string]>('isProcessed');
  setHandler(isProcessedQuery, (requestId: string): boolean => {
    return processedRequestIds.has(requestId);
  });

  // 🔑 定义 Query：获取缓存结果
  const getResultQuery = defineQuery<string | null, [string]>('getResult');
  setHandler(getResultQuery, (requestId: string): string | null => {
    return resultCache.get(requestId) || null;
  });

  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    if (args.requestId && processedRequestIds.has(args.requestId)) {
      return resultCache.get(args.requestId) || '已处理';
    }
    
    const completion = new Trigger<string>();
    pendingQueue.push({ ...args, completion });
    const result = await completion;
    
    if (args.requestId) {
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
    }
    
    return result;
  });

  // ... 其余代码
}
```

### 后端调用（在 executeUpdate 前先查询）

```typescript
async function handleUserMessage(data: UserMessageData, context: MessageHandlerContext) {
  // ... 验证 ...
  
  try {
    const handle = getWorkflowHandle(sessionId);
    
    // 🔑 先通过 Query 检查是否已处理
    if (data.requestId) {
      const isProcessed = await handle.query('isProcessed', { args: [data.requestId] });
      if (isProcessed) {
        const cachedResult = await handle.query('getResult', { args: [data.requestId] });
        if (cachedResult) {
          return context.sendResponse({
            type: MESSAGE_TYPES.ASSISTANT_MESSAGE,
            sessionId,
            userId: data.userId,
            message: cachedResult,
            isNewSession,
          });
        }
      }
    }
    
    // 未处理，执行 Update
    const reply = await handle.executeUpdate('sendMessage', {
      args: [{ ...userMessage, startedAtMs: now, requestId: data.requestId }],
      ...(data.requestId && { updateId: data.requestId }),
    });
    
    // ... 发送响应 ...
  } catch (error: any) {
    // ... 错误处理 ...
  }
}
```

**优点**：
- ✅ 可以外部查询去重状态
- ✅ 更灵活（可用于监控）

**缺点**：
- ❌ 额外的网络请求（Query）
- ❌ 增加复杂度

---

## 方案 4：使用 sideEffect 记录已处理的 ID

### 实现

```typescript
import { sideEffect } from '@temporalio/workflow';

setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
  // 🔑 使用 sideEffect 记录（重播时会使用缓存）
  const isDuplicate = await sideEffect(() => {
    // 这段代码只在首次执行时运行
    // 重播时会使用历史记录的结果
    return processedRequestIds.has(args.requestId || '');
  });
  
  if (isDuplicate) {
    return resultCache.get(args.requestId || '') || '已处理';
  }
  
  const completion = new Trigger<string>();
  pendingQueue.push({ ...args, completion });
  const result = await completion;
  
  // 🔑 记录结果
  await sideEffect(() => {
    if (args.requestId) {
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
    }
  });
  
  return result;
});
```

**优点**：
- ✅ 重播安全（Temporal 保证）
- ✅ 决定性执行

**缺点**：
- ❌ sideEffect 的语义不适合去重（它是为非决定性操作设计的）
- ❌ 过度使用 sideEffect 会增加 History 大小

---

## 方案 5：混合方案（多层防护）⭐⭐

### 实现

```typescript
export async function chatSessionWorkflow(startArgs: StartSessionArgs): Promise<void> {
  const pendingQueue: QueueItem[] = [];
  let currentScope: CancellationScope | null = null;
  let sessionInitialized = false;
  
  // 🔑 第一层：内存去重
  const processedRequestIds = new Set<string>();
  const resultCache = new Map<string, string>();
  
  // 🔑 第二层：队列去重
  const inQueueRequestIds = new Map<string, Trigger<string>>();

  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    // 🔑 第一层检查：已完成的请求
    if (args.requestId && processedRequestIds.has(args.requestId)) {
      console.log(`[Workflow] Cache hit: ${args.requestId}`);
      return resultCache.get(args.requestId) || '已处理';
    }
    
    // 🔑 第二层检查：正在处理的请求
    if (args.requestId && inQueueRequestIds.has(args.requestId)) {
      console.log(`[Workflow] Request in queue: ${args.requestId}`);
      return await inQueueRequestIds.get(args.requestId)!;
    }
    
    const completion = new Trigger<string>();
    pendingQueue.push({ ...args, completion });
    
    // 记录正在处理
    if (args.requestId) {
      inQueueRequestIds.set(args.requestId, completion);
    }
    
    const result = await completion;
    
    // 移除队列标记，记录已完成
    if (args.requestId) {
      inQueueRequestIds.delete(args.requestId);
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
    }
    
    return result;
  });

  // ... 其余代码
}
```

**优点**：
- ✅ 双重防护（已完成 + 正在处理）
- ✅ 最完善的去重方案
- ✅ 防止并发重复

**缺点**：
- ❌ 稍微复杂

---

## 方案对比表

| 方案 | 响应速度 | 内存占用 | 复杂度 | ContinueAsNew | 推荐度 |
|-----|---------|---------|--------|---------------|--------|
| **当前（Update ID）** | ⚠️ 中等 | ✅ 低 | ✅ 低 | ✅ 无需处理 | ⭐⭐⭐ |
| **方案 1（内存去重）** | ✅ 最快 | ⚠️ 中等 | ✅ 低 | ❌ 需处理 | ⭐⭐⭐⭐ |
| **方案 1.1（+ContinueAsNew）** | ✅ 最快 | ✅ 可控 | ⚠️ 中等 | ✅ 已处理 | ⭐⭐⭐⭐⭐ |
| **方案 2（队列去重）** | ⚠️ 中等 | ✅ 低 | ✅ 低 | ✅ 无需处理 | ⭐⭐ |
| **方案 3（Query）** | ❌ 慢 | ⚠️ 中等 | ❌ 高 | ❌ 需处理 | ⭐ |
| **方案 4（sideEffect）** | ⚠️ 中等 | ⚠️ 中等 | ❌ 高 | ❌ 语义不适 | ⭐ |
| **方案 5（混合）** | ✅ 最快 | ⚠️ 中等 | ⚠️ 中等 | ❌ 需处理 | ⭐⭐⭐⭐⭐ |

---

## 推荐方案

### 🥇 小型系统（< 1000 sessions）
**方案 1.1：内存去重 + ContinueAsNew 优化**

- 简单高效
- 内存可控（保留最近 1000 个 ID）
- 最快响应

### 🥈 中大型系统（> 1000 sessions）
**方案 5：混合方案（多层防护）**

- 防止并发重复
- 正在处理的请求也能去重
- 最完善的方案

### 🥉 追求简单
**当前方案：Temporal Update ID + Activities 去重**

- 最简单
- 依赖 Temporal 内置机制
- 后续层防护足够

---

## 性能对比

### 场景：重复请求处理时间

| 方案 | 首次请求 | 重复请求（缓存命中） | 重复请求（缓存未命中） |
|-----|---------|-------------------|---------------------|
| Update ID only | ~1000ms | ~1000ms (重新执行) | ~1000ms |
| 内存去重 | ~1000ms | **~1ms** (内存) | ~50ms (DB 去重) |
| Query + Update | ~1050ms | **~50ms** (Query) | ~1050ms |
| 混合方案 | ~1000ms | **~1ms** (内存) | ~50ms (DB 去重) |

---

## 实现建议

### 快速实现（推荐方案 1.1）

```typescript
// 只需修改 chatSessionWorkflow 函数签名和 ContinueAsNew 部分
export async function chatSessionWorkflow(
  startArgs: StartSessionArgs,
  processedIds?: Set<string>
): Promise<void> {
  const processedRequestIds = processedIds || new Set<string>();
  const resultCache = new Map<string, string>();

  setHandler(sendMessageUpdate, async (args: SendMessageArgs): Promise<string> => {
    if (args.requestId && processedRequestIds.has(args.requestId)) {
      return resultCache.get(args.requestId) || '已处理';
    }
    
    const completion = new Trigger<string>();
    pendingQueue.push({ ...args, completion });
    const result = await completion;
    
    if (args.requestId) {
      processedRequestIds.add(args.requestId);
      resultCache.set(args.requestId, result);
    }
    
    return result;
  });

  // ... 其余代码不变 ...

  // 修改 ContinueAsNew
  if (workflowInfo().continueAsNewSuggested) {
    const recentIds = new Set(
      Array.from(processedRequestIds).slice(-1000)
    );
    return continueAsNew<typeof chatSessionWorkflow>(
      startArgs,
      recentIds
    );
  }
}
```

### 完整实现（推荐方案 5）

见上文"方案 5"代码示例。

---

## 总结

1. **当前方案已经足够**（Update ID + DB 去重）
2. **如需优化性能** → 方案 1.1（内存去重 + ContinueAsNew）
3. **如需最完善** → 方案 5（混合方案）
4. **不推荐** → 方案 3（Query）、方案 4（sideEffect）

选择哪种方案取决于：
- 系统规模
- 性能要求
- 复杂度接受度
- 内存约束

