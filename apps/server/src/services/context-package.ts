/**
 * 上下文包服务（设计稿 §4.3 / §6.5）。
 *
 * 一个上下文包是「跨工具交接」这件事的实物。它的价值不在于内容多，
 * 而在于**有版本、有来源、有删减说明**，让下一个客户端能判断该不该信。
 */

import {
  budgetFor,
  buildContextPackage,
  estimateTokens,
  newId,
  renderContextJson,
  renderContextMarkdown,
  selectContextItems,
  type ContextBudgetKind,
  type ContextCandidate,
  type ContextPackage,
  type MemoryKind,
  type SensitivityLevel,
} from '@aicc/core';
import { TxAbort, tx } from '../db/database.js';
import { listActiveMemoriesForProject, type Memory } from '../db/repos/memory.js';
import { getProject } from '../db/repos/registry.js';
import { insertContextExport } from '../db/repos/system.js';
import type { ServiceContext } from '../service-context.js';
import { audit } from './audit.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';

export interface BuildContextInput {
  projectId: string;
  task?: string | null;
  budgetKind: ContextBudgetKind;
  customBudgetTokens?: number | null;
  includeGlobalMemory?: boolean;
  maxSensitivity?: SensitivityLevel;
  /** 请求方声明的项目范围。服务端会与调用方实际授权求交，不直接信任。 */
  requestedProjectIds?: string[] | null;
  /** 调用方实际被授权的项目范围（来自凭据或用户会话）。null = 用户本机不受限。 */
  grantedProjectIds: string[] | null;
  createdBy: string;
  /** 工作区：真实 / 示例 / 全部。默认只读真实数据。 */
  workspace?: WorkspaceScope;
  /** 只预览不落库。 */
  dryRun?: boolean;
}

export interface BuildContextResult {
  exportId: string | null;
  package: ContextPackage;
  markdown: string;
  json: string;
  requiresUserChoice: boolean;
  warnings: string[];
}

export function buildContext(ctx: ServiceContext, input: BuildContextInput): BuildContextResult {
  const project = getProject(ctx.db, input.projectId);
  if (!project) throw new TxAbort('not_found', `项目不存在：${input.projectId}`);

  // INV-13：先把权限范围定下来，再检索。顺序不能反。
  const allowedProjectIds = intersectScope(input.grantedProjectIds, input.requestedProjectIds);
  if (allowedProjectIds !== null && !allowedProjectIds.includes(input.projectId)) {
    throw new TxAbort(
      'forbidden',
      `当前调用方未被授权访问项目 ${input.projectId}（已授权的项目：${allowedProjectIds.join('、') || '无'}）`,
    );
  }

  const budgetTokens = budgetFor(input.budgetKind, input.customBudgetTokens ?? undefined);

  const workspace = input.workspace ?? 'real';
  const memories = listActiveMemoriesForProject(ctx.db, input.projectId, {
    includeGlobal: input.includeGlobalMemory === true,
    workspace,
  });

  const candidates: ContextCandidate[] = memories.map((m) => toCandidate(m, input.task ?? null));

  const selection = selectContextItems(candidates, {
    allowedProjectIds,
    projectId: input.projectId,
    includeGlobalMemory: input.includeGlobalMemory === true,
    maxSensitivity: input.maxSensitivity ?? 'normal',
    budgetTokens,
    task: input.task ?? null,
    now: ctx.now(),
  });

  const exportId = newId('contextExport');
  const pkg = buildContextPackage({
    packageId: exportId,
    projectId: input.projectId,
    projectTitle: project.title,
    task: input.task ?? null,
    budgetKind: input.budgetKind,
    selection,
    generatedAt: new Date(ctx.now()).toISOString(),
  });

  const markdown = renderContextMarkdown(pkg);
  const json = renderContextJson(pkg);

  if (input.dryRun) {
    return {
      exportId: null,
      package: pkg,
      markdown,
      json,
      requiresUserChoice: selection.requiresUserChoice,
      warnings: selection.warnings,
    };
  }

  return tx(ctx.db, () => {
    insertContextExport(ctx.db, {
      id: exportId,
      projectId: input.projectId,
      task: input.task ?? null,
      budgetKind: input.budgetKind,
      budgetTokens,
      estimatedTokens: selection.estimatedTokens,
      tokenCountKind: 'estimated',
      manifest: pkg.manifest as unknown as Record<string, unknown>,
      droppedCount: selection.dropped.length,
      excludedByPolicy: selection.excludedByPolicy,
      warnings: selection.warnings,
      contentMarkdown: markdown,
      contentJson: json,
      memoryRefs: selection.selected.map((i) => ({ memoryId: i.memoryId, version: i.version })),
      createdBy: input.createdBy,
      // 在示例工作区里生成的包也标记为示例，这样它不会混进真实工作区的包列表
      isDemo: workspace === 'demo',
    });

    audit(ctx, {
      action: 'context.export',
      entityType: 'context_export',
      entityId: exportId,
      detail: {
        projectId: input.projectId,
        budgetKind: input.budgetKind,
        budgetTokens,
        estimatedTokens: selection.estimatedTokens,
        itemCount: selection.selected.length,
        droppedCount: selection.dropped.length,
        excludedByPolicy: selection.excludedByPolicy,
        includeGlobalMemory: input.includeGlobalMemory === true,
        memoryVersions: selection.selected.map((i) => `${i.memoryId}@${i.version}`),
      },
      actorKind: input.createdBy === ctx.actor ? 'user' : 'agent',
      isDemo: workspace === 'demo',
    });

    return {
      exportId,
      package: pkg,
      markdown,
      json,
      requiresUserChoice: selection.requiresUserChoice,
      warnings: selection.warnings,
    };
  });
}

