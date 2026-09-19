import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting } from '../src/db/repos/system.js';
import { getCodexHistory, runCodexHistory, scanCodexHistory } from '../src/services/codex-history.js';
import { createHarness } from './helpers.js';

function line(type: string, payload: Record<string, unknown>, ordinal: number, timestamp: string): string {
  return JSON.stringify({ type, payload, ordinal, timestamp });
}

function usage(input: number, cached: number, output: number, reasoning: number, total: number): Record<string, unknown> {
  return {
    type: 'token_count',
    info: { total_token_usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: total,
    } },
    // 哨兵正文：扫描器不该读取、更不能把它带到缓存或响应。
    text: 'never-store-chat-body',
  };
}

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'aicc-codex-history-'));
  const live = join(home, 'sessions', '2026', '09', '19');
  const archived = join(home, 'archived_sessions', '2026', '09', '19');
  await Promise.all([mkdir(live, { recursive: true }), mkdir(archived, { recursive: true })]);

  const sessionA = [
    line('session_meta', { id: 'session-a' }, 0, '2026-09-18T00:00:00.000Z'),
    line('turn_context', { model: 'gpt-fixture-a' }, 1, '2026-09-18T00:01:00.000Z'),
    line('event_msg', usage(10, 2, 3, 1, 13), 2, '2026-09-18T00:02:00.000Z'),
    line('event_msg', usage(15, 4, 5, 2, 20), 3, '2026-09-18T00:03:00.000Z'),
  ].join('\n');
  // 同 session/ordinal 的归档备份不能把累计计数再加一次。
  await Promise.all([
    writeFile(join(live, 'rollout-live.jsonl'), sessionA, 'utf8'),
    writeFile(join(archived, 'rollout-copy.jsonl'), sessionA, 'utf8'),
  ]);

  const sessionB = [
    line('session_meta', { id: 'session-b' }, 0, '2026-09-19T00:00:00.000Z'),
    line('turn_context', { model: 'gpt-fixture-b' }, 1, '2026-09-19T00:01:00.000Z'),
    line('event_msg', usage(7, 1, 2, 1, 9), 2, '2026-09-19T00:02:00.000Z'),
    // 新段从更小的累计数开始：只补这一段的 2，不会把此前 7 再算一次。
    line('event_msg', usage(2, 0, 1, 0, 3), 3, '2026-09-19T00:03:00.000Z'),
    '{bad json',
  ].join('\n');
  await writeFile(join(live, 'rollout-reset.jsonl'), sessionB, 'utf8');

  const sessionC = [
    line('session_meta', { id: 'session-c', parent_session_id: 'session-a' }, 0, '2026-09-19T01:00:00.000Z'),
    line('turn_context', { model: 'gpt-fixture-c' }, 1, '2026-09-19T01:01:00.000Z'),
    // fork 会继承父会话的累计前缀；这两条与 session-a 完全相同。
    line('event_msg', usage(10, 2, 3, 1, 13), 2, '2026-09-18T00:02:00.000Z'),
    line('event_msg', usage(15, 4, 5, 2, 20), 3, '2026-09-18T00:03:00.000Z'),
    line('event_msg', usage(18, 5, 6, 3, 24), 4, '2026-09-19T01:03:00.000Z'),
  ].join('\n');
  await writeFile(join(live, 'rollout-fork.jsonl'), sessionC, 'utf8');

  const sessionD = [
    line('session_meta', { id: 'session-d', parent_session_id: 'session-c' }, 0, '2026-09-19T01:04:00.000Z'),
    line('turn_context', { model: 'gpt-fixture-d' }, 1, '2026-09-19T01:04:10.000Z'),
    // 三代分叉：D 继承 C 的完整累计轨迹，只有最后一条是自己的新增用量。
    line('event_msg', usage(10, 2, 3, 1, 13), 2, '2026-09-18T00:02:00.000Z'),
    line('event_msg', usage(15, 4, 5, 2, 20), 3, '2026-09-18T00:03:00.000Z'),
    line('event_msg', usage(18, 5, 6, 3, 24), 4, '2026-09-19T01:03:00.000Z'),
    line('event_msg', usage(20, 6, 7, 4, 27), 5, '2026-09-19T01:05:00.000Z'),
  ].join('\n');
  await writeFile(join(live, 'rollout-grandchild-fork.jsonl'), sessionD, 'utf8');

  const sessionE = [
    line('session_meta', { id: 'session-e' }, 0, '2026-09-19T02:00:00.000Z'),
    line('turn_context', { model: 'gpt-fixture-e' }, 1, '2026-09-19T02:01:00.000Z'),
    line('event_msg', usage(10, 0, 5, 0, 15), 2, '2026-09-19T02:02:00.000Z'),
    // output 被上游从 5 向下校正为 3，但 total 没重置；不能把 3 当作新段再加一次。
    line('event_msg', usage(12, 0, 3, 0, 15), 3, '2026-09-19T02:03:00.000Z'),
  ].join('\n');
  await writeFile(join(live, 'rollout-component-correction.jsonl'), sessionE, 'utf8');
  return home;
}

