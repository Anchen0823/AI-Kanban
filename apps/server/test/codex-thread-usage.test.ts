import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeCodexThreadUsage } from '../src/collectors/codex-thread-usage.js';
import { readCodexAccountUsage } from '../src/collectors/codex-account-usage.js';
const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const fakeSpawn = (mode: string): typeof spawn => ((_cmd: string, args: readonly string[], options: Record<string, unknown>) =>
  spawn(process.execPath, [fake, ...args], { ...options, env: { ...(options.env as Record<string, string>), FAKE_CODEX_MODE: mode }, shell: false })) as unknown as typeof spawn;

test('official estimates reconcile account totals, deduplicate active/archive threads and preserve unknown reasoning', async () => {
  const result = await readCodexAccountUsage({ spawnImpl: fakeSpawn('usage-details-complete') });
  assert.equal(result.summary?.lifetimeTokens, 100);
  assert.equal(result.details?.status, 'complete');
  assert.equal(result.details?.checkedThreads, 2);
  assert.equal(result.details?.availableThreads, 2);
  assert.deepEqual(result.details?.totals, { inputTokens: 90, outputTokens: 10, cachedInputTokens: 40, totalTokens: 100, reasoningOutputTokens: null });
  assert.equal(result.details?.byModel[0]?.sessionCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret-fixture|fixture-thread|reasoningEffort/);
});
test('partial and null thread responses never replace account totals or invent zero details', async () => {
  const partial = await readCodexAccountUsage({ spawnImpl: fakeSpawn('usage-details-partial') });
  assert.equal(partial.details?.status, 'partial');
  assert.equal(partial.details?.totals.totalTokens, 100);
  assert.equal(partial.summary?.lifetimeTokens, 200);
  const missing = await readCodexAccountUsage({ spawnImpl: fakeSpawn('usage-details-missing') });
  assert.equal(missing.details?.totals.inputTokens, null);
  assert.equal(missing.details?.totals.outputTokens, 10);
  const empty = await readCodexAccountUsage({ spawnImpl: fakeSpawn('usage-details-null') });
  assert.equal(empty.status, 'ok');
  assert.equal(empty.details?.status, 'unavailable');
  assert.equal(empty.details?.totals.totalTokens, null);
  assert.equal(empty.summary?.lifetimeTokens, 100);
});
test('thread identity, invalid counts and inconsistent cached/input/output totals are rejected', () => {
  const payload = (group: Record<string, unknown>) => ({ threadUsage: { threadId: 't', groups: [group] } });
  assert.equal(normalizeCodexThreadUsage(payload({ totalTokens: 1 }), 'different-thread'), null);
  for (const group of [{ totalTokens: -1 }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { inputTokens: 3, outputTokens: 2, totalTokens: 4 }, { inputTokens: 3, cachedInputTokens: 4 }]) {
    assert.equal(normalizeCodexThreadUsage(payload(group), 't'), null);
  }
  const unknown = normalizeCodexThreadUsage(payload({ model: 'model', totalTokens: 5 }), 't');
  assert.equal(unknown?.[0]?.totals.inputTokens, null);
});
