import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeMinimaxTokens, scanMinimaxHistory, runMinimaxHistory } from '../src/services/minimax-history.js';
import { historyTotal } from '../src/services/history-total.js';
import { setSetting } from '../src/db/repos/system.js';
import { createHarness, importCsv } from './helpers.js';

const usage = { input: 10, output: 4, cacheRead: 20, cacheWrite: 5, totalTokens: 39 };
const row = (id: string, extra = {}) => ({ message_id: id, turn_id: 'same-turn', message: {
  role: 'assistant', model: 'MiniMax-M3.1-Flash-Preview', timestamp: 1790511774044,
  content: [{ type: 'text', text: 'PRIVATE_CONVERSATION' }], usage, ...extra,
} });
async function fixture() {
  const minimaxHome = await mkdtemp(join(tmpdir(), 'aicc-minimax-'));
  const dir = join(minimaxHome, 'v2', 'sessions', '2026', '09', '27', 'session-one');
  await mkdir(join(dir, 'snapshots'), { recursive: true });
  const file = join(dir, 'messages.jsonl');
  const content = [row('one'), row('one'), row('two'), row('conflict'), row('conflict', { usage: { ...usage, output: 5, totalTokens: 40 } }),
    row('user', { role: 'user' }), row('bad', { usage: { ...usage, totalTokens: 100 } }), row('no-usage', { usage: undefined })]
    .map(x => JSON.stringify(x)).join('\n') + '\n{unfinished';
  await writeFile(file, content);
  await writeFile(join(dir, 'snapshots', 'messages.jsonl'), JSON.stringify(row('snapshot')));
  await writeFile(join(dir, 'display.jsonl'), JSON.stringify(row('projection')));
  return { minimaxHome, file, content };
}

test('MiniMax cache components are input subsets after normalization; unknown is never zero', () => {
  assert.deepEqual(normalizeMinimaxTokens(usage), { inputTokens: 35, outputTokens: 4, cachedInputTokens: 20, reasoningOutputTokens: null, totalTokens: 39 });
  assert.equal(normalizeMinimaxTokens({ totalTokens: 15 })?.inputTokens, null);
  assert.equal(normalizeMinimaxTokens({ totalTokens: 15 })?.totalTokens, 15);
  for (const bad of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) assert.equal(normalizeMinimaxTokens({ ...usage, input: bad }), null);
  assert.equal(normalizeMinimaxTokens({ ...usage, totalTokens: 99 }), null);
  assert.equal(normalizeMinimaxTokens({ ...usage, input: Number.MAX_SAFE_INTEGER }), null);
});

test('MiniMax counts calls within one turn, dedupes messages, excludes conflicts/snapshots and preserves source', async () => {
  const f = await fixture();
  try {
    const result = await scanMinimaxHistory(f);
    assert.equal(result.status, 'ok'); assert.equal(result.totals.totalTokens, 78);
    assert.equal(result.sessionCount, 1);
    assert.equal(result.byModel[0]?.totals.totalTokens, 78);
    assert.equal(result.byDay[0]?.day, '2026-09-27');
    assert.ok(result.warnings.some(x => x.includes('冲突')));
    assert.ok(result.warnings.some(x => x.includes('损坏')));
    assert.ok(!JSON.stringify(result).includes('PRIVATE_CONVERSATION'));
    assert.ok(!JSON.stringify(result).includes(f.minimaxHome));
    assert.deepEqual((await scanMinimaxHistory(f)).totals, result.totals);
    assert.equal(await readFile(f.file, 'utf8'), f.content);
    assert.ok((await scanMinimaxHistory({ ...f, maxRecords: 1 })).warnings.some(x => x.includes('上限')));
    assert.equal((await scanMinimaxHistory({ minimaxHome: join(f.minimaxHome, 'missing') })).totals.totalTokens, null);
  } finally { await rm(f.minimaxHome, { recursive: true, force: true }); }
});

test('MiniMax routes enforce auth/workspace and overlapping imports keep the client out of totals', async () => {
  const f = await fixture(); const h = await createHarness();
  try {
    await runMinimaxHistory(h.app.ctx, f);
    for (const method of ['GET', 'POST'] as const) {
      assert.equal((await h.anonymous(method, '/api/history/minimax')).status, 401);
      assert.equal((await h.request(method, '/api/history/minimax?workspace=demo')).status, 403);
    }
    assert.equal((await h.request('GET', '/api/history/minimax')).status, 200);
    assert.equal(historyTotal(h.app.ctx).totalTokens, 78);
    assert.ok(!historyTotal(h.app.ctx, 'demo').sources.some(x => x.id === 'minimax'));
    const account = await h.request<{account: {id: string}}>('POST', '/api/accounts', { provider: 'MiniMax', alias: 'test', currency: 'USD' });
    await importCsv(h, 'minimax.csv', 'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens\n2026-09-27T00:00:00Z,api-request,MiniMax-M3.1,10,1,11', { accountId: account.body.account.id });
    const total = historyTotal(h.app.ctx);
    assert.equal(total.totalTokens, 11);
    assert.equal(total.sources.find(x => x.id === 'minimax')?.included, false);
    assert.ok(total.sources.find(x => x.id === 'minimax')?.reason?.includes('重叠'));
  } finally { h.close(); await rm(f.minimaxHome, { recursive: true, force: true }); }
});

test('MiniMax overlap with other client model history is visibly excluded', async () => {
  const f = await fixture(); const h = await createHarness();
  try {
    const result = await runMinimaxHistory(h.app.ctx, f);
    setSetting(h.app.db, 'history.opencode', JSON.stringify({ schemaVersion: 1, ...result }));
    const total = historyTotal(h.app.ctx);
    assert.equal(total.totalTokens, 78);
    assert.equal(total.sources.find(x => x.id === 'minimax')?.included, false);
  } finally { h.close(); await rm(f.minimaxHome, { recursive: true, force: true }); }
});
