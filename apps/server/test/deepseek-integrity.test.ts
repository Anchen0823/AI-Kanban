import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { createHarness } from './helpers.js';
import { getSetting } from '../src/db/repos/system.js';
import { scanDeepseekHistory, runDeepseekHistory, getDeepseekHistory } from '../src/services/deepseek-history.js';

const AH = 'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount';
const CH = 'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency';
const row = (amount = '100', type = 'output_tokens') => `synthetic-user,2025-01-02T00:00:00Z,2025-01-03T00:00:00Z,synthetic-model,synthetic-key-name,synthetic-key,${type},1,${amount}`;
const cost = 'synthetic-user,2025-01-02T00:00:00Z,2025-01-03T00:00:00Z,synthetic-model,Paid,1.25,CNY';
type Files = Record<string, string | Uint8Array>;

async function setup(files: Files) {
  const h = await createHarness();
  const oldDir = join(h.dir, 'old-export');
  const newDir = join(h.dir, 'new-export');
  await mkdir(oldDir); await mkdir(newDir);
  await writeFile(join(oldDir, 'amount.csv'), `${AH}\n${row()}`);
  await writeFile(join(oldDir, 'cost.csv'), `${CH}\n${cost}`);
  await runDeepseekHistory(h.app.ctx, { directory: oldDir });
  const previous = getDeepseekHistory(h.app.ctx);
  const rawPrevious = getSetting(h.app.db, 'history.deepseek');
  for (const [name, content] of Object.entries(files)) await writeFile(join(newDir, name), content);
  return { h, oldDir, newDir, previous, rawPrevious };
}

async function assertRetained(files: Files, t: { diagnostic(message: string): void }) {
  const s = await setup(files);
  try {
    const response = await runDeepseekHistory(s.h.app.ctx, { directory: s.newDir });
    const after = getDeepseekHistory(s.h.app.ctx);
    t.diagnostic(JSON.stringify({ attempted: response.status, tokens: after.totals.totalTokens, costs: after.costs,
      rememberedOld: after.sourceDirectory === s.oldDir, stale: after.sync?.stale, warnings: response.warnings }));
    assert.equal(response.status, 'error', 'unusable or corrupted input must not commit a successful replacement');
    assert.equal(getSetting(s.h.app.db, 'history.deepseek'), s.rawPrevious, 'entire old snapshot must be unchanged');
    assert.equal(after.sourceDirectory, s.oldDir);
    assert.equal(after.sync?.stale, true);
    assert.equal(after.sync?.lastSuccessAt, s.previous.sync?.lastSuccessAt);
    assert.equal(after.sync?.lastAttempt?.status, 'error');
    const reuse = await runDeepseekHistory(s.h.app.ctx);
    assert.deepEqual(reuse.totals, s.previous.totals);
    assert.deepEqual(reuse.costs, s.previous.costs);
  } finally { s.h.close(); }
}

test('R01 wholly unusable inputs preserve the complete snapshot and old directory', async t => {
  const cases: Record<string, Files> = {
    'wrong headers': { 'other.csv': 'date,value\n2025-01-02,99' },
    'invalid amount': { 'amount.csv': `${AH}\n${row('bad')}` },
    'invalid cost': { 'cost.csv': `${CH}\n${cost.replace(',1.25,', ',bad,')}` },
    'zero byte CSV': { 'empty.csv': '' },
    'empty ZIP': { 'empty.zip': zipSync({}) },
    'ZIP with nested CSV only': { 'nested.zip': zipSync({ 'nested/amount.csv': strToU8(`${AH}\n${row()}`) }) },
    'valid headers plus wrong headers': { 'amount.csv': AH, 'other.csv': 'wrong,header\n1,2' },
  };
  for (const [name, files] of Object.entries(cases)) await t.test(name, sub => assertRetained(files, sub));
});

test('R02 hard failure after parsing valid data rolls the scan back', async t => {
  const cases: Record<string, Files> = {
    'invalid UTF-8 after valid CSV': { 'a.csv': `${AH}\n${row('5')}`, 'z.csv': new Uint8Array([255]) },
    'bad ZIP after valid CSV': { 'a.csv': `${AH}\n${row('5')}`, 'z.zip': 'corrupt ZIP' },
  };
  for (const [name, files] of Object.entries(cases)) await t.test(name, sub => assertRetained(files, sub));
});

