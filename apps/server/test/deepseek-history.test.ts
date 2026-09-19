import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { getSetting } from '../src/db/repos/system.js';
import { errorBody, toApiError } from '../src/http/errors.js';
import { registerDeepseekHistoryRoutes } from '../src/http/routes/deepseek-history.js';
import {
  getDeepseekHistory,
  runDeepseekHistory,
  scanDeepseekHistory,
} from '../src/services/deepseek-history.js';
import { createHarness } from './helpers.js';

const AMOUNT_HEADER = 'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount';
const COST_HEADER = 'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency';
const time = ['2025-01-02T00:00:00+08:00', '2025-01-03T00:00:00+08:00', 'deepseek-chat'];

function amount(type: string, price: string, value: string, apiKey = 'secret-key'): string {
  return ['private-user', ...time, 'private-name', apiKey, type, price, value].join(',');
}

function cost(wallet: string, value: string): string {
  return ['private-user', ...time, wallet, value, 'CNY'].join(',');
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aicc-deepseek-history-'));
  const amountOne = [
    AMOUNT_HEADER,
    amount('input_cache_hit_tokens', '0.1', '10'),
    amount('input_cache_hit_tokens', '0.2', '3'),
    amount('input_cache_miss_tokens', '0.3', '20'),
    amount('output_tokens', '0.4', '5'),
    amount('request_count', '', '2'),
  ].join('\n');
  const costOne = [
    COST_HEADER,
    cost('Paid', '0.1000000000000001'),
    cost('Granted', '0.2000000000000002'),
  ].join('\n');
  await writeFile(join(directory, 'usage_data_2025-01-01_2025-01-31.zip'), zipSync({
    'amount-2025-01-01_2025-01-31.csv': strToU8(amountOne),
    'cost-2025-01-01_2025-01-31.csv': strToU8(costOne),
    'nested/ignored.csv': strToU8('not,read'),
    'ignored.txt': strToU8('not read'),
  }));

  // 第二份导出包含真正的跨 ZIP 重复、同 bucket 冲突，以及未知类型。
  const amountTwo = [
    AMOUNT_HEADER,
    amount('input_cache_hit_tokens', '0.1', '10'),
    amount('input_cache_hit_tokens', '0.1', '11'),
    amount('future_token_type', '1', '999'),
  ].join('\n');
  const costTwo = [
    COST_HEADER,
    cost('Paid', '0.1000000000000001'),
    cost('Granted', '0.9'),
  ].join('\n');
  await writeFile(join(directory, 'usage_data_2025-03-01_2025-03-31.zip'), zipSync({
    'amount-2025-03-01_2025-03-31.csv': strToU8(amountTwo),
    'cost-2025-03-01_2025-03-31.csv': strToU8(costTwo),
  }));
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'nested', 'amount.csv'), `${AMOUNT_HEADER}\n${amount('output_tokens', '1', '99999')}`);
  return directory;
}