/** 授权范围与请求范围的交集。任一侧为 null 表示该侧不设限。 */
export function intersectScope(
  granted: string[] | null,
  requested: string[] | null | undefined,
): string[] | null {
  if (granted === null) return requested ?? null;
  if (!requested || requested.length === 0) return granted;
  const set = new Set(granted);
  return requested.filter((id) => set.has(id));
}

/** 相关性打分：任务描述里出现记忆标题/正文关键词时加权。 */
function relevanceFor(memory: Memory, task: string | null): number {
  let score = 1;
  if (memory.pinned) score += 5;
  if (memory.kind === 'decision' || memory.kind === 'preference') score += 1.5;
  if (memory.verification === 'human_confirmed' || memory.verification === 'formally_verified') score += 1;

  if (task && task.trim().length > 0) {
    const haystack = `${memory.title}\n${memory.content}`.toLowerCase();
    const terms = task
      .toLowerCase()
      .split(/[\s,，。;；:：/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
  }
  return score;
}

function toCandidate(memory: Memory, task: string | null): ContextCandidate {
  return {
    memoryId: memory.id,
    version: memory.version,
    title: memory.title,
    content: memory.content,
    scope: memory.scope,
    projectId: memory.projectId,
    kind: memory.kind as MemoryKind,
    sensitivity: memory.sensitivity,
    pinned: memory.pinned,
    updatedAt: memory.updatedAt,
    relevance: relevanceFor(memory, task),
  };
}

/**
 * 预览「如果把该项目的 active 记忆全部装进去会有多大」。
 *
 * 不含 global 记忆之外的过滤，也不含权限排除 —— 它是一个上界，
 * 用途只是让用户在生成前挑预算，不是精确值。
 */
export function previewContextBudget(
  ctx: ServiceContext,
  projectId: string,
  workspace: WorkspaceScope = 'real',
): { totalCandidates: number; totalEstimatedTokens: number } {
  const memories = listActiveMemoriesForProject(ctx.db, projectId, { includeGlobal: true, workspace });
  const totalEstimatedTokens = memories.reduce(
    (acc, m) => acc + estimateTokens(`${m.title}\n${m.content}\n${m.id}`),
    0,
  );
  return { totalCandidates: memories.length, totalEstimatedTokens };
}
