/**
 * MCP 协议的线格式与版本协商。
 *
 * 刻意只依赖 MCP 规范里**稳定**的那一小层：JSON-RPC 2.0 信封、
 * `initialize` / `tools/list` / `tools/call` / `ping` 四个方法。
 * 消息按行分隔（stdio 传输就是「一行一个 JSON-RPC 消息」），不做长度前缀。
 *
 * 不引入官方 SDK 的原因不是「省一个依赖」，而是：这个进程的全部职责就是
 * 「把 JSON-RPC 翻译成对本机 HTTP API 的调用」。用自己的 200 行把这段写清楚，
 * 比让一层外部 SDK 决定「错误该怎么呈现」更容易保证 §11.2 那条要求 ——
 * **失败不能返回类似成功的安慰文案**。
 */

/** 本服务支持并能正确处理的协议版本，从新到旧。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** 没有可协商的共同版本时使用的版本。 */
export const LATEST_PROTOCOL_VERSION = '2025-06-18';

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/**
 * 版本协商。
 *
 * 规范要求服务端在无法满足客户端要求的版本时，返回**自己支持的**版本，
 * 由客户端决定是否继续。所以这里不回错误，只回一个明确的值 ——
 * 客户端能读到 `protocolVersion` 自己判断，比收到一个含糊的失败更可处理。
 */
export function negotiateProtocolVersion(requested: unknown): ProtocolVersion {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested as ProtocolVersion;
  }
  return LATEST_PROTOCOL_VERSION;
}

/* ------------------------------------------------------------------ */
/* JSON-RPC 2.0 信封                                                   */
/* ------------------------------------------------------------------ */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** JSON-RPC 2.0 保留错误码。 */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 是不是一个「请求」（需要回响应）。
 *
 * 判定按 JSON-RPC 2.0 的定义：`id` 存在即为请求。注意 `id: 0` 和 `id: 0.0`
 * 都是合法 id，不能用 `if (msg.id)` 判断 —— 那会把 `id: 0` 的请求当成通知丢掉，
 * 客户端会一直等一个永远不来的响应。
 */
export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return (
    isObject(message) &&
    message.jsonrpc === '2.0' &&
    typeof message.method === 'string' &&
    'id' in message &&
    (typeof message.id === 'string' || typeof message.id === 'number' || message.id === null)
  );
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return isObject(message) && message.jsonrpc === '2.0' && typeof message.method === 'string' && !('id' in message);
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return data === undefined ? { jsonrpc: '2.0', id, error: { code, message } } : { jsonrpc: '2.0', id, error: { code, message, data } };
}

/** 一行一个消息。输出时补换行，输入时按换行切分。 */
export function encodeMessage(message: JsonRpcResponse | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}
