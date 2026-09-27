import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeOpencodeTokens, scanOpencodeHistory, runOpencodeHistory } from '../src/services/opencode-history.js';
import { historyTotal } from '../src/services/history-total.js';
import { createHarness, importCsv } from './helpers.js';

const tokens = { input: 10, output: 4, reasoning: 2, cache: { read: 20, write: 5 }, total: 41 };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'aicc-local-clients-'));
  const databasePath = join(dir, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
  const message = db.prepare('INSERT INTO message VALUES(?,?,?,?)');
  const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
  const at = Date.parse('2026-09-26T01:00:00Z');
  message.run('m1', 's1', at, JSON.stringify({ role: 'assistant', modelID: 'model-one', tokens, finish: 'stop', content: 'SECRET' }));
  // Two steps are both counted; the containing message is not counted again.
  for (const id of ['p1', 'p2']) part.run(id, 'm1', 's1', at, JSON.stringify({ type: 'step-finish', reason: 'tool-calls', tokens }));
  message.run('m2', 's2', at, JSON.stringify({ role: 'assistant', modelID: 'model-two', finish: 'stop', tokens }));
  message.run('m3', 's2', at, JSON.stringify({ role: 'assistant', finish: 'unknown', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  message.run('m4', 's2', at, JSON.stringify({ role: 'user', tokens }));
  message.run('broken', 's2', at, '{broken');
  db.close();
  return { dir, databasePath };
}

test('OpenCode normalizes cache and reasoning into inclusive totals exactly once', () => {
  assert.deepEqual(normalizeOpencodeTokens({ input: 10, output: 4, reasoning: 2, cache_read: 20, cache_write: 5, total: 41 }), {
    inputTokens: 35, outputTokens: 6, cachedInputTokens: 20, reasoningOutputTokens: 2, totalTokens: 41,
  });
  assert.equal(normalizeOpencodeTokens({ total: 15 }).totalTokens, 15);
  assert.equal(normalizeOpencodeTokens({ total: -1 }).totalTokens, null);
});

test('OpenCode counts steps or fallback message, skips unknown placeholders, preserves read-only DB', async () => {
  const f = await fixture();
  try {
    const first = await scanOpencodeHistory(f);
    const second = await scanOpencodeHistory(f);
    assert.equal(first.status, 'ok');
    assert.equal(first.totals.totalTokens, 123);
    assert.deepEqual(first.totals, second.totals);
    assert.equal(first.sessionCount, 2);
    assert.equal(first.byModel.length, 2);
    assert.equal(first.byDay[0]?.totals.totalTokens, 123);
    assert.ok(first.warnings.some(x => x.includes('损坏')));
    assert.ok(first.warnings.some(x => x.includes('占位')));
    assert.ok(!JSON.stringify(first).includes('SECRET'));
    const db = new DatabaseSync(f.databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS n FROM message').get()?.n, 5); db.close();
    const limited = await scanOpencodeHistory({ ...f, maxRecords: 1 });
    assert.ok(limited.warnings.some(x => x.includes('上限')));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('Missing OpenCode database stays unknown and is never created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aicc-opencode-missing-'));
  try {
    const missing = await scanOpencodeHistory({ databasePath: join(dir, 'missing.db') });
    assert.equal(missing.status, 'error'); assert.equal(missing.totals.totalTokens, null);
    const { readdir } = await import('node:fs/promises');
    assert.ok(!(await readdir(dir)).includes('missing.db'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OpenCode history enforces auth/workspace, persists, aggregates and excludes matching imports', async () => {
  const h = await createHarness(); const f = await fixture();
  try {
    await runOpencodeHistory(h.app.ctx, f);
    for (const method of ['GET', 'POST'] as const) {
      assert.equal((await h.anonymous(method, '/api/history/opencode')).status, 401);
      assert.equal((await h.request(method, '/api/history/opencode?workspace=demo')).status, 403);
    }
    const account = await h.request<{account: {id: string}}>('POST', '/api/accounts', { provider: 'OpenCode', alias: 'test', currency: 'USD' });
    await importCsv(h, 'opencode.csv', 'occurred_at,request_id,model,input_tokens,output_tokens,total_tokens\n2026-09-26T00:00:00Z,request,model,10,1,11', { accountId: account.body.account.id });
    const total = historyTotal(h.app.ctx);
    assert.equal(total.totalTokens, 123);
    assert.equal(total.sources.some(x => x.id === 'doubao'), false);
    assert.equal(total.sources.find(x => x.id === 'imported:OpenCode')?.included, false);
    assert.ok(!historyTotal(h.app.ctx, 'demo').sources.some(x => x.id === 'opencode'));
    assert.equal((await h.request('GET', '/api/history/opencode')).status, 200);
  } finally { h.close(); await rm(f.dir, { recursive: true, force: true }); }
});