test('DeepSeek 导出扫描精确汇总、跨 ZIP 去重、冲突保留首次值且不读取子目录', async () => {
  const directory = await fixtureDirectory();
  try {
    const result = await scanDeepseekHistory({ directory, now: () => Date.UTC(2026, 8, 19) });
    assert.equal(result.status, 'ok');
    assert.equal(result.fileCount, 2);
    assert.deepEqual(result.totals, {
      inputTokens: 33,
      cachedInputTokens: 13,
      outputTokens: 5,
      totalTokens: 38,
      requestCount: 2,
    });
    assert.deepEqual(result.costs, [{ currency: 'CNY', amount: '0.3000000000000003' }]);
    assert.equal(result.firstAt, '2025-01-01T16:00:00.000Z');
    assert.equal(result.lastAt, '2025-01-02T16:00:00.000Z');
    assert.deepEqual(result.byModel, [{ model: 'deepseek-chat', totals: result.totals }]);
    assert.deepEqual(result.byDay, [{ day: '2025-01-02', totals: result.totals }]);
    assert.match(result.message, /2025-01-01 至 2025-03-31/);
    assert.match(result.message, /范围空档/);
    assert.ok(result.warnings.some((warning) => warning.includes('用量 bucket')));
    assert.ok(result.warnings.some((warning) => warning.includes('消费 bucket')));
    assert.ok(result.warnings.some((warning) => warning.includes('无法识别')));
    assert.ok(result.warnings.some((warning) => warning.includes('日期范围空档')));
    assert.doesNotMatch(JSON.stringify(result), /private-user|secret-key|private-name|aicc-deepseek-history/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺失 token 类型保持 null 或明确的已知部分，不伪造 0', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aicc-deepseek-partial-'));
  try {
    await writeFile(join(directory, 'amount-2025-01-01_2025-01-31.csv'), [
      AMOUNT_HEADER,
      amount('request_count', '', '7'),
    ].join('\n'));
    const requestOnly = await scanDeepseekHistory({ directory });
    assert.deepEqual(requestOnly.totals, {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      requestCount: 7,
    });

    await writeFile(join(directory, 'amount-2025-02-01_2025-02-28.csv'), [
      AMOUNT_HEADER,
      ['private-user', ...time, 'private-name', 'secret-key-2', 'input_cache_hit_tokens', '0.1', '4'].join(','),
    ].join('\n'));
    const partial = await scanDeepseekHistory({ directory });
    assert.equal(partial.totals.inputTokens, 4);
    assert.equal(partial.totals.cachedInputTokens, 4);
    assert.equal(partial.totals.outputTokens, null);
    assert.equal(partial.totals.totalTokens, 4);
    assert.ok(partial.warnings.some((warning) => warning.includes('一种输入')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ZIP 条目数超过安全上限时在解压阶段拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aicc-deepseek-limit-'));
  try {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < 101; index += 1) entries[`ignored-${index}.txt`] = strToU8('ignored');
    await writeFile(join(directory, 'usage_data_2025-01-01_2025-01-31.zip'), zipSync(entries));
    const result = await scanDeepseekHistory({ directory });
    assert.equal(result.status, 'error');
    assert.match(result.message, /ZIP 条目数超过安全限制/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('成功扫描只缓存脱敏聚合，后续失败不覆盖最近成功结果', async () => {
  const h = await createHarness();
  const directory = await fixtureDirectory();
  try {
    const result = await runDeepseekHistory(h.app.ctx, { directory });
    assert.equal(result.status, 'ok');
    const stored = getSetting(h.app.db, 'history.deepseek') ?? '';
    assert.doesNotMatch(stored, /private-user|secret-key|private-name|aicc-deepseek-history/);
    assert.deepEqual(getDeepseekHistory(h.app.ctx), result);

    const failed = await runDeepseekHistory(h.app.ctx, { directory: join(directory, 'missing') });
    assert.equal(failed.status, 'error');
    assert.deepEqual(getDeepseekHistory(h.app.ctx), result);
  } finally {
    await rm(directory, { recursive: true, force: true });
    h.close();
  }
});

test('DeepSeek 历史路由要求用户会话、拒绝 demo 并设置 no-store', async () => {
  const h = await createHarness();
  const directory = await fixtureDirectory();
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
  registerDeepseekHistoryRoutes(server, { app: h.app, sessions: h.sessions, config: h.config });
  await server.ready();
  try {
    assert.equal((await server.inject({ method: 'GET', url: '/api/history/deepseek' })).statusCode, 401);
    const demo = await server.inject({
      method: 'POST',
      url: '/api/history/deepseek?workspace=demo',
      headers: { authorization: 'Test user' },
      payload: { directory },
    });
    assert.equal(demo.statusCode, 400);

    const scan = await server.inject({
      method: 'POST',
      url: '/api/history/deepseek',
      headers: { authorization: 'Test user' },
      payload: { directory },
    });
    assert.equal(scan.statusCode, 200);
    assert.equal(scan.headers['cache-control'], 'no-store');
    assert.equal(scan.json().status, 'ok');

    const get = await server.inject({
      method: 'GET', url: '/api/history/deepseek', headers: { authorization: 'Test user' },
    });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers['cache-control'], 'no-store');
    assert.equal(get.json().totals.totalTokens, 38);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
    h.close();
  }
});
