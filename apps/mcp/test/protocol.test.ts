import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENTIAL_SCOPES } from '@aicc/core';
import { Backend } from '../src/backend.js';
import {
  JSON_RPC,
  encodeMessage,
  isJsonRpcRequest,
  negotiateProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/protocol.js';
import { createMcpServer } from '../src/server.js';
import { findTool, toolList } from '../src/tools.js';

/**
 * MCP 传输层的协议与映射测试。
 *
 * 这一层最怕两类问题：一是协议形状不对（客户端直接连不上，且报错指向别处），
 * 二是把服务端的失败美化成了成功。这两类都在这份文件里按住。
 */

/* ------------------------------------------------------------------ */
/* 测试替身                                                            */
/* ------------------------------------------------------------------ */

interface StubRoute {
  /** 返回 { status, body } 表示非 2xx。 */
  (body: unknown): unknown;
}

function stubBackend(routes: Record<string, StubRoute>, token: string | null = 'fake-token'): Backend {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof url === 'string' ? url : url.toString()).pathname;
    const handler = routes[path];
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `测试替身没有定义路由 ${path}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const result = handler(body) as { status: number; body: unknown } | unknown;
    if (result !== null && typeof result === 'object' && 'status' in result && 'body' in result) {
      const shaped = result as { status: number; body: unknown };
      return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  return new Backend({ baseUrl: 'http://127.0.0.1:8787', token, fetchImpl });
}

const silent = (): void => {};

async function handshake(backend: Backend) {
  const server = createMcpServer({ backend, log: silent });
  const init = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't', version: '1' } } }),
  );
  return { server, init };
}

/** 取出成功响应的 result。签名收成 unknown，免得每个用例都要先做类型戏法。 */
function resultOf(response: unknown): Record<string, unknown> {
  assert.ok(response !== null && typeof response === 'object', '期望有响应');
  assert.ok('result' in response, `期望成功响应，实际是：${JSON.stringify(response)}`);
  return (response as { result: Record<string, unknown> }).result;
}

/** 取出错误响应的 error。 */
function errorOf(response: unknown): { code: number; message: string } {
  assert.ok(response !== null && typeof response === 'object', '期望有响应');
  assert.ok('error' in response, `期望错误响应，实际是：${JSON.stringify(response)}`);
  return (response as { error: { code: number; message: string } }).error;
}

/* ------------------------------------------------------------------ */
/* 协议：版本协商与信封                                                */
/* ------------------------------------------------------------------ */

test('版本协商：客户端要求的版本受支持时原样返回', () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocolVersion(v), v);
  }
});

test('版本协商：不受支持的版本回退到本服务的最新版本，而不是报错', () => {
  // 规范要求服务端返回自己支持的版本，由客户端决定是否继续。
  // 回错误会让客户端只看到「失败」，看不出「其实可以降级继续」。
  assert.equal(negotiateProtocolVersion('1999-01-01'), SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateProtocolVersion(42), SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test('id 为 0 的请求是合法请求，不能被当成通知丢掉', () => {
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: 0, method: 'ping' }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', id: '', method: 'ping' }), true);
  assert.equal(isJsonRpcRequest({ jsonrpc: '2.0', method: 'ping' }), false, '没有 id 的是通知');
});

test('消息按行编码，且是一行一个完整 JSON', () => {
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  assert.equal(encoded.endsWith('\n'), true);
  assert.equal(encoded.trimEnd().includes('\n'), false);
  assert.deepEqual(JSON.parse(encoded), { jsonrpc: '2.0', id: 1, result: { ok: true } });
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

test('initialize 返回协议版本、工具能力与服务端自述', async () => {
  const { init } = await handshake(stubBackend({}));
  const result = resultOf(init);
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal((result.serverInfo as { name: string }).name, 'ai-control-center');
  // instructions 是模型唯一一定会读到的一段话，不能为空
  assert.match(String(result.instructions), /候选/);
  assert.match(String(result.instructions), /不要假装检索成功/);
});

test('未 initialize 就调用 tools/list / tools/call 会被拒绝（-32002）', async () => {
  const server = createMcpServer({ backend: stubBackend({}), log: silent });
  const list = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(errorOf(list).code, -32002);

  const call = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: {} } }),
  );
  assert.equal(errorOf(call).code, -32002);
});

test('通知不产生响应；坏 JSON 与未知方法各自报正确的错', async () => {
  const { server } = await handshake(stubBackend({}));

  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  assert.equal(await server.handleLine('   '), null);

  const broken = await server.handleLine('{ 这不是 JSON');
  assert.equal(errorOf(broken).code, JSON_RPC.parseError);

  const unknown = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/remove' }));
  assert.equal(errorOf(unknown).code, JSON_RPC.methodNotFound);
  assert.match(errorOf(unknown).message, /tools\/remove/);
});

test('资源与提示词返回空列表，而不是「方法不存在」', async () => {
  const { server } = await handshake(stubBackend({}));
  for (const [method, key] of [
    ['resources/list', 'resources'],
    ['prompts/list', 'prompts'],
  ] as const) {
    const res = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method }));
    assert.deepEqual(resultOf(res)[key], [], `${method} 应回空数组`);
  }
});

/* ------------------------------------------------------------------ */
/* 工具清单与参数契约                                                  */
/* ------------------------------------------------------------------ */

test('六个工具齐全，且与凭据 scope 一一对应', () => {
  // 工具名必须等于 scope 名：否则会出现「工具能列出、但凭据怎么签都不够用」
  // 或者反过来「scope 存在、却没有对应工具」这种谁都查不出来的错位。
  assert.deepEqual(
    toolList().map((t) => t.name),
    [...CREDENTIAL_SCOPES],
  );
});

test('工具 schema 都是封闭对象，且读工具带 readOnlyHint', () => {
  for (const tool of toolList()) {
    const schema = tool.inputSchema as { type: string; additionalProperties: boolean };
    assert.equal(schema.type, 'object', `${tool.name} 的 inputSchema 必须是 object`);
    // 封闭 schema：模型多传一个字段就应当被挡下，而不是被悄悄忽略
    assert.equal(schema.additionalProperties, false, `${tool.name} 应当拒绝额外字段`);

    const annotations = tool.annotations as { readOnlyHint: boolean };
    if (['memory_search', 'memory_get', 'integration_status'].includes(tool.name as string)) {
      assert.equal(annotations.readOnlyHint, true, `${tool.name} 是只读工具`);
    }
    assert.ok(String(tool.description).length > 20, `${tool.name} 需要说清用途，不能只写名字`);
  }
});

test('未知工具名报 -32602，并列出可用工具', async () => {
  const { server } = await handshake(stubBackend({}));
  const res = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_delete', arguments: {} } }),
  );
  const error = errorOf(res);
  assert.equal(error.code, JSON_RPC.invalidParams);
  assert.match(error.message, /memory_delete/);
  assert.match(error.message, /memory_search/, '要把可用工具列出来，便于模型自我纠正');
});

/* ------------------------------------------------------------------ */
/* 失败必须如实呈现                                                    */
/* ------------------------------------------------------------------ */

test('没有凭据时工具调用返回 isError，并说明去哪里签发', async () => {
  const { server } = await handshake(stubBackend({}, null));
  const res = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } }),
  );
  const result = resultOf(res) as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /token_missing/);
  assert.match(result.content[0]?.text ?? '', /代理凭据/);
});

test('服务端 403 原样传导，且明确要求不要重试', async () => {
  const backend = stubBackend({
    '/api/agent/memory_search': () => ({
      status: 403,
      body: { error: { code: 'forbidden', message: '当前凭据未被授权访问项目 proj_b' } },
    }),
  });
  const { server } = await handshake(backend);
  const res = await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'x', project_id: 'proj_b' } },
    }),
  );
  const text = (resultOf(res) as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  assert.equal((resultOf(res) as { isError: boolean }).isError, true);
  assert.match(text, /forbidden/);
  assert.match(text, /proj_b/, '要带上服务端给的具体原因');
  assert.match(text, /不要换参数重试/);
  assert.match(text, /没有产生任何变更/);
});

test('服务连不上时说明要启动工作台，而不是静默返回空结果', async () => {
  const failing = new Backend({
    baseUrl: 'http://127.0.0.1:8787',
    token: 'fake',
    fetchImpl: (async () => {
      const err = new Error('fetch failed');
      (err as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw err;
    }) as unknown as typeof fetch,
  });
  const { server } = await handshake(failing);
  const res = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'x' } } }),
  );
  const result = resultOf(res) as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /backend_unreachable/);
  assert.match(result.content[0]?.text ?? '', /npm start/);
});

test('工具入参缺字段时在传输层就拦下，不编造默认值', async () => {
  const { server } = await handshake(stubBackend({}));
  const res = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_propose', arguments: { operation: 'create' } } }),
  );
  const text = (resultOf(res) as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  assert.equal((resultOf(res) as { isError: boolean }).isError, true);
  assert.match(text, /缺少必填字段 project_id/);
  assert.match(text, /不要用占位内容凑一个值/);
});

/* ------------------------------------------------------------------ */
/* 参数映射                                                            */
/* ------------------------------------------------------------------ */

test('memory_search 的参数按服务端字段名转发', async () => {
  let seen: Record<string, unknown> | undefined;
  const backend = stubBackend({
    '/api/agent/memory_search': (body) => {
      seen = body as Record<string, unknown>;
      return { items: [], count: 0 };
    },
  });
  const { server } = await handshake(backend);
  await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: '时区', project_id: 'proj_a', kind: 'decision', limit: 5 } },
    }),
  );
  assert.deepEqual(seen, { query: '时区', project_id: 'proj_a', kind: 'decision', limit: 5 });
});

test('memory_search 只给 query 时，其余字段显式传 null 而不是省略', async () => {
  // 省略会让服务端的默认值生效，看似等价；但显式 null 让「这次没有限定项目」
  // 这件事在审计记录里也看得见。
  let seen: Record<string, unknown> | undefined;
  const backend = stubBackend({
    '/api/agent/memory_search': (body) => {
      seen = body as Record<string, unknown>;
      return { items: [] };
    },
  });
  const { server } = await handshake(backend);
  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_search', arguments: { query: '' } } }),
  );
  assert.deepEqual(seen, { query: '', project_id: null, kind: null, limit: 10 });
});

test('memory_propose 的 camelCase 映射正确，且不接受凭据写全局记忆', async () => {
  let seen: Record<string, unknown> | undefined;
  const backend = stubBackend({
    '/api/agent/memory_propose': (body) => {
      seen = body as Record<string, unknown>;
      return { proposal_id: 'prop_1', status: 'candidate' };
    },
  });
  const { server } = await handshake(backend);
  const res = await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_propose',
        arguments: {
          operation: 'update',
          target_memory_id: 'mem_1',
          base_version: 3,
          project_id: 'proj_a',
          kind: 'decision',
          title: '统一用 UTC 存时间',
          content: '所有时间戳以 UTC 存储。',
          source_kind: 'codex_session',
          sources: ['https://example.com/thread/1'],
        },
      },
    }),
  );

  assert.deepEqual(seen, {
    operation: 'update',
    targetMemoryId: 'mem_1',
    baseVersion: 3,
    scope: 'project',
    projectId: 'proj_a',
    kind: 'decision',
    title: '统一用 UTC 存时间',
    content: '所有时间戳以 UTC 存储。',
    sensitivity: 'normal',
    verification: 'unverified',
    sourceKind: 'codex_session',
    sourceRef: 'https://example.com/thread/1',
    evidenceStatus: 'user_confirmation_required',
    submittedByClientId: null,
  });
  assert.equal((resultOf(res) as { isError: boolean }).isError, false);
});

test('update 不给 base_version 时直接拒绝，不说「已提交」', async () => {
  const { server } = await handshake(stubBackend({}));
  const res = await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_propose',
        arguments: { operation: 'update', project_id: 'p', kind: 'decision', title: 't', content: 'c' },
      },
    }),
  );
  const result = resultOf(res) as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /base_version/);
  assert.doesNotMatch(result.content[0]?.text ?? '', /已提交|已保存|成功/);
});

test('多个来源时明确告知只登记了第一个，而不是静默丢弃', async () => {
  const backend = stubBackend({
    '/api/agent/memory_propose': () => ({ proposal_id: 'prop_2', status: 'candidate' }),
  });
  const { server } = await handshake(backend);
  const res = await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'memory_propose',
        arguments: {
          operation: 'create',
          project_id: 'p',
          kind: 'fact',
          title: 't',
          content: 'c',
          sources: ['s1', 's2', 's3'],
        },
      },
    }),
  );
  const text = (resultOf(res) as { content: Array<{ text: string }> }).content[0]?.text ?? '';
  assert.match(text, /只登记了第一个来源/);
  assert.match(text, /其余 2 个/);
});

test('integration_status 走 GET，不带请求体', async () => {
  let method: string | undefined;
  const backend = new Backend({
    baseUrl: 'http://127.0.0.1:8787',
    token: 'fake',
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      method = init?.method;
      assert.equal(init?.body, undefined, 'GET 不该带 body');
      return new Response(JSON.stringify({ schema_version: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  const { server } = await handshake(backend);
  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'integration_status', arguments: {} } }),
  );
  assert.equal(method, 'GET');
});

test('findTool 对不存在与存在的名字都给出一致结论', () => {
  assert.equal(findTool('memory_get')?.name, 'memory_get');
  assert.equal(findTool('nope'), undefined);
});
