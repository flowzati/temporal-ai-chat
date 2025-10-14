# WebSocket Router 重构说明

## 概述

将 `backend/src/index.ts` 中的 WebSocket 消息处理逻辑重构为更清晰的 Router/Dispatcher 模式。

## 重构前

原来的代码在 `ws.on('message')` 回调中使用大量的 `if-else` 来判断消息类型：

```typescript
ws.on('message', async (raw) => {
  if (data?.type === 'user_message') {
    // 处理用户消息...
  } else if (data?.type === 'confirm_ledger') {
    // 处理记账确认...
  } else if (data?.type === 'cancel') {
    // 处理取消...
  }
});
```

## 重构后

### 新增文件：`backend/src/services/wsRouter.ts`

创建了一个 `WebSocketRouter` 类，采用以下设计模式：

1. **消息处理器 (MessageHandler)**: 每种消息类型都有独立的处理函数
   - `handleUserMessage`: 处理用户消息
   - `handleConfirmLedger`: 处理记账确认
   - `handleCancel`: 处理取消操作

2. **路由器 (Router)**: 负责将消息分发到对应的处理器
   - 使用 `Map` 存储消息类型到处理器的映射
   - 支持动态注册新的消息处理器
   - 统一的错误处理

3. **上下文 (Context)**: 封装处理器所需的依赖
   - Temporal Client
   - WebSocket 连接

### 使用方式

在 `index.ts` 中，现在只需要几行代码：

```typescript
wss.on('connection', (ws) => {
  const router = new WebSocketRouter({
    client: temporalClient,
    ws
  });
  
  ws.on('message', (raw) => router.dispatch(raw));
});
```

## 优势

1. **更好的代码组织**: 每个消息处理器都是独立的函数，职责单一
2. **易于扩展**: 添加新的消息类型只需要：
   - 编写新的处理函数
   - 在 router 中注册
3. **易于测试**: 每个处理器都可以独立测试
4. **类型安全**: 使用 TypeScript 接口定义消息结构
5. **统一错误处理**: 所有错误都在 dispatcher 层统一捕获和处理
6. **可维护性**: 代码结构更清晰，符合单一职责原则

## 如何添加新的消息类型

1. 在 `wsRouter.ts` 中添加新的处理函数：
```typescript
async function handleNewMessageType(data: any, context: MessageHandlerContext): Promise<void> {
  // 处理逻辑
}
```

2. 在 `registerDefaultHandlers` 中注册：
```typescript
this.register('new_message_type', handleNewMessageType);
```

或者从外部注册：
```typescript
router.register('new_message_type', handleNewMessageType);
```

