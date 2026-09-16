/**
 * §11.2 的六个 MCP 工具。
 *
 * 每个工具就是一个「MCP 参数 → 服务端请求体」的显式映射，没有别的逻辑。
 * 所有判断（权限、版本冲突、墓碑、预算）都留在服务端 —— 传输层多做一点判断，
 * 就多一处两套口径不一致的机会。
 *
 * 与 §11.2 签名的一处**有意偏离**：规范里写的
 * `memory_propose(operation, project_id, content, sources?, base_version?)`
 * 缺了服务端必需的 `kind` 与 `title`。这里把它们提为必填，而不是替模型猜一个 ——
 * 「AI 自动归纳出标题和类型」正是 §6.2 要挡掉的东西。
 */

import type { Backend, BackendResult } from './backend.js';

export interface ToolOutcome {
  /** 给模型看的文本。结构化对象序列化成 JSON，模型和人都能读。 */
  text: string;
  isError: boolean;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  invoke(backend: Backend, args: Record<string, unknown>): Promise<ToolOutcome>;
}

const str = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'string',
  description,
  ...extra,
});

const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({
  anyOf: [schema, { type: 'null' }],
});

/**
 * 把后端结果折成工具回执。
 *
 * §11.2：「失败不能返回类似成功的安慰文案」。所以失败分支里
 * **绝不包含** 「已保存」「稍后可见」这类词，只有事实 + 下一步动作。
 */
function present<T>(result: BackendResult<T>, failureLabel: string): ToolOutcome {
  if (result.ok) {
    return { text: JSON.stringify(result.data, null, 2), isError: false };
  }

  const parts = [`${failureLabel}（${result.code}${result.status > 0 ? ` / HTTP ${result.status}` : ''}）`, result.message];
  if (result.details !== undefined) {
    parts.push(`细节：${typeof result.details === 'string' ? result.details : JSON.stringify(result.details)}`);
  }
  if (result.hint) parts.push(`下一步：${result.hint}`);
  parts.push('这次调用没有产生任何变更。不要向用户描述为已完成。');

  return { text: parts.join('\n'), isError: true };
}

