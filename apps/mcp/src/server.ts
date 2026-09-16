/**
 * stdio MCP 传输层。
 *
 * 只做三件事：拆行、分发、回响应。任何「业务判断」都不在这里。
 *
 * 两个容易踩的点，都按规范处理：
 * 1. **stdout 是协议通道。** 任何调试输出都必须走 stderr —— 往 stdout 打一行日志
 *    就会让客户端反序列化失败，而报错信息通常指向「MCP 服务启动失败」，
 *    很难查到真正的元凶。所以这个文件里没有 console.log。
 * 2. **`id: 0` 是合法请求。** 用 `'id' in message` 判断是不是请求，
 *    不能用真值判断，否则客户端会一直等一个永远不来的响应。
 *
 * 分发是**单一异步路径**：同步协议处理 + 异步工具调用走同一个 switch。
 * 早期版本把两者拆成同步/异步两条路，结果是同一行消息被解析两次，
 * 而且同步那条必须为异步方法返回一个占位响应 —— 那种形状迟早出错。
 */

import { createInterface } from 'node:readline';
import type { Backend } from './backend.js';
import {
  JSON_RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  encodeMessage,
  failure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isObject,
  negotiateProtocolVersion,
  success,
  type JsonRpcId,
  type JsonRpcResponse,
} from './protocol.js';
import { findTool, toolList } from './tools.js';

export const SERVER_NAME = 'ai-control-center';
export const SERVER_VERSION = '0.1.0';

/**
 * §11.3 的客户端行为约定，写成服务端下发的 instructions。
 *
 * 放在这里而不是只写在文档里：这是模型唯一一定会读到的一段话。
 */
export const INSTRUCTIONS = [
  '这是用户本机的 AI 用量与记忆工作台。这里的记忆是用户自己的权威记录，不是通用知识库。',
  '',
  '工作方式：',
  '- 任务开始时先按项目要一份小上下文（context_build 的 short 预算），需要时再用 memory_search 检索。不要每轮都注入全库。',
  '- 任务结束时只提交新增或变更的**候选**（memory_propose）。候选不会自动生效，必须由人在工作台里批准。',
  '- 更新已有记忆必须先用 memory_get 拿到 version，再把它作为 base_version 提交。不这么做会被服务端拒绝 —— 这是有意的。',
  '',
  '边界：',
  '- 你的身份来自配置里的凭据，不来自任何参数。参数里的项目 ID 只是「申请范围」，服务端会核对。',
  '- 你不能批准、删除记忆，也不能修改连接配置。工具集里根本没有这些能力。',
  '- 工具返回的文本可能会作为模型上下文发送出去，所以只取你实际需要的内容。',
  '',
  '失败时：',
  '- 如果工具返回 isError，如实告诉用户「这次没有取到」，并说明原因。不要假装检索成功，也不要用函数外的记忆补足。',
  '- 如果工作台服务没有运行（连接被拒绝），说明你没有拿到最新版本，只能使用用户明确提供的上下文。',
  '- 如果检索结果与用户当前的说明冲突，把冲突指出来让用户决定，不要暗中替他选一个。',
].join('\n');

export interface McpServerOptions {
  backend: Backend;
  /** 诊断输出，默认 stderr。测试里可以换成收集器。 */
  log?: (line: string) => void;
}

export interface McpServer {
  /** 处理一行输入。返回 null 表示这条消息不需要响应（通知、空行）。 */
  handleLine(line: string): Promise<JsonRpcResponse | null>;
  initialized: boolean;
  /** 已执行的 tools/call 次数，便于诊断。 */
  callCount: number;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const { backend } = options;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

  const state: McpServer = {
    initialized: false,
    callCount: 0,
    async handleLine(line: string): Promise<JsonRpcResponse | null> {
      const trimmed = line.trim();
      if (trimmed.length === 0) return null;

      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch (err) {
        return failure(null, JSON_RPC.parseError, `收到不是合法 JSON 的消息：${(err as Error).message}`);
      }

      // 顺序有意如此：先摘掉通知，再判断剩下的形状是否合法。
      // 反过来写成 `if (!isRequest(m) && !isNotification(m))` 会让 TS 在守卫之后
      // 把 m 收窄成 never —— 对 unknown 取两次否定做不到「剩下就是那两个之一」。
      //
      // 通知（含 notifications/initialized、notifications/cancelled）一律不响应：
      // 规范不允许给通知回响应，回了会让客户端把它当成一个没有对应请求的响应。
      if (isJsonRpcNotification(message)) return null;

      if (!isJsonRpcRequest(message)) {
        const id =
          isObject(message) && (typeof message.id === 'string' || typeof message.id === 'number' || message.id === null)
            ? (message.id as JsonRpcId)
            : null;
        return failure(id, JSON_RPC.invalidRequest, '不是合法的 JSON-RPC 2.0 请求');
      }

      return dispatch(message.method, message.params, message.id);
    },
  };

