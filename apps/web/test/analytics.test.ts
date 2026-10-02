import { tokenCoverage } from '@aicc/core';
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, cacheInputRate, buildSources, calendarDays, sumKnown, type SourceData } from '../src/analytics.js';
const source = (id: string, included: boolean): SourceData => ({ id, label: id, included, reason: null, total: 12,
  days: [{ day: '2026-09-01', value: 12 }], models: [{ name: 'model', value: 12 }], warnings: [] });
test('all-source charts exclude overlapping sources but standalone selection permits them', () => {
  const rows = [source('codex', true), source('imported:OpenAI', false)];
  assert.equal(aggregate(rows, 'all').days[0]?.value, 12);
  assert.equal(aggregate(rows, 'all').models[0]?.value, 12);
  assert.equal(aggregate(rows, 'imported:OpenAI').days[0]?.value, 12);
});
test('official Codex totals and days do not blend with local model and component details', () => {
  const rows = buildSources({ totalTokens: 100, partial: false, warnings: [], sources: [{ id: 'codex', label: 'Codex 官方账户统计', totalTokens: 100, included: true, reason: null }] }, {
    codex: { status: 'ok', statisticsSource: 'official', dailySource: 'official',
      totals: { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: 100 },
      localTotals: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, totalTokens: 12 },
      firstAt: null, lastAt: null, warnings: [], message: '',
      byDay: [{ day: '2026-09-01', totals: { inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: 50 } }],
      byModel: [{ model: 'local-model', totals: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, totalTokens: 12 } }],
    },
  });
  assert.equal(rows[0]?.total, 100);
  assert.equal(rows[0]?.statisticsSource, 'official');
  assert.equal(aggregate(rows, 'codex').days[0]?.value, 50);
  assert.equal(aggregate(rows, 'codex').models[0]?.value, 12);
  assert.equal(aggregate(rows, 'codex').input, 10);
});
test('verified official components override the preserved local fallback', () => {
  const totals = { inputTokens: 90, outputTokens: 10, cachedInputTokens: 70, reasoningOutputTokens: null, totalTokens: 100 };
  const rows = buildSources({ totalTokens: 100, partial: false, warnings: [], sources: [{ id: 'codex', label: 'Codex', totalTokens: 100, included: true, reason: null }] }, {
    codex: { status: 'ok', totals, detailsSource: 'official', detailTotals: totals,
      localTotals: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8, totalTokens: 12 },
      firstAt: null, lastAt: null, warnings: [], message: '', byDay: [], byModel: [{ model: 'official-model', totals }] },
  });
  assert.equal(aggregate(rows, 'codex').input, 90);
  assert.equal(aggregate(rows, 'codex').models[0]?.name, 'official-model');
  assert.equal(aggregate(rows, 'codex').reasoning, null);
});
test('unknown components and absent calendar days never become zero', () => {
  assert.equal(sumKnown([null, undefined]), null);
  assert.equal(sumKnown([0, null]), 0);
  assert.equal(sumKnown([Number.MAX_SAFE_INTEGER, 1]), null);
  assert.deepEqual(calendarDays([{ day: '2026-09-02', value: 0 }], 2), [{ day: '2026-09-01', value: null }, { day: '2026-09-02', value: 0 }]);
  assert.equal(aggregate([source('codex', true)], 'all').input, null);
});
test('invalid dates do not invent calendar activity', () => {
  const row = source('codex', true);
  row.days = [{day:'2026-02-31',value:99},{day:'未知日期',value:99}];
  assert.equal(aggregate([row], 'all').days.length, 0);
});
test('imported provider names bind to authoritative source ids', () => {
  const rows = buildSources({ totalTokens: 12, partial: false, warnings: [], sources: [{ id: 'imported:test', label: '已导入：test', totalTokens: 12, included: true, reason: null }] }, {}, { providers: [{ provider: 'test', totals: { inputTokens: 10, outputTokens: 2, cachedInputTokens: null, totalTokens: 12 }, firstAt: null, lastAt: null, byDay: [{ date: '2026-09-01', totalTokens: 12 }], byModel: [{ model: null, totalTokens: 12 }] }] });
  assert.equal(aggregate(rows, 'all').input, 10);
  assert.equal(rows[0]?.models[0]?.name, '未记录模型');
});


test('cache ratio requires matching complete coverage and never clamps invalid values', () => {
  const make = (input: number | null, cached: number | null): SourceData => {
    const totals = { inputTokens: input, cachedInputTokens: cached, outputTokens: 0, totalTokens: input };
    return { ...source('test', true), totals, coverage: tokenCoverage([totals], totals) };
  };
  assert.equal(cacheInputRate([make(100, 100), make(900, null)]), null);
  assert.equal(cacheInputRate([make(100, 0)]), 0);
  assert.equal(cacheInputRate([make(100, 20)]), 20);
  assert.equal(cacheInputRate([make(0, 0)]), null);
  assert.equal(cacheInputRate([make(100, 101)]), null);
  assert.equal(cacheInputRate([make(Number.MAX_SAFE_INTEGER, 1), make(1, 0)]), null);
  const partial = make(100, 30); partial.coverage!.cachedInputTokens = 'partial';
  assert.equal(cacheInputRate([partial]), null);
  delete partial.coverage; assert.equal(cacheInputRate([partial]), null);
});
