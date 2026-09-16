/**
 * 概览服务。
 *
 * §4.1 的核心要求：首页必须把「实际已支付」「尚未结算的已报告费用」「估算费用」
 * 「已观测 token」「额度窗口」**分开**展示，不能只放一个看起来精确的「总消耗」。
 *
 * 所以这里的返回结构本身就是一组互不相加的桶，而不是一个合并后的数字。
 * 想让前端「不小心把它们加起来」都做不到。
 */

import { sumByCurrency, type Money, type QuotaFreshness } from '@aicc/core';
import { countedObservations, listCharges, countSuspectDuplicates, type Charge } from '../db/repos/usage.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';
import { listIntegrations, listAudit, listImportJobs } from '../db/repos/system.js';
import { workspaceLabel } from '../db/repos/workspace.js';
import { listProjects, listAccounts, listSubscriptions, listClients } from '../db/repos/registry.js';
import { memoryCounters } from './memory.js';
import { quotaBuckets } from './quota.js';
import { usageTotals } from './usage.js';
import type { ServiceContext } from '../service-context.js';

export interface MoneyBucket {
  currency: string;
  amountMinor: string;
  count: number;
}

export interface OverviewChargeBuckets {
  /** 实际已支付。 */
  paid: MoneyBucket[];
  /** 已报告但尚未结算。 */
  pending: MoneyBucket[];
  /** 退款（负向）。 */
  refunded: MoneyBucket[];
  /** 用户标注为「估算」的费用，与实际支出隔离展示（§5.3 / §5.4）。 */
  estimated: MoneyBucket[];
  /** 口径说明，界面直接显示。 */
  notes: string[];
}

function toMoney(charge: Charge): Money {
  return { amountMinor: charge.amountMinor, currency: charge.currency };
}

export function chargeBuckets(ctx: ServiceContext, workspace: WorkspaceScope = 'real'): OverviewChargeBuckets {
  const charges = listCharges(ctx.db, { workspace, limit: 500 });

  const paid = charges.filter((c) => c.status === 'paid' && c.measurementQuality !== 'estimated');
  const pending = charges.filter((c) => c.status === 'pending');
  const refunded = charges.filter((c) => c.status === 'refunded' || c.kind === 'refund');
  const estimated = charges.filter((c) => c.measurementQuality === 'estimated' && c.status !== 'refunded');

  return {
    paid: sumByCurrency(paid.map(toMoney)),
    pending: sumByCurrency(pending.map(toMoney)),
    refunded: sumByCurrency(refunded.map(toMoney)),
    estimated: sumByCurrency(estimated.map(toMoney)),
    notes: [
      '固定订阅费按实际付款记录，只记一次；订阅覆盖多个客户端时不会重复计入（U06）。',
      '不同币种不相加。要合并查看必须先按记录汇率换算，并保留汇率来源。',
      '「估算费用」与「实际支出」永远分开展示，不会并进同一个数字。',
    ],
  };
}

export interface Overview {
  generatedAt: string;
  driver: string;
  dataDir: string;
  /** 本次概览的数据来自哪个工作区。 */
  workspace: string;
  counts: {
    projects: number;
    clients: number;
    accounts: number;
    subscriptions: number;
    observations: number;
    charges: number;
    imports: number;
  };
  tokens: {
    observed: number | null;
    partial: boolean;
    coverage: string;
    byModel: Array<{ model: string | null; value: number | null; count: number }>;
  };
  charges: OverviewChargeBuckets;
  quota: {
    groups: Array<{ windowKind: string; windowLabel: string; buckets: unknown[] }>;
    needsAttention: number;
    states: Array<{ state: QuotaFreshness; label: string; count: number }>;
  };
  memory: {
    pendingProposals: number;
    active: number;
    archived: number;
    expired: number;
    superseded: number;
    tombstones: number;
  };
  usage: {
    /** 缺少稳定请求 ID、内容重复但未确认的记录数。必须显示出来，不能悄悄藏着。 */
    suspectDuplicates: number;
    byCollectionMethod: Array<{ method: string; count: number }>;
    byQuality: Array<{ quality: string; count: number }>;
  };
  integrations: Array<{
    id: string;
    name: string;
    category: string;
    capabilityStatus: string;
    verifiedAt: string | null;
    lastSuccessAt: string | null;
    notes: string | null;
  }>;
  attention: Array<{ level: 'info' | 'warn'; text: string; hint?: string }>;
  recentAudit: Array<{ at: string; action: string; entityType: string; entityId: string | null; result: string }>;
  recentImports: Array<{
    id: string;
    fileName: string;
    kind: string;
    status: string;
    acceptedRows: number;
    replayedRows: number;
    suspectRows: number;
    rejectedRows: number;
    startedAt: string;
  }>;
}

