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
async function waitFor(fn, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop exited early (${child.exitCode}): ${stderr}`);
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
  await command('Input.setIgnoreInputEvents', {ignore:true});
  await waitFor(() => evaluate(`document.body.innerText.includes('用量统计') && document.querySelectorAll('button').length > 3`));
  assert.equal(await evaluate(`fetch('/api/session').then(r=>r.json()).then(r=>r.authenticated)`), true);
  assert.equal(await evaluate(`typeof window.require`), 'undefined');
  assert.equal(await evaluate(`typeof window.process`), 'undefined');
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).authenticated, false);
  const second = spawn(executable, process.argv[2] ? [] : ['apps/desktop'], { env, stdio: 'ignore', windowsHide: true });
  const [secondCode] = await once(second, 'exit');
  assert.equal(secondCode, 0, 'Second instance should exit and focus the first window');
  await command('Input.setIgnoreInputEvents', {ignore:true});

  const runtimeErrors = [];
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params); });
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  async function capture(name) {
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, name), Buffer.from(shot.data, 'base64'));
  }
  async function clickLabel(label) {
    assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getClientRects().length); if (!b || b.disabled) return false; b.click(); return true; })()`), true, label);
    await delay(120);
  }
  await waitFor(() => evaluate(`document.querySelector('.telemetry')?.getAttribute('aria-busy') === 'false'`));
  assert.equal(await evaluate(`/用量明细|数据设置|更多工具|收费流水/.test(document.body.innerText)`), false);
  assert.equal(await evaluate(`document.querySelectorAll('.kpi').length`), 4);
  assert.equal(await evaluate(`fetch('/api/history/total').then(r => r.json()).then(r => r.totalTokens)`), null, 'Fresh test profile must contain no usage');
  await capture('aqua-empty.png');
  // A real isolated database is populated via public APIs; these are QA fixtures, never user data.
  async function post(path, body) {
    return evaluate(`fetch(${JSON.stringify(path)}, {method:'POST', headers:{'content-type':'application/json','x-aicc-request':'1'}, body:JSON.stringify(${JSON.stringify(body)})}).then(async r => {const body=await r.json(); if(!r.ok) throw new Error(JSON.stringify(body)); return body;})`);
  }
  let expectedTotal = 0;
  for (const [index, provider] of ['OpenAI', 'DeepSeek', 'Anthropic'].entries()) {
    const account = await post('/api/accounts', { provider, alias: provider + ' QA', currency:'USD' });
    const rows = ['occurred_at,request_id,model,input_tokens,output_tokens,cached_tokens,reasoning_tokens'];
    for (let day=0;day<90;day++) {
      if (day % 11 === 0) continue;
      const date = new Date(Date.UTC(2026,6,1+day)).toISOString();
      const input = Math.floor((100000+day*2400+Math.sin(day*.7+index)*60000)/(index+1));
      const output = Math.floor(input*.23);
      expectedTotal += input+output;
      const model = [['gpt-5.4','gpt-5.4-mini'],['deepseek-v3','deepseek-r1'],['claude-sonnet','claude-opus']][index][day%2];
      rows.push([date,provider+'-qa-'+day,model,input,output,Math.floor(input*.68),Math.floor(output*.26)].join(','));
    }
    const result = await post('/api/imports', { kind:'usage_csv',fileName:provider+'-qa.csv',accountId:account.account.id,content:rows.join('\n') });
    assert.equal(result.acceptedRows,81);
  }
  await evaluate(`document.querySelector('[aria-label="刷新统计"]').click()`);
  try {
    await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.getAttribute('title') === ${JSON.stringify(expectedTotal.toLocaleString('zh-CN'))}`), 15000);
  } catch (error) {
    console.error('Fixture mismatch', {expectedTotal, actual: await evaluate(`document.querySelector('.hero-kpi .kpi-value')?.title`), total: await evaluate(`fetch('/api/history/total').then(r => r.json())`), notices: await evaluate(`document.querySelector('.telemetry-notice')?.textContent`)});
    await capture('aqua-failure.png');
    throw error;
  }
  assert.equal(await evaluate(`document.querySelectorAll('.donut-legend button').length`),3);
  assert.equal(await evaluate(`document.querySelectorAll('.model-rank').length`),6);
  assert.match(await evaluate(`document.querySelector('.trend-meta strong').textContent`), /^[\d,]+$/);
  await capture('aqua-dashboard.png');
  for (const label of ['7 天','90 天','全部','30 天']) await clickLabel(label);
  await clickLabel('柱状');
  assert.equal(await evaluate(`!!document.querySelector('svg[aria-label="每日 Token 柱状图"]')`),true);
  await capture('aqua-bars.png');
  await clickLabel('曲线');
  await clickLabel('表格');
  assert.equal(await evaluate(`document.querySelectorAll('.model-panel tbody tr').length`),6);
  await clickLabel('排行');
  assert.equal(await evaluate(`document.querySelector('.hero-kpi .kpi-value').textContent`),expectedTotal.toLocaleString('zh-CN'));
  await evaluate(`document.querySelector('.donut-legend button').click()`);
  await delay(100);
  assert.notEqual(await evaluate(`document.querySelector('select[aria-label="统计来源"]').value`),'all');
  assert.equal(await evaluate(`document.querySelectorAll('.model-rank').length`),2);
  await evaluate(`document.querySelector('.donut-legend button.selected').click()`);
  await delay(100);
  assert.equal(await evaluate(`document.querySelector('select[aria-label="统计来源"]').value`),'all');
  await evaluate(`document.querySelector('[aria-label="切换界面动效"]').click()`);
  await delay(100);
  assert.equal(await evaluate(`document.querySelector('.aqua-app').dataset.motion`),'off');
  await clickLabel('读取历史导出 ↗');
  assert.equal(await evaluate(`!!document.querySelector('#deepseek-directory')`),true);
  await clickLabel('读取历史导出 ↗');
  await evaluate(`document.querySelector('.methodology').open = true; document.querySelector('#sources').scrollIntoView()`);
  await delay(100);
  await capture('aqua-sources.png');
  await evaluate(`document.querySelector('.methodology').open = false; window.scrollTo(0,0)`);
  for (const width of [1000, 390]) {
    await command('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await delay(150);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`),true,'No overflow at '+width);
    if (width === 390) {
      assert.match(await evaluate(`document.querySelector('.hero-kpi .kpi-value').textContent`), /[KMB]$/);
      assert.equal(await evaluate(`document.querySelector('.hero-kpi .kpi-value').title`), expectedTotal.toLocaleString('zh-CN'));
    }
    await capture('aqua-'+width+'.png');
  }
  await command('Emulation.setDeviceMetricsOverride', {width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await delay(150);
  assert.equal(await evaluate(`document.querySelector('.hero-kpi .kpi-value').textContent`),expectedTotal.toLocaleString('zh-CN'));
  assert.equal(runtimeErrors.length,0,JSON.stringify(runtimeErrors));
  await post('/api/demo/seed',{});
  await evaluate('location.reload()');
  await waitFor(() => evaluate(`!!document.querySelector('.workspace-switch')`));
  await clickLabel('示例数据');
  await waitFor(() => evaluate(`document.querySelector('.telemetry')?.getAttribute('aria-busy') === 'false'`));
  assert.equal(await evaluate(`document.body.innerText.includes('合成数据不计入真实统计')`),true);
  assert.equal(await evaluate(`document.querySelector('.deck-actions .sync-button').disabled`),true);
  assert.notEqual(await evaluate(`document.querySelector('.hero-kpi .kpi-value').getAttribute('title')`),expectedTotal.toLocaleString('zh-CN'));
  await clickLabel('真实数据');
  await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.getAttribute('title') === ${JSON.stringify(expectedTotal.toLocaleString('zh-CN'))}`));
  const beforeSync = await evaluate(`fetch('/api/history/total').then(r => r.json())`);
  const deepseekImport = beforeSync.sources.find(source => source.id === 'imported:DeepSeek').totalTokens;
  const exportDirectory = join(profile, 'deepseek-export');
  mkdirSync(exportDirectory, {recursive:true});
  writeFileSync(join(exportDirectory, 'amount-2026-09-01_2026-09-30.csv'), [
    'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
    ...[['input_cache_hit_tokens',13],['input_cache_miss_tokens',20],['output_tokens',5]].map(([type, amount]) => `qa,2026-09-01T00:00:00+08:00,2026-09-02T00:00:00+08:00,deepseek-chat,qa,qa,${type},0,${amount}`),
  ].join('\n'));
  await clickLabel('读取历史导出 ↗');
  await evaluate(`(() => { const input = document.querySelector('#deepseek-directory'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(exportDirectory)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await delay(100);
  await clickLabel('读取并统计');
  await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.getAttribute('title') === ${JSON.stringify((expectedTotal-deepseekImport+38).toLocaleString('zh-CN'))}`));
  assert.equal(await evaluate(`fetch('/api/history/total').then(r => r.json()).then(r => r.sources.find(s => s.id === 'imported:DeepSeek').included)`), false);
  console.log('PASS: DeepSeek UI collection refreshes the dashboard and excludes overlapping generic imports.');
  console.log('PASS: aqua single-screen UI, real API fixture totals, trend ranges and chart switching, model views, source filtering, full numbers, reduced motion, DeepSeek collection, source coverage, 1000px/390px layouts, demo isolation, zero renderer errors.');
  await evaluate('window.close()');
  await Promise.race([exited, delay(10000).then(() => { throw new Error('Desktop did not exit'); })]);
  await assert.rejects(fetch(origin));
  console.log('PASS: real desktop auto-login, navigation, renderer isolation, anonymous rejection, screenshot, window close and backend cleanup.');
  console.log(join(output, 'aqua-dashboard.png'));
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
