/**
 * 用量仓储：`usage_observation`（token 事实）与 `charge`（钱）。
 *
 * 两者刻意分开：token 与钱是两种量纲，混在一起就会出现「用 token 数反推花了多少钱」
 * 这种看起来合理、实际上必然错的结论（§5.1）。
 */

import {
  newId,
  nowIso,
  type ChargeKind,
  type ChargeStatus,
  type CollectionMethod,
  type MeasurementQuality,
  type MeterKind,
  type NormalizedTokens,
  type ObservationKind,
  type TokenBasis,
} from '@aicc/core';
import type { DbConnection } from '../database.js';
import { workspaceClause, type WorkspaceScope } from './workspace.js';

/* ------------------------------------------------------------------ */
/* 用量观测                                                            */
/* ------------------------------------------------------------------ */

export type DuplicateStatus = 'none' | 'merged_evidence' | 'suspect' | 'resolved_unique' | 'resolved_duplicate';

export interface UsageObservation {
  id: string;
  kind: ObservationKind;
  collectionMethod: CollectionMethod;
  measurementQuality: MeasurementQuality;
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  model: string | null;
  occurredAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rawUsage: Record<string, unknown>;
  inputTotal: number | null;
  outputTotal: number | null;
  totalReported: number | null;
  cachedInput: number | null;
  reasoningOutput: number | null;
  cacheWriteInput: number | null;
  normalizationBasis: TokenBasis;
  normalizationNotes: string[];
  sourceRef: string | null;
  adapterVersion: string | null;
  coverageScope: string | null;
  providerRequestId: string | null;
  meterKind: MeterKind;
  dedupeKey: string;
  identityKey: string;
  identityConfidence: string;
  isPrimary: boolean;
  duplicateStatus: DuplicateStatus;
  duplicateOf: string | null;
  importJobId: string | null;
  rowIndex: number | null;
  fileFingerprint: string | null;
  contentFingerprint: string | null;
  observedAt: string;
  isDemo: boolean;
}

interface ObservationRow {
  id: string;
  kind: string;
  collection_method: string;
  measurement_quality: string;
  account_id: string | null;
  project_id: string | null;
  client_id: string | null;
  model: string | null;
  occurred_at: string | null;
  period_start: string | null;
  period_end: string | null;
  raw_usage: string;
  input_total: number | null;
  output_total: number | null;
  total_reported: number | null;
  cached_input: number | null;
  reasoning_output: number | null;
  cache_write_input: number | null;
  normalization_basis: string;
  normalization_notes: string;
  source_ref: string | null;
  adapter_version: string | null;
  coverage_scope: string | null;
  provider_request_id: string | null;
  meter_kind: string;
  dedupe_key: string;
  identity_key: string;
  identity_confidence: string;
  is_primary: number;
  duplicate_status: string;
  duplicate_of: string | null;
  import_job_id: string | null;
  row_index: number | null;
  file_fingerprint: string | null;
  content_fingerprint: string | null;
  observed_at: string;
  is_demo: number;
}

function toObservation(row: ObservationRow): UsageObservation {
  return {
    id: row.id,
    kind: row.kind as ObservationKind,
    collectionMethod: row.collection_method as CollectionMethod,
    measurementQuality: row.measurement_quality as MeasurementQuality,
    accountId: row.account_id,
    projectId: row.project_id,
    clientId: row.client_id,
    model: row.model,
    occurredAt: row.occurred_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rawUsage: JSON.parse(row.raw_usage) as Record<string, unknown>,
    inputTotal: row.input_total,
    outputTotal: row.output_total,
    totalReported: row.total_reported,
    cachedInput: row.cached_input,
    reasoningOutput: row.reasoning_output,
    cacheWriteInput: row.cache_write_input,
    normalizationBasis: row.normalization_basis as TokenBasis,
    normalizationNotes: JSON.parse(row.normalization_notes) as string[],
    sourceRef: row.source_ref,
    adapterVersion: row.adapter_version,
    coverageScope: row.coverage_scope,
    providerRequestId: row.provider_request_id,
    meterKind: row.meter_kind as MeterKind,
    dedupeKey: row.dedupe_key,
    identityKey: row.identity_key,
    identityConfidence: row.identity_confidence,
    isPrimary: row.is_primary === 1,
    duplicateStatus: row.duplicate_status as DuplicateStatus,
    duplicateOf: row.duplicate_of,
    importJobId: row.import_job_id,
    rowIndex: row.row_index,
    fileFingerprint: row.file_fingerprint,
    contentFingerprint: row.content_fingerprint,
    observedAt: row.observed_at,
    isDemo: row.is_demo === 1,
  };
}

