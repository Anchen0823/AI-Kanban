/**
 * Codex 用量接口的只读适配器（§3.2 / §12）。
 *
 * 设计稿 §3.2 列了三个可探测项，本机实测（codex-cli 0.130.0，用
 * `codex app-server generate-json-schema` 导出的官方协议定义核对）的真实情况是：
 *
 * | 设计稿写的 | 0.130.0 的实际状态 | 本适配器的处理 |
 * |---|---|---|
 * | `account/rateLimits/read` | **存在**，是可查询请求 | 探测并采集为额度快照 |
 * | `account/usage/read` | **不存在**（不在合法方法枚举里） | 记为 unsupported，把方法列表作为证据 |
 * | `thread/tokenUsage/updated` | 存在，但是**通知**不是查询接口 | 只记录「是否在探测期间收到过」，不当采集源 |
 *
 * 这个差异本身就是 M1 的价值：§3 开头就写明「官方资料不等于在用户的版本上实测通过」。
 *
 * 三态判定刻意分得很细，因为把「环境问题」误报成「不支持」会让用户永远不再试：
 * - 方法不在协议里 → `unsupported`（有方法枚举为证）
 * - 方法存在但这次调用失败（网络、未登录） → `unknown`，并写清原因
 * - 真的拿到了数据 → `verified`，证据必须能复现
 */

import {
  CodexAppServer,
  extractMethodList,
  readCodexVersion,
  type AppServerHandshake,
  type CallOutcome,
} from './codex-app-server.js';
import type { CapabilityStatus, QuotaWindowKind } from '@aicc/core';

export const CODEX_ADAPTER_ID = 'codex-app-server';
export const CODEX_ADAPTER_VERSION = '0.1.0';

/** 设计稿 §3.2 提到的三个方法，逐个记录本机实测结论。 */
export const DOCUMENTED_METHODS = ['account/rateLimits/read', 'account/usage/read', 'thread/tokenUsage/updated'] as const;

export interface QuotaSnapshotDraft {
  bucketId: string;
  bucketLabel: string;
  scope: string | null;
  windowKind: QuotaWindowKind;
  windowSeconds: number | null;
  usedRatio: number;
  remainingRatio: number;
  resetAt: string | null;
  sourceRef: string;
}

export interface CodexCapabilityReport {
  status: CapabilityStatus;
  clientVersion: string | null;
  transport: string;
  authMode: string;
  /** 可复现的证据：命令、版本、方法结论、返回样例。 */
  evidence: string;
  detail: Record<string, unknown>;
  notes: string;
}

export interface CodexProbeResult {
  report: CodexCapabilityReport;
  quotaSnapshots: QuotaSnapshotDraft[];
  warnings: string[];
}

export interface CodexAdapterOptions {
  command?: string;
  timeoutMs?: number;
  /** 便于测试注入一个假的 app-server。 */
  env?: Record<string, string>;
  /** 注入子进程启动方式：测试用「真子进程 + 假可执行文件」。 */
  spawnImpl?: typeof import("node:child_process").spawn;
}

/** 邮箱脱敏。账号身份有用，但完整地址不需要进库、备份和导出。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const name = email.slice(0, at);
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}***${email.slice(at)}`;
}

/**
 * 窗口时长 → 窗口类型。
 *
 * 只对**恰好等于**常见周期的情况给出确定答案：codex 的主窗口是 5 小时，
 * 把它归成 "hourly" 会让人以为是每小时重置。落不到常见周期就标 custom 并带上秒数。
 */
export function classifyWindow(minutes: number | null | undefined): { kind: QuotaWindowKind; seconds: number | null; label: string } {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return { kind: 'custom', seconds: null, label: '窗口长度未知' };
  }
  const seconds = Math.round(minutes * 60);
  if (minutes === 60) return { kind: 'hourly', seconds, label: '1 小时' };
  if (minutes === 24 * 60) return { kind: 'daily', seconds, label: '1 天' };
  if (minutes === 7 * 24 * 60) return { kind: 'weekly', seconds, label: '1 周' };
  if (minutes === 30 * 24 * 60) return { kind: 'monthly', seconds, label: '30 天' };
  if (minutes % 60 === 0) return { kind: 'custom', seconds, label: `${minutes / 60} 小时` };
  return { kind: 'custom', seconds, label: `${minutes} 分钟` };
}

