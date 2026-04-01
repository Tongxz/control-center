# OpenClaw 控制中心 — SPEC.md

## 项目名称
OpenClaw Control Center（自定义版）

## 版本
v0.2

## 状态
设计定稿

---

## 1. 设计目标

1. 统一查看系统运行状态、Agent 状态、任务状态、异常状态
2. 为多 Agent 协作提供可观察、可追踪、可审计的操作界面
3. 将任务、项目、记忆、文档、异常、审计从"散落在 session 和文件里"提升为可治理对象
4. 不替代 OpenClaw 本体，只做控制、观测、治理辅助
5. 支持从"只读看板"逐步演进到"受控写操作平台"

## 2. 非目标

- 不替代 OpenClaw Gateway / session runtime
- 不替代模型编排内核
- 不直接承担 LLM 决策
- 不假设拥有强一致性执行真相源

---

## 3. 总体架构：四层数据面

### A. OpenClaw 实时运行面
- session 列表 / 历史 / 状态
- cron 状态
- approval 状态
- agent roster

### B. 控制中心本地状态面
- tasks、projects、budgets、acks
- snapshots、timeline
- approval action log、digest、export snapshot

### C. 文件系统知识面
- IDENTITY.md、SOUL.md、AGENTS.md、MEMORY.md
- daily memory、docs、HALL.md

### D. 治理与派生计算面
- exceptions、action queue
- budget evaluation、context pressure
- commander digest、audit timeline、graph、replay index

---

## 4. 核心对象

| 对象 | 说明 |
|------|------|
| Agent | displayName、role、status、sessionIds、workspacePath、memoryHealth |
| Session | sessionId、agentId、status、tokenUsage、cost、lastSnippet |
| Task | taskId、title、ownerAgentId、projectId、status、priority、riskLevel、dod、artifacts、rollbackPlan |
| Project | projectId、name、status、owner、budgetScope、taskIds、progress |
| Exception | exceptionId、type、severity、source、message、actionRequired |
| Approval | approvalId、source、title、status、riskSummary、rollbackPlan |

---

## 5. Phase 1 模块清单（最小可用）

### 1. Overview 总览
- 系统健康概览
- Agent 忙闲分布
- 今日异常摘要
- 快速跳转入口

**数据源**: `openclaw status --json`、`cron list`、MEMORY.md

### 2. Staff Agent 状态
- Agent 列表 + 当前运行状态
- 当前任务 / 下一个任务
- 身份 / 职责摘要
- memory health

**数据源**: `openclaw agents list`、`sessions --all-agents`、IDENTITY.md/SOUL.md/AGENTS.md

### 3. Tasks 任务（基础版）
- 任务列表、状态流转
- owner 分配
- linked session / project
- heartbeat 检查

**数据源**: 本地 `runtime/tasks.json`

### 4. Exceptions 异常中心
- 异常聚合 + 严重级别
- action queue
- ack / snooze
- 关联上下文跳转

**数据源**: session errors、cron errors、`openclaw doctor`、runtime/acks.json

### 5. Documents 文档
- 核心文档查看/编辑（IDENTITY/SOUL/AGENTS/MEMORY/TOOLS）
- 保存后直接写回源文件

**数据源**: workspace 文件系统

### 6. Memory 记忆
- 长期记忆查看/编辑（MEMORY.md）
- 每日记忆查看（memory/YYYY-MM-DD.md）
- memory health 状态

**数据源**: MEMORY.md、memory/ 目录

### 7. Settings / Health
- Gateway 版本、连接状态
- channel 状态（Feishu）
- API key 状态（不显示值）
- skill 注册情况
- 安全配置（allowInsecureAuth 等）

**数据源**: `openclaw status --json`、`openclaw channels status --probe`

---

## 6. 五个落地先决条件

Phase 1 开始前先定这 5 份：

1. `task.schema.json` — 任务实体结构
2. `project.schema.json` — 项目实体结构
3. `exception.schema.json` — 异常实体结构
4. `overview.snapshot.schema.json` — 总览快照结构
5. `control-api.yaml` — API 接口定义

---

## 7. 技术架构

```
Browser (localhost:18799)
        │
        │ fetch /api/*
        ▼
Backend (Node.js)           ← workspace/control-center/
  ├── Runtime Ingest          polls openclaw CLI
  ├── Workspace Indexer       reads workspace/*.md
  ├── Governance Engine       computes exceptions/action queue
  └── Control API             HTTP endpoints
        │
        ▼
  runtime/                    控制中心本地状态
  ├── tasks.json
  ├── projects.json
  ├── acks.json
  ├── last-snapshot.json
  ├── timeline.log
  └── digests/
```

---

## 8. 目录结构

```
workspace/control-center/
├── server.js              # HTTP server + API
├── poll.js                # 轮询逻辑
├── package.json
├── runtime/               # 本地状态存储
│   ├── tasks.json
│   ├── projects.json
│   ├── acks.json
│   ├── last-snapshot.json
│   └── timeline.log
├── shared/
│   ├── schemas/           # JSON Schema 定义
│   │   ├── task.schema.json
│   │   ├── project.schema.json
│   │   ├── exception.schema.json
│   │   └── snapshot.schema.json
│   └── types/
└── public/
    └── index.html         # 控制面板 UI
```