function asRecord(args: unknown): Record<string, unknown> {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'memory_search',
    title: '检索记忆',
    description:
      '在当前凭据授权的项目范围内检索已批准生效的记忆。只返回 active 记录；过期与已被替代的内容不会出现在这里。' +
      '返回的文本可能作为模型上下文被发送到你所在的模型服务。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('检索词。留空表示按时间倒序返回该范围内最近的记忆。', { default: '' }),
        project_id: nullable(str('限定项目。凭据被限定了项目范围时必填，服务端不会替你选一个。')),
        kind: nullable({
          type: 'string',
          enum: ['preference', 'fact', 'decision', 'lesson', 'hypothesis', 'handoff'],
          description: '按记忆类型过滤。',
        }),
        limit: { type: 'integer', description: '最多返回多少条。', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    invoke: async (backend, raw) => {
      const args = asRecord(raw);
      return present(
        await backend.call('/api/agent/memory_search', {
          method: 'POST',
          body: {
            query: typeof args.query === 'string' ? args.query : '',
            project_id: typeof args.project_id === 'string' ? args.project_id : null,
            kind: typeof args.kind === 'string' ? args.kind : null,
            limit: typeof args.limit === 'number' ? args.limit : 10,
          },
        }),
        '检索没有执行',
      );
    },
  },

  {
    name: 'memory_get',
    title: '读取单条记忆',
    description:
      '按 memory_id 读取一条正式记忆的当前版本。读取同样会做项目授权校验 —— 不知道 ID 不构成安全控制。' +
      '需要更新它时，把返回的 version 当作 memory_propose 的 base_version。',
    inputSchema: {
      type: 'object',
      properties: { memory_id: str('记忆 ID，形如 mem_xxx。只能来自用户明确提供或上一次检索的结果。') },
      required: ['memory_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    invoke: async (backend, raw) => {
      const args = asRecord(raw);
      if (typeof args.memory_id !== 'string' || args.memory_id.length === 0) {
        return { text: 'memory_get 缺少 memory_id。这个 ID 必须来自用户明确提供或检索结果，不能编造。', isError: true };
      }
      return present(await backend.call('/api/agent/memory_get', { method: 'POST', body: { memory_id: args.memory_id } }), '读取没有执行');
    },
  },

  {
    name: 'context_build',
    title: '生成项目上下文包',
    description:
      '为一个项目生成可直接粘贴进另一个客户端的上下文包（Markdown + 清单）。' +
      '注意：这一步会在工作台留下一条导出记录（不是只读操作），但它不修改任何记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: str('要交接的项目。'),
        task: nullable(str('这次要做什么。会写进包的抬头，帮助接收方理解上下文用途。')),
        budget: {
          type: 'string',
          enum: ['short', 'standard'],
          description: 'short ≈ 1000 token，standard ≈ 2500 token。默认 short —— 先要小上下文，需要时再检索。',
          default: 'short',
        },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    invoke: async (backend, raw) => {
      const args = asRecord(raw);
      if (typeof args.project_id !== 'string' || args.project_id.length === 0) {
        return { text: 'context_build 缺少 project_id。', isError: true };
      }
      return present(
        await backend.call('/api/agent/context_build', {
          method: 'POST',
          body: {
            project_id: args.project_id,
            task: typeof args.task === 'string' ? args.task : null,
            budget: args.budget === 'standard' ? 'standard' : 'short',
          },
        }),
        '生成上下文包失败',
      );
    },
  },

  {
    name: 'memory_propose',
    title: '提交记忆候选',
    description:
      '提交一条**候选**记忆。它不会立即生效：只有在工作台里由人批准之后才会生成 memory_id / version。' +
      '更新已有记忆必须带上 base_version（取自 memory_get），否则会被拒绝 —— 系统不采用「最后写入者获胜」。' +
      '本工具不能批准、不能删除、不能修改连接配置。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'archive'], description: '要做什么。' },
        target_memory_id: nullable(str('operation 为 update / archive 时必填。')),
        base_version: nullable({ type: 'integer', minimum: 1, description: 'update 时必填：你读到的那一版版本号。' }),
        project_id: str('归属项目。'),
        kind: {
          type: 'string',
          enum: ['preference', 'fact', 'decision', 'lesson', 'hypothesis', 'handoff'],
          description: '记忆类型。判断不明确时用 hypothesis，不要用 fact —— 类型会直接影响以后的信任程度。',
        },
        title: str('简短标题。必须由你根据实际内容写出，系统不会自动归纳。'),
        content: str('正文。写清结论本身、适用范围和已知限制。'),
        sensitivity: {
          type: 'string',
          enum: ['normal', 'private', 'restricted'],
          description: '内容涉及的敏感级别。默认 normal；涉及个人或企业资料时提高一级。',
          default: 'normal',
        },
        verification: {
          type: 'string',
          enum: ['unverified', 'locally_tested', 'formally_verified', 'human_confirmed'],
          description: '这条内容被验证到什么程度。默认 unverified —— 不要替用户升级验证状态。',
          default: 'unverified',
        },
        source_kind: {
          type: 'string',
          enum: ['codex_session', 'cursor_session', 'workbuddy_session', 'agent_proposal'],
          description: '这条候选来自哪类会话。',
          default: 'agent_proposal',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: '来源引用（链接、文件路径、会话标识）。服务端目前只登记第一个；没有可验证来源就留空，不要编造。',
          default: [],
        },
      },
      required: ['operation', 'project_id', 'kind', 'title', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    invoke: async (backend, raw) => {
      const args = asRecord(raw);
      const operation = args.operation;

      if (operation !== 'create' && operation !== 'update' && operation !== 'archive') {
        return { text: `memory_propose 的 operation 必须是 create / update / archive，收到 ${JSON.stringify(operation)}。`, isError: true };
      }
      for (const field of ['project_id', 'kind', 'title', 'content'] as const) {
        const v = args[field];
        if (typeof v !== 'string' || v.trim().length === 0) {
          return { text: `memory_propose 缺少必填字段 ${field}。不要用占位内容凑一个值。`, isError: true };
        }
      }
      if (operation === 'update' && typeof args.base_version !== 'number') {
        return {
          text:
            'operation 为 update 时必须带 base_version。先用 memory_get 读到当前版本号再提交 —— ' +
            '不带基线的更新会让别人的改动被静默覆盖，服务端会直接拒绝。',
          isError: true,
        };
      }

      // §14：全局记忆默认不向每个 coding agent 开放。凭据只能写项目/会话范围，
      // 想建全局记忆要到工作台界面上由人操作。
      const sources = Array.isArray(args.sources) ? args.sources.filter((s): s is string => typeof s === 'string') : [];

      const result = await backend.call<Record<string, unknown>>('/api/agent/memory_propose', {
        method: 'POST',
        body: {
          operation,
          targetMemoryId: typeof args.target_memory_id === 'string' ? args.target_memory_id : null,
          baseVersion: typeof args.base_version === 'number' ? args.base_version : null,
          scope: 'project',
          projectId: args.project_id,
          kind: args.kind,
          title: args.title,
          content: args.content,
          sensitivity: typeof args.sensitivity === 'string' ? args.sensitivity : 'normal',
          verification: typeof args.verification === 'string' ? args.verification : 'unverified',
          sourceKind: typeof args.source_kind === 'string' ? args.source_kind : 'agent_proposal',
          sourceRef: sources[0] ?? null,
          evidenceStatus: 'user_confirmation_required',
          submittedByClientId: null,
        },
      });

      const outcome = present(result, '提交候选失败');
      if (outcome.isError || sources.length <= 1) return outcome;

      // 不静默丢弃：说出来，让用户知道有几个来源没被登记。
      return {
        ...outcome,
        text: `${outcome.text}\n\n注意：本次只登记了第一个来源（${sources[0]}）。其余 ${sources.length - 1} 个来源当前不会入库。`,
      };
    },
  },

  {
    name: 'session_propose',
    title: '登记会话摘要',
    description:
      '把这次会话的摘要、已达成的决策和下一步登记为**项目材料**。它不会自动变成长期记忆 —— ' +
      '只有用户明确认可的内容才应该另提 memory_propose 并经过批准。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: str('归属项目。'),
        summary: str('这次做了什么、结论是什么。'),
        decisions: { type: 'array', items: { type: 'string' }, description: '已达成的决策，逐条写。', default: [] },
        next_steps: { type: 'array', items: { type: 'string' }, description: '下一步，逐条写。', default: [] },
        sources: { type: 'array', items: { type: 'string' }, description: '来源引用。', default: [] },
      },
      required: ['project_id', 'summary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    invoke: async (backend, raw) => {
      const args = asRecord(raw);
      if (typeof args.project_id !== 'string' || args.project_id.length === 0) {
        return { text: 'session_propose 缺少 project_id。', isError: true };
      }
      if (typeof args.summary !== 'string' || args.summary.trim().length === 0) {
        return { text: 'session_propose 缺少 summary。', isError: true };
      }
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return present(
        await backend.call('/api/agent/session_propose', {
          method: 'POST',
          body: {
            project_id: args.project_id,
            summary: args.summary,
            decisions: list(args.decisions),
            next_steps: list(args.next_steps),
            sources: list(args.sources),
          },
        }),
        '登记会话摘要失败',
      );
    },
  },

  {
    name: 'integration_status',
    title: '查看接入与授权状态',
    description:
      '返回当前凭据的身份、项目范围、可用项目，以及各客户端连接的能力状态。' +
      '注意 capability_status 为 documented 只表示「官方文档说支持」，不等于本机已验证。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    invoke: async (backend) => present(await backend.call('/api/agent/integration_status', { method: 'GET' }), '查询接入状态失败'),
  },
];

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 暴露给 tools/list 的定义（不含 invoke 这类函数）。 */
export function toolList(): Array<Record<string, unknown>> {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}
