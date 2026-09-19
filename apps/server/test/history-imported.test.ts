import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { errorBody, toApiError } from '../src/http/errors.js';
import { registerHistoryImportedRoutes } from '../src/http/routes/history-imported.js';
import { importedHistory } from '../src/services/history-imported.js';
import { importData } from '../src/services/usage.js';
import { createHarness, importCsv } from './helpers.js';

test('历史汇总使用全部 counted observations、稳定去重，并保持子集 token 语义', async () => {
  const h = await createHarness();
  try {
    const account = await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
      provider: 'Vendor A', alias: '历史账户', currency: 'USD',
    });
    const accountId = account.body.account.id;
    const rows = Array.from({ length: 501 }, (_, index) => [
      index < 250 ? '2026-09-01T00:00:00Z' : '2026-09-02T00:00:00Z',
      `req-${index}`,
      'deepseek-chat',
      '10',
      '2',
      '4',
      '1',
      '12',
    ].join(','));
    const header = 'occurred_at,request_id,model,input_tokens,output_tokens,cached_tokens,reasoning_tokens,total_tokens';
    const imported = await importCsv(h, 'history-501.csv', [header, ...rows].join('\n'), { accountId });
    assert.equal(imported.body.acceptedRows, 501);

    const duplicate = await importCsv(h, 'history-duplicate.csv', [header, rows[0]].join('\n'), { accountId });
    assert.equal(duplicate.body.evidenceRows, 1, '同一稳定 request id 的第二来源不重复计数');

    await importCsv(h, 'deepseek-unaccounted.csv', [
      'request_id,model,input_tokens,output_tokens,total_tokens',
      'deepseek-unaccounted,deepseek-reasoner,2,1,3',
    ].join('\n'));
    await importCsv(h, 'codex-unclassified.csv', [
      'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens',
      '2026-09-03T00:00:00Z,codex-unclassified,codex-cli,4,1,5',
    ].join('\n'));

    const result = importedHistory(h.app.ctx, 'real');
    assert.equal(result.count, 503, '全量返回，不能在 500 条截断，且证据行不重复计数');
    assert.equal(result.partial, true, '未知日期和缺失缓存分量使结果明确标为 partial');
    assert.match(result.note, /不能直接相加/);
    assert.deepEqual(result.providers.map((provider) => provider.provider), ['DeepSeek', 'Vendor A', '未分类']);

    const vendor = result.providers.find((provider) => provider.provider === 'Vendor A');
    assert.ok(vendor);
    assert.equal(vendor.count, 501);
    assert.deepEqual(vendor.totals, {
      inputTokens: 5010,
      cachedInputTokens: 2004,
      outputTokens: 1002,
      reasoningOutputTokens: 501,
      totalTokens: 6012,
    });
    assert.equal(vendor.firstAt, '2026-09-01T00:00:00.000Z');
    assert.equal(vendor.lastAt, '2026-09-02T00:00:00.000Z');
    assert.deepEqual(vendor.byDay, [
      { date: '2026-09-01', totalTokens: 3000, count: 250 },
      { date: '2026-09-02', totalTokens: 3012, count: 251 },
    ]);
    assert.equal(vendor.byModel[0]?.totalTokens, 6012);
    assert.notEqual(vendor.totals.totalTokens, 8517, '缓存与推理是子集，不能再次加到总量');

    const deepseek = result.providers.find((provider) => provider.provider === 'DeepSeek');
    assert.deepEqual(deepseek?.byDay, [{ date: '未知日期', totalTokens: 3, count: 1 }]);
    assert.equal(result.providers.at(-1)?.provider, '未分类', 'codex 模型名不能被猜成 OpenAI');
  } finally {
    h.close();
  }
});

test('历史汇总空状态与 demo workspace 隔离', async () => {
  const h = await createHarness();
  try {
    assert.deepEqual(importedHistory(h.app.ctx, 'real'), {
      providers: [], count: 0, partial: false,
      note: '仅汇总已导入的历史记录；可能与本机 Codex 数据重叠，不能直接相加。',
    });

    const demo = importData(h.app.ctx, {
      kind: 'usage_csv',
      fileName: 'demo-history.csv',
      content: 'occurred_at,model,input_tokens,output_tokens\n2026-09-05T00:00:00Z,demo-model,8,2',
      accountId: null,
      projectId: null,
      clientId: null,
      collectionMethod: 'imported_file',
      measurementQuality: 'provider_reported',
      coverageScope: null,
      dryRun: false,
      isDemo: true,
    });
    assert.equal(demo.acceptedRows, 1);
    assert.equal(importedHistory(h.app.ctx, 'real').count, 0);
    assert.equal(importedHistory(h.app.ctx, 'demo').count, 1);
  } finally {
    h.close();
  }
});

