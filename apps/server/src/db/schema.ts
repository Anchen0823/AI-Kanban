/**
 * 数据库 schema 与迁移。
 *
 * SQL 直接内联在 TS 里而不是放 `.sql` 文件：编译到 `dist/` 后不需要额外拷贝资源，
 * 也就不会出现「开发时能跑、构建后找不到迁移文件」这类只在部署时才暴露的问题。
 *
 * 迁移**只追加**：已发布的迁移不许改写，否则老库和新库会分叉。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M1_INIT = `
-- ============================================================================
-- 设置
-- ============================================================================
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- 登记类：客户端 / 账户 / 订阅 / 项目 / 会话
-- ============================================================================

CREATE TABLE client (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  client_version   TEXT,
  mcp_profile      TEXT,
  -- JSON 数组或 NULL（NULL = 未限定范围）
  allowed_projects TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  is_demo          INTEGER NOT NULL DEFAULT 0
);

-- 注意：这张表里没有任何存放第三方登录 Cookie / Token 的列。
-- 这是设计约束（§14），不是遗漏。
CREATE TABLE billing_account (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  alias       TEXT NOT NULL,
  account_ref TEXT,
  currency    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  is_demo     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE subscription (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  account_id    TEXT REFERENCES billing_account(id) ON DELETE SET NULL,
  plan          TEXT,
  price_minor   TEXT NOT NULL,
  currency      TEXT NOT NULL,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly','yearly','other')),
  period_start  TEXT,
  period_end    TEXT,
  renew_at      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','cancelled','unknown')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  is_demo       INTEGER NOT NULL DEFAULT 0
);

-- 订阅与客户端是多对多：一个付费订阅可以覆盖多个入口（§5.4）
CREATE TABLE subscription_client (
  subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, client_id)
);

CREATE TABLE project (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  goal            TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  handoff_summary TEXT,
  repo_alias      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  is_demo         INTEGER NOT NULL DEFAULT 0
);

-- source_session_id 只保存对方平台的会话 ID，不保存聊天全文（§14）
CREATE TABLE session (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES project(id) ON DELETE SET NULL,
  client_id         TEXT REFERENCES client(id) ON DELETE SET NULL,
  started_at        TEXT,
  ended_at          TEXT,
  source_session_id TEXT,
  summary           TEXT,
  created_at        TEXT NOT NULL,
  is_demo           INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- 用量：观测 / 收费 / 额度
-- ============================================================================

-- 一条 UsageEvent 或 UsageSummary（§5.1）。
-- token 列全部允许 NULL —— NULL 表示「供应商没有报告」，与 0（真实为零）严格区分（INV-01）。
CREATE TABLE usage_observation (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN ('event','summary')),
  collection_method   TEXT NOT NULL,
  measurement_quality TEXT NOT NULL,

  account_id TEXT,
  project_id TEXT,
  client_id  TEXT,
  model      TEXT,

  occurred_at  TEXT,
  period_start TEXT,
  period_end   TEXT,

  raw_usage TEXT NOT NULL DEFAULT '{}',

  input_total       INTEGER,
  output_total      INTEGER,
  total_reported    INTEGER,
  cached_input      INTEGER,
  reasoning_output  INTEGER,
  cache_write_input INTEGER,

  normalization_basis TEXT NOT NULL,
  normalization_notes TEXT NOT NULL DEFAULT '[]',

  source_ref     TEXT,
  adapter_version TEXT,
  coverage_scope  TEXT,

  provider_request_id TEXT,
  meter_kind          TEXT NOT NULL,

  -- 批次重放幂等键（INV-05）
  dedupe_key          TEXT NOT NULL UNIQUE,
  -- 跨来源同一请求的身份键（INV-06）
  identity_key        TEXT NOT NULL,
  identity_confidence TEXT NOT NULL,

  -- 只有 is_primary = 1 且 duplicate_status 未被标记为待确认的记录进入统计（INV-04）
  is_primary       INTEGER NOT NULL DEFAULT 1,
  duplicate_status TEXT NOT NULL DEFAULT 'none',
  duplicate_of     TEXT,
  duplicate_resolved_at TEXT,
  duplicate_resolved_by TEXT,

  import_job_id      TEXT,
  row_index          INTEGER,
  file_fingerprint   TEXT,
  content_fingerprint TEXT,

  observed_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  is_demo     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_usage_identity ON usage_observation(identity_key);
CREATE INDEX ix_usage_scope    ON usage_observation(account_id, project_id, occurred_at);
CREATE INDEX ix_usage_primary  ON usage_observation(is_primary, kind);
CREATE INDEX ix_usage_request  ON usage_observation(account_id, provider_request_id, meter_kind);

-- 钱。不表达 token（§5.1）。
CREATE TABLE charge (
  id              TEXT PRIMARY KEY,
  account_id      TEXT,
  subscription_id TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('subscription','api','extra','refund')),
  amount_minor    TEXT NOT NULL,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL,
  period_start    TEXT,
  period_end      TEXT,
  paid_at         TEXT,
  billing_ref     TEXT,

  collection_method   TEXT NOT NULL,
  measurement_quality TEXT NOT NULL DEFAULT 'provider_reported',
  source_ref          TEXT,

  dedupe_key   TEXT NOT NULL UNIQUE,
  import_job_id TEXT,
  note         TEXT,

  observed_at TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  is_demo     INTEGER NOT NULL DEFAULT 0
);

-- INV-09 / U06：同一订阅、同一周期内固定月费只允许记一次。
-- 合并订阅到多个客户端时不会因此多记一笔账。
CREATE UNIQUE INDEX ux_charge_subscription_period
  ON charge(subscription_id, period_start)
  WHERE kind = 'subscription' AND status <> 'void' AND subscription_id IS NOT NULL;

-- 同一笔账单不会被重复记账（账单与请求明细通过 billing_ref 对账，§5.4）
CREATE UNIQUE INDEX ux_charge_billing_ref
  ON charge(billing_ref)
  WHERE billing_ref IS NOT NULL AND status <> 'void';

CREATE INDEX ix_charge_scope ON charge(account_id, kind, period_start);

-- 额度是状态，不是流水。它不参与任何求和（INV-03）。
CREATE TABLE quota_snapshot (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES billing_account(id) ON DELETE CASCADE,
  bucket_id      TEXT NOT NULL,
  bucket_label   TEXT NOT NULL,
  scope          TEXT,
  window_kind    TEXT NOT NULL,
  window_seconds INTEGER,

  used_ratio      REAL,
  remaining_ratio REAL,

  used_amount_minor TEXT,
  limit_minor       TEXT,
  currency          TEXT,

  reset_at    TEXT,
  observed_at TEXT NOT NULL,

  measurement_quality TEXT NOT NULL,
  collection_method   TEXT NOT NULL,
  source_ref          TEXT,
  adapter_version     TEXT,
  stale_after_seconds INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  is_demo    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_quota_latest ON quota_snapshot(account_id, bucket_id, observed_at DESC);

-- ============================================================================
-- 记忆
-- ============================================================================

CREATE TABLE source (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  external_id         TEXT,
  locator             TEXT,
  local_material_path TEXT,
  content_fingerprint TEXT,
  retention           TEXT NOT NULL DEFAULT 'keep',
  created_at          TEXT NOT NULL,
  is_demo             INTEGER NOT NULL DEFAULT 0
);

-- 正式记忆：这里只放「当前版本」。历史版本全部在 memory_revision。
CREATE TABLE memory (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('global','project','session')),
  project_id    TEXT,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,

  status  TEXT NOT NULL CHECK (status IN ('active','superseded','archived','expired','deleted')),
  version INTEGER NOT NULL,

  sensitivity  TEXT NOT NULL,
  verification TEXT NOT NULL,
  review_after TEXT,
  pinned       INTEGER NOT NULL DEFAULT 0,

  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,

  source_id  TEXT,
  -- 被这条记忆替代掉的那条（替代关系轴）
  supersedes_id TEXT,
  origin_proposal_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_demo    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_memory_scope ON memory(scope, project_id, status, kind);
CREATE INDEX ix_memory_status ON memory(status, updated_at DESC);

-- 记忆历史。每次版本变更都追加一行，**包括当前版本**。
-- memory 是「当前状态的索引」，memory_revision 是「不可变历史」，两者职责不同。
CREATE TABLE memory_revision (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,

  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  project_id  TEXT,
  sensitivity TEXT NOT NULL,
  verification TEXT NOT NULL,
  review_after TEXT,
  status      TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,

  change_kind TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL,
  note        TEXT,
  source_id   TEXT,

  UNIQUE (memory_id, version)
);

CREATE INDEX ix_revision_memory ON memory_revision(memory_id, version DESC);

-- 候选。正式记忆只能由审核通过的动作产生（INV-10）。
CREATE TABLE memory_proposal (
  id               TEXT PRIMARY KEY,
  operation        TEXT NOT NULL CHECK (operation IN ('create','update','archive')),
  target_memory_id TEXT,
  base_version     INTEGER,

  scope       TEXT NOT NULL,
  project_id  TEXT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  verification TEXT NOT NULL,
  review_after TEXT,

  source_kind    TEXT NOT NULL,
  source_ref     TEXT,
  evidence_quote TEXT,
  evidence_status TEXT NOT NULL,

  submitted_by_client_id TEXT,

  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','conflict')),
  content_hash TEXT NOT NULL,
  -- 与已有候选内容完全相同时的合并建议（仅建议，不自动合并）
  duplicate_of_proposal_id TEXT,
  -- 语义近似的提示（仅提示，不自动删除）
  similarity_note TEXT,

  conflict_detail TEXT,
  review_note     TEXT,
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  -- 批准时用户可能微调过正文，保留最终版本以便与提案原文对比
  reviewed_title   TEXT,
  reviewed_content TEXT,

  resulting_memory_id TEXT,
  resulting_version   INTEGER,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_demo    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_proposal_status ON memory_proposal(status, created_at DESC);
CREATE INDEX ix_proposal_hash   ON memory_proposal(content_hash);
CREATE INDEX ix_proposal_target ON memory_proposal(target_memory_id, base_version);

-- 删除后留下的最小墓碑：只存哈希，**不存正文**（INV-12）。
-- 作用：旧导入包再次导入时不能把已删除的记忆悄悄复活。
CREATE TABLE memory_tombstone (
  memory_id    TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  title_hash   TEXT NOT NULL,
  scope        TEXT NOT NULL,
  project_id   TEXT,
  kind         TEXT NOT NULL,
  deleted_at   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  deleted_by   TEXT NOT NULL
);

CREATE INDEX ix_tombstone_hash ON memory_tombstone(content_hash);

-- ============================================================================
-- 导入 / 集成 / 导出 / 凭据 / 审计
-- ============================================================================

CREATE TABLE import_job (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  adapter_id     TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  file_fingerprint TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('precheck','running','completed','failed','cancelled','rejected')),
  cursor TEXT,

  total_rows    INTEGER NOT NULL DEFAULT 0,
  accepted_rows INTEGER NOT NULL DEFAULT 0,
  replayed_rows INTEGER NOT NULL DEFAULT 0,
  evidence_rows INTEGER NOT NULL DEFAULT 0,
  suspect_rows  INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,

  warnings     TEXT NOT NULL DEFAULT '[]',
  error_report TEXT NOT NULL DEFAULT '[]',

  dry_run    INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  project_id TEXT,
  client_id  TEXT,

  started_at  TEXT NOT NULL,
  finished_at TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_import_fingerprint ON import_job(kind, file_fingerprint, started_at DESC);

-- 能力登记：区分「官方文档说支持」和「本机已验证」（§3.1）
CREATE TABLE integration (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL,
  transport         TEXT NOT NULL,
  auth_mode         TEXT NOT NULL,
  client_version    TEXT,
  capability_status TEXT NOT NULL CHECK (capability_status IN ('documented','verified','unsupported','unknown')),
  capability_detail TEXT NOT NULL DEFAULT '{}',
  evidence          TEXT,
  verified_at       TEXT,
  last_success_at   TEXT,
  env_requirement   TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  is_demo           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE context_export (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  task           TEXT,
  budget_kind    TEXT NOT NULL,
  budget_tokens  INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  token_count_kind TEXT NOT NULL,

  manifest          TEXT NOT NULL,
  dropped_count     INTEGER NOT NULL,
  excluded_by_policy INTEGER NOT NULL,
  warnings          TEXT NOT NULL DEFAULT '[]',

  content_markdown TEXT NOT NULL,
  content_json     TEXT NOT NULL,
  file_path        TEXT,
  -- JSON 数组：[{memory_id, version}]，用于记忆变更后标记哪些包已失效
  memory_refs      TEXT NOT NULL DEFAULT '[]',

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  invalidated_at     TEXT,
  invalidated_reason TEXT,
  is_demo    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_context_project ON context_export(project_id, created_at DESC);

-- MCP 客户端凭据。只存哈希（INV-15）。
-- scopes 里不可能出现审批 / 删除 / 连接管理类动作，因为枚举里根本没有（§11.2）。
CREATE TABLE api_credential (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  project_ids  TEXT,
  scopes       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_used_at TEXT,
  is_demo      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_credential_hash ON api_credential(token_hash);

-- 审计：默认只记动作与 ID，不复制被删敏感全文（§14.1）
CREATE TABLE audit_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_kind  TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  version     INTEGER,
  result      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '{}',
  request_id  TEXT,
  is_demo     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_audit_at ON audit_event(at DESC);
CREATE INDEX ix_audit_entity ON audit_event(entity_type, entity_id, at DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: M1_INIT },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
