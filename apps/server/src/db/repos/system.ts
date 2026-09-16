/**
 * 系统类仓储：导入批次、能力登记、上下文导出、凭据、审计、设置，以及 demo 数据清理。
 */

import {
  newId,
  nowIso,
  type CapabilityStatus,
  type CredentialScope,
  type ImportKind,
  type ImportStatus,
} from '@aicc/core';
import type { DbConnection } from '../database.js';

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export function getSetting(db: DbConnection, key: string): string | undefined {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').get<{ value: string }>(key)?.value;
}

export function setSetting(db: DbConnection, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function allSettings(db: DbConnection): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM app_settings ORDER BY key').all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/* ------------------------------------------------------------------ */
/* 导入批次                                                            */
/* ------------------------------------------------------------------ */

export interface ImportJob {
  id: string;
  kind: ImportKind;
  adapterId: string;
  adapterVersion: string;
  fileName: string;
  fileFingerprint: string;
  byteSize: number;
  status: ImportStatus;
  totalRows: number;
  acceptedRows: number;
  replayedRows: number;
  evidenceRows: number;
  suspectRows: number;
  rejectedRows: number;
  warnings: string[];
  errorReport: Array<{ row: number; message: string }>;
  dryRun: boolean;
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  startedAt: string;
  finishedAt: string | null;
  isDemo: boolean;
}

interface ImportRow {
  id: string;
  kind: string;
  adapter_id: string;
  adapter_version: string;
  file_name: string;
  file_fingerprint: string;
  byte_size: number;
  status: string;
  total_rows: number;
  accepted_rows: number;
  replayed_rows: number;
  evidence_rows: number;
  suspect_rows: number;
  rejected_rows: number;
  warnings: string;
  error_report: string;
  dry_run: number;
  account_id: string | null;
  project_id: string | null;
  client_id: string | null;
  started_at: string;
  finished_at: string | null;
  is_demo: number;
}

function toImportJob(row: ImportRow): ImportJob {
  return {
    id: row.id,
    kind: row.kind as ImportKind,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    fileName: row.file_name,
    fileFingerprint: row.file_fingerprint,
    byteSize: row.byte_size,
    status: row.status as ImportStatus,
    totalRows: row.total_rows,
    acceptedRows: row.accepted_rows,
    replayedRows: row.replayed_rows,
    evidenceRows: row.evidence_rows,
    suspectRows: row.suspect_rows,
    rejectedRows: row.rejected_rows,
    warnings: JSON.parse(row.warnings) as string[],
    errorReport: JSON.parse(row.error_report) as Array<{ row: number; message: string }>,
    dryRun: row.dry_run === 1,
    accountId: row.account_id,
    projectId: row.project_id,
    clientId: row.client_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    isDemo: row.is_demo === 1,
  };
}

export function createImportJob(
  db: DbConnection,
  input: {
    kind: ImportKind;
    adapterId: string;
    adapterVersion: string;
    fileName: string;
    fileFingerprint: string;
    byteSize: number;
    status: ImportStatus;
    dryRun: boolean;
    accountId: string | null;
    projectId: string | null;
    clientId: string | null;
    isDemo?: boolean;
  },
): ImportJob {
  const id = newId('importJob');
  db.prepare(
    `INSERT INTO import_job (
       id, kind, adapter_id, adapter_version, file_name, file_fingerprint, byte_size,
       status, total_rows, accepted_rows, replayed_rows, evidence_rows, suspect_rows, rejected_rows,
       warnings, error_report, dry_run, account_id, project_id, client_id, started_at, finished_at, is_demo
     ) VALUES (?,?,?,?,?,?,?, ?, 0,0,0,0,0,0, '[]','[]', ?,?,?,?,?, NULL, ?)`,
  ).run(
    id,
    input.kind,
    input.adapterId,
    input.adapterVersion,
    input.fileName,
    input.fileFingerprint,
    input.byteSize,
    input.status,
    input.dryRun ? 1 : 0,
    input.accountId,
    input.projectId,
    input.clientId,
    nowIso(),
    input.isDemo ? 1 : 0,
  );
  return getImportJob(db, id) as ImportJob;
}

export function finishImportJob(
  db: DbConnection,
  id: string,
  patch: {
    status: ImportStatus;
    totalRows: number;
    acceptedRows: number;
    replayedRows: number;
    evidenceRows: number;
    suspectRows: number;
    rejectedRows: number;
    warnings: string[];
    errorReport: Array<{ row: number; message: string }>;
  },
): ImportJob {
  db.prepare(
    `UPDATE import_job SET
       status = ?, total_rows = ?, accepted_rows = ?, replayed_rows = ?, evidence_rows = ?,
       suspect_rows = ?, rejected_rows = ?, warnings = ?, error_report = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    patch.status,
    patch.totalRows,
    patch.acceptedRows,
    patch.replayedRows,
    patch.evidenceRows,
    patch.suspectRows,
    patch.rejectedRows,
    JSON.stringify(patch.warnings),
    JSON.stringify(patch.errorReport),
    nowIso(),
    id,
  );
  return getImportJob(db, id) as ImportJob;
}

export function getImportJob(db: DbConnection, id: string): ImportJob | undefined {
  const row = db.prepare('SELECT * FROM import_job WHERE id = ?').get<ImportRow>(id);
  return row ? toImportJob(row) : undefined;
}

export function listImportJobs(db: DbConnection, limit = 50): ImportJob[] {
  const rows = db
    .prepare('SELECT * FROM import_job WHERE is_demo = 0 ORDER BY started_at DESC LIMIT ?')
    .all<ImportRow>(Math.min(limit, 200));
  return rows.map(toImportJob);
}

/** 同文件是否已经完整导入过（用于界面提示「这个文件上次已导入」）。 */
export function findCompletedImportByFingerprint(
  db: DbConnection,
  kind: ImportKind,
  fileFingerprint: string,
): ImportJob | undefined {
  const row = db
    .prepare(
      `SELECT * FROM import_job
       WHERE kind = ? AND file_fingerprint = ? AND status = 'completed' AND dry_run = 0
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get<ImportRow>(kind, fileFingerprint);
  return row ? toImportJob(row) : undefined;
}

/* ------------------------------------------------------------------ */
/* 能力登记                                                            */
/* ------------------------------------------------------------------ */

export interface Integration {
  id: string;
  name: string;
  category: 'usage' | 'memory' | 'chatgpt_bridge' | 'quota';
  transport: string;
  authMode: string;
  clientVersion: string | null;
  capabilityStatus: CapabilityStatus;
  capabilityDetail: Record<string, unknown>;
  evidence: string | null;
  verifiedAt: string | null;
  lastSuccessAt: string | null;
  envRequirement: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface IntegrationRow {
  id: string;
  name: string;
  category: string;
  transport: string;
  auth_mode: string;
  client_version: string | null;
  capability_status: string;
  capability_detail: string;
  evidence: string | null;
  verified_at: string | null;
  last_success_at: string | null;
  env_requirement: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    name: row.name,
    category: row.category as Integration['category'],
    transport: row.transport,
    authMode: row.auth_mode,
    clientVersion: row.client_version,
    capabilityStatus: row.capability_status as CapabilityStatus,
    capabilityDetail: JSON.parse(row.capability_detail) as Record<string, unknown>,
    evidence: row.evidence,
    verifiedAt: row.verified_at,
    lastSuccessAt: row.last_success_at,
    envRequirement: row.env_requirement,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

export function insertIntegration(
  db: DbConnection,
  input: {
    name: string;
    category: Integration['category'];
    transport: string;
    authMode: string;
    clientVersion?: string | null;
    capabilityStatus: CapabilityStatus;
    capabilityDetail?: Record<string, unknown>;
    evidence?: string | null;
    verifiedAt?: string | null;
    envRequirement?: string | null;
    notes?: string | null;
    isDemo?: boolean;
    id?: string;
  },
): Integration {
  const id = input.id ?? newId('integration');
  const at = nowIso();
  db.prepare(
    `INSERT INTO integration (
       id, name, category, transport, auth_mode, client_version,
       capability_status, capability_detail, evidence, verified_at, last_success_at,
       env_requirement, notes, created_at, updated_at, is_demo
     ) VALUES (?,?,?,?,?,?, ?,?,?,?, NULL, ?,?,?,?,?)`,
  ).run(
    id,
    input.name,
    input.category,
    input.transport,
    input.authMode,
    input.clientVersion ?? null,
    input.capabilityStatus,
    JSON.stringify(input.capabilityDetail ?? {}),
    input.evidence ?? null,
    input.verifiedAt ?? null,
    input.envRequirement ?? null,
    input.notes ?? null,
    at,
    at,
    input.isDemo ? 1 : 0,
  );
  return getIntegration(db, id) as Integration;
}

export function getIntegration(db: DbConnection, id: string): Integration | undefined {
  const row = db.prepare('SELECT * FROM integration WHERE id = ?').get<IntegrationRow>(id);
  return row ? toIntegration(row) : undefined;
}

export function findIntegrationByName(db: DbConnection, name: string): Integration | undefined {
  const row = db.prepare('SELECT * FROM integration WHERE name = ? LIMIT 1').get<IntegrationRow>(name);
  return row ? toIntegration(row) : undefined;
}

export function listIntegrations(db: DbConnection, options: { includeDemo?: boolean } = {}): Integration[] {
  const rows = options.includeDemo
    ? db.prepare('SELECT * FROM integration ORDER BY category, name').all<IntegrationRow>()
    : db.prepare('SELECT * FROM integration WHERE is_demo = 0 ORDER BY category, name').all<IntegrationRow>();
  return rows.map(toIntegration);
}

/**
 * 记录一次只读探测结果。
 *
 * 刻意**不允许**把 `capability_status` 直接写成 `verified` 而不带证据：
 * §3.1 要求界面区分「官方文档描述支持」与「本机已验证」，所以写 verified
 * 必须同时给出 evidence。
 */
export function recordProbe(
  db: DbConnection,
  id: string,
  patch: {
    capabilityStatus: CapabilityStatus;
    capabilityDetail?: Record<string, unknown>;
    evidence?: string | null;
    clientVersion?: string | null;
    note?: string | null;
  },
): Integration {
  const existing = getIntegration(db, id);
  if (!existing) throw new Error(`集成不存在：${id}`);
  if (patch.capabilityStatus === 'verified' && !(patch.evidence ?? '').trim()) {
    throw new Error('把能力标记为「已验证」必须同时给出证据（命令、返回样例或截图说明）');
  }
  const at = nowIso();
  db.prepare(
    `UPDATE integration SET
       capability_status = ?, capability_detail = ?, evidence = ?,
       client_version = ?, notes = ?, verified_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.capabilityStatus,
    JSON.stringify(patch.capabilityDetail ?? existing.capabilityDetail),
    patch.evidence !== undefined ? patch.evidence : existing.evidence,
    patch.clientVersion !== undefined ? patch.clientVersion : existing.clientVersion,
    patch.note !== undefined ? patch.note : existing.notes,
    patch.capabilityStatus === 'verified' ? at : existing.verifiedAt,
    at,
    id,
  );
  return getIntegration(db, id) as Integration;
}

export function markIntegrationSuccess(db: DbConnection, id: string): void {
  db.prepare('UPDATE integration SET last_success_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
}

/* ------------------------------------------------------------------ */
/* 上下文导出                                                          */
/* ------------------------------------------------------------------ */

export interface ContextExportRecord {
  id: string;
  projectId: string;
  task: string | null;
  budgetKind: string;
  budgetTokens: number;
  estimatedTokens: number;
  tokenCountKind: string;
  manifest: Record<string, unknown>;
  droppedCount: number;
  excludedByPolicy: number;
  warnings: string[];
  contentMarkdown: string;
  contentJson: string;
  memoryRefs: Array<{ memoryId: string; version: number }>;
  createdBy: string;
  createdAt: string;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  isDemo: boolean;
}

interface ContextRow {
  id: string;
  project_id: string;
  task: string | null;
  budget_kind: string;
  budget_tokens: number;
  estimated_tokens: number;
  token_count_kind: string;
  manifest: string;
  dropped_count: number;
  excluded_by_policy: number;
  warnings: string;
  content_markdown: string;
  content_json: string;
  memory_refs: string;
  created_by: string;
  created_at: string;
  invalidated_at: string | null;
  invalidated_reason: string | null;
  is_demo: number;
}

function toContextExport(row: ContextRow): ContextExportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    task: row.task,
    budgetKind: row.budget_kind,
    budgetTokens: row.budget_tokens,
    estimatedTokens: row.estimated_tokens,
    tokenCountKind: row.token_count_kind,
    manifest: JSON.parse(row.manifest) as Record<string, unknown>,
    droppedCount: row.dropped_count,
    excludedByPolicy: row.excluded_by_policy,
    warnings: JSON.parse(row.warnings) as string[],
    contentMarkdown: row.content_markdown,
    contentJson: row.content_json,
    memoryRefs: JSON.parse(row.memory_refs) as Array<{ memoryId: string; version: number }>,
    createdBy: row.created_by,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
    invalidatedReason: row.invalidated_reason,
    isDemo: row.is_demo === 1,
  };
}

export function insertContextExport(
  db: DbConnection,
  input: Omit<ContextExportRecord, 'createdAt' | 'invalidatedAt' | 'invalidatedReason' | 'isDemo'> & {
    isDemo?: boolean;
  },
): ContextExportRecord {
  const at = nowIso();
  db.prepare(
    `INSERT INTO context_export (
       id, project_id, task, budget_kind, budget_tokens, estimated_tokens, token_count_kind,
       manifest, dropped_count, excluded_by_policy, warnings,
       content_markdown, content_json, file_path, memory_refs,
       created_by, created_at, invalidated_at, invalidated_reason, is_demo
     ) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?, NULL, ?, ?,?, NULL, NULL, ?)`,
  ).run(
    input.id,
    input.projectId,
    input.task,
    input.budgetKind,
    input.budgetTokens,
    input.estimatedTokens,
    input.tokenCountKind,
    JSON.stringify(input.manifest),
    input.droppedCount,
    input.excludedByPolicy,
    JSON.stringify(input.warnings),
    input.contentMarkdown,
    input.contentJson,
    JSON.stringify(input.memoryRefs),
    input.createdBy,
    at,
    input.isDemo ? 1 : 0,
  );
  return getContextExport(db, input.id) as ContextExportRecord;
}

export function getContextExport(db: DbConnection, id: string): ContextExportRecord | undefined {
  const row = db.prepare('SELECT * FROM context_export WHERE id = ?').get<ContextRow>(id);
  return row ? toContextExport(row) : undefined;
}

export function listContextExports(db: DbConnection, projectId?: string, limit = 50): ContextExportRecord[] {
  const rows = projectId
    ? db
        .prepare('SELECT * FROM context_export WHERE project_id = ? AND is_demo = 0 ORDER BY created_at DESC LIMIT ?')
        .all<ContextRow>(projectId, Math.min(limit, 200))
    : db
        .prepare('SELECT * FROM context_export WHERE is_demo = 0 ORDER BY created_at DESC LIMIT ?')
        .all<ContextRow>(Math.min(limit, 200));
  return rows.map(toContextExport);
}

/** 记忆变更后，把引用了旧版本的包标为失效（§4.4）。 */
export function invalidateContextExports(db: DbConnection, memoryId: string, newVersion: number): string[] {
  const candidates = db
    .prepare("SELECT * FROM context_export WHERE invalidated_at IS NULL AND memory_refs LIKE ?")
    .all<ContextRow>(`%${memoryId}%`);
  const affected: string[] = [];
  const at = nowIso();
  for (const row of candidates) {
    const refs = JSON.parse(row.memory_refs) as Array<{ memoryId: string; version: number }>;
    const stale = refs.some((r) => r.memoryId === memoryId && r.version < newVersion);
    if (!stale) continue;
    db.prepare('UPDATE context_export SET invalidated_at = ?, invalidated_reason = ? WHERE id = ?').run(
      at,
      `记忆 ${memoryId} 已更新到 v${newVersion}，本包引用的是旧版本`,
      row.id,
    );
    affected.push(row.id);
  }
  return affected;
}

/* ------------------------------------------------------------------ */
/* 凭据                                                                */
/* ------------------------------------------------------------------ */

export interface ApiCredential {
  id: string;
  clientId: string;
  label: string;
  tokenPrefix: string;
  /** null = 未限定项目范围（仅建议本机调试用）。 */
  projectIds: string[] | null;
  scopes: CredentialScope[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  isDemo: boolean;
}

interface CredentialRow {
  id: string;
  client_id: string;
  label: string;
  token_hash: string;
  token_prefix: string;
  project_ids: string | null;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  is_demo: number;
}

function toCredential(row: CredentialRow): ApiCredential {
  return {
    id: row.id,
    clientId: row.client_id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    projectIds: row.project_ids ? (JSON.parse(row.project_ids) as string[]) : null,
    scopes: JSON.parse(row.scopes) as CredentialScope[],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    isDemo: row.is_demo === 1,
  };
}

export function insertCredential(
  db: DbConnection,
  input: {
    id: string;
    clientId: string;
    label: string;
    tokenHash: string;
    tokenPrefix: string;
    projectIds: string[] | null;
    scopes: CredentialScope[];
    isDemo?: boolean;
  },
): ApiCredential {
  db.prepare(
    `INSERT INTO api_credential (id, client_id, label, token_hash, token_prefix, project_ids, scopes, created_at, revoked_at, last_used_at, is_demo)
     VALUES (?,?,?,?,?,?,?,?, NULL, NULL, ?)`,
  ).run(
    input.id,
    input.clientId,
    input.label,
    input.tokenHash,
    input.tokenPrefix,
    input.projectIds ? JSON.stringify(input.projectIds) : null,
    JSON.stringify(input.scopes),
    nowIso(),
    input.isDemo ? 1 : 0,
  );
  return getCredential(db, input.id) as ApiCredential;
}

export function getCredential(db: DbConnection, id: string): ApiCredential | undefined {
  const row = db.prepare('SELECT * FROM api_credential WHERE id = ?').get<CredentialRow>(id);
  return row ? toCredential(row) : undefined;
}

export function findCredentialByTokenHash(
  db: DbConnection,
  tokenHash: string,
): { credential: ApiCredential; clientId: string } | undefined {
  const row = db.prepare('SELECT * FROM api_credential WHERE token_hash = ?').get<CredentialRow>(tokenHash);
  if (!row) return undefined;
  return { credential: toCredential(row), clientId: row.client_id };
}

export function listCredentials(db: DbConnection, clientId?: string): ApiCredential[] {
  const rows = clientId
    ? db.prepare('SELECT * FROM api_credential WHERE client_id = ? ORDER BY created_at DESC').all<CredentialRow>(clientId)
    : db.prepare('SELECT * FROM api_credential ORDER BY created_at DESC').all<CredentialRow>();
  return rows.map(toCredential);
}

export function revokeCredential(db: DbConnection, id: string): ApiCredential | undefined {
  db.prepare('UPDATE api_credential SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
  return getCredential(db, id);
}

export function touchCredential(db: DbConnection, id: string): void {
  db.prepare('UPDATE api_credential SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
}

/* ------------------------------------------------------------------ */
/* 审计                                                                */
/* ------------------------------------------------------------------ */

export interface AuditEvent {
  seq: number;
  id: string;
  at: string;
  actor: string;
  actorKind: string;
  action: string;
  entityType: string;
  entityId: string | null;
  version: number | null;
  result: string;
  detail: Record<string, unknown>;
  requestId: string | null;
}

interface AuditRow {
  seq: number;
  id: string;
  at: string;
  actor: string;
  actor_kind: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  version: number | null;
  result: string;
  detail: string;
  request_id: string | null;
}

export function appendAudit(
  db: DbConnection,
  input: {
    actor: string;
    actorKind: string;
    action: string;
    entityType: string;
    entityId?: string | null;
    version?: number | null;
    result: string;
    /** 只放 ID、计数、结论。**不要**把敏感全文塞进来（§14.1）。 */
    detail?: Record<string, unknown>;
    requestId?: string | null;
    isDemo?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO audit_event (id, at, actor, actor_kind, action, entity_type, entity_id, version, result, detail, request_id, is_demo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    newId('audit'),
    nowIso(),
    input.actor,
    input.actorKind,
    input.action,
    input.entityType,
    input.entityId ?? null,
    input.version ?? null,
    input.result,
    JSON.stringify(input.detail ?? {}),
    input.requestId ?? null,
    input.isDemo ? 1 : 0,
  );
}

export function listAudit(db: DbConnection, options: { limit?: number; action?: string } = {}): AuditEvent[] {
  const rows = options.action
    ? db
        .prepare('SELECT * FROM audit_event WHERE action = ? AND is_demo = 0 ORDER BY seq DESC LIMIT ?')
        .all<AuditRow>(options.action, Math.min(options.limit ?? 100, 500))
    : db
        .prepare('SELECT * FROM audit_event WHERE is_demo = 0 ORDER BY seq DESC LIMIT ?')
        .all<AuditRow>(Math.min(options.limit ?? 100, 500));
  return rows.map((row) => ({
    seq: row.seq,
    id: row.id,
    at: row.at,
    actor: row.actor,
    actorKind: row.actor_kind,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    version: row.version,
    result: row.result,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    requestId: row.request_id,
  }));
}

/* ------------------------------------------------------------------ */
/* Demo 数据隔离（INV-16）                                              */
/* ------------------------------------------------------------------ */

const DEMO_TABLES = [
  'audit_event',
  'context_export',
  'api_credential',
  'integration',
  'import_job',
  'memory_proposal',
  'memory_revision',
  'memory',
  'source',
  'quota_snapshot',
  'charge',
  'usage_observation',
  'session',
  'subscription_client',
  'subscription',
  'project',
  'billing_account',
  'client',
] as const;

export interface DemoCounts {
  [table: string]: number;
}

/**
 * 库里是否存在示例数据。
 *
 * 只看 `is_demo = 1` 的行，**不是**看「表里有没有数据」。
 * 这个区别很重要：早期实现用「有没有客户端」来判定，结果只要你先建了一个真实客户端，
 * 就再也无法生成示例数据了 —— 报错还说「已存在 demo 数据」，让人完全摸不着头脑。
 */
export function countDemoRows(db: DbConnection): DemoCounts {
  const counts: DemoCounts = {};
  for (const table of DEMO_TABLES) {
    if (table === 'memory_revision') {
      counts[table] =
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM memory_revision r JOIN memory m ON m.id = r.memory_id WHERE m.is_demo = 1',
          )
          .get<{ n: number }>()?.n ?? 0;
      continue;
    }
    if (table === 'subscription_client') {
      counts[table] =
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM subscription_client sc JOIN subscription s ON s.id = sc.subscription_id WHERE s.is_demo = 1',
          )
          .get<{ n: number }>()?.n ?? 0;
      continue;
    }
    counts[table] =
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_demo = 1`).get<{ n: number }>()?.n ?? 0;
  }
  counts.memory_tombstone =
    db.prepare('SELECT COUNT(*) AS n FROM memory_tombstone').get<{ n: number }>()?.n ?? 0;
  return counts;
}

export function hasDemoData(db: DbConnection): boolean {
  return Object.values(countDemoRows(db)).some((n) => n > 0);
}

/** 清空所有 demo 数据。真实数据（is_demo = 0）一行都不会动。 */
export function purgeDemoData(db: DbConnection): DemoCounts {
  const counts: DemoCounts = {};
  // memory_revision 没有自己的 is_demo，按父记忆判定
  db.exec(
    'DELETE FROM memory_revision WHERE memory_id IN (SELECT id FROM memory WHERE is_demo = 1)',
  );
  db.exec('DELETE FROM subscription_client WHERE subscription_id IN (SELECT id FROM subscription WHERE is_demo = 1)');
  counts.memory_revision = 0;
  counts.subscription_client = 0;
  db.exec('DELETE FROM memory_tombstone WHERE memory_id IN (SELECT id FROM memory WHERE is_demo = 1)');

  for (const table of DEMO_TABLES) {
    if (table === 'memory_revision' || table === 'subscription_client') continue;
    const before = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_demo = 1`).get<{ n: number }>()?.n ?? 0;
    if (before > 0) db.prepare(`DELETE FROM ${table} WHERE is_demo = 1`).run();
    counts[table] = before;
  }
  return counts;
}

/** 全库计数，用于「备份/恢复后一致性」检查。 */
export function databaseCounts(db: DbConnection, includeDemo = false): DemoCounts {
  const filter = includeDemo ? '' : ' WHERE is_demo = 0';
  const out: DemoCounts = {};
  for (const table of DEMO_TABLES) {
    if (table === 'memory_revision') {
      out[table] =
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM memory_revision r
             JOIN memory m ON m.id = r.memory_id ${includeDemo ? '' : 'WHERE m.is_demo = 0'}`,
          )
          .get<{ n: number }>()?.n ?? 0;
      continue;
    }
    if (table === 'subscription_client') {
      out[table] =
        db.prepare('SELECT COUNT(*) AS n FROM subscription_client').get<{ n: number }>()?.n ?? 0;
      continue;
    }
    out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${filter}`).get<{ n: number }>()?.n ?? 0;
  }
  out.memory_tombstone =
    db.prepare('SELECT COUNT(*) AS n FROM memory_tombstone').get<{ n: number }>()?.n ?? 0;
  return out;
}
