import { collectCacheInputSample, tokenCoverage } from '@aicc/core';
import { saveHistoryAttempt, withHistorySync } from './history-cache.js';
/** Read-only MiniMax Code v2 canonical message history adapter. Never persists conversation content. */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServiceContext } from '../service-context.js';
import { getSetting } from '../db/repos/system.js';
import type { CodexHistoryResponse, CodexHistoryTotals } from './codex-history.js';

export type MinimaxHistoryResponse = CodexHistoryResponse;
export interface MinimaxScanOptions { minimaxHome?: string; maxFiles?: number; maxRecords?: number; now?: () => number }
const KEY = 'history.minimax';
const emptyTotals = (): CodexHistoryTotals => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, totalTokens: null });
const blank = (): MinimaxHistoryResponse => ({ status: 'not_scanned', checkedAt: null, totals: emptyTotals(), sessionCount: null, firstAt: null, lastAt: null, byModel: [], byDay: [], warnings: [], message: '尚未同步 MiniMax Code 本机历史。' });
const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const num = (x: unknown): number | null => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
const identifier = (x: unknown): string | null => typeof x === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(x) ? x : null;
const inFlight = new WeakMap<ServiceContext, Promise<MinimaxHistoryResponse>>();

/** Pi usage.input excludes cacheRead/cacheWrite; output already includes reasoning.
 * Missing counters stay unknown; raw cost and message bodies are never returned.
 */
export function normalizeMinimaxTokens(usage: Record<string, unknown>): CodexHistoryTotals | null {
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
  if (keys.some(key => usage[key] != null && num(usage[key]) === null)) return null;
  const input = num(usage.input), cache = num(usage.cacheRead), write = num(usage.cacheWrite), output = num(usage.output);
  const inputTotal = input !== null && cache !== null && write !== null ? num(input + cache + write) : null;
  if (input !== null && cache !== null && write !== null && inputTotal === null) return null;
  const computed = inputTotal !== null && output !== null ? num(inputTotal + output) : null;
  if (inputTotal !== null && output !== null && computed === null) return null;
  const reported = num(usage.totalTokens);
  if (computed !== null && reported !== null && computed !== reported) return null;
  return { inputTokens: inputTotal, outputTokens: output, cachedInputTokens: cache,
    reasoningOutputTokens: null, totalTokens: computed ?? reported };
}

