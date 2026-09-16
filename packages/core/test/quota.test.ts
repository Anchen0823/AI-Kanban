import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateQuota, formatDuration, groupBuckets, type QuotaBucketView } from '../src/quota.js';

/** 额度新鲜度。设计稿 §5.6 / §15 的 U07 直接对应这里。 */

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-09-16T10:00:00.000Z');

function snapshot(overrides: Partial<Parameters<typeof evaluateQuota>[0]> = {}) {
  return {
    observedAt: new Date(T0).toISOString(),
    resetAt: new Date(T0 + 5 * HOUR).toISOString(),
    staleAfterSeconds: 21600,
    usedRatio: 0.4,
    remainingRatio: 0.6,
    windowKind: 'hourly' as const,
    windowSeconds: 3600,
    measurementQuality: 'provider_reported' as const,
    ...overrides,
  };
}

test('U07：已过重置时间但未重新查询 → 待刷新，绝不显示 100%', () => {
  const status = evaluateQuota(snapshot(), T0 + 6 * HOUR);

  assert.equal(status.state, 'pending_refresh');
  assert.match(status.label, /待刷新/);
  assert.equal(status.ratioAuthoritative, false, '旧窗口的比例不可当作当前值');
  assert.ok(
    status.reasons.some((r) => r.includes('不会自动按 100% 计算')),
    '必须明确说明不会假装恢复满额',
  );
  assert.ok(status.untilResetSeconds !== null && status.untilResetSeconds < 0, '重置时间应已过去');
});

test('重置时间已过，但快照本身就是重置后取的 → 属于当前窗口，仍然新鲜', () => {
  const resetAt = new Date(T0 + 5 * HOUR).toISOString();
  const status = evaluateQuota(
    snapshot({ observedAt: new Date(T0 + 5 * HOUR + 60 * 1000).toISOString(), resetAt, usedRatio: 0.05, remainingRatio: 0.95 }),
    T0 + 5 * HOUR + 120 * 1000,
  );
  assert.equal(status.state, 'fresh');
  assert.equal(status.ratioAuthoritative, true);
});

test('超过新鲜度阈值 → 已过期快照', () => {
  // 窗口还开着（reset 在 48 小时后），但上次观测已经过去 7 小时
  const status = evaluateQuota(
    snapshot({ resetAt: new Date(T0 + 48 * HOUR).toISOString() }),
    T0 + 7 * HOUR,
  );
  assert.equal(status.state, 'stale');
  assert.match(status.label, /已过期/);
  assert.equal(status.ratioAuthoritative, false);
  assert.equal(status.ageSeconds, 7 * 3600);
});

test('窗口已过 且 观测已旧 → 报「待刷新」而不是「已过期」', () => {
  // 两种异常同时成立时，pending_refresh 信息量更大：这组数值来自一个已经死掉的窗口，
  // 说「过期」只说明它旧，说「待刷新」才说明它现在完全不能代表当前额度。
  const status = evaluateQuota(snapshot(), T0 + 7 * HOUR);
  assert.equal(status.state, 'pending_refresh');
});

test('从未观测 → 未知，而不是 0%', () => {
  const status = evaluateQuota(snapshot({ observedAt: null }), T0);
  assert.equal(status.state, 'unknown');
  assert.equal(status.ratioAuthoritative, false);
  assert.equal(status.ageSeconds, null);
});

test('used 与 remaining 之和不等于 1 → 标记自相矛盾，不给权威值', () => {
  const status = evaluateQuota(snapshot({ usedRatio: 0.9, remainingRatio: 0.9 }), T0);
  assert.equal(status.inconsistent, true);
  assert.equal(status.ratioAuthoritative, false);
  assert.ok(status.reasons.some((r) => r.includes('自相矛盾')));

  // 容差内的浮点误差不算矛盾
  const tolerant = evaluateQuota(snapshot({ usedRatio: 0.4, remainingRatio: 0.6001 }), T0);
  assert.equal(tolerant.inconsistent, false);
  assert.equal(tolerant.state, 'fresh');
});

test('没有 reset_at 时不推断窗口状态', () => {
  const status = evaluateQuota(snapshot({ resetAt: null }), T0 + 1000);
  assert.equal(status.state, 'fresh');
  assert.equal(status.untilResetSeconds, null);
});

test('分窗口分组：小时窗在前，不做跨窗口平均', () => {
  const mk = (bucketId: string, windowKind: QuotaBucketView['windowKind']): QuotaBucketView => ({
    accountId: 'acc_1',
    bucketId,
    bucketLabel: bucketId,
    windowKind,
    windowSeconds: null,
    sharedWith: [],
    status: evaluateQuota(snapshot({ windowKind }), T0),
    usedRatio: 0.4,
    remainingRatio: 0.6,
    resetAt: null,
    observedAt: new Date(T0).toISOString(),
    measurementQuality: 'provider_reported',
  });

  const groups = groupBuckets([mk('month', 'monthly'), mk('hour', 'hourly'), mk('week', 'weekly')]);
  assert.deepEqual(
    groups.map((g) => g.windowKind),
    ['hourly', 'weekly', 'monthly'],
  );
  // 每个桶保留自己的比例，没有被平均成一个「综合剩余」
  const allRatios = groups.flatMap((g) => g.buckets.map((b) => b.remainingRatio));
  assert.deepEqual(allRatios, [0.6, 0.6, 0.6]);
  assert.equal(groups.length, 3, '三个窗口必须是三组，不能合并');
});

test('时间格式化为中文可读文案', () => {
  assert.equal(formatDuration(30), '30 秒');
  assert.equal(formatDuration(120), '2 分钟');
  assert.equal(formatDuration(3600), '1 小时');
  assert.equal(formatDuration(3660), '1 小时 1 分钟');
  assert.equal(formatDuration(90000), '1 天 1 小时');
});