test('历史汇总拒绝超过安全整数的聚合，并统一 DeepSeek 账户名大小写', async () => {
  const h = await createHarness();
  try {
    const account = await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
      provider: 'deepseek', alias: '溢出测试', currency: 'CNY',
    });
    const huge = '9007199254740990';
    const imported = await importCsv(h, 'safe-overflow.csv', [
      'request_id,model,input_tokens,output_tokens',
      `overflow-1,other-model,${huge},0`,
      `overflow-2,other-model,${huge},0`,
    ].join('\n'), { accountId: account.body.account.id });
    assert.equal(imported.body.acceptedRows, 2);

    const result = importedHistory(h.app.ctx);
    assert.deepEqual(result.providers.map((provider) => provider.provider), ['DeepSeek']);
    assert.equal(result.providers[0]?.totals.inputTokens, null);
    assert.equal(result.providers[0]?.totals.totalTokens, null);
    assert.equal(result.providers[0]?.totals.outputTokens, 0);
    assert.equal(result.partial, true);
  } finally {
    h.close();
  }
});

test('DeepSeek 原生 usage JSON 被显式展平，created 秒时间与 request id 去重保留', async () => {
  const h = await createHarness();
  try {
    const created = 1_720_000_000;
    const native = {
      id: 'chatcmpl-deepseek-1',
      created,
      model: 'deepseek-chat',
      metadata: { prompt_tokens: 999, source: '不能展开的 metadata' },
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 40,
      },
    };
    const topLevelWins = {
      ...native,
      id: 'chatcmpl-deepseek-2',
      prompt_tokens: 7,
    };
    const first = await h.request<Record<string, unknown>>('POST', '/api/imports', {
      kind: 'usage_json', fileName: 'deepseek-native.json', content: JSON.stringify([native, topLevelWins]),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.acceptedRows, 2);

    const usage = await h.request<{
      items: Array<{
        providerRequestId: string | null;
        inputTotal: number | null;
        cachedInput: number | null;
        outputTotal: number | null;
        totalReported: number | null;
        occurredAt: string | null;
        rawUsage: Record<string, unknown>;
      }>;
    }>('GET', '/api/usage?limit=10');
    const row1 = usage.body.items.find((row) => row.providerRequestId === native.id);
    const row2 = usage.body.items.find((row) => row.providerRequestId === topLevelWins.id);
    assert.ok(row1);
    assert.equal(row1.inputTotal, 100);
    assert.equal(row1.outputTotal, 20);
    assert.equal(row1.cachedInput, 40);
    assert.equal(row1.totalReported, 120);
    assert.equal(row1.occurredAt, new Date(created * 1000).toISOString());
    assert.deepEqual(row1.rawUsage.metadata, native.metadata, 'metadata 只保存在 raw_usage，不参与展平');
    assert.equal(row2?.inputTotal, 7, '顶层明确字段优先于 usage 内同名字段');
    assert.equal(row2?.totalReported, 27, '总量仍由 core 的 input + output 子集语义计算');

    const second = await h.request<Record<string, unknown>>('POST', '/api/imports', {
      kind: 'usage_json',
      fileName: 'deepseek-second-source.json',
      content: JSON.stringify({ ...native, metadata: { ...native.metadata, source: '第二来源' } }),
    });
    assert.equal(second.body.evidenceRows, 1, '嵌套 usage 展平不能破坏顶层 request id 去重');
  } finally {
    h.close();
  }
});

test('历史路由只允许用户会话并遵循 workspace 查询', async () => {
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
  registerHistoryImportedRoutes(server, { app: h.app, sessions: h.sessions, config: h.config });
  await server.ready();
  try {
    assert.equal((await server.inject({ method: 'GET', url: '/api/history/imported' })).statusCode, 401);
    const response = await server.inject({
      method: 'GET', url: '/api/history/imported?workspace=demo', headers: { authorization: 'Test user' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().count, 0);
  } finally {
    await server.close();
    h.close();
  }
});
