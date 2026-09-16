/**
 * 代理接口（设计稿 §11.2 的服务端实现）。
 *
 * **这不是 MCP。** MCP 的 stdio 传输层属于 M1，本文件只把 §11.2 约定的工具
 * 以一比一的形状实现成 HTTP 接口，用来把权限边界先定下来并接受测试：
 *
 * - 身份只来自 Bearer 凭据，绝不来自参数里的 `client_id`。
 * - `project_id` 只是「申请范围」，服务端必须核对凭据是否被授权。
 * - 审批、删除、连接管理在这里**根本无法表达** —— 没有对应接口，
 *   而且即使有，`requireUser` 也会拦掉凭据身份。
 *
 * 这样 M1 接 MCP 时，只需要在传输层做一次转发，权限语义不需要重新设计。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zMemoryProposalInput, MEMORY_KINDS } from '@aicc/core';
import {
  createProposal,
  getMemoryDetail,
  searchMemories,
} from '../../services/memory.js';
import { buildContext } from '../../services/context-package.js';
import { createSession, listProjects } from '../../db/repos/registry.js';
import { listIntegrations } from '../../db/repos/system.js';
import { SCHEMA_VERSION } from '../../db/database.js';
import { audit } from '../../services/audit.js';
import { ApiError } from '../errors.js';
import { principalProjectScope, requireScope, type HttpDeps } from '../server.js';

const zMemorySearch = z.object({
  query: z.string().max(200).default(''),
  project_id: z.string().max(64).nullable().default(null),
  kind: z.enum(MEMORY_KINDS).nullable().default(null),
  limit: z.number().int().min(1).max(50).default(10),
});

const zMemoryGet = z.object({ memory_id: z.string().min(1).max(64) });

const zContextBuild = z.object({
  project_id: z.string().min(1).max(64),
  task: z.string().max(2000).nullable().default(null),
  budget: z.enum(['short', 'standard']).default('short'),
});

const zSessionPropose = z.object({
  project_id: z.string().min(1).max(64),
  summary: z.string().min(1).max(20000),
  decisions: z.array(z.string().max(2000)).max(50).default([]),
  next_steps: z.array(z.string().max(2000)).max(50).default([]),
  sources: z.array(z.string().max(500)).max(20).default([]),
});

export function registerAgentRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const { app } = deps;
  const ctx = app.ctx;

  /**
   * 凭据请求必须显式声明项目，且必须在授权范围内。
   *
   * 越权**必须留痕**：§11.2 要求「两种路径均被拒绝，日志有拒绝记录」。
   * 只在响应里返回 403 而不写审计，等于事后再也说不清「是谁试过读什么」。
   */
  function assertProjectAllowed(
    principal: { kind: string; label: string; credentialId?: string },
    principalProjectIds: string[] | null,
    projectId: string | null,
    tool: string,
  ): void {
    if (principalProjectIds === null) return;

    const deny = (reason: string, message: string): never => {
      audit(ctx, {
        action: 'auth.reject',
        entityType: 'api_credential',
        entityId: principal.credentialId ?? null,
        result: 'rejected',
        detail: { reason, tool, requestedProject: projectId, granted: principalProjectIds },
        actor: principal.label,
        actorKind: 'agent',
      });
      throw new ApiError(403, 'forbidden', message);
    };

    if (projectId === null) {
      deny(
        'project_required',
        '当前凭据被限定了项目范围，必须显式指定 project_id。服务端不会替你猜一个。',
      );
    }
    if (!principalProjectIds.includes(projectId as string)) {
      deny(
        'project_scope_violation',
        `当前凭据未被授权访问项目 ${projectId}（授权范围：${principalProjectIds.join('、') || '无'}）`,
      );
    }
  }

  fastify.post('/api/agent/memory_search', async (request) => {
    const principal = requireScope(request, 'memory_search');
    const input = zMemorySearch.parse(request.body ?? {});
    const scope = principalProjectScope(principal);
    assertProjectAllowed(principal, scope, input.project_id, 'memory_search');

    const result = searchMemories(ctx, {
      projectId: input.project_id ?? undefined,
      kind: input.kind ?? undefined,
      q: input.query.length > 0 ? input.query : undefined,
      limit: input.limit,
    });

    const items = result.items
      .filter((m) => scope === null || m.projectId === null || scope.includes(m.projectId))
      .map((m) => ({
        memory_id: m.id,
        version: m.version,
        kind: m.kind,
        scope: m.scope,
        project_id: m.projectId,
        title: m.title,
        content: m.content,
        verification: m.verification,
        updated_at: m.updatedAt,
      }));

    audit(ctx, {
      action: 'auth.login',
      entityType: 'api_credential',
      entityId: principal.kind === 'credential' ? principal.credentialId : null,
      detail: { tool: 'memory_search', hits: items.length, projectId: input.project_id },
      actorKind: 'agent',
      actor: principal.label,
    });

    return {
      items,
      count: items.length,
      coverage: '仅返回 active 记忆。过期与已替代内容不会出现在这里。',
      caution: '这些内容可能会作为模型上下文被发送到你所连接的 AI 客户端及其模型服务。',
    };
  });

  fastify.post('/api/agent/memory_get', async (request) => {
    const principal = requireScope(request, 'memory_get');
    const input = zMemoryGet.parse(request.body ?? {});
    const scope = principalProjectScope(principal);

    const detail = getMemoryDetail(ctx, input.memory_id);
    if (!detail) throw new ApiError(404, 'not_found', `记忆不存在：${input.memory_id}`);
    assertProjectAllowed(principal, scope, detail.memory.projectId, 'memory_get');

    return {
      memory_id: detail.memory.id,
      version: detail.memory.version,
      kind: detail.memory.kind,
      scope: detail.memory.scope,
      project_id: detail.memory.projectId,
      title: detail.memory.title,
      content: detail.memory.content,
      verification: detail.memory.verification,
      status: detail.memory.status,
      updated_at: detail.memory.updatedAt,
      revision_count: detail.revisions.length,
      caution: '读取到的是本系统内的权威记录，但普通上下文不能强制覆盖其他平台的系统规则或原生记忆。',
    };
  });

  fastify.post('/api/agent/context_build', async (request) => {
    const principal = requireScope(request, 'context_build');
    const input = zContextBuild.parse(request.body ?? {});
    const scope = principalProjectScope(principal);
    assertProjectAllowed(principal, scope, input.project_id, 'memory_search');

    const result = buildContext(ctx, {
      projectId: input.project_id,
      task: input.task,
      budgetKind: input.budget,
      includeGlobalMemory: false,
      maxSensitivity: 'normal',
      grantedProjectIds: scope,
      createdBy: principal.label,
    });

    return {
      export_id: result.exportId,
      manifest: result.package.manifest,
      markdown: result.markdown,
      estimated_tokens: result.package.manifest.estimatedTokens,
      token_count_kind: 'estimated',
      requires_user_choice: result.requiresUserChoice,
      warnings: result.warnings,
    };
  });

  fastify.post('/api/agent/memory_propose', async (request) => {
    const principal = requireScope(request, 'memory_propose');
    const input = zMemoryProposalInput.parse(request.body ?? {});
    const scope = principalProjectScope(principal);
    assertProjectAllowed(principal, scope, input.projectId, 'memory_propose');

    // 身份来自凭据，不来自请求体里的 submittedByClientId。
    // 如果模型自报的 client_id 与凭据不一致，以凭据为准并记录下来。
    const claimed = input.submittedByClientId;
    const actualClientId = principal.kind === 'credential' ? principal.clientId : claimed;

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
      submittedByClientId: actualClientId,
    });

    if (claimed && actualClientId && claimed !== actualClientId) {
      audit(ctx, {
        action: 'auth.reject',
        entityType: 'memory_proposal',
        entityId: result.proposal.id,
        result: 'rejected',
        detail: { reason: 'client_id_mismatch', claimed, actual: actualClientId },
        actorKind: 'agent',
        actor: principal.label,
      });
    }

    return {
      proposal_id: result.proposal.id,
      status: 'candidate',
      review_status: result.proposal.status,
      warnings: result.warnings,
      tombstone_hit: result.tombstoneHit,
      note:
        '已提交候选。只有人工批准后才会生成 memory_id / version。' +
        '在没有收到人工审批回执之前，不要向用户声称这条记忆已经写入。',
    };
  });

  fastify.post('/api/agent/session_propose', async (request) => {
    const principal = requireScope(request, 'session_propose');
    const input = zSessionPropose.parse(request.body ?? {});
    const scope = principalProjectScope(principal);
    assertProjectAllowed(principal, scope, input.project_id, 'memory_search');

    const summaryText = [
      input.summary,
      input.decisions.length > 0 ? `\n已确认的决策：\n${input.decisions.map((d) => `- ${d}`).join('\n')}` : '',
      input.next_steps.length > 0 ? `\n下一步：\n${input.next_steps.map((d) => `- ${d}`).join('\n')}` : '',
      input.sources.length > 0 ? `\n来源：\n${input.sources.map((d) => `- ${d}`).join('\n')}` : '',
    ]
      .filter((s) => s.trim().length > 0)
      .join('\n');

    const session = createSession(app.db, {
      projectId: input.project_id,
      clientId: principal.kind === 'credential' ? principal.clientId : null,
      summary: summaryText,
      sourceSessionId: null,
    });

    audit(ctx, {
      action: 'session.create',
      entityType: 'session',
      entityId: session.id,
      detail: { projectId: input.project_id, source: 'agent', decisionCount: input.decisions.length },
      actorKind: 'agent',
      actor: principal.label,
    });

    return {
      session_id: session.id,
      status: 'recorded',
      note:
        '会话摘要默认只是临时项目材料，不会自动成为长期记忆。' +
        '只有你明确认可的内容，才应该另建候选并经过批准进入正式库。',
    };
  });

  fastify.get('/api/agent/integration_status', async (request) => {
    const principal = requireScope(request, 'integration_status');
    const scope = principalProjectScope(principal);
    return {
      schema_version: SCHEMA_VERSION,
      principal: {
        kind: principal.kind,
        label: principal.label,
        project_scope: scope,
        scopes: principal.kind === 'credential' ? principal.scopes : 'user-session',
      },
      integrations: listIntegrations(app.db).map((i) => ({
        id: i.id,
        name: i.name,
        category: i.category,
        capability_status: i.capabilityStatus,
        verified_at: i.verifiedAt,
        last_success_at: i.lastSuccessAt,
      })),
      projects: listProjects(app.db)
        .filter((p) => scope === null || scope.includes(p.id))
        .map((p) => ({ id: p.id, title: p.title, status: p.status })),
      mcp_transport_available: true,
      mcp_transport: {
        /** 传输方式与入口，便于客户端自检时核对。 */
        transport: 'stdio',
        package: '@aicc/mcp',
        tool_count: 6,
      },
      note:
        'MCP 传输层（stdio）已在 M1 实现：在客户端里把 @aicc/mcp 作为命令启动，' +
        '用环境变量 AICC_API_URL / AICC_TOKEN 指向本服务与一份代理凭据即可。' +
        'capability_status 为 documented 只表示「官方文档说支持」，不等于本机已验证。',
    };
  });
}
