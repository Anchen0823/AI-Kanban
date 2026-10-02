import { collectCacheInputSample, tokenCoverage, type HistoryTokens } from '@aicc/core';
import { saveHistoryAttempt, withHistorySync } from './history-cache.js';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServiceContext } from '../service-context.js';
import { getSetting } from '../db/repos/system.js';
import type { CodexHistoryResponse, CodexHistoryTotals } from './codex-history.js';

const emptyTotals = (): CodexHistoryTotals => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, totalTokens: null });
const blank = (): CodexHistoryResponse => ({ status: 'not_scanned', checkedAt: null, totals: emptyTotals(), sessionCount: null, firstAt: null, lastAt: null, byModel: [], byDay: [], warnings: [], message: '尚未同步 OpenCode 本机历史。' });
const numeric = (x: unknown): number | null => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
const sum = (...values: (number | null)[]): number | null => values.every(x => x !== null) ? numeric((values as number[]).reduce((a, b) => a + b, 0)) : null;
const modelName = (x: unknown): string => typeof x === 'string' && /^[\w.:/-]{1,160}$/.test(x) ? x : '未记录模型';

/** OpenCode stores non-overlapping input/cache and output/reasoning components. */
export function normalizeOpencodeTokens(row: Record<string, unknown>): CodexHistoryTotals {
  const cache = numeric(row.cache_read);
  const reasoning = numeric(row.reasoning);
  const input = sum(numeric(row.input), cache, numeric(row.cache_write));
  const output = sum(numeric(row.output), reasoning);
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cache, reasoningOutputTokens: reasoning, totalTokens: sum(input, output) ?? numeric(row.total) };
}

