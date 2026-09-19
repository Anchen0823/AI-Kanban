/** DeepSeek 官方余额检测路由。 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpDeps } from '../server.js';
import { ApiError } from '../errors.js';
import { requireUser, workspaceOf } from '../server.js';
import {
  getDeepseekDetection,
  runDeepseekDetection,
  type DeepseekDetectionOptions,
} from '../../services/deepseek-detection.js';

const zRequest = z.object({ apiKey: z.string().max(512).optional() }).strict();

export function registerDeepseekDetectionRoutes(
  fastify: FastifyInstance,
  deps: HttpDeps,
  options: Omit<DeepseekDetectionOptions, 'apiKey'> = {},
): void {
  fastify.get('/api/detection/deepseek', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    requireUser(request, '查看 DeepSeek 余额检测');
    if (workspaceOf(request) === 'demo') {
      throw new ApiError(400, 'invalid_workspace', 'DeepSeek 真实余额不能在示例工作区读取');
    }
    return getDeepseekDetection(deps.app.ctx, options);
  });

  fastify.post('/api/detection/deepseek', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    requireUser(request, '执行 DeepSeek 余额检测');
    if (workspaceOf(request) === 'demo') {
      throw new ApiError(400, 'invalid_workspace', 'DeepSeek 真实余额不能在示例工作区检测');
    }
    const input = zRequest.parse(request.body ?? {});
    return runDeepseekDetection(deps.app.ctx, { ...options, apiKey: input.apiKey });
  });
}
