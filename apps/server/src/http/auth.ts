/**
 * 本地会话与凭据（设计稿 §11.1 / §14）。
 *
 * 三个必须做对的地方：
 *
 * 1. **配对，而不是默认放行。** 服务启动时在终端打印一次性配对码，浏览器用配对码
 *    换一个 HttpOnly 的会话 Cookie。这样「随便一个网页调你的 localhost」不会直接成功。
 * 2. **Origin / Host 校验。** 配合下面的 CSRF 头，挡住恶意页面发起的跨站写请求（R03）。
 * 3. **代理凭据的权限面在类型层面就受限。** 审批、删除、连接管理这些动作根本不在
 *    `CREDENTIAL_SCOPES` 里，所以一个 coding agent 手里的凭据不可能调用它们（M03 / §11.2）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Session {
  id: string;
  tokenHash: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export type PairResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; reason: 'bad_code' | 'rate_limited'; retryAfterMs?: number; remaining?: number };

const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;

/** 配对码用可读字符集，避免 0/O、1/I 混淆 —— 它是要人肉抄的。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  return out;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 定长时间比较，避免用配对码的响应时间做逐字符爆破。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private pairingCode: string;
  private attempts: number[] = [];

  constructor(private readonly ttlMs: number = 12 * 60 * 60 * 1000) {
    this.pairingCode = generateCode();
  }

  /** 启动时打印到终端的配对码。 */
  get code(): string {
    return this.pairingCode;
  }

  rotatePairingCode(): string {
    this.pairingCode = generateCode();
    this.attempts = [];
    return this.pairingCode;
  }

  pair(code: string, label = '本机浏览器'): PairResult {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < PAIRING_WINDOW_MS);

    if (this.attempts.length >= PAIRING_MAX_ATTEMPTS) {
      const oldest = this.attempts[0] as number;
      return { ok: false, reason: 'rate_limited', retryAfterMs: PAIRING_WINDOW_MS - (now - oldest) };
    }

    if (!safeEqual(code.trim().toUpperCase(), this.pairingCode)) {
      this.attempts.push(now);
      return { ok: false, reason: 'bad_code', remaining: PAIRING_MAX_ATTEMPTS - this.attempts.length };
    }

    const token = `aicc_sess_${randomBytes(32).toString('hex')}`;
    const session: Session = {
      id: `ses_${randomBytes(8).toString('hex')}`,
      tokenHash: hashToken(token),
      label,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
    };
    this.sessions.set(session.tokenHash, session);
    this.attempts = [];

    // 配对成功后立刻换一个新的配对码：一次性使用，避免同一个码被反复利用。
    this.pairingCode = generateCode();

    return { ok: true, token, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  verify(token: string): Session | null {
    const hash = hashToken(token);
    const session = this.sessions.get(hash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(hash);
      return null;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  revoke(token: string): boolean {
    return this.sessions.delete(hashToken(token));
  }

  revokeAll(): number {
    const n = this.sessions.size;
    this.sessions.clear();
    return n;
  }

  count(): number {
    return this.sessions.size;
  }
}

/* ------------------------------------------------------------------ */
/* 主体                                                                */
/* ------------------------------------------------------------------ */

export interface UserPrincipal {
  kind: 'user';
  label: string;
  sessionId: string;
  /** 用户本机会话不受项目范围限制。 */
  projectIds: null;
  scopes: null;
}

export interface CredentialPrincipal {
  kind: 'credential';
  credentialId: string;
  clientId: string;
  label: string;
  projectIds: string[] | null;
  scopes: readonly string[];
}

export type Principal = UserPrincipal | CredentialPrincipal;

/**
 * 代理凭据**不可能**拥有的动作。
 *
 * 这份清单是第二道闸门：即使某天有人不小心给凭据加了一个宽泛的 scope，
 * 这些动作依然会被拒绝。第一道闸门是 `CREDENTIAL_SCOPES` 枚举本身不包含它们。
 */
export const CREDENTIAL_FORBIDDEN_ACTIONS = new Set([
  'proposal_review',
  'memory_delete',
  'memory_restore',
  'connection_manage',
  'credential_manage',
  'backup_restore',
  'project_manage',
  'demo_reset',
]);

export function isUser(principal: Principal): principal is UserPrincipal {
  return principal.kind === 'user';
}

export function hasScope(principal: Principal, scope: string): boolean {
  if (principal.kind === 'user') return true;
  return principal.scopes.includes(scope);
}

/** 凭据可见的项目范围。null 表示不限定（仅本机用户会这样）。 */
export function principalProjectScope(principal: Principal): string[] | null {
  return principal.kind === 'user' ? null : principal.projectIds;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}

export const SESSION_COOKIE = 'aicc_session';