---

## 9. API 设计

| 接口 | 说明 |
|------|------|
| `GET /api/overview/snapshot` | 首页聚合快照 |
| `GET /api/agents` | Agent 列表 + 状态 |
| `GET /api/agents/:agentId/sessions` | 某 agent 的 session 列表 |
| `GET /api/tasks` | 任务列表 |
| `POST /api/tasks` | 创建任务 |
| `PATCH /api/tasks/:taskId` | 更新任务 |
| `GET /api/exceptions` | 异常列表 |
| `POST /api/action-queue/:itemId/ack` | 确认异常 |
| `GET /api/docs` | 文档列表 |
| `GET /api/docs/:docId` | 文档内容 |
| `PUT /api/docs/:docId` | 保存文档 |
| `GET /api/memory` | 记忆列表 |
| `GET /api/memory/:agentId` | 某 agent 记忆 |
| `PUT /api/memory/:agentId` | 更新记忆 |
| `GET /api/settings/health` | 系统健康状态 |
| `GET /api/cron/history` | Cron 执行历史 |

---

## 10. 安全与模式

| 模式 | 说明 |
|------|------|
| 只读模式（默认） | 允许查看全部状态，禁止变更 |
| 受控写模式 | 允许任务、文档、记忆写操作 |
| 审批执行模式 | 允许 approve/reject，需显式开启 |

---

## 11. Phase 2 模块清单（治理与审批）

**目标**：从"只读看板"升级为"受控写操作平台"，支持任务审批和项目管理闭环。

### 1. Projects 看板
- 项目列表、进度、关联任务
- 项目创建 / 归档
- 任务 → 项目挂靠
- 甘特式时间线（简版）

**数据源**: `runtime/projects.json`

### 2. Approvals 审批闭环
- 待审批队列（agent 发起的高风险操作）
- approve / reject + 备注
- 审批历史记录
- 关联 Task / Exception

**数据源**: `runtime/approvals.json`、`openclaw approvals list`

### 3. Audit Timeline
- 所有写操作的审计日志
- 操作人（agent / user）、时间、前后值
- 可按 agent / 时间段过滤

**数据源**: `runtime/timeline.log`

### 4. Budget Governance（基础版）
- 各 agent 本月 token 消耗
- 预算上限配置
- 超限预警

**数据源**: `openclaw usage --json`

### 5. LaunchAgent 自启
- 生成 `com.openclaw.control-center.plist`
- 开机自动启动 server.js
- 状态管理（start / stop / restart）

---

## 12. Phase 3 模块清单（高级扩展）

**目标**：完整可观察性 + 远程访问 + 外部集成。

### 1. Usage & Cost 详细账单
- 按 session / agent / 项目分类
- 日/周/月趋势图
- 导出 CSV

### 2. Audit Replay / Export
- session 重放（关键步骤回溯）
- 快照导出（ZIP：runtime + workspace）
- 合规审计报告生成

### 3. Collaboration Hall
- 多 agent 协作记录看板
- spawn 链路可视化（main → forge → reviewer）
- 任务传递时间线

### 4. External Bridge
- Feishu 消息推送（异常告警、审批通知）
- Telegram / Discord（可选）
- Webhook 出口（通用）

### 5. 远程访问
- Tailscale 接入配置
- 简单 token 鉴权
- HTTPS 支持

---

## 13. Phase 路线图

| Phase | 核心目标 | 预计任务数 | 前置条件 |
|-------|---------|-----------|---------|
| **Phase 1** | 可观测，只读看板跑起来 | 8 个 forge 任务 | 4 个技术决策已定 |
| **Phase 2** | 受控写操作，治理闭环 | 6 个 forge 任务 | Phase 1 完成，runtime 结构稳定 |
| **Phase 3** | 高级扩展，远程+集成 | 待定 | Phase 2 完成 |

---

## 14. 技术决策记录（ADR）

| 编号 | 问题 | 决策 | 理由 |
|------|------|------|------|
| ADR-01 | 后端语言 | **Node.js** | 现有栈一致，forge 最熟 |
| ADR-02 | 启动方式 | **手动 `node server.js`**，Phase 2 加 LaunchAgent | Phase 1 先跑起来 |
| ADR-03 | 远程访问 | **暂不支持，localhost only** | Phase 3 再加 Tailscale |
| ADR-04 | 存储选型 | **JSON 文件**，复杂后换 SQLite | 零依赖，Phase 1 够用 |
| ADR-05 | Tasks 数据源（3.31+） | **OpenClaw SQLite 后端**为真实源，`runtime/tasks.json` 仅作本地任务补充 | 3.31 将 tasks 统一为 SQLite，control-center 作为观察者接入 |
| ADR-06 | Task Flows | **观察优先**，通过 `openclaw flows list` 展示 flow 状态，不做写操作 | Flow 是 3.31 新增概念，写操作接口待成熟 |
