import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolveCodexCommand } from '../src/collectors/codex-app-server.js';
import { normalizeCodexAccountUsage, readCodexAccountUsage } from '../src/collectors/codex-account-usage.js';

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
function fakeSpawn(mode: string): typeof spawn {
  return ((_command: string, args: readonly string[], options: Record<string, unknown>) =>
    spawn(process.execPath, [fake, ...args], { ...options,
      env: { ...(options.env as Record<string, string>), FAKE_CODEX_MODE: mode }, shell: false,
    })) as unknown as typeof spawn;
}
test('official account activity crosses real stdio transport and preserves missing components', async () => {
  const result = await readCodexAccountUsage({ spawnImpl: fakeSpawn('usage-ok') });
  assert.equal(result.status, 'ok');
  assert.equal(result.summary?.lifetimeTokens, 2_810_000_000);
  assert.equal(result.summary?.currentStreakDays, null);
  assert.equal(result.dailyUsageBuckets?.[0]?.tokens, 420_000_000);
});
test('unsupported, unauthenticated, empty and timed-out account reads produce safe fallback reasons', async () => {
  for (const [mode, reason] of [['ok', /更新 Codex/], ['usage-auth', /codex login/], ['usage-empty', /未返回/], ['usage-timeout', /超时/]] as const) {
    const result = await readCodexAccountUsage({ spawnImpl: fakeSpawn(mode), timeoutMs: 200 });
    assert.equal(result.status, 'unavailable');
    assert.match(result.message, reason);
    assert.doesNotMatch(JSON.stringify(result), /secret-fixture|someone@example/);
  }
});
test('account normalization rejects negative, unsafe and invalid dates without inventing zero or totals', () => {
  for (const lifetimeTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
    assert.equal(normalizeCodexAccountUsage({ summary: { lifetimeTokens } }).status, 'unavailable');
  }
  for (const dailyUsageBuckets of [
    [{ startDate: '2026-02-31', tokens: 5 }],
    [{ startDate: '2026-09-01', tokens: -1 }],
    [{ startDate: '2026-09-01', tokens: 5 }, { startDate: '2026-09-01', tokens: 6 }],
  ]) {
    const result = normalizeCodexAccountUsage({ summary: { lifetimeTokens: 20 }, dailyUsageBuckets });
    assert.equal(result.summary?.lifetimeTokens, 20);
    assert.equal(result.dailyUsageBuckets, null);
  }
  const dailyOnly = normalizeCodexAccountUsage({ dailyUsageBuckets: [{ startDate: '2026-09-01', tokens: 5 }] });
  assert.equal(dailyOnly.summary?.lifetimeTokens, null, 'daily buckets never substitute for lifetime usage');
  assert.equal(normalizeCodexAccountUsage({ summary: { lifetimeTokens: 0 }, dailyUsageBuckets: [] }).summary?.lifetimeTokens, 0);
});

test('missing Codex executable falls back without an unhandled process error', async () => {
  const result = await readCodexAccountUsage({ command: 'aicc-missing-codex', spawnImpl: spawn, timeoutMs: 1000 });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /安装/);
});

test('Windows prefers a native Codex executable over npm shims and respects custom commands', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aicc-codex-path-'));
  try {
    await writeFile(join(directory, 'codex.exe'), 'fixture');
    assert.equal(resolveCodexCommand('codex', `missing${delimiter}"${directory}"`), join(directory, 'codex.exe'));
    assert.equal(resolveCodexCommand('custom-codex.cmd', directory), 'custom-codex.cmd');
    assert.equal(resolveCodexCommand('codex', 'missing', 'missing-desktop'), 'codex');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Explorer PATH without native Codex discovers the latest installed desktop executable', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aicc-codex-desktop-'));
  try {
    const oldDir = join(directory, 'old');
    const newDir = join(directory, 'new');
    await mkdir(oldDir); await mkdir(newDir);
    await writeFile(join(oldDir, 'codex.exe'), 'old');
    await writeFile(join(newDir, 'codex.exe'), 'new');
    await utimes(join(oldDir, 'codex.exe'), new Date(0), new Date(0));
    await mkdir(join(directory, 'incomplete-update'));
    assert.equal(resolveCodexCommand('codex', 'old-npm-path', directory), join(newDir, 'codex.exe'));
    assert.equal(resolveCodexCommand('my-custom-codex.cmd', 'old-npm-path', directory), 'my-custom-codex.cmd');
    await rm(newDir, { recursive: true, force: true });
    assert.equal(resolveCodexCommand('codex', '', directory), join(oldDir, 'codex.exe'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