test('R03 truncated quoted record must not clear old statistics as a successful empty import', t =>
  assertRetained({ 'amount.csv': `${AH}\n"` }, t));

test('R04 invalid amount file plus valid cost file must not erase prior token statistics', t =>
  assertRetained({ 'amount.csv': `${AH}\n${row('bad')}`, 'cost.csv': `${CH}\n${cost}` }, t));

test('R05 mixed valid and invalid known rows must not publish an incomplete replacement', t =>
  assertRetained({ 'amount.csv': `${AH}\n${row('5')}\n${row('bad', 'input_cache_miss_tokens')}` }, t));

test('R06 empty scans and intentionally cost-only scans remain supported', async t => {
  for (const [name, files, expected] of [
    ['empty directory', {}, 'empty'],
    ['header only', { 'amount.csv': AH }, 'empty'],
    ['cost only', { 'cost.csv': `${CH}\n${cost}` }, 'ok'],
    ['request count only', { 'amount.csv': `${AH}\n${row('5', 'request_count')}` }, 'ok'],
  ] as const) await t.test(name, async () => {
    const s = await setup(files);
    try {
      const r = await runDeepseekHistory(s.h.app.ctx, { directory: s.newDir });
      assert.equal(r.status, expected);
      assert.equal(r.sourceDirectory, s.newDir);
      assert.equal(r.sync?.stale, false);
    } finally { s.h.close(); }
  });
});

test('R07 date range validation: leap years, reversed dates, impossible days, year boundaries', async t => {
  const cases = [
    ['1900-02-29', '1900-03-01', false], ['2000-02-29', '2000-03-01', true],
    ['2024-02-29', '2024-03-01', true], ['2025-02-29', '2025-03-01', false],
    ['2025-04-31', '2025-05-01', false], ['2025-00-01', '2025-01-01', false],
    ['2025-01-00', '2025-01-01', false], ['2025-12-32', '2026-01-01', false],
    ['2025-99-99', '2026-01-01', false], ['2025-04-30', '2025-04-01', false],
    ['2025-12-31', '2026-01-01', true], ['9999-12-31', '9999-12-31', true],
    ['0000-02-29', '0000-03-01', true],
  ] as const;
  for (const [start, end, valid] of cases) await t.test(`${start}_${end}`, async () => {
    const s = await setup({ [`amount-${start}_${end}.CSV`]: `${AH}\n${row('5')}` });
    try {
      const r = await scanDeepseekHistory({ directory: s.newDir });
      assert.equal(r.status, 'ok');
      assert.equal(r.totals.totalTokens, 5);
      assert.equal(r.warnings.some(w => w.includes('日期范围无效')), !valid);
      assert.equal(r.message.includes(`声明范围 ${start} 至 ${end}`), valid);
    } finally { s.h.close(); }
  });
});

test('R08 overlapping ranges at year 9999 must not invent a gap', async t => {
  const s = await setup({
    'a-9999-01-01_9999-12-31.csv': `${AH}\n${row('5')}`,
    'b-9999-06-01_9999-06-30.csv': AH,
  });
  try {
    const r = await scanDeepseekHistory({ directory: s.newDir });
    t.diagnostic(r.message);
    assert.equal(r.status, 'ok');
    assert.ok(!r.warnings.some(w => w.includes('范围空档')));
  } finally { s.h.close(); }
});

test('R09 failed directory persistence must roll back the associated snapshot and success metadata', async t => {
  const s = await setup({ 'amount.csv': `${AH}\n${row('5')}` });
  try {
    s.h.app.db.exec(`CREATE TRIGGER review_fail_directory BEFORE UPDATE ON app_settings
      WHEN NEW.key = 'history.deepseek.directory'
      BEGIN SELECT RAISE(ABORT, 'review injected directory write failure'); END`);
    await assert.rejects(runDeepseekHistory(s.h.app.ctx, { directory: s.newDir }), /review injected/);
    const after = getDeepseekHistory(s.h.app.ctx);
    t.diagnostic(JSON.stringify({ tokens: after.totals.totalTokens, rememberedOld: after.sourceDirectory === s.oldDir,
      stale: after.sync?.stale, lastAttemptStatus: after.sync?.lastAttempt?.status }));
    assert.equal(getSetting(s.h.app.db, 'history.deepseek'), s.rawPrevious);
    assert.deepEqual(after, s.previous, 'failed persistence restores metadata and directory too');
  } finally { s.h.close(); }
});