export interface OpencodeScanOptions { databasePath?: string; maxRecords?: number; now?: () => number }
export async function scanOpencodeHistory(options: OpencodeScanOptions = {}): Promise<CodexHistoryResponse> {
  const result = blank();
  result.checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const warn = (text: string): void => { if (!result.warnings.includes(text)) result.warnings.push(text); };
  warn('仅覆盖本机 OpenCode 数据库保留的已知用量。');
  const databasePath = options.databasePath ?? process.env.OPENCODE_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1500; BEGIN');
    // Select only metadata and numeric usage, never message/tool bodies or account tables.
    const fields = (data: string): string => ['input', 'output', 'reasoning', 'total'].map(key => `json_extract(${data}, '$.tokens.${key}') AS ${key}`).join(',') + `,json_extract(${data}, '$.tokens.cache.read') AS cache_read,json_extract(${data}, '$.tokens.cache.write') AS cache_write`;
    const limit = options.maxRecords ?? 100_000;
    const rows = db.prepare(`
      SELECT p.id, p.session_id, p.time_created, json_extract(m.data,'$.modelID') AS model,
        json_extract(p.data,'$.reason') AS finish, ${fields('p.data')}
      FROM part p JOIN message m ON m.id=p.message_id
      WHERE json_valid(p.data) AND json_valid(m.data) AND json_extract(p.data,'$.type')='step-finish'
        AND json_extract(m.data,'$.role')='assistant'
      UNION ALL
      SELECT m.id, m.session_id, m.time_created, json_extract(m.data,'$.modelID') AS model,
        json_extract(m.data,'$.finish') AS finish, ${fields('m.data')}
      FROM message m WHERE json_valid(m.data) AND json_extract(m.data,'$.role')='assistant'
        AND NOT EXISTS (SELECT 1 FROM part p WHERE p.message_id=m.id AND json_valid(p.data) AND json_extract(p.data,'$.type')='step-finish')
      ORDER BY time_created, id LIMIT ?
    `).all(limit + 1);
    if (rows.length > limit) { rows.pop(); warn('扫描达到记录上限，部分历史未统计。'); }
    const corrupt = db.prepare('SELECT (SELECT count(*) FROM message WHERE NOT json_valid(data)) + (SELECT count(*) FROM part WHERE NOT json_valid(data)) AS n').get();
    if (Number(corrupt?.n) > 0) warn('部分数据库记录损坏，已跳过。');
    type Bucket = { totals: CodexHistoryTotals; sessions: Set<string> };
    const models = new Map<string, Bucket>(), days = new Map<string, Bucket>(), sessions = new Set<string>();
    const failed = new WeakMap<CodexHistoryTotals, Set<string>>();
    const add = (target: CodexHistoryTotals, source: CodexHistoryTotals): void => {
      let fields = failed.get(target); if (!fields) { fields = new Set(); failed.set(target, fields); }
      for (const key of Object.keys(target) as (keyof CodexHistoryTotals)[]) {
        if (source[key] === null || fields.has(key)) continue;
        const value = sum(target[key] ?? 0, source[key]);
        target[key] = value;
        if (value === null) { fields.add(key); warn('Token 合计超出安全整数范围，对应字段已标为未知。'); }
      }
    };
    const bucket = (map: Map<string, Bucket>, key: string, session: string, totals: CodexHistoryTotals): void => {
      let value = map.get(key); if (!value) { value = { totals: emptyTotals(), sessions: new Set() }; map.set(key, value); }
      add(value.totals, totals); value.sessions.add(session);
    };
    const coverageRows: HistoryTokens[] = [];
    for (const row of rows) {
      const totals = normalizeOpencodeTokens(row);
      // OpenCode writes all-zero placeholders for unfinished/unknown steps without provider usage.
      if (totals.totalTokens === null || (totals.totalTokens === 0 && numeric(row.total) === null && (!row.finish || row.finish === 'unknown'))) {
        warn('部分请求未报告有效用量，已跳过零值占位或缺失记录。'); continue;
      }
      const reported = numeric(row.total);
      if (reported !== null && totals.totalTokens !== reported) { warn('部分请求的总量与分项不一致，已排除。'); continue; }
      if (Object.values(totals).some(v => v === null)) warn('部分用量分项缺失，分项仅为已知值。');
      const session = String(row.session_id), model = modelName(row.model);
      const ms = numeric(row.time_created);
      const at = ms !== null && ms <= 8.64e15 ? new Date(ms).toISOString() : null;
      coverageRows.push(totals);
      add(result.totals, totals); sessions.add(session);
      bucket(models, model, session, totals); bucket(days, at?.slice(0, 10) ?? '未知日期', session, totals);
      if (at) {
        if (!result.firstAt || at < result.firstAt) result.firstAt = at;
        if (!result.lastAt || at > result.lastAt) result.lastAt = at;
      } else warn('部分记录缺少有效时间，已归入未知日期。');
    }
    result.coverage = tokenCoverage(coverageRows, result.totals);
    result.cacheInputSample = collectCacheInputSample(coverageRows);
    result.sessionCount = sessions.size;
    result.byModel = [...models].map(([model, b]) => ({ model, totals: b.totals, sessionCount: b.sessions.size }));
    result.byDay = [...days].map(([day, b]) => ({ day, totals: b.totals, sessionCount: b.sessions.size }));
    result.status = !sessions.size && Number(corrupt?.n) > 0 ? 'error' : sessions.size ? 'ok' : 'empty';
    result.message = sessions.size ? `已同步 ${sessions.size} 个 OpenCode 会话的已知用量。` : '未找到已报告用量的 OpenCode 请求，用量未知。';
  } catch {
    result.status = 'error';
    result.message = '无法读取 OpenCode 用量，请确认本机数据库存在且格式受支持。';
  } finally { db?.close(); }
  return result;
}

export function getOpencodeHistory(ctx: ServiceContext): CodexHistoryResponse {
  try {
    const value = JSON.parse(getSetting(ctx.db, 'history.opencode') ?? 'null');
    if (value?.schemaVersion === 1 && ['ok', 'empty', 'error'].includes(value.status) && value.totals && Array.isArray(value.byModel) && Array.isArray(value.byDay) && Array.isArray(value.warnings)) {
      const { schemaVersion: _, ...response } = value; return withHistorySync(ctx, 'history.opencode', response);
    }
  } catch { /* no valid cache */ }
  return withHistorySync(ctx, 'history.opencode', blank());
}
const pending = new WeakMap<ServiceContext, Promise<CodexHistoryResponse>>();
export function runOpencodeHistory(ctx: ServiceContext, options: OpencodeScanOptions = {}): Promise<CodexHistoryResponse> {
  const existing = pending.get(ctx); if (existing) return existing;
  const task = scanOpencodeHistory({ ...options, now: () => ctx.now() }).then(result => {
    return saveHistoryAttempt(ctx, 'history.opencode', 1, result, options.databasePath ?? process.env.OPENCODE_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode', 'opencode.db'));
  });
  pending.set(ctx, task);
  void task.finally(() => pending.delete(ctx)).catch(() => undefined);
  return task;
}
