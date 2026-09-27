# MiniMax Code 本机历史

首页「同步 MiniMax Code」读取 `%USERPROFILE%/.minimax/v2/sessions/YYYY/MM/DD/<session>/messages.jsonl`。可在启动服务前通过 `MINIMAX_HOME` 指定 MiniMax 数据根目录；安装程序目录不是历史数据目录。

仅读取当前会话的标准消息文件，不扫描 snapshots、display、ledger、数据库投影或迁移备份。按 `message_id` 去重，同一 `turn_id` 下多次模型调用分别统计。相同消息的用量、模型或时间冲突会排除并提示。重复同步重新计算并替换脱敏汇总缓存，不追加累计。

MiniMax 当前 Pi 格式的 `usage.input` 不含 `cacheRead`、`cacheWrite`，因此输入为三者之和；总 Token 为该输入加 `output`，并与 `totalTokens` 核对。缓存读取量展示为输入子项，不再次加入总计。没有独立推理计数时显示未知，不根据思考文本估算。缺失、损坏、溢出及扫描限额会提示；未找到记录显示未知。

仅持久化总量、模型/UTC 日期分布、会话数及统计范围，不保存对话正文、工具参数、API Key、消息 ID 或绝对历史路径；不会调用模型或修改 MiniMax 文件。

## 与 API 和其他客户端的重叠

没有潜在重叠来源时，MiniMax Code 已知用量纳入总面板。若已导入供应商或模型标记为 MiniMax 的记录、存在未分类导入，或其他已同步客户端记录了 MiniMax 模型，则 MiniMax Code 卡片仍显示，来源列表说明它未纳入总计。这个保守规则可能少计非重叠部分，但不声称已做跨账户、跨时段的逐请求精确去重。自定义模型别名及未知来源仍无法可靠识别，需要后续账户/请求关联。

当前仅覆盖本机保留的 v2 会话历史，不是 MiniMax 官方全账户账单，也不包含已经删除或其他设备上的会话。客户端升级改变格式时可能需要更新适配器。

## 验证

`apps/server/test/minimax-history.test.ts` 覆盖缓存口径、重复消息、多调用同轮次、冲突、损坏行、快照排除、只读与隐私、认证/工作区隔离及跨来源排除。

Windows 可设置 `AICC_VERIFY_MINIMAX=1` 后运行 `npm run verify:desktop`，验证真实窗口同步、重复同步一致和汇总纳入，并保存截图到 `tmp/desktop-verification/minimax.png`。该检查要求本机已有有效 MiniMax 会话，验证期间保持 MiniMax 会话闲置。
