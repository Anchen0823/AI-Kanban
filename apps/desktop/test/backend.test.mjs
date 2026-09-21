import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function start(dir) {
  const child = fork(new URL('../backend.mjs', import.meta.url), [], {
    env: { ...process.env, AICC_DATA_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const message = await Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(() => { throw new Error('Backend exited before ready'); }),
  ]);
  assert.equal(message.type, 'ready');
  return { child, ...message };
}
async function stop(child, disconnect = false) {
  const exited = once(child, 'exit');
  if (disconnect) child.disconnect(); else child.send({ type: 'shutdown' });
  await exited;
}
test('desktop backend: authentication, persistence, shutdown and parent disconnect', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aicc-desktop-test-'));
  let active;
  try {
    active = await start(dir);
    const { url, code } = active;
    assert.equal((await (await fetch(`${url}/api/session`)).json()).authenticated, false);
    const headers = { 'content-type': 'application/json', 'x-aicc-request': '1', origin: url };
    const pair = await fetch(`${url}/api/session/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    assert.equal(pair.status, 200);
    headers.cookie = pair.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(`${url}/api/session`, { headers })).json()).authenticated, true);
    assert.equal((await fetch(`${url}/api/settings`, { method: 'PATCH', headers,
      body: JSON.stringify({ displayTimezone: 'UTC' }) })).status, 200);
    assert.equal((await fetch(`${url}/api/session/pair`, { method: 'POST', headers,
      body: JSON.stringify({ code }) })).status, 401);
    assert.equal((await fetch(`${url}/api/session`, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
    assert.match(await (await fetch(url)).text(), /<div id="root">/);
    await stop(active.child);
    await assert.rejects(fetch(url));
    active = await start(dir);
    const paired = await fetch(`${active.url}/api/session/pair`, { method: 'POST', headers: { ...headers, origin: active.url },
      body: JSON.stringify({ code: active.code }) });
    const settings = await (await fetch(`${active.url}/api/settings`, {
      headers: { cookie: paired.headers.get('set-cookie').split(';')[0] },
    })).json();
    assert.equal(settings.settings.displayTimezone, 'UTC');
    await stop(active.child, true);
    await assert.rejects(fetch(active.url));
  } finally {
    if (active?.child.exitCode === null) await stop(active.child);
    rmSync(dir, { recursive: true, force: true });
  }
});
