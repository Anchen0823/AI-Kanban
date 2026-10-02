/** Official account activity, queried through Codex's own authentication. */
import { CodexAppServer, type CodexAppServerOptions } from './codex-app-server.js';
import { readCodexThreadDetails, type CodexThreadDetails } from './codex-thread-usage.js';

export interface CodexAccountSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}
export interface CodexAccountUsage {
  details?: CodexThreadDetails;
  status: 'ok' | 'unavailable';
  summary: CodexAccountSummary | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
  message: string;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function unavailableAccountUsage(message: string): CodexAccountUsage {
  return { status: 'unavailable', summary: null, dailyUsageBuckets: null, message };
}

/** Whitelist numeric fields; never persist raw responses, identities or errors. */
export function normalizeCodexAccountUsage(value: unknown): CodexAccountUsage {
  const payload = record(value);
  const raw = record(payload?.summary);
  const summary: CodexAccountSummary = {
    lifetimeTokens: count(raw?.lifetimeTokens),
    peakDailyTokens: count(raw?.peakDailyTokens),
    longestRunningTurnSec: count(raw?.longestRunningTurnSec),
    currentStreakDays: count(raw?.currentStreakDays),
    longestStreakDays: count(raw?.longestStreakDays),
  };
  const buckets = payload?.dailyUsageBuckets;
  let dailyUsageBuckets: CodexAccountUsage['dailyUsageBuckets'] = null;
  if (Array.isArray(buckets)) {
    const days = new Map<string, number>();
    let valid = true;
    for (const item of buckets) {
      const row = record(item);
      const day = row?.startDate;
      const tokens = count(row?.tokens);
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
        || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))
        || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || tokens === null
        || (days.has(day) && days.get(day) !== tokens)) {
        valid = false;
        break;
      }
      // Repeated buckets are snapshots, not additive usage.
      days.set(day, tokens);
    }
    if (valid) dailyUsageBuckets = [...days].sort(([a], [b]) => a.localeCompare(b))
      .map(([startDate, tokens]) => ({ startDate, tokens }));
  }
  if (summary.lifetimeTokens === null && !dailyUsageBuckets?.length) {
    return unavailableAccountUsage('官方未返回可用的累计或每日 Token，已回退到本机日志。');
  }
  return { status: 'ok', summary, dailyUsageBuckets, message: '已读取 Codex 官方账户统计。' };
}

export async function readCodexAccountUsage(options: CodexAppServerOptions = {}): Promise<CodexAccountUsage> {
  let server: CodexAppServer | undefined;
  try {
    server = CodexAppServer.start(options);
    await server.initialize();
    const result = await server.call<unknown>('account/usage/read');
    if (result.ok) {
      const usage = normalizeCodexAccountUsage(result.result);
      if (usage.status === 'ok') {
        // A detail failure must never discard a successfully read account total.
        try { usage.details = await readCodexThreadDetails(server, usage.summary?.lifetimeTokens ?? null); } catch { /* retain account activity */ }
      }
      return usage;
    }
    if (result.kind === 'method_not_supported') {
      return unavailableAccountUsage('当前 Codex 版本不支持官方统计，请更新 Codex；已回退到本机日志。');
    }
    if (/authentication required|not authenticated|unauthorized|sign.?in|login|auth.*required/i.test(result.message)) {
      return unavailableAccountUsage('官方统计需要 Codex CLI 的 ChatGPT 登录。请运行 codex login，使用与 Codex 应用相同的账号后重新同步；当前回退到本机日志。');
    }
    return unavailableAccountUsage(result.kind === 'timeout'
      ? '读取官方统计超时，已回退到本机日志。'
      : '暂时无法读取官方统计，请检查 Codex 登录或网络后重新同步；已回退到本机日志。');
  } catch {
    return unavailableAccountUsage('无法启动 Codex 官方统计接口，请检查 Codex 安装后重新同步；已回退到本机日志。');
  } finally {
    server?.close();
  }
}
