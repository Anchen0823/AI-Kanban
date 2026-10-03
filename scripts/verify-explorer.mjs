// Reproducible synthetic query benchmark; never opens a developer account.
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from '../apps/server/test/helpers.ts';
import { DetailBuilder, attachDetails } from '../apps/server/src/services/history-detail-store.ts';
import { saveHistoryAttempt } from '../apps/server/src/services/history-cache.ts';
const h = await createHarness();
try {
  const builder = new DetailBuilder(), sessions = 10000, buckets = sessions * 10;
  for (let i = 0; i < sessions; i++) {
    const id = `benchmark-${i}`;
    builder.metadata(id, `示例性能会话 ${i}`, `D:\\Synthetic\\Project-${i % 100}`);
    for (let d = 0; d < 10; d++) builder.add(id, `model-${d % 5}`, `2026-09-${String(d + 1).padStart(2, '0')}T12:00:00Z`, {
      inputTokens: 1000, outputTokens: 200, cachedInputTokens: 500, reasoningOutputTokens: 50, totalTokens: 1200,
    });
  }
  const started = performance.now();
  saveHistoryAttempt(h.app.ctx, 'history.workbuddy', 1, attachDetails({ status:'ok', checkedAt:'2026-10-03T00:00:00Z',
    totals:{ inputTokens:100000000, outputTokens:20000000, cachedInputTokens:50000000, reasoningOutputTokens:5000000,totalTokens:120000000 },
    byDay:[], byModel:[], firstAt:null,lastAt:null,warnings:[],message:'Synthetic benchmark' }, builder), 'D:\\Synthetic');
  const insertMs = performance.now() - started;
  const results = [];
  for (const path of ['/api/history/sessions', '/api/history/sessions?page=100', '/api/history/workspaces', '/api/history/analytics', '/api/history/analytics?from=2026-09-03&to=2026-09-07&model=model-2', '/api/history/dashboard']) {
    const samples = []; let response;
    for (let i = 0; i < 3; i++) {
      const start = performance.now(); response = await h.request('GET', path); samples.push(performance.now() - start);
      assert.equal(response.status, 200, path);
    }
    const bytes = Buffer.byteLength(JSON.stringify(response.body));
    assert.ok(bytes < 300000, `bounded response: ${path} ${bytes}`);
    if (path.startsWith('/api/history/sessions')) assert.equal(response.body.items.length, 50);
    if (path === '/api/history/sessions') { assert.equal(response.body.total, sessions); assert.equal(response.body.summary.totals.totalTokens,120000000); }
    if (path === '/api/history/analytics') assert.equal(response.body.summary.totals.totalTokens,120000000);
    if (path === '/api/history/dashboard') assert.ok(!JSON.stringify(response.body).includes('benchmark-'));
    const sorted = [...samples].sort((a,b)=>a-b);
    results.push({path,medianMs:Math.round(sorted[1]),maxMs:Math.round(sorted.at(-1)),bytes});
    console.log(JSON.stringify(results.at(-1)));
    assert.ok(sorted[1] < 3000, `interactive query budget: ${path} ${sorted[1]}ms`);
  }
  mkdirSync('tmp', {recursive:true});
  writeFileSync('tmp/explorer-performance.json',JSON.stringify({sessions,buckets,insertMs:Math.round(insertMs),node:process.version,results},null,2));
  console.log(JSON.stringify({sessions,buckets,results},null,2));
} finally { h.close(); }
