/**
 * 记忆仓储：正式记忆、历史版本、候选、墓碑、来源。
 *
 * 两条不可绕过的约束在这里落地：
 * - 正式记忆只能由 `approveProposal` 写入（INV-10）。仓储不提供「直接插入一条 active 记忆」的接口。
 * - 每次版本变更都追加一条 `memory_revision`，包括当前版本，历史不可改写。
 */

import {
  newId,
  nowIso,
  type EvidenceStatus,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type ProposalOperation,
  type ProposalStatus,
  type SensitivityLevel,
  type SourceKind,
  type VerificationState,
} from '@aicc/core';
import type { DbConnection } from '../database.js';
import { workspaceClause, type WorkspaceScope } from './workspace.js';

/* ------------------------------------------------------------------ */
/* 来源                                                                */
/* ------------------------------------------------------------------ */

export function insertSource(
  db: DbConnection,
  input: {
    kind: SourceKind;
    externalId?: string | null;
    locator?: string | null;
    localMaterialPath?: string | null;
    contentFingerprint?: string | null;
    retention?: 'keep' | 'ephemeral' | 'delete_after_review';
    isDemo?: boolean;
  },
): string {
  const id = newId('source');
  db.prepare(
    `INSERT INTO source (id, kind, external_id, locator, local_material_path, content_fingerprint, retention, created_at, is_demo)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.kind,
    input.externalId ?? null,
    input.locator ?? null,
    input.localMaterialPath ?? null,
    input.contentFingerprint ?? null,
    input.retention ?? 'keep',
    nowIso(),
    input.isDemo ? 1 : 0,
  );
  return id;
}

/* ------------------------------------------------------------------ */
/* 正式记忆                                                            */
/* ------------------------------------------------------------------ */

export interface Memory {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  status: MemoryStatus;
  version: number;
  sensitivity: SensitivityLevel;
  verification: VerificationState;
  reviewAfter: string | null;
  pinned: boolean;
  approvedBy: string;
  approvedAt: string;
  sourceId: string | null;
  supersedesId: string | null;
  originProposalId: string | null;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface MemoryRow {
  id: string;
  scope: string;
  project_id: string | null;
  kind: string;
  title: string;
  content: string;
  status: string;
  version: number;
  sensitivity: string;
  verification: string;
  review_after: string | null;
  pinned: number;
  approved_by: string;
  approved_at: string;
  source_id: string | null;
  supersedes_id: string | null;
  origin_proposal_id: string | null;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    projectId: row.project_id,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    status: row.status as MemoryStatus,
    version: row.version,
    sensitivity: row.sensitivity as SensitivityLevel,
    verification: row.verification as VerificationState,
    reviewAfter: row.review_after,
    pinned: row.pinned === 1,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    sourceId: row.source_id,
    supersedesId: row.supersedes_id,
    originProposalId: row.origin_proposal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

export function getMemory(db: DbConnection, id: string): Memory | undefined {
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get<MemoryRow>(id);
  return row ? toMemory(row) : undefined;
}

export interface MemoryQuery {
  projectId?: string;
  scope?: MemoryScope;
  kind?: MemoryKind;
  /** 不传时默认只返回 active（普通视图）。 */
  statuses?: MemoryStatus[];
  q?: string;
  /** 工作区：真实 / 示例 / 全部。默认只读真实数据。 */
  workspace?: WorkspaceScope;
  limit?: number;
  offset?: number;
}

function escapeLike(input: string): string {
  // 转义 LIKE 通配符。否则用户搜 "100%" 会变成「匹配任意内容」。
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 检索。§6.5 要求「中文短词要能查到」，所以用参数化 LIKE + 规范化匹配，
 * 不假装默认分词器已经解决了中文全文检索。
 */
export function listMemories(db: DbConnection, query: MemoryQuery = {}): { items: Memory[]; total: number } {
  const where: string[] = [workspaceClause(query.workspace ?? 'real')];
  const params: Array<string | number> = [];

  if (query.projectId) {
    where.push('project_id = ?');
    params.push(query.projectId);
  }
  if (query.scope) {
    where.push('scope = ?');
    params.push(query.scope);
  }
  if (query.kind) {
    where.push('kind = ?');
    params.push(query.kind);
  }
  if (query.statuses && query.statuses.length > 0) {
    where.push(`status IN (${query.statuses.map(() => '?').join(',')})`);
    params.push(...query.statuses);
  }
  if (query.q && query.q.trim().length > 0) {
    const needle = `%${escapeLike(query.q.trim().toLowerCase())}%`;
    where.push(
      "(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(project_id,'')) LIKE ? ESCAPE '\\')",
    );
    params.push(needle, needle, needle);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM memory ${clause}`).get<{ n: number }>(...params)?.n ?? 0;

  const rows = db
    .prepare(`SELECT * FROM memory ${clause} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`)
    .all<MemoryRow>(...params, Math.min(query.limit ?? 50, 200), query.offset ?? 0);

  return { items: rows.map(toMemory), total };
}

