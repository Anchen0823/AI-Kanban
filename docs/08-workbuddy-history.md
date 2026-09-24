# WorkBuddy 历史用量

在首页「历史用量」点击「同步 WorkBuddy」，即可读取本机 `~/.workbuddy/projects/**/*.jsonl`。非默认目录可通过服务端环境变量 `WORKBUDDY_HOME` 指定。无需 API Key，也不需要配置 MCP。

显示累计 Token、输入、输出、缓存输入、推理输出、会话数，以及模型与日期（UTC）明细。同步完成会刷新「全部 AI 累计 Token」。每次重新扫描并替换汇总，重复同步不会追加重复数据。

读取 WorkBuddy `message.usage` 中的逐请求数字，以 `providerData.messageId`（缺失时回退日志 `id`）去重；同一 trace 可以包含多个请求，不以 trace 去重。同一消息的冲突用量会排除并提示。缓存输入是输入的子项、推理输出是输出的子项，不再次加入总 Token。缺失分项显示未知或已知部分，不填零。当前适配的是本机已验证的 WorkBuddy 项目 JSONL 格式，未来格式变化可能需要更新适配器。

仅统计本机尚保留且带用量的记录，不代表账号全部历史或计费账单。无法读取、损坏、字段缺失、扫描上限等诊断保留在接口汇总中。聊天正文、工具参数、项目路径和凭据不会进入汇总缓存。

WorkBuddy 是客户端来源；即使使用 DeepSeek 模型，也不会自动归到 DeepSeek 官方 API 账单。若通过自定义 API 在 WorkBuddy 中使用同一供应商账号，其日志可能与另行导入的供应商账单重叠，当前不能跨平台逐请求去重。明确标为 WorkBuddy / CodeBuddy 的通用导入，在已有专用历史时会从总数排除。

接口为 `GET /api/history/workbuddy`（读取缓存）和 `POST /api/history/workbuddy`（同步），仅真实工作区的本地用户会话可调用。示例工作区和代理凭据不能扫描。

可选的本机端到端验证：在 PowerShell 设置 `$env:AICC_VERIFY_WORKBUDDY='1'` 后运行 `npm run verify:desktop`；使用独立测试数据库，点击同步两次并检查总览一致性，不修改 WorkBuddy 数据。
