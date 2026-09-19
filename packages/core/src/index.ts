/**
 * @aicc/core —— 领域模型与纯逻辑。
 *
 * 这一层**不做任何 I/O**：不读文件、不连数据库、不发请求。它只回答「什么是合法的」
 * 和「两个数该怎么合并」。所有副作用都在 apps/server。
 *
 * 这样拆的好处不只是测试方便：前端可以直接引用同一套枚举与预算规则，
 * 于是「界面显示的口径」和「服务端计算的口径」不可能悄悄漂移。
 */

export * from './enums.js';
export * from './ids.js';
export * from './sha256.js';
export * from './money.js';
export * from './tokens.js';
export * from './dedupe.js';
export * from './quota.js';
export * from './memory.js';
export * from './context.js';
export * from './schemas.js';
export * from './mcp-config.js';
