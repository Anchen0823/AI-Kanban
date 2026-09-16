/**
 * Demo 数据（设计稿 §8 / INV-16）。
 *
 * 三条纪律：
 * 1. 所有 demo 行的 `is_demo = 1`，并且**名字里就带着「示例」**——
 *    防止截图或分享时被误认成真实账单。
 * 2. demo 数据从创建那一刻起就可以一键清空，且清空不会碰到任何真实数据。
 * 3. demo 数据要**刻意包含各种「不完美」状态**：未知 token、待刷新额度、
 *    待确认重复、待审候选。只放「一切正常」的示例会掩盖这个系统真正在解决的问题。
 */

import { computeDedupeKeys, fileFingerprint, newId, normalizeOpenAiLike } from '@aicc/core';
import { tx } from '../db/database.js';
import { insertObservation, insertCharge, type DuplicateStatus } from '../db/repos/usage.js';
import { insertQuotaSnapshot } from '../db/repos/quota.js';
import {
  createClient,
  createAccount,
  createSubscription,
  createProject,
  createSession,
} from '../db/repos/registry.js';
import { countDemoRows, insertIntegration, purgeDemoData, hasDemoData } from '../db/repos/system.js';
import type { ServiceContext } from '../service-context.js';
import { audit } from './audit.js';
import { createProposal, reviewProposal } from './memory.js';

const HOUR = 3600 * 1000;

export interface SeedReport {
  created: Record<string, number>;
  notes: string[];
}

