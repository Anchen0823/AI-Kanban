/**
 * 审计写入。
 *
 * 与业务写入同事务（§9.2）：审计在事务里跟着一起提交或一起回滚，
 * 不会出现「操作成功了但审计没记」的情况。
 *
 * 另外刻意限制 detail 的内容：只放 ID、计数、结论。敏感全文不复制一份到审计里，
 * 否则「删除记忆」反而在多一张表里留下了正文（§14.1）。
 */

import { appendAudit, listAudit } from '../db/repos/system.js';
import type { ServiceContext } from '../service-context.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  version?: number | null;
  result?: 'ok' | 'rejected' | 'failed' | 'conflict';
  detail?: Record<string, unknown>;
  actor?: string;
  actorKind?: 'user' | 'agent' | 'system';
  requestId?: string | null;
  isDemo?: boolean;
}

export function audit(ctx: ServiceContext, input: AuditInput): void {
  appendAudit(ctx.db, {
    actor: input.actor ?? ctx.actor,
    actorKind: input.actorKind ?? 'user',
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    version: input.version ?? null,
    result: input.result ?? 'ok',
    detail: input.detail ?? {},
    requestId: input.requestId ?? null,
    isDemo: input.isDemo,
  });
}

export function readAudit(ctx: ServiceContext, options: { limit?: number; action?: string } = {}) {
  return listAudit(ctx.db, options);
}
