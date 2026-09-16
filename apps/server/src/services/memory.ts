/**
 * 记忆服务：候选导入、审核、版本、删除（设计稿 §6 / §4.4，M01～M05）。
 *
 * 这个文件是整个系统里最需要克制的部分。它必须做到：
 * - AI 只能**提案**，永远不能直接写正式记忆（M01 / INV-10）。
 * - 更新必须匹配 `base_version`，冲突就报冲突（M02 / INV-11）。
 * - 删除必须留下只含哈希的墓碑，旧包再次导入要重新确认（M05 / INV-12）。
 * - 删除报告必须说清「哪些东西删不掉」，而不是给用户一个「已彻底遗忘」的错觉。
 */

import {
  canTransitionMemory,
  checkBaseVersion,
  diffLines,
  memoryContentHash,
  normalizeText,
  nowIso,
  proposalContentHash,
  textSimilarity,
  type EvidenceStatus,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type ProposalOperation,
  type SensitivityLevel,
  type SourceKind,
  type VerificationState,
} from '@aicc/core';
import { TxAbort, tx } from '../db/database.js';
import {
  deleteMemoryPermanently,
  findProposalByContentHash,
  findSimilarProposals,
  findTombstoneByContentHash,
  findTombstoneByMemoryId,
  getMemory,
  getProposal,
  insertMemoryFromProposal,
  insertProposal,
  insertSource,
  listMemories,
  listProposals,
  listRevisions,
  setMemoryPinned,
  setMemoryStatus,
  setProposalStatus,
  updateMemoryFromProposal,
  countMemoriesByStatus,
  countPendingProposals,
  countTombstones,
  type Memory,
  type MemoryProposal,
  type MemoryRevision,
} from '../db/repos/memory.js';
import {
  getProject,
  findProjectByTitle,
  listProjects,
  listSessions,
} from '../db/repos/registry.js';
import { invalidateContextExports, listContextExports } from '../db/repos/system.js';
import { guardImportPayload } from '../imports/guard.js';
import { parseJsonRecords } from '../imports/parse.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';
import type { ServiceContext } from '../service-context.js';
import { audit } from './audit.js';

/* ------------------------------------------------------------------ */
/* 候选创建                                                            */
/* ------------------------------------------------------------------ */

export interface CreateProposalInput {
  operation: ProposalOperation;
  targetMemoryId?: string | null;
  baseVersion?: number | null;
  scope: MemoryScope;
  projectId?: string | null;
  kind: MemoryKind;
  title: string;
  content: string;
  sensitivity?: SensitivityLevel;
  verification?: VerificationState;
  reviewAfter?: string | null;
  sourceKind?: SourceKind;
  sourceRef?: string | null;
  evidenceQuote?: string | null;
  evidenceStatus?: EvidenceStatus;
  submittedByClientId?: string | null;
  isDemo?: boolean;
}

export interface ProposalCreated {
  proposal: MemoryProposal;
  warnings: string[];
  /** 命中墓碑时为 true：批准前必须显式确认。 */
  tombstoneHit: { memoryId: string; deletedAt: string; reason: string } | null;
  /** 与已有候选内容完全一致时给出，只建议合并不自动合并。 */
  duplicateOfProposalId: string | null;
  similarProposals: Array<{ proposalId: string; title: string; similarity: number }>;
}

