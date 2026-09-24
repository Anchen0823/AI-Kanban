/** Read-only WorkBuddy project JSONL adapter. Never persists conversation content. */
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServiceContext } from '../service-context.js';
import { getSetting, setSetting } from '../db/repos/system.js';
import type { CodexHistoryResponse, CodexHistoryTotals } from './codex-history.js';

export type WorkbuddyHistoryResponse = CodexHistoryResponse;
export interface WorkbuddyScanOptions { workbuddyHome?: string; maxFiles?: number; now?: () => number }
const KEY = 'history.workbuddy';
const emptyTotals = (): CodexHistoryTotals => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, totalTokens: null });
const blank = (): WorkbuddyHistoryResponse => ({ status: 'not_scanned', checkedAt: null, totals: emptyTotals(), sessionCount: null, firstAt: null, lastAt: null, byModel: [], byDay: [], warnings: [], message: '尚未同步 WorkBuddy 本机历史。' });
const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const num = (x: unknown): number | null => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
const identifier = (x: unknown): string | null => typeof x === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(x) ? x : null;
const inFlight = new WeakMap<ServiceContext, Promise<WorkbuddyHistoryResponse>>();

export async function scanWorkbuddyHistory(options: WorkbuddyScanOptions = {}): Promise<WorkbuddyHistoryResponse> {
  const result = blank();
  result.checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const warn = (text: string): void => { if (!result.warnings.includes(text)) result.warnings.push(text); };
  warn('仅覆盖本机保留的 WorkBuddy 项目日志，不包含已删除或其他设备的历史。');
  const root = join(options.workbuddyHome ?? process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy'), 'projects');
  const files: string[] = [];
  const limit = options.maxFiles ?? 10_000;
  let entries = 0;
  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 8) { warn('目录深度超过限制，部分历史未扫描。'); return; }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 100_000 || files.length >= limit) { warn('扫描达到文件数量限制，部分历史未扫描。'); return; }
      if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(dir, entry.name));
    }
  }
  try { await walk(root); } catch (e) {
    result.status = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'empty' : 'error';
    result.message = result.status === 'empty' ? '未找到 WorkBuddy 本机项目日志，未按 0 Token 处理。' : '无法读取 WorkBuddy 历史目录，请检查访问权限。';
    return result;
  }
  type Event = { totals: CodexHistoryTotals; model: string; session: string; at: string | null };
  const events = new Map<string, Event>();
  const conflicts = new Set<string>();
  for (const file of files.sort()) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > 2_000_000) { warn('部分日志行过大，已跳过。'); continue; }
        let row: Record<string, unknown>;
        try { row = record(JSON.parse(line)); } catch { warn('部分日志行不完整或损坏，已跳过。'); continue; }
        if (row.type !== 'function_call' && !(row.type === 'message' && row.role === 'assistant')) continue;
        const usage = record(record(row.message).usage);
        if (!Object.keys(usage).length) continue;
        const provider = record(row.providerData);
        // traceId / conversationRequestId span many requests; they are NOT dedupe keys.
        const id = identifier(provider.messageId) ?? identifier(row.id);
        if (!id) { warn('部分用量没有稳定消息 ID，已排除以避免重复累计。'); continue; }
        const input = num(usage.input_tokens), output = num(usage.output_tokens);
        const computed = input !== null && output !== null ? num(input + output) : null;
        const reported = num(usage.total_tokens);
        if (computed !== null && reported !== null && computed !== reported) { warn('部分用量的总量与输入输出不一致，已排除。'); continue; }
        const raw = record(provider.rawUsage);
        const cache = num(usage.cache_read_input_tokens) ?? num(record(raw.prompt_tokens_details).cached_tokens);
        const reasoning = num(record(raw.completion_tokens_details).reasoning_tokens);
        const totals: CodexHistoryTotals = {
          inputTokens: input, outputTokens: output, totalTokens: computed ?? reported,
          cachedInputTokens: cache !== null && input !== null && cache <= input ? cache : null,
          reasoningOutputTokens: reasoning !== null && output !== null && reasoning <= output ? reasoning : null,
        };
        if (totals.totalTokens === null) { warn('部分请求缺少有效总 Token，未计入。'); continue; }
        if (Object.values(totals).some(v => v === null)) warn('部分请求的输入、输出、缓存或推理字段缺失；分项仅为已知用量。');
        const ms = typeof row.timestamp === 'number' ? row.timestamp : typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        const at = Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
        const event: Event = { totals, model: identifier(provider.model) ?? identifier(provider.requestModelId) ?? '未记录模型', session: identifier(row.sessionId) ?? file, at };
        const old = events.get(id);
        if (old && (JSON.stringify(old.totals) !== JSON.stringify(totals) || old.model !== event.model)) {
          conflicts.add(id); warn('同一消息 ID 的用量存在冲突，已排除冲突消息。');
        } else if (!old) events.set(id, event);
      }
    } catch { warn('部分历史文件读取失败，汇总可能不完整。'); }
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
  result.status = sessions.size ? 'ok' : 'empty';
  result.message = sessions.size ? `已扫描 ${files.length} 个 WorkBuddy 日志文件，按消息 ID 去重汇总。` : '未找到有效的 WorkBuddy 用量记录，未按 0 Token 处理。';
  return result;
}

export function getWorkbuddyHistory(ctx: ServiceContext): WorkbuddyHistoryResponse {
  try {
    const value = JSON.parse(getSetting(ctx.db, KEY) ?? 'null');
    if (value?.schemaVersion === 1 && ['ok', 'empty', 'error'].includes(value.status) && value.totals && Array.isArray(value.byModel) && Array.isArray(value.byDay) && Array.isArray(value.warnings)) {
      const { schemaVersion: _, ...response } = value;
      return response;
    }
  } catch { /* invalid cache is treated as not scanned */ }
  return blank();
}

export function runWorkbuddyHistory(ctx: ServiceContext, options: WorkbuddyScanOptions = {}): Promise<WorkbuddyHistoryResponse> {
  const pending = inFlight.get(ctx);
  if (pending) return pending;
  const task = scanWorkbuddyHistory({ ...options, now: () => ctx.now() }).then(result => {
    setSetting(ctx.db, KEY, JSON.stringify({ schemaVersion: 1, ...result }));
    return result;
  });
  inFlight.set(ctx, task);
  void task.finally(() => inFlight.delete(ctx)).catch(() => undefined);
  return task;
}
