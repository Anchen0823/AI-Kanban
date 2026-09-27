# Aqua 用量控制台

应用仅展示用量统计。用量明细、数据设置及此前的记忆、收费、额度页面不再加载到前端。

## 展示与操作

- KPI：累计 Token、已知输入、已知输出、已知缓存输入占比。空间足够时显示完整整数，仅在容器不足时自动缩写为 K / M / B；悬停始终显示完整值。
- 用量趋势：7 / 30 / 90 天及全部记录，支持曲线和柱状图；悬停显示日期及数值。
- 来源占比：全部历史来源占比，点击图例联动 KPI、趋势、模型与热力图，再次点击恢复全部。
- 模型排行：前 8 名横向条形图，切换表格查看全部模型。
- Token 构成：输入 / 输出及其缓存 / 推理子集，不重复相加。
- 活动热力图：截至最新记录日期的 91 个日历日；浅灰表示没有记录，非零用量日期另计。
- 数据源：本机用量同步与 DeepSeek 导出读取；统计口径展开区保留来源排除和范围提示。

时间范围仅影响趋势图；KPI、模型和来源分布均明确展示全部历史。日期空缺保留未知，曲线不跨空缺连线。来源合计遵循 `/api/history/total` 的 `included` 规则，可能重叠的来源只有被单独选择时才展示。总量与分项可能因缺失字段或未知日期而不完全一致。安全整数溢出不显示舍入后的数字。

本机记录按 UTC 日期聚合，DeepSeek 使用导出日期，跨来源日边界可能不同。刷新读取已缓存统计；同步本机用量重新扫描本机文件。示例工作区不读取真实本机历史，且禁用同步。

## 视觉参考

参考 [Uiverse 玻璃卡片](https://uiverse.io/ui/glassmorphism-cards)、[按钮交互](https://uiverse.io/ui/animated-buttons) 与 [Attio Reporting](https://attio.com/platform/reporting) 的方向，结合用户指定的 visionOS / Liquid Glass、Linear、Axiom、Arc 风格。组件与 CSS 自行实现，无外部 CDN 或字体依赖。

玻璃与光晕集中在导航、KPI、控件和背景；图表与表格采用接近不透明的底色。支持系统减少动效偏好和手动动效开关。窄屏图表可在面板内横向滚动，避免文字缩小到不可读。

## 验证

`npm run build`、`npm test`、`npm run test:desktop`；`npm run verify:desktop` 使用隔离数据目录和合成 API 样例，检查图表联动、数值、来源排除、DeepSeek 同步、示例隔离、390 / 1000px 布局与渲染异常。`node scripts/verify-desktop.mjs <exe-path>` 验证便携包。截图保存在 `tmp/desktop-verification/aqua-*.png`，其中填充数字来自验证样例，不是用户用量。
