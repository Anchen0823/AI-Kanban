/** 已导入历史用量汇总路由。 */

import type { FastifyInstance } from 'fastify';
import { importedHistory } from '../../services/history-imported.js';
import { requireUser, workspaceOf, type HttpDeps } from '../server.js';

export function registerHistoryImportedRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  fastify.get('/api/history/imported', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    requireUser(request, '查看已导入历史用量');
    return importedHistory(deps.app.ctx, workspaceOf(request));
  });
}
