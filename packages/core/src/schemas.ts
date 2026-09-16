/**
 * 请求/响应校验（zod）。
 *
 * 放在 core 而不是 server，是为了让前端能直接复用同一套约束来做事前校验，
 * 也让测试可以用同一份 schema 构造合法/非法输入。
 *
 * 注意：这里只做**形状**校验。「这个数值有没有证据」「这个能力有没有验证过」
 * 属于业务规则，在服务层判断。
 */

import { z } from 'zod';
import {
  CHARGE_KINDS,
  CHARGE_STATUSES,
  CLIENT_KINDS,
  COLLECTION_METHODS,
  CONTEXT_BUDGET_KINDS,
  CREDENTIAL_SCOPES,
  IMPORT_KINDS,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEASUREMENT_QUALITIES,
  METER_KINDS,
  OBSERVATION_KINDS,
  PROPOSAL_OPERATIONS,
  QUOTA_WINDOW_KINDS,
  SENSITIVITY_LEVELS,
  SOURCE_KINDS,
  VERIFICATION_STATES,
} from './enums.js';

/* ---------------------------------------------------------------- */
/* 基础标量                                                          */
/* ---------------------------------------------------------------- */

export const zIsoDateTime = z
  .string()
  .min(1)
  .refine((v) => Number.isFinite(Date.parse(v)), '需要可解析的 ISO-8601 时间');

/** 只精确到「天」的日期。不伪造精确时刻（§10）。 */
export const zIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

export const zId = z.string().min(1).max(64);

export const zCurrency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, '币种需为 3 位 ISO-4217 代码')
  .transform((v) => v.toUpperCase());

/** 最小单位金额，十进制定点整数的字符串。 */
export const zAmountMinor = z.string().regex(/^-?(0|[1-9]\d*)$/, '金额需为十进制定点整数的字符串');

/** 非负整数；未知用 null，禁止用 0 冒充（INV-01）。 */
export const zTokenCount = z.number().int().nonnegative();
export const zNullableTokenCount = zTokenCount.nullable();

export const zRatio = z.number().min(0).max(1);

export const zRawUsage = z.record(z.string(), z.unknown());

/**
 * 查询串里的布尔值。
 *
 * 不能用 `z.coerce.boolean()`：`Boolean("false") === true`，而 `?flag=false` 会
 * 静默变成 `true`。这类错误在「是否包含证据行」「是否包含历史」上会直接影响统计口径，
 * 必须显式解析。
 */
export const zQueryBool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return defaultValue;
      if (typeof v === 'boolean') return v;
      return v === 'true' || v === '1';
    });


/* ---------------------------------------------------------------- */
/* 登记类                                                            */
/* ---------------------------------------------------------------- */

export const zCreateClient = z.object({
  kind: z.enum(CLIENT_KINDS),
  displayName: z.string().min(1).max(120),
  clientVersion: z.string().max(80).nullable().optional(),
  mcpProfile: z.string().max(200).nullable().optional(),
  /** null = 未限定；数组 = 明确允许的项目范围。 */
  allowedProjects: z.array(zId).nullable().optional(),
});

export const zCreateAccount = z.object({
  provider: z.string().min(1).max(80),
  alias: z.string().min(1).max(120),
  /** 用户自己填的账户标识。**系统不接受也不保存登录 Cookie。** */
  accountRef: z.string().max(120).nullable().optional(),
  currency: zCurrency,
});

export const zCreateSubscription = z.object({
  name: z.string().min(1).max(120),
  accountId: zId.nullable().optional(),
  plan: z.string().max(120).nullable().optional(),
  priceMinor: zAmountMinor,
  currency: zCurrency,
  billingCycle: z.enum(['monthly', 'yearly', 'other']),
  periodStart: zIsoDate.nullable().optional(),
  periodEnd: zIsoDate.nullable().optional(),
  renewAt: zIsoDate.nullable().optional(),
  status: z.enum(['active', 'cancelled', 'unknown']).default('active'),
  /** 订阅覆盖的入口。多对多，固定月费只记一次（INV-09 / U06）。 */
  clientIds: z.array(zId).default([]),
});