function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

interface RateLimitWindow {
  usedPercent?: unknown;
  resetsAt?: unknown;
  windowDurationMins?: unknown;
}

interface RateLimitSnapshot {
  limitId?: unknown;
  limitName?: unknown;
  planType?: unknown;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { balance?: unknown; hasCredits?: unknown; unlimited?: unknown } | null;
  rateLimitReachedType?: unknown;
}

function windowToDraft(
  snapshot: RateLimitSnapshot,
  role: 'primary' | 'secondary',
  bucketKey: string,
  bucketName: string,
  window: RateLimitWindow,
): QuotaSnapshotDraft | null {
  const usedPercent = window.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;

  const windowInfo = classifyWindow(typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null);

  /**
   * 两侧都从**整数百分数**算，不要用 `1 - used`。
   *
   * `1 - 0.42` 在 IEEE 754 下是 0.5800000000000001，于是 used + remaining
   * 加起来不等于 1 —— 存进库之后，任何「这两个值互补」的检查都会失败，
   * 而 0.5800000000000001 这种数字出现在界面上也只会让人怀疑系统在瞎算。
   * 用 (100 - p) / 100 得到的两个 double 才是同一套舍入下的互补对。
   */
  const percent = Math.min(Math.max(usedPercent, 0), 100);
  const used = percent / 100;
  const remaining = (100 - percent) / 100;
  const resetAt = unixSecondsToIso(window.resetsAt);
  const limitLabel = typeof snapshot.limitName === 'string' && snapshot.limitName.length > 0 ? snapshot.limitName : bucketName;

  return {
    // bucket_id 必须跨次观测稳定，否则「最新快照」的分组会碎成很多条
    bucketId: `${bucketKey}:${role}`,
    bucketLabel: `${limitLabel} · ${role === 'primary' ? '主窗口' : '次窗口'}（${windowInfo.label}）`,
    scope: typeof snapshot.limitId === 'string' ? `limit_id=${snapshot.limitId}` : null,
    windowKind: windowInfo.kind,
    windowSeconds: windowInfo.seconds,
    usedRatio: used,
    remainingRatio: remaining,
    resetAt,
    sourceRef: 'codex app-server · account/rateLimits/read',
  };
}

/** 把 RateLimitSnapshot 折成额度快照草稿。不产出任何 token 观测 —— 见下方 collect 的说明。 */
export function snapshotsToDrafts(payload: {
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}): QuotaSnapshotDraft[] {
  const drafts: QuotaSnapshotDraft[] = [];

  const perBucket = payload.rateLimitsByLimitId;
  if (perBucket && typeof perBucket === 'object' && Object.keys(perBucket).length > 0) {
    // 多桶视图更全：它按 metered limit_id 分开，正是「一个账户可能有多个额度桶」的真实形状。
    for (const [limitId, snapshot] of Object.entries(perBucket)) {
      const name = typeof snapshot.limitName === 'string' && snapshot.limitName.length > 0 ? snapshot.limitName : `Codex ${limitId}`;
      if (snapshot.primary) {
        const draft = windowToDraft(snapshot, 'primary', limitId, name, snapshot.primary);
        if (draft) drafts.push(draft);
      }
      if (snapshot.secondary) {
        const draft = windowToDraft(snapshot, 'secondary', limitId, name, snapshot.secondary);
        if (draft) drafts.push(draft);
      }
    }
    if (drafts.length > 0) return drafts;
  }

  const single = payload.rateLimits;
  if (single) {
    const name = typeof single.limitName === 'string' && single.limitName.length > 0 ? single.limitName : 'Codex';
    const key = typeof single.limitId === 'string' && single.limitId.length > 0 ? single.limitId : 'codex';
    if (single.primary) {
      const draft = windowToDraft(single, 'primary', key, name, single.primary);
      if (draft) drafts.push(draft);
    }
    if (single.secondary) {
      const draft = windowToDraft(single, 'secondary', key, name, single.secondary);
      if (draft) drafts.push(draft);
    }
  }
  return drafts;
}

function describeOutcome(method: string, outcome: CallOutcome<unknown>): string {
  if (outcome.ok) return `${method} → 成功`;
  if (outcome.kind === 'method_not_supported') return `${method} → 该版本不支持此方法`;
  if (outcome.kind === 'timeout') return `${method} → 超时（${outcome.message}）`;
  return `${method} → 调用失败（code ${outcome.code}）：${outcome.message}`;
}

