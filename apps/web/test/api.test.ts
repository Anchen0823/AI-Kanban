import assert from 'node:assert/strict';
import test from 'node:test';
import { api, authenticationRestored, isAuthenticationLost, onAuthenticationLost, UnauthenticatedError, demoMutationBlockReason, setWorkspace, workspacePath } from '../src/api.ts';

test('real workspace permits normal mutations', () => {
  setWorkspace('real');
  assert.equal(demoMutationBlockReason('POST', '/api/projects'), null);
  assert.equal(demoMutationBlockReason('PATCH', '/api/settings'), null);
});

test('demo workspace blocks mutations that would default to the real database', () => {
  setWorkspace('demo');
  assert.match(demoMutationBlockReason('POST', '/api/projects') ?? '', /只读/);
  assert.match(demoMutationBlockReason('POST', '/api/imports') ?? '', /只读/);
  assert.match(demoMutationBlockReason('DELETE', '/api/memories/memory_1') ?? '', /只读/);
});

test('demo workspace keeps safe controls and scoped context preview paths available', () => {
  setWorkspace('demo');
  assert.equal(demoMutationBlockReason('POST', '/api/session/pair'), null);
  assert.equal(demoMutationBlockReason('POST', '/api/demo/reset'), null);
  assert.equal(demoMutationBlockReason('POST', '/api/context-exports'), null);
  assert.equal(demoMutationBlockReason('POST', '/api/memories/memory_1/delete-preview'), null);
  assert.equal(demoMutationBlockReason('GET', '/api/projects'), null);
  setWorkspace('real');
});

test('CSV export URL follows the selected workspace', () => {
  setWorkspace('real');
  assert.equal(workspacePath('/api/exports/usage.csv'), '/api/exports/usage.csv');

  setWorkspace('demo');
  assert.equal(workspacePath('/api/exports/usage.csv'), '/api/exports/usage.csv?workspace=demo');
  setWorkspace('real');
});

test('401 notifies recovery once; an incorrect pairing code does not expire the new session', async t => {
  setWorkspace('real'); authenticationRestored();
  let lost = 0;
  const unsubscribe = onAuthenticationLost(() => { lost++; });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 }));
  try {
    await assert.rejects(api.get('/api/history/dashboard'), UnauthenticatedError);
    await assert.rejects(api.get('/api/history/codex'), UnauthenticatedError);
    assert.equal(lost, 1); assert.equal(isAuthenticationLost(), true);
    authenticationRestored();
    await assert.rejects(api.post('/api/session/pair', { code: 'wrong' }), UnauthenticatedError);
    assert.equal(lost, 1); assert.equal(isAuthenticationLost(), false);
  } finally { unsubscribe(); authenticationRestored(); }
});
