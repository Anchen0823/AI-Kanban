# AI Control Center — M0 实施设计

> 本文是 `AI-Control-Center-Design-v0.1.md` §18 要求的**开工产物**：目录结构、数据实体、
> 状态迁移、关键不变量与测试计划。它描述**已实现**的 M0 范围，以及明确**未实现**的部分。
>
> 范围口径：只做 M0。MCP、Codex 只读探测、ChatGPT 导出包解析、LiteLLM / Langfuse、远程
> 认证均不在本次实现内（见文末「未实现清单」）。

---

## 1. 目录结构

```text
AI Kanban/
├─ AI-Control-Center-Design-v0.1.md     原始设计稿（未改动）
├─ README.md                            怎么跑起来、怎么算账、不做什么
├─ docs/
│  ├─ 00-m0-scope.md                    本文
│  ├─ 01-invariants.md                  关键不变量（可执行断言的来源）
│  └─ 02-test-plan.md                   M0 验收测试计划与实测结果
├─ scripts/
│  ├─ verify-sqlite.mjs                 SQLite 驱动最小兼容性验证
│  ├─ smoke.mjs                         真实 HTTP 端到端冒烟（spawn 真实服务进程）
│  └─ dev.mjs                           并行启动 server + web（零额外依赖）
├─ packages/core/                       @aicc/core —— 无 I/O 的领域逻辑
│  ├─ src/enums.ts                      枚举：采集方式、质量、范围、类型、状态
│  ├─ src/ids.ts                        ID、稳定 JSON、内容指纹
│  ├─ src/sha256.ts                     纯 TS 的 SHA-256（使 core 可同构复用）
│  ├─ src/money.ts                      定点金额（字符串主单位 + 币种）
│  ├─ src/tokens.ts                     Token 归一化（含子集语义）
│  ├─ src/dedupe.ts                     幂等键与跨来源身份键
│  ├─ src/quota.ts                      额度快照新鲜度判定
│  ├─ src/memory.ts                     记忆生命周期与版本冲突
│  ├─ src/context.ts                    上下文包预算与清单
│  ├─ src/schemas.ts                    zod 请求/响应校验
│  └─ test/*.test.ts                    纯逻辑单测（72 项）
├─ apps/server/                         @aicc/server —— 本地单体服务
│  ├─ src/config.ts                     配置与「拒绝非回环绑定」
│  ├─ src/app.ts                        组合根：数据库生命周期 + 恢复备份
│  ├─ src/db/database.ts                SQLite 驱动适配、迁移、可重入事务
│  ├─ src/db/schema.ts                  建表与约束（迁移内联，构建后不需要拷资源）
│  ├─ src/db/repos/*.ts                 各实体仓储
│  ├─ src/services/*.ts                 用量、额度、记忆、上下文、备份、审计、demo
│  ├─ src/imports/*.ts                  CSV / JSON 解析与列映射 + 安全守卫
│  ├─ src/http/                         鉴权、错误结构、路由（含代理接口契约）
│  └─ test/*.test.ts                    验收测试（60 项）
└─ apps/web/                            @aicc/web —— React 工作台
   └─ src/pages/*.tsx                   概览 / 用量 / 记忆 / 项目 / 桥接 / 设置
```

技术栈按 §9.1 默认栈落地：React + Vite / Node + TypeScript + Fastify / SQLite / zod /
Node 内置测试运行器。**没有引入 LiteLLM、Langfuse、向量库、消息队列或 ORM。**

### 1.1 SQLite 驱动决策

§9.1 要求「先验证 Windows 安装、SQLite 驱动与 MCP 的最小兼容样例」。做法：

- `scripts/verify-sqlite.mjs` 在写业务代码之前跑一遍：打开库、建表、写入、事务回滚、
  唯一约束、`wal_checkpoint(TRUNCATE)`、热备份、关闭。任何一项失败即停下。
- 驱动优先 `better-sqlite3`；不可用时回退 Node 22 内置 `node:sqlite`（`DatabaseSync`）。
  两者都是同步 API，业务层通过 `driver.ts` 隔离，替换驱动不需要改服务代码。
- 实际结果记录在 `docs/02-test-plan.md`。

---

## 2. 数据实体

