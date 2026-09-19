# v0.2.0 — AI 历史用量工作台

- 新增全部 AI 累计 Token 面板，汇总 Codex 本机历史、DeepSeek 控制台导出及其他导入来源。
- 支持 Codex 现存与归档会话统计、DeepSeek ZIP/CSV 历史导入、按模型和日期查看。
- 精简前端提示，将同步按钮放入 Codex 卡片；日期最新优先，模型按版本及同版本档位降序。
- 新增 Codex 当前额度与 DeepSeek 官方余额查询。
- 加固工作区隔离、代理凭据边界、记忆校验和备份恢复验证，修正 Token 归一化与历史计数。

## 运行

使用 Node.js 22.5 或以上版本，下载源码后运行：

```sh
npm ci
npm run build
npm start
```

按启动终端提示打开本地页面并配对。详见 README 和 docs/06-usage-dashboard.md。

历史合计仅覆盖已保存或已导入的数据；额度查询依赖本机 Codex 登录，DeepSeek 余额查询需要用户自己的 API Key。源码发布不包含本地数据库、个人用量或凭据。
