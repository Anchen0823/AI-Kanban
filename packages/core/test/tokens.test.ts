import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTokens,
  applyCumulativeUpdate,
  computeTotalFromParts,
  describeCoverage,
  EMPTY_TOKENS,
  normalizeExclusiveBuckets,
  normalizeOpenAiLike,
  readToken,
} from '../src/tokens.js';

/** Token 归一化。设计稿 §5.3 / §15 的 U02、U03 直接对应这里。 */

test('U02：输入含缓存、输出含推理时总量为 12,000 而非 19,000', () => {
  const raw = {
    input_tokens: 10000,
    output_tokens: 2000,
    total_tokens: 12000,
    input_tokens_details: { cached_tokens: 6000 },
    output_tokens_details: { reasoning_tokens: 1000 },
  };

  const n = normalizeOpenAiLike(raw);

  assert.equal(n.inputTotal, 10000);
  assert.equal(n.outputTotal, 2000);
  assert.equal(n.cachedInput, 6000);
  assert.equal(n.reasoningOutput, 1000);
  assert.equal(n.totalReported, 12000, 'total 必须是 input + output');
  assert.notEqual(n.totalReported, 19000, '子项不得重复相加');

  // 与供应商自报的 total_tokens 一致，因此不该产生不一致告警
  assert.deepEqual(n.warnings, []);
  assert.equal(computeTotalFromParts({ inputTotal: n.inputTotal, outputTotal: n.outputTotal }), 12000);
});

test('供应商只报告总量时保留总量，并说明无法核对子集语义', () => {
  // 这是回归测试。以前这种输入会被当成「未知」，导致整条记录被拒 ——
  // 等于把一条真实记录丢掉，只因为它的形状和预期的不一样。
  const n = normalizeOpenAiLike({ total_tokens: 99999 });
  assert.equal(n.totalReported, 99999);
  assert.equal(n.inputTotal, null);
  assert.equal(n.outputTotal, null, '没有分量就是 null，不能凭空拆出一个输入数');
  assert.equal(n.warnings.length, 1);
  assert.match(n.warnings[0] as string, /只报告了总量/);
});

