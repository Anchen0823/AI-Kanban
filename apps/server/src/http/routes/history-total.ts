/** 全部 AI 历史 token 总览路由。 */

import type { FastifyInstance } from 'fastify';
import { historyTotal } from '../../services/history-total.js';
import { requireUser, workspaceOf, type HttpDeps } from '../server.js';

export function registerHistoryTotalRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  fastify.get('/api/history/total', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    requireUser(request, '查看全部 AI 历史总用量');
    return historyTotal(deps.app.ctx, workspaceOf(request));
  });
}