test('Codex 本机历史按 session 合并备份，累计计数取增量并处理重置', async () => {
  const home = await fixtureHome();
  try {
    const result = await scanCodexHistory({ codexHome: home, now: () => Date.parse('2026-09-20T00:00:00.000Z') });
    assert.equal(result.status, 'ok');
    assert.equal(result.sessionCount, 5);
    assert.deepEqual(result.totals, {
      inputTokens: 41,
      cachedInputTokens: 7,
      outputTokens: 13,
      reasoningOutputTokens: 5,
      totalTokens: 54,
    });
    assert.equal(result.firstAt, '2026-09-18T00:02:00.000Z');
    assert.equal(result.lastAt, '2026-09-19T02:03:00.000Z');
    assert.deepEqual(result.byModel.map((row) => [row.model, row.totals.totalTokens, row.sessionCount]), [
      ['gpt-fixture-a', 20, 1],
      ['gpt-fixture-b', 12, 1],
      ['gpt-fixture-c', 4, 1],
      ['gpt-fixture-d', 3, 1],
      ['gpt-fixture-e', 15, 1],
    ]);
    assert.deepEqual(result.byDay.map((row) => [row.day, row.totals.totalTokens]), [
      ['2026-09-18', 20],
      ['2026-09-19', 34],
    ]);
    assert.ok(result.warnings.some((warning) => /累计 token 计数重置/.test(warning)));
    assert.ok(result.warnings.some((warning) => /分项在总计数未重置时被上游向下修正/.test(warning)));
    assert.ok(result.warnings.some((warning) => /排除分叉继承前缀/.test(warning)));
    assert.ok(result.warnings.some((warning) => /无法解析/.test(warning)));
    assert.doesNotMatch(JSON.stringify(result), /never-store-chat-body/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('历史扫描缓存只保存聚合数字；未扫描时不把 token 报成 0', async () => {
  const home = await fixtureHome();
  const h = await createHarness();
  try {
    const before = getCodexHistory(h.app.ctx);
    assert.equal(before.status, 'not_scanned');
    assert.equal(before.totals.totalTokens, null);

    const scanned = await runCodexHistory(h.app.ctx, { codexHome: home });
    assert.equal(scanned.status, 'ok');
    assert.deepEqual(getCodexHistory(h.app.ctx), scanned);
    const saved = getSetting(h.app.db, 'history.codex') ?? '';
    assert.match(saved, /"totalTokens":54/);
    assert.doesNotMatch(saved, /never-store-chat-body|session-a|session-b/);
  } finally {
    h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('没有本机历史时明确是 error/unknown，不把没有记录说成 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aicc-codex-history-empty-'));
  try {
    const result = await scanCodexHistory({ codexHome: home });
    assert.equal(result.status, 'error');
    assert.equal(result.sessionCount, null);
    assert.equal(result.totals.totalTokens, null);
    assert.match(result.message, /没有把它当作 0 token/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('字段或时间缺失时保留 unknown，不伪装成完整的按日统计', async () => {
  const home = await mkdtemp(join(tmpdir(), 'aicc-codex-history-partial-'));
  try {
    const dir = join(home, 'sessions');
    await mkdir(dir, { recursive: true });
    const partial = [
      line('session_meta', { id: 'partial-session' }, 0, '2026-09-19T00:00:00.000Z'),
      line('turn_context', { model: 'gpt-partial' }, 1, '2026-09-19T00:01:00.000Z'),
      JSON.stringify({
        type: 'event_msg', ordinal: 2,
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 5 } } },
      }),
    ].join('\n');
    await writeFile(join(dir, 'rollout-partial.jsonl'), partial, 'utf8');
    const result = await scanCodexHistory({ codexHome: home });
    assert.equal(result.status, 'ok');
    assert.equal(result.totals.totalTokens, 5);
    assert.equal(result.totals.inputTokens, null);
    assert.deepEqual(result.byDay.map((row) => row.day), ['未知日期']);
    assert.ok(result.warnings.some((warning) => /缺少字段/.test(warning)));
    assert.ok(result.warnings.some((warning) => /未知日期/.test(warning)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('历史 API 只读缓存、禁止缓存，并拒绝匿名或 demo 工作区扫描', async () => {
  const h = await createHarness();
  try {
    const current = await h.request<{ status: string; totals: { totalTokens: number | null } }>('GET', '/api/history/codex');
    assert.equal(current.status, 200);
    assert.equal(current.headers['cache-control'], 'no-store');
    assert.equal(current.body.status, 'not_scanned');
    assert.equal(current.body.totals.totalTokens, null);
    assert.equal((await h.anonymous('POST', '/api/history/codex')).status, 401);
    assert.equal((await h.request('GET', '/api/history/codex?workspace=demo')).status, 403);
    assert.equal((await h.request('POST', '/api/history/codex?workspace=demo')).status, 403);
  } finally {
    h.close();
  }
});
