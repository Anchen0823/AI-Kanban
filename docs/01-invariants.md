# 关键不变量

这些是本系统的「不能违反的事」。每一条都能在代码里指到具体位置，也都有对应的测试。
写在这里的原因不是文档完整性，而是：**它们每一条都对应一个「看起来正常但账是错的」的失败模式。**

| 编号 | 不变量 | 代码位置 | 测试 |
|---|---|---|---|
| INV-01 | 未知数值存 `null`，**永不存 0** 来冒充「没有消耗」 | `packages/core/src/tokens.ts` `readToken` / `normalizeOpenAiLike`；`usage_observation` 的 token 列全部可空 | `tokens.test.ts` U03；`usage.test.ts` U03 |
| INV-02 | `cached_input ⊆ input_total`，`reasoning_output ⊆ output_total`；`total_reported = input_total + output_total` | `packages/core/src/tokens.ts` `normalizeOpenAiLike` / `computeTotalFromParts` | `tokens.test.ts` U02；`usage.test.ts` U02 |
| INV-03 | 额度快照不参与任何求和，也不与账户汇总、请求明细相加 | `quota_snapshot` 独立表；`services/quota.ts` 只做状态判定 | `quota.test.ts`；`usage.test.ts` U07 |
| INV-04 | 统计只对 `is_primary = 1` 且未被标为待确认的记录求和 | `db/repos/usage.ts` `countedObservations` 的 `WHERE` | `usage.test.ts` U04；`dedupe.test.ts` |
| INV-05 | 同一批次（同文件 + 同内容 + 同行定位）重复导入不产生新行 | `computeDedupeKeys` 的 `batch\|file\|row\|fp` 结构 + `dedupe_key` 唯一索引 | `usage.test.ts` U01 |
| INV-06 | 跨来源同一身份键只计一次，其余作为证据保留 | `classifyDuplicate` → `evidence` 分支；`findPrimaryByIdentityKey` | `usage.test.ts` U04 |
| INV-07 | 累计计数回退按新窗口处理，**不产生负 token** | `applyCumulativeUpdate` 的 `reset` 分支 | `tokens.test.ts` |
| INV-08 | 不同币种不相加；无汇率则按币种分行展示 | `money.ts` `assertSameCurrency` / `sumByCurrency` | `money.test.ts` |
| INV-09 | 同一订阅、同一周期内固定月费只记一次 | `charge` 上的部分唯一索引 `ux_charge_subscription_period` + `insertCharge` 的顺序检查 | `usage.test.ts` U06 |
| INV-10 | 正式记忆仅由 approve 产生，写库与审计同事务 | `services/memory.ts` `reviewProposal`；仓储层不提供「直接插入 active 记忆」的接口 | `memory.test.ts` M01 |
| INV-11 | 更新必须匹配 `base_version`，冲突返回 409 且不静默合并 | `checkBaseVersion` + `reviewProposal` 的冲突落库分支 | `memory.test.ts` M02 |
| INV-12 | 删除后留墓碑（**仅哈希**），重复导入触发重新确认 | `memory_tombstone` 表 + `deleteMemoryPermanently` + `reviewProposal` 的墓碑检查 | `memory.test.ts` M05 |
| INV-13 | 上下文构建**先权限过滤再检索** | `selectContextItems` 的过滤顺序；`buildContext` 先解析授权范围 | `context.test.ts`；`reliability.test.ts` M03 |
| INV-14 | 所有时间以 UTC 存储，展示时再转时区 | `nowIso()` 只产出 UTC ISO-8601 | 全部时间相关用例 |
| INV-15 | 写 API 校验会话凭据 + Origin/Host + CSRF 头；凭据只存哈希 | `http/server.ts` 的 `onRequest` / `requireUser` / `requireScope` | `reliability.test.ts` R03 |
| INV-13/M1 | MCP 是**纯代理**：权限判断只在服务端一处，传输层不复刻 | `apps/mcp/src/backend.ts` 不持有任何仓储；`tools.ts` 只做参数映射 | `mcp-e2e.test.ts` M03 路径 |
| INV-15/M1 | Bearer 凭据调用**同样必须**带 CSRF 头，不为内部进程开口子 | `apps/mcp/src/backend.ts` 的 headers | `mcp/protocol.test.ts` 403 原样传导 |
| INV-16 | demo 数据独立工作区：真实视图一行不出现，示例视图能看到全部且不含真实数据，可一键清空，界面持续可见标识 | `db/repos/workspace.ts` 的三态范围 + `countDemoRows` / `purgeDemoData`；前端顶栏切换 | `database.test.ts` 双向隔离用例 |
| INV-17 | 备份前必须 `wal_checkpoint(TRUNCATE)`，备份件带 schema 版本与校验和 | `DbConnection.backupTo`；`createBackup` 写 manifest | `reliability.test.ts` R01 |

---

## 发现过的真实缺陷

