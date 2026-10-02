/** Official thread estimates. Persist aggregates only, never thread identifiers. */
import type { CodexAppServer } from './codex-app-server.js';

export interface ThreadTokenTotals {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}
export interface CodexThreadDetails {
  status: 'complete' | 'partial' | 'unavailable';
  totals: ThreadTokenTotals;
  byModel: Array<{ model: string; totals: ThreadTokenTotals; sessionCount: number }>;
  checkedThreads: number;
  availableThreads: number;
  message: string;
}
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'] as const;
const empty = (): ThreadTokenTotals => ({ inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: null });

function sum(rows: ThreadTokenTotals[]): ThreadTokenTotals {
  const result = empty();
  for (const key of keys) {
    if (!rows.length || rows.some(row => row[key] === null)) continue;
    result[key] = count(rows.reduce((n, row) => n + row[key]!, 0));
  }
  return result;
}

/** A thread response is a complete snapshot; do not add it to older snapshots. */
export function normalizeCodexThreadUsage(value: unknown, expectedId: string): CodexThreadDetails['byModel'] | null {
  const thread = record(record(value)?.threadUsage);
  if (thread?.threadId !== expectedId || !Array.isArray(thread.groups)) return null;
  const models = new Map<string, ThreadTokenTotals[]>();
  for (const item of thread.groups) {
    const group = record(item);
    if (!group) return null;
    const totals = empty();
    for (const key of keys) {
      if (group[key] != null && count(group[key]) === null) return null;
      totals[key] = count(group[key]);
    }
    // Cached input is already included in input. Reasoning effort is not a token count.
    if (totals.inputTokens !== null && totals.outputTokens !== null && totals.totalTokens !== null
      && totals.inputTokens + totals.outputTokens !== totals.totalTokens) return null;
    if (totals.cachedInputTokens !== null && totals.inputTokens !== null && totals.cachedInputTokens > totals.inputTokens) return null;
    const model = typeof group.model === 'string' && /^[\w./:-]{1,120}$/.test(group.model) ? group.model : '未记录模型';
    models.set(model, [...(models.get(model) ?? []), totals]);
  }
  return [...models].map(([model, rows]) => ({ model, totals: sum(rows), sessionCount: 1 }));
}

export async function readCodexThreadDetails(server: CodexAppServer, lifetime: number | null): Promise<CodexThreadDetails> {
  const result: CodexThreadDetails = { status: 'unavailable', totals: empty(), byModel: [], checkedThreads: 0, availableThreads: 0,
    message: '官方会话明细暂不可用，分项与模型排行采用本机日志。' };
  // Bound interactive sync time and backend traffic. Archived threads are sampled too.
  const deadline = Date.now() + 15_000;
  const ids = new Set<string>();
  const lists: string[][] = [];
  let enumeratedAll = true;
  for (const archived of [false, true]) {
    const listIds: string[] = [];
    lists.push(listIds);
    const listed = await server.call<unknown>('thread/list', { archived, limit: 32, useStateDbOnly: true, sortKey: 'updated_at' }, 4_000);
    const payload = listed.ok ? record(listed.result) : null;
    if (!Array.isArray(payload?.data)) { enumeratedAll = false; continue; }
    if (payload.nextCursor != null) enumeratedAll = false;
    for (const item of payload.data) {
      const id = record(item)?.id;
      if (typeof id === 'string' && /^[\w-]{1,128}$/.test(id)) listIds.push(id);
      else enumeratedAll = false;
    }
  }
  // Interleave archived and active IDs so an unavailable active billing route does
  // not prevent checking archived usage. Only IDs leave this process, not messages.
  for (let index = 0; index < 32; index++) {
    for (const list of lists) if (list[index]) ids.add(list[index]!);
  }
  const all = [...ids];
  const threadRows: ThreadTokenTotals[] = [];
  const models = new Map<string, Array<{ totals: ThreadTokenTotals; sessionCount: number }>>();
  for (let offset = 0; offset < all.length && Date.now() < deadline; offset += 4) {
    const batch = all.slice(offset, offset + 4);
    const outcomes = await Promise.all(batch.map(async id => {
      const response = await server.call<unknown>('account/usage/read', { threadId: id }, Math.max(1, Math.min(4_000, deadline - Date.now())));
      return response.ok ? normalizeCodexThreadUsage(response.result, id) : null;
    }));
    result.checkedThreads += batch.length;
    for (const rows of outcomes) {
      if (rows === null) continue;
      result.availableThreads += 1;
      threadRows.push(sum(rows.map(row => row.totals)));
      for (const row of rows) models.set(row.model, [...(models.get(row.model) ?? []), row]);
    }
    // A null estimate is not zero. Avoid dozens of requests when the sampled
    // billing routes do not supply any usage. A later sync always probes again.
    if (result.checkedThreads >= 8 && result.availableThreads === 0) break;
  }
  result.totals = sum(threadRows);
  result.byModel = [...models].map(([model, rows]) => ({ model, totals: sum(rows.map(row => row.totals)),
    sessionCount: rows.reduce((n, row) => n + row.sessionCount, 0) }))
    .sort((a, b) => (b.totals.totalTokens ?? -1) - (a.totals.totalTokens ?? -1));
  if (result.availableThreads > 0) {
    // Local thread enumeration cannot prove account-wide coverage by itself.
    // Only use official breakdowns in the main charts after reconciling lifetime.
    const complete = enumeratedAll && result.checkedThreads === all.length && result.availableThreads === all.length
      && lifetime !== null && result.totals.totalTokens === lifetime;
    result.status = complete ? 'complete' : 'partial';
    result.message = complete ? '官方会话明细已与官方累计核对一致，分项与模型排行采用官方估算数据。'
      : `官方返回 ${result.availableThreads} 个会话的估算明细，尚未覆盖官方累计；分项与模型排行继续采用本机日志。`;
  } else if (result.checkedThreads > 0) {
    result.message = `已查询 ${result.checkedThreads} 个会话，官方未返回可用明细；分项与模型排行采用本机日志。`;
  }
  return result;
}
