# AI Kanban —— 项目长期记忆

## 这是什么

`AI Control Center`：个人 AI 用量与记忆工作台。本地单用户、单机运行、不替换任何现有 AI 客户端。
规格来源是仓库里的 `AI-Control-Center-Design-v0.1.md`（用户自己写的设计稿，逐字未改）。

**读代码前先读 `README.md` → `docs/00-m0-scope.md` → `docs/01-invariants.md`。**
不变量文档把 17 条规则映射到具体代码位置，是理解这个项目为什么这么写的最快路径。

## 项目约定（改动前必须知道）

- **范围纪律**：设计稿 §18 明确「第一阶段仅实现 M0」。不要顺手把 MCP、外部探测、
  ChatGPT 导出解析加进来。未实现的东西要在界面和文档里如实标注，不许含糊。
- **证据边界**：这个项目最在意的就是「我确认了」和「我推测」分开。
  文档里绝不写「已实现」除非真的跑通了。「官方文档说支持」必须显示为
  `documented` 而不是 `verified`（改状态的接口会在没给证据时直接拒绝）。
- **未知不填 0**：token 未知就是 `null`。这是全项目最硬的一条，改动任何统计代码前先想它。
- **不猜字段含义**：导入的未知列原样进 `raw_usage`，不按名字相似度塞进归一化列。
- **演示数据隔离**：demo 行 `is_demo = 1`，名称带「【示例】」，不计入任何真实统计。
- **零依赖偏好**：没有 ORM、状态管理库、测试框架、并行脚本库。
  加依赖前先问「自己写 40 行能不能解决」——`scripts/dev.mjs`、纯 TS SHA-256 都是这个原则的产物。

## 技术栈（已锁定精确版本）

Node ≥ 22.5（用内置 `node:sqlite`）/ TypeScript 7.0.2 / Fastify 5.12.5 / zod 4.6.5 /
React 19.3.0 / Vite 8.3.0 / Node 内置 `node:test`。npm workspaces：`packages/core` + `apps/server` + `apps/web`。

## 验证阶梯（改完必须按顺序跑）

```bash
npm run typecheck      # 与测试互补：tsc 抓到过测试没抓到的 as 优先级 bug
npm test               # core 72 + server 60
npm run build
npm run verify:smoke   # 真实 HTTP，会 spawn 服务进程
```

**不要只跑测试就认为没问题**：`tsx` 只剥类型不做类型检查，
且进程内 `inject` 会跳过真实 socket / Cookie / Host 头。三层都要跑。

## 环境坑（Windows）

- 工作目录的 `bash` 工具缺 coreutils（没有 `ls`/`grep`/`find`/`dirname`）。
  需要跑脚本时直接用 `node -e "..."` 或 PowerShell；文件搜索用 Grep/Glob 工具。
- PowerShell 工具回显有时被吞，需要「写入文件再读」。
- 同一文件的多处 Edit 不要放在同一条消息里并行发 —— 实测第二个会静默不落盘。

## 当前状态（2026-09-16）

M0 完成并全部验证通过。10 个提交在本地 `main`，**尚未建远端仓库**。
下一步由用户决定：M1（MCP 传输层 + Codex 只读探测）还是先自己用一段时间。
