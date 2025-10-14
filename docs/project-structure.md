# 项目结构

## 后端目录结构（重构后）

```
backend/src/
│
├── 📄 index.ts                          # 🎯 主入口（38 行）
│   └── 职责：组合模块，启动服务器
│
├── 📄 worker.ts                         # Temporal Worker 入口
│   └── 职责：运行 Temporal 工作流
│
├── 📄 types.ts                          # TypeScript 类型定义
│   └── 职责：全局类型声明
│
├── 📁 services/                         # 🎯 业务服务层
│   ├── httpRouter.ts                    # HTTP REST API 路由
│   │   ├── createHttpRequestHandler()   # 创建 HTTP 处理器
│   │   ├── handleListSessions()         # GET /api/sessions
│   │   ├── handleGetMessages()          # GET /api/sessions/:id/messages
│   │   └── handleNotFound()             # 404 处理
│   │
│   ├── websocketServer.ts               # WebSocket 服务器配置
│   │   └── setupWebSocketServer()       # 设置 WebSocket 服务器
│   │
│   └── wsRouter.ts                      # 🎯 WebSocket 消息路由器
│       ├── WebSocketRouter              # 路由器类
│       ├── handleUserMessage()          # 处理用户消息
│       ├── handleConfirmLedger()        # 处理记账确认
│       └── handleCancel()               # 处理取消操作
│
├── 📁 temporal/                         # Temporal 相关
│   ├── workflows.ts                     # 工作流定义
│   │   └── chatSessionWorkflow()        # 聊天会话工作流
│   │
│   └── activities.ts                    # Activity 定义
│       ├── callAI()                     # 调用 AI 服务
│       ├── saveLedger()                 # 保存记账记录
│       └── queryLedgerRange()           # 查询记账范围
│
└── 📁 utils/                            # 工具函数
    ├── env.ts                           # 环境配置加载
    │   └── loadConfig()                 # 加载配置
    │
    ├── db.ts                            # 🎯 数据库操作
    │   ├── getDb()                      # 获取数据库连接
    │   ├── upsertSession()              # 更新/插入会话
    │   ├── insertMessage()              # 插入消息
    │   ├── listSessions()               # 列出会话
    │   ├── getMessages()                # 获取消息
    │   ├── insertLedgerEntry()          # 插入记账
    │   └── sumLedgerEntriesByRange()    # 汇总记账
    │
    ├── temporal.ts                      # 🎯 Temporal Client 工具
    │   └── createTemporalClient()       # 创建 Temporal 客户端
    │
    ├── ai.ts                            # AI 服务集成
    │   └── callOpenAI()                 # 调用 OpenAI API
    │
    └── ledger.ts                        # 记账相关工具
        └── parseDateRange()             # 解析日期范围
```

## 模块依赖关系

```
┌─────────────────────────────────────────────────────────┐
│                      index.ts                           │
│                   (主入口/组合层)                        │
└─────────────────┬───────────────────┬───────────────────┘
                  │                   │
      ┌───────────▼──────────┐   ┌───▼──────────────────┐
      │  httpRouter.ts       │   │ websocketServer.ts   │
      │  (REST API)          │   │ (WebSocket 配置)     │
      └───────────┬──────────┘   └───┬──────────────────┘
                  │                  │
                  │              ┌───▼──────────────────┐
                  │              │  wsRouter.ts         │
                  │              │  (消息路由)          │
                  │              └───┬──────────────────┘
                  │                  │
      ┌───────────▼──────────────────▼──────────────────┐
      │              temporal.ts                         │
      │          (Temporal Client)                       │
      └───────────┬──────────────────┬──────────────────┘
                  │                  │
      ┌───────────▼──────────┐   ┌──▼──────────────────┐
      │  workflows.ts        │   │  activities.ts      │
      │  (工作流逻辑)        │   │  (活动实现)         │
      └───────────┬──────────┘   └──┬──────────────────┘
                  │                  │
      ┌───────────▼──────────────────▼──────────────────┐
      │              db.ts / ai.ts / ledger.ts          │
      │              (底层工具函数)                      │
      └─────────────────────────────────────────────────┘
```

