/** 本机 Codex 只读额度检测。 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HttpDeps } from '../server.js';
import { ApiError } from '../errors.js';
import { requireUser, workspaceOf } from '../server.js';
import { getCodexDetection, runCodexDetection } from '../../services/codex-detection.js';

export function registerDetectionRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const realWorkspaceOnly = (request: FastifyRequest): void => {
    if (workspaceOf(request) !== 'real') {
      throw new ApiError(403, 'forbidden', 'Codex 本机额度只在真实工作区可查看或刷新。');
    }
  };

  fastify.get('/api/detection/codex', async (request, reply) => {
    requireUser(request, '查看 Codex 额度检测');
    reply.header('Cache-Control', 'no-store');
    realWorkspaceOnly(request);
    return getCodexDetection(deps.app.ctx);
  });

  fastify.post('/api/detection/codex', async (request, reply) => {
    requireUser(request, '执行 Codex 额度检测');
    reply.header('Cache-Control', 'no-store');
    realWorkspaceOnly(request);
    return runCodexDetection(deps.app.ctx);
  });
}
