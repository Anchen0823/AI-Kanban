/**
 * 额度仓储。
 *
 * 每次观测**追加**一行快照，不覆盖。原因：额度是状态不是流水（INV-03），
 * 但它同时需要「这个数字是什么时候看的」来判断新鲜度（U07）。
 * 只保留最新一行会让「上次观测时间」无法自证。
 * 读取时按 bucket 取最新一行，历史仍然可查。
 */

import {
  newId,
  nowIso,
  type CollectionMethod,
  type MeasurementQuality,
  type QuotaWindowKind,
} from '@aicc/core';
import type { DbConnection } from '../database.js';

export interface QuotaSnapshot {
  id: string;
  accountId: string;
  bucketId: string;
  bucketLabel: string;
  scope: string | null;
  windowKind: QuotaWindowKind;
  windowSeconds: number | null;
  usedRatio: number | null;
  remainingRatio: number | null;
  usedAmountMinor: string | null;
  limitMinor: string | null;
  currency: string | null;
  resetAt: string | null;
  observedAt: string;
  measurementQuality: MeasurementQuality;
  collectionMethod: CollectionMethod;
  sourceRef: string | null;
  adapterVersion: string | null;
  staleAfterSeconds: number;
  isDemo: boolean;
}

interface QuotaRow {
  id: string;
  account_id: string;
  bucket_id: string;
  bucket_label: string;
  scope: string | null;
  window_kind: string;
  window_seconds: number | null;
  used_ratio: number | null;
  remaining_ratio: number | null;
  used_amount_minor: string | null;
  limit_minor: string | null;
  currency: string | null;
  reset_at: string | null;
  observed_at: string;
  measurement_quality: string;
  collection_method: string;
  source_ref: string | null;
  adapter_version: string | null;
  stale_after_seconds: number;
  is_demo: number;
}

function toQuota(row: QuotaRow): QuotaSnapshot {
  return {
    id: row.id,
    accountId: row.account_id,
    bucketId: row.bucket_id,
    bucketLabel: row.bucket_label,
    scope: row.scope,
    windowKind: row.window_kind as QuotaWindowKind,
    windowSeconds: row.window_seconds,
    usedRatio: row.used_ratio,
    remainingRatio: row.remaining_ratio,
    usedAmountMinor: row.used_amount_minor,
    limitMinor: row.limit_minor,
    currency: row.currency,
    resetAt: row.reset_at,
    observedAt: row.observed_at,
    measurementQuality: row.measurement_quality as MeasurementQuality,
    collectionMethod: row.collection_method as CollectionMethod,
    sourceRef: row.source_ref,
    adapterVersion: row.adapter_version,
    staleAfterSeconds: row.stale_after_seconds,
    isDemo: row.is_demo === 1,
  };
}

export function insertQuotaSnapshot(
  db: DbConnection,
  input: {
    accountId: string;
    bucketId: string;
    bucketLabel: string;
    scope?: string | null;
    windowKind: QuotaWindowKind;
    windowSeconds?: number | null;
    usedRatio?: number | null;
    remainingRatio?: number | null;
    usedAmountMinor?: string | null;
    limitMinor?: string | null;
    currency?: string | null;
    resetAt?: string | null;
    observedAt: string;
    measurementQuality: MeasurementQuality;
    collectionMethod: CollectionMethod;
    sourceRef?: string | null;
    adapterVersion?: string | null;
    staleAfterSeconds: number;
    isDemo?: boolean;
  },
): QuotaSnapshot {
  const id = newId('quota');
  const at = nowIso();
  db.prepare(
    `INSERT INTO quota_snapshot (
       id, account_id, bucket_id, bucket_label, scope,
       window_kind, window_seconds,
       used_ratio, remaining_ratio, used_amount_minor, limit_minor, currency,
       reset_at, observed_at,
       measurement_quality, collection_method, source_ref, adapter_version, stale_after_seconds,
       created_at, is_demo
     ) VALUES (?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?)`,
  ).run(
    id,
    input.accountId,
    input.bucketId,
    input.bucketLabel,
    input.scope ?? null,
    input.windowKind,
    input.windowSeconds ?? null,
    input.usedRatio ?? null,
    input.remainingRatio ?? null,
    input.usedAmountMinor ?? null,
    input.limitMinor ?? null,
    input.currency ?? null,
    input.resetAt ?? null,
    input.observedAt,
    input.measurementQuality,
    input.collectionMethod,
    input.sourceRef ?? null,
    input.adapterVersion ?? null,
    input.staleAfterSeconds,
    at,
    input.isDemo ? 1 : 0,
  );
  return getQuotaSnapshot(db, id) as QuotaSnapshot;
}

export function getQuotaSnapshot(db: DbConnection, id: string): QuotaSnapshot | undefined {
  const row = db.prepare('SELECT * FROM quota_snapshot WHERE id = ?').get<QuotaRow>(id);
  return row ? toQuota(row) : undefined;
}

/**
 * 每个「账户 + 额度桶」的最新快照。
 *
 * 用窗口函数而不是 `GROUP BY` + `MAX(observed_at)`：后者在观测时间相同时
 * 会随机挑一行，导致界面上的数值在两次刷新之间跳变。
 */
export function latestQuotaSnapshots(db: DbConnection, options: { includeDemo?: boolean } = {}): QuotaSnapshot[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT q.*,
                ROW_NUMBER() OVER (PARTITION BY account_id, bucket_id ORDER BY observed_at DESC, created_at DESC) AS rn
         FROM quota_snapshot q
         WHERE is_demo = ${options.includeDemo ? 1 : 0}
       ) WHERE rn = 1
       ORDER BY account_id, window_kind, bucket_id`,
    )
    .all<QuotaRow>();
  return rows.map(toQuota);
}

export function listQuotaHistory(
  db: DbConnection,
  accountId: string,
  bucketId: string,
  limit = 50,
): QuotaSnapshot[] {
  const rows = db
    .prepare(
      `SELECT * FROM quota_snapshot
       WHERE account_id = ? AND bucket_id = ?
       ORDER BY observed_at DESC LIMIT ?`,
    )
    .all<QuotaRow>(accountId, bucketId, Math.min(limit, 200));
  return rows.map(toQuota);
}
