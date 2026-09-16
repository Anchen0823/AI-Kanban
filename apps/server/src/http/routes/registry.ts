/**
 * 登记路由：客户端、计费账户、订阅、项目、会话。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  zCreateAccount,
  zCreateClient,
  zCreateProject,
  zCreateSession,
  zCreateSubscription,
  zUpdateProject,
} from '@aicc/core';
import {
  createAccount,
  createClient,
  createProject,
  createSession,
  createSubscription,
  getProject,
  listAccounts,
  listClients,
  listProjects,
  listSessions,
  listSubscriptions,
  updateProject,
} from '../../db/repos/registry.js';
import { audit } from '../../services/audit.js';
import { ApiError } from '../errors.js';
import { requirePrincipal, requireUser, type HttpDeps } from '../server.js';

export function registerRegistryRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const { app } = deps;
  const ctx = app.ctx;

  /* ---------------- 客户端 ---------------- */

  fastify.get('/api/clients', async (request) => {
    requirePrincipal(request);
    return { clients: listClients(app.db) };
  });

  fastify.post('/api/clients', async (request) => {
    requireUser(request, '客户端登记');
    const input = zCreateClient.parse(request.body ?? {});
    const client = createClient(app.db, {
      kind: input.kind,
      displayName: input.displayName,
      clientVersion: input.clientVersion ?? null,
      mcpProfile: input.mcpProfile ?? null,
      allowedProjects: input.allowedProjects ?? null,
    });
    audit(ctx, {
      action: 'client.create',
      entityType: 'client',
      entityId: client.id,
      detail: { kind: client.kind, displayName: client.displayName, allowedProjects: client.allowedProjects },
    });
    return { client };
  });

  /* ---------------- 计费账户 ---------------- */

  fastify.get('/api/accounts', async (request) => {
    requirePrincipal(request);
    return {
      accounts: listAccounts(app.db),
      note: '本表不保存任何第三方登录 Cookie 或会话令牌，只有你自己填的账户别名。',
    };
  });

  fastify.post('/api/accounts', async (request) => {
    requireUser(request, '账户登记');
    const input = zCreateAccount.parse(request.body ?? {});
    const account = createAccount(app.db, {
      provider: input.provider,
      alias: input.alias,
      accountRef: input.accountRef ?? null,
      currency: input.currency,
    });
    audit(ctx, {
      action: 'account.create',
      entityType: 'billing_account',
      entityId: account.id,
      detail: { provider: account.provider, currency: account.currency },
    });
    return { account };
  });

  /* ---------------- 订阅 ---------------- */

  fastify.get('/api/subscriptions', async (request) => {
    requirePrincipal(request);
    return {
      subscriptions: listSubscriptions(app.db),
      note: '订阅与客户端是多对多。一个订阅覆盖多个入口时，固定月费只登记一次。',
    };
  });

  fastify.post('/api/subscriptions', async (request) => {
    requireUser(request, '订阅登记');
    const input = zCreateSubscription.parse(request.body ?? {});
    const subscription = createSubscription(app.db, {
      name: input.name,
      accountId: input.accountId ?? null,
      plan: input.plan ?? null,
      priceMinor: input.priceMinor,
      currency: input.currency,
      billingCycle: input.billingCycle,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      renewAt: input.renewAt ?? null,
      status: input.status,
      clientIds: input.clientIds,
    });
    audit(ctx, {
      action: 'subscription.create',
      entityType: 'subscription',
      entityId: subscription.id,
      detail: {
        name: subscription.name,
        priceMinor: subscription.priceMinor,
        currency: subscription.currency,
        clientCount: subscription.clientIds.length,
      },
    });
    return { subscription };
  });

  /* ---------------- 项目 ---------------- */

  fastify.get('/api/projects', async (request) => {
    requirePrincipal(request);
    return { projects: listProjects(app.db) };
  });

  fastify.post('/api/projects', async (request) => {
    requireUser(request, '项目登记');
    const input = zCreateProject.parse(request.body ?? {});
    const project = createProject(app.db, {
      title: input.title,
      goal: input.goal ?? null,
      status: input.status,
      handoffSummary: input.handoffSummary ?? null,
      repoAlias: input.repoAlias ?? null,
    });
    audit(ctx, {
      action: 'project.create',
      entityType: 'project',
      entityId: project.id,
      detail: { title: project.title, status: project.status },
    });
    return { project };
  });

  fastify.patch('/api/projects/:id', async (request) => {
    requireUser(request, '项目编辑');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const patch = zUpdateProject.parse(request.body ?? {});
    if (!getProject(app.db, id)) throw new ApiError(404, 'not_found', `项目不存在：${id}`);
    const project = updateProject(app.db, id, patch);
    audit(ctx, {
      action: 'project.update',
      entityType: 'project',
      entityId: id,
      detail: { changed: Object.keys(patch) },
    });
    return { project };
  });

  /* ---------------- 会话 ---------------- */

  fastify.get('/api/sessions', async (request) => {
    requirePrincipal(request);
    const q = z.object({ projectId: z.string().max(64).optional() }).parse(request.query ?? {});
    return {
      sessions: listSessions(app.db, q.projectId),
      note: '这里只保存来源会话 ID 与摘要，不保存任何平台的聊天全文。',
    };
  });

  fastify.post('/api/sessions', async (request) => {
    requireUser(request, '会话摘要登记');
    const input = zCreateSession.parse(request.body ?? {});
    const session = createSession(app.db, {
      projectId: input.projectId,
      clientId: input.clientId,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      summary: input.summary ?? null,
    });
    audit(ctx, {
      action: 'session.create',
      entityType: 'session',
      entityId: session.id,
      detail: { projectId: session.projectId, clientId: session.clientId, hasSummary: Boolean(session.summary) },
    });
    return {
      session,
      note: '会话摘要默认只是临时项目材料。只有你明确认可的内容才应提升为长期记忆（需要另建候选并批准）。',
    };
  });
}
