import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenCoverage } from '../src/history.js';

test('field coverage distinguishes complete zero, partially reported counters and unknown totals', () => {
  const rows = [{ inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, { inputTokens: 200, cachedInputTokens: null, outputTokens: 30 }];
  const coverage = tokenCoverage(rows, { inputTokens: 300, cachedInputTokens: 0, outputTokens: 50, totalTokens: null });
  assert.deepEqual(coverage, { inputTokens: 'complete', cachedInputTokens: 'partial', outputTokens: 'complete', reasoningOutputTokens: 'unknown', totalTokens: 'unknown' });
});