逻辑模型按 §10，物理上一张表对应一个实体。所有时间以 **UTC ISO-8601 字符串**保存，
展示层再转时区。所有金额以 **十进制定点整数的十进制字符串**保存（`"1999"` = ¥19.99），
避免浮点与 JS 大整数精度问题。

| 表 | 职责 | 关键约束 |
|---|---|---|
| `client` | 客户端与版本、MCP 档案、允许项目范围 | `allowed_projects` 为 JSON 数组，`null` 表示未限定 |
| `billing_account` | 账户别名与 provider；**不含登录 Cookie** | 无凭据字段，只有用户自填的 `account_ref` |
| `subscription` | 订阅、周期、币种、金额 | 金额字符串；周期用 `billing_cycle` |
| `subscription_client` | 订阅 ↔ 客户端多对多 | 复合主键 |
| `project` | 目标、状态、交接摘要 | |
| `session` | 项目/客户端/时间/源会话 ID/摘要 | `source_session_id` 只存 ID，不存全文 |
| `usage_observation` | 一条采集到的用量事实 | `dedupe_key` 唯一；`identity_key` 索引；`is_primary` 决定是否计入统计 |
| `charge` | 钱，不表达 token | 部分唯一索引防同一订阅同一周期重复记账 |
| `quota_snapshot` | 额度状态快照（不可累加） | 每次观测一行；新鲜度读取时计算 |
| `memory` | 正式记忆当前版本 | `(id, version)` 对应 `memory_revision` |
| `memory_revision` | 记忆历史版本 | `UNIQUE(memory_id, version)` |
| `memory_proposal` | 候选（create/update/archive） | `base_version` 参与冲突检测 |
| `source` | 来源类型、外部 ID、定位、指纹、保留策略 | |
| `import_job` | 导入批次、进度、错误行、指纹 | `file_fingerprint` 支持同文件重放幂等 |
| `integration` | 能力登记 | `capability_status` + `verified_at` + `evidence` |
| `context_export` | 上下文包与清单 | 记忆失效时可标 `invalidated_at` |
| `memory_tombstone` | 删除后的最小墓碑 | **只存哈希，不存正文** |
| `api_credential` | 客户端凭据与项目范围、scope | 只存 token 哈希；支持撤销 |
| `audit_event` | 谁、何时、对哪个 ID 做了什么 | 默认不记敏感全文 |

### 2.1 用量相关的三个层次（§5.1 的物理落点）

- **UsageEvent** → `usage_observation.kind = 'event'`。
- **UsageSummary** → `usage_observation.kind = 'summary'`，带 `period_start/period_end`。
- **QuotaSnapshot** → 独立表，**不是流水**，永不参与求和。
- **Charge** → 独立表，**只表达钱**。

统计口径由 `is_primary = 1` 选出唯一主统计源（§5.5「账户日汇总与事件明细选择其一作为
该覆盖范围的主统计源」）。

---

## 3. 状态迁移

### 3.1 记忆

```text
导入文本 / Agent 提案 / 人工输入
             ↓
        memory_proposal: pending
             ↓ 人工核对（approve / reject）
        approved ──→ memory: active（version = 1 或 base_version + 1）
        rejected ──→ 终态；不生成正式记忆
             ↓ 后续更新审批通过
   memory: active → superseded（旧版本进 memory_revision）
             ↓
        archived / expired
             ↓
        deleted（正文清除，留 memory_tombstone）
```

约束：

- 正式记忆**只能**由 `approve` 产生（§6.2）。没有「AI 自动激活」的入口。
- `update` 提案必须带 `base_version`；与当前版本不符 → 提案置 `conflict` 并返回差异，**不采用最后写入者获胜**（§6.4）。
- `expired` 不进普通上下文；仍可在历史视图检索。
- `deleted` 后 `memory_tombstone` 生效：再次导入命中墓碑必须重新确认（§10）。

### 3.2 提案

```text
pending ──approve──→ approved
   │
   ├──reject──→ rejected
   └──base_version 不符 / 缺 base_version──→ conflict（终态）
                                              需基于新版本重新提交一份提案
```

`conflict` 是终态，不是「待重试」。基线已经变了，这份提案里的差异必须重新对照，
不能「顺手修好」。用户要基于当前版本新建一份提案。

错误码细分到具体原因（`base_version_required` / `base_version_mismatch` / `target_missing`），
都返回 409 —— 让调用方知道「不是你参数写错了，是当前状态变了」。

### 3.3 导入批次

