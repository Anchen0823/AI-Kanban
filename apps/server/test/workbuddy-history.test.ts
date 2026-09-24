import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkbuddyHistory, runWorkbuddyHistory } from '../src/services/workbuddy-history.js';
import { historyTotal } from '../src/services/history-total.js';
import { createHarness } from './helpers.js';

function row(id: string, input = 100, output = 10) {
  return { id, type: 'function_call', sessionId: 'session-one', timestamp: 1789479407668,
    arguments: 'SECRET_BODY', cwd: 'SECRET_PATH',
    providerData: { messageId: id, model: 'deepseek-fixture', traceId: 'shared-trace', rawUsage: { completion_tokens_details: { reasoning_tokens: 2 } } },
    message: { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, cache_read_input_tokens: 80 } } };
}
async function fixture(rows: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), 'aicc-workbuddy-'));
  await mkdir(join(home, 'projects', 'project'), { recursive: true });
  await writeFile(join(home, 'projects', 'project', 'session.jsonl'), rows.map(x => JSON.stringify(x)).join('\n'));
  return home;
}

test('WorkBuddy counts per-message usage, dedupes copied history, preserves cache subsets and no content', async () => {
  const home = await fixture([row('a'), row('b', 200, 20)]);
  try {
    await writeFile(join(home, 'projects', 'copy.jsonl'), JSON.stringify(row('a')) + '\n{partial');
    const result = await scanWorkbuddyHistory({ workbuddyHome: home });
    assert.equal(result.totals.totalTokens, 330);
    assert.equal(result.totals.inputTokens, 300);
    assert.equal(result.totals.cachedInputTokens, 160);
    assert.equal(result.totals.reasoningOutputTokens, 4);
    assert.equal(result.sessionCount, 1);
    assert.equal(result.byModel[0]?.totals.totalTokens, 330);
    assert.equal(result.byDay[0]?.totals.totalTokens, 330);
    assert.ok(result.warnings.some(x => x.includes('损坏')));
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    const limited = await scanWorkbuddyHistory({ workbuddyHome: home, maxFiles: 1 });
    assert.ok(limited.warnings.some(x => x.includes('数量限制')));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('WorkBuddy excludes conflicting IDs, invalid totals and non-assistant data', async () => {
  const home = await fixture([row('conflict'), row('conflict', 200),
    { ...row('user'), type: 'message', role: 'user' },
    { ...row('bad'), message: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 999 } } },
    { ...row('known'), message: { usage: { total_tokens: 50 } } }]);
  try {
    const result = await scanWorkbuddyHistory({ workbuddyHome: home });
    assert.equal(result.totals.totalTokens, 50);
    assert.equal(result.totals.inputTokens, null);
    assert.equal(result.totals.outputTokens, null);
    assert.ok(result.warnings.some(x => x.includes('冲突')));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('WorkBuddy overflow stays unknown; missing home is empty rather than zero', async () => {
  const home = await fixture([row('a', Number.MAX_SAFE_INTEGER, 0), row('b')]);
  try {
    const result = await scanWorkbuddyHistory({ workbuddyHome: home });
    assert.equal(result.totals.totalTokens, null);
    assert.ok(result.warnings.some(x => x.includes('安全整数')));
    const empty = await scanWorkbuddyHistory({ workbuddyHome: join(home, 'missing') });
    assert.equal(empty.status, 'empty');
    assert.equal(empty.totals.totalTokens, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('WorkBuddy persisted summary joins real total, isolates demo and rejects anonymous access', async () => {
  const home = await fixture([row('a')]);
  const h = await createHarness();
  try {
    const first = runWorkbuddyHistory(h.app.ctx, { workbuddyHome: home });
    assert.equal(first, runWorkbuddyHistory(h.app.ctx, { workbuddyHome: home }));
    await first;
    assert.equal(historyTotal(h.app.ctx).totalTokens, 110);
    assert.ok(!historyTotal(h.app.ctx, 'demo').sources.some(x => x.id === 'workbuddy'));
    for (const method of ['GET', 'POST'] as const) {
      assert.equal((await h.anonymous(method, '/api/history/workbuddy')).status, 401);
      assert.equal((await h.request(method, '/api/history/workbuddy?workspace=demo')).status, 403);
    }
    const got = await h.request<{ totals: { totalTokens: number } }>('GET', '/api/history/workbuddy');
    assert.equal(got.status, 200);
    assert.equal(got.body.totals.totalTokens, 110);
  } finally { h.close(); await rm(home, { recursive: true, force: true }); }
});
