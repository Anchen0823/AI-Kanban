import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LOCAL_HISTORY_SOURCES } from '@aicc/core';
import { requireUser, workspaceOf, type HttpDeps } from '../server.js';
import { explorerSessions, explorerWorkspaces, explorerAnalytics, explorerSessionDetail, explorerWorkspaceDetail } from '../../services/history-explorer.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const ms = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}, '日期无效');
const filterSchema = z.object({
  source: z.enum(LOCAL_HISTORY_SOURCES).optional(), workspaceId: z.string().regex(/^(?:[a-f0-9]{64}|unassigned)$/).optional(),
  model: z.string().min(1).max(160).optional(), from: day.optional(), to: day.optional(), q: z.string().max(200).optional(),
  sessionId: z.string().regex(/^[a-f0-9]{64}$/).optional(), page: z.coerce.number().int().min(1).max(1000000).optional(),
  sort: z.enum(['recent', 'tokens', 'name']).optional(), direction: z.enum(['asc', 'desc']).optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(), split: z.enum(['source', 'model']).optional(),
}).refine(v => !v.from || !v.to || v.from <= v.to, '开始日期不能晚于结束日期');
export function registerHistoryExplorerRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  for (const route of ['sessions', 'workspaces', 'analytics', 'sessions/:id', 'workspaces/:id']) {
    fastify.get(`/api/history/${route}`, async (request, reply) => {
      reply.header('cache-control', 'no-store'); requireUser(request, '查看本机用量明细');
      const scope = workspaceOf(request), filter = filterSchema.parse(request.query), ctx = deps.app.ctx;
      if (route.includes(':id')) {
        const { id } = z.object({ id: z.string().regex(/^(?:[a-f0-9]{64}|unassigned)$/) }).parse(request.params);
        return route.startsWith('sessions') ? explorerSessionDetail(ctx, scope, filter, id) : explorerWorkspaceDetail(ctx, scope, filter, id);
      }
      return route === 'sessions' ? explorerSessions(ctx, scope, filter) : route === 'workspaces' ? explorerWorkspaces(ctx, scope, filter) : explorerAnalytics(ctx, scope, filter);
    });
  }
}