export interface InsertObservationInput {
  kind: ObservationKind;
  collectionMethod: CollectionMethod;
  measurementQuality: MeasurementQuality;
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  model: string | null;
  occurredAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rawUsage: Record<string, unknown>;
  tokens: NormalizedTokens;
  sourceRef: string | null;
  adapterVersion: string | null;
  coverageScope: string | null;
  providerRequestId: string | null;
  meterKind: MeterKind;
  dedupeKey: string;
  identityKey: string;
  identityConfidence: string;
  isPrimary: boolean;
  duplicateStatus: DuplicateStatus;
  duplicateOf: string | null;
  importJobId: string | null;
  rowIndex: number | null;
  fileFingerprint: string | null;
  contentFingerprint: string | null;
  observedAt?: string;
  isDemo?: boolean;
}

export function insertObservation(db: DbConnection, input: InsertObservationInput): UsageObservation {
  const id = newId('usage');
  const at = input.observedAt ?? nowIso();
  db.prepare(
    `INSERT INTO usage_observation (
       id, kind, collection_method, measurement_quality,
       account_id, project_id, client_id, model,
       occurred_at, period_start, period_end,
       raw_usage,
       input_total, output_total, total_reported, cached_input, reasoning_output, cache_write_input,
       normalization_basis, normalization_notes,
       source_ref, adapter_version, coverage_scope,
       provider_request_id, meter_kind,
       dedupe_key, identity_key, identity_confidence,
       is_primary, duplicate_status, duplicate_of,
       import_job_id, row_index, file_fingerprint, content_fingerprint,
       observed_at, created_at, updated_at, is_demo
     ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?, ?, ?,?,?,?,?,?, ?,?, ?,?,?, ?,?, ?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?)`,
  ).run(
    id,
    input.kind,
    input.collectionMethod,
    input.measurementQuality,
    input.accountId,
    input.projectId,
    input.clientId,
    input.model,
    input.occurredAt,
    input.periodStart,
    input.periodEnd,
    JSON.stringify(input.rawUsage ?? {}),
    input.tokens.inputTotal,
    input.tokens.outputTotal,
    input.tokens.totalReported,
    input.tokens.cachedInput,
    input.tokens.reasoningOutput,
    input.tokens.cacheWriteInput,
    input.tokens.basis,
    JSON.stringify(input.tokens.warnings),
    input.sourceRef,
    input.adapterVersion,
    input.coverageScope,
    input.providerRequestId,
    input.meterKind,
    input.dedupeKey,
    input.identityKey,
    input.identityConfidence,
    input.isPrimary ? 1 : 0,
    input.duplicateStatus,
    input.duplicateOf,
    input.importJobId,
    input.rowIndex,
    input.fileFingerprint,
    input.contentFingerprint,
    at,
    at,
    at,
    input.isDemo ? 1 : 0,
  );
  return getObservation(db, id) as UsageObservation;
}

export function getObservation(db: DbConnection, id: string): UsageObservation | undefined {
  const row = db.prepare('SELECT * FROM usage_observation WHERE id = ?').get<ObservationRow>(id);
  return row ? toObservation(row) : undefined;
}

export function findByDedupeKey(db: DbConnection, dedupeKey: string): UsageObservation | undefined {
  const row = db.prepare('SELECT * FROM usage_observation WHERE dedupe_key = ?').get<ObservationRow>(dedupeKey);
  return row ? toObservation(row) : undefined;
}

/** 找该身份键下的主统计源（证据行一律挂在它下面）。 */
export function findPrimaryByIdentityKey(db: DbConnection, identityKey: string): UsageObservation | undefined {
  const row = db
    .prepare(
      `SELECT * FROM usage_observation
       WHERE identity_key = ? AND is_primary = 1
       ORDER BY observed_at ASC LIMIT 1`,
    )
    .get<ObservationRow>(identityKey);
  return row ? toObservation(row) : undefined;
}

export function findFirstByIdentityKey(db: DbConnection, identityKey: string): UsageObservation | undefined {
  const row = db
    .prepare('SELECT * FROM usage_observation WHERE identity_key = ? ORDER BY observed_at ASC LIMIT 1')
    .get<ObservationRow>(identityKey);
  return row ? toObservation(row) : undefined;
}

export function resolveDuplicate(
  db: DbConnection,
  id: string,
  decision: 'confirmed_unique' | 'confirmed_duplicate',
  by: string,
): UsageObservation | undefined {
  const at = nowIso();
  if (decision === 'confirmed_unique') {
    // 用户确认这是两次真实发生的相同请求：把它提升为独立统计源。
    db.prepare(
      `UPDATE usage_observation
       SET is_primary = 1, duplicate_status = 'resolved_unique', duplicate_of = NULL,
           duplicate_resolved_at = ?, duplicate_resolved_by = ?, updated_at = ?
       WHERE id = ?`,
    ).run(at, by, at, id);
  } else {
    db.prepare(
      `UPDATE usage_observation
       SET is_primary = 0, duplicate_status = 'resolved_duplicate',
           duplicate_resolved_at = ?, duplicate_resolved_by = ?, updated_at = ?
       WHERE id = ?`,
    ).run(at, by, at, id);
  }
  return getObservation(db, id);
}