```text
precheck ──→ running ──→ completed
    │           │
    │           ├──→ failed（局部失败，已提交行保留）
    │           └──→ cancelled（保留已提交批次状态，重试幂等）
    └──→ rejected（超限、路径穿越、可执行内容）
```

### 3.4 客户端能力登记

`capability_status`：`documented` →（探测）`verified` / `unsupported` / `unknown`。
界面上「官方文档描述支持」与「本机已验证」必须视觉区分；未验证的能力**不显示为已同步**。

---

## 4. 关键不变量

完整可执行断言见 `docs/01-invariants.md`，代码内以 `INV-xx` 注释标记对应位置。

| 编号 | 不变量 |
|---|---|
| INV-01 | 未知数值存 `null`，**永不存 0** 来冒充「没有消耗」 |
| INV-02 | `cached_input ⊆ input_total`，`reasoning_output ⊆ output_total`；`total_reported = input_total + output_total`，子项不重复相加 |
| INV-03 | 额度快照不参与任何求和，也不与账户汇总、请求明细相加 |
| INV-04 | 统计只对 `is_primary = 1` 的 `usage_observation` 求和 |
| INV-05 | `dedupe_key` 唯一 → 同一批次的重复导入不产生新行 |
| INV-06 | 跨来源同一身份键只计一次，其余作为证据保留 |
| INV-07 | 累计计数回退按新窗口处理，**不产生负 token** |
| INV-08 | 不同币种不相加，无汇率则按币种分行展示 |
| INV-09 | 同一订阅周期内固定月费只记一次 |
| INV-10 | 正式记忆仅由 approve 产生，且写库与审计同事务 |
| INV-11 | 更新必须匹配 `base_version`，冲突返回 409 |
| INV-12 | 删除后留墓碑（仅哈希），重复导入触发重新确认 |
| INV-13 | 上下文构建先做权限过滤再检索 |
| INV-14 | 所有时间 UTC 存储 |
| INV-15 | 写入 API 校验会话凭据 + Origin/Host；凭据只存哈希 |
| INV-16 | demo 数据 `is_demo = 1`，可一键清空，界面持续可见标识 |
| INV-17 | 备份前必须 `wal_checkpoint(TRUNCATE)`，备份件带 schema 版本与校验和 |

---

## 5. 测试计划

见 `docs/02-test-plan.md`。M0 退出条件为设计稿 §16 列出的
`U01 / U02 / U03 / U06 / U07 / M01 / M02 / B01 / B03 / R01` 全部通过，
外加「成功 / 失败 / 重复输入」三类用例齐备。每个模块在测试通过后才继续。

**实测结果**：core 72/72、server 60/60、类型检查 0 错误、全量构建通过、
真实 HTTP 冒烟 24/24。B02（ChatGPT 导出包解析）与 MCP 联调不属于 M0，已在
`02-test-plan.md` 里标注为「不属于本阶段」而不是「通过」。

验收测试用的是进程内注入（Fastify `inject`），它会跳过真实 socket 与 Cookie 往返，
所以额外有一个 `npm run verify:smoke` 会**真的启动服务进程**再跑一遍关键路径。
这个脚本抓到了两个进程内测试没覆盖到的缺陷（空 JSON 请求体、事务不可重入）。

---

## 6. 未实现清单（诚实边界）

以下均为设计稿中**不属于 M0**、本次**没有实现**的内容。界面与文档都不得暗示它们已可用：

- **本地 MCP 服务**（§11.2 工具集）：M1。`api_credential` 表与 scope 校验已就位，但没有 MCP 传输层。
- **Codex / Cursor / WorkBuddy 只读接口探测**：M1。`integration` 表中相关记录保持 `unknown` / `documented`，不预填 `verified`。
- **ChatGPT 导出包（`conversations.json`）解析**：M2。M0 只支持用户自己粘贴文本。
- **内置 AI 提炼**：不属于 M0。用户可在现有客户端生成候选，再粘贴进收集箱。
- **LiteLLM / Langfuse / 向量检索 / 远程网关**：M3，且需要真实需求触发。
- **多用户与权限系统**：不做。本项目是本地单用户。

已知限制同样必须写在界面上：MCP 缺失时不能声称「已同步」；无稳定请求 ID 的跨文件疑似重复
会计入「待确认」而不是静默合并或静默丢弃。
