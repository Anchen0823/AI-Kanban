/**
 * 记忆路由：正式库、候选箱、审核、归档、删除。
 *
 * 这里有一条硬边界：`POST /api/memory-proposals` 允许代理凭据调用（AI 可以提案），
 * 而 `review` / `delete` 一律 `requireUser`。换句话说，**提版权和批准权不在同一个主体手里**。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  zDeleteMemoryInput,
  zMemoriesQuery,
  zMemoryCandidateImportInput,
  zMemoryProposalInput,
  zProposalsQuery,
  zProposalReviewInput,
} from '@aicc/core';
import {
  createProposal,
  deleteMemory,
  deletePreview,
  getMemoryDetail,
  importCandidatePayload,
  listProposalQueue,
  memoryCounters,
  pinMemory,
  proposalDetail,
  reviewProposal,
  searchMemories,
  transitionMemory,
} from '../../services/memory.js';
import { audit } from '../../services/audit.js';
import { ApiError } from '../errors.js';
import {
  principalProjectScope,
  requirePrincipal,
  requireScope,
  requireUser,
  workspaceOf,
  type HttpDeps,
} from '../server.js';
export function registerMemoryRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const { app } = deps;
  const ctx = app.ctx;

  /* ---------------- 正式记忆 ---------------- */

  fastify.get('/api/memories', async (request) => {
    const principal = requireScope(request, 'memory_search');
    const query = zMemoriesQuery.parse(request.query ?? {});
    const scope = principalProjectScope(principal);

    // 项目范围隔离：凭据只能看到自己被授权的项目（M03）
    if (scope !== null && query.projectId && !scope.includes(query.projectId)) {
      audit(ctx, {
        action: 'auth.reject',
        entityType: 'memory',
        entityId: null,
        result: 'rejected',
        detail: { reason: 'project_scope_violation', requestedProject: query.projectId, granted: scope },
        actorKind: 'agent',
      });
      throw new ApiError(403, 'forbidden', `当前凭据未被授权访问项目 ${query.projectId}`);
    }

    const result = searchMemories(ctx, {
      workspace: workspaceOf(request),
      projectId: query.projectId,
      scope: query.scope,
      kind: query.kind,
      status: query.status,
      q: query.q,
      includeHistory: query.includeHistory,
      limit: query.limit,
      offset: query.offset,
    });

    const items =
      scope === null
        ? result.items
        : result.items.filter((m) => m.projectId === null || scope.includes(m.projectId));

    return {
      items,
      total: scope === null ? result.total : items.length,
      counters: memoryCounters(ctx, workspaceOf(request)),
      note: '默认只返回 active。历史视图需要显式传 includeHistory=true。',
    };
  });

  fastify.get('/api/memories/:id', async (request) => {
    const principal = requireScope(request, 'memory_get');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const detail = getMemoryDetail(ctx, id, workspaceOf(request));
    if (!detail) throw new ApiError(404, 'not_found', `记忆不存在：${id}`);

    const scope = principalProjectScope(principal);
    if (scope !== null && detail.memory.projectId !== null && !scope.includes(detail.memory.projectId)) {
      audit(ctx, {
        action: 'auth.reject',
        entityType: 'memory',
        entityId: id,
        result: 'rejected',
        detail: { reason: 'project_scope_violation', memoryProject: detail.memory.projectId, granted: scope },
        actorKind: 'agent',
      });
      // 注意：不区分「不存在」和「无权限」以外的话术 —— 但这里返回 403 是刻意的：
      // 用户需要知道是自己配置的范围挡住了它。ID 猜测本身不是安全边界（§11.2）。
      throw new ApiError(403, 'forbidden', `当前凭据未被授权访问该记忆所属项目（${detail.memory.projectId}）`);
    }

    return detail;
  });

  fastify.post('/api/memories/:id/pin', async (request) => {
    requireUser(request, '固定记忆');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ pinned: z.boolean() }).parse(request.body ?? {});
    pinMemory(ctx, id, body.pinned);
    return { ok: true };
  });

  fastify.post('/api/memories/:id/transition', async (request) => {
    requireUser(request, '变更记忆状态');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const body = z
      .object({ status: z.enum(['active', 'superseded', 'archived', 'expired']), note: z.string().min(1).max(500) })
      .parse(request.body ?? {});
    const memory = transitionMemory(ctx, id, body.status, body.note);
    return { memory };
  });

  /* ---------------- 删除 ---------------- */

  fastify.post('/api/memories/:id/delete-preview', async (request) => {
    requireUser(request, '删除预览');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    return {
      preview: deletePreview(ctx, id, workspaceOf(request)),
      note: '这是预览，没有任何内容被删除。请特别阅读 cannotDelete 列表。',
    };
  });

  fastify.delete('/api/memories/:id', async (request) => {
    requireUser(request, '删除记忆');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const input = zDeleteMemoryInput.parse(request.body ?? {});
    const result = deleteMemory(ctx, id, {
      reason: input.reason,
      confirmed: input.confirm === true,
      deletedBy: input.deletedBy,
    });
    return { ...result, note: '删除已完成。上面列出的「不随本次删除消失」项仍然存在。' };
  });

  /* ---------------- 候选 ---------------- */

  fastify.get('/api/memory-proposals', async (request) => {
    const principal = requirePrincipal(request);
    const query = zProposalsQuery.parse(request.query ?? {});
    const result = listProposalQueue(ctx, {
      workspace: workspaceOf(request),
      status: query.status,
      projectId: query.projectId,
      limit: query.limit,
      offset: query.offset,
    });
    const scope = principalProjectScope(principal);
    const items =
      scope === null ? result.items : result.items.filter((p) => p.projectId === null || scope.includes(p.projectId));
    return { items, total: items.length, counters: memoryCounters(ctx, workspaceOf(request)) };
  });

  fastify.get('/api/memory-proposals/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const detail = proposalDetail(ctx, id);
    if (!detail) throw new ApiError(404, 'not_found', `候选不存在：${id}`);

    const scope = principalProjectScope(principal);
    if (scope !== null && detail.proposal.projectId !== null && !scope.includes(detail.proposal.projectId)) {
      throw new ApiError(403, 'forbidden', '当前凭据未被授权访问该候选所属项目');
    }

    return {
      ...detail,
      reviewAllowed: principal.kind === 'user',
      reviewBlockedReason:
        principal.kind === 'user' ? null : '代理凭据不能审批候选。批准必须由你本人完成。',
    };
  });

  fastify.post('/api/memory-proposals', async (request) => {
    const principal = requireScope(request, 'memory_propose');
    const input = zMemoryProposalInput.parse(request.body ?? {});

    const scope = principalProjectScope(principal);
    const targetProjectId = input.projectId;
    if (scope !== null) {
      if (targetProjectId === null) {
        throw new ApiError(403, 'forbidden', '当前凭据被限定了项目范围，提案必须指定 projectId');
      }
      if (!scope.includes(targetProjectId)) {
        throw new ApiError(403, 'forbidden', `当前凭据未被授权访问项目 ${targetProjectId}`);
      }
    }

    const conflictHint = input.baseVersion === null ? null : `本提案声明基于 v${input.baseVersion}；批准时会重新校验当前版本，不一致将直接判为冲突并拒绝合并。`;

    const result = createProposal(ctx, {
      operation: input.operation,
      targetMemoryId: input.targetMemoryId,
      baseVersion: input.baseVersion,
      scope: input.scope,
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      sensitivity: input.sensitivity,
      verification: input.verification,
      reviewAfter: input.reviewAfter ?? null,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef ?? null,
      evidenceQuote: input.evidenceQuote ?? null,
      evidenceStatus: input.evidenceStatus,
      submittedByClientId: input.submittedByClientId,
    });

    return {
      proposalId: result.proposal.id,
      // 成功提交提案必须返回 proposal_id 与 status=candidate（§11.2）
      status: 'candidate',
      operation: result.proposal.operation,
      reviewStatus: result.proposal.status,
      warnings: result.warnings,
      tombstoneHit: result.tombstoneHit,
      duplicateOfProposalId: result.duplicateOfProposalId,
      similarProposals: result.similarProposals,
      conflictHint,
      note:
        '这是候选，不是正式记忆。只有人工批准后才会生成 memory_id 与 version。' +
        '在批准之前，它不会出现在任何上下文包里。',
    };
  });

  fastify.post('/api/memory-proposals/import', async (request) => {
    requireUser(request, '导入候选');
    const input = zMemoryCandidateImportInput.parse(request.body ?? {});
    const result = importCandidatePayload(ctx, {
      fileName: input.fileName,
      content: input.content,
      projectMapping: input.projectMapping,
      defaultProjectId: input.defaultProjectId,
      dryRun: input.dryRun,
    });
    return {
      ...result,
      mode: 'candidate-import',
      note: '已生成候选，全部处于 pending。界面与话术都是「已生成候选」，不会声称「已写入统一记忆」。',
    };
  });

  fastify.post('/api/memory-proposals/:id/review', async (request) => {
    requireUser(request, '审批候选');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const input = zProposalReviewInput.parse(request.body ?? {});

    const result = reviewProposal(ctx, id, {
      decision: input.decision,
      reviewedBy: input.reviewedBy,
      reviewNote: input.reviewNote ?? null,
      overrideTitle: input.overrideTitle ?? null,
      overrideContent: input.overrideContent ?? null,
      acknowledgeTombstone: input.acknowledgeTombstone,
    });

    return {
      ...result,
      note:
        input.decision === 'approve'
          ? '已批准。正式记忆诞生于这次人工批准，候选本身不构成记忆。'
          : '已驳回。该候选不会生成任何正式记忆。',
    };
  });
}
