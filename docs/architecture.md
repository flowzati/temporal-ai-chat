# 项目架构说明

## 概览

本项目是一个基于 Temporal.io 的 AI 聊天应用，使用 TypeScript、React 和 WebSocket 实现实时通讯。

## 后端架构

### 目录结构

```
backend/src/
├── server.ts                   # HTTP/WebSocket server process
├── temporalWorker.ts           # Temporal worker process
├── services/                   # 业务服务层
│   ├── httpRouter.ts          # HTTP REST API 路由
│   ├── websocketServer.ts     # WebSocket 服务器配置
│   └── wsRouter.ts            # WebSocket 消息路由器
├── temporal/                   # Temporal 相关
│   ├── workflows.ts           # 工作流定义
│   └── activities.ts          # Activity 定义
├── utils/                      # 工具函数
│   ├── env.ts                 # 环境配置加载
│   ├── db.ts                  # 数据库操作
│   ├── temporal.ts            # Temporal Client 工具
│   ├── ai.ts                  # AI 服务集成
│   └── ledger.ts              # 记账相关工具
└── types.ts                    # TypeScript 类型定义
```

### 模块职责

#### 1. **server.ts** - HTTP/WebSocket server process
- **职责**：组合各个模块，启动 HTTP/WebSocket 服务器
- **特点**：简洁清晰，只有 ~40 行代码
- **功能**：
  - 加载配置
  - 创建 HTTP 服务器
  - 初始化 Temporal Client
  - 设置 WebSocket 服务器
  - 启动监听

#### 2. **temporalWorker.ts** - Temporal worker process
- **职责**：启动 Temporal Worker，执行 workflow tasks 与 activities
- **功能**：
  - 加载配置
  - 注册 workflows 与 activities
  - 监听 configured task queue
  - 长驻执行 Temporal 任务

#### 3. **services/httpRouter.ts** - HTTP 路由
- **职责**：处理 REST API 请求
- **端点**：
  - `GET /api/sessions` - 获取会话列表
  - `GET /api/sessions/:id/messages` - 获取会话消息
- **特点**：
  - CORS 支持
  - 统一错误处理
  - 清晰的函数分离

#### 4. **services/websocketServer.ts** - WebSocket 配置
- **职责**：设置 WebSocket 服务器
- **功能**：
  - 创建 WebSocketServer 实例
  - 为每个连接创建路由器
  - 绑定消息处理

#### 5. **services/wsRouter.ts** - WebSocket 路由器
- **职责**：分发 WebSocket 消息到对应处理器
- **消息类型**：
  - `user_message` - 用户发送消息
  - `confirm_ledger` - 确认记账
  - `cancel` - 取消操作
- **特点**：
  - Router/Dispatcher 模式
  - 支持动态注册新的消息类型
  - 统一的错误处理

#### 5. **utils/temporal.ts** - Temporal 工具
- **职责**：创建和管理 Temporal Client
- **功能**：封装 Temporal 连接逻辑

#### 6. **utils/db.ts** - 数据库操作
- **职责**：SQLite 数据库操作
- **表结构**：
  - `sessions` - 会话表
  - `messages` - 消息表
  - `ledger_entries` - 记账表

## 设计模式

### 1. Router/Dispatcher 模式
用于 HTTP 和 WebSocket 消息路由，提高代码可维护性和可扩展性。

### 2. 依赖注入
通过构造函数传递依赖（如 Temporal Client），便于测试和模块解耦。

### 3. 单一职责原则
每个模块只负责一个明确的功能，降低耦合度。

### 4. 工厂模式
使用工厂函数创建服务器和处理器实例。

## 数据流

### REST API 流程
```
Client → HTTP Router → DB → Response
```

### WebSocket 聊天流程
```
Client → WS Router → Temporal Workflow → AI Service → DB → Client
```

### 记账流程
```
Client → WS Router → Temporal Workflow → DB (ledger_entries) → Client
```

## 关键优势

1. **模块化设计**：每个模块职责清晰，易于维护
2. **可测试性**：各模块可独立测试
3. **可扩展性**：添加新功能只需添加新的路由处理器
4. **类型安全**：完整的 TypeScript 类型定义
5. **错误处理**：统一的错误处理机制

## 如何扩展

### 添加新的 REST API 端点
在 `services/httpRouter.ts` 中：
1. 创建处理函数
2. 在路由分发中添加匹配规则

### 添加新的 WebSocket 消息类型
在 `services/wsRouter.ts` 中：
1. 创建消息处理函数
2. 在 `registerDefaultHandlers()` 中注册

### 添加新的 Temporal Workflow
1. 在 `temporal/workflows.ts` 中定义 workflow
2. 在 `temporal/activities.ts` 中定义 activities
3. 在路由器中调用 workflow