test('R10 impossible calendar day in CSV rows must not become a successful import', t =>
  assertRetained({ 'amount.csv': `${AH}\n${row('5').replace('2025-01-02', '2025-02-29').replace('2025-01-03', '2025-03-02')}` }, t));


test('R11 mixed damaged exports reject the entire replacement', async t => {
  const cases: Record<string, Files> = {
    'truncated record after valid data': { 'amount.csv': `${AH}\n${row('5')}\n"` },
    'valid amount and invalid cost': { 'amount.csv': `${AH}\n${row('5')}`, 'cost.csv': `${CH}\n${cost.replace(',1.25,', ',bad,')}` },
    'valid amount and unrecognized file': { 'amount.csv': `${AH}\n${row('5')}`, 'other.csv': 'wrong,header\n1,2' },
    'valid amount and empty ZIP': { 'amount.csv': `${AH}\n${row('5')}`, 'empty.zip': zipSync({}) },
    'missing required value': { 'amount.csv': `${AH}\n${row('5')}\n${row('6').replace('synthetic-model', '')}` },
    'duplicate required header': { 'amount.csv': `${AH},amount\n${row('5')},6` },
    'extra row cell': { 'amount.csv': `${AH}\n${row('5')},extra` },
    'missing row cell': { 'amount.csv': `${AH}\n${row('5').slice(0, -2)}` },
    'invalid end calendar date': { 'amount.csv': `${AH}\n${row('5').replace('2025-01-03', '2025-02-29')}` },
    'invalid request count price': { 'amount.csv': `${AH}\n${row('5', 'request_count').replace(',1,5', ',bad,5')}` },
  };
  for (const [name, files] of Object.entries(cases)) await t.test(name, sub => assertRetained(files, sub));
});

test('R12 real SQLite write failures roll back every key on first import and replacement', async t => {
  for (const existing of [false, true]) {
    for (const key of ['history.deepseek', 'history.deepseek.sync', 'history.deepseek.directory']) {
      await t.test(`${existing ? 'update' : 'insert'} ${key}`, async () => {
        const s = await setup({ 'amount.csv': `${AH}\n${row('5')}` });
        try {
          if (!existing) s.h.app.db.exec("DELETE FROM app_settings WHERE key LIKE 'history.deepseek%'");
          const keys = ['history.deepseek', 'history.deepseek.sync', 'history.deepseek.directory'];
          const before = keys.map(k => getSetting(s.h.app.db, k));
          s.h.app.db.exec(`CREATE TRIGGER fail_history_write BEFORE ${existing ? 'UPDATE' : 'INSERT'} ON app_settings
            WHEN NEW.key = '${key}'
            BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`);
          await assert.rejects(runDeepseekHistory(s.h.app.ctx, { directory: s.newDir }), /injected persistence failure/);
          assert.deepEqual(keys.map(k => getSetting(s.h.app.db, k)), before);
          s.h.app.db.exec('DROP TRIGGER fail_history_write');
          const retry = await runDeepseekHistory(s.h.app.ctx, { directory: s.newDir });
          assert.equal(retry.status, 'ok');
          assert.equal(retry.totals.totalTokens, 5);
          assert.equal(retry.sourceDirectory, s.newDir);
          assert.equal(retry.sync?.stale, false);
          assert.deepEqual(getDeepseekHistory(s.h.app.ctx), JSON.parse(JSON.stringify(retry)));
        } finally { s.h.close(); }
      });
    }
  }
});

test('R13 valid leap day preserves the export timezone day', async () => {
  const s = await setup({ 'amount.csv': `${AH}\n${row('5').replace('2025-01-02T00:00:00Z', '2024-02-29T00:00:00+08:00').replace('2025-01-03T00:00:00Z', '2024-03-01T00:00:00+08:00')}` });
  try {
    const r = await runDeepseekHistory(s.h.app.ctx, { directory: s.newDir });
    assert.equal(r.status, 'ok');
    assert.equal(r.byDay[0]?.day, '2024-02-29');
    assert.equal(r.firstAt, '2024-02-28T16:00:00.000Z');
    assert.equal(r.lastAt, '2024-02-29T16:00:00.000Z');
  } finally { s.h.close(); }
});
