/**
 * 用量路由：概览、用量查询、手动录入、重复确认、收费、额度、导入、导出。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  zChargeInput,
  zImportInput,
  zManualUsageInput,
  zQuotaSnapshotInput,
  zUsageQuery,
} from '@aicc/core';
import { getOverview, chargeBuckets } from '../../services/overview.js';
import { importData, queryCharges, queryUsage, recordManualUsage, resolveDuplicateObservation, usageTotals } from '../../services/usage.js';
import { quotaBuckets, quotaHistory, saveQuotaSnapshot } from '../../services/quota.js';
import { getAccount } from '../../db/repos/registry.js';
import { insertCharge } from '../../db/repos/usage.js';
import { getImportJob, listImportJobs } from '../../db/repos/system.js';
import { toCsv } from '../../imports/guard.js';
import { audit } from '../../services/audit.js';
import { ApiError } from '../errors.js';
import { requirePrincipal, requireUser, type HttpDeps } from '../server.js';

export function registerUsageRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const { app } = deps;
  const ctx = app.ctx;

  /* ---------------- 概览 ---------------- */

  fastify.get('/api/overview', async (request) => {
    requirePrincipal(request);
    const overview = getOverview(ctx);
    return {
      ...overview,
      // 概览页的口径声明直接跟着数据一起返回，前端不需要自己编一套文案
      disclaimers: {
        tokens: '这是「已观测 token」，不是「总消耗」。覆盖范围见 coverage 字段。',
        quota: '额度是状态快照，不参与任何求和，也不与账户汇总、请求明细相加。',
        charges: '费用按币种分行展示，不做跨币种相加。',
        demo: 'demo 数据不计入本页任何数字。',
      },
    };
  });

  /* ---------------- 用量明细 ---------------- */

  fastify.get('/api/usage', async (request) => {
    requirePrincipal(request);
    const query = zUsageQuery.parse(request.query ?? {});
    const result = queryUsage(ctx, query);
    return {
      ...result,
      totals: usageTotals(ctx),
      note:
        query.includeNonPrimary === true
          ? '当前查询包含非主统计源（证据行与待确认行）。这些行不计入统计。'
          : '默认只返回主统计源。需要查看证据行与待确认行请显式传 includeNonPrimary=true。',
    };
  });

  fastify.post('/api/usage', async (request) => {
    requireUser(request, '手动录入用量');
    const input = zManualUsageInput.parse(request.body ?? {});
    const observation = recordManualUsage(ctx, {
      kind: input.kind,
      accountId: input.accountId,
      projectId: input.projectId,
      clientId: input.clientId,
      model: input.model ?? null,
      occurredAt: input.occurredAt ?? null,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      providerRequestId: input.providerRequestId ?? null,
      meterKind: input.meterKind,
      rawUsage: input.rawUsage,
      basis: input.basis,
      measurementQuality: input.measurementQuality,
      coverageScope: input.coverageScope ?? null,
      sourceRef: input.sourceRef ?? null,
    });
    return {
      observation,
      note: '手动填入「官方页显示 60%」这类数值时，采集方式是 manual，但数值质量仍可以是 provider_reported。',
    };
  });

  fastify.post('/api/usage/:id/resolve-duplicate', async (request) => {
    requireUser(request, '确认疑似重复');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const body = z
      .object({
        decision: z.enum(['confirmed_unique', 'confirmed_duplicate']),
        note: z.string().max(500).nullable().optional(),
      })
      .parse(request.body ?? {});
    const observation = resolveDuplicateObservation(ctx, id, body.decision);
    return {
      observation,
      note:
        body.decision === 'confirmed_unique'
          ? '已确认这是两次真实发生的请求，该记录现在计入统计。'
          : '已确认为同一请求的重复记录，该记录不计入统计，但仍作为证据保留。',
    };
  });

  /* ---------------- 收费 ---------------- */

  fastify.get('/api/charges', async (request) => {
    requirePrincipal(request);
    const q = z
      .object({ accountId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) })
      .parse(request.query ?? {});
    return {
      charges: queryCharges(ctx, q),
      buckets: chargeBuckets(ctx),
      note: '事件上的费用用于分析，收费流水用于记账。账单与请求明细通过 billingRef 对账，不把两者再算两次。',
    };
  });

  fastify.post('/api/charges', async (request) => {
    requireUser(request, '收费登记');
    const input = zChargeInput.parse(request.body ?? {});

    if (input.accountId && !getAccount(app.db, input.accountId)) {
      throw new ApiError(404, 'not_found', `计费账户不存在：${input.accountId}`);
    }

    const result = insertCharge(app.db, {
      accountId: input.accountId,
      subscriptionId: input.subscriptionId,
      kind: input.kind,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: input.status,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      paidAt: input.paidAt ?? null,
      billingRef: input.billingRef ?? null,
      collectionMethod: input.collectionMethod,
      measurementQuality: 'provider_reported',
      sourceRef: null,
      dedupeKey: `charge\u001fmanual\u001f${input.amountMinor}\u001f${input.currency}\u001f${input.periodStart ?? ''}\u001f${
        input.billingRef ?? ''
      }\u001f${input.kind}`,
      note: input.note ?? null,
    });

    if (result.kind === 'duplicate') {
      return {
        inserted: false,
        existing: result.existing,
        reason: result.reason,
        note: '没有重复记账。',
      };
    }

    audit(ctx, {
      action: 'charge.create',
      entityType: 'charge',
      entityId: result.charge.id,
      detail: { kind: input.kind, currency: input.currency, status: input.status },
    });
    return { inserted: true, charge: result.charge };
  });

  /* ---------------- 额度 ---------------- */

  fastify.get('/api/quota', async (request) => {
    requirePrincipal(request);
    const result = quotaBuckets(ctx);
    return {
      ...result,
      note:
        '小时窗与周窗分别展示，不做跨窗口平均。到达重置时间但没有重新查询的桶会显示「待刷新」，' +
        '系统不会自动按 100% 计算。',
    };
  });

  fastify.post('/api/quota-snapshots', async (request) => {
    requireUser(request, '更新额度快照');
    const input = zQuotaSnapshotInput.parse(request.body ?? {});
    const snapshot = saveQuotaSnapshot(ctx, input);
    return { snapshot, note: '额度快照是状态，不参与任何求和。' };
  });

  fastify.get('/api/quota/history', async (request) => {
    requirePrincipal(request);
    const q = z
      .object({
        accountId: z.string().min(1).max(64),
        bucketId: z.string().min(1).max(120),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query ?? {});
    return { history: quotaHistory(ctx, q.accountId, q.bucketId, q.limit) };
  });

  /* ---------------- 导入 ---------------- */

  fastify.get('/api/imports', async (request) => {
    requirePrincipal(request);
    return {
      jobs: listImportJobs(app.db, 50),
      supportedKinds: ['usage_csv', 'usage_json', 'charge_csv'],
      limits: { maxBytes: app.config.maxImportBytes, maxRows: app.config.maxImportRows },
      note: '记忆候选 JSON 请走 /api/memory-proposals/import。',
    };
  });

  fastify.get('/api/imports/:id', async (request) => {
    requirePrincipal(request);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const job = getImportJob(app.db, id);
    if (!job) throw new ApiError(404, 'not_found', `导入批次不存在：${id}`);
    return { job };
  });

  fastify.post('/api/imports', async (request) => {
    requireUser(request, '导入数据');
    const input = zImportInput.parse(request.body ?? {});
    const outcome = importData(ctx, {
      kind: input.kind,
      fileName: input.fileName,
      content: input.content,
      accountId: input.accountId,
      projectId: input.projectId,
      clientId: input.clientId,
      collectionMethod: input.collectionMethod,
      measurementQuality: input.measurementQuality,
      coverageScope: input.coverageScope ?? null,
      dryRun: input.dryRun,
    });
    return {
      ...outcome,
      note: outcome.dryRun
        ? '本次为预检，没有写入任何数据。确认无误后再以 dryRun=false 正式导入。'
        : '导入完成。重复导入同一个文件不会让 token 或金额翻倍。',
    };
  });

  /* ---------------- 导出（防公式注入） ---------------- */

  fastify.get('/api/exports/usage.csv', async (request, reply) => {
    requireUser(request, '导出数据');
    const query = zUsageQuery.parse(request.query ?? {});
    const result = queryUsage(ctx, { ...query, limit: 500, offset: 0, includeNonPrimary: true });

    const csv = toCsv(
      [
        'observation_id',
        'kind',
        'collection_method',
        'measurement_quality',
        'occurred_at',
        'model',
        'input_total',
        'output_total',
        'cached_input',
        'reasoning_output',
        'total_reported',
        'is_primary',
        'duplicate_status',
        'normalization_basis',
        'coverage_scope',
      ],
      result.items.map((o) => [
        o.id,
        o.kind,
        o.collectionMethod,
        o.measurementQuality,
        o.occurredAt,
        o.model,
        o.inputTotal,
        o.outputTotal,
        o.cachedInput,
        o.reasoningOutput,
        o.totalReported,
        o.isPrimary ? 1 : 0,
        o.duplicateStatus,
        o.normalizationBasis,
        o.coverageScope,
      ]),
    );

    audit(ctx, {
      action: 'import.complete',
      entityType: 'usage_export',
      entityId: 'usage.csv',
      detail: { rows: result.items.length },
    });

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="usage-export.csv"');
    // 以 = + - @ 开头的单元格已被加上前导单引号，避免在 Excel / WPS 里被当公式执行
    return `\uFEFF${csv}`;
  });
}
