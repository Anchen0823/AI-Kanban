# AI Control Center

个人 AI 历史用量工作台。**本地单用户，单机运行，不替换你现有的任何 AI 客户端。**

首页以历史累计 Token 为主：同步本机 Codex 会话记录，查看输入、输出、缓存、推理及模型 / 日期分布；导入 API 用量记录后按供应商累计。当前 Codex 额度与 DeepSeek 余额位于折叠区，记忆工具暂放「更多工具」。使用方式与覆盖边界见 [历史用量统计](./docs/06-usage-dashboard.md)。

它解决的问题是：你在 ChatGPT、Codex、Cursor、WorkBuddy 之间来回切换时，
用量、额度、项目状态和个人偏好各自留在不同客户端里，彼此之间无法交接。

WorkBuddy 历史用量已支持：在首页点击「同步 WorkBuddy」，读取本机项目日志并加入累计 Token，支持模型和日期明细。无需 MCP 或 API Key，范围说明见 [WorkBuddy 历史用量](./docs/08-workbuddy-history.md)。

本仓库当前实现到设计稿 §16 的 **M1**，分两段看：

- **M0 已交付**：登记 / 用量导入与去重 / 额度快照 / 记忆候选审核与版本 / 上下文包导出 / 备份恢复。
- **M1 已交付的部分**：本地 MCP 传输层（`apps/mcp`，六个工具全通）、Codex 用量接口只读探测、
  以及客户端 / 账户 / 订阅的登记界面。
  **尚未交付**：在真实 Codex / Cursor / WorkBuddy 客户端里的联调。详见 §6.1。

设计原文见 [`AI-Control-Center-Design-v0.1.md`](./AI-Control-Center-Design-v0.1.md)，
实施设计见 [`docs/00-m0-scope.md`](./docs/00-m0-scope.md) 与 [`docs/03-m1-scope.md`](./docs/03-m1-scope.md)。

---

## 快速开始

### Windows 桌面版

双击 `release/AI-Control-Center-0.2.0-x64.exe` 即可使用，内置运行时、自动配对，关窗后自动停止服务。从源码运行：`npm run desktop`；生成便携版：`npm run desktop:pack`。数据默认保存在 `%APPDATA%/AI Control Center/data`，现有网页数据的接入方式和验证命令见 [桌面版说明](./docs/07-desktop.md)。

### 网页版

> **不知道从哪下手？** 直接看 [`docs/04-how-to-use.md`](./docs/04-how-to-use.md)——
> 那份文档只回答「第一步做什么、第二步做什么」，不含设计动机。

需要 **Node ≥ 22.5**（用到内置的 `node:sqlite`）。

```bash
npm install
npm run build          # 构建 core → server → web
npm start              # 启动服务
```

启动后终端会打印一行**黄色配对码**：

```
  配对码：K7M2QP4R
```

浏览器打开 `http://127.0.0.1:8787`，把这个码填进去。

> **为什么要配对？** 服务只监听 `127.0.0.1`，但「只监听本地」并不等于「只有你能调用」——
> 你打开的任何一个网页都能向 localhost 发请求。所以启动时打印一次性配对码，
> 配对成功后该码立即更换。

### 把 MCP 挂到你的客户端

服务端是一个 stdio 进程，构建产物入口在 `apps/mcp/dist/index.js`。
它需要两样东西才能工作：**工作台服务正在运行**，以及**一个复用凭据**（在
「设置与连接 → 代理凭据」里签发，明文只显示一次）。

