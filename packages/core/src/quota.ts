/**
 * 额度快照与新鲜度（设计稿 §5.6，不变量 INV-03 / INV-17 相关）。
 *
 * 额度是**状态**，不是流水。它不参与任何求和，也不和账户汇总、请求明细相加。
 *
 * 三条硬规则：
 * 1. 超过新鲜度阈值 → 显示「已过期快照」，不假装是当前值。
 * 2. 到达预计重置时间但没有重新查询 → 显示「待刷新」，**绝不自动宣称恢复 100%**。
 * 3. 小时窗和周窗分别展示，不平均成「综合剩余百分比」。
 */

import type { MeasurementQuality, QuotaWindowKind } from './enums.js';

export type QuotaState = 'fresh' | 'stale' | 'pending_refresh' | 'unknown';

export interface QuotaSnapshotLike {
  observedAt: string | null;
  resetAt: string | null;
  staleAfterSeconds: number;
  usedRatio: number | null;
  remainingRatio: number | null;
  windowKind: QuotaWindowKind;
  windowSeconds: number | null;
  measurementQuality: MeasurementQuality;
}

export interface QuotaStatus {
  state: QuotaState;
  /** 界面文案。中文，直接可用。 */
  label: string;
  reasons: string[];
  /** 距上次观测的秒数；无观测时间时为 null。 */
  ageSeconds: number | null;
  /** 距预计重置的秒数；无重置时间时为 null。负数表示已过重置时间。 */
  untilResetSeconds: number | null;
  /** used + remaining ≠ 1（超出容差）时为 true，界面应提示数据自相矛盾。 */
  inconsistent: boolean;
  /** 是否允许把 ratio 当作「当前真实值」展示。 */
  ratioAuthoritative: boolean;
}

const RATIO_TOLERANCE = 0.005;

export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function evaluateQuota(snapshot: QuotaSnapshotLike, now: number | Date = Date.now()): QuotaStatus {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const reasons: string[] = [];

  let inconsistent = false;
  if (snapshot.usedRatio !== null && snapshot.remainingRatio !== null) {
    const sum = snapshot.usedRatio + snapshot.remainingRatio;
    if (Math.abs(sum - 1) > RATIO_TOLERANCE) {
      inconsistent = true;
      reasons.push(`used(${snapshot.usedRatio}) 与 remaining(${snapshot.remainingRatio}) 之和不为 1，数值自相矛盾`);
    }
  }

  const observedMs = parseTime(snapshot.observedAt);
  const resetMs = parseTime(snapshot.resetAt);
  const ageSeconds = observedMs === null ? null : Math.floor((nowMs - observedMs) / 1000);
  const untilResetSeconds = resetMs === null ? null : Math.floor((resetMs - nowMs) / 1000);

  if (observedMs === null) {
    return {
      state: 'unknown',
      label: '未知（从未观测）',
      reasons: [...reasons, '没有观测时间，无法判断这组数值是否仍然有效'],
      ageSeconds: null,
      untilResetSeconds,
      inconsistent,
      ratioAuthoritative: false,
    };
  }

  // 窗口已经过去，而快照是在窗口内取得的 → 这是一个已失效的旧窗口。
  // 无论它当时多新鲜，现在都不能宣称「剩余 100%」。
  if (resetMs !== null && nowMs >= resetMs && observedMs < resetMs) {
    return {
      state: 'pending_refresh',
      label: '待刷新（窗口已过，尚未重新查询）',
      reasons: [
        ...reasons,
        `预计重置时间 ${snapshot.resetAt} 已过，但最后一次观测在重置之前`,
        '重置后的真实额度未知，本系统不会自动按 100% 计算',
      ],
      ageSeconds,
      untilResetSeconds,
      inconsistent,
      ratioAuthoritative: false,
    };
  }

  if (ageSeconds !== null && ageSeconds > snapshot.staleAfterSeconds) {
    return {
      state: 'stale',
      label: '已过期快照',
      reasons: [
        ...reasons,
        `距上次观测已 ${formatDuration(ageSeconds)}，超过新鲜度阈值 ${formatDuration(snapshot.staleAfterSeconds)}`,
      ],
      ageSeconds,
      untilResetSeconds,
      inconsistent,
      ratioAuthoritative: false,
    };
  }

  return {
    state: 'fresh',
    label: '新鲜',
    reasons: reasons.length > 0 ? reasons : ['观测时间在新鲜度阈值内'],
    ageSeconds,
    untilResetSeconds,
    inconsistent,
    ratioAuthoritative: !inconsistent,
  };
}

export interface QuotaBucketView {
  accountId: string;
  bucketId: string;
  bucketLabel: string;
  windowKind: QuotaWindowKind;
  windowSeconds: number | null;
  /** 共享范围：这个桶被哪些入口共同消耗。 */
  sharedWith: string[];
  status: QuotaStatus;
  usedRatio: number | null;
  remainingRatio: number | null;
  resetAt: string | null;
  observedAt: string | null;
  measurementQuality: MeasurementQuality;
}

/**
 * 分窗口展示配额桶。**不做跨窗口平均**（§5.6）。
 * 排序按窗口粒度从短到长，让「小时窗是不是要爆了」先被看到。
 */
export function groupBuckets(buckets: readonly QuotaBucketView[]): Array<{ windowKind: QuotaWindowKind; buckets: QuotaBucketView[] }> {
  const order: QuotaWindowKind[] = ['hourly', 'daily', 'weekly', 'monthly', 'custom'];
  const map = new Map<QuotaWindowKind, QuotaBucketView[]>();
  for (const b of buckets) {
    const list = map.get(b.windowKind) ?? [];
    list.push(b);
    map.set(b.windowKind, list);
  }
  return order
    .filter((k) => map.has(k))
    .map((k) => ({ windowKind: k, buckets: map.get(k) as QuotaBucketView[] }));
}

export const WINDOW_LABELS: Record<QuotaWindowKind, string> = {
  hourly: '小时窗',
  daily: '日窗',
  weekly: '周窗',
  monthly: '月窗',
  custom: '自定义窗口',
};

export function formatDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${abs} 秒`;
  if (abs < 3600) return `${Math.floor(abs / 60)} 分钟`;
  if (abs < 86400) {
    const h = Math.floor(abs / 3600);
    const m = Math.floor((abs % 3600) / 60);
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
}
