/**
 * API 客户端。
 *
 * 三件事：
 * 1. 所有写操作都带上 `x-aicc-request: 1`（服务端的 CSRF 防护要求）。
 * 2. 统一把服务端的 `{ error: { code, message, details } }` 转成异常，界面不需要各自判断形状。
 * 3. 401 时抛出专门的类型，让上层切到配对界面，而不是显示一堆「加载失败」。
 */

const CSRF_HEADER = 'x-aicc-request';

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

export class UnauthenticatedError extends ApiError {
  constructor(message: string) {
    super(401, 'unauthenticated', message);
    this.name = 'UnauthenticatedError';
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers[CSRF_HEADER] = '1';
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const envelope = parsed as { error?: { code?: string; message?: string; details?: unknown } } | null;
    const code = envelope?.error?.code ?? 'unknown';
    const message = envelope?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) throw new UnauthenticatedError(message);
    throw new ApiError(response.status, code, message, envelope?.error?.details);
  }

  return parsed as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T,>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/* ------------------------------------------------------------------ */
/* 与服务端响应对应的类型（只声明界面真正用到的字段）                    */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  authenticated: boolean;
  kind?: 'user' | 'credential';
  label?: string;
  scopes?: string[] | 'user-session';
  projectScope?: string[] | null;
  forbiddenActions?: string[];
  hint?: string;
}

export interface SelfCheck {
  schemaVersion: number;
  driver: string;
  driverAttempts: Array<{ driver: string; ok: boolean; error?: string }>;
  dataDir: string;
  dbFile: string;
  backupDir: string;
  webBuilt: boolean;
  migrationsApplied: number[];
  counts: Record<string, number>;
  realCounts: Record<string, number>;
  nodeVersion: string;
  platform: string;
  activeSessions: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface MoneyBucket {
  currency: string;
  amountMinor: string;
  count: number;
}

export interface ChargeBuckets {
  paid: MoneyBucket[];
  pending: MoneyBucket[];
  refunded: MoneyBucket[];
  estimated: MoneyBucket[];
  notes: string[];
}

export interface QuotaBucket {
  accountId: string;
  bucketId: string;
  bucketLabel: string;
  snapshotId: string;
  scope: string | null;
  windowKind: string;
  windowSeconds: number | null;
  sharedWith: string[];
  freshness: 'fresh' | 'stale' | 'pending_refresh' | 'unknown';
  stateLabel: string;
  reasons: string[];
  ageSeconds: number | null;
  untilResetSeconds: number | null;
  inconsistent: boolean;
  ratioAuthoritative: boolean;
  usedRatio: number | null;
  remainingRatio: number | null;
  usedAmountMinor: string | null;
  limitMinor: string | null;
  currency: string | null;
  resetAt: string | null;
  observedAt: string;
  measurementQuality: string;
  collectionMethod: string;
  sourceRef: string | null;
}

export interface Overview {
  generatedAt: string;
  driver: string;
  dataDir: string;
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
  charges: ChargeBuckets;
  quota: {
    groups: Array<{ windowKind: string; windowLabel: string; buckets: QuotaBucket[] }>;
    needsAttention: number;
    states: Array<{ state: string; label: string; count: number }>;
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
  disclaimers: Record<string, string>;
}

export interface UsageObservation {
  id: string;
  kind: string;
  collectionMethod: string;
  measurementQuality: string;
  accountId: string | null;
  projectId: string | null;
  clientId: string | null;
  model: string | null;
  occurredAt: string | null;
  rawUsage: Record<string, unknown>;
  inputTotal: number | null;
  outputTotal: number | null;
  totalReported: number | null;
  cachedInput: number | null;
  reasoningOutput: number | null;
  normalizationBasis: string;
  normalizationNotes: string[];
  providerRequestId: string | null;
  identityConfidence: string;
  isPrimary: boolean;
  duplicateStatus: string;
  duplicateOf: string | null;
  coverageScope: string | null;
  observedAt: string;
}

export interface UsageTotals {
  tokenValue: number | null;
  partial: boolean;
  knownCount: number;
  unknownCount: number;
  coverage: string;
  byModel: Array<{ model: string | null; value: number | null; count: number }>;
  byProject: Array<{ projectId: string | null; value: number | null; count: number }>;
  byClient: Array<{ clientId: string | null; value: number | null; count: number }>;
  suspectCount: number;
}

export interface Charge {
  id: string;
  accountId: string | null;
  subscriptionId: string | null;
  kind: string;
  amountMinor: string;
  currency: string;
  status: string;
  periodStart: string | null;
  paidAt: string | null;
  billingRef: string | null;
  collectionMethod: string;
  measurementQuality: string;
  note: string | null;
}

export interface ImportOutcome {
  jobId: string;
  status: string;
  fileName: string;
  fileFingerprint: string;
  dryRun: boolean;
  totalRows: number;
  acceptedRows: number;
  replayedRows: number;
  evidenceRows: number;
  suspectRows: number;
  rejectedRows: number;
  warnings: string[];
  errors: Array<{ row: number; message: string }>;
  previousImport: { jobId: string; finishedAt: string | null; acceptedRows: number } | null;
  note: string;
}

export interface ClientRecord {
  id: string;
  kind: string;
  displayName: string;
  clientVersion: string | null;
  allowedProjects: string[] | null;
}

export interface AccountRecord {
  id: string;
  provider: string;
  alias: string;
  currency: string;
}

export interface SubscriptionRecord {
  id: string;
  name: string;
  accountId: string | null;
  priceMinor: string;
  currency: string;
  billingCycle: string;
  status: string;
  clientIds: string[];
}

export interface ProjectRecord {
  id: string;
  title: string;
  goal: string | null;
  status: string;
  handoffSummary: string | null;
  repoAlias: string | null;
}

export interface MemoryRecord {
  id: string;
  scope: string;
  projectId: string | null;
  kind: string;
  title: string;
  content: string;
  status: string;
  version: number;
  sensitivity: string;
  verification: string;
  pinned: boolean;
  updatedAt: string;
  approvedBy: string;
}

export interface ProposalRecord {
  id: string;
  operation: string;
  targetMemoryId: string | null;
  baseVersion: number | null;
  scope: string;
  projectId: string | null;
  kind: string;
  title: string;
  content: string;
  sensitivity: string;
  verification: string;
  sourceKind: string;
  sourceRef: string | null;
  evidenceQuote: string | null;
  evidenceStatus: string;
  status: string;
  conflictDetail: string | null;
  similarityNote: string | null;
  duplicateOfProposalId: string | null;
  createdAt: string;
}

export interface IntegrationRecord {
  id: string;
  name: string;
  category: string;
  transport: string;
  authMode: string;
  capabilityStatus: string;
  capabilityDetail: Record<string, unknown>;
  evidence: string | null;
  verifiedAt: string | null;
  lastSuccessAt: string | null;
  envRequirement: string | null;
  notes: string | null;
}

export interface ContextExportSummary {
  id: string;
  projectId: string;
  task: string | null;
  budgetKind: string;
  budgetTokens: number;
  estimatedTokens: number;
  droppedCount: number;
  excludedByPolicy: number;
  createdAt: string;
  invalidatedAt: string | null;
  invalidatedReason: string | null;
  itemCount: number;
}

export interface BackupListing {
  name: string;
  dir: string;
  createdAt: string;
  schemaVersion: number;
  bytes: number;
  counts: Record<string, number>;
  integrity: 'ok' | 'checksum_mismatch' | 'manifest_missing' | 'file_missing';
}