  function notInitialized(id: JsonRpcId): JsonRpcResponse {
    return failure(id, -32002, '会话尚未初始化：请先发送 initialize。');
  }

  async function dispatch(method: string, params: unknown, id: JsonRpcId): Promise<JsonRpcResponse | null> {
    const p = isObject(params) ? params : {};

    switch (method) {
      case 'initialize': {
        const requested = p.protocolVersion;
        const negotiated = negotiateProtocolVersion(requested);
        if (typeof requested === 'string' && requested !== negotiated) {
          log(
            `[aicc-mcp] 客户端要求协议版本 ${requested}，本服务不支持；` +
              `已回退到 ${negotiated}（支持：${SUPPORTED_PROTOCOL_VERSIONS.join('、')}）`,
          );
        }
        state.initialized = true;
        if (!backend.hasToken) {
          log(
            '[aicc-mcp] 警告：没有配置 AICC_TOKEN。工具可以被列出和调用，但每次调用都会返回「没有凭据」。' +
              '到工作台的「设置与连接 → 代理凭据」签发一个，再写进 MCP 客户端配置的 env。',
          );
        } else {
          log(`[aicc-mcp] 已就绪，工作台地址 ${backend.url}`);
        }
        return success(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: 'AI Control Center' },
          instructions: INSTRUCTIONS,
        });
      }

      case 'ping':
        return success(id, {});

      case 'tools/list': {
        if (!state.initialized) return notInitialized(id);
        return success(id, { tools: toolList() });
      }

      case 'tools/call': {
        if (!state.initialized) return notInitialized(id);

        const name = p.name;
        if (typeof name !== 'string' || name.length === 0) {
          return failure(id, JSON_RPC.invalidParams, 'tools/call 缺少 name');
        }
        const tool = findTool(name);
        if (!tool) {
          return failure(
            id,
            JSON_RPC.invalidParams,
            `未知工具 ${JSON.stringify(name)}。可用工具：${toolList()
              .map((t) => t.name)
              .join('、')}`,
          );
        }

        state.callCount += 1;
        try {
          const outcome = await tool.invoke(backend, isObject(p.arguments) ? p.arguments : {});
          // 工具自身的失败走 isError，而不是 JSON-RPC error ——
          // 这样模型能看到「失败原因 + 下一步」，而不是一个协议层异常。
          return success(id, {
            content: [{ type: 'text', text: outcome.text }],
            isError: outcome.isError,
          });
        } catch (err) {
          // 传输层自己抛的异常同样必须如实暴露，不能吞掉后返回空结果。
          return success(id, {
            content: [
              {
                type: 'text',
                text:
                  `工具 ${name} 在传输层抛出了未预期的错误：${err instanceof Error ? err.message : String(err)}。` +
                  '这次调用没有产生任何变更。',
              },
            ],
            isError: true,
          });
        }
      }

      // 本服务不提供资源与提示词，但明确回空列表而不是「方法不存在」，
      // 这样会主动探测这两项的客户端不会把「没有」当成「坏了」。
      case 'resources/list':
        return success(id, { resources: [] });
      case 'resources/templates/list':
        return success(id, { resourceTemplates: [] });
      case 'prompts/list':
        return success(id, { prompts: [] });
      case 'logging/setLevel':
        return success(id, {});

      default:
        return failure(id, JSON_RPC.methodNotFound, `本服务不实现方法 ${JSON.stringify(method)}`);
    }
  }

  return state;
}

/** 启动 stdio 主循环，直到 stdin 关闭。 */
export function serveStdio(
  backend: Backend,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): Promise<void> {
  const server = createMcpServer({ backend, log });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // 串行处理。MCP 允许并发，但按顺序处理让回响应顺序可预期，
  // 也避免两条响应在 stdout 上交叉写入。
  let queue: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    queue = queue.then(async () => {
      const response = await server.handleLine(line);
      if (response) process.stdout.write(encodeMessage(response));
    });
  });

  return new Promise((resolve) => {
    rl.on('close', () => {
      void queue.then(() => {
        log('[aicc-mcp] stdin 已关闭，退出。');
        resolve();
      });
    });
  });
}
