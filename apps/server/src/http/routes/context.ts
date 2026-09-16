/**
 * 上下文包与 ChatGPT 桥接路由。
 *
 * 桥接部分只做三件事：把候选**带进来**、把上下文**带出去**、给出生成候选的提示词。
 * 它不做任何「假装已经同步」的事情 —— 没有外部工具回执时，界面话术必须是
 * 「已生成候选」，而不是「已写入统一记忆」（B01 / §4.2）。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zContextExportInput } from '@aicc/core';
import { buildContext, previewContextBudget } from '../../services/context-package.js';
import { listContextExports, getContextExport } from '../../db/repos/system.js';
import { getProject } from '../../db/repos/registry.js';
import { memoryCounters } from '../../services/memory.js';
import { audit } from '../../services/audit.js';
import { toCsv } from '../../imports/guard.js';
import { ApiError } from '../errors.js';
import { principalProjectScope, requirePrincipal, requireScope, requireUser, type HttpDeps } from '../server.js';

/**
 * §7.2 的标准候选记忆提示词。
 *
 * 它作为**产物**返回给用户复制使用，而不是藏在文档里。
 * 提示词里每一句「不要让你自己的建议变成我的偏好」都是在补 LLM 的默认行为。
 */
export const CANDIDATE_PROMPT = `请只基于你当前实际能访问到的对话和资料，生成"待审核的外部记忆包"。

仅提取：明确的长期偏好、项目事实、已确认决策、可复用经验和下一步。
区分"我明确说过/确认过""你的建议""尚未验证的推断"。
不要把你的建议改写成我的偏好，不要补充你无法访问的历史。
尽量保留我的原始措辞，并指出纠正或替代了哪些旧信息。
默认排除健康、财务隐私、联系方式、凭据和与本项目无关的个人信息。
每条给出：scope、project、kind、title、content、source/evidence、待确认项。
没有可靠原文、日期或链接时写 unknown，不要编造。
只输出候选材料；没有外部工具成功回执时，不要声称已经写入或同步。

输出格式（只输出 JSON，不要输出其他文字）：
{
  "schema_version": "1.0",
  "candidates": [
    {
      "operation": "create",
      "scope": "project",
      "project_id": "<项目标识，用我告诉你的原样写法>",
      "kind": "preference | fact | decision | lesson | hypothesis | handoff",
      "title": "短标题",
      "content": "要长期保留的内容",
      "source": {
        "kind": "chatgpt_summary",
        "source_ref": null,
        "evidence_quote": "我的原始措辞，没有就写 null",
        "evidence_status": "user_confirmation_required"
      },
      "sensitivity": "normal",
      "verification": "unverified",
      "review_after": null
    }
  ]
}`;

