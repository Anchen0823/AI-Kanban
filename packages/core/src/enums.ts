/**
 * 枚举与常量。
 *
 * 一律使用「冻结对象 + 联合类型」而不是 TS `enum`：这样在 zod 校验、SQLite 存储和
 * ESM 转译之间不会出现编译期魔法，`verbatimModuleSyntax` 下也更好处理。
 */

/** 客户端类型（设计稿 §10 Client）。 */
export const CLIENT_KINDS = [
  'chatgpt_app',
  'chatgpt_web',
  'codex',
  'cursor',
  'workbuddy',
  'api_agent',
  'other',
] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** 数值采集方式（§5.2）。表达「这个数怎么来的」。 */
export const COLLECTION_METHODS = [
  'official_api',
  'local_log',
  'imported_file',
  'manual',
] as const;
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

/** 数值质量（§5.2）。表达「这个数有多可信」，与采集方式正交。 */
export const MEASUREMENT_QUALITIES = [
  'provider_reported',
  'locally_observed',
  'estimated',
  'unknown',
] as const;
export type MeasurementQuality = (typeof MEASUREMENT_QUALITIES)[number];

/** 用量观测种类（§5.1）。 */
export const OBSERVATION_KINDS = ['event', 'summary'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/** 计量桶。用于幂等键，避免同一请求的不同计费维度互相覆盖。 */
export const METER_KINDS = ['tokens', 'requests', 'compute_time', 'tool_calls'] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/** 收费类型（§5.1 Charge）。 */
export const CHARGE_KINDS = ['subscription', 'api', 'extra', 'refund'] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

export const CHARGE_STATUSES = ['paid', 'pending', 'refunded', 'void', 'unknown'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** 额度窗口类型（§5.6）。小时窗与周窗分别展示，不平均。 */
export const QUOTA_WINDOW_KINDS = ['hourly', 'daily', 'weekly', 'monthly', 'custom'] as const;
export type QuotaWindowKind = (typeof QUOTA_WINDOW_KINDS)[number];

/** 额度快照读取时计算出的新鲜度状态。 */
export const QUOTA_FRESHNESS = ['fresh', 'stale', 'pending_refresh', 'unknown'] as const;
export type QuotaFreshness = (typeof QUOTA_FRESHNESS)[number];

/** 记忆范围（§6.1）。 */
export const MEMORY_SCOPES = ['global', 'project', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** 记忆类型（§6.1）。个人偏好、项目事实、决策、经验、猜想、交接材料不混成一团。 */
export const MEMORY_KINDS = [
  'preference',
  'fact',
  'decision',
  'lesson',
  'hypothesis',
  'handoff',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 记忆生命周期状态（§6.2 / §3.1）。 */
export const MEMORY_STATUSES = [
  'active',
  'superseded',
  'archived',
  'expired',
  'deleted',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** 提案状态。 */
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'conflict'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_OPERATIONS = ['create', 'update', 'archive'] as const;
export type ProposalOperation = (typeof PROPOSAL_OPERATIONS)[number];

/** 验证状态（§6.1）。AI 语气肯定不等于已证明。 */
export const VERIFICATION_STATES = [
  'unverified',
  'locally_tested',
  'formally_verified',
  'human_confirmed',
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** 敏感等级（§6.1 / §14）。 */
export const SENSITIVITY_LEVELS = ['normal', 'private', 'restricted'] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** 来源类型。`source_ref = null` 表示没有可验证链接，不允许编造。 */
export const SOURCE_KINDS = [
  'manual_input',
  'chatgpt_summary',
  'chatgpt_export',
  'codex_session',
  'cursor_session',
  'workbuddy_session',
  'imported_file',
  'local_log',
  'official_api',
  'agent_proposal',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** 证据状态（§6.3）。模型生成过摘要 ≠ 用户确认过内容。 */
export const EVIDENCE_STATUSES = [
  'verified',
  'user_confirmation_required',
  'unknown',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** 能力登记状态（§3.1）。 */
export const CAPABILITY_STATUSES = [
  'documented',
  'verified',
  'unsupported',
  'unknown',
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** 导入批次状态（§3.3）。 */
export const IMPORT_STATUSES = [
  'precheck',
  'running',
  'completed',
  'failed',
  'cancelled',
  'rejected',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** 导入器类型。M0 只实现通用 CSV/JSON 与手动录入。 */
export const IMPORT_KINDS = [
  'usage_csv',
  'usage_json',
  'charge_csv',
  'memory_json',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** 上下文包规格（§6.5）。 */
export const CONTEXT_BUDGET_KINDS = ['short', 'standard', 'custom'] as const;
export type ContextBudgetKind = (typeof CONTEXT_BUDGET_KINDS)[number];

/** 预算默认值：短版约 1,000、标准版约 2,500。 */
export const CONTEXT_BUDGET_DEFAULTS: Record<ContextBudgetKind, number> = {
  short: 1000,
  standard: 2500,
  custom: 0,
};

/** 凭据 scope。审批、删除、连接管理**不在** MCP 客户端可持有的范围内（§11.2）。 */
export const CREDENTIAL_SCOPES = [
  'memory_search',
  'memory_get',
  'context_build',
  'memory_propose',
  'session_propose',
  'integration_status',
] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/** 只有用户会话能执行的高危动作。 */
export const USER_ONLY_ACTIONS = [
  'proposal_review',
  'memory_delete',
  'memory_restore',
  'connection_manage',
  'credential_manage',
  'backup_restore',
  'project_manage',
  'demo_reset',
] as const;
export type UserOnlyAction = (typeof USER_ONLY_ACTIONS)[number];

/** 审计动作名。 */
export type AuditAction =
  | 'client.create'
  | 'client.update'
  | 'account.create'
  | 'subscription.create'
  | 'project.create'
  | 'project.update'
  | 'session.create'
  | 'import.create'
  | 'import.complete'
  | 'import.fail'
  | 'usage.observe'
  | 'usage.dedupe'
  | 'usage.resolve_duplicate'
  | 'charge.create'
  | 'quota.snapshot'
  | 'proposal.create'
  | 'proposal.review'
  | 'memory.create'
  | 'memory.update'
  | 'memory.archive'
  | 'memory.delete'
  | 'memory.delete_preview'
  | 'context.export'
  | 'integration.probe'
  | 'credential.create'
  | 'credential.revoke'
  | 'backup.create'
  | 'backup.restore'
  | 'demo.seed'
  | 'demo.reset'
  | 'auth.login'
  | 'auth.reject';