export async function scanMinimaxHistory(options: MinimaxScanOptions = {}): Promise<MinimaxHistoryResponse> {
  const result = blank();
  result.checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const warn = (text: string): void => { if (!result.warnings.includes(text)) result.warnings.push(text); };
  warn('MiniMax Code 是客户端来源；API 账单及其他客户端可能包含相同请求，不能直接相加。');
  warn('仅覆盖本机保留的 MiniMax Code 会话记录，不包含已删除或其他设备的历史。');
  const root = join(options.minimaxHome ?? process.env.MINIMAX_HOME ?? join(homedir(), '.minimax'), 'v2', 'sessions');
  const files: string[] = [];
  const limit = options.maxFiles ?? 10_000;
  let entries = 0;
  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 4) { warn('目录深度超过限制，部分历史未扫描。'); return; }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 100_000 || files.length >= limit) { warn('扫描达到文件数量限制，部分历史未扫描。'); return; }
      // Only YYYY/MM/DD/session/messages.jsonl; exclude snapshots, backups and projections.
      if (entry.isDirectory() && depth < 4) await walk(join(dir, entry.name), depth + 1);
      else if (depth === 4 && entry.isFile() && entry.name === 'messages.jsonl') files.push(join(dir, entry.name));
    }
  }
  try { await walk(root); } catch (e) {
    result.status = 'error';
    result.message = '无法读取 MiniMax Code 历史目录，请检查访问权限。';
    return result;
  }
  type Event = { totals: CodexHistoryTotals; model: string; session: string; at: string | null };
  const events = new Map<string, Event>();
  const conflicts = new Set<string>();
  let readFailed = false;
  let malformed = false;
  let scanned = 0;
  scan: for (const file of files.sort()) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (++scanned > (options.maxRecords ?? 100_000)) { warn('扫描达到记录数量上限，部分历史未统计。'); break scan; }
        if (!line.trim()) continue;
        if (line.length > 2_000_000) { warn('部分日志行过大，已跳过。'); continue; }
        let row: Record<string, unknown>;
        try { row = record(JSON.parse(line)); } catch { malformed = true; warn('部分日志行不完整或损坏，已跳过。'); continue; }
        const message = record(row.message);
        if (message.role !== 'assistant') continue;
        const usage = record(message.usage);
        if (!Object.keys(usage).length) continue;
        // turn_id spans multiple model calls; never dedupe on it.
        const id = identifier(row.message_id);
        if (!id) { warn('部分用量没有稳定消息 ID，已排除以避免重复累计。'); continue; }
        const totals = normalizeMinimaxTokens(usage);
        if (!totals) { warn('部分用量字段无效或总量与分项不一致，已排除。'); continue; }
        if (totals.totalTokens === null) { warn('部分请求缺少有效总 Token，未计入。'); continue; }
        if (Object.values(totals).some(v => v === null)) warn('部分请求的输入、输出、缓存或推理字段缺失；分项仅为已知用量。');
        const ms = typeof message.timestamp === 'number' ? message.timestamp : typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
        const at = Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
        const event: Event = { totals, model: identifier(message.model) ?? '未记录模型', session: basename(dirname(file)), at };
        const old = events.get(id);
        if (old && (JSON.stringify(old.totals) !== JSON.stringify(totals) || old.model !== event.model || old.at !== event.at)) {
          conflicts.add(id); warn('同一消息 ID 的用量存在冲突，已排除冲突消息。');
        } else if (!old) events.set(id, event);
      }
    } catch { readFailed = true; warn('部分历史文件读取失败，汇总可能不完整。'); }
    finally { lines.close(); stream.destroy(); }
  }
  type Bucket = { totals: CodexHistoryTotals; sessions: Set<string> };
  const models = new Map<string, Bucket>(), days = new Map<string, Bucket>(), sessions = new Set<string>();
  const overflows = new WeakMap<CodexHistoryTotals, Set<string>>();
  function add(target: CodexHistoryTotals, source: CodexHistoryTotals): void {
    let failed = overflows.get(target);
    if (!failed) { failed = new Set(); overflows.set(target, failed); }
    for (const key of Object.keys(target) as (keyof CodexHistoryTotals)[]) {
      const value = source[key];
      if (value === null || failed.has(key)) continue;
      const next = (target[key] ?? 0) + value;
      if (!Number.isSafeInteger(next)) { target[key] = null; failed.add(key); warn('Token 合计超出安全整数范围，对应字段已标为未知。'); }
      else target[key] = next;
    }
  }
  function bucket(map: Map<string, Bucket>, key: string, event: Event): void {
    let b = map.get(key);
    if (!b) { b = { totals: emptyTotals(), sessions: new Set() }; map.set(key, b); }
    add(b.totals, event.totals); b.sessions.add(event.session);
  }
  for (const [id, event] of events) {
    if (conflicts.has(id)) continue;
    add(result.totals, event.totals); sessions.add(event.session);
    bucket(models, event.model, event); bucket(days, event.at?.slice(0, 10) ?? '未知日期', event);
    if (event.at) {
      if (!result.firstAt || event.at < result.firstAt) result.firstAt = event.at;
      if (!result.lastAt || event.at > result.lastAt) result.lastAt = event.at;
    } else warn('部分用量缺少有效时间，已归入未知日期。');
  }
  result.sessionCount = sessions.size;
  result.byModel = [...models].map(([model, b]) => ({ model, totals: b.totals, sessionCount: b.sessions.size }));
  result.byDay = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => ({ day, totals: b.totals, sessionCount: b.sessions.size }));
  const coverageRows = [...events].filter(([id]) => !conflicts.has(id)).map(([, event]) => event.totals);
  result.coverage = tokenCoverage(coverageRows, result.totals);
  result.cacheInputSample = collectCacheInputSample(coverageRows);
  result.status = readFailed || (malformed && !sessions.size) ? 'error' : sessions.size ? 'ok' : 'empty';
  result.message = sessions.size ? `已扫描 ${files.length} 个 MiniMax Code 日志文件，按消息 ID 去重汇总。` : '未找到有效的 MiniMax Code 用量记录，未按 0 Token 处理。';
  if (result.status === 'error') result.message = '历史读取不完整；保留上次成功结果，请修复文件或访问权限后重试。';
  return result;
}

export function getMinimaxHistory(ctx: ServiceContext): MinimaxHistoryResponse {
  try {
    const value = JSON.parse(getSetting(ctx.db, KEY) ?? 'null');
    if (value?.schemaVersion === 1 && ['ok', 'empty', 'error'].includes(value.status) && value.totals && Array.isArray(value.byModel) && Array.isArray(value.byDay) && Array.isArray(value.warnings)) {
      const { schemaVersion: _, ...response } = value;
      return withHistorySync(ctx, KEY, response);
    }
  } catch { /* invalid cache is treated as not scanned */ }
  return withHistorySync(ctx, KEY, blank());
}

export function runMinimaxHistory(ctx: ServiceContext, options: MinimaxScanOptions = {}): Promise<MinimaxHistoryResponse> {
  const pending = inFlight.get(ctx);
  if (pending) return pending;
  const task = scanMinimaxHistory({ ...options, now: () => ctx.now() }).then(result => {
    return saveHistoryAttempt(ctx, KEY, 1, result, options.minimaxHome ?? process.env.MINIMAX_HOME ?? join(homedir(), '.minimax'));
  });
  inFlight.set(ctx, task);
  void task.finally(() => inFlight.delete(ctx)).catch(() => undefined);
  return task;
}
