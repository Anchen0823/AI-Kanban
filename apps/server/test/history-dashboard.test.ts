import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryDashboard } from '@aicc/core';
import { createHarness } from './helpers.js';
import { getOpencodeHistory, runOpencodeHistory } from '../src/services/opencode-history.js';
import { saveHistoryAttempt } from '../src/services/history-cache.js';
import { runWorkbuddyHistory, getWorkbuddyHistory } from '../src/services/workbuddy-history.js';
import { runMinimaxHistory, getMinimaxHistory } from '../src/services/minimax-history.js';

function fixture(path: string, rows = true): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
  if (rows) db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m1', 's1', Date.parse('2026-10-01T00:00:00Z'), JSON.stringify({ role: 'assistant', modelID: 'test-model', finish: 'stop', tokens: { input: 70, cache: { read: 30, write: 0 }, output: 20, reasoning: 0, total: 120 } }));
  db.close();
}

test('failed local scans retain the successful snapshot and time, then recover or accept a verified empty scan', async () => {
  const h = await createHarness();
  const path = join(h.dir, 'opencode.db');
  try {
    fixture(path);
    const success = await runOpencodeHistory(h.app.ctx, { databasePath: path });
    assert.equal(success.totals.totalTokens, 120);
    assert.equal(success.coverage?.cachedInputTokens, 'complete');
    const bytes = readFileSync(path);
    unlinkSync(path);
    const missing = await runOpencodeHistory(h.app.ctx, { databasePath: path });
    assert.equal(missing.status, 'error');
    let retained = getOpencodeHistory(h.app.ctx);
    assert.equal(retained.totals.totalTokens, 120);
    assert.equal(retained.checkedAt, success.checkedAt);
    assert.equal(retained.sync?.stale, true);
    writeFileSync(path, 'corrupt database');
    await runOpencodeHistory(h.app.ctx, { databasePath: path });
    assert.equal(getOpencodeHistory(h.app.ctx).totals.totalTokens, 120);
    // Permission failures and IO errors share the same failed-attempt persistence boundary.
    saveHistoryAttempt(h.app.ctx, 'history.opencode', 1, { ...missing, message: '无法读取数据库：访问权限不足' }, path);
    retained = getOpencodeHistory(h.app.ctx);
    assert.match(retained.sync!.lastAttempt!.message, /权限/);
    assert.equal(retained.sync?.lastSuccessAt, success.checkedAt);
    writeFileSync(path, bytes);
    const recovered = await runOpencodeHistory(h.app.ctx, { databasePath: path });
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.sync?.stale, false);
    unlinkSync(path); fixture(path, false);
    await runOpencodeHistory(h.app.ctx, { databasePath: path });
    assert.equal(getOpencodeHistory(h.app.ctx).status, 'empty');
    assert.equal(getOpencodeHistory(h.app.ctx).totals.totalTokens, null);
  } finally { h.close(); }
});

test('changed source configuration cannot inherit another path\'s successful snapshot', async () => {
  const h = await createHarness();
  try {
    const path = join(h.dir, 'opencode.db'); fixture(path);
    await runOpencodeHistory(h.app.ctx, { databasePath: path });
    await runOpencodeHistory(h.app.ctx, { databasePath: join(h.dir, 'other.db') });
    assert.equal(getOpencodeHistory(h.app.ctx).totals.totalTokens, null);
    assert.equal(getOpencodeHistory(h.app.ctx).sync?.lastSuccessAt, null);
  } finally { h.close(); }
});

test('dashboard is cache-only, authenticated and workspace-isolated with matching total and source snapshots', async () => {
  const h = await createHarness();
  try {
    const path = join(h.dir, 'opencode.db'); fixture(path);
    await runOpencodeHistory(h.app.ctx, { databasePath: path });
    unlinkSync(path); // GET must not trigger another scan.
    const real = await h.request<HistoryDashboard>('GET', '/api/history/dashboard');
    assert.equal(real.status, 200);
    assert.equal(real.headers['cache-control'], 'no-store');
    assert.equal(real.body.total.totalTokens, 120);
    assert.equal(real.body.local.opencode?.totals.totalTokens, 120);
    assert.equal(real.body.local.opencode?.sync?.stale, false);
    assert.equal((await h.anonymous('GET', '/api/history/dashboard')).status, 401);
    const demo = await h.request<HistoryDashboard>('GET', '/api/history/dashboard?workspace=demo');
    assert.deepEqual(demo.body.local, {});
    assert.equal(demo.body.total.totalTokens, null);
    assert.doesNotMatch(JSON.stringify(real.body), /opencode\.db|scope|s1|m1/);
  } finally { h.close(); }
});

test('JSONL sources preserve snapshots on inaccessible roots and mark partial per-record cache coverage', async () => {
  const h = await createHarness();
  try {
    const wb = join(h.dir, 'wb'), mini = join(h.dir, 'mini');
    mkdirSync(join(wb, 'projects'), { recursive: true });
    const wbRow = (id: string, cache: number | null) => ({ id, type: 'function_call', sessionId: 's1', timestamp: '2026-10-01T00:00:00Z', providerData: { messageId: id, model: 'fixture' }, message: { usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_input_tokens: cache } } });
    writeFileSync(join(wb, 'projects', 'session.jsonl'), [wbRow('a', 30), wbRow('b', null)].map(row => JSON.stringify(row)).join('\n'));
    const one = await runWorkbuddyHistory(h.app.ctx, { workbuddyHome: wb });
    assert.equal(one.coverage?.inputTokens, 'complete');
    assert.equal(one.coverage?.cachedInputTokens, 'partial');
    renameSync(join(wb, 'projects'), join(wb, 'temporarily-unavailable'));
    assert.equal((await runWorkbuddyHistory(h.app.ctx, { workbuddyHome: wb })).status, 'error');
    assert.equal(getWorkbuddyHistory(h.app.ctx).totals.totalTokens, 240);
    assert.equal(getWorkbuddyHistory(h.app.ctx).sync?.stale, true);
    const folder = join(mini, 'v2', 'sessions', '2026', '10', '01', 'session');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'messages.jsonl'), JSON.stringify({ message_id: 'one', message: { role: 'assistant', model: 'fixture', timestamp: '2026-10-01T00:00:00Z', usage: { input: 70, cacheRead: 30, cacheWrite: 0, output: 20, totalTokens: 120 } } }));
    await runMinimaxHistory(h.app.ctx, { minimaxHome: mini });
    renameSync(join(mini, 'v2'), join(mini, 'unavailable'));
    assert.equal((await runMinimaxHistory(h.app.ctx, { minimaxHome: mini })).status, 'error');
    assert.equal(getMinimaxHistory(h.app.ctx).totals.totalTokens, 120);
    assert.equal(getMinimaxHistory(h.app.ctx).sync?.stale, true);
  } finally { h.close(); }
});