/** 供上下文构建使用：只取可进上下文的记录（active）。 */
export function listActiveMemoriesForProject(
  db: DbConnection,
  projectId: string,
  options: { includeGlobal?: boolean; workspace?: WorkspaceScope } = {},
): Memory[] {
  const scopeFilter = options.includeGlobal
    ? "(scope = 'project' AND project_id = ?) OR scope = 'global' OR (scope = 'session' AND project_id = ?)"
    : "(scope = 'project' AND project_id = ?) OR (scope = 'session' AND project_id = ?)";
  const params: Array<string | number> = [projectId, projectId];
  const rows = db
    .prepare(
      `SELECT * FROM memory
       WHERE status = 'active' AND ${workspaceClause(options.workspace ?? 'real')} AND (${scopeFilter})
       ORDER BY pinned DESC, updated_at DESC`,
    )
    .all<MemoryRow>(...params);
  return rows.map(toMemory);
}

export function listAllActiveMemories(db: DbConnection, workspace: WorkspaceScope = 'real'): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory WHERE status = 'active' AND ${workspaceClause(workspace)}`,
    )
    .all<MemoryRow>();
  return rows.map(toMemory);
}

/* ------------------------------------------------------------------ */
/* 历史版本                                                            */
/* ------------------------------------------------------------------ */

export interface MemoryRevision {
  id: string;
  memoryId: string;
  version: number;
  title: string;
  content: string;
  kind: MemoryKind;
  scope: MemoryScope;
  projectId: string | null;
  sensitivity: SensitivityLevel;
  verification: VerificationState;
  reviewAfter: string | null;
  status: MemoryStatus;
  pinned: boolean;
  changeKind: string;
  changedBy: string;
  changedAt: string;
  note: string | null;
}

interface RevisionRow {
  id: string;
  memory_id: string;
  version: number;
  title: string;
  content: string;
  kind: string;
  scope: string;
  project_id: string | null;
  sensitivity: string;
  verification: string;
  review_after: string | null;
  status: string;
  pinned: number;
  change_kind: string;
  changed_by: string;
  changed_at: string;
  note: string | null;
}

function toRevision(row: RevisionRow): MemoryRevision {
  return {
    id: row.id,
    memoryId: row.memory_id,
    version: row.version,
    title: row.title,
    content: row.content,
    kind: row.kind as MemoryKind,
    scope: row.scope as MemoryScope,
    projectId: row.project_id,
    sensitivity: row.sensitivity as SensitivityLevel,
    verification: row.verification as VerificationState,
    reviewAfter: row.review_after,
    status: row.status as MemoryStatus,
    pinned: row.pinned === 1,
    changeKind: row.change_kind,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    note: row.note,
  };
}

export function listRevisions(db: DbConnection, memoryId: string): MemoryRevision[] {
  const rows = db
    .prepare('SELECT * FROM memory_revision WHERE memory_id = ? ORDER BY version DESC')
    .all<RevisionRow>(memoryId);
  return rows.map(toRevision);
}

export function getRevision(db: DbConnection, memoryId: string, version: number): MemoryRevision | undefined {
  const row = db
    .prepare('SELECT * FROM memory_revision WHERE memory_id = ? AND version = ?')
    .get<RevisionRow>(memoryId, version);
  return row ? toRevision(row) : undefined;
}

function appendRevision(
  db: DbConnection,
  memory: {
    id: string;
    scope: MemoryScope;
    projectId: string | null;
    kind: MemoryKind;
    title: string;
    content: string;
    status: MemoryStatus;
    version: number;
    sensitivity: SensitivityLevel;
    verification: VerificationState;
    reviewAfter: string | null;
    pinned: boolean;
    sourceId: string | null;
  },
  change: { kind: string; by: string; at: string; note: string | null },
): void {
  db.prepare(
    `INSERT INTO memory_revision (
       id, memory_id, version, title, content, kind, scope, project_id,
       sensitivity, verification, review_after, status, pinned,
       change_kind, changed_by, changed_at, note, source_id
     ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)`,
  ).run(
    newId('revision'),
    memory.id,
    memory.version,
    memory.title,
    memory.content,
    memory.kind,
    memory.scope,
    memory.projectId,
    memory.sensitivity,
    memory.verification,
    memory.reviewAfter,
    memory.status,
    memory.pinned ? 1 : 0,
    change.kind,
    change.by,
    change.at,
    change.note,
    memory.sourceId,
  );
}

/** 只有审核通过的提案能走到这里（INV-10）。 */
export function insertMemoryFromProposal(
  db: DbConnection,
  input: {
    proposalId: string;
    scope: MemoryScope;
    projectId: string | null;
    kind: MemoryKind;
    title: string;
    content: string;
    sensitivity: SensitivityLevel;
    verification: VerificationState;
    reviewAfter: string | null;
    sourceId: string | null;
    supersedesId?: string | null;
    approvedBy: string;
    note?: string | null;
    isDemo?: boolean;
  },
): Memory {
  const id = newId('memory');
  const at = nowIso();
  db.prepare(
    `INSERT INTO memory (
       id, scope, project_id, kind, title, content, status, version,
       sensitivity, verification, review_after, pinned,
       approved_by, approved_at, source_id, supersedes_id, origin_proposal_id,
       created_at, updated_at, is_demo
     ) VALUES (?,?,?,?,?,?, 'active', 1, ?,?,?, 0, ?,?,?,?,?, ?,?,?)`,
  ).run(
    id,
    input.scope,
    input.projectId,
    input.kind,
    input.title,
    input.content,
    input.sensitivity,
    input.verification,
    input.reviewAfter,
    input.approvedBy,
    at,
    input.sourceId,
    input.supersedesId ?? null,
    input.proposalId,
    at,
    at,
    input.isDemo ? 1 : 0,
  );

  const memory = getMemory(db, id) as Memory;
  appendRevision(
    db,
    {
      id: memory.id,
      scope: memory.scope,
      projectId: memory.projectId,
      kind: memory.kind,
      title: memory.title,
      content: memory.content,
      status: memory.status,
      version: memory.version,
      sensitivity: memory.sensitivity,
      verification: memory.verification,
      reviewAfter: memory.reviewAfter,
      pinned: memory.pinned,
      sourceId: memory.sourceId,
    },
    { kind: 'create', by: input.approvedBy, at, note: input.note ?? '由候选审核通过创建' },
  );

  return memory;
}

export function updateMemoryFromProposal(
  db: DbConnection,
  memoryId: string,
  input: {
    title: string;
    content: string;
    kind?: MemoryKind;
    sensitivity?: SensitivityLevel;
    verification?: VerificationState;
    reviewAfter?: string | null;
    scope?: MemoryScope;
    projectId?: string | null;
    approvedBy: string;
    note?: string | null;
    sourceId?: string | null;
  },
): Memory {
  const existing = getMemory(db, memoryId);
  if (!existing) throw new Error(`记忆不存在：${memoryId}`);

  const at = nowIso();
  const nextVersion = existing.version + 1;
  db.prepare(
    `UPDATE memory
     SET title = ?, content = ?, kind = ?, scope = ?, project_id = ?,
         sensitivity = ?, verification = ?, review_after = ?,
         version = ?, approved_by = ?, approved_at = ?, updated_at = ?
     WHERE id = ? AND version = ?`,
  ).run(
    input.title,
    input.content,
    input.kind ?? existing.kind,
    input.scope ?? existing.scope,
    input.projectId !== undefined ? input.projectId : existing.projectId,
    input.sensitivity ?? existing.sensitivity,
    input.verification ?? existing.verification,
    input.reviewAfter !== undefined ? input.reviewAfter : existing.reviewAfter,
    nextVersion,
    input.approvedBy,
    at,
    at,
    memoryId,
    existing.version,
  );

  const updated = getMemory(db, memoryId) as Memory;
  if (updated.version !== nextVersion) {
    throw new Error('版本更新未生效，可能存在并发写入');
  }
  appendRevision(
    db,
    {
      id: updated.id,
      scope: updated.scope,
      projectId: updated.projectId,
      kind: updated.kind,
      title: updated.title,
      content: updated.content,
      status: updated.status,
      version: updated.version,
      sensitivity: updated.sensitivity,
      verification: updated.verification,
      reviewAfter: updated.reviewAfter,
      pinned: updated.pinned,
      sourceId: input.sourceId ?? updated.sourceId,
    },
    { kind: 'update', by: input.approvedBy, at, note: input.note ?? `由候选审核通过更新（基于 v${existing.version}）` },
  );

  return updated;
}

export function setMemoryStatus(
  db: DbConnection,
  memoryId: string,
  nextStatus: MemoryStatus,
  options: { by: string; note: string; supersededBy?: string | null },
): Memory {
  const existing = getMemory(db, memoryId);
  if (!existing) throw new Error(`记忆不存在：${memoryId}`);
  const at = nowIso();
  db.prepare('UPDATE memory SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, at, memoryId);
  const updated = getMemory(db, memoryId) as Memory;
  appendRevision(
    db,
    {
      id: updated.id,
      scope: updated.scope,
      projectId: updated.projectId,
      kind: updated.kind,
      title: updated.title,
      content: updated.content,
      status: updated.status,
      version: updated.version,
      sensitivity: updated.sensitivity,
      verification: updated.verification,
      reviewAfter: updated.reviewAfter,
      pinned: updated.pinned,
      sourceId: updated.sourceId,
    },
    { kind: nextStatus, by: options.by, at, note: options.note },
  );
  return updated;
}

export function setMemoryPinned(db: DbConnection, memoryId: string, pinned: boolean): void {
  db.prepare('UPDATE memory SET pinned = ?, updated_at = ? WHERE id = ?').run(
    pinned ? 1 : 0,
    nowIso(),
    memoryId,
  );
}

/** 永久删除：清正文与历史，但**保留墓碑**（§14.1 / INV-12）。 */
export function deleteMemoryPermanently(
  db: DbConnection,
  memoryId: string,
  options: { by: string; reason: string; contentHash: string; titleHash: string },
): void {
  const existing = getMemory(db, memoryId);
  if (!existing) throw new Error(`记忆不存在：${memoryId}`);
  const at = nowIso();

  db.prepare(
    `INSERT INTO memory_tombstone (memory_id, content_hash, title_hash, scope, project_id, kind, deleted_at, reason, deleted_by)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(memory_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       title_hash = excluded.title_hash,
       deleted_at = excluded.deleted_at,
       reason = excluded.reason,
       deleted_by = excluded.deleted_by`,
  ).run(memoryId, options.contentHash, options.titleHash, existing.scope, existing.projectId, existing.kind, at, options.reason, options.by);

  // 正文与历史一并清除。审计只记动作，不复制被删的全文（§14.1）。
  db.prepare('DELETE FROM memory_revision WHERE memory_id = ?').run(memoryId);
  db.prepare('DELETE FROM memory WHERE id = ?').run(memoryId);
}

/* ------------------------------------------------------------------ */
/* 墓碑                                                                */
/* ------------------------------------------------------------------ */

export interface Tombstone {
  memoryId: string;
  contentHash: string;
  titleHash: string;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  deletedAt: string;
  reason: string;
  deletedBy: string;
}

interface TombstoneRow {
  memory_id: string;
  content_hash: string;
  title_hash: string;
  scope: string;
  project_id: string | null;
  kind: string;
  deleted_at: string;
  reason: string;
  deleted_by: string;
}

function toTombstone(row: TombstoneRow): Tombstone {
  return {
    memoryId: row.memory_id,
    contentHash: row.content_hash,
    titleHash: row.title_hash,
    scope: row.scope as MemoryScope,
    projectId: row.project_id,
    kind: row.kind as MemoryKind,
    deletedAt: row.deleted_at,
    reason: row.reason,
    deletedBy: row.deleted_by,
  };
}

export function findTombstoneByMemoryId(db: DbConnection, memoryId: string): Tombstone | undefined {
  const row = db.prepare('SELECT * FROM memory_tombstone WHERE memory_id = ?').get<TombstoneRow>(memoryId);
  return row ? toTombstone(row) : undefined;
}

/** 命中墓碑：说明这条内容曾被删除，导入时必须重新确认（§10）。 */
export function findTombstoneByContentHash(db: DbConnection, contentHash: string): Tombstone | undefined {
  const row = db
    .prepare('SELECT * FROM memory_tombstone WHERE content_hash = ? ORDER BY deleted_at DESC LIMIT 1')
    .get<TombstoneRow>(contentHash);
  return row ? toTombstone(row) : undefined;
}

export function listTombstones(db: DbConnection, limit = 100): Tombstone[] {
  const rows = db
    .prepare('SELECT * FROM memory_tombstone ORDER BY deleted_at DESC LIMIT ?')
    .all<TombstoneRow>(Math.min(limit, 500));
  return rows.map(toTombstone);
}

export function countTombstones(db: DbConnection): number {
  return db.prepare('SELECT COUNT(*) AS n FROM memory_tombstone').get<{ n: number }>()?.n ?? 0;
}

/* ------------------------------------------------------------------ */
/* 候选                                                                */
/* ------------------------------------------------------------------ */

export interface MemoryProposal {
  id: string;
  operation: ProposalOperation;
  targetMemoryId: string | null;
  baseVersion: number | null;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  sensitivity: SensitivityLevel;
  verification: VerificationState;
  reviewAfter: string | null;
  sourceKind: SourceKind;
  sourceRef: string | null;
  evidenceQuote: string | null;
  evidenceStatus: EvidenceStatus;
  submittedByClientId: string | null;
  status: ProposalStatus;
  contentHash: string;
  duplicateOfProposalId: string | null;
  similarityNote: string | null;
  conflictDetail: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewedTitle: string | null;
  reviewedContent: string | null;
  resultingMemoryId: string | null;
  resultingVersion: number | null;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface ProposalRow {
  id: string;
  operation: string;
  target_memory_id: string | null;
  base_version: number | null;
  scope: string;
  project_id: string | null;
  kind: string;
  title: string;
  content: string;
  sensitivity: string;
  verification: string;
  review_after: string | null;
  source_kind: string;
  source_ref: string | null;
  evidence_quote: string | null;
  evidence_status: string;
  submitted_by_client_id: string | null;
  status: string;
  content_hash: string;
  duplicate_of_proposal_id: string | null;
  similarity_note: string | null;
  conflict_detail: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewed_title: string | null;
  reviewed_content: string | null;
  resulting_memory_id: string | null;
  resulting_version: number | null;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toProposal(row: ProposalRow): MemoryProposal {
  return {
    id: row.id,
    operation: row.operation as ProposalOperation,
    targetMemoryId: row.target_memory_id,
    baseVersion: row.base_version,
    scope: row.scope as MemoryScope,
    projectId: row.project_id,
    kind: row.kind as MemoryKind,
    title: row.title,
    content: row.content,
    sensitivity: row.sensitivity as SensitivityLevel,
    verification: row.verification as VerificationState,
    reviewAfter: row.review_after,
    sourceKind: row.source_kind as SourceKind,
    sourceRef: row.source_ref,
    evidenceQuote: row.evidence_quote,
    evidenceStatus: row.evidence_status as EvidenceStatus,
    submittedByClientId: row.submitted_by_client_id,
    status: row.status as ProposalStatus,
    contentHash: row.content_hash,
    duplicateOfProposalId: row.duplicate_of_proposal_id,
    similarityNote: row.similarity_note,
    conflictDetail: row.conflict_detail,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewedTitle: row.reviewed_title,
    reviewedContent: row.reviewed_content,
    resultingMemoryId: row.resulting_memory_id,
    resultingVersion: row.resulting_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

export function insertProposal(
  db: DbConnection,
  input: {
    operation: ProposalOperation;
    targetMemoryId: string | null;
    baseVersion: number | null;
    scope: MemoryScope;
    projectId: string | null;
    kind: MemoryKind;
    title: string;
    content: string;
    sensitivity: SensitivityLevel;
    verification: VerificationState;
    reviewAfter: string | null;
    sourceKind: SourceKind;
    sourceRef: string | null;
    evidenceQuote: string | null;
    evidenceStatus: EvidenceStatus;
    submittedByClientId: string | null;
    contentHash: string;
    duplicateOfProposalId?: string | null;
    similarityNote?: string | null;
    isDemo?: boolean;
  },
): MemoryProposal {
  const id = newId('proposal');
  const at = nowIso();
  db.prepare(
    `INSERT INTO memory_proposal (
       id, operation, target_memory_id, base_version,
       scope, project_id, kind, title, content, sensitivity, verification, review_after,
       source_kind, source_ref, evidence_quote, evidence_status, submitted_by_client_id,
       status, content_hash, duplicate_of_proposal_id, similarity_note,
       created_at, updated_at, is_demo
     ) VALUES (?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?, 'pending', ?,?,?, ?,?,?)`,
  ).run(
    id,
    input.operation,
    input.targetMemoryId,
    input.baseVersion,
    input.scope,
    input.projectId,
    input.kind,
    input.title,
    input.content,
    input.sensitivity,
    input.verification,
    input.reviewAfter,
    input.sourceKind,
    input.sourceRef,
    input.evidenceQuote,
    input.evidenceStatus,
    input.submittedByClientId,
    input.contentHash,
    input.duplicateOfProposalId ?? null,
    input.similarityNote ?? null,
    at,
    at,
    input.isDemo ? 1 : 0,
  );
  return getProposal(db, id) as MemoryProposal;
}

export function getProposal(db: DbConnection, id: string): MemoryProposal | undefined {
  const row = db.prepare('SELECT * FROM memory_proposal WHERE id = ?').get<ProposalRow>(id);
  return row ? toProposal(row) : undefined;
}

export function listProposals(
  db: DbConnection,
  options: {
    status?: ProposalStatus;
    projectId?: string;
    workspace?: WorkspaceScope;
    limit?: number;
    offset?: number;
  } = {},
): { items: MemoryProposal[]; total: number } {
  const where: string[] = [workspaceClause(options.workspace ?? 'real')];
  const params: Array<string | number> = [];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.projectId) {
    where.push('project_id = ?');
    params.push(options.projectId);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM memory_proposal ${clause}`).get<{ n: number }>(...params)?.n ?? 0;
  const rows = db
    .prepare(`SELECT * FROM memory_proposal ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all<ProposalRow>(...params, Math.min(options.limit ?? 50, 200), options.offset ?? 0);
  return { items: rows.map(toProposal), total };
}

export function countPendingProposals(db: DbConnection, workspace: WorkspaceScope = 'real'): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_proposal WHERE status = 'pending' AND ${workspaceClause(workspace)}`,
      )
      .get<{ n: number }>()?.n ?? 0
  );
}

