# 2026-09-19 审查、重构与 M1 接入改进

本轮在现有 M0/M1 功能上修复数据隔离与可靠性问题，并补齐 MCP 配置生成。
SQLite schema 仍为 v1，无数据迁移；未读取或修改仓库的个人 `data/` 数据，验收使用独立临时数据库。

## 已修复的问题

| 优先级 | 原有行为 | 修改后 | 回归验证 |
|---|---|---|---|
| P1 | 提案的项目范围可信任调用方自报，update/archive 目标可指向其他项目；候选详情可返回目标正文 | 先按目标实际项目授权，再校验项目、scope、工作区一致；审核队列和详情仅用户会话可读 | `apps/server/test/memory.test.ts` |
| P1 | 上下文历史、项目预览、会话摘要和账目等 GET 只要求已认证，代理 scope 未约束这些读取 | 工作台管理与历史读取要求用户会话；六个 MCP 工具继续使用各自 scope 与项目范围 | `apps/server/test/credential-boundary.test.ts`、原有 MCP 端到端测试 |
| P1 | 备份操作直接拼接名称与目录；缺失数据库哈希条目可能被当作完整性通过 | 名称只接受生成格式，目录必须为备份根的直接子目录；拒绝目录链接；清单必需字段、文件大小、哈希全部校验 | `apps/server/test/backup-validation.test.ts`、原有恢复测试 |
| P2 | JSON 清单损坏会让整个备份列表加载失败 | 单份备份显示 `manifest_invalid`，其他备份正常列出，禁止恢复无效项 | 同上 |
| P2 | 缺少输入或输出分量时，缺失部分被当成 0，形成不完整的“总量” | 两个分量齐全才相加；否则只保留供应商明确自报总量，无自报则保持未知；拒绝不安全整数 | `packages/core/test/tokens.test.ts` |
| P2 | 候选 dry-run 跳过实际创建前的验证，预检成功后可能全部导入失败 | 抽出无写入的 `prepareProposal`，预检与实际创建共用 | `apps/server/test/memory.test.ts` |
| P2 | 示例工作区的登记列表与 CSV 导出读取真实数据；部分写入会进入真实工作区 | 四类登记列表按 real/demo/all 筛选；导出携带工作区；前端统一阻断会修改真实数据的示例操作 | `apps/server/test/registry-workspace.test.ts`、`apps/web/test/api.test.ts` |

## 接入体验

- 新增「代理凭据 → 连接本地 MCP」：生成 Codex TOML 和 Cursor JSON，处理 Windows 空格、反斜杠、引号，使用当前 Node 与实际监听端口。
- 签发弹窗内填入刚签发的凭据；关闭后通用配置仍使用占位符，服务端未增加明文存储。
- 自检反映当前已实现的 Codex 探测，并检查 MCP 构建入口是否存在；不把文件存在或配置生成当作真实客户端联调成功。
- 根目录 `npm test` 纳入前端工作区隔离测试。

配置格式对照 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp) 和
[Cursor 官方 MCP 文档](https://cursor.com/docs/mcp)。操作步骤见 [上手指南 §6](./04-how-to-use.md#6-本地-mcp-接入)。

## 验证

环境：Windows / Node v24.20.0 / SQLite 驱动 `node:sqlite`。

| 命令 | 结果 |
|---|---|
| `npm test` | 195/195：core 76、server 93、MCP 22、web 4，无跳过 |
| `npm run typecheck` | 四个 workspace 通过 |
| `npm run build` | 四个 workspace 通过 |
| `npm run verify:sqlite` | 驱动、事务、WAL 与备份兼容检查通过 |
| `npm run verify:smoke` | 24/24，真实 HTTP 服务进程 |

浏览器在临时数据库中完成配对、配置预览、Codex/Cursor 切换、用户授权的最小权限测试凭据签发、
配置复制成功反馈，以及关闭弹窗后移除完整凭据。临时凭据仅绑定空白验收项目的 `memory_search`，未连接外部客户端。
最终前端构建还验证了示例项目列表、示例上下文包生成、示例视图写入拦截，
以及切回真实工作区后项目和上下文包列表保持隔离。

## 兼容性与剩余边界

- 原先用代理 Bearer 读取工作台管理/历史接口的脚本现在会收到 403。
  代理应调用六个 MCP 工具或相应的 `/api/agent/*`；用户浏览器流程保持可用。
- 由本程序正常生成的 v1 备份仍可恢复；改过名称、缺失清单字段、目录链接或内容不匹配的备份会被拒绝。
- 示例模式仍允许会话与示例数据控制、只读删除预览、生成带示例标记的上下文包；其他写操作需切回真实数据。
- 未在真实 Codex、Cursor 或 WorkBuddy 客户端完成挂载和联调。配置格式与本地协议测试不能替代该验收。
- Cursor 用量采集、ChatGPT 导出历史解析仍未实现；未把本轮改进标为 M1 全部完成或 M2 交付。
