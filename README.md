# AI Control Center

个人 AI 历史用量看板，v0.3。本地单用户，Windows 桌面版及本机网页版；数据保存在本机，不替换现有 AI 客户端。

## 使用

Windows 双击 `release/current/AI-Control-Center-0.3.0-x64.exe`。也可以运行 `release/current/win-unpacked/AI Control Center.exe`，分享此目录时保留全部文件。桌面版包含 Node 和生产依赖，自动配对，关闭窗口后停止服务。

源码需要 Node >=22.5，Windows CI 使用 Node 24：

```powershell
npm ci
npm run build
npm start
```

打开终端显示的本机地址（默认 http://127.0.0.1:8787），输入一次性配对码。开发模式使用 `npm run dev`；源码桌面版使用 `npm run desktop`。

## 同步与统计

- 打开窗口先显示缓存，再自动同步一次 Codex、WorkBuddy、OpenCode、MiniMax Code，最多两个来源并行。窗口内刷新、工作区切换不重复启动采集；顶部按钮可手动同步，各来源可单独重试。
- DeepSeek 在「数据源 → 读取历史导出」选择包含官方 ZIP/CSV 的绝对目录，按需读取。
- 来源卡片显示最近成功时间、同步状态和可展开的失败原因。读取失败时保留同一配置的旧统计并标为旧数据；成功扫描到空目录才更新为空。
- 来源环图与卡片的「查看」筛选全部图表；未计入总量的来源仍可独立查看。通用导入来源可在「统计口径」中查看。独立查看不改变全部来源的合计规则。
- 未知值显示「—」；缓存属于输入、推理属于输出，不能再次相加。缓存与输入覆盖不一致时不计算占比。旧缓存缺少覆盖证据时需要重新同步。
- Codex 优先采用官方累计及每日统计；只有完整核对的官方会话明细才替换本机分项。官方失败时回退本机，不恢复无法确认账户归属的旧官方累计。
- 7/30/90 天及全部仅影响趋势图，其他指标为全部历史。缺失日期用实线连接趋势，悬停仍显示「没有记录」，柱状图与区间合计不补零、不计插值。本机日志按 UTC，官方数据按返回日期。

首次未安装某客户端时，对应来源会显示读取失败或未发现记录；不影响其他来源。示例工作区只读，不触发真实同步。

## 数据与边界

桌面数据默认位于 `%APPDATA%/AI Control Center/data`，可从「应用 → 打开数据目录」查看。网页版默认 `data/`；`AICC_DATA_DIR` 可覆盖。迁移现有数据前先退出原服务，再指定该目录启动。

当前主界面仅提供用量统计。记忆、项目、MCP、通用导入及备份等旧后端接口仍保留，但主界面没有管理入口；历史设计文档不代表当前页面导航。数据导出与备份恢复工具入口列入 v0.4，真实 MCP 客户端联调和新来源扩展不属于 v0.3。

HTTP 服务只监听回环地址，配对会话与代理凭据分权，写请求校验来源及 CSRF。网页版会话过期后重新配对；桌面版按 Alt 显示菜单，选择「应用 → 重新启动」。历史缓存只保存聚合数字及脱敏状态，不保存聊天正文、凭据或源文件路径。

## 开发与验证

```powershell
npm run verify:all       # 构建、类型检查、全部测试、桌面后端、SQLite、真实 HTTP 冒烟
npm run verify:desktop   # 隔离合成数据，真实 Electron 交互与布局检查
npm run desktop:pack     # 生成 Windows x64 便携包
npm run verify:release   # 项目外验证解包目录及便携 EXE，生成 manifest.json
```

发布产物统一在 `release/current/`，验证报告和截图在 `tmp/`。发布清单包含版本、Git 提交、工作区是否未提交、源码指纹及 EXE SHA-256。测试通过不等于真实账户已经连接；默认桌面验证不会读取开发者账户。

目录：`packages/core` 共享纯逻辑与类型；`apps/server` Fastify + SQLite 与只读采集；`apps/web` React 单页；`apps/desktop` Electron；`apps/mcp` 保留的 stdio 服务。

常用配置：`AICC_PORT`、`AICC_DATA_DIR`、`AICC_CODEX_COMMAND`、`CODEX_HOME`、`WORKBUDDY_HOME`、`MINIMAX_HOME`、`OPENCODE_DB`。服务仅接受回环地址，数据、构建产物与凭据不提交 Git。

详细说明：[上手指南](docs/04-how-to-use.md)、[统计规则](docs/06-usage-dashboard.md)、[桌面版](docs/07-desktop.md)、[界面与验证](docs/10-aqua-observatory.md)。历史架构见 [原始设计](docs/AI-Control-Center-Design-v0.1.md)。
