/**
 * 统一错误结构（§11.1「错误结构统一」）。
 *
 * 前端只需要认一种错误形状：`{ error: { code, message, details?, requestId? } }`。
 * 业务层抛 `TxAbort`，这里翻译成 HTTP 状态码 —— 映射表集中在一处，
 * 避免每个路由自己决定「这个错该返回 400 还是 409」。
 */

import { TxAbort } from '../db/database.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 业务错误码 → HTTP 状态码。
 *
 * 409 专门给「冲突」类：版本冲突、状态不允许、墓碑命中。
 * 这些情况必须让调用方知道「不是你参数写错了，是当前状态变了」。
 */
const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  bad_pairing_code: 401,
  forbidden: 403,
  origin_rejected: 403,
  not_found: 404,
  method_not_allowed: 405,
  version_conflict: 409,
  base_version_required: 409,
  base_version_mismatch: 409,
  target_exists: 409,
  invalid_state: 409,
  duplicate_entry: 409,
  tombstone_hit: 409,
  already_exists: 409,
  target_missing: 404,
  import_rejected: 422,
  import_too_many_rows: 422,
  wrong_endpoint: 400,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};

export function statusForCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof TxAbort) {
    return new ApiError(statusForCode(err.code), err.code, err.message, err.detail);
  }
  if (err && typeof err === 'object' && 'issues' in err) {
    // zod 校验错误
    const issues = (err as { issues: unknown }).issues;
    return new ApiError(400, 'invalid_input', '请求参数校验未通过', issues);
  }

  // Fastify 自己的错误（请求体解析失败、body 超限等）自带 statusCode。
  // 不认它的话，「JSON 语法错误」会被报成 500 内部错误，把调用方引向错误的方向。
  if (err && typeof err === 'object') {
    const candidate = err as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown };
    const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : candidate.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = typeof candidate.code === 'string' && candidate.code.length > 0 ? candidate.code : 'invalid_input';
      const message = typeof candidate.message === 'string' ? candidate.message : '请求无法处理';
      return new ApiError(status, code, message);
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(500, 'internal', message);
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export function errorBody(error: ApiError, requestId?: string): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}