export interface UsageQuery {
  accountId?: string;
  projectId?: string;
  clientId?: string;
  kind?: ObservationKind;
  collectionMethod?: CollectionMethod;
  measurementQuality?: MeasurementQuality;
  from?: string;
  to?: string;
  includeNonPrimary?: boolean;
  /** 工作区：真实 / 示例 / 全部。默认只读真实数据。 */
  workspace?: WorkspaceScope;
  limit?: number;
  offset?: number;
}

export function listObservations(db: DbConnection, query: UsageQuery = {}): { items: UsageObservation[]; total: number } {
  const where: string[] = [workspaceClause(query.workspace ?? 'real')];
  const params: Array<string | number> = [];

  if (!query.includeNonPrimary) {
    where.push("is_primary = 1 AND duplicate_status IN ('none','resolved_unique')");
  }
  if (query.accountId) {
    where.push('account_id = ?');
    params.push(query.accountId);
  }
  if (query.projectId) {
    where.push('project_id = ?');
    params.push(query.projectId);
  }
  if (query.clientId) {
    where.push('client_id = ?');
    params.push(query.clientId);
  }
  if (query.kind) {
    where.push('kind = ?');
    params.push(query.kind);
  }
  if (query.collectionMethod) {
    where.push('collection_method = ?');
    params.push(query.collectionMethod);
  }
  if (query.measurementQuality) {
    where.push('measurement_quality = ?');
    params.push(query.measurementQuality);
  }
  if (query.from) {
    where.push('COALESCE(occurred_at, observed_at) >= ?');
    params.push(query.from);
  }
  if (query.to) {
    where.push('COALESCE(occurred_at, observed_at) <= ?');
    params.push(query.to);
  }

  const clause = where.join(' AND ');
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM usage_observation WHERE ${clause}`)
    .get<{ n: number }>(...params)?.n ?? 0;

  const limit = Math.min(query.limit ?? 100, 500);
  const offset = query.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM usage_observation WHERE ${clause}
       ORDER BY COALESCE(occurred_at, observed_at) DESC, created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all<ObservationRow>(...params, limit, offset);

  return { items: rows.map(toObservation), total };
}

/** 统计口径：只取主统计源（INV-04），并且只取当前工作区的数据。 */
export function countedObservations(db: DbConnection, scope: WorkspaceScope = 'real'): UsageObservation[] {
  const rows = db
    .prepare(
      `SELECT * FROM usage_observation
       WHERE is_primary = 1 AND duplicate_status IN ('none','resolved_unique')
         AND ${workspaceClause(scope)}
       ORDER BY COALESCE(occurred_at, observed_at) ASC`,
    )
    .all<ObservationRow>();
  return rows.map(toObservation);
}

export function countSuspectDuplicates(db: DbConnection, scope: WorkspaceScope = 'real'): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM usage_observation
         WHERE duplicate_status = 'suspect' AND ${workspaceClause(scope)}`,
      )
      .get<{ n: number }>()?.n ?? 0
  );
}

/* ------------------------------------------------------------------ */
/* 收费                                                                */
/* ------------------------------------------------------------------ */

export interface Charge {
  id: string;
  accountId: string | null;
  subscriptionId: string | null;
  kind: ChargeKind;
  amountMinor: string;
  currency: string;
  status: ChargeStatus;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  billingRef: string | null;
  collectionMethod: CollectionMethod;
  measurementQuality: MeasurementQuality;
  sourceRef: string | null;
  dedupeKey: string;
  note: string | null;
  observedAt: string;
  isDemo: boolean;
}

interface ChargeRow {
  id: string;
  account_id: string | null;
  subscription_id: string | null;
  kind: string;
  amount_minor: string;
  currency: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  paid_at: string | null;
  billing_ref: string | null;
  collection_method: string;
  measurement_quality: string;
  source_ref: string | null;
  dedupe_key: string;
  note: string | null;
  observed_at: string;
  is_demo: number;
}

function toCharge(row: ChargeRow): Charge {
  return {
    id: row.id,
    accountId: row.account_id,
    subscriptionId: row.subscription_id,
    kind: row.kind as ChargeKind,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status as ChargeStatus,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    paidAt: row.paid_at,
    billingRef: row.billing_ref,
    collectionMethod: row.collection_method as CollectionMethod,
    measurementQuality: row.measurement_quality as MeasurementQuality,
    sourceRef: row.source_ref,
    dedupeKey: row.dedupe_key,
    note: row.note,
    observedAt: row.observed_at,
    isDemo: row.is_demo === 1,
  };
}

