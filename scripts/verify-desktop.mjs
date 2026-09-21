// Real Electron window smoke test through Chromium's local debugging protocol.
// No testing endpoint or privileged renderer bridge is shipped in the application.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const output = resolve('tmp/desktop-verification');
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'profile-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolveClose => probe.close(resolveClose));
const executable = process.argv[2] ? resolve(process.argv[2]) : require('electron');
const args = [...(process.argv[2] ? [] : ['apps/desktop']), `--remote-debugging-port=${port}`];
const env = { ...process.env, AICC_NODE_EXECUTABLE: process.execPath,
  AICC_DESKTOP_PROFILE: profile, AICC_DATA_DIR: join(profile, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
const exited = once(child, 'exit');
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
let socket;
let origin;
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (err) { error = err; }
    await delay(200);
  }
  throw new Error(`Desktop check timed out: ${error?.message || ''}\n${stderr}`);
}
try {
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return targets.find(target => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'));
  });
  origin = new URL(target.url).origin;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const callback = pending.get(result.id);
    if (callback) { pending.delete(result.id); callback(result); }
  });
  function command(method, params = {}) {
    return new Promise((resolveResult, reject) => {
      const request = ++id;
      const timeout = setTimeout(() => { pending.delete(request); reject(new Error(`${method} timed out`)); }, 10000);
      pending.set(request, result => { clearTimeout(timeout); result.error ? reject(new Error(result.error.message)) : resolveResult(result.result); });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await waitFor(() => evaluate(`document.body.innerText.includes('用量总览') && document.querySelectorAll('button').length > 3`));
  assert.equal(await evaluate(`fetch('/api/session').then(r=>r.json()).then(r=>r.authenticated)`), true);
  assert.equal(await evaluate(`typeof window.require`), 'undefined');
  assert.equal(await evaluate(`typeof window.process`), 'undefined');
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).authenticated, false);
  const second = spawn(executable, process.argv[2] ? [] : ['apps/desktop'], { env, stdio: 'ignore', windowsHide: true });
  const [secondCode] = await once(second, 'exit');
  assert.equal(secondCode, 0, 'Second instance should exit and focus the first window');
  for (const label of ['用量记录', '设置', '用量总览']) {
    assert.equal(await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button) return false; button.click(); return true; })()`), true);
    await delay(400);
    assert.equal(await evaluate(`document.body.innerText.includes('加载失败')`), false);
  }
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, 'desktop.png'), Buffer.from(screenshot.data, 'base64'));
  const text = await evaluate('document.body.innerText');
  writeFileSync(join(output, 'window-text.txt'), text);
  await evaluate('window.close()');
  await Promise.race([exited, delay(10000).then(() => { throw new Error('Desktop did not exit'); })]);
  await assert.rejects(fetch(origin));
  console.log('PASS: real desktop auto-login, navigation, renderer isolation, anonymous rejection, screenshot, window close and backend cleanup.');
  console.log(join(output, 'desktop.png'));
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
