/**
 * 登记类仓储：客户端、账户、订阅、项目、会话。
 *
 * 仓储层只负责「行 ↔ 领域对象」的翻译和 SQL，不含业务规则。
 * 规则判断（版本冲突、去重决策、权限过滤）在 services 里。
 */

import { newId, nowIso, type ClientKind, type CollectionMethod, type MeasurementQuality } from '@aicc/core';
import type { DbConnection } from '../database.js';
import { workspaceClause, type WorkspaceScope } from './workspace.js';

/**
 * 登记数据的读取范围。`includeDemo` 是 M0 时已有的内部调用约定：
 * true 表示不过滤。保留它，避免备份/诊断等旧调用方改变语义；新的 HTTP
 * 读取一律传 workspace，以区分 real / demo / all。
 */
export interface RegistryListOptions {
  workspace?: WorkspaceScope;
  includeDemo?: boolean;
}

function registryWorkspace(options: RegistryListOptions): WorkspaceScope {
  return options.workspace ?? (options.includeDemo ? 'all' : 'real');
}

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

export interface Client {
  id: string;
  kind: ClientKind;
  displayName: string;
  clientVersion: string | null;
  mcpProfile: string | null;
  /** null = 未限定范围。 */
  allowedProjects: string[] | null;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface ClientRow {
  id: string;
  kind: string;
  display_name: string;
  client_version: string | null;
  mcp_profile: string | null;
  allowed_projects: string | null;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    kind: row.kind as ClientKind,
    displayName: row.display_name,
    clientVersion: row.client_version,
    mcpProfile: row.mcp_profile,
    allowedProjects: row.allowed_projects ? (JSON.parse(row.allowed_projects) as string[]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

export function createClient(
  db: DbConnection,
  input: {
    kind: ClientKind;
    displayName: string;
    clientVersion?: string | null;
    mcpProfile?: string | null;
    allowedProjects?: string[] | null;
    isDemo?: boolean;
  },
): Client {
  const id = newId('client');
  const at = nowIso();
  db.prepare(
    `INSERT INTO client (id, kind, display_name, client_version, mcp_profile, allowed_projects, created_at, updated_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.displayName,
    input.clientVersion ?? null,
    input.mcpProfile ?? null,
    input.allowedProjects ? JSON.stringify(input.allowedProjects) : null,
    at,
    at,
    input.isDemo ? 1 : 0,
  );
  return getClient(db, id) as Client;
}

export function getClient(db: DbConnection, id: string): Client | undefined {
  const row = db.prepare('SELECT * FROM client WHERE id = ?').get<ClientRow>(id);
  return row ? toClient(row) : undefined;
}

export function listClients(
  db: DbConnection,
  options: RegistryListOptions = {},
): Client[] {
  const rows = db
    .prepare(`SELECT * FROM client WHERE ${workspaceClause(registryWorkspace(options))} ORDER BY created_at`)
    .all<ClientRow>();
  return rows.map(toClient);
}

/* ------------------------------------------------------------------ */
/* 计费账户                                                            */
/* ------------------------------------------------------------------ */

export interface BillingAccount {
  id: string;
  provider: string;
  alias: string;
  accountRef: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface AccountRow {
  id: string;
  provider: string;
  alias: string;
  account_ref: string | null;
  currency: string;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toAccount(row: AccountRow): BillingAccount {
  return {
    id: row.id,
    provider: row.provider,
    alias: row.alias,
    accountRef: row.account_ref,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

export function createAccount(
  db: DbConnection,
  input: { provider: string; alias: string; accountRef?: string | null; currency: string; isDemo?: boolean },
): BillingAccount {
  const id = newId('account');
  const at = nowIso();
  db.prepare(
    `INSERT INTO billing_account (id, provider, alias, account_ref, currency, created_at, updated_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.provider, input.alias, input.accountRef ?? null, input.currency, at, at, input.isDemo ? 1 : 0);
  return getAccount(db, id) as BillingAccount;
}

export function getAccount(db: DbConnection, id: string): BillingAccount | undefined {
  const row = db.prepare('SELECT * FROM billing_account WHERE id = ?').get<AccountRow>(id);
  return row ? toAccount(row) : undefined;
}

export function listAccounts(db: DbConnection, options: RegistryListOptions = {}): BillingAccount[] {
  const rows = db
    .prepare(`SELECT * FROM billing_account WHERE ${workspaceClause(registryWorkspace(options))} ORDER BY created_at`)
    .all<AccountRow>();
  return rows.map(toAccount);
}

/* ------------------------------------------------------------------ */
/* 订阅                                                                */
/* ------------------------------------------------------------------ */

export interface Subscription {
  id: string;
  name: string;
  accountId: string | null;
  plan: string | null;
  priceMinor: string;
  currency: string;
  billingCycle: 'monthly' | 'yearly' | 'other';
  periodStart: string | null;
  periodEnd: string | null;
  renewAt: string | null;
  status: 'active' | 'cancelled' | 'unknown';
  clientIds: string[];
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface SubscriptionRow {
  id: string;
  name: string;
  account_id: string | null;
  plan: string | null;
  price_minor: string;
  currency: string;
  billing_cycle: string;
  period_start: string | null;
  period_end: string | null;
  renew_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toSubscription(row: SubscriptionRow, clientIds: string[]): Subscription {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    plan: row.plan,
    priceMinor: row.price_minor,
    currency: row.currency,
    billingCycle: row.billing_cycle as Subscription['billingCycle'],
    periodStart: row.period_start,
    periodEnd: row.period_end,
    renewAt: row.renew_at,
    status: row.status as Subscription['status'],
    clientIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

function clientIdsFor(db: DbConnection, subscriptionId: string): string[] {
  return db
    .prepare('SELECT client_id FROM subscription_client WHERE subscription_id = ? ORDER BY client_id')
    .all<{ client_id: string }>(subscriptionId)
    .map((r) => r.client_id);
}

export function createSubscription(
  db: DbConnection,
  input: {
    name: string;
    accountId?: string | null;
    plan?: string | null;
    priceMinor: string;
    currency: string;
    billingCycle: Subscription['billingCycle'];
    periodStart?: string | null;
    periodEnd?: string | null;
    renewAt?: string | null;
    status?: Subscription['status'];
    clientIds?: string[];
    isDemo?: boolean;
  },
): Subscription {
  const id = newId('subscription');
  const at = nowIso();
  db.prepare(
    `INSERT INTO subscription
       (id, name, account_id, plan, price_minor, currency, billing_cycle, period_start, period_end, renew_at, status, created_at, updated_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.accountId ?? null,
    input.plan ?? null,
    input.priceMinor,
    input.currency,
    input.billingCycle,
    input.periodStart ?? null,
    input.periodEnd ?? null,
    input.renewAt ?? null,
    input.status ?? 'active',
    at,
    at,
    input.isDemo ? 1 : 0,
  );

  for (const clientId of input.clientIds ?? []) {
    db.prepare('INSERT OR IGNORE INTO subscription_client (subscription_id, client_id) VALUES (?, ?)').run(id, clientId);
  }

  return getSubscription(db, id) as Subscription;
}

export function getSubscription(db: DbConnection, id: string): Subscription | undefined {
  const row = db.prepare('SELECT * FROM subscription WHERE id = ?').get<SubscriptionRow>(id);
  return row ? toSubscription(row, clientIdsFor(db, id)) : undefined;
}

export function listSubscriptions(db: DbConnection, options: RegistryListOptions = {}): Subscription[] {
  const rows = db
    .prepare(`SELECT * FROM subscription WHERE ${workspaceClause(registryWorkspace(options))} ORDER BY created_at`)
    .all<SubscriptionRow>();
  return rows.map((r) => toSubscription(r, clientIdsFor(db, r.id)));
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

export interface Project {
  id: string;
  title: string;
  goal: string | null;
  status: 'active' | 'paused' | 'archived';
  handoffSummary: string | null;
  repoAlias: string | null;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
}

interface ProjectRow {
  id: string;
  title: string;
  goal: string | null;
  status: string;
  handoff_summary: string | null;
  repo_alias: string | null;
  created_at: string;
  updated_at: string;
  is_demo: number;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    status: row.status as Project['status'],
    handoffSummary: row.handoff_summary,
    repoAlias: row.repo_alias,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: row.is_demo === 1,
  };
}

export function createProject(
  db: DbConnection,
  input: {
    title: string;
    goal?: string | null;
    status?: Project['status'];
    handoffSummary?: string | null;
    repoAlias?: string | null;
    isDemo?: boolean;
    id?: string;
  },
): Project {
  const id = input.id ?? newId('project');
  const at = nowIso();
  db.prepare(
    `INSERT INTO project (id, title, goal, status, handoff_summary, repo_alias, created_at, updated_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title,
    input.goal ?? null,
    input.status ?? 'active',
    input.handoffSummary ?? null,
    input.repoAlias ?? null,
    at,
    at,
    input.isDemo ? 1 : 0,
  );
  return getProject(db, id) as Project;
}

export function updateProject(
  db: DbConnection,
  id: string,
  patch: Partial<Pick<Project, 'title' | 'goal' | 'status' | 'handoffSummary' | 'repoAlias'>>,
): Project | undefined {
  const existing = getProject(db, id);
  if (!existing) return undefined;
  const at = nowIso();
  db.prepare(
    `UPDATE project SET title = ?, goal = ?, status = ?, handoff_summary = ?, repo_alias = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.title ?? existing.title,
    patch.goal !== undefined ? patch.goal : existing.goal,
    patch.status ?? existing.status,
    patch.handoffSummary !== undefined ? patch.handoffSummary : existing.handoffSummary,
    patch.repoAlias !== undefined ? patch.repoAlias : existing.repoAlias,
    at,
    id,
  );
  return getProject(db, id);
}

export function getProject(db: DbConnection, id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get<ProjectRow>(id);
  return row ? toProject(row) : undefined;
}

export function listProjects(db: DbConnection, options: RegistryListOptions = {}): Project[] {
  const rows = db
    .prepare(`SELECT * FROM project WHERE ${workspaceClause(registryWorkspace(options))} ORDER BY created_at`)
    .all<ProjectRow>();
  return rows.map(toProject);
}

export function findProjectByTitle(db: DbConnection, title: string): Project | undefined {
  const row = db.prepare('SELECT * FROM project WHERE title = ? LIMIT 1').get<ProjectRow>(title);
  return row ? toProject(row) : undefined;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export interface SessionRecord {
  id: string;
  projectId: string | null;
  clientId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sourceSessionId: string | null;
  summary: string | null;
  createdAt: string;
  isDemo: boolean;
}

interface SessionRow {
  id: string;
  project_id: string | null;
  client_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  source_session_id: string | null;
  summary: string | null;
  created_at: string;
  is_demo: number;
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    clientId: row.client_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sourceSessionId: row.source_session_id,
    summary: row.summary,
    createdAt: row.created_at,
    isDemo: row.is_demo === 1,
  };
}

export function createSession(
  db: DbConnection,
  input: {
    projectId?: string | null;
    clientId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    sourceSessionId?: string | null;
    summary?: string | null;
    isDemo?: boolean;
  },
): SessionRecord {
  const id = newId('session');
  const at = nowIso();
  db.prepare(
    `INSERT INTO session (id, project_id, client_id, started_at, ended_at, source_session_id, summary, created_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.clientId ?? null,
    input.startedAt ?? null,
    input.endedAt ?? null,
    input.sourceSessionId ?? null,
    input.summary ?? null,
    at,
    input.isDemo ? 1 : 0,
  );
  return getSession(db, id) as SessionRecord;
}

export function getSession(db: DbConnection, id: string): SessionRecord | undefined {
  const row = db.prepare('SELECT * FROM session WHERE id = ?').get<SessionRow>(id);
  return row ? toSession(row) : undefined;
}

export function listSessions(db: DbConnection, projectId?: string): SessionRecord[] {
  const rows = projectId
    ? db.prepare('SELECT * FROM session WHERE project_id = ? ORDER BY created_at DESC').all<SessionRow>(projectId)
    : db.prepare('SELECT * FROM session WHERE is_demo = 0 ORDER BY created_at DESC LIMIT 200').all<SessionRow>();
  return rows.map(toSession);
}

/** 供审计与统计使用的轻量描述。 */
export function describeCollector(method: CollectionMethod, quality: MeasurementQuality): string {
  return `${method} / ${quality}`;
}
