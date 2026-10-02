import test from 'node:test';
import assert from 'node:assert/strict';
import type { HistorySnapshot } from '@aicc/core';
import { HistorySyncCoordinator } from '../src/history-sync.js';

const success = { status: 'ok', message: 'ok' } as HistorySnapshot;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('startup, StrictMode replay and duplicate manual refresh coalesce, with at most two active sources', async () => {
  const calls: string[] = [];
  const release = new Map<string, (value: HistorySnapshot) => void>();
  const coordinator = new HistorySyncCoordinator(id => {
    calls.push(id); return new Promise(resolve => release.set(id, resolve));
  }, () => true);
  let completions = 0;
  coordinator.onCompleted(() => { completions++; });
  const first = coordinator.startOnce();
  void coordinator.startOnce();
  const repeated = coordinator.sync(['codex', 'workbuddy']);
  await tick();
  assert.deepEqual(calls, ['codex', 'workbuddy']);
  release.get('codex')!({ ...success, status: 'error', message: 'offline' });
  await tick();
  assert.equal(completions, 1);
  assert.deepEqual(calls, ['codex', 'workbuddy', 'opencode']);
  assert.equal(coordinator.snapshot().codex?.phase, 'error');
  release.get('workbuddy')!(success); await tick();
  assert.deepEqual(calls, ['codex', 'workbuddy', 'opencode', 'minimax']);
  release.get('opencode')!(success); release.get('minimax')!(success);
  await Promise.all([first, repeated]); await tick();
  assert.equal(completions, 4);
  assert.equal(calls.length, 4);
});

test('demo blocks startup and pauses queued requests until returning to real workspace', async () => {
  let allowed = false;
  const calls: string[] = [];
  const release: Array<(value: HistorySnapshot) => void> = [];
  const coordinator = new HistorySyncCoordinator(id => { calls.push(id); return new Promise(done => release.push(done)); }, () => allowed);
  await coordinator.startOnce(); assert.equal(calls.length, 0);
  allowed = true;
  const startup = coordinator.startOnce(); await tick();
  allowed = false;
  release.splice(0).forEach(done => done(success)); await tick();
  assert.equal(calls.length, 2);
  allowed = true; coordinator.resume(); await tick();
  assert.equal(calls.length, 4);
  release.splice(0).forEach(done => done(success)); await startup;
});

test('authentication loss cancels queued work, restoration allows an explicit new startup', async () => {
  let allowed = true;
  let calls = 0;
  const coordinator = new HistorySyncCoordinator(async () => { calls++; allowed = false; coordinator.cancelQueued(); throw new Error('会话已过期'); }, () => allowed);
  await coordinator.startOnce();
  assert.equal(calls, 2);
  await coordinator.sync(['opencode']); assert.equal(calls, 2);
  allowed = true; coordinator.resetStartup(); await coordinator.startOnce();
  assert.equal(calls, 4);
});
