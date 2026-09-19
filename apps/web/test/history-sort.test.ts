import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDates, compareModels } from '../src/history-sort.ts';

test('历史截图中的 Codex 模型按版本和产品层级倒序', () => {
  const models = [
    '未记录模型',
    'gpt-5.5',
    'codex-auto-review',
    'gpt-5.6-luna',
    'gpt-6-astra',
    'gpt-5.6-sol',
    null,
    'gpt-5.6-terra',
  ];
  assert.deepEqual(models.sort(compareModels), [
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'codex-auto-review',
    null,
    '未记录模型',
  ]);
});

test('未来版本走自然数字排序，同版本 pro 在 flash 之前', () => {
  const models = ['gpt-6-sol', 'gpt-6-astra', 'gpt-5.6-flash', 'gpt-5.10-terra', 'gpt-5.6-pro', 'gpt-12.0-luna', 'gpt6astra'];
  assert.deepEqual(models.sort(compareModels), [
    'gpt-12.0-luna',
    'gpt-6-astra',
    'gpt6astra',
    'gpt-6-sol',
    'gpt-5.10-terra',
    'gpt-5.6-pro',
    'gpt-5.6-flash',
  ]);
});

test('DeepSeek 截图模型与未来 vN 版本都按版本和档位倒序', () => {
  const screenshotModels = [
    'deepseek-reasoner',
    'deepseek-v4-flash',
    'deepseek-chat',
    'deepseek-flash',
    'deepseek-v4-pro',
    'deepseek-v5-flash',
  ];
  assert.deepEqual(screenshotModels.sort(compareModels), [
    'deepseek-v5-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-flash',
    'deepseek-chat',
    'deepseek-reasoner',
  ]);
});

test('历史日期最新优先，未知或畸形日期最后', () => {
  const dates = ['未知日期', '2026-09-08', 'not-a-date', '2026-10-01', '2026-09-19T01:03:00.000Z'];
  assert.deepEqual(dates.sort(compareDates), [
    '2026-10-01',
    '2026-09-19T01:03:00.000Z',
    '2026-09-08',
    'not-a-date',
    '未知日期',
  ]);
});