在「代理凭据 → 连接本地 MCP」可复制 Codex TOML / Cursor JSON 配置。配置自动使用
本机 Node、MCP 入口的完整路径和当前服务端口；签发弹窗内的配置会填入刚签发的凭据。
已有配置文件时只合并本服务的配置项，保留其他服务。完整步骤见
[`docs/04-how-to-use.md`](./docs/04-how-to-use.md#6-本地-mcp-接入)。

环境变量只有两个（`AICC_API_URL` 默认就是 `http://127.0.0.1:8787`）：

```bash
AICC_TOKEN=<你的凭据> node apps/mcp/dist/index.js
```

启动后它在 stderr 上打印工作台地址与凭据状态 —— **stdout 是协议通道**，
往那里打一行日志就会让客户端反序列化失败，所以所有诊断信息都走 stderr。

> 这一步目前**还没有在任何真实客户端里跑过**。
> 传输层与六个工具都有端到端测试，但「在你的 Codex / Cursor 里真正能用」
> 需要你挂上去试一次（详见 `docs/03-m1-scope.md` §6.1）。
> 已知坑：codex 的 `config.toml` 里若有 `service_tier="default"`，0.130.0 会判整个配置无效
> 并放弃读取它 —— 于是写进去的 MCP 项也不会生效。

### 开发模式

```bash
npm run dev            # 同时启动 API(8787) 与 Vite(5173)
```

### 验证

```bash
npm run verify:sqlite  # SQLite 驱动最小兼容性验证
npm test               # core + server + mcp + web 全部测试
npm run typecheck
npm run verify:smoke   # 真实 HTTP 端到端冒烟（会真的启动服务进程）
```

本轮审查与改进记录见 [`docs/05-review-hardening.md`](./docs/05-review-hardening.md)：
代理读取权限、备份校验、示例工作区隔离、候选预检、未知 token 与 MCP 接入配置。

### 起不来的时候

**`端口 8787 已被占用`** —— 最常见的原因是上一个实例还在运行（关掉终端窗口不会结束进程）。
启动脚本会直接打印排查命令；也可以换端口起：

```bash
AICC_PORT=8788 npm start        # PowerShell: $env:AICC_PORT=8788; npm start
```

**服务本身能连、界面打不开** —— 先确认前端产物是否构建过（`npm run build`），
服务端只会把 `apps/web/dist` 里的东西当作静态资源提供。

**数据在哪** —— 默认 `data/ai-control-center.sqlite`（可用 `AICC_DATA_DIR` 改）。
备份是「设置与连接」页里的一键操作，或者直接复制 `data/backups/` 下的目录。

---

## 它怎么算账

这是本项目最需要说清楚的部分。四条规则贯穿全部代码：

**1. 未知就是未知，不是 0。**
供应商没报告 token 就是 `null`。存 0 会让「这个月比上个月少了」这种结论完全失真。

**2. 缓存和推理是子项，不重复相加。**
`cached ⊆ input`、`reasoning ⊆ output`，所以总量 = 输入 + 输出。
输入 10,000（含缓存 6,000）+ 输出 2,000（含推理 1,000）= **12,000**，不是 19,000。

**3. 同一条事实只计一次，但只存一份不等于只有一份来源。**
去重键（管「这一行走过没有」）和身份键（管「这是不是同一个请求」）是两个东西。
同一请求出现在网关和日志里时，第二条作为证据保留但不计入统计。
缺少稳定请求 ID 的跨文件重复会标为**待确认**——既不静默合并，也不静默丢弃。

**4. 额度、汇总、明细三者永不互相相加。**
额度是状态快照，到了重置时间但没重新查询就显示「待刷新」，
**绝不会自动按 100% 计算**。费用按币种分行展示，不做跨币种相加。

首页因此没有「总消耗」这一个数字 —— 只有按口径分开的几组数字。这是刻意的。

---

## 它怎么管记忆

- **AI 只能提案，批准是你一个人的动作。** 正式记忆只能由 `approve` 产生，
  代码里不存在「直接写入一条生效记忆」的路径。
- **更新必须带基线版本。** 两个客户端基于同一旧版本修改时，第二次审批会返回 409 冲突，
  不会采用「最后写入者获胜」。
- **删除会留下只含哈希的墓碑**，防止旧导入包把已删除的内容悄悄复活。
  删除报告会如实列出「不随本次删除消失」的东西：你已经复制到别处的文本、其他平台的原生记忆、你自己的备份。
- **上下文包有版本和清单。** 它包含本次目标、已确认事实、当前决策、**已尝试且失败的路径**、下一步、来源与版本。
  清单能证明系统返回了哪些资料，**不能**证明目标模型读了或遵守了它们。

---

## 它不做什么

以下都是设计稿里的后续阶段，**当前版本没有实现**，界面上也如实标注为不可用：

| 未实现 | 计划阶段 |
|---|---|
| 在真实 Codex / Cursor / WorkBuddy 客户端里挂载本 MCP 并联调 | M1 剩最后一步（服务端已就绪，需你在自己机器上配一次） |
| Cursor 用量 / 费用探测 | M1 未完成 |
| ChatGPT 导出包（`conversations.json`）解析 | M2 |
| 内置 AI 提炼（请在你现有的客户端里生成候选再粘贴进来） | 不在 M0 / M1 |
| LiteLLM / Langfuse / 向量检索 / 远程网关 | M3 |
| 多用户与权限系统 | 不做。这是本地单用户工具 |

> **「内部能重复」不等于「外部已验证」。** MCP 服务有端到端测试、能被外部进程
> 真的调用并通过授权隔离检查，但只要没在你的真实客户端里挂过一次，
> 「能力登记」页里那一项就仍然是 `documented`（官方文档描述支持），不会自己变成「已同步」。

另外：不抓 Cookie、不调私有网页接口、不把订阅迁移到收费 API、
不把未知 token 填 0、不给代理凭据审批或删除权限、
不让 Markdown 和 SQLite 同时成为可自动覆盖对方的主库。

---

## 目录结构

```
├─ AI-Control-Center-Design-v0.1.md   原始设计稿
├─ docs/
│  ├─ 00-m0-scope.md                  目录结构 / 数据实体 / 状态迁移 / M0 未实现清单
│  ├─ 01-invariants.md                关键不变量（可执行断言的来源）
│  ├─ 02-test-plan.md                 M0 验收测试计划与实测结果
│  ├─ 03-m1-scope.md                  M1：本地 MCP 传输层与 Codex 只读探测
│  └─ 04-how-to-use.md                上手指南：第一步做什么、第二步做什么
├─ scripts/
│  ├─ verify-sqlite.mjs               SQLite 驱动最小兼容性验证
│  ├─ smoke.mjs                       真实 HTTP 端到端冒烟
│  └─ dev.mjs                         零依赖的并行开发脚本
├─ packages/core/                     无 I/O 的领域逻辑（前后端共用）
├─ apps/server/                       本地单体服务（Fastify + SQLite）
│  └─ src/collectors/                 外部只读采集适配器（Codex app-server）
├─ apps/mcp/                          本地 stdio MCP 服务（纯转发，无业务判断）
└─ apps/web/                          React 工作台
```

`packages/core` 不做任何 I/O。金额、Token 归一化、去重决策、额度新鲜度、
记忆状态机、上下文预算全部放在这里，前端直接引用同一套规则 ——
这样「界面显示的口径」和「服务端计算的口径」不可能悄悄漂移。

---

## 数据与隐私

- 数据库、备份、导出都在 `data/`（可用 `AICC_DATA_DIR` 改）。**`data/` 已在 `.gitignore` 里。**
- 服务默认只监听回环地址。把 `AICC_HOST` 改成别的值会被**直接拒绝启动**，
  以防把本地服务暴露到局域网。
- 凭据只保存哈希，明文只在签发时显示一次。
- 审计只记动作、ID、时间与结果，**不复制被删除内容的全文**。
- **本地 MCP 不等于数据不出机器。** 代理凭据返回的文本可能进入所连接 AI 客户端及其模型服务，
  所以全局个人记忆默认不向每个 agent 开放。

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AICC_PORT` | `8787` | 监听端口 |
| `AICC_HOST` | `127.0.0.1` | 只接受回环地址 |
| `AICC_DATA_DIR` | `./data` | 数据目录 |
| `AICC_TZ` | `Asia/Shanghai` | 展示时区（存储一律 UTC） |
| `AICC_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | 允许调用写接口的来源 |
| `AICC_CODEX_COMMAND` | `codex` | Codex 探针调用的命令名（不在 PATH 时填完整路径） |

---

## 技术栈

| 层 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node 22 + TypeScript 7 | 依赖锁定精确版本 |
| 数据库 | SQLite（优先 `better-sqlite3`，回退内置 `node:sqlite`） | 单文件、WAL、热备份 |
| 服务 | Fastify 5 | 单体，无微服务 |
| 校验 | zod 4 | 前后端共用同一套 schema |
| 前端 | React 19 + Vite 8 | 无 UI 框架，手写 CSS |
| 测试 | Node 内置 `node --test` | 无额外测试框架 |

没有引入 ORM、状态管理库、消息队列、向量数据库或 SSR 框架。
