import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCacheInputSample, tokenCoverage } from '../src/history.js';

test('field coverage distinguishes complete zero, partially reported counters and unknown totals', () => {
  const rows = [{ inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, { inputTokens: 200, cachedInputTokens: null, outputTokens: 30 }];
  const coverage = tokenCoverage(rows, { inputTokens: 300, cachedInputTokens: 0, outputTokens: 50, totalTokens: null });
  assert.deepEqual(coverage, { inputTokens: 'complete', cachedInputTokens: 'partial', outputTokens: 'complete', reasoningOutputTokens: 'unknown', totalTokens: 'unknown' });
});

test('matched cache samples retain real zero and exclude incomplete or invalid pairs without overflowing', () => {
  assert.deepEqual(collectCacheInputSample([
    { inputTokens: 100, cachedInputTokens: 20 }, { inputTokens: 900 },
    { inputTokens: 50, cachedInputTokens: 0 }, { inputTokens: 5, cachedInputTokens: 6 },
  ]), { inputTokens: 150, cachedInputTokens: 20, matchedRecords: 2, totalRecords: 4 });
  assert.equal(collectCacheInputSample([{ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0 }, { inputTokens: 1, cachedInputTokens: 0 }]), undefined);
  assert.equal(collectCacheInputSample([{ inputTokens: -1, cachedInputTokens: 0 }, { inputTokens: 1.5, cachedInputTokens: 0 }]), undefined);
});
