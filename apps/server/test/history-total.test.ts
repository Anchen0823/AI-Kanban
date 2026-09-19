import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setSetting } from '../src/db/repos/system.js';
import { errorBody, toApiError } from '../src/http/errors.js';
import { registerHistoryTotalRoutes } from '../src/http/routes/history-total.js';
import {
  aggregateHistoryTotal,
  historyTotal,
  type HistoryTotalCandidate,
} from '../src/services/history-total.js';
import { importData } from '../src/services/usage.js';
import { createHarness, importCsv } from './helpers.js';

function saveCodex(h: Awaited<ReturnType<typeof createHarness>>, totalTokens: number): void {
  setSetting(h.app.db, 'history.codex', JSON.stringify({
    schemaVersion: 1,
    status: 'ok',
    checkedAt: '2026-09-19T00:00:00.000Z',
    totals: {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens,
    },
    sessionCount: 1,
    firstAt: null,
    lastAt: null,
    byModel: [],
    byDay: [],
    warnings: [],
    message: 'fixture',
  }));
}

function saveDeepseek(h: Awaited<ReturnType<typeof createHarness>>, totalTokens: number, warnings: string[] = []): void {
  setSetting(h.app.db, 'history.deepseek', JSON.stringify({
    schemaVersion: 1,
    status: 'ok',
    checkedAt: '2026-09-19T00:00:00.000Z',
    totals: {
      inputTokens: totalTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens,
      requestCount: 1,
    },
    firstAt: null,
    lastAt: null,
    byModel: [],
    byDay: [],
    costs: [],
    fileCount: 1,
    warnings,
    message: 'fixture',
  }));
}

test('纯聚合只累计 included 来源一次，并对重复 id 与安全整数溢出降级', () => {
  const candidates: HistoryTotalCandidate[] = [
    { id: 'a', label: 'A', totalTokens: Number.MAX_SAFE_INTEGER, included: true, reason: null },
    { id: 'a', label: 'A duplicate', totalTokens: 999, included: true, reason: null },
    { id: 'excluded', label: 'Excluded', totalTokens: 500, included: false, reason: '重叠' },
    { id: 'b', label: 'B', totalTokens: 1, included: true, reason: null },
  ];
  const result = aggregateHistoryTotal(candidates);
  assert.equal(result.totalTokens, null);
  assert.equal(result.partial, true);
  assert.deepEqual(result.sources.map((source) => source.id), ['a', 'excluded', 'b']);
  assert.equal(result.sources.filter((source) => source.id === 'a').length, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('重复来源 id')));
  assert.ok(result.warnings.some((warning) => warning.includes('安全整数范围')));
});

test('real 总览纳入专用历史和明确非重叠供应商，排除潜在重叠导入', async () => {
  const h = await createHarness();
  try {
    saveCodex(h, 100);
    saveDeepseek(h, 200, ['DeepSeek 导出范围存在空档。']);

    for (const [provider, total] of [['DeepSeek', 30], ['OpenAI', 40], ['Anthropic', 50]] as const) {
      const account = await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
        provider, alias: provider, currency: 'USD',
      });
      await importCsv(h, `${provider}.csv`, [
        'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens',
        `2026-09-01T00:00:00Z,${provider}-request,model-${provider},${total},0,${total}`,
      ].join('\n'), { accountId: account.body.account.id });
    }
    await importCsv(h, 'unknown.csv', [
      'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens',
      '2026-09-01T00:00:00Z,unknown-request,custom-model,60,0,60',
    ].join('\n'));

    const result = historyTotal(h.app.ctx, 'real');
    assert.equal(result.totalTokens, 350);
    assert.equal(result.partial, true);
    assert.equal(result.sources.find((source) => source.id === 'codex')?.included, true);
    assert.equal(result.sources.find((source) => source.id === 'deepseek')?.included, true);
    assert.equal(result.sources.find((source) => source.id === 'imported:Anthropic')?.included, true);
    assert.match(result.sources.find((source) => source.id === 'imported:DeepSeek')?.reason ?? '', /可能重叠/);
    assert.match(result.sources.find((source) => source.id === 'imported:OpenAI')?.reason ?? '', /潜在重叠/);
    assert.match(result.sources.find((source) => source.id === 'imported:未分类')?.reason ?? '', /潜在重叠/);
    assert.ok(result.warnings.includes('DeepSeek 导出范围存在空档。'));
    assert.ok(result.warnings.some((warning) => warning.includes('不是逐请求精确去重')));
  } finally {
    h.close();
  }
});

test('没有专用快照时可纳入通用导入，但未分类始终标记 partial', async () => {
  const h = await createHarness();
  try {
    const account = await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
      provider: 'deepseek', alias: 'DeepSeek', currency: 'CNY',
    });
    await importCsv(h, 'deepseek.csv', [
      'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens',
      '2026-09-01T00:00:00Z,ds-request,deepseek-chat,10,2,12',
    ].join('\n'), { accountId: account.body.account.id });
    await importCsv(h, 'unknown.csv', [
      'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens',
      '2026-09-01T00:00:00Z,unknown-request,custom-model,5,3,8',
    ].join('\n'));

    const result = historyTotal(h.app.ctx, 'real');
    assert.equal(result.totalTokens, 20);
    assert.equal(result.sources.find((source) => source.id === 'imported:DeepSeek')?.included, true);
    assert.equal(result.sources.find((source) => source.id === 'imported:未分类')?.included, true);
    assert.equal(result.partial, true);
    assert.ok(result.warnings.some((warning) => warning.includes('未分类导入')));
  } finally {
    h.close();
  }
});

test('demo 只汇总 demo imported，不读取或暴露真实专用缓存', async () => {
  const h = await createHarness();
  try {
    saveCodex(h, 999_999);
    saveDeepseek(h, 888_888);
    const imported = importData(h.app.ctx, {
      kind: 'usage_csv',
      fileName: 'demo-total.csv',
      content: 'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens\n2026-09-01T00:00:00Z,demo,anthropic-demo,6,4,10',
      accountId: null,
      projectId: null,
      clientId: null,
      collectionMethod: 'imported_file',
      measurementQuality: 'provider_reported',
      coverageScope: null,
      dryRun: false,
      isDemo: true,
    });
    assert.equal(imported.acceptedRows, 1);

    const result = historyTotal(h.app.ctx, 'demo');
    assert.equal(result.totalTokens, 10);
    assert.equal(result.sources.some((source) => source.id === 'codex' || source.id === 'deepseek'), false);
    assert.deepEqual(result.sources.map((source) => source.id), ['imported:未分类']);
  } finally {
    h.close();
  }
});

test('全部 AI 历史路由要求用户会话、设置 no-store 并遵循 workspace', async () => {
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
  registerHistoryTotalRoutes(server, { app: h.app, sessions: h.sessions, config: h.config });
  await server.ready();
  try {
    assert.equal((await server.inject({ method: 'GET', url: '/api/history/total' })).statusCode, 401);
    const response = await server.inject({
      method: 'GET', url: '/api/history/total?workspace=demo', headers: { authorization: 'Test user' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().totalTokens, null);
    assert.deepEqual(response.json().sources, []);
  } finally {
    await server.close();
    h.close();
  }
});
