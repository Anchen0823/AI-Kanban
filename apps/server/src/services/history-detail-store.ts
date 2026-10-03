/** Local-only usage index. Collector payloads never leak through aggregate responses. */
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { HISTORY_TOKEN_FIELDS, type HistorySnapshot, type HistoryTokens, type LocalHistorySource } from '@aicc/core';
import type { ServiceContext } from '../service-context.js';

export const detailHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const EMPTY_DETAIL_TOKENS = (): HistoryTokens => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null, totalTokens: null });
export function directoryIdentity(value: unknown): { directory: string; normalized: string } | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) return null;
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(value)) {
    const normal = win32.normalize(value);
    const directory = normal.length > win32.parse(normal).root.length ? normal.replace(/\\+$/, '') : normal;
    return { directory, normalized: directory.toLowerCase() };
  }
  if (value.startsWith('/')) {
    const directory = posix.normalize(value).replace(/\/+$/, '') || '/';
    return { directory, normalized: directory };
  }
  return null;
}
export function metadataTitle(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 500) : null;
}
interface DetailMetadata { sourceSessionId: string; title: string | null; directory: string | null; workspaceId: string }
interface DetailBucket {
  session: string; day: string; model: string; totals: HistoryTokens; known: Record<string, number>;
  records: number; sampleInput: number; sampleCached: number; matched: number;
  firstAt: string | null; lastAt: string | null; overflow: Set<string>;
}
export class DetailBuilder {
  readonly sessions = new Map<string, DetailMetadata>();
  readonly buckets = new Map<string, DetailBucket>();
  metadata(session: string, title?: unknown, directory?: unknown): void {
    const existing = this.sessions.get(session);
    const path = directoryIdentity(directory);
    this.sessions.set(session, {
      sourceSessionId: session, title: existing?.title ?? metadataTitle(title),
      directory: existing?.directory ?? path?.directory ?? null,
      workspaceId: existing?.directory ? existing.workspaceId : path ? detailHash(path.normalized) : 'unassigned',
    });
  }
  add(session: string, model: string, at: string | null, totals: Partial<HistoryTokens>): void {
    this.metadata(session);
    const day = at?.slice(0, 10) ?? '';
    const key = JSON.stringify([session, day, model]);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { session, day, model, totals: EMPTY_DETAIL_TOKENS(), known: {}, records: 0,
        sampleInput: 0, sampleCached: 0, matched: 0, firstAt: null, lastAt: null, overflow: new Set() };
      this.buckets.set(key, bucket);
    }
    bucket.records++;
    for (const field of HISTORY_TOKEN_FIELDS) {
      const value = totals[field];
      if (value == null || !Number.isSafeInteger(value)) continue;
      bucket.known[field] = (bucket.known[field] ?? 0) + 1;
      if (bucket.overflow.has(field)) continue;
      const next = (bucket.totals[field] ?? 0) + value;
      bucket.totals[field] = Number.isSafeInteger(next) ? next : null;
      if (!Number.isSafeInteger(next)) bucket.overflow.add(field);
    }
    const input = totals.inputTokens, cached = totals.cachedInputTokens;
    if (input != null && cached != null && Number.isSafeInteger(input) && Number.isSafeInteger(cached) && input >= 0 && cached >= 0 && cached <= input) {
      bucket.sampleInput += input; bucket.sampleCached += cached; bucket.matched++;
    }
    if (at) { if (!bucket.firstAt || at < bucket.firstAt) bucket.firstAt = at; if (!bucket.lastAt || at > bucket.lastAt) bucket.lastAt = at; }
  }
}
const payloads = new WeakMap<object, { builder: DetailBuilder; status: HistorySnapshot['status'] }>();
export function attachDetails<T extends HistorySnapshot>(result: T, builder: DetailBuilder): T {
  payloads.set(result, { builder, status: result.status }); return result;
}
export function carryDetails<T extends HistorySnapshot>(local: HistorySnapshot, result: T): T {
  const payload = payloads.get(local);
  if (payload) payloads.set(result, payload);
  else payloads.set(result, { builder: new DetailBuilder(), status: local.status });
  return result;
}
export const localDetailStatus = (result: HistorySnapshot): HistorySnapshot['status'] | undefined => payloads.get(result)?.status;
/** Called inside the same transaction as the source aggregate; local status is independent of official success. */
export function saveDetailAttempt(ctx: ServiceContext, source: LocalHistorySource, scope: string, result: HistorySnapshot): void {
  const payload = payloads.get(result);
  const status = payload?.status ?? (result.status === 'ok' ? 'not_scanned' : result.status);
  const old = ctx.db.prepare('SELECT scope,last_success_at FROM history_detail_source WHERE source=? AND is_demo=0').get<{ scope: string; last_success_at: string | null }>(source);
  const failed = status !== 'ok' && status !== 'empty';
  const preserve = failed && old?.scope === scope && old.last_success_at !== null;
  if (!preserve) {
    ctx.db.prepare('DELETE FROM history_detail_session WHERE source=? AND is_demo=0').run(source);
  }
  const at = result.checkedAt ?? new Date(ctx.now()).toISOString();
  const lastSuccess = preserve ? old!.last_success_at : failed ? null : at;
  ctx.db.prepare(`INSERT INTO history_detail_source(source,is_demo,scope,last_success_at,last_attempt_at,status,stale)
    VALUES(?,0,?,?,?,?,?) ON CONFLICT(source,is_demo) DO UPDATE SET scope=excluded.scope,last_success_at=excluded.last_success_at,
    last_attempt_at=excluded.last_attempt_at,status=excluded.status,stale=excluded.stale`).run(source, scope, lastSuccess, at, status, preserve);
  if (!failed && payload) insertDetailBuilder(ctx, source, scope, payload.builder, false);
}
export function insertDetailBuilder(ctx: ServiceContext, source: LocalHistorySource, scope: string, builder: DetailBuilder, demo: boolean): void {
  const insertSession = ctx.db.prepare('INSERT INTO history_detail_session(id,source,is_demo,source_session_id,title,directory,workspace_id) VALUES(?,?,?,?,?,?,?)');
  const columns = HISTORY_TOKEN_FIELDS.flatMap(field => [field, `${field}_known`]);
  const insertBucket = ctx.db.prepare(`INSERT INTO history_detail_bucket(session_id,day,model,records,first_at,last_at,sample_input,sample_cached,matched,${columns.join(',')}) VALUES(${Array(9 + columns.length).fill('?').join(',')})`);
  const used = new Set([...builder.buckets.values()].map(b => b.session));
  for (const session of builder.sessions.values()) {
    if (!used.has(session.sourceSessionId)) continue;
    const id = detailHash(JSON.stringify([demo, source, scope, session.sourceSessionId]));
    insertSession.run(id, source, demo, session.sourceSessionId, session.title, session.directory, session.workspaceId);
  }
  for (const bucket of builder.buckets.values()) {
    const id = detailHash(JSON.stringify([demo, source, scope, bucket.session]));
    insertBucket.run(id, bucket.day, bucket.model, bucket.records, bucket.firstAt, bucket.lastAt,
      Number.isSafeInteger(bucket.sampleInput) ? bucket.sampleInput : null, Number.isSafeInteger(bucket.sampleCached) ? bucket.sampleCached : null, bucket.matched,
      ...HISTORY_TOKEN_FIELDS.flatMap(field => [bucket.totals[field] ?? null, bucket.known[field] ?? 0]));
  }
}