前三条是自动化测试抓到的，第四条和第五条不是 —— 各自说明了「测试为什么没抓到」，
因为它们都属于「写的时候看起来完全没问题」：

M1 阶段又抓到四条（传输层双分发、CSRF 头、`id: 0`、float 尾巴），
记录在 [`03-m1-scope.md`](./03-m1-scope.md) §8。

### 1. `dedupeKey` 与 `identityKey` 曾经是同一个值

最初的设计是：有稳定请求 ID 时，两个键都用 `req|account|rid|meter`。

后果：同一个请求被网关和客户端日志分别采集之后，**第二条因为「去重键重复」被当成重放直接跳过**，
证据行根本没有落库。表面上 U04 的「只计一次」满足了，实际上「保留多来源证据」这条丢了 ——
而丢掉的恰恰是「这个数字有几个来源支撑」这个信息。

修复：两个键的职责彻底分开。`dedupeKey` 永远带「批次 + 行定位 + 内容」，
只管「这一行走过没有」；`identityKey` 管「这是不是同一个请求」。

### 2. `lcs[i+1][j] as number >= lcs[i][j+1] as number`

TS 里 `as` 的优先级会把 `number >= ...` 整个吃掉，表达式变成 `x as (number >= y)`。
剥掉类型后只剩 `if (x)` —— 一个真值判断。

它**碰巧**在多数输入下给出正确答案，所以单测没抓到（当时的用例两种写法结果一致）。
是 `tsc` 的 TS2352 把它揪出来的。这也是为什么这个项目坚持 `npm run typecheck` 必须与测试一起跑。

### 3. `tx()` 不可重入

SQLite 的 `BEGIN` 不能嵌套，而服务层天然会出现嵌套调用：
「生成示例数据」在自己事务里调用「创建候选」，后者也要保证原子性。

结果：`cannot start a transaction within a transaction`，而且**只在同时走这两条路径时出现** ——
单独测每个服务全绿。这个问题是真实 HTTP 冒烟验证发现的，进程内 `inject` 的测试第一次也没覆盖到。

修复：用连接级的深度计数让 `tx()` 可重入，嵌套调用加入外层事务。内层失败连带回滚整个外层。

### 4. 「demo 隔离」被实现成了「demo 隐身」

设计稿 §8 写的是「演示数据使用**单独的 demo workspace** 和持续可见的标识，
**不能污染真实总览**」——这是两件事。

实现只做了「不污染」：所有视图都排除 `is_demo = 1`。于是用户点了「生成示例数据」，
界面上依然一片空白，示例数据等于白生成。而**全部验收测试都是绿的** ——
因为它们断言的正是「示例数据不出现在真实统计里」。

修复：三态工作区范围（`real` / `demo` / `all`），前端顶栏切换，
API 客户端统一给所有读取带上参数，杜绝「概览是示例、明细是真实」的混搭。

这条不属于「代码写错了」，而属于「把文档里的一句话读漏了半句」——
也是唯一一条靠**自己把应用跑一遍**才发现的。

### 5. 端口被占时只给 `EADDRINUSE` 堆栈

这条是**用户实际使用时报出来的**，不是测试发现的 —— 四条自动化验证路径全都没有覆盖它。

原来的启动顺序是「开数据库 → 跑迁移 → 监听」。端口被占时，用户先白等一轮迁移，
再看到一段 `listen EADDRINUSE` 堆栈，堆栈里没有任何一句告诉他该怎么办。
而本地单用户场景下这个错误的成因几乎永远是同一个：上一个实例还在跑，
用户以为关掉终端窗口就等于结束了进程（在 Windows 上尤其常见）。

修复分两处，都是「少让用户自己推理」：

- 把端口探测提到开库之前（`apps/server/src/net/port.ts`），失败得早，且不碰数据库。
- 识别出这个错误后打印分步骤的排查指引：查占用进程的命令、结束进程的命令、
  以及换端口启动的办法（`AICC_PORT`）。按平台给出实际可复制粘贴的命令。
- 顺带补上：启动过程中的任何失败都会关闭已打开的数据库，不再在磁盘上留一个 WAL 文件
  掩盖真实原因。

刻意**不做**自动换端口重试：配对码与 Origin 白名单都绑定在配置端口上，
静默换端口只会让用户打开一个错误的地址。宁可响亮地失败。

`apps/server/test/startup.test.ts` 覆盖了「空闲放行 / 被占抛出 / 提示可执行 /
探测不把自己变成占用者」四个方向。

---

## 还有两条不算「不变量」但同样要坚持的约定

**不猜字段含义。** 导入时未识别的列原样进 `raw_usage`，不按名字相似度塞进某个归一化列。
猜错一条用量记录的代价，比让用户手动映射一次大得多。

**不把「官方文档说支持」显示成「已同步」。** 能力状态分四级
（`documented` / `verified` / `unsupported` / `unknown`），
且把状态改成 `verified` 时**必须同时给出证据**，否则接口直接拒绝。
