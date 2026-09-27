import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, buildSources, calendarDays, sumKnown, type SourceData } from '../src/analytics.js';
const source = (id: string, included: boolean): SourceData => ({ id, label: id, included, reason: null, total: 12,
  days: [{ day: '2026-09-01', value: 12 }], models: [{ name: 'model', value: 12 }], warnings: [] });
test('all-source charts exclude overlapping sources but standalone selection permits them', () => {
  const rows = [source('codex', true), source('imported:OpenAI', false)];
  assert.equal(aggregate(rows, 'all').days[0]?.value, 12);
  assert.equal(aggregate(rows, 'all').models[0]?.value, 12);
  assert.equal(aggregate(rows, 'imported:OpenAI').days[0]?.value, 12);
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