export function getOverview(ctx: ServiceContext, workspace: WorkspaceScope = 'real'): Overview {
  const observations = countedObservations(ctx.db, workspace);
  const charges = listCharges(ctx.db, { workspace, limit: 500 });
  const quota = quotaBuckets(ctx, workspace);
  const integrations = listIntegrations(ctx.db, workspace);
  const totals = usageTotals(ctx, workspace);

  const byMethod = new Map<string, number>();
  const byQuality = new Map<string, number>();
  for (const o of observations) {
    byMethod.set(o.collectionMethod, (byMethod.get(o.collectionMethod) ?? 0) + 1);
    byQuality.set(o.measurementQuality, (byQuality.get(o.measurementQuality) ?? 0) + 1);
  }

  const stateCounts = new Map<QuotaFreshness, { label: string; count: number }>();
  for (const group of quota.groups) {
    for (const bucket of group.buckets) {
      const entry = stateCounts.get(bucket.freshness) ?? { label: bucket.stateLabel, count: 0 };
      entry.count += 1;
      stateCounts.set(bucket.freshness, entry);
    }
  }

  const attention: Overview['attention'] = [];

  if (workspace === 'demo') {
    attention.push({
      level: 'info',
      text: '当前显示的是示例数据工作区',
      hint: '示例数据永远不会进入真实统计数据。切回「真实数据」即可看到你自己的记录。',
    });
  }

  const unverified = integrations.filter((i) => i.capabilityStatus === 'documented');
  if (unverified.length > 0) {
    attention.push({
      level: 'info',
      text: `${unverified.length} 个连接只有官方文档描述、尚未在本机验证：${unverified.map((i) => i.name).join('、')}`,
      hint: '「官方文档说支持」不等于「你这里能跑通」。在「设置与连接」里做只读探测后才会变成「已验证」。',
    });
  }
  const unknownIntegrations = integrations.filter((i) => i.capabilityStatus === 'unknown');
  if (unknownIntegrations.length > 0) {
    attention.push({
      level: 'info',
      text: `${unknownIntegrations.length} 个连接能力未知：${unknownIntegrations.map((i) => i.name).join('、')}`,
    });
  }

  if (quota.needsAttention > 0) {
    attention.push({
      level: 'warn',
      text: `${quota.needsAttention} 个额度快照不是最新状态（已过期 / 待刷新 / 未知）`,
      hint: '窗口过后的真实额度未知，本系统不会自动按 100% 计算。请到官方页面核对后重新登记。',
    });
  }

  const suspect = countSuspectDuplicates(ctx.db, workspace);
  if (suspect > 0) {
    attention.push({
      level: 'warn',
      text: `${suspect} 条用量记录疑似重复，尚未确认`,
      hint: '这些记录缺少稳定请求 ID 但内容与已有记录相同。它们既没有计入统计，也没有被删除。',
    });
  }

  const memCounters = memoryCounters(ctx, workspace);
  if (memCounters.pendingProposals > 0) {
    attention.push({
      level: 'info',
      text: `${memCounters.pendingProposals} 条候选记忆等待审核`,
      hint: '在批准之前，它们不会进入任何上下文包。',
    });
  }

  const importedWithoutRequestId = observations.filter((o) => o.identityConfidence === 'content_fingerprint').length;
  if (importedWithoutRequestId > 0) {
    attention.push({
      level: 'info',
      text: `${importedWithoutRequestId} 条记录没有稳定请求 ID，只能靠内容指纹识别同一请求`,
      hint: '跨文件的重复判定因此偏保守：会标为待确认，而不是自动合并。',
    });
  }

  return {
    generatedAt: new Date(ctx.now()).toISOString(),
    driver: ctx.driver,
    dataDir: ctx.config.dataDir,
    workspace: workspaceLabel(workspace),
    counts: {
      projects: listProjects(ctx.db).length,
      clients: listClients(ctx.db).length,
      accounts: listAccounts(ctx.db).length,
      subscriptions: listSubscriptions(ctx.db).length,
      observations: observations.length,
      charges: charges.length,
      imports: listImportJobs(ctx.db, 5, workspace).length,
    },
    tokens: {
      observed: totals.tokenValue,
      partial: totals.partial,
      coverage: totals.coverage,
      byModel: totals.byModel,
    },
    charges: chargeBuckets(ctx, workspace),
    quota: {
      groups: quota.groups,
      needsAttention: quota.needsAttention,
      states: [...stateCounts.entries()].map(([state, v]) => ({ state, label: v.label, count: v.count })),
    },
    memory: memCounters,
    usage: {
      suspectDuplicates: suspect,
      byCollectionMethod: [...byMethod.entries()].map(([method, count]) => ({ method, count })),
      byQuality: [...byQuality.entries()].map(([quality, count]) => ({ quality, count })),
    },
    integrations: integrations.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      capabilityStatus: i.capabilityStatus,
      verifiedAt: i.verifiedAt,
      lastSuccessAt: i.lastSuccessAt,
      notes: i.notes,
    })),
    attention,
    recentAudit: listAudit(ctx.db, { limit: 15, workspace }).map((a) => ({
      at: a.at,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      result: a.result,
    })),
    recentImports: listImportJobs(ctx.db, 8, workspace).map((j) => ({
      id: j.id,
      fileName: j.fileName,
      kind: j.kind,
      status: j.status,
      acceptedRows: j.acceptedRows,
      replayedRows: j.replayedRows,
      suspectRows: j.suspectRows,
      rejectedRows: j.rejectedRows,
      startedAt: j.startedAt,
    })),
  };
}