export function findProposalByContentHash(db: DbConnection, contentHash: string): MemoryProposal | undefined {
  const row = db
    .prepare(
      `SELECT * FROM memory_proposal
       WHERE content_hash = ? AND status IN ('pending','approved') AND is_demo = 0
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get<ProposalRow>(contentHash);
  return row ? toProposal(row) : undefined;
}

export function setProposalStatus(
  db: DbConnection,
  id: string,
  status: ProposalStatus,
  patch: {
    reviewNote?: string | null;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
    reviewedTitle?: string | null;
    reviewedContent?: string | null;
    conflictDetail?: string | null;
    resultingMemoryId?: string | null;
    resultingVersion?: number | null;
  },
): MemoryProposal {
  const existing = getProposal(db, id);
  if (!existing) throw new Error(`候选不存在：${id}`);
  db.prepare(
    `UPDATE memory_proposal SET
       status = ?,
       review_note = ?, reviewed_by = ?, reviewed_at = ?,
       reviewed_title = ?, reviewed_content = ?,
       conflict_detail = ?, resulting_memory_id = ?, resulting_version = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    patch.reviewNote !== undefined ? patch.reviewNote : existing.reviewNote,
    patch.reviewedBy !== undefined ? patch.reviewedBy : existing.reviewedBy,
    patch.reviewedAt !== undefined ? patch.reviewedAt : existing.reviewedAt,
    patch.reviewedTitle !== undefined ? patch.reviewedTitle : existing.reviewedTitle,
    patch.reviewedContent !== undefined ? patch.reviewedContent : existing.reviewedContent,
    patch.conflictDetail !== undefined ? patch.conflictDetail : existing.conflictDetail,
    patch.resultingMemoryId !== undefined ? patch.resultingMemoryId : existing.resultingMemoryId,
    patch.resultingVersion !== undefined ? patch.resultingVersion : existing.resultingVersion,
    nowIso(),
    id,
  );
  return getProposal(db, id) as MemoryProposal;
}

/** 相似候选提示：只返回候选，不做任何自动合并或删除（§6.4）。 */
export function findSimilarProposals(
  db: DbConnection,
  projectId: string | null,
  excludeId: string,
  limit = 20,
): MemoryProposal[] {
  const rows = projectId
    ? db
        .prepare(
          `SELECT * FROM memory_proposal
           WHERE status = 'pending' AND id <> ? AND project_id = ? AND is_demo = 0
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all<ProposalRow>(excludeId, projectId, limit)
    : db
        .prepare(
          `SELECT * FROM memory_proposal
           WHERE status = 'pending' AND id <> ? AND is_demo = 0
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all<ProposalRow>(excludeId, limit);
  return rows.map(toProposal);
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export function countMemoriesByStatus(db: DbConnection, status: MemoryStatus, workspace: WorkspaceScope = 'real'): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory WHERE status = ? AND ${workspaceClause(workspace)}`,
      )
      .get<{ n: number }>(status)?.n ?? 0
  );
}
