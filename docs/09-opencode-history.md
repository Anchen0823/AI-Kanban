# OpenCode 历史用量

首页增加 OpenCode「同步」入口，保持原有简洁卡片样式。

## OpenCode

只读访问 `OPENCODE_DB` 指定的数据库；未设置时使用 `$XDG_DATA_HOME/opencode/opencode.db`，再回退到 `~/.local/share/opencode/opencode.db`。使用 SQLite 只读事务，读取 `message` 和 `part` 中的用量与必要元数据；不访问账号、凭据和聊天正文，不复制或改写源数据库。

优先按 `step-finish` 请求步骤累计；同一消息有步骤记录时不再加消息汇总，没有步骤记录才回退消息用量。只统计 assistant，排除未报告用量的全零占位。同一数据库行只计一次，每次同步替换脱敏汇总。现支持含 `message` / `part` 的本地数据库格式，不支持旧版散落 JSON 或未来不同的 v2 表结构；格式不符会报错，不能当作零。

OpenCode 的 `input` 是非缓存输入，`output` 不含单列推理：看板输入 = input + cache.read + cache.write；输出 = output + reasoning；总量 = 输入 + 输出。缓存读取、推理仍以子项显示，不再次加到总量。字段缺失、计数冲突和整数溢出不会静默填零。口径依据 [OpenCode Session.getUsage 源码](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts)，路径依据 [官方排错文档](https://opencode.ai/v2/docs/troubleshooting)。

## 接口与边界

- `GET /api/history/opencode`：读取汇总缓存；同路径 `POST`：同步。仅本地用户、真实工作区可调用，拒绝匿名、代理凭据和示例工作区。
- 专用历史存在时，标记为 OpenCode 的通用导入从总量排除。客户端通过自定义供应商 API 产生的用量仍可能与供应商账单重叠，尚不能跨来源逐请求去重。
- 仅本机现存记录；清理、删除、其他设备或未落盘的请求无法还原。

验证：`npm test`、`npm run typecheck`、`npm run build`。可选本机实测：PowerShell 设置 `$env:AICC_VERIFY_OPENCODE='1'`，运行 `npm run verify:desktop`；使用独立数据目录验证同步按钮、重复同步和汇总纳入状态。
