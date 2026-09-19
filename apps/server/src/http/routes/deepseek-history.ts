/** DeepSeek 控制台导出历史路由。 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDeepseekHistory, runDeepseekHistory } from '../../services/deepseek-history.js';
import { ApiError } from '../errors.js';
import { requireUser, workspaceOf, type HttpDeps } from '../server.js';

const zScan = z.object({ directory: z.string().trim().min(1).max(4096) }).strict();

export function registerDeepseekHistoryRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  fastify.get('/api/history/deepseek', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    requireUser(request, '查看 DeepSeek 导出历史');
    if (workspaceOf(request) === 'demo') {
      throw new ApiError(400, 'invalid_workspace', 'DeepSeek 真实历史不能在示例工作区读取');
    }
    return getDeepseekHistory(deps.app.ctx);
  });

  fastify.post('/api/history/deepseek', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    requireUser(request, '扫描 DeepSeek 导出历史');
    if (workspaceOf(request) === 'demo') {
      throw new ApiError(400, 'invalid_workspace', 'DeepSeek 真实历史不能在示例工作区扫描');
    }
    return runDeepseekHistory(deps.app.ctx, zScan.parse(request.body ?? {}));
  });
}