test('有分量时以分量为准，供应商自报总量只用于交叉核对', () => {
  const n = normalizeOpenAiLike({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  assert.equal(n.totalReported, 15);
  assert.deepEqual(n.warnings, [], '一致时不该报警');

  const mismatch = normalizeOpenAiLike({ input_tokens: 10, output_tokens: 5, total_tokens: 999 });
  assert.equal(mismatch.totalReported, 15);
  assert.match(mismatch.warnings[0] as string, /不一致/);
});

test('U02 变体：cached 与 reasoning 为 0 是真实值，不是未知', () => {
  const n = normalizeOpenAiLike({
    input_tokens: 500,
    output_tokens: 100,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(n.cachedInput, 0);
  assert.equal(n.reasoningOutput, 0);
  assert.equal(n.totalReported, 600);
});

test('U03：供应商未报告 token 时是 null，不是 0', () => {
  const n = normalizeOpenAiLike({ model: 'unknown-provider', currency: 'USD' });

  assert.equal(n.inputTotal, null);
  assert.equal(n.outputTotal, null);
  assert.equal(n.totalReported, null);
  assert.notEqual(n.totalReported, 0, 'INV-01：未知不得用 0 冒充');

  const agg = aggregateTokens([{ tokens: n, value: n.totalReported }]);
  assert.equal(agg.value, null);
  assert.deepEqual(describeCoverage(agg), '供应商未报告 token（1 条记录）');
});

test('INV-01：0 与 null 在聚合里必须区分', () => {
  const zero = normalizeOpenAiLike({ input_tokens: 0, output_tokens: 0 });
  const unknown = normalizeOpenAiLike({});

  const aggZero = aggregateTokens([{ tokens: zero, value: zero.totalReported }]);
  assert.equal(aggZero.value, 0, '真实为零要显示 0');
  assert.equal(aggZero.partial, false);

  const aggMixed = aggregateTokens([
    { tokens: zero, value: zero.totalReported },
    { tokens: unknown, value: unknown.totalReported },
  ]);
  assert.equal(aggMixed.value, 0);
  assert.equal(aggMixed.partial, true, '存在未知项时必须标记为部分覆盖');
  assert.equal(aggMixed.unknownCount, 1);
  assert.match(describeCoverage(aggMixed), /覆盖 1\/2 条记录/);
});

test('子集语义被违反时记录告警，但不用假数据覆盖', () => {
  const n = normalizeOpenAiLike({
    input_tokens: 100,
    output_tokens: 50,
    input_tokens_details: { cached_tokens: 300 },
  });
  assert.equal(n.cachedInput, 300, '保留原始子项，不做修正');
  assert.equal(n.totalReported, 150, '总量仍只按 input + output');
  assert.equal(n.warnings.length, 1);
  assert.match(n.warnings[0] as string, /cached_input\(300\) 大于 input_total\(100\)/);
});

test('供应商自报总量与子集语义不一致时告警，不静默采信', () => {
  const n = normalizeOpenAiLike({ input_tokens: 100, output_tokens: 50, total_tokens: 999 });
  assert.equal(n.totalReported, 150);
  assert.equal(n.warnings.length, 1);
  assert.match(n.warnings[0] as string, /供应商 total_tokens\(999\)/);
});

test('非整数、负数、非法字符串一律视为未知', () => {
  assert.equal(readToken({ x: 1.5 }, 'x'), null);
  assert.equal(readToken({ x: -1 }, 'x'), null);
  assert.equal(readToken({ x: 'abc' }, 'x'), null);
  assert.equal(readToken({ x: true }, 'x'), null);
  assert.equal(readToken({ x: null }, 'x'), null);
  assert.equal(readToken({}, 'x'), null);
  assert.equal(readToken({ x: '123' }, 'x'), 123);
});

test('兼容 prompt_tokens / completion_tokens 旧字段名', () => {
  const n = normalizeOpenAiLike({ prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(n.inputTotal, 10);
  assert.equal(n.outputTotal, 5);
  assert.equal(n.totalReported, 15);
});

test('嵌套在 usage 下的字段也能读到', () => {
  const n = normalizeOpenAiLike({
    usage: {
      input_tokens: 800,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 50 },
    },
  });
  assert.equal(n.totalReported, 1000);
  assert.equal(n.cachedInput, 100);
  assert.equal(n.reasoningOutput, 50);
});

test('互斥桶式：总量为各桶之和，缺失桶导致不完整', () => {
  const complete = normalizeExclusiveBuckets([
    { name: 'text_input', tokens: 100 },
    { name: 'image_input', tokens: 50 },
  ]);
  assert.equal(complete.basis, 'exclusive_buckets');
  assert.equal(complete.totalReported, 150);
  assert.deepEqual(complete.warnings, []);

  const partial = normalizeExclusiveBuckets([
    { name: 'text_input', tokens: 100 },
    { name: 'image_input', tokens: null },
  ]);
  assert.equal(partial.totalReported, 100);
  assert.equal(partial.warnings.length, 1);
  assert.match(partial.warnings[0] as string, /总和/);
});

test('不同归一化依据不得混加：返回 null 并说明原因', () => {
  const a = normalizeOpenAiLike({ input_tokens: 100, output_tokens: 0 });
  const b = normalizeExclusiveBuckets([{ name: 'x', tokens: 100 }]);
  const agg = aggregateTokens([
    { tokens: a, value: a.totalReported },
    { tokens: b, value: b.totalReported },
  ]);
  assert.equal(agg.value, null);
  assert.equal(agg.skippedByBasis, 2);
  assert.match(describeCoverage(agg), /多种归一化依据/);
});

test('INV-07：累计计数回退按新窗口处理，绝不产生负数', () => {
  assert.deepEqual(applyCumulativeUpdate(null, 500), { kind: 'initial', total: 500 });
  assert.deepEqual(applyCumulativeUpdate(500, 800), { kind: 'updated', total: 800, delta: 300 });
  assert.deepEqual(applyCumulativeUpdate(500, 500), { kind: 'updated', total: 500, delta: 0 });

  const reset = applyCumulativeUpdate(5000, 120);
  assert.equal(reset.kind, 'reset');
  if (reset.kind !== 'reset') throw new Error('不可达：上面刚断言过 kind 为 reset');
  assert.equal(reset.total, 120);
  assert.equal(reset.previousTotal, 5000);
});

test('空归一化结果不参与旧依据统计', () => {
  assert.equal(EMPTY_TOKENS.totalReported, null);
  assert.equal(EMPTY_TOKENS.basis, 'unknown');

  const agg = aggregateTokens([{ tokens: EMPTY_TOKENS, value: null }]);
  assert.equal(agg.value, null);
  assert.equal(agg.unknownCount, 1);
  assert.equal(describeCoverage(agg), '供应商未报告 token（1 条记录）');

  // 完全没有任何记录时才是「无数据」
  assert.equal(describeCoverage(aggregateTokens([])), '无数据');
});