export type ChargeInsertResult =
  | { kind: 'inserted'; charge: Charge }
  | { kind: 'duplicate'; existing: Charge; reason: string };

/**
 * 登记一笔收费，并防止重复记账。
 *
 * 检查顺序是有讲究的：先按账单号，再按「订阅 + 周期」，最后才按通用去重键。
 * 如果反过来，一笔「同一订阅同一周期」的重复登记会命中通用去重键，
 * 用户看到的理由是「同一来源的相同记录已存在」—— 这句话没有告诉他真正的原因，
 * 而真正的原因是「订阅月费只应该记一次」。
 */
export function insertCharge(
  db: DbConnection,
  input: {
    accountId: string | null;
    subscriptionId: string | null;
    kind: ChargeKind;
    amountMinor: string;
    currency: string;
    status: ChargeStatus;
    periodStart: string | null;
    periodEnd: string | null;
    paidAt: string | null;
    billingRef: string | null;
    collectionMethod: CollectionMethod;
    measurementQuality: MeasurementQuality;
    sourceRef: string | null;
    dedupeKey: string;
    note: string | null;
    observedAt?: string;
    isDemo?: boolean;
  },
): ChargeInsertResult {
  // 1) 账单对账：同一个账单号不会记两次（§5.4）
  if (input.billingRef) {
    const byRef = db.prepare('SELECT * FROM charge WHERE billing_ref = ? LIMIT 1').get<ChargeRow>(input.billingRef);
    if (byRef) {
      return {
        kind: 'duplicate',
        existing: toCharge(byRef),
        reason: `账单号 ${input.billingRef} 已记账，不重复登记（账单与请求明细通过 billing_ref 对账，不双算）`,
      };
    }
  }

  // 2) INV-09 / U06：同一订阅、同一周期的固定费用只记一次。
  //    订阅覆盖多个客户端时，不会因为「多了一个入口」就多记一笔。
  if (input.kind === 'subscription' && input.subscriptionId && input.periodStart) {
    const existingPeriod = db
      .prepare(
        `SELECT * FROM charge
         WHERE subscription_id = ? AND period_start = ? AND kind = 'subscription' AND status <> 'void'
         LIMIT 1`,
      )
      .get<ChargeRow>(input.subscriptionId, input.periodStart);
    if (existingPeriod) {
      return {
        kind: 'duplicate',
        existing: toCharge(existingPeriod),
        reason: '该订阅在本周期的固定费用已登记，月费只记一次（U06：订阅覆盖多个客户端时不重复计费）',
      };
    }
  }

  // 3) 通用去重键：同一来源的完全相同记录
  const byKey = db.prepare('SELECT * FROM charge WHERE dedupe_key = ? LIMIT 1').get<ChargeRow>(input.dedupeKey);
  if (byKey) {
    return { kind: 'duplicate', existing: toCharge(byKey), reason: '同一来源的相同收费记录已存在' };
  }

  const id = newId('charge');
  const at = input.observedAt ?? nowIso();
  db.prepare(
    `INSERT INTO charge (
       id, account_id, subscription_id, kind, amount_minor, currency, status,
       period_start, period_end, paid_at, billing_ref,
       collection_method, measurement_quality, source_ref,
       dedupe_key, import_job_id, note, observed_at, created_at, updated_at, is_demo
     ) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.accountId,
    input.subscriptionId,
    input.kind,
    input.amountMinor,
    input.currency,
    input.status,
    input.periodStart,
    input.periodEnd,
    input.paidAt,
    input.billingRef,
    input.collectionMethod,
    input.measurementQuality,
    input.sourceRef,
    input.dedupeKey,
    null,
    input.note,
    at,
    at,
    at,
    input.isDemo ? 1 : 0,
  );

  return { kind: 'inserted', charge: toCharge(db.prepare('SELECT * FROM charge WHERE id = ?').get<ChargeRow>(id) as ChargeRow) };
}

export function listCharges(
  db: DbConnection,
  options: { accountId?: string; workspace?: WorkspaceScope; limit?: number } = {},
): Charge[] {
  const where: string[] = [workspaceClause(options.workspace ?? 'real')];
  const params: Array<string | number> = [];
  if (options.accountId) {
    where.push('account_id = ?');
    params.push(options.accountId);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT * FROM charge ${clause} ORDER BY COALESCE(paid_at, observed_at) DESC LIMIT ?`)
    .all<ChargeRow>(...params, Math.min(options.limit ?? 200, 500));
  return rows.map(toCharge);
}