export function seedDemo(ctx: ServiceContext): SeedReport {
  // 只检查示例数据本身，不检查「表里有没有数据」。
  // 用后者会导致「先建了一个真实客户端，就再也生不成示例」这种莫名其妙的失败。
  if (hasDemoData(ctx.db)) {
    throw new Error('已存在示例数据。请先清空示例数据再重新生成，避免出现两套示例。');
  }

  const now = ctx.now();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

  return tx(ctx.db, () => {
    const clientApp = createClient(ctx.db, {
      kind: 'chatgpt_app',
      displayName: '【示例】ChatGPT App',
      clientVersion: '示例版本',
      allowedProjects: null,
      isDemo: true,
    });
    const clientCodex = createClient(ctx.db, {
      kind: 'codex',
      displayName: '【示例】Codex',
      clientVersion: '示例版本',
      allowedProjects: null,
      isDemo: true,
    });
    const clientCursor = createClient(ctx.db, {
      kind: 'cursor',
      displayName: '【示例】Cursor',
      clientVersion: '示例版本',
      allowedProjects: null,
      isDemo: true,
    });
    const clientWb = createClient(ctx.db, {
      kind: 'workbuddy',
      displayName: '【示例】WorkBuddy',
      clientVersion: '示例版本',
      allowedProjects: null,
      isDemo: true,
    });

    const accountCny = createAccount(ctx.db, {
      provider: '示例供应商 A',
      alias: '【示例】主账户（人民币）',
      accountRef: null,
      currency: 'CNY',
      isDemo: true,
    });
    const accountUsd = createAccount(ctx.db, {
      provider: '示例供应商 B',
      alias: '【示例】按量账户（美元）',
      accountRef: null,
      currency: 'USD',
      isDemo: true,
    });

    const sub = createSubscription(ctx.db, {
      name: '【示例】月付订阅（覆盖两个客户端）',
      accountId: accountCny.id,
      plan: '示例套餐',
      priceMinor: '14000',
      currency: 'CNY',
      billingCycle: 'monthly',
      periodStart: iso(-20 * 24 * HOUR).slice(0, 10),
      periodEnd: iso(10 * 24 * HOUR).slice(0, 10),
      renewAt: iso(10 * 24 * HOUR).slice(0, 10),
      status: 'active',
      clientIds: [clientApp.id, clientWb.id],
      isDemo: true,
    });

    const projectA = createProject(ctx.db, {
      title: '【示例】项目 A：象棋引擎重构',
      goal: '把搜索与评估解耦，先保证棋例规则正确，再谈棋力。',
      status: 'active',
      handoffSummary: '示例交接摘要：当前卡在长将判负的边界用例。',
      repoAlias: 'example/xiangqi',
      isDemo: true,
    });
    const projectB = createProject(ctx.db, {
      title: '【示例】项目 B：Lean 形式化练习',
      goal: '用完整的证明任务练手，而不是一行一个 TODO。',
      status: 'active',
      handoffSummary: null,
      repoAlias: null,
      isDemo: true,
    });

    createSession(ctx.db, {
      projectId: projectA.id,
      clientId: clientCodex.id,
      startedAt: iso(-6 * HOUR),
      endedAt: iso(-5 * HOUR),
      sourceSessionId: 'example-session-1',
      summary: '【示例】讨论了重复局面判定的实现方式，决定先补齐测试再动搜索。',
      isDemo: true,
    });

    /* ---------------- 记忆：一条 active、一条待审、一条带冲突 ---------------- */

    const created = createProposal(ctx, {
      operation: 'create',
      scope: 'project',
      projectId: projectA.id,
      kind: 'decision',
      title: '【示例】新任务优先检索已有引理',
      content: '开始新的证明任务前，先检索可复用的定理和引理，再决定是否拆分新节点。',
      sourceKind: 'chatgpt_summary',
      sourceRef: null,
      evidenceStatus: 'user_confirmation_required',
      isDemo: true,
    });
    reviewProposal(ctx, created.proposal.id, {
      decision: 'approve',
      reviewedBy: '示例用户',
      reviewNote: '【示例】核对无误后批准。',
    });

    createProposal(ctx, {
      operation: 'create',
      scope: 'project',
      projectId: projectB.id,
      kind: 'hypothesis',
      title: '【示例】猜测：分块搜索在残局收益更大',
      content: '这是一个尚未验证的猜想，verification 保持 unverified，不允许进入「已确认事实」。',
      sourceKind: 'agent_proposal',
      evidenceStatus: 'unknown',
      verification: 'unverified',
      isDemo: true,
    });

    createProposal(ctx, {
      operation: 'create',
      scope: 'project',
      projectId: projectA.id,
      kind: 'fact',
      title: '【示例】引擎默认思考时间 3 秒',
      content: '示例事实：默认思考时间 3 秒，可在设置页调整。',
      sourceKind: 'manual_input',
      evidenceStatus: 'verified',
      verification: 'human_confirmed',
      isDemo: true,
    });

    /* ---------------- 用量：包含未知 / 重复 / 证据三种情况 ---------------- */

    const fileFp = fileFingerprint('example-usage.csv', 'demo');

    const pushUsage = (
      input: {
        accountId: string;
        projectId: string | null;
        clientId: string | null;
        model: string | null;
        occurredAt: string;
        raw: Record<string, unknown>;
        isPrimary: boolean;
        duplicateStatus: DuplicateStatus;
        duplicateOf?: string | null;
        quality: 'provider_reported' | 'locally_observed' | 'estimated' | 'unknown';
        rowIndex: number;
        providerRequestId?: string | null;
      },
    ) => {
      const tokens = normalizeOpenAiLike(input.raw);
      const keys = computeDedupeKeys({
        accountId: input.accountId,
        providerRequestId: input.providerRequestId ?? null,
        meterKind: 'tokens',
        fileFingerprint: fileFp,
        rowIndex: input.rowIndex,
        model: input.model,
        occurredAt: input.occurredAt,
        inputTotal: tokens.inputTotal,
        outputTotal: tokens.outputTotal,
        totalReported: tokens.totalReported,
        rawUsage: input.raw,
      });
      return insertObservation(ctx.db, {
        kind: 'event',
        collectionMethod: 'imported_file',
        measurementQuality: input.quality,
        accountId: input.accountId,
        projectId: input.projectId,
        clientId: input.clientId,
        model: input.model,
        occurredAt: input.occurredAt,
        periodStart: null,
        periodEnd: null,
        rawUsage: input.raw,
        tokens,
        sourceRef: null,
        adapterVersion: 'demo-1.0.0',
        coverageScope: '【示例】仅演示用，不代表真实用量',
        providerRequestId: input.providerRequestId ?? null,
        meterKind: 'tokens',
        dedupeKey: keys.dedupeKey,
        identityKey: keys.identityKey,
        identityConfidence: keys.identityConfidence,
        isPrimary: input.isPrimary,
        duplicateStatus: input.duplicateStatus,
        duplicateOf: input.duplicateOf ?? null,
        importJobId: null,
        rowIndex: input.rowIndex,
        fileFingerprint: fileFp,
        contentFingerprint: null,
        isDemo: true,
      });
    };

    const obs1 = pushUsage({
      accountId: accountCny.id,
      projectId: projectA.id,
      clientId: clientCodex.id,
      model: '示例模型-大',
      occurredAt: iso(-30 * HOUR),
      raw: { input_tokens: 10000, output_tokens: 2000, cached_tokens: 6000, reasoning_tokens: 1000 },
      isPrimary: true,
      duplicateStatus: 'none',
      quality: 'provider_reported',
      rowIndex: 2,
      providerRequestId: 'example-req-1',
    });

    pushUsage({
      accountId: accountCny.id,
      projectId: projectA.id,
      clientId: clientCodex.id,
      model: '示例模型-大',
      occurredAt: iso(-30 * HOUR),
      raw: { input_tokens: 10000, output_tokens: 2000, cached_tokens: 6000, reasoning_tokens: 1000 },
      isPrimary: true,
      duplicateStatus: 'none',
      quality: 'provider_reported',
      rowIndex: 3,
      providerRequestId: 'example-req-1',
    });

    pushUsage({
      accountId: accountCny.id,
      projectId: projectB.id,
      clientId: clientCursor.id,
      model: '示例模型-中',
      occurredAt: iso(-10 * HOUR),
      raw: { input_tokens: 4000, output_tokens: 800 },
      isPrimary: true,
      duplicateStatus: 'none',
      quality: 'provider_reported',
      rowIndex: 4,
      providerRequestId: 'example-req-2',
    });

    pushUsage({
      accountId: accountCny.id,
      projectId: projectB.id,
      clientId: clientWb.id,
      model: '示例模型-中',
      occurredAt: iso(-8 * HOUR),
      raw: { model: 'unknown-provider' },
      isPrimary: true,
      duplicateStatus: 'none',
      quality: 'unknown',
      rowIndex: 5,
    });

    pushUsage({
      accountId: accountUsd.id,
      projectId: null,
      clientId: null,
      model: '示例模型-按量',
      occurredAt: iso(-20 * HOUR),
      raw: { input_tokens: 2000, output_tokens: 500 },
      isPrimary: false,
      duplicateStatus: 'suspect',
      duplicateOf: obs1.id,
      quality: 'provider_reported',
      rowIndex: 6,
    });

    /* ---------------- 收费：人民币与美元分开，含一笔待结算 ---------------- */

    insertCharge(ctx.db, {
      accountId: accountCny.id,
      subscriptionId: sub.id,
      kind: 'subscription',
      amountMinor: '14000',
      currency: 'CNY',
      status: 'paid',
      periodStart: iso(-20 * 24 * HOUR).slice(0, 10),
      periodEnd: iso(10 * 24 * HOUR).slice(0, 10),
      paidAt: iso(-20 * 24 * HOUR),
      billingRef: 'example-invoice-cny-1',
      collectionMethod: 'manual',
      measurementQuality: 'provider_reported',
      sourceRef: null,
      dedupeKey: `charge|demo|subscription|${sub.id}|1`,
      note: '【示例】订阅覆盖了 ChatGPT App 与 WorkBuddy 两个入口，仍只记一次。',
      isDemo: true,
    });

    insertCharge(ctx.db, {
      accountId: accountUsd.id,
      subscriptionId: null,
      kind: 'api',
      amountMinor: '1235',
      currency: 'USD',
      status: 'pending',
      periodStart: null,
      periodEnd: null,
      paidAt: null,
      billingRef: 'example-invoice-usd-1',
      collectionMethod: 'manual',
      measurementQuality: 'provider_reported',
      sourceRef: null,
      dedupeKey: 'charge|demo|api|usd|1',
      note: '【示例】已报告但尚未结算。',
      isDemo: true,
    });

    insertCharge(ctx.db, {
      accountId: accountUsd.id,
      subscriptionId: null,
      kind: 'extra',
      amountMinor: '300',
      currency: 'USD',
      status: 'pending',
      periodStart: null,
      periodEnd: null,
      paidAt: null,
      billingRef: null,
      collectionMethod: 'manual',
      measurementQuality: 'estimated',
      sourceRef: null,
      dedupeKey: 'charge|demo|extra|usd|1',
      note: '【示例】用户自报的估算费用。它与实际支出分开展示，不会并进同一个数字。',
      isDemo: true,
    });

    /* ---------------- 额度：新鲜 / 已过期 / 待刷新 各一个 ---------------- */

    insertQuotaSnapshot(ctx.db, {
      accountId: accountCny.id,
      bucketId: 'example-hourly',
      bucketLabel: '【示例】小时窗额度',
      scope: 'ChatGPT App, Codex',
      windowKind: 'hourly',
      windowSeconds: 3600,
      usedRatio: 0.42,
      remainingRatio: 0.58,
      resetAt: iso(20 * 60 * 1000),
      observedAt: iso(-5 * 60 * 1000),
      measurementQuality: 'provider_reported',
      collectionMethod: 'manual',
      sourceRef: '【示例】用户从官方页面抄录',
      staleAfterSeconds: 21600,
      isDemo: true,
    });

    insertQuotaSnapshot(ctx.db, {
      accountId: accountCny.id,
      bucketId: 'example-weekly',
      bucketLabel: '【示例】周窗额度',
      scope: 'ChatGPT App',
      windowKind: 'weekly',
      windowSeconds: 7 * 24 * 3600,
      usedRatio: 0.71,
      remainingRatio: 0.29,
      resetAt: iso(3 * 24 * HOUR),
      observedAt: iso(-40 * HOUR),
      measurementQuality: 'provider_reported',
      collectionMethod: 'manual',
      sourceRef: null,
      staleAfterSeconds: 21600,
      isDemo: true,
    });

    insertQuotaSnapshot(ctx.db, {
      accountId: accountUsd.id,
      bucketId: 'example-monthly',
      bucketLabel: '【示例】月窗额度（窗口已过，待刷新）',
      scope: null,
      windowKind: 'monthly',
      windowSeconds: 30 * 24 * 3600,
      usedRatio: 0.93,
      remainingRatio: 0.07,
      resetAt: iso(-2 * HOUR),
      observedAt: iso(-3 * 24 * HOUR),
      measurementQuality: 'provider_reported',
      collectionMethod: 'manual',
      sourceRef: null,
      staleAfterSeconds: 21600,
      isDemo: true,
    });

    /* ---------------- 能力登记：三种状态各一个 ---------------- */

    insertIntegration(ctx.db, {
      id: newId('integration'),
      name: '【示例】Codex 用量接口',
      category: 'usage',
      transport: '本地只读探测（M1 才实现）',
      authMode: '使用官方组件自身的认证流程',
      capabilityStatus: 'documented',
      capabilityDetail: {
        documented_methods: ['account/rateLimits/read', 'account/usage/read'],
        implemented: false,
        milestone: 'M1',
      },
      evidence: null,
      envRequirement: '需要本机安装 Codex；探测在 M1 实现',
      notes: '【示例】官方文档描述支持，但本机尚未验证。因此状态是 documented，不是 verified。',
      isDemo: true,
    });

    insertIntegration(ctx.db, {
      id: newId('integration'),
      name: '【示例】本地 MCP（记忆检索）',
      category: 'memory',
      transport: 'stdio MCP server',
      authMode: '按客户端与项目发放凭据',
      capabilityStatus: 'unknown',
      capabilityDetail: { implemented: false, milestone: 'M1' },
      evidence: null,
      envRequirement: null,
      notes: '【示例】M0 只提供 HTTP API 与凭据模型，MCP 传输层未实现。',
      isDemo: true,
    });

    insertIntegration(ctx.db, {
      id: newId('integration'),
      name: '【示例】手动 CSV 导入',
      category: 'usage',
      transport: '本地文件',
      authMode: '无需凭据',
      capabilityStatus: 'verified',
      capabilityDetail: { implemented: true, milestone: 'M0' },
      evidence: '【示例】本机已用合成 CSV 跑通成功 / 失败 / 重复导入三类用例',
      verifiedAt: iso(-2 * HOUR),
      envRequirement: null,
      notes: '【示例】这是 M0 唯一「已在本机验证」的采集方式。',
      isDemo: true,
    });

    audit(ctx, {
      action: 'demo.seed',
      entityType: 'workspace',
      entityId: 'demo',
      detail: { note: '全部为合成示例数据，is_demo = 1，可一键清空' },
      actorKind: 'system',
      isDemo: true,
    });

    return {
      created: {
        clients: 4,
        accounts: 2,
        subscriptions: 1,
        projects: 2,
        memories: 1,
        proposals: 2,
        observations: 5,
        charges: 3,
        quotaSnapshots: 3,
        integrations: 3,
      },
      notes: [
        '所有示例数据的名称都以「【示例】」开头，并在数据库中标记 is_demo = 1。',
        '示例刻意包含了未知 token、待刷新额度、疑似重复、待审候选等「不完美」状态。',
        'demo 数据不会进入任何真实统计：概览默认只统计 is_demo = 0 的记录。',
        '清空 demo 数据只删除 is_demo = 1 的行，真实数据不受影响。',
      ],
    };
  });
}

export interface ResetReport {
  deleted: Record<string, number>;
  totalDeleted: number;
  note: string;
}

export function resetDemo(ctx: ServiceContext): ResetReport {
  return tx(ctx.db, () => {
    const counts = purgeDemoData(ctx.db);
    const totalDeleted = Object.values(counts).reduce((a, b) => a + b, 0);
    audit(ctx, {
      action: 'demo.reset',
      entityType: 'workspace',
      entityId: 'demo',
      detail: { deletedRows: totalDeleted },
      actorKind: 'system',
    });
    return {
      deleted: counts,
      totalDeleted,
      note: '已删除全部 demo 数据。is_demo = 0 的真实记录一行都没有被改动。',
    };
  });
}

export function demoStatus(ctx: ServiceContext): { hasDemoData: boolean; counts: Record<string, number> } {
  const demoOnly = countDemoRows(ctx.db);
  const nonZero: Record<string, number> = {};
  let hasAny = false;
  for (const [table, count] of Object.entries(demoOnly)) {
    if (count > 0) {
      nonZero[table] = count;
      hasAny = true;
    }
  }
  return { hasDemoData: hasAny, counts: nonZero };
}