/** 探测成功但需要判定为「无法判定」时的统一收尾。 */
function unknownReport(input: {
  clientVersion: string | null;
  reasonCode: string;
  reason: string;
  evidence: string;
  detail: Record<string, unknown>;
  warnings: string[];
}): CodexProbeResult {
  return {
    report: {
      status: 'unknown',
      clientVersion: input.clientVersion,
      transport: 'codex app-server（stdio，只读）',
      authMode: '使用 Codex 自己的认证状态，本适配器不接触任何凭据',
      evidence: input.evidence,
      detail: { ...input.detail, reason_code: input.reasonCode, reason: input.reason },
      notes: input.reason,
    },
    quotaSnapshots: [],
    warnings: input.warnings,
  };
}

/**
 * 执行一次只读探测，并顺带把这次能拿到的额度快照一起取回来。
 *
 * 一次进程用完即关：常驻的 app-server 会与用户正在用的 Codex 抢同一份本地状态，
 * 而这次探测的收益不值得那个风险。
 */
export async function probeCodex(options: CodexAdapterOptions = {}): Promise<CodexProbeResult> {
  const warnings: string[] = [];
  const command = options.command ?? 'codex';

  const clientVersion = await readCodexVersion(command, 15_000, options.spawnImpl);
  if (clientVersion === null) {
    // 注意用 unknown 而不是 unsupported：用户的机器上装一个 codex 就会改变结论，
    // 「这个平台不支持」是一个更强的、我们不掌握的断言。
    return unknownReport({
      clientVersion: null,
      reasonCode: 'codex_not_installed',
      reason: `本机没有可用的 codex 可执行文件（尝试的命令：${command}）。无法判定接口能力；手动导入与额度手工录入不受影响。`,
      evidence: `执行 \`${command} --version\` 没有得到版本号。这一步没有产生任何外部请求。`,
      detail: { command, probed_at: new Date().toISOString() },
      warnings,
    });
  }

  const server = CodexAppServer.start({
    command,
    timeoutMs: options.timeoutMs ?? 12_000,
    env: options.env,
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  });
  const methodResults: Record<string, string> = {};

  try {
    let handshake: AppServerHandshake;
    try {
      handshake = await server.initialize();
    } catch (err) {
      return unknownReport({
        clientVersion,
        reasonCode: 'handshake_failed',
        reason: `codex app-server 启动后握手失败：${err instanceof Error ? err.message : String(err)}`,
        evidence: `${clientVersion}\n启动 \`${command} app-server\` 后未能完成 initialize。\nstderr：${server.stderr.slice(-600)}`,
        detail: { command, probed_at: new Date().toISOString() },
        warnings,
      });
    }

    const configWarnings = handshake.notifications.filter((n) => /warning/i.test(n.method));
    for (const warning of configWarnings) {
      // 配置警告会直接导致「MCP 挂不上」这类现象，必须浮出来而不是吞掉。
      const summary = JSON.stringify(warning.params ?? {}).slice(0, 300);
      warnings.push(`codex app-server 报告：${warning.method} ${summary}`);
    }

    // 1) account/read —— 只读，确认登录状态与套餐
    const account = await server.call<{ account?: { type?: string; planType?: string; email?: string } | null; requiresOpenaiAuth?: boolean }>(
      'account/read',
    );
    methodResults['account/read'] = describeOutcome('account/read', account);

    const accountView = account.ok ? account.result.account ?? null : null;
    const accountDetail: Record<string, unknown> = {
      account_read_ok: account.ok,
      requires_openai_auth: account.ok ? (account.result.requiresOpenaiAuth ?? null) : null,
      account_type: accountView?.type ?? null,
      plan_type: accountView?.planType ?? null,
      // 完整邮箱不进库：它没有分析价值，却会跟着备份和导出走。
      account_masked: typeof accountView?.email === 'string' ? maskEmail(accountView.email) : null,
    };

    // 2) account/usage/read —— 设计稿 §3.2 提到它，先确认它到底存不存在
    const usage = await server.call('account/usage/read');
    methodResults['account/usage/read'] = describeOutcome('account/usage/read', usage);
    const methodList = usage.ok || usage.kind !== 'method_not_supported' ? [] : extractMethodList(usage.message);

    // 3) account/rateLimits/read —— 真正可用的那一个
    const limits = await server.call<{ rateLimits?: RateLimitSnapshot | null; rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null }>(
      'account/rateLimits/read',
    );
    methodResults['account/rateLimits/read'] = describeOutcome('account/rateLimits/read', limits);

    // 4) thread/tokenUsage/updated —— 通知，只能看本次有没有收到
    const tokenUsageNotifications = server.handshakeNotifications.filter((n) => n.method === 'thread/tokenUsage/updated');
    methodResults['thread/tokenUsage/updated'] =
      tokenUsageNotifications.length > 0
        ? `thread/tokenUsage/updated → 探测期间收到 ${tokenUsageNotifications.length} 条`
        : 'thread/tokenUsage/updated → 存在但本次未收到（它是通知，且只对活动线程推送，不能当作采集源）';

    const drafts = limits.ok ? snapshotsToDrafts(limits.result ?? {}) : [];
    const evidenceLines = [
      `客户端版本：${clientVersion}`,
      `握手：userAgent=${String(handshake.serverInfo.userAgent ?? '未知')}；codexHome=${String(handshake.serverInfo.codexHome ?? '未知')}`,
      ...DOCUMENTED_METHODS.map((m) => `· ${methodResults[m] ?? '(未探测)'}`),
      `采集到的额度桶：${drafts.length} 个${drafts.length > 0 ? `（${drafts.map((d) => d.bucketId).join('、')}）` : ''}`,
      methodList.length > 0 ? `该版本合法方法数：${methodList.length}；其中含 account/rateLimits/read：${methodList.includes('account/rateLimits/read')}` : '',
    ].filter((l) => l.length > 0);

    const detail: Record<string, unknown> = {
      ...accountDetail,
      probed_at: new Date().toISOString(),
      adapter_version: CODEX_ADAPTER_VERSION,
      documented_methods: [...DOCUMENTED_METHODS],
      method_results: methodResults,
      supports_account_usage_read: usage.ok,
      supports_rate_limits_read: limits.ok,
      legal_method_count: methodList.length || null,
      quota_bucket_count: drafts.length,
      config_warnings: configWarnings.map((w) => ({ method: w.method, params: w.params })),
    };

    if (drafts.length > 0) {
      return {
        report: {
          status: 'verified',
          clientVersion,
          transport: 'codex app-server（stdio，只读）',
          authMode: '使用 Codex 自己的认证状态，本适配器不接触任何凭据',
          evidence: evidenceLines.join('\n'),
          detail,
          notes: `已在 ${
            clientVersion
          } 上实测读到 ${drafts.length} 个额度桶。注意：额度快照不参与任何求和，也不与账户汇总、请求明细相加（INV-03）。`,
        },
        quotaSnapshots: drafts,
        warnings,
      };
    }

    // 方法存在但没拿到数据：区分「不支持」与「这次没能判定」
    if (limits.ok) {
      return unknownReport({
        clientVersion,
        reasonCode: 'no_rate_limit_windows',
        reason: 'account/rateLimits/read 调用成功，但返回里没有可用的额度窗口（primary / secondary 都为空）。',
        evidence: evidenceLines.join('\n'),
        detail,
        warnings,
      });
    }
    if (limits.kind === 'method_not_supported') {
      return {
        report: {
          status: 'unsupported',
          clientVersion,
          transport: 'codex app-server（stdio，只读）',
          authMode: '使用 Codex 自己的认证状态，本适配器不接触任何凭据',
          evidence: evidenceLines.join('\n'),
          detail,
          notes: `本版本的 app-server 不支持 account/rateLimits/read。继续使用手动导入与额度手工录入 —— 不用「抓 Cookie」顶替。`,
        },
        quotaSnapshots: [],
        warnings,
      };
    }
    // 网络不可达、未登录等：这是环境问题，不是能力问题
    return unknownReport({
      clientVersion,
      reasonCode: limits.kind === 'timeout' ? 'rate_limits_timeout' : 'rate_limits_call_failed',
      reason:
        `account/rateLimits/read 这个方法存在，但这次调用没有成功：${limits.message}。` +
        '这属于环境或登录状态问题，不是「该版本不支持」，所以能力状态保持未判定。',
      evidence: evidenceLines.join('\n'),
      detail,
      warnings,
    });
  } finally {
    server.close();
  }
}
