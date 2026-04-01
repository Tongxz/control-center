# OpenClaw 控制中心 — 任务拆解

## 说明

- 每个 Task 是一次 forge spawn 的最小单元
- 每个 Task 完成后必须 checkpoint 验证，再派下一个
- 状态：`[ ]` 待执行 / `[~]` 进行中 / `[x]` 完成 / `[!]` 阻塞

---

## Phase 1 — 只读看板

**目标**：`node server.js` 跑起来，浏览器能看到真实数据

---

### T0 · JSON Schema 定义

- **状态**：[x]
- **范围**：`shared/schemas/` 下 4 个文件，不写任何 JS
- **输入**：spec 第 4 节核心对象定义
- **产出**：
  - `task.schema.json`
  - `project.schema.json`
  - `exception.schema.json`
  - `snapshot.schema.json`
- **完成标准**：4 个文件存在，字段与 spec 一致，JSON 格式合法（可用 ajv 验证）
- **不做**：不写任何 JS / HTML

---

### T1 · 项目脚手架

- **状态**：[x]
- **范围**：目录结构 + 依赖，不写业务逻辑
- **输入**：spec 第 8 节目录结构
- **产出**：
  - `workspace/control-center/` 完整目录
  - `package.json`（依赖：express, cors, chokidar）
  - 空 `runtime/tasks.json` `projects.json` `acks.json` `last-snapshot.json` `timeline.log`
- **完成标准**：`npm install` 无报错
- **不做**：不写 server.js 业务代码

---

### T2 · Backend 骨架（Mock 版）

- **状态**：[x]
- **范围**：Express 服务 + 所有路由 mock，前端空壳
- **输入**：spec 第 9 节 API 设计
- **产出**：
  - `server.js`：Express，注册全部路由，返回静态 mock 数据
  - `public/index.html`：空白页，能访问 `/`
- **完成标准**：`node server.js` 启动，`GET /api/overview/snapshot` 返回合法 JSON，浏览器能打开 `localhost:18799`
- **不做**：不接真实数据

---

### T3 · Workspace Indexer

- **状态**：[x]
- **范围**：读写 workspace MD 文件，接通文档和记忆接口
- **输入**：`~/.openclaw/workspace/*.md`、`memory/` 目录
- **产出**：
  - `indexer.js`：解析 MD 文件列表和内容
  - 接通 `GET /api/docs` `GET /api/docs/:id`（替换 mock）
  - 接通 `GET /api/memory` `GET /api/memory/:agentId`（替换 mock）
  - 接通 `PUT /api/docs/:id`（写回源文件）
  - 接通 `PUT /api/memory/:agentId`（写回源文件）
- **完成标准**：`GET /api/docs` 返回真实 MD 文件列表，PUT 后文件内容变更

---

### T4 · OpenClaw Poller

- **状态**：[x]
- **范围**：轮询 openclaw CLI，更新本地 snapshot
- **输入**：`openclaw status --json`、`openclaw agents list`、`cron list`
- **产出**：
  - `poll.js`：每 30s 执行一次 CLI 命令，写入 `runtime/last-snapshot.json`
  - 接通 `GET /api/overview/snapshot`（替换 mock）
  - 接通 `GET /api/agents`（替换 mock）
  - 接通 `GET /api/cron/history`（替换 mock）
  - `server.js` 启动时自动运行 poll 循环
- **完成标准**：`runtime/last-snapshot.json` 每 30s 更新，API 返回真实 agent 状态

---

### T5 · 前端 Shell

- **状态**：[x]
- **范围**：纯 HTML/CSS/JS，sidebar + 7 个 panel 空壳
- **约束**：无构建工具，无框架依赖，单文件 `public/index.html`
- **产出**：
  - 左侧 sidebar：Overview / Agents / Tasks / Exceptions / Documents / Memory / Settings
  - 右侧内容区：点击 sidebar 切换对应 panel，内容为占位文字
  - 深色主题（`#1a1a1a` 背景，`#e0e0e0` 文字）
- **完成标准**：7 个 panel 可点击切换，无 JS 报错

---

### T6 · 前端接通（Overview + Agents + Settings）

- **状态**：[x]
- **范围**：3 个 panel 接真实 API
- **产出**：
  - **Overview panel**：调 `/api/overview/snapshot`，显示 agent 忙闲分布、今日异常数、cron 状态
  - **Agents panel**：调 `/api/agents`，卡片式展示每个 agent 的状态、当前任务、身份摘要
  - **Settings panel**：调 `/api/settings/health`，显示 gateway 版本、连接状态、channel 状态
- **完成标准**：3 个 panel 显示真实数据，刷新页面数据更新

---

### T7 · 前端接通（Tasks + Exceptions + Documents + Memory）

