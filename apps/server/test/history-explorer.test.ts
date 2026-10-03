import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExplorerList, ExplorerSession, ExplorerWorkspace, HistorySnapshot } from '@aicc/core';
import { createHarness } from './helpers.js';
import { attachDetails, DetailBuilder, directoryIdentity } from '../src/services/history-detail-store.js';
import { saveHistoryAttempt } from '../src/services/history-cache.js';
import { explorerSessions, explorerWorkspaces, explorerAnalytics } from '../src/services/history-explorer.js';
import { runCodexHistory } from '../src/services/codex-history.js';
import { runOpencodeHistory } from '../src/services/opencode-history.js';
import { runWorkbuddyHistory } from '../src/services/workbuddy-history.js';
import { runMinimaxHistory } from '../src/services/minimax-history.js';
import { createBackup, planRestore, restoreToEmptyPath } from '../src/services/backup.js';
import { openDatabase, migrate } from '../src/db/database.js';
import { createServiceContext } from '../src/service-context.js';
import { MIGRATIONS } from '../src/db/schema.js';
import { unavailableAccountUsage } from '../src/collectors/codex-account-usage.js';
import { seedDemo, resetDemo } from '../src/services/demo.js';
import { setSetting } from '../src/db/repos/system.js';

const at = '2026-10-03T12:00:00.000Z';
const tokens = (input = 100, output = 20, cached: number | null = 50) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: null, totalTokens: input + output });
function snapshot(): HistorySnapshot {
  return { status: 'ok', checkedAt: at, totals: tokens(200, 40), firstAt: at, lastAt: at,
    byDay: [], byModel: [{ model: 'test', totals: tokens() }], warnings: [], message: 'fixture' };
}
function populate(ctx: Parameters<typeof saveHistoryAttempt>[0], source = 'workbuddy', directory = 'D:\\Projects\\Alpha\\') {
  const builder = new DetailBuilder();
  builder.metadata('shared-id', '标题：Alpha', directory);
  builder.metadata('shared-id', 'later title', 'D:\\wrong-directory');
  builder.add('shared-id', 'model-a', '2026-10-01T23:55:00Z', tokens());
  builder.add('shared-id', 'model-b', '2026-10-02T00:05:00Z', tokens(200, 40, null));
  builder.metadata('unknown-time', null, directory);
  builder.add('unknown-time', 'model-a', null, tokens(80, 10, 0));
  saveHistoryAttempt(ctx, `history.${source}`, source === 'codex' ? 2 : 1, attachDetails(snapshot(), builder), 'D:\\fixture');
  return builder;
}
test('directory identity is lexical, Windows case-insensitive and keeps subdirectories/worktrees separate', () => {
  assert.equal(directoryIdentity('D:/Projects/Alpha/')?.normalized, directoryIdentity('d:\\projects\\alpha')?.normalized);
  assert.notEqual(directoryIdentity('D:/Projects/Alpha/sub')?.normalized, directoryIdentity('D:/Projects/Alpha')?.normalized);
  assert.notEqual(directoryIdentity('/Projects/Alpha')?.normalized, directoryIdentity('/projects/alpha')?.normalized);
  assert.equal(directoryIdentity('relative-folder'), null);
  assert.equal(directoryIdentity('BAD\nPATH'), null);
});
test('session, directory and analysis aggregates reconcile under crossed filters without leaking to overview', async () => {
  const h = await createHarness();
  try {
    populate(h.app.ctx); populate(h.app.ctx, 'opencode', 'd:/projects/alpha');
    const sessions = await h.request<ExplorerList<ExplorerSession>>('GET', '/api/history/sessions');
    assert.equal(sessions.status, 200); assert.equal(sessions.headers['cache-control'], 'no-store');
    assert.equal(sessions.body.total, 4); assert.equal(sessions.body.summary.totals.totalTokens, 900);
    assert.equal(new Set(sessions.body.items.map(s => s.id)).size, 4);
    assert.equal(sessions.body.items[0]!.directory, 'D:\\Projects\\Alpha');
    const workspaces = explorerWorkspaces(h.app.ctx, 'real', {});
    assert.equal(workspaces.total, 1); assert.equal(workspaces.items[0]!.sessionCount, 4);
    assert.equal(workspaces.summary.totals.totalTokens, sessions.body.summary.totals.totalTokens);
    const filter = { from: '2026-10-02', to: '2026-10-02', model: 'model-b', workspaceId: workspaces.items[0]!.id };
    const filtered = explorerSessions(h.app.ctx, 'real', filter);
    const analysis = explorerAnalytics(h.app.ctx, 'real', filter);
    assert.equal(filtered.total, 2); assert.equal(filtered.summary.totals.totalTokens, 480);
    assert.equal(analysis.summary.totals.totalTokens, 480);
    assert.equal(analysis.trend[0]!.totals.totalTokens, 480);
    assert.equal(analysis.matrix.rows[0]!.totalTokens, 480);
    assert.equal(analysis.summary.coverage.cachedInputTokens, 'unknown');
    const partial = explorerAnalytics(h.app.ctx, 'real', {});
    assert.equal(partial.summary.cacheInputSample!.inputTokens, 360);
    assert.equal(partial.summary.cacheInputSample!.cachedInputTokens, 100);
    assert.equal(partial.summary.cacheInputSample!.matchedRecords, 4);
    assert.equal(partial.summary.cacheInputSample!.totalRecords, 6);
    assert.equal(partial.context.unknownDateRecords, 2);
    assert.equal(explorerAnalytics(h.app.ctx, 'real', { from: '2026-10-01' }).summary.totals.totalTokens, 720);
    const detail = await h.request<{session:ExplorerSession}>('GET', `/api/history/sessions/${filtered.items[0]!.id}?from=2026-10-02`);
    assert.equal(detail.status, 200); assert.equal(detail.body.session.totals.totalTokens, 240);
    const wkDetail = await h.request<{workspace:ExplorerWorkspace}>('GET', `/api/history/workspaces/${workspaces.items[0]!.id}`);
    assert.equal(wkDetail.status, 200); assert.equal(wkDetail.body.workspace.totals.totalTokens, 900);
    assert.equal(explorerSessions(h.app.ctx, 'real', { q: '标题' }).total, 2);
    assert.equal(explorerSessions(h.app.ctx, 'real', { q: '%' }).total, 0);
    assert.equal(explorerSessions(h.app.ctx, 'real', { q: "' OR 1=1 --" }).total, 0);
    const overview = await h.request('GET', '/api/history/dashboard');
    assert.doesNotMatch(JSON.stringify(overview.body), /标题|shared-id|Projects|sourceSessionId/);
    for (const path of ['/api/history/sessions', '/api/history/workspaces', '/api/history/analytics', `/api/history/sessions/${filtered.items[0]!.id}`]) {
      assert.equal((await h.anonymous('GET', path)).status, 401);
    }
    assert.equal((await h.request('GET', '/api/history/sessions?from=2026-02-30')).status, 400);
    assert.equal((await h.request('GET', '/api/history/sessions?from=2026-10-03&to=2026-10-01')).status, 400);
    assert.equal((await h.request('GET', '/api/history/sessions?sort=sql')).status, 400);
    assert.equal((await h.request('GET', '/api/history/sessions?workspace=all')).status, 400);
    assert.equal((await h.request('GET', `/api/history/sessions/${filtered.items[0]!.id}?workspace=demo`)).status, 404);
  } finally { h.close(); }
});
test('paging and sorting are server-side, summary covers all rows, period buckets start Monday', async () => {
  const h = await createHarness();
  try {
    const b = new DetailBuilder();
    for (let i = 0; i < 72; i++) b.add(`s-${i.toString().padStart(3, '0')}`, 'm', '2026-10-04T00:00:00Z', tokens(i, 1));
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails(snapshot(), b), 'D:\\fixture');
    const first = explorerSessions(h.app.ctx, 'real', { sort: 'tokens' });
    const second = explorerSessions(h.app.ctx, 'real', { sort: 'tokens', page: 2 });
    assert.equal(first.items.length, 50); assert.equal(second.items.length, 22);
    assert.equal(first.items[0]!.sourceSessionId, 's-071');
    assert.equal(first.summary.totals.totalTokens, second.summary.totals.totalTokens);
    assert.equal(explorerAnalytics(h.app.ctx, 'real', { granularity: 'week' }).trend[0]!.period, '2026-09-28');
    assert.equal(explorerAnalytics(h.app.ctx, 'real', { granularity: 'month' }).trend[0]!.period, '2026-10');
    assert.equal(explorerSessions(h.app.ctx, 'real', { page: 9999 }).page, 2);
  } finally { h.close(); }
});
test('successful replacement, failed retention, changed scope and transaction rollback are atomic', async () => {
  const h = await createHarness();
  try {
    const b = populate(h.app.ctx);
    const before = explorerSessions(h.app.ctx, 'real', {});
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, { ...snapshot(), status: 'error' }, 'D:\\fixture');
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).summary.totals.totalTokens, 450);
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).context.sources.find(s => s.id === 'workbuddy')!.sync.stale, true);
    h.app.db.exec("CREATE TRIGGER detail_fail BEFORE INSERT ON history_detail_bucket BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(() => saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails(snapshot(), b), 'D:\\fixture'), /rollback/);
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).summary.totals.totalTokens, before.summary.totals.totalTokens);
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).context.sources.find(s => s.id === 'workbuddy')!.sync.stale, true);
    h.app.db.exec('DROP TRIGGER detail_fail');
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails(snapshot(), b), 'D:\\fixture');
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).total, 2);
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, { ...snapshot(), status: 'error' }, 'D:\\other');
    assert.equal(explorerSessions(h.app.ctx, 'real', { source: 'workbuddy' }).total, 0);
    populate(h.app.ctx);
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails({ ...snapshot(), status: 'empty' }, new DetailBuilder()), 'D:\\fixture');
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).total, 0);
  } finally { h.close(); }
});
test('signed corrections and unsafe sums stay honest', async () => {
  const h = await createHarness();
  try {
    const b = new DetailBuilder();
    b.add('s', 'm', '2026-10-01T00:00:00Z', tokens());
    b.add('s', 'm', '2026-10-02T00:00:00Z', { inputTokens: -10, outputTokens: 15, totalTokens: 5, cachedInputTokens: -2 });
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails(snapshot(), b), 'D:\\fixture');
    assert.equal(explorerAnalytics(h.app.ctx, 'real', {}).summary.totals.inputTokens, 90);
    assert.equal(explorerAnalytics(h.app.ctx, 'real', { from: '2026-10-02' }).summary.totals.inputTokens, -10);
    assert.equal(explorerAnalytics(h.app.ctx, 'real', {}).summary.cacheInputSample!.matchedRecords, 1);
    const overflow = new DetailBuilder();
    overflow.add('s1', 'm', at, { totalTokens: Number.MAX_SAFE_INTEGER });
    overflow.add('s2', 'm', at, { totalTokens: Number.MAX_SAFE_INTEGER });
    saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails(snapshot(), overflow), 'D:\\fixture');
    assert.equal(explorerAnalytics(h.app.ctx, 'real', {}).summary.totals.totalTokens, null);
  } finally { h.close(); }
});
test('demo seed, purge and backup restore isolate and preserve local metadata', async () => {
  const h = await createHarness();
  try {
    populate(h.app.ctx); seedDemo(h.app.ctx);
    const demo = explorerSessions(h.app.ctx, 'demo', {});
    assert.equal(demo.total, 72); assert.doesNotMatch(JSON.stringify(demo), /Projects|shared-id|标题/);
    resetDemo(h.app.ctx);
    assert.equal(explorerSessions(h.app.ctx, 'demo', {}).total, 0);
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).total, 2);
    const backup = createBackup(h.app.ctx);
    const plan = planRestore(h.app.ctx, backup.name), restored = join(h.dir, 'restored.sqlite');
    restoreToEmptyPath(plan, restored);
    const { db, driver } = openDatabase({ filePath: restored });
    try {
      migrate(db); const ctx = createServiceContext({ db, driver, config: h.config });
      assert.deepEqual(explorerSessions(ctx, 'real', {}), explorerSessions(h.app.ctx, 'real', {}));
    } finally { db.close(); }
    const oldPath = join(h.dir, 'v1.sqlite'), old = openDatabase({ filePath: oldPath }).db;
    try {
      migrate(old, [MIGRATIONS[0]!]);
      migrate(old);
      assert.equal(old.prepare('SELECT COUNT(*) AS n FROM history_detail_session').get<{n:number}>()!.n, 0);
    } finally { old.close(); }
  } finally { h.close(); }
});
test('real collector fixtures index explicit metadata and never cache message bodies or source file paths', async () => {
  const h = await createHarness();
  try {
    const opPath = join(h.dir, 'op.db'), db = new DatabaseSync(opPath);
    db.exec('CREATE TABLE session(id TEXT,title TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
    db.prepare('INSERT INTO session VALUES(?,?,?)').run('s', '明确的标题', 'D:/Projects/Alpha');
    db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m', 's', Date.parse(at), JSON.stringify({ role: 'assistant', modelID: 'test', finish: 'stop', content: 'SECRET_BODY', tokens: { input: 50, output: 20, cache: { read: 50, write: 0 }, reasoning: 0, total: 120 } }));
    db.close(); const bytes = readFileSync(opPath); await runOpencodeHistory(h.app.ctx, { databasePath: opPath });
    assert.deepEqual(readFileSync(opPath), bytes);
    const wb = join(h.dir, 'wb'); mkdirSync(join(wb, 'projects'), { recursive: true });
    writeFileSync(join(wb, 'projects', 'events.jsonl'), JSON.stringify({ type: 'message', role: 'assistant', id: 'm', sessionId: 's', title: 'WorkBuddy 标题', cwd: 'd:/projects/alpha', timestamp: at,
      message: { content: 'SECRET_BODY', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_input_tokens: 50 } }, providerData: { model: 'test', messageId: 'm' } }));
    await runWorkbuddyHistory(h.app.ctx, { workbuddyHome: wb });
    const mm = join(h.dir, 'mm'), mmSession = join(mm, 'v2/sessions/2026/10/03/s'); mkdirSync(mmSession, { recursive: true });
    writeFileSync(join(mmSession, 'messages.jsonl'), [JSON.stringify({ type: 'session', title: 'MiniMax 标题', cwd: 'D:\\Projects\\Alpha' }), JSON.stringify({ message_id: 'm', message: { role: 'assistant', content: 'SECRET_BODY', model: 'test', timestamp: at, usage: { input: 50, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 120 } } })].join('\n'));
    await runMinimaxHistory(h.app.ctx, { minimaxHome: mm });
    for (const source of ['opencode', 'workbuddy', 'minimax'] as const) {
      const data = explorerSessions(h.app.ctx, 'real', { source });
      assert.equal(data.items[0]!.totals.totalTokens, 120); assert.ok(data.items[0]!.title); assert.ok(data.items[0]!.directory);
      assert.doesNotMatch(JSON.stringify(data), /SECRET_BODY|events\.jsonl|messages\.jsonl|op\.db/);
    }
    assert.equal(explorerWorkspaces(h.app.ctx, 'real', {}).total, 1);
    const stored = h.app.db.prepare('SELECT value FROM app_settings').all<{value:string}>();
    assert.doesNotMatch(JSON.stringify(stored), /SECRET_BODY|明确的标题|WorkBuddy 标题|MiniMax 标题/);
  } finally { h.close(); }
});
test('Codex local index survives official success with local failure and is independent of overview choice', async () => {
  const h = await createHarness();
  try {
    const root = join(h.dir, 'codex'); mkdirSync(join(root, 'sessions'), { recursive: true });
    writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ id: 's', thread_name: 'Codex 明确标题' }));
    const path = join(root, 'sessions', 'rollout-test.jsonl');
    writeFileSync(path, [
      { type: 'session_meta', payload: { id: 's', cwd: 'D:/Projects/Alpha' }, timestamp: at },
      { type: 'turn_context', payload: { model: 'test' }, timestamp: at },
      { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, total_tokens: 120 } } } },
    ].map(r => JSON.stringify(r)).join('\n'));
    const official = async () => ({ ...unavailableAccountUsage('fixture'), status: 'ok' as const, summary: { lifetimeTokens: 9999, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null });
    await runCodexHistory(h.app.ctx, { codexHome: root, readOfficial: official });
    const before = explorerSessions(h.app.ctx, 'real', {});
    assert.equal(before.summary.totals.totalTokens, 120); assert.equal(before.items[0]!.title, 'Codex 明确标题');
    setSetting(h.app.db, 'codex.statisticsSource', 'local');
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).summary.totals.totalTokens, 120);
    setSetting(h.app.db, 'codex.statisticsSource', 'official');
    renameSync(join(root, 'sessions'), join(root, 'hidden-sessions'));
    await runCodexHistory(h.app.ctx, { codexHome: root, readOfficial: official });
    const retained = explorerSessions(h.app.ctx, 'real', {});
    assert.equal(retained.summary.totals.totalTokens, 120);
    assert.equal(retained.context.sources.find(s => s.id === 'codex')!.sync.stale, true);
    renameSync(join(root, 'hidden-sessions'), join(root, 'sessions'));
    unlinkSync(path); writeFileSync(path, 'broken'); // successful zero-usage scan is empty; use inaccessible new root for scope protection below
    await runCodexHistory(h.app.ctx, { codexHome: join(h.dir, 'missing'), readOfficial: official });
    assert.equal(explorerSessions(h.app.ctx, 'real', { source: 'codex' }).total, 0);
  } finally { h.close(); }
});
test('excluded source stays independently queryable without changing inclusion', async () => {
  const h = await createHarness();
  try {
    populate(h.app.ctx, 'minimax');
    setSetting(h.app.db, 'history.opencode', JSON.stringify({ schemaVersion: 1, ...snapshot(), byModel: [{model:'minimax-test', totals:tokens()}] }));
    assert.equal(explorerSessions(h.app.ctx, 'real', {}).total, 0);
    const standalone = explorerSessions(h.app.ctx, 'real', { source: 'minimax' });
    assert.equal(standalone.total, 2); assert.equal(standalone.context.sources.find(s => s.id === 'minimax')!.included, false);
  } finally { h.close(); }
});