## 数据流图

### REST API 流程
```
Client Request
    │
    ▼
httpRouter.ts ────► handleListSessions()
    │                      │
    │                      ▼
    │                  db.ts ────► SQLite
    │                      │
    │                      ▼
    └──────────────► Response JSON
```

### WebSocket 消息流程
```
Client WebSocket Message
    │
    ▼
wsRouter.ts ────► dispatch()
    │                 │
    │                 ▼
    │            handleUserMessage()
    │                 │
    │                 ▼
    │         temporal.ts ────► Temporal Workflow
    │                 │              │
    │                 │              ▼
    │                 │         workflows.ts
    │                 │              │
    │                 │              ▼
    │                 │         activities.ts
    │                 │              │
    │                 │              ├──► ai.ts ────► OpenAI
    │                 │              │
    │                 │              └──► db.ts ────► SQLite
    │                 │
    │                 ▼
    └──────────► WebSocket Response
```

## 关键文件说明

### 🎯 核心文件（重构重点）

| 文件 | 行数 | 职责 | 重构状态 |
|------|------|------|----------|
| **index.ts** | ~38 | 主入口，组合模块 | ✅ 已重构 |
| **httpRouter.ts** | ~100 | HTTP API 路由 | ✅ 新建 |
| **wsRouter.ts** | ~164 | WebSocket 路由 | ✅ 已重构 |
| **websocketServer.ts** | ~20 | WebSocket 配置 | ✅ 新建 |
| **temporal.ts** | ~7 | Temporal 工具 | ✅ 新建 |

### 📊 代码分布

```
总代码行数: ~800 行

分布：
├── index.ts              5%  ████
├── services/            40%  ████████████████████████████████
├── temporal/            30%  ████████████████████████
├── utils/               20%  ████████████████
└── types.ts             5%   ████
```

## 模块职责矩阵

| 模块 | HTTP | WebSocket | Temporal | Database | AI | 配置 |
|------|------|-----------|----------|----------|----|----|
| index.ts | ✓ 组合 | ✓ 组合 | ✓ 初始化 | - | - | ✓ 加载 |
| httpRouter.ts | ✓ 实现 | - | - | ✓ 调用 | - | - |
| wsRouter.ts | - | ✓ 实现 | ✓ 调用 | ✓ 调用 | - | - |
| websocketServer.ts | - | ✓ 配置 | - | - | - | - |
| temporal.ts | - | - | ✓ 创建 | - | - | - |
| workflows.ts | - | - | ✓ 实现 | - | - | - |
| activities.ts | - | - | - | ✓ 调用 | ✓ 调用 | - |
| db.ts | - | - | - | ✓ 实现 | - | - |
| ai.ts | - | - | - | - | ✓ 实现 | - |

## 启动流程

```
1. main() 函数启动
   │
   ├─► 加载配置 (loadConfig)
   │
   ├─► 创建 HTTP 处理器 (createHttpRequestHandler)
   │
   ├─► 创建 HTTP 服务器
   │
   ├─► 初始化 Temporal Client (createTemporalClient)
   │
   ├─► 设置 WebSocket 服务器 (setupWebSocketServer)
   │
   └─► 启动监听 (server.listen)
       │
       └─► 服务器运行中
           ├─► HTTP 请求 → httpRouter
           └─► WebSocket 连接 → wsRouter
```

## 文件大小对比

### 重构前
```
index.ts: ████████████████████ 82 行
```

### 重构后
```
index.ts:           ████████ 38 行
httpRouter.ts:      █████████████████████ 100 行
wsRouter.ts:        ████████████████████████████████ 164 行
websocketServer.ts: ███ 20 行
temporal.ts:        █ 7 行
```

**总行数**: 82 → 329 行（包含注释和更好的代码组织）

**优势**: 虽然总行数增加，但每个文件职责单一，更易维护和测试！