export function createProposal(ctx: ServiceContext, input: CreateProposalInput): ProposalCreated {
  const title = normalizeText(input.title);
  const content = normalizeText(input.content);
  if (title.length === 0 || content.length === 0) {
    throw new TxAbort('invalid_input', '候选记忆的标题与正文都不能为空');
  }

  // 项目引用必须存在。不存在就报错，不静默创建一个来自 AI 输出的项目。
  if (input.projectId !== null && input.projectId !== undefined) {
    if (!getProject(ctx.db, input.projectId)) {
      throw new TxAbort('invalid_input', `项目不存在：${input.projectId}`);
    }
  }
  if (input.scope === 'project' && !input.projectId) {
    throw new TxAbort('invalid_input', 'scope 为 project 的候选必须指定 projectId');
  }

  const contentHash = proposalContentHash(title, content);
  const existingSame = findProposalByContentHash(ctx.db, contentHash);
  const tombstone = findTombstoneByContentHash(ctx.db, memoryContentHash(title, content));

  const similar = findSimilarProposals(ctx.db, input.projectId ?? null, existingSame?.id ?? 'none', 30)
    .map((p) => ({ proposalId: p.id, title: p.title, similarity: textSimilarity(p.title + p.content, title + content) }))
    .filter((s) => s.similarity >= 0.6)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  const warnings: string[] = [];
  if (existingSame) {
    warnings.push(
      `已存在内容完全相同的候选 ${existingSame.id}（${existingSame.status}）。建议合并而不是重复批准。`,
    );
  }
  if (tombstone) {
    warnings.push(
      `这条内容与 ${tombstone.deletedAt} 删除的一条记忆完全一致（墓碑 ${tombstone.memoryId}）。` +
        '批准前必须显式确认，避免旧导入包把已删除的记忆悄悄复活。',
    );
  }
  if (input.evidenceStatus === 'user_confirmation_required' || !input.evidenceStatus) {
    warnings.push(
      '该候选标记为「需要用户确认」：模型生成过这段摘要，不等于你确认过其中每一项。请核对原文证据后再批准。',
    );
  }
  if (!input.sourceRef) {
    warnings.push('没有可验证的来源链接（source_ref 为空）。这是允许的，但系统不会替你编造一个。');
  }

  return tx(ctx.db, () => {
    const proposal = insertProposal(ctx.db, {
      operation: input.operation,
      targetMemoryId: input.targetMemoryId ?? null,
      baseVersion: input.baseVersion ?? null,
      scope: input.scope,
      projectId: input.projectId ?? null,
      kind: input.kind,
      title,
      content,
      sensitivity: input.sensitivity ?? 'normal',
      verification: input.verification ?? 'unverified',
      reviewAfter: input.reviewAfter ?? null,
      sourceKind: input.sourceKind ?? 'agent_proposal',
      sourceRef: input.sourceRef ?? null,
      evidenceQuote: input.evidenceQuote ?? null,
      evidenceStatus: input.evidenceStatus ?? 'user_confirmation_required',
      submittedByClientId: input.submittedByClientId ?? null,
      contentHash,
      duplicateOfProposalId: existingSame?.id ?? null,
      similarityNote: similar.length > 0 ? `与 ${similar.length} 条待审候选语义相近，建议一并核对` : null,
      isDemo: input.isDemo,
    });

    audit(ctx, {
      action: 'proposal.create',
      entityType: 'memory_proposal',
      entityId: proposal.id,
      result: 'ok',
      detail: {
        operation: proposal.operation,
        targetMemoryId: proposal.targetMemoryId,
        baseVersion: proposal.baseVersion,
        projectId: proposal.projectId,
        kind: proposal.kind,
        sourceKind: proposal.sourceKind,
        hasSourceRef: Boolean(proposal.sourceRef),
        duplicateOfProposalId: proposal.duplicateOfProposalId,
      },
      actorKind: input.submittedByClientId ? 'agent' : 'user',
      isDemo: input.isDemo,
    });

    return {
      proposal,
      warnings,
      tombstoneHit: tombstone
        ? { memoryId: tombstone.memoryId, deletedAt: tombstone.deletedAt, reason: tombstone.reason }
        : null,
      duplicateOfProposalId: existingSame?.id ?? null,
      similarProposals: similar,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 批量导入候选（ChatGPT 桥接）                                         */
/* ------------------------------------------------------------------ */

export interface CandidateImportResult {
  totalCandidates: number;
  created: Array<{ index: number; proposalId: string; title: string; warnings: string[] }>;
  rejected: Array<{ index: number; reason: string; title: string | null }>;
  unresolvedProjects: string[];
  warnings: string[];
  dryRun: boolean;
}

interface RawCandidate {
  schema_version?: string;
  operation?: string;
  target_memory_id?: string | null;
  base_version?: number | null;
  scope?: string;
  project_id?: string | null;
  kind?: string;
  title?: string;
  content?: string;
  source?: { kind?: string; source_ref?: string | null; evidence_quote?: string | null; evidence_status?: string };
  sensitivity?: string;
  verification?: string;
  review_after?: string | null;
  evidence_quote?: string | null;
}

const SCOPES: MemoryScope[] = ['global', 'project', 'session'];
const KINDS: MemoryKind[] = ['preference', 'fact', 'decision', 'lesson', 'hypothesis', 'handoff'];
const SENSITIVITIES: SensitivityLevel[] = ['normal', 'private', 'restricted'];
const VERIFICATIONS: VerificationState[] = ['unverified', 'locally_tested', 'formally_verified', 'human_confirmed'];
const OPERATIONS: ProposalOperation[] = ['create', 'update', 'archive'];
const SOURCE_KINDS: SourceKind[] = [
  'manual_input',
  'chatgpt_summary',
  'chatgpt_export',
  'codex_session',
  'cursor_session',
  'workbuddy_session',
  'imported_file',
  'local_log',
  'official_api',
  'agent_proposal',
];
const EVIDENCE_STATUSES: EvidenceStatus[] = ['verified', 'user_confirmation_required', 'unknown'];

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/**
 * 导入粘贴来的候选记忆包（§4.2 的基础模式）。
 *
 * 注意这不是「写入统一记忆」：它只是把文本变成**待审核候选**。
 * 全部候选创建后状态都是 `pending`，没有任何一条会自动进入正式库。
 */
export function importCandidatePayload(
  ctx: ServiceContext,
  input: {
    fileName: string;
    content: string;
    projectMapping: Record<string, string>;
    defaultProjectId: string | null;
    dryRun: boolean;
    isDemo?: boolean;
  },
): CandidateImportResult {
  const guard = guardImportPayload(input.fileName, input.content, {
    maxBytes: ctx.config.maxImportBytes,
    allowedExtensions: ['.json'],
  });
  if (!guard.ok) throw new TxAbort('import_rejected', guard.message);

  const { records, warnings: parseWarnings } = parseJsonRecords(input.content);
  if (records.length > ctx.config.maxImportRows) {
    throw new TxAbort('import_too_many_rows', `候选数量 ${records.length} 超过上限 ${ctx.config.maxImportRows}`);
  }

  const warnings: string[] = [...guard.notices, ...parseWarnings];
  const created: CandidateImportResult['created'] = [];
  const rejected: CandidateImportResult['rejected'] = [];
  const unresolved = new Set<string>();

  const projects = listProjects(ctx.db, { includeDemo: true });
  const projectIds = new Set(projects.map((p) => p.id));

  const resolveProject = (ref: string | null | undefined): string | null => {
    const raw = (ref ?? '').trim();
    if (raw.length === 0) return input.defaultProjectId;
    const mapped = input.projectMapping[raw];
    if (mapped && projectIds.has(mapped)) return mapped;
    if (projectIds.has(raw)) return raw;
    const byTitle = findProjectByTitle(ctx.db, raw);
    if (byTitle) return byTitle.id;
    unresolved.add(raw);
    return input.defaultProjectId;
  };

  records.forEach((record, index) => {
    const candidate = record as RawCandidate;
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    if (!title || typeof candidate.content !== 'string' || candidate.content.trim().length === 0) {
      rejected.push({ index, reason: '缺少 title 或 content', title: title.length > 0 ? title : null });
      return;
    }

    const operation = pick<ProposalOperation>(candidate.operation, OPERATIONS, 'create');
    const scope = pick<MemoryScope>(candidate.scope, SCOPES, 'project');
    const kind = pick<MemoryKind>(candidate.kind, KINDS, 'fact');
    const sensitivity = pick<SensitivityLevel>(candidate.sensitivity, SENSITIVITIES, 'normal');
    const verification = pick<VerificationState>(candidate.verification, VERIFICATIONS, 'unverified');
    const sourceKind = pick<SourceKind>(candidate.source?.kind, SOURCE_KINDS, 'chatgpt_summary');
    const evidenceStatus = pick<EvidenceStatus>(
      candidate.source?.evidence_status,
      EVIDENCE_STATUSES,
      'user_confirmation_required',
    );
    const projectId = resolveProject(candidate.project_id ?? null);

    if (scope === 'project' && !projectId) {
      rejected.push({
        index,
        reason: `scope=project 但项目引用 ${JSON.stringify(candidate.project_id ?? '')} 无法解析到已有项目，且未提供默认项目`,
        title,
      });
      return;
    }

    if (input.dryRun) {
      created.push({ index, proposalId: `preview-${index}`, title, warnings: ['预检：未写入数据库'] });
      return;
    }

    try {
      const result = createProposal(ctx, {
        operation,
        targetMemoryId: candidate.target_memory_id ?? null,
        baseVersion: typeof candidate.base_version === 'number' ? candidate.base_version : null,
        scope,
        projectId,
        kind,
        title,
        content: candidate.content,
        sensitivity,
        verification,
        reviewAfter: candidate.review_after ?? null,
        sourceKind,
        sourceRef: candidate.source?.source_ref ?? null,
        evidenceQuote: candidate.source?.evidence_quote ?? candidate.evidence_quote ?? null,
        evidenceStatus,
        isDemo: input.isDemo,
      });
      created.push({ index, proposalId: result.proposal.id, title, warnings: result.warnings });
    } catch (err) {
      rejected.push({ index, reason: err instanceof Error ? err.message : String(err), title });
    }
  });

  if (unresolved.size > 0) {
    warnings.push(
      `以下项目引用无法匹配到已有项目，这些候选的项目字段被留空或回落到默认项目：${[...unresolved].join('、')}。` +
        '系统不会因为 AI 写了一个项目名就自动创建项目。请先建立项目，或用 projectMapping 显式指定。',
    );
  }
  warnings.push(
    `已生成 ${created.length} 条候选，全部处于 pending 状态。在人工批准之前，它们不会进入任何上下文包（M01）。`,
  );

  audit(ctx, {
    action: 'proposal.create',
    entityType: 'memory_proposal',
    entityId: null,
    result: rejected.length > 0 && created.length === 0 ? 'rejected' : 'ok',
    detail: {
      source: 'candidate_import',
      fileName: input.fileName,
      total: records.length,
      created: created.length,
      rejected: rejected.length,
      dryRun: input.dryRun,
      unresolvedProjects: [...unresolved],
    },
    actorKind: 'agent',
    isDemo: input.isDemo,
  });

  return {
    totalCandidates: records.length,
    created,
    rejected,
    unresolvedProjects: [...unresolved],
    warnings,
    dryRun: input.dryRun,
  };
}

/* ------------------------------------------------------------------ */
/* 审核                                                                */
/* ------------------------------------------------------------------ */

export interface ReviewResult {
  proposal: MemoryProposal;
  memory: Memory | null;
  invalidatedExports: string[];
  warnings: string[];
}

export function reviewProposal(
  ctx: ServiceContext,
  proposalId: string,
  input: {
    decision: 'approve' | 'reject';
    reviewedBy: string;
    reviewNote?: string | null;
    overrideTitle?: string | null;
    overrideContent?: string | null;
    acknowledgeTombstone?: boolean;
  },
): ReviewResult {
  const proposal = getProposal(ctx.db, proposalId);
  if (!proposal) throw new TxAbort('not_found', `候选不存在：${proposalId}`);
  if (proposal.status !== 'pending') {
    throw new TxAbort('invalid_state', `候选当前状态为 ${proposal.status}，只有 pending 状态可以被审核。`);
  }

  const target = proposal.targetMemoryId ? getMemory(ctx.db, proposal.targetMemoryId) : undefined;
  const check = checkBaseVersion(proposal.operation, target?.version ?? null, proposal.baseVersion);

  if (input.decision === 'reject') {
    return tx(ctx.db, () => {
      const updated = setProposalStatus(ctx.db, proposalId, 'rejected', {
        reviewNote: input.reviewNote ?? null,
        reviewedBy: input.reviewedBy,
        reviewedAt: nowIso(),
      });
      audit(ctx, {
        action: 'proposal.review',
        entityType: 'memory_proposal',
        entityId: proposalId,
        result: 'rejected',
        detail: { decision: 'reject', reviewNote: input.reviewNote ?? null },
      });
      return { proposal: updated, memory: null, invalidatedExports: [], warnings: [] };
    });
  }

  // ---- 版本冲突：先落库标记，再抛错，确保「冲突」这件事被持久记录下来 ----
  if (!check.ok) {
    tx(ctx.db, () => {
      setProposalStatus(ctx.db, proposalId, 'conflict', {
        reviewNote: input.reviewNote ?? null,
        reviewedBy: input.reviewedBy,
        reviewedAt: nowIso(),
        conflictDetail: JSON.stringify({
          code: check.code,
          currentVersion: check.currentVersion,
          baseVersion: check.baseVersion,
          targetMemoryId: proposal.targetMemoryId,
          message: check.message,
        }),
      });
      audit(ctx, {
        action: 'proposal.review',
        entityType: 'memory_proposal',
        entityId: proposalId,
        result: 'conflict',
        detail: {
          code: check.code,
          currentVersion: check.currentVersion,
          baseVersion: check.baseVersion,
        },
      });
    });
    throw new TxAbort(check.code, check.message, {
      code: check.code,
      currentVersion: check.currentVersion,
      baseVersion: check.baseVersion,
      targetMemoryId: proposal.targetMemoryId,
    });
  }

  const finalTitle = normalizeText(input.overrideTitle ?? proposal.title);
  const finalContent = normalizeText(input.overrideContent ?? proposal.content);
  if (finalTitle.length === 0 || finalContent.length === 0) {
    throw new TxAbort('invalid_input', '批准后的标题与正文不能为空');
  }

  // ---- 墓碑：内容曾被删除过，必须显式确认（M05 / INV-12） ----
  const tombstone = findTombstoneByContentHash(ctx.db, memoryContentHash(finalTitle, finalContent));
  if (tombstone && !input.acknowledgeTombstone) {
    throw new TxAbort(
      'tombstone_hit',
      `这条内容与 ${tombstone.deletedAt} 删除的记忆（墓碑 ${tombstone.memoryId}）完全一致。` +
        '为避免旧导入包复活已删除内容，请确认后重试（acknowledgeTombstone = true）。',
      { memoryId: tombstone.memoryId, deletedAt: tombstone.deletedAt, reason: tombstone.reason },
    );
  }

  const warnings: string[] = [];
  const editedSomething =
    normalizeText(input.overrideTitle ?? proposal.title) !== proposal.title ||
    normalizeText(input.overrideContent ?? proposal.content) !== proposal.content;
  if (editedSomething) {
    const diff = diffLines(proposal.content, finalContent);
    warnings.push(
      `批准时对正文做了调整（+${diff.added} 行 / -${diff.removed} 行）。这属于用户编辑，与提案原文的差异已记录在审核备注中。`,
    );
  }
  if (proposal.evidenceStatus === 'user_confirmation_required' && !input.reviewNote) {
    warnings.push('该候选标记为「需要用户确认」，但本次批准没有留下核对备注。');
  }

  return tx(ctx.db, () => {
    let memory: Memory;
    if (proposal.operation === 'create') {
      // 正式记忆才写入 source 行：候选没被批准过就不该在来源表里留下「已归档」的痕迹。
      const sourceId = insertSource(ctx.db, {
        kind: proposal.sourceKind,
        externalId: proposal.sourceRef,
        locator: proposal.sourceRef,
        contentFingerprint: proposal.contentHash,
        retention: 'keep',
        isDemo: proposal.isDemo,
      });
      memory = insertMemoryFromProposal(ctx.db, {
        proposalId: proposal.id,
        scope: proposal.scope,
        projectId: proposal.projectId,
        kind: proposal.kind,
        title: finalTitle,
        content: finalContent,
        sensitivity: proposal.sensitivity,
        verification: proposal.verification,
        reviewAfter: proposal.reviewAfter,
        sourceId,
        approvedBy: input.reviewedBy,
        note: input.reviewNote ?? null,
        isDemo: proposal.isDemo,
      });
    } else if (proposal.operation === 'update') {
      if (!target) throw new TxAbort('not_found', '目标记忆不存在');
      memory = updateMemoryFromProposal(ctx.db, target.id, {
        title: finalTitle,
        content: finalContent,
        kind: proposal.kind,
        sensitivity: proposal.sensitivity,
        verification: proposal.verification,
        reviewAfter: proposal.reviewAfter,
        scope: proposal.scope,
        projectId: proposal.projectId,
        approvedBy: input.reviewedBy,
        note: input.reviewNote ?? null,
      });
    } else {
      if (!target) throw new TxAbort('not_found', '目标记忆不存在');
      if (!canTransitionMemory(target.status, 'archived')) {
        throw new TxAbort('invalid_state', `记忆当前状态 ${target.status} 不允许归档`);
      }
      memory = setMemoryStatus(ctx.db, target.id, 'archived', {
        by: input.reviewedBy,
        note: input.reviewNote ?? '由归档提案批准',
      });
    }

    const updatedProposal = setProposalStatus(ctx.db, proposalId, 'approved', {
      reviewNote: input.reviewNote ?? null,
      reviewedBy: input.reviewedBy,
      reviewedAt: nowIso(),
      reviewedTitle: finalTitle,
      reviewedContent: finalContent,
      resultingMemoryId: memory.id,
      resultingVersion: memory.version,
    });

    // 旧上下文包引用的是旧版本 → 标记为失效（§4.4）
    const invalidated =
      proposal.operation === 'update' ? invalidateContextExports(ctx.db, memory.id, memory.version) : [];

    audit(ctx, {
      action: proposal.operation === 'create' ? 'memory.create' : proposal.operation === 'update' ? 'memory.update' : 'memory.archive',
      entityType: 'memory',
      entityId: memory.id,
      version: memory.version,
      result: 'ok',
      detail: {
        proposalId: proposal.id,
        operation: proposal.operation,
        scope: memory.scope,
        projectId: memory.projectId,
        kind: memory.kind,
        editedDuringReview: editedSomething,
        invalidatedExports: invalidated.length,
      },
      isDemo: proposal.isDemo,
    });

    return { proposal: updatedProposal, memory, invalidatedExports: invalidated, warnings };
  });
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export function searchMemories(
  ctx: ServiceContext,
  query: {
    projectId?: string;
    scope?: MemoryScope;
    kind?: MemoryKind;
    status?: MemoryStatus;
    q?: string;
    includeHistory?: boolean;
    limit?: number;
    offset?: number;
    workspace?: WorkspaceScope;
  },
) {
  const statuses: MemoryStatus[] | undefined = query.status
    ? [query.status]
    : query.includeHistory
      ? ['active', 'superseded', 'archived', 'expired']
      : ['active'];
  return listMemories(ctx.db, { ...query, statuses });
}

export interface MemoryDetail {
  memory: Memory;
  revisions: MemoryRevision[];
  supersedes: Memory | null;
  /** 引用到这条记忆的上下文包（含已失效）。 */
  referencedExports: Array<{ id: string; createdAt: string; invalidatedAt: string | null }>;
  sessions: Array<{ id: string; createdAt: string; summary: string | null }>;
  project: { id: string; title: string } | null;
}

export function getMemoryDetail(
  ctx: ServiceContext,
  memoryId: string,
  workspace: WorkspaceScope = 'real',
): MemoryDetail | null {
  const memory = getMemory(ctx.db, memoryId);
  if (!memory) return null;
  const supersedes = memory.supersedesId ? (getMemory(ctx.db, memory.supersedesId) ?? null) : null;
  const exports = listContextExports(ctx.db, memory.projectId ?? undefined, 200, workspace).filter((e) =>
    e.memoryRefs.some((r) => r.memoryId === memoryId),
  );
  const sessions = memory.projectId
    ? listSessions(ctx.db, memory.projectId).map((s) => ({ id: s.id, createdAt: s.createdAt, summary: s.summary }))
    : [];
  const project = memory.projectId ? getProject(ctx.db, memory.projectId) : undefined;
  return {
    memory,
    revisions: listRevisions(ctx.db, memoryId),
    supersedes,
    referencedExports: exports.map((e) => ({ id: e.id, createdAt: e.createdAt, invalidatedAt: e.invalidatedAt })),
    sessions: sessions.slice(0, 10),
    project: project ? { id: project.id, title: project.title } : null,
  };
}

export function memoryCounters(ctx: ServiceContext, workspace: WorkspaceScope = 'real') {
  return {
    active: countMemoriesByStatus(ctx.db, 'active', workspace),
    archived: countMemoriesByStatus(ctx.db, 'archived', workspace),
    expired: countMemoriesByStatus(ctx.db, 'expired', workspace),
    superseded: countMemoriesByStatus(ctx.db, 'superseded', workspace),
    pendingProposals: countPendingProposals(ctx.db, workspace),
    // 墓碑没有 is_demo 列：它只含哈希，且必须跨工作区生效（旧导入包不能复活任何工作区里删过的内容）
    tombstones: countTombstones(ctx.db),
    workspace,
  };
}

export function listProposalQueue(
  ctx: ServiceContext,
  options: {
    status?: 'pending' | 'approved' | 'rejected' | 'conflict';
    projectId?: string;
    limit?: number;
    offset?: number;
    workspace?: WorkspaceScope;
  },
) {
  return listProposals(ctx.db, options);
}

/** 候选详情：包含与目标记忆的差异，供审核界面使用（来源在左、候选在右、差异在下）。 */
export function proposalDetail(ctx: ServiceContext, proposalId: string) {
  const proposal = getProposal(ctx.db, proposalId);
  if (!proposal) return null;
  const target = proposal.targetMemoryId ? (getMemory(ctx.db, proposal.targetMemoryId) ?? null) : null;
  const diff = target ? diffLines(target.content, proposal.content) : null;
  const similar = findSimilarProposals(ctx.db, proposal.projectId, proposal.id, 20)
    .map((p) => ({ proposalId: p.id, title: p.title, similarity: textSimilarity(p.title + p.content, proposal.title + proposal.content) }))
    .filter((s) => s.similarity >= 0.5)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
  return { proposal, target, diff, similar };
}

/* ------------------------------------------------------------------ */
/* 归档 / 恢复 / 固定                                                   */
/* ------------------------------------------------------------------ */

export function transitionMemory(
  ctx: ServiceContext,
  memoryId: string,
  next: MemoryStatus,
  note: string,
): Memory {
  const memory = getMemory(ctx.db, memoryId);
  if (!memory) throw new TxAbort('not_found', `记忆不存在：${memoryId}`);
  if (!canTransitionMemory(memory.status, next)) {
    throw new TxAbort('invalid_state', `不允许从 ${memory.status} 迁移到 ${next}`);
  }
  return tx(ctx.db, () => {
    const updated = setMemoryStatus(ctx.db, memoryId, next, { by: ctx.actor, note });
    audit(ctx, {
      action: next === 'archived' ? 'memory.archive' : 'memory.update',
      entityType: 'memory',
      entityId: memoryId,
      version: updated.version,
      detail: { from: memory.status, to: next, note },
    });
    return updated;
  });
}

export function pinMemory(ctx: ServiceContext, memoryId: string, pinned: boolean): void {
  const memory = getMemory(ctx.db, memoryId);
  if (!memory) throw new TxAbort('not_found', `记忆不存在：${memoryId}`);
  tx(ctx.db, () => {
    setMemoryPinned(ctx.db, memoryId, pinned);
    audit(ctx, {
      action: 'memory.update',
      entityType: 'memory',
      entityId: memoryId,
      version: memory.version,
      detail: { pinned },
    });
  });
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

export interface DeletePreview {
  memoryId: string;
  title: string;
  version: number;
  status: MemoryStatus;
  projectId: string | null;
  scope: MemoryScope;
  /** 本次删除会影响到的本地记录。 */
  willDelete: {
    currentContent: boolean;
    revisionCount: number;
    revisionVersions: number[];
  };
  /** 会被标记为失效、但不会被删除的导出包。 */
  exportsToInvalidate: Array<{ id: string; createdAt: string; projectId: string }>;
  /** 不会随本次删除消失的东西。必须如实列出。 */
  cannotDelete: string[];
  tombstone: {
    willCreate: boolean;
    contentHash: string;
    alreadyExists: boolean;
    note: string;
  };
  /** 该记忆是否被提升为正式记忆的会话摘要引用。 */
  /** 该记忆所属项目下最近的会话（只含 ID 与摘要，不含聊天全文）。 */
  relatedSessions: Array<{ id: string; createdAt: string }>;
}

/**
 * 删除预览。§4.4 要求「用户删除时，系统展示本地记录、原始导入材料、历史版本、
 * 导出文件和外部平台分别能否删除」。
 *
 * 这里最重要的一段是 `cannotDelete`：由系统替用户说清楚「你以为删干净了，
 * 其实还有几处副本在你自己手里」。
 */
export function deletePreview(ctx: ServiceContext, memoryId: string, workspace: WorkspaceScope = 'real'): DeletePreview {
  const memory = getMemory(ctx.db, memoryId);
  if (!memory) throw new TxAbort('not_found', `记忆不存在：${memoryId}`);

  const revisions = listRevisions(ctx.db, memoryId);
  const exports = listContextExports(ctx.db, memory.projectId ?? undefined, 500, workspace).filter((e) =>
    e.memoryRefs.some((r) => r.memoryId === memoryId),
  );
  const existingTombstone = findTombstoneByMemoryId(ctx.db, memoryId);
  const sessions = memory.projectId ? listSessions(ctx.db, memory.projectId).slice(0, 10) : [];

  return {
    memoryId,
    title: memory.title,
    version: memory.version,
    status: memory.status,
    projectId: memory.projectId,
    scope: memory.scope,
    willDelete: {
      currentContent: true,
      revisionCount: revisions.length,
      revisionVersions: revisions.map((r) => r.version),
    },
    exportsToInvalidate: exports.map((e) => ({ id: e.id, createdAt: e.createdAt, projectId: e.projectId })),
    cannotDelete: [
      '已经复制或粘贴到其他 AI 客户端（ChatGPT / Codex / Cursor / WorkBuddy）里的文本 —— 本系统无法撤回。',
      '其他平台的原生记忆（例如 ChatGPT 的 Memory）—— 本系统不写入也不删除它。',
      '你自己另存的导出文件、备份文件、截图或笔记。',
      '已经进入对方模型上下文的对话内容。',
    ],
    relatedSessions: sessions.map((s) => ({ id: s.id, createdAt: s.createdAt })),
    tombstone: {
      willCreate: true,
      contentHash: memoryContentHash(memory.title, memory.content),
      alreadyExists: Boolean(existingTombstone),
      note: '删除后会留下一行只含哈希的墓碑（不含正文），防止旧导入包把这条内容悄悄复活。',
    },
  };
}

export interface DeleteResult {
  memoryId: string;
  deletedAt: string;
  tombstoneMemoryId: string;
  invalidatedExports: string[];
  report: string[];
}

export function deleteMemory(
  ctx: ServiceContext,
  memoryId: string,
  input: { reason: string; confirmed: boolean; deletedBy: string },
): DeleteResult {
  if (!input.confirmed) {
    throw new TxAbort('invalid_input', '永久删除必须显式确认（confirm = true）');
  }
  const memory = getMemory(ctx.db, memoryId);
  if (!memory) throw new TxAbort('not_found', `记忆不存在：${memoryId}`);

  const preview = deletePreview(ctx, memoryId);
  const contentHash = memoryContentHash(memory.title, memory.content);
  const titleHash = memoryContentHash(memory.title, '');

  return tx(ctx.db, () => {
    // 引用它的导出包先标记失效，而不是静默保留一份过期副本
    const invalidated = invalidateContextExports(ctx.db, memoryId, memory.version + 1_000_000);

    deleteMemoryPermanently(ctx.db, memoryId, {
      by: input.deletedBy,
      reason: input.reason,
      contentHash,
      titleHash,
    });

    audit(ctx, {
      action: 'memory.delete',
      entityType: 'memory',
      entityId: memoryId,
      version: memory.version,
      result: 'ok',
      // 只记 ID、计数、原因。不把被删正文复制进审计（§14.1）。
      detail: {
        reason: input.reason,
        scope: memory.scope,
        projectId: memory.projectId,
        kind: memory.kind,
        revisionCount: preview.willDelete.revisionCount,
        invalidatedExports: invalidated.length,
        tombstoneCreated: true,
      },
    });

    return {
      memoryId,
      deletedAt: nowIso(),
      tombstoneMemoryId: memoryId,
      invalidatedExports: invalidated,
      report: [
        `已删除正式正文与 ${preview.willDelete.revisionCount} 个历史版本。`,
        `已创建只含哈希的墓碑（${memoryId}），重复导入相同内容时会要求重新确认。`,
        invalidated.length > 0 ? `已把 ${invalidated.length} 个引用它的上下文包标记为失效。` : '没有上下文包引用这条记忆。',
        '以下内容不随本次删除消失：',
        ...preview.cannotDelete.map((s) => `  · ${s}`),
      ],
    };
  });
}