export const zCreateProject = z.object({
  title: z.string().min(1).max(160),
  goal: z.string().max(4000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  handoffSummary: z.string().max(8000).nullable().optional(),
  repoAlias: z.string().max(200).nullable().optional(),
});

export const zUpdateProject = z.object({
  title: z.string().min(1).max(160).optional(),
  goal: z.string().max(4000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  handoffSummary: z.string().max(8000).nullable().optional(),
  repoAlias: z.string().max(200).nullable().optional(),
});

export const zCreateSession = z.object({
  projectId: zId.nullable().default(null),
  clientId: zId.nullable().default(null),
  startedAt: zIsoDateTime.nullable().optional(),
  endedAt: zIsoDateTime.nullable().optional(),
  /** 只存源会话 ID，不存聊天全文（§14）。 */
  sourceSessionId: z.string().max(200).nullable().optional(),
  summary: z.string().max(20000).nullable().optional(),
});

/* ---------------------------------------------------------------- */
/* 用量与额度                                                        */
/* ---------------------------------------------------------------- */

export const zManualUsageInput = z.object({
  kind: z.enum(OBSERVATION_KINDS).default('event'),
  accountId: zId.nullable().default(null),
  projectId: zId.nullable().default(null),
  clientId: zId.nullable().default(null),
  model: z.string().max(120).nullable().optional(),
  occurredAt: zIsoDateTime.nullable().optional(),
  periodStart: zIsoDateTime.nullable().optional(),
  periodEnd: zIsoDateTime.nullable().optional(),
  providerRequestId: z.string().max(200).nullable().optional(),
  meterKind: z.enum(METER_KINDS).default('tokens'),
  rawUsage: zRawUsage.default({}),
  /** 归一化依据。默认按 OpenAI 的子集语义；设为 unknown 时只保留原始字段。 */
  basis: z.enum(['openai_inclusive', 'exclusive_buckets', 'unknown']).default('openai_inclusive'),
  /** 手动录入时用户自报的数值质量。 */
  measurementQuality: z.enum(MEASUREMENT_QUALITIES).default('unknown'),
  coverageScope: z.string().max(200).nullable().optional(),
  sourceRef: z.string().max(500).nullable().optional(),
});

export const zImportInput = z.object({
  kind: z.enum(IMPORT_KINDS),
  fileName: z.string().min(1).max(255),
  /** 文本内容。服务端会再做大小与解压比例限制。 */
  content: z.string().min(1),
  accountId: zId.nullable().default(null),
  projectId: zId.nullable().default(null),
  clientId: zId.nullable().default(null),
  /** 仅预检不落库。 */
  dryRun: z.boolean().default(false),
});

export const zQuotaSnapshotInput = z.object({
  accountId: zId,
  bucketId: z.string().min(1).max(120),
  bucketLabel: z.string().min(1).max(200),
  /** 该额度桶被哪些入口共享消耗。 */
  scope: z.string().max(500).nullable().optional(),
  windowKind: z.enum(QUOTA_WINDOW_KINDS),
  windowSeconds: z.number().int().positive().nullable().optional(),
  usedRatio: zRatio.nullable().optional(),
  remainingRatio: zRatio.nullable().optional(),
  usedAmountMinor: zAmountMinor.nullable().optional(),
  limitMinor: zAmountMinor.nullable().optional(),
  currency: zCurrency.nullable().optional(),
  resetAt: zIsoDateTime.nullable().optional(),
  observedAt: zIsoDateTime,
  /** 手动填「官网显示 60%」依然是 provider_reported，但采集方式是 manual（§5.2）。 */
  measurementQuality: z.enum(MEASUREMENT_QUALITIES).default('provider_reported'),
  collectionMethod: z.enum(COLLECTION_METHODS).default('manual'),
  sourceRef: z.string().max(500).nullable().optional(),
  staleAfterSeconds: z.number().int().positive().default(21600),
});

export const zChargeInput = z.object({
  accountId: zId.nullable().default(null),
  subscriptionId: zId.nullable().default(null),
  kind: z.enum(CHARGE_KINDS),
  amountMinor: zAmountMinor,
  currency: zCurrency,
  status: z.enum(CHARGE_STATUSES).default('paid'),
  periodStart: zIsoDate.nullable().optional(),
  periodEnd: zIsoDate.nullable().optional(),
  paidAt: zIsoDateTime.nullable().optional(),
  /** 账单对账用。同一 billing_ref 不会重复记账。 */
  billingRef: z.string().max(200).nullable().optional(),
  collectionMethod: z.enum(COLLECTION_METHODS).default('manual'),
  note: z.string().max(1000).nullable().optional(),
});

export const zUsageQuery = z.object({
  accountId: zId.optional(),
  projectId: zId.optional(),
  clientId: zId.optional(),
  kind: z.enum(OBSERVATION_KINDS).optional(),
  collectionMethod: z.enum(COLLECTION_METHODS).optional(),
  measurementQuality: z.enum(MEASUREMENT_QUALITIES).optional(),
  from: zIsoDateTime.optional(),
  to: zIsoDateTime.optional(),
  /** 默认只返回主统计源；显式传 true 才连证据行一起看。 */
  includeNonPrimary: zQueryBool(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ---------------------------------------------------------------- */
/* 记忆                                                              */
/* ---------------------------------------------------------------- */

export const zMemoryProposalInput = z.object({
  operation: z.enum(PROPOSAL_OPERATIONS),
  targetMemoryId: zId.nullable().default(null),
  baseVersion: z.number().int().positive().nullable().default(null),
  scope: z.enum(MEMORY_SCOPES),
  projectId: zId.nullable().default(null),
  kind: z.enum(MEMORY_KINDS),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(20000),
  sensitivity: z.enum(SENSITIVITY_LEVELS).default('normal'),
  verification: z.enum(VERIFICATION_STATES).default('unverified'),
  reviewAfter: zIsoDate.nullable().optional(),
  sourceKind: z.enum(SOURCE_KINDS).default('agent_proposal'),
  /** 没有可验证链接就写 null，不允许编造（§6.3）。 */
  sourceRef: z.string().max(500).nullable().optional(),
  evidenceQuote: z.string().max(4000).nullable().optional(),
  evidenceStatus: z.enum(['verified', 'user_confirmation_required', 'unknown']).default('user_confirmation_required'),
  /** 提案者客户端；服务端会核对它与凭据授权是否一致。 */
  submittedByClientId: zId.nullable().default(null),
});

export const zProposalReviewInput = z.object({
  decision: z.enum(['approve', 'reject']),
  reviewedBy: z.string().min(1).max(120).default('local-user'),
  reviewNote: z.string().max(2000).nullable().optional(),
  /** 批准时可微调正文；系统会记录这与提案原文的差异。 */
  overrideTitle: z.string().min(1).max(200).nullable().optional(),
  overrideContent: z.string().min(1).max(20000).nullable().optional(),
});

export const zMemoriesQuery = z.object({
  projectId: zId.optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  status: z.enum(['active', 'superseded', 'archived', 'expired', 'deleted']).optional(),
  q: z.string().max(200).optional(),
  includeHistory: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const zProposalsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'conflict']).optional(),
  projectId: zId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ---------------------------------------------------------------- */
/* 上下文包                                                          */
/* ---------------------------------------------------------------- */

export const zContextExportInput = z.object({
  projectId: zId,
  task: z.string().max(2000).nullable().optional(),
  budgetKind: z.enum(CONTEXT_BUDGET_KINDS).default('short'),
  customBudgetTokens: z.number().int().positive().max(200000).nullable().optional(),
  includeGlobalMemory: z.boolean().default(false),
  /** 允许纳入的敏感等级上限。 */
  maxSensitivity: z.enum(SENSITIVITY_LEVELS).default('normal'),
  /** 请求方项目范围；服务端会与实际授权求交，不会直接信任这个字段。 */
  requestedProjectIds: z.array(zId).nullable().optional(),
});

/* ---------------------------------------------------------------- */
/* 删除与备份                                                        */
/* ---------------------------------------------------------------- */

export const zDeleteMemoryInput = z.object({
  reason: z.string().min(1).max(500),
  /** 必须显式确认；永久删除不能藏在保存按钮后面（§8）。 */
  confirm: z.literal(true),
  deletedBy: z.string().min(1).max(120).default('local-user'),
});

export const zCreateCredential = z.object({
  clientId: zId,
  label: z.string().min(1).max(120),
  /** 该凭据可见的项目范围。null 表示不限定（仅建议用于用户自己调试）。 */
  projectIds: z.array(zId).nullable().default(null),
  /**
   * 允许的 scope。**审批、删除、连接管理类动作不在这个枚举里**，
   * 因此 MCP 客户端凭据在类型层面就无法调用它们（§11.2）。
   */
  scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1),
});

export const zProbeIntegrationInput = z.object({
  /** 只读探测的说明由用户填写；不做任何写操作。 */
  note: z.string().max(1000).nullable().optional(),
});

export const zRestoreInput = z.object({
  /** 备份目录名（相对于 data/backups）。 */
  backupName: z.string().min(1).max(200),
  confirm: z.literal(true),
});

export const zSettingsInput = z.object({
  displayTimezone: z.string().max(80).optional(),
  dataDir: z.string().max(500).optional(),
  backupDir: z.string().max(500).optional(),
  quotaStaleSeconds: z.number().int().positive().max(31536000).optional(),
  contextShortBudget: z.number().int().positive().max(100000).optional(),
  contextStandardBudget: z.number().int().positive().max(200000).optional(),
});

/** 统一的错误包装。前端只需要认这一种结构。 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
