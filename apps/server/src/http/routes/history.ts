/** 本机 Codex 历史 token 汇总接口。 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { HttpDeps } from '../server.js';
import { requireUser, workspaceOf } from '../server.js';
import { getCodexHistory, runCodexHistory } from '../../services/codex-history.js';
import { getWorkbuddyHistory, runWorkbuddyHistory } from '../../services/workbuddy-history.js';

export function registerCodexHistoryRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  for (const method of ['GET', 'POST'] as const) {
    fastify.route({ method, url: '/api/history/workbuddy', handler: async (request, reply) => {
      requireUser(request, 'WorkBuddy 本机历史');
      reply.header('Cache-Control', 'no-store');
      if (workspaceOf(request) !== 'real') throw new ApiError(403, 'forbidden', 'WorkBuddy 本机历史只在真实工作区可查看或扫描。');
      return method === 'GET' ? getWorkbuddyHistory(deps.app.ctx) : runWorkbuddyHistory(deps.app.ctx);
    } });
  }
  const realWorkspaceOnly = (request: FastifyRequest): void => {
    if (workspaceOf(request) !== 'real') {
      throw new ApiError(403, 'forbidden', 'Codex 本机历史只在真实工作区可查看或扫描。');
    }
  };

  fastify.get('/api/history/codex', async (request, reply) => {
    requireUser(request, '查看 Codex 本机历史');
    reply.header('Cache-Control', 'no-store');
    realWorkspaceOnly(request);
    return getCodexHistory(deps.app.ctx);
  });

  fastify.post('/api/history/codex', async (request, reply) => {
    requireUser(request, '扫描 Codex 本机历史');
    reply.header('Cache-Control', 'no-store');
    realWorkspaceOnly(request);
    return runCodexHistory(deps.app.ctx);
  });
}
