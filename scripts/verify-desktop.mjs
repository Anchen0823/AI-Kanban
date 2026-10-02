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
const env = { ...process.env, AICC_DESKTOP_PROFILE: profile, AICC_DATA_DIR: join(profile, 'data') };
if (process.argv[2]) { delete env.AICC_NODE_EXECUTABLE; delete env.NODE_PATH; }
else env.AICC_NODE_EXECUTABLE = process.execPath;
// Startup sync must never inspect developer accounts during fixture verification.
if (process.env.AICC_VERIFY_OFFICIAL_SYNC !== '1') {
  env.AICC_CODEX_COMMAND = join(profile, 'no-such-codex.exe');
  env.CODEX_HOME = join(profile, 'codex');
}
env.WORKBUDDY_HOME = join(profile, 'workbuddy');
env.MINIMAX_HOME = join(profile, 'minimax');
env.OPENCODE_DB = join(profile, 'opencode.db');
// Match Explorer's stale PATH instead of inheriting the terminal's new Codex bin.
if (process.env.AICC_VERIFY_OFFICIAL_SYNC === '1') {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = (env[pathKey] ?? '').split(';').filter(dir => !/OpenAI[\\/]Codex[\\/]bin/i.test(dir)).join(';');
}
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
      const timeout = setTimeout(() => { pending.delete(request); reject(new Error(`${method} timed out: ${JSON.stringify(params).slice(0, 300)}\n${stderr.slice(-2000)}`)); }, 30000);
      pending.set(request, result => { clearTimeout(timeout); result.error ? reject(new Error(result.error.message)) : resolveResult(result.result); });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function reloadPage() {
    const previous = await evaluate('performance.timeOrigin');
    // Navigation can destroy Runtime.evaluate's reply context, particularly in
    // the portable launcher. Page.reload acknowledges before navigating.
    await command('Page.reload');
    await waitFor(() => evaluate(`performance.timeOrigin !== ${previous} && document.readyState === 'complete'`));
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
    await evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))).then(() => true)`);
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
  assert.equal(await evaluate(`!!document.querySelector('.control-deck, select[aria-label="统计来源"]')`),false);
  assert.equal(await evaluate(`!!document.querySelector('.observatory-nav .nav-sync-button')`),true);
  await waitFor(() => evaluate(`['codex','workbuddy','opencode','minimax'].every(id => document.querySelector('[data-source="'+id+'"] .source-actions button')?.disabled === false)`));
  const startupAttempts = await evaluate(`fetch('/api/history/dashboard').then(r => r.json()).then(d => Object.fromEntries(Object.entries(d.local).filter(([id]) => id !== 'deepseek').map(([id,s]) => [id,s.sync.lastAttempt?.at])))`);
  assert.equal(Object.values(startupAttempts).filter(Boolean).length,4);
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
      const model = [['gpt-5.4','gpt-5.4-mini','gpt-5.4-pro'],['deepseek-v3','deepseek-r1','deepseek-v4'],['claude-sonnet','claude-opus','claude-haiku']][index][day%3];
      rows.push([date,provider+'-qa-'+day,model,input,output,Math.floor(input*.68),Math.floor(output*.26)].join(','));
    }
    const result = await post('/api/imports', { kind:'usage_csv',fileName:provider+'-qa.csv',accountId:account.account.id,content:rows.join('\n') });
    assert.equal(result.acceptedRows,81);
  }
  await reloadPage();
  try {
    await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.getAttribute('title') === ${JSON.stringify(expectedTotal.toLocaleString('zh-CN'))}`), 15000);
  } catch (error) {
    console.error('Fixture mismatch', {expectedTotal, actual: await evaluate(`document.querySelector('.hero-kpi .kpi-value')?.title`), total: await evaluate(`fetch('/api/history/total').then(r => r.json())`), notices: await evaluate(`document.querySelector('.telemetry-notice')?.textContent`)});
    await capture('aqua-failure.png');
    throw error;
  }
  assert.deepEqual(await evaluate(`fetch('/api/history/dashboard').then(r => r.json()).then(d => Object.fromEntries(Object.entries(d.local).filter(([id]) => id !== 'deepseek').map(([id,s]) => [id,s.sync.lastAttempt?.at])))`), startupAttempts, 'Reload must not trigger startup sync again');
  assert.equal(await evaluate(`document.querySelectorAll('.donut-legend button').length`),3);
  assert.equal(await evaluate(`document.querySelectorAll('.model-rank').length`),9);
  assert.match(await evaluate(`document.querySelector('.trend-meta strong').textContent`), /^[\d,]+$/);
  assert.equal(await evaluate(`!!document.querySelector('.head-instrument')`),false);
  assert.equal(await evaluate(`[...document.querySelectorAll('.trend-chart path[fill="none"]')].some(p => p.getAttribute('d').includes('C'))`),true);
  assert.equal(await evaluate(`(() => { const b = document.querySelector('.brand-prism').getBoundingClientRect(), s = document.querySelector('.brand-prism svg').getBoundingClientRect(); return Math.abs(b.x+b.width/2-s.x-s.width/2)<1 && Math.abs(b.y+b.height/2-s.y-s.height/2)<1; })()`),true);
  await capture('aqua-dashboard.png');
  for (const label of ['7 天','90 天','全部','30 天']) await clickLabel(label);
  await clickLabel('柱状');
  assert.equal(await evaluate(`!!document.querySelector('svg[aria-label="每日 Token 柱状图"]')`),true);
  await capture('aqua-bars.png');
  await clickLabel('曲线');
  await clickLabel('表格');
  assert.equal(await evaluate(`document.querySelectorAll('.model-panel tbody tr').length`),9);
  await clickLabel('排行');
  assert.equal(await evaluate(`document.querySelector('.hero-kpi .kpi-value').textContent`),expectedTotal.toLocaleString('zh-CN'));
  await evaluate(`document.querySelector('.donut-legend button').click()`);
  await delay(100);
  assert.equal(await evaluate(`document.querySelectorAll('.donut-legend button.selected').length`),1);
  assert.equal(await evaluate(`document.querySelectorAll('.model-rank').length`),3);
  await evaluate(`document.querySelector('.donut-legend button.selected').click()`);
  await delay(100);
  assert.equal(await evaluate(`document.querySelectorAll('.donut-legend button.selected').length`),0);
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
  await reloadPage();
  await waitFor(() => evaluate(`!!document.querySelector('.workspace-switch')`));
  await clickLabel('示例数据');
  await waitFor(() => evaluate(`document.querySelector('.telemetry')?.getAttribute('aria-busy') === 'false'`));
  assert.equal(await evaluate(`document.body.innerText.includes('合成数据不计入真实统计')`),true);
  assert.equal(await evaluate(`document.querySelector('.nav-sync-button').disabled`),true);
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
  assert.equal(await evaluate(`document.body.innerText.includes('同步完成，已重新读取可用统计。')`),false);
  await evaluate(`document.querySelector('.methodology').open = true; document.querySelector('tr[data-source="imported:DeepSeek"] button').click()`);
  await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.title === ${JSON.stringify(deepseekImport.toLocaleString('zh-CN'))}`));
  assert.match(await evaluate(`document.querySelector('.source-selection').textContent`), /重叠/);
  await clickLabel('查看全部');
  await evaluate(`document.querySelector('.methodology').open = false`);
  console.log('PASS: excluded sources can be inspected without changing the authoritative all-source total.');
  console.log('PASS: DeepSeek UI collection refreshes the dashboard and excludes overlapping generic imports.');
  if (process.env.AICC_VERIFY_OFFICIAL_SYNC === '1') {
    // Exercise the actual UI sync button twice, not just stored fixture rendering.
    // The profile is isolated; only Codex's own read-only account interface is used.
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await evaluate(`(() => { const tile = [...document.querySelectorAll('.source-tile')].find(t => t.querySelector('.source-tile-top strong')?.textContent === 'Codex'); const b = tile?.querySelector('button'); if (!b || b.disabled) return false; b.click(); return true; })()`), true);
      await waitFor(() => evaluate(`(() => { const tile = [...document.querySelectorAll('.source-tile')].find(t => t.querySelector('.source-tile-top strong')?.textContent === 'Codex'); return tile?.querySelector('button')?.disabled === false; })()`), 60000);
      const history = await evaluate(`fetch('/api/history/codex').then(r => r.json())`);
      assert.equal(history.statisticsSource, 'official', history.officialMessage);
      assert.equal(history.dailySource, 'official');
      assert.ok(Number.isSafeInteger(history.totals.totalTokens) && history.totals.totalTokens > 0);
      assert.equal(await evaluate(`fetch('/api/history/total').then(r => r.json()).then(r => r.sources.find(s => s.id === 'codex').totalTokens)`), history.totals.totalTokens);
      console.log(`PASS: real UI sync ${attempt + 1} with Explorer-style PATH returns official total ${history.totals.totalTokens}.`);
    }
    await evaluate(`(() => { const b = [...document.querySelectorAll('.donut-legend button')].find(b => b.textContent.includes('Codex')); b.click(); window.scrollTo(0,0); })()`);
    await waitFor(() => evaluate(`document.querySelector('.methodology tbody')?.textContent.includes('Codex（官方统计）')`));
    await capture('codex-official-real-sync.png');
  }
  // Official Codex account fixtures are written only to the isolated QA profile.
  // Verify the official total is never reconstructed from local components.
  const { DatabaseSync } = require('node:sqlite');
  const qaDb = new DatabaseSync(join(profile, 'data', 'ai-control-center.sqlite'));
  const localTotals = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, reasoningOutputTokens: 1, totalTokens: 12 };
  const unknownTotals = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, totalTokens: 100 };
  const codexFixture = { schemaVersion: 2, status: 'ok', checkedAt: '2026-10-01T00:00:00.000Z',
    statisticsSource: 'official', dailySource: 'official', totals: unknownTotals, localTotals,
    officialMessage: '已读取 Codex 官方账户统计。', sessionCount: 1,
    firstAt: '2026-09-24T00:00:00.000Z', lastAt: '2026-09-24T00:00:00.000Z',
    byDay: [{ day: '2026-09-24', totals: { ...unknownTotals, totalTokens: 50 }, sessionCount: 0 }],
    byModel: [{ model: 'codex-qa-local-model', totals: localTotals, sessionCount: 1 }], warnings: [], message: 'QA official fixture',
  };
  function saveCodexFixture(value) {
    qaDb.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run('history.codex', JSON.stringify(value), new Date().toISOString());
  }
  async function selectCodexFixture() {
    await reloadPage();
    await waitFor(() => evaluate(`document.querySelector('.telemetry')?.getAttribute('aria-busy') === 'false'`));
    assert.equal(await evaluate(`(() => { const b = [...document.querySelectorAll('.donut-legend button')].find(b => b.textContent.includes('Codex')); if (!b) return false; b.click(); return true; })()`), true);
  }
  try {
    saveCodexFixture(codexFixture);
    await selectCodexFixture();
    await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.title === '100'`));
    assert.equal(await evaluate(`document.querySelectorAll('.kpi:not(.hero-kpi) .kpi-note').length`), 0);
    assert.equal(await evaluate(`document.querySelectorAll('.kpi')[1].querySelector('.kpi-value').title`), '10');
    assert.equal(await evaluate(`document.querySelectorAll('.kpi')[3].querySelector('.kpi-value').textContent`), '—', 'Legacy coverage must not invent a cache ratio');
    assert.doesNotMatch(await evaluate(`document.querySelector('.chart-foot').textContent`), /官方统计|本机日志/);
    assert.equal(await evaluate(`document.querySelector('.model-panel .panel-note') === null`), true);
    assert.match(await evaluate(`document.querySelector('.methodology tbody').textContent`), /Codex（官方统计）/);
    await capture('codex-official-qa.png');
    const officialTotals = { inputTokens: 90, outputTokens: 10, cachedInputTokens: 70, reasoningOutputTokens: null, totalTokens: 100 };
    const officialDetails = { status: 'complete', totals: officialTotals, checkedThreads: 2, availableThreads: 2,
      message: '官方会话明细已与官方累计核对一致，分项与模型排行采用官方估算数据。' };
    saveCodexFixture({ ...codexFixture, detailTotals: officialTotals, detailsSource: 'official', officialDetails,
      detailCoverage: { inputTokens:'complete', outputTokens:'complete', cachedInputTokens:'complete', reasoningOutputTokens:'unknown', totalTokens:'complete' },
      byModel: [{ model: 'codex-qa-official-model', totals: officialTotals, sessionCount: 2 }] });
    await selectCodexFixture();
    await waitFor(() => evaluate(`document.querySelectorAll('.kpi')[1].querySelector('.kpi-value').title === '90'`));
    assert.match(await evaluate(`document.querySelector('.model-panel').textContent`), /codex-qa-official-model/);
    assert.equal(await evaluate(`document.querySelectorAll('.kpi')[3].querySelector('.kpi-value').textContent`), '77.8%');
    assert.equal(await evaluate(`document.querySelector('.methodology').open`), false);
    assert.equal(await evaluate(`document.querySelectorAll('.kpi:not(.hero-kpi) .kpi-note').length`), 0);
    await capture('codex-official-details-qa.png');
    saveCodexFixture({ ...codexFixture, detailTotals: localTotals, detailsSource: 'local',
      officialDetails: { ...officialDetails, status: 'partial', totals: { ...officialTotals, totalTokens: 40 },
        message: '官方返回部分会话的估算明细，尚未覆盖官方累计；分项与模型排行继续采用本机日志。' } });
    await selectCodexFixture();
    await waitFor(() => evaluate(`document.querySelectorAll('.kpi')[1].querySelector('.kpi-value').title === '10'`));
    assert.equal(await evaluate(`document.querySelector('.hero-kpi .kpi-value').title`), '100');
    assert.match(await evaluate(`document.querySelector('.methodology').textContent`), /已返回明细合计 40 Token/);
    assert.match(await evaluate(`document.querySelector('.model-panel').textContent`), /codex-qa-local-model/);
    saveCodexFixture({ ...codexFixture, statisticsSource: 'local', dailySource: 'local', totals: localTotals,
      officialMessage: '官方统计需要 Codex CLI 的 ChatGPT 登录。请运行 codex login 后重新同步；当前回退到本机日志。' });
    await selectCodexFixture();
    await waitFor(() => evaluate(`document.querySelector('.hero-kpi .kpi-value')?.title === '12'`));
    assert.match(await evaluate(`document.querySelector('.telemetry-notice').textContent`), /codex login/);
    assert.match(await evaluate(`document.querySelector('.methodology tbody').textContent`), /Codex（本机日志）/);
    await capture('codex-fallback-qa.png');
    console.log('PASS: official Codex totals/days, reconciled official details, partial-detail fallback, clean main UI and login fallback (isolated QA fixtures).');
  } finally { qaDb.close(); }
  // Simulate an expired HTTP session at the renderer boundary, without changing production auth TTL.
  await evaluate(`(() => { const real = window.fetch.bind(window); window.fetch = (url, options) => String(url).startsWith('/api/history/') ? Promise.resolve(new Response(JSON.stringify({error:{message:'会话已过期'}}), {status:401,headers:{'content-type':'application/json'}})) : real(url, options); document.querySelector('.nav-sync-button').click(); })()`);
  await waitFor(() => evaluate(`document.body.innerText.includes('应用 → 重新启动') && !document.querySelector('.telemetry')`));
  console.log('PASS: expired desktop session shows recovery and unmounts the dashboard.');
  await evaluate(`history.replaceState(null, '', '/')`);
  await reloadPage();
  await waitFor(() => evaluate(`document.querySelector('.telemetry')?.getAttribute('aria-busy') === 'false' && document.querySelector('.nav-sync-button')?.disabled === false`));
  await evaluate(`(() => { window.__qaFetch = window.fetch.bind(window); window.fetch = (url, options) => String(url).startsWith('/api/history/') ? Promise.resolve(new Response(JSON.stringify({error:{message:'会话已过期'}}),{status:401,headers:{'content-type':'application/json'}})) : window.__qaFetch(url, options); document.querySelector('.nav-sync-button').click(); })()`);
  await waitFor(() => evaluate(`!!document.querySelector('input[placeholder="例如 K7M2QP4R"]') && !document.querySelector('.telemetry')`));
  // The pairing HTTP contract is covered by real backend tests; simulate its success here to exercise the UI recovery transition.
  await evaluate(`(() => { window.fetch = (url, options) => String(url) === '/api/session/pair' ? Promise.resolve(new Response('{}',{status:200,headers:{'content-type':'application/json'}})) : window.__qaFetch(url, options); const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'TESTCODE'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await clickLabel('配对');
  await waitFor(() => evaluate(`document.querySelector('.telemetry')?.getAttribute('aria-busy') === 'false' && document.querySelector('.nav-sync-button')?.disabled === false`));
  assert.equal(runtimeErrors.length,0,JSON.stringify(runtimeErrors));
  console.log('PASS: browser session recovery returns to pairing and resumes sync after authentication.');
  console.log('PASS: aqua single-screen UI, real API fixture totals, trend ranges and chart switching, model views, source filtering, full numbers, reduced motion, DeepSeek collection, source coverage, 1000px/390px layouts, demo isolation, zero renderer errors.');
  // Let the debugging protocol acknowledge the command before the window and
  // its transport disappear; immediate close can drop the RPC reply in builds.
  await evaluate('setTimeout(() => window.close(), 200); true');
  await Promise.race([exited, delay(10000).then(() => { throw new Error('Desktop did not exit'); })]);
  await assert.rejects(fetch(origin));
  console.log('PASS: real desktop auto-login, navigation, renderer isolation, anonymous rejection, screenshot, window close and backend cleanup.');
  console.log(join(output, 'aqua-dashboard.png'));
 } finally {
  // The portable launcher has its own process; killing only that launcher can
  // leave Electron alive. Ask Chromium to close first, even after a failed check.
  if (child.exitCode === null && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: 2147483647, method: 'Browser.close' }));
    await Promise.race([exited, delay(3000)]);
  }
  socket?.close();
  if (child.exitCode === null) child.kill();
}