- **状态**：[x]
- **范围**：4 个 panel 接真实 API，Tasks / Exceptions 支持写操作
- **产出**：
  - **Tasks panel**：列表展示，新建任务（填 title/owner/priority），状态切换（todo → doing → done）
  - **Exceptions panel**：异常列表 + 严重级别色标，支持 ack 操作
  - **Documents panel**：MD 文件列表，点击展开内容，支持编辑保存（调 PUT）
  - **Memory panel**：各 agent 记忆列表，支持编辑保存
- **完成标准**：Tasks 可新建，Exceptions 可 ack，Documents/Memory 可保存并写回文件

---

## Phase 2 — 治理与审批

**目标**：写操作闭环，任务和项目可管理，操作可审计

---

### T8 · Projects 数据层

- **状态**：[x]
- **范围**：后端 projects CRUD + task 关联
- **前置**：T7 完成
- **产出**：
  - `runtime/projects.json` 持久化
  - `GET /POST /PATCH /DELETE /api/projects`
  - `PATCH /api/tasks/:taskId`：支持 `projectId` 字段写入
- **完成标准**：API 可创建项目并将任务挂靠到项目

---

### T9 · Projects 前端看板

- **状态**：[x]
- **范围**：Projects panel UI
- **产出**：
  - 项目列表：名称、状态、进度条（完成任务数 / 总任务数）
  - 展开项目查看关联任务
  - 项目创建 / 归档操作
- **完成标准**：能创建项目、挂靠任务、看到进度

---

### T10 · Approvals 数据层

- **状态**：[x]
- **范围**：后端审批 CRUD + 审计日志
- **产出**：
  - `runtime/approvals.json` 持久化
  - `GET /api/approvals`：待审批列表
  - `POST /api/approvals/:id/approve`：审批通过（写备注）
  - `POST /api/approvals/:id/reject`：拒绝（写备注）
  - 每次操作追加写入 `runtime/timeline.log`
- **完成标准**：approve 操作有日志，timeline.log 有记录

---

### T11 · Approvals 前端

- **状态**：[x]
- **范围**：Approvals panel UI
- **产出**：
  - 待审批队列：标题、来源 agent、风险摘要
  - approve / reject 操作，支持输入备注
  - 审批历史 tab
- **完成标准**：完整审批流程可操作，历史可查

---

### T12 · Audit Timeline

- **状态**：[x]
- **范围**：timeline.log 解析 + Timeline panel
- **产出**：
  - `GET /api/timeline`：支持 `?agent=` `?from=` `?to=` 过滤
  - **Timeline panel**：时间轴展示所有写操作，显示操作人、时间、前后值摘要
- **完成标准**：所有 Phase 2 写操作（tasks/approvals/docs）均可在 Timeline 追溯

---

### T13 · LaunchAgent 自启 + Budget 预警

- **状态**：[x]
- **范围**：开机自启配置 + token 用量接入
- **产出**：
  - `scripts/install-launchagent.sh`：生成并安装 `com.openclaw.control-center.plist`
  - `scripts/uninstall-launchagent.sh`：卸载
  - `GET /api/settings/health` 新增 `budget` 字段（调 `openclaw usage --json`）
  - Settings panel 新增：token 消耗卡片 + 预算预警标识
- **完成标准**：重启后 server 自动运行，Settings 显示本月用量

---

## Phase 3 — 高级扩展

**目标**：完整可观察性 + 外部集成（细节待 Phase 2 完成后再定）

---

### T14 · 账单详情
- 按 agent / session / 项目分类的 token 消耗
- 日/周趋势图（canvas 原生绘制）
- CSV 导出

### T15 · Collaboration Hall
- spawn 链路可视化（main → forge → reviewer 树形图）
- 多 agent 协作时间线
- 数据源：session announce 记录

### T16 · Feishu 推送
- 异常告警、审批通知推送飞书
- 复用现有 `feishu-bot` 工具
- 可配置推送级别（仅 critical / 全部）

### T17 · Audit Export
- 快照导出（runtime + workspace 打包 ZIP）
- session 关键步骤回放（基于 timeline.log）

### T18 · 远程访问
- Tailscale 接入配置
- 简单 Bearer token 鉴权
- 待 Phase 2 完成后细化

---

## 执行顺序总览

```
Phase 1:
  T0 → T1 → T2 ✓(能跑) → T3 → T4 ✓(真实数据) → T5 → T6 → T7 ✓(全功能只读) ✅ DONE

Phase 2:
  T8 → T9 ✓(项目管) → T10 → T11 ✓(审批闭环) → T12 ✓(可审计) → T13 ✓(自启+预算)

Phase 3:
  T14 → T15 → T16 → T17 → T18（顺序可调）
```

---

*最后更新：2026-04-01*
*关联文档：[control-center-spec.md](control-center-spec.md)*
