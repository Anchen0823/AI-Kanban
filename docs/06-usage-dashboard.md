# v0.3 历史用量与同步规则

## 数据来源

Codex 同步首先尝试本机 CLI 的 `account/usage/read`；官方累计与每日趋势分别采用返回值，缺失项回退本机日志。官方累计不与本机累计相加，也不由每日记录补算。官方会话估算明细完整且与累计核对一致时，输入、输出、缓存与模型采用官方明细，否则继续使用独立的本机明细。推理字段缺失保持未知，不按比例补齐。

官方查询要求 Codex CLI 使用 ChatGPT 登录；运行 `codex login` 并选择对应账号。未登录、不支持或超时均明确显示回退原因。官方失败时不恢复旧官方账户累计。Windows 自动查找原生 CLI，显式 `AICC_CODEX_COMMAND` 优先。

WorkBuddy、OpenCode、MiniMax Code 只读扫描本机保留的日志或数据库，不保证覆盖其他设备和已删除记录。DeepSeek 从用户选定的 ZIP/CSV 导出目录读取，缓存只保留聚合结果与脱敏同步信息。

## 快照、失败与覆盖

各来源分开保存最近有效快照和最近同步尝试。相同来源配置下，路径缺失、权限失败或数据库损坏不会覆盖有效快照；GET 返回旧数值和原成功时间，`sync.stale` 为 true，`lastAttempt` 记录失败。POST 的 `status` 仍描述本次尝试。明确成功的空扫描可以更新为空，未知不改成零。

本机配置变化后不能继承旧路径的快照。DeepSeek 目录是一次读取输入，失败的目录选择不会替换上次成功选择。Codex 仅保留可确认仍为本机口径的失败快照，不恢复旧官方账户累计。

`coverage` 逐字段区分 complete / partial / unknown；该标记描述保留数据集的字段覆盖，不证明整个账户历史完整。`detailCoverage` 描述分项使用的数据。旧缓存可读取，缺少覆盖证据则标 unknown。缓存与输入必须同时 complete 且符合子集关系才显示占比；异常不通过截断到 100% 隐藏。

## 交互与接口

打开窗口先读缓存，再启动一次同步，最多两个来源并行；刷新窗口及工作区切换不会再次启动。每个来源完成即更新，失败可单独重试。DeepSeek 手动读取，示例工作区不扫描真实数据。

`GET /api/history/dashboard` 在同一 SQLite 读取事务内返回 `total`、`local`、`imported`，只读缓存、禁止 HTTP 缓存、只允许用户会话。示例工作区的 `local` 为空。原有各来源 GET/POST 与 `/api/history/total` 继续兼容。

全部合计仅使用服务端标记 included 的来源。潜在重叠来源不重复计数，但通过来源卡片或「统计口径」的查看操作仍可独立查看。

7/30/90 天与全部只影响趋势图，KPI、模型与来源均为全部历史。缺失日期间保持实线连接，悬停显示没有记录，柱状图不补零，区间合计不加入插值。本机日期使用 UTC，官方和 DeepSeek 使用返回日期。

## 验证范围

`npm run verify:all` 验证统计、权限与服务；`npm run verify:desktop` 使用隔离合成数据验证真实窗口，不默认访问账户。真实账户可用性不能由 fixture 推断。具体来源格式见 [WorkBuddy](08-workbuddy-history.md)、[OpenCode](09-opencode-history.md)、[MiniMax Code](10-minimax-history.md)。