export function registerContextRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const { app } = deps;
  const ctx = app.ctx;

  /* ---------------- 上下文包 ---------------- */

  fastify.post('/api/context-exports', async (request) => {
    const principal = requireScope(request, 'context_build');
    const input = zContextExportInput.parse(request.body ?? {});
    const scope = principalProjectScope(principal);

    const result = buildContext(ctx, {
      projectId: input.projectId,
      task: input.task ?? null,
      budgetKind: input.budgetKind,
      customBudgetTokens: input.customBudgetTokens ?? null,
      includeGlobalMemory: input.includeGlobalMemory,
      maxSensitivity: input.maxSensitivity,
      requestedProjectIds: input.requestedProjectIds ?? null,
      grantedProjectIds: scope,
      createdBy: principal.kind === 'user' ? 'local-user' : principal.label,
      dryRun: false,
    });

    return {
      exportId: result.exportId,
      manifest: result.package.manifest,
      markdown: result.markdown,
      json: result.json,
      estimatedTokens: result.package.manifest.estimatedTokens,
      requiresUserChoice: result.requiresUserChoice,
      warnings: result.warnings,
      note: result.requiresUserChoice
        ? '固定项合计已超过预算。系统不会自动删除固定项，请先取消部分固定或提高预算后重新生成。'
        : '包的清单记录了每条记忆的 ID 与版本。它可以证明本系统返回了哪些资料，不能证明目标模型一定读了或遵守了它们。',
    };
  });

  fastify.get('/api/context-exports', async (request) => {
    requirePrincipal(request);
    const q = z
      .object({ projectId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query ?? {});
    const exports = listContextExports(app.db, q.projectId, q.limit);
    return {
      exports: exports.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        task: e.task,
        budgetKind: e.budgetKind,
        budgetTokens: e.budgetTokens,
        estimatedTokens: e.estimatedTokens,
        droppedCount: e.droppedCount,
        excludedByPolicy: e.excludedByPolicy,
        createdAt: e.createdAt,
        invalidatedAt: e.invalidatedAt,
        invalidatedReason: e.invalidatedReason,
        itemCount: e.memoryRefs.length,
      })),
      note: '被标记为失效的包说明它引用的记忆已经更新。包本身不会被删除 —— 你手上已经复制出去的副本我们也删不掉。',
    };
  });

  fastify.get('/api/context-exports/:id', async (request) => {
    requirePrincipal(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const record = getContextExport(app.db, id);
    if (!record) throw new ApiError(404, 'not_found', `上下文包不存在：${id}`);
    return {
      export: {
        id: record.id,
        projectId: record.projectId,
        task: record.task,
        budgetKind: record.budgetKind,
        budgetTokens: record.budgetTokens,
        estimatedTokens: record.estimatedTokens,
        tokenCountKind: record.tokenCountKind,
        manifest: record.manifest,
        warnings: record.warnings,
        memoryRefs: record.memoryRefs,
        createdAt: record.createdAt,
        invalidatedAt: record.invalidatedAt,
        invalidatedReason: record.invalidatedReason,
      },
      markdown: record.contentMarkdown,
    };
  });

  fastify.get('/api/context-exports/compare', async (request) => {
    requireUser(request, '比较上下文包');
    const q = z.object({ a: z.string().min(1), b: z.string().min(1) }).parse(request.query ?? {});
    const left = getContextExport(app.db, q.a);
    const right = getContextExport(app.db, q.b);
    if (!left || !right) throw new ApiError(404, 'not_found', '要比较的上下文包不存在');

    const leftMap = new Map(left.memoryRefs.map((r) => [r.memoryId, r.version]));
    const rightMap = new Map(right.memoryRefs.map((r) => [r.memoryId, r.version]));
    const all = new Set([...leftMap.keys(), ...rightMap.keys()]);

    const rows: Array<{ memoryId: string; leftVersion: number | null; rightVersion: number | null; change: string }> = [];
    for (const memoryId of all) {
      const l = leftMap.get(memoryId) ?? null;
      const r = rightMap.get(memoryId) ?? null;
      const change = l === null ? '仅出现在 B' : r === null ? '仅出现在 A' : l === r ? '相同' : `版本不同（v${l} → v${r}）`;
      rows.push({ memoryId, leftVersion: l, rightVersion: r, change });
    }

    // 导出成 CSV，便于核对。以 = + - @ 开头的单元格会被加前导单引号。
    const csv = toCsv(
      ['memory_id', 'left_version', 'right_version', 'change'],
      rows.map((r) => [r.memoryId, r.leftVersion, r.rightVersion, r.change]),
    );

    return { rows, csv, note: '用于核对「同一个项目在不同时间生成的包差了什么」。' };
  });

  /* ---------------- 项目包预览 ---------------- */

  fastify.get('/api/projects/:id/context-preview', async (request) => {
    requirePrincipal(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const project = getProject(app.db, id);
    if (!project) throw new ApiError(404, 'not_found', `项目不存在：${id}`);
    const preview = previewContextBudget(ctx, id);
    return {
      project: { id: project.id, title: project.title, goal: project.goal, handoffSummary: project.handoffSummary },
      ...preview,
      note: '这是「如果把该项目的 active 记忆全部装进去会有多大」，用于在生成前决定预算。',
    };
  });

  /* ---------------- ChatGPT 桥接 ---------------- */

  fastify.get('/api/bridge/prompt', async (request) => {
    requireUser(request);
    return {
      prompt: CANDIDATE_PROMPT,
      usage: [
        '1. 把这段提示词发给 ChatGPT（或其他客户端），让它生成候选记忆包 JSON。',
        '2. 复制它输出的 JSON。',
        '3. 回到本系统「ChatGPT 桥接」页，粘贴并导入。',
        '4. 在「记忆中心 → 候选箱」逐条核对来源与措辞，再决定批准或驳回。',
      ],
      caveat:
        '这条路径不依赖任何新连接，也不使用任何凭据。没有外部工具回执时，本系统只会说「已生成候选」，' +
        '不会说「已同步」——因为它确实没有向 ChatGPT 写入任何东西。',
    };
  });

  fastify.get('/api/bridge/status', async (request) => {
    requirePrincipal(request);
    const counters = memoryCounters(ctx);
    return {
      counters,
      mode: 'paste',
      modes: {
        paste: { available: true, description: '复制候选 JSON 进来，导出上下文包出去。不依赖任何新连接。' },
        remoteMcp: {
          available: false,
          description: '远程 MCP / 应用接入属于后续阶段。需要逐账户、逐客户端实际探测，不能从文档推断。',
        },
      },
      limitations: [
        '手机与电脑之间没有天然共享的 localhost。可在电脑网页端打开同一段聊天后复制，或自行选择传输方式。',
        '上传到 ChatGPT Projects 的文件是一份快照，不会随本地记忆库更新而更新。',
        '本系统不写入、不复制、不双向同步 ChatGPT 的原生 Memory。',
      ],
    };
  });

  /* ---------------- 失效包清单 ---------------- */

  fastify.get('/api/context-exports/invalidated', async (request) => {
    requireUser(request, '查看失效包');
    const all = listContextExports(app.db, undefined, 200);
    const invalidated = all.filter((e) => e.invalidatedAt !== null);
    audit(ctx, {
      action: 'context.export',
      entityType: 'context_export',
      entityId: null,
      detail: { view: 'invalidated_list', count: invalidated.length },
    });
    return {
      invalidated: invalidated.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        createdAt: e.createdAt,
        invalidatedAt: e.invalidatedAt,
        invalidatedReason: e.invalidatedReason,
      })),
      note: '这些包引用的记忆已经被更新过。包内容没有被销毁，但请以记忆当前版本为准。',
    };
  });
}
