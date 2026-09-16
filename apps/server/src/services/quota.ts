/**
 * 额度服务（设计稿 §5.6，U07）。
 *
 * 读出的是「状态」而不是「数值」：每个桶都带上新鲜度判定与解释文案，
 * 让界面能说出「这组数字是什么时候看的、现在还算不算数」。
 */

import { evaluateQuota, groupBuckets, type QuotaBucketView, type QuotaFreshness } from '@aicc/core';
import { tx } from '../db/database.js';
import {
  insertQuotaSnapshot,
  latestQuotaSnapshots,
  listQuotaHistory,
  type QuotaSnapshot,
} from '../db/repos/quota.js';
import { getAccount } from '../db/repos/registry.js';
import type { ServiceContext } from '../service-context.js';
import { audit } from './audit.js';

export interface QuotaSnapshotInput {
  accountId: string;
  bucketId: string;
  bucketLabel: string;
  scope?: string | null;
  windowKind: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';
  windowSeconds?: number | null;
  usedRatio?: number | null;
  remainingRatio?: number | null;
  usedAmountMinor?: string | null;
  limitMinor?: string | null;
  currency?: string | null;
  resetAt?: string | null;
  observedAt: string;
  measurementQuality: 'provider_reported' | 'locally_observed' | 'estimated' | 'unknown';
  collectionMethod: 'official_api' | 'local_log' | 'imported_file' | 'manual';
  sourceRef?: string | null;
  staleAfterSeconds: number;
}

export function saveQuotaSnapshot(ctx: ServiceContext, input: QuotaSnapshotInput): QuotaSnapshot {
  const account = getAccount(ctx.db, input.accountId);
  if (!account) {
    throw new Error(`计费账户不存在：${input.accountId}。额度必须挂在某个账户下。`);
  }

  return tx(ctx.db, () => {
    const snapshot = insertQuotaSnapshot(ctx.db, {
      ...input,
      scope: input.scope ?? null,
      windowSeconds: input.windowSeconds ?? null,
      usedRatio: input.usedRatio ?? null,
      remainingRatio: input.remainingRatio ?? null,
      usedAmountMinor: input.usedAmountMinor ?? null,
      limitMinor: input.limitMinor ?? null,
      currency: input.currency ?? null,
      resetAt: input.resetAt ?? null,
      sourceRef: input.sourceRef ?? null,
      adapterVersion: input.collectionMethod === 'official_api' ? 'official-api-1.0.0' : null,
    });

    audit(ctx, {
      action: 'quota.snapshot',
      entityType: 'quota_snapshot',
      entityId: snapshot.id,
      detail: {
        accountId: snapshot.accountId,
        bucketId: snapshot.bucketId,
        windowKind: snapshot.windowKind,
        usedRatio: snapshot.usedRatio,
        remainingRatio: snapshot.remainingRatio,
        measurementQuality: snapshot.measurementQuality,
        collectionMethod: snapshot.collectionMethod,
      },
    });

    return snapshot;
  });
}

export interface QuotaBucketViewWithFreshness extends QuotaBucketView {
  snapshotId: string;
  scope: string | null;
  windowSeconds: number | null;
  freshness: QuotaFreshness;
  stateLabel: string;
  reasons: string[];
  ageSeconds: number | null;
  untilResetSeconds: number | null;
  inconsistent: boolean;
  ratioAuthoritative: boolean;
  usedAmountMinor: string | null;
  limitMinor: string | null;
  currency: string | null;
  collectionMethod: string;
  sourceRef: string | null;
}

export function quotaBuckets(ctx: ServiceContext): {
  groups: Array<{ windowKind: string; windowLabel: string; buckets: QuotaBucketViewWithFreshness[] }>;
  /** 是否存在需要用户注意的状态（过期 / 待刷新 / 未知）。 */
  needsAttention: number;
} {
  const snapshots = latestQuotaSnapshots(ctx.db);
  const nowMs = ctx.now();

  const views: QuotaBucketViewWithFreshness[] = snapshots.map((snapshot) => {
    const status = evaluateQuota(
      {
        observedAt: snapshot.observedAt,
        resetAt: snapshot.resetAt,
        staleAfterSeconds: snapshot.staleAfterSeconds,
        usedRatio: snapshot.usedRatio,
        remainingRatio: snapshot.remainingRatio,
        windowKind: snapshot.windowKind,
        windowSeconds: snapshot.windowSeconds,
        measurementQuality: snapshot.measurementQuality,
      },
      nowMs,
    );

    return {
      accountId: snapshot.accountId,
      bucketId: snapshot.bucketId,
      bucketLabel: snapshot.bucketLabel,
      snapshotId: snapshot.id,
      scope: snapshot.scope,
      windowKind: snapshot.windowKind,
      windowSeconds: snapshot.windowSeconds,
      sharedWith: snapshot.scope ? snapshot.scope.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [],
      status,
      freshness: status.state,
      stateLabel: status.label,
      reasons: status.reasons,
      ageSeconds: status.ageSeconds,
      untilResetSeconds: status.untilResetSeconds,
      inconsistent: status.inconsistent,
      ratioAuthoritative: status.ratioAuthoritative,
      usedRatio: snapshot.usedRatio,
      remainingRatio: snapshot.remainingRatio,
      usedAmountMinor: snapshot.usedAmountMinor,
      limitMinor: snapshot.limitMinor,
      currency: snapshot.currency,
      resetAt: snapshot.resetAt,
      observedAt: snapshot.observedAt,
      measurementQuality: snapshot.measurementQuality,
      collectionMethod: snapshot.collectionMethod,
      sourceRef: snapshot.sourceRef,
    };
  });

  const WINDOW_LABELS: Record<string, string> = {
    hourly: '小时窗',
    daily: '日窗',
    weekly: '周窗',
    monthly: '月窗',
    custom: '自定义窗口',
  };

  const groups = groupBuckets(views).map((g) => ({
    windowKind: g.windowKind,
    windowLabel: WINDOW_LABELS[g.windowKind] ?? g.windowKind,
    buckets: g.buckets as QuotaBucketViewWithFreshness[],
  }));

  return {
    groups,
    needsAttention: views.filter((v) => v.freshness !== 'fresh').length,
  };
}

export function quotaHistory(ctx: ServiceContext, accountId: string, bucketId: string, limit = 50): QuotaSnapshot[] {
  return listQuotaHistory(ctx.db, accountId, bucketId, limit);
}
