import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getSetting } from '../src/db/repos/system.js';
import { errorBody, toApiError } from '../src/http/errors.js';
import { registerDeepseekDetectionRoutes } from '../src/http/routes/deepseek-detection.js';
import { getDeepseekDetection, runDeepseekDetection } from '../src/services/deepseek-detection.js';
import { createHarness } from './helpers.js';

const fixture = {
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    total_balance: '12.3400',
    granted_balance: '-0.5000',
    topped_up_balance: '10.0000',
  }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('DeepSeek 检测使用官方只读接口，金额保持字符串，凭据不持久化', async () => {
  const h = await createHarness();
  try {
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      assert.equal(String(url), 'https://api.deepseek.com/user/balance');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-fixture-secret');
      return jsonResponse(fixture);
    }) as typeof fetch;

    assert.equal(getDeepseekDetection(h.app.ctx, { envApiKey: null }).status, 'not_configured');
    const result = await runDeepseekDetection(h.app.ctx, {
      apiKey: '  sk-fixture-secret  ', fetchImpl, envApiKey: 'sk-env-not-used',
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.isAvailable, true);
    assert.equal(result.configured, true);
    assert.deepEqual(result.balances, [{
      currency: 'CNY', totalBalance: '12.3400', grantedBalance: '-0.5000', toppedUpBalance: '10.0000',
    }]);

    const stored = getSetting(h.app.db, 'detection.deepseek') ?? '';
    assert.doesNotMatch(stored, /sk-fixture-secret/);
    assert.deepEqual(getDeepseekDetection(h.app.ctx, { envApiKey: null }), result);

    const reused = await runDeepseekDetection(h.app.ctx, { fetchImpl, envApiKey: 'sk-other-env-not-used' });
    assert.equal(reused.status, 'ok', '省略 key 时复用服务器内存中的上次连接');
    assert.equal(calls, 2);
  } finally {
    h.close();
  }
});

test('失败保留旧余额；401、429、畸形响应和网络错误不泄露上游正文', async () => {
  const h = await createHarness();
  try {
    const ok = await runDeepseekDetection(h.app.ctx, {
      apiKey: 'sk-old', fetchImpl: async () => jsonResponse(fixture), envApiKey: null,
    });

    for (const [fetchImpl, expected] of [
      [async () => new Response('upstream says secret sk-old', { status: 401 }), /API Key 无效/],
      [async () => new Response('rate detail', { status: 429 }), /请求过于频繁/],
      [async () => jsonResponse({ is_available: 'yes', balance_infos: [] }), /格式不符合预期/],
      [async () => { throw new Error('socket failed with sk-old'); }, /无法连接/],
    ] as Array<[typeof fetch, RegExp]>) {
      const failed = await runDeepseekDetection(h.app.ctx, { fetchImpl, envApiKey: null });
      assert.equal(failed.status, 'error');
      assert.deepEqual(failed.balances, ok.balances);
      assert.equal(failed.lastSuccessAt, ok.lastSuccessAt);
      assert.match(failed.message, expected);
      assert.doesNotMatch(failed.message, /sk-old|upstream|socket failed/);
    }
  } finally {
    h.close();
  }
});

test('环境变量后备与超时可测试，GET 本身不触发网络', async () => {
  const h = await createHarness();
  try {
    let calls = 0;
    const get = getDeepseekDetection(h.app.ctx, { envApiKey: 'sk-env' });
    assert.equal(get.status, 'not_configured');
    assert.equal(get.configured, true);
    assert.equal(calls, 0);

    const timedOut = await runDeepseekDetection(h.app.ctx, {
      envApiKey: 'sk-env', timeoutMs: 5,
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }) as typeof fetch,
    });
    assert.equal(calls, 1);
    assert.equal(timedOut.status, 'error');
    assert.match(timedOut.message, /超时/);
  } finally {
    h.close();
  }
});

test('没有可用 key 的 POST 保留上次成功余额并提示重新连接', async () => {
  const h = await createHarness();
  try {
    const ok = await runDeepseekDetection(h.app.ctx, {
      envApiKey: 'sk-env-only', fetchImpl: async () => jsonResponse(fixture),
    });
    const disconnected = await runDeepseekDetection(h.app.ctx, {
      envApiKey: null,
      fetchImpl: async () => { throw new Error('没有 key 时不应联网'); },
    });
    assert.equal(disconnected.status, 'not_configured');
    assert.equal(disconnected.configured, false);
    assert.equal(disconnected.lastSuccessAt, ok.lastSuccessAt);
    assert.equal(disconnected.checkedAt, ok.checkedAt);
    assert.deepEqual(disconnected.balances, ok.balances);
    assert.match(disconnected.message, /保留上次成功余额.*重新连接/);
  } finally {
    h.close();
  }
});

test('DeepSeek 路由仅用户可用且禁止缓存；请求体拒绝额外字段', async () => {
  const h = await createHarness();
  const server = Fastify({ logger: false });
  server.decorateRequest('principal', undefined);
  server.addHook('preHandler', async (request) => {
    if (request.headers.authorization === 'Test user') {
      request.principal = { kind: 'user', label: 'test', sessionId: 'session', projectIds: null, scopes: null };
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    const apiError = toApiError(error);
    reply.status(apiError.status).send(errorBody(apiError));
  });
  let routeFetchCalls = 0;
  registerDeepseekDetectionRoutes(server, { app: h.app, sessions: h.sessions, config: h.config }, {
    envApiKey: null,
    fetchImpl: async () => {
      routeFetchCalls += 1;
      return jsonResponse(fixture);
    },
  });
  await server.ready();
  try {
    const unauthorized = await server.inject({ method: 'GET', url: '/api/detection/deepseek' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.headers['cache-control'], 'no-store');
    const current = await server.inject({
      method: 'GET', url: '/api/detection/deepseek', headers: { authorization: 'Test user' },
    });
    assert.equal(current.statusCode, 200);
    assert.equal(current.headers['cache-control'], 'no-store');
    assert.equal(current.json().status, 'not_configured');

    for (const method of ['GET', 'POST'] as const) {
      const demo = await server.inject({
        method,
        url: '/api/detection/deepseek?workspace=demo',
        headers: { authorization: 'Test user' },
        ...(method === 'POST' ? { payload: { apiKey: 'sk-demo-must-not-run' } } : {}),
      });
      assert.equal(demo.statusCode, 400);
      assert.equal(demo.headers['cache-control'], 'no-store');
      assert.match(demo.body, /示例工作区/);
    }
    assert.equal(routeFetchCalls, 0, '示例工作区请求在任何联网前被拒绝');

    const invalid = await server.inject({
      method: 'POST', url: '/api/detection/deepseek', headers: { authorization: 'Test user' },
      payload: { apiKey: 'sk', extra: true },
    });
    assert.equal(invalid.statusCode, 400);

    const connected = await server.inject({
      method: 'POST', url: '/api/detection/deepseek', headers: { authorization: 'Test user' },
      payload: { apiKey: 'sk-route' },
    });
    assert.equal(connected.statusCode, 200);
    assert.equal(connected.headers['cache-control'], 'no-store');
    assert.equal(connected.json().status, 'ok');
    assert.equal(routeFetchCalls, 1);
    assert.doesNotMatch(connected.body, /sk-route/);
  } finally {
    await server.close();
    h.close();
  }
});
