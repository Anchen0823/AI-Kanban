import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { unknownCoverage, type HistorySnapshot, type HistorySync } from '@aicc/core';
import { tx } from '../db/database.js';
import { getSetting, setSetting } from '../db/repos/system.js';
import type { ServiceContext } from '../service-context.js';
import { LOCAL_HISTORY_SOURCES, type LocalHistorySource } from '@aicc/core';
import { saveDetailAttempt, localDetailStatus } from './history-detail-store.js';

interface SyncState extends HistorySync { scope: string }
function state(ctx: ServiceContext, key: string): SyncState | null {
  try { return JSON.parse(getSetting(ctx.db, `${key}.sync`) ?? 'null') as SyncState | null; }
  catch { return null; }
}
/** No paths or credentials are stored in sync metadata. */
function scopeId(path: string): string {
  const absolute = resolve(path);
  return createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex');
}
export function withHistorySync<T extends HistorySnapshot>(ctx: ServiceContext, key: string, snapshot: T): T {
  const meta = state(ctx, key);
  return { ...snapshot, coverage: snapshot.coverage ?? unknownCoverage(),
    detailCoverage: snapshot.detailCoverage ?? snapshot.coverage ?? unknownCoverage(),
    sync: meta ? { lastAttempt: meta.lastAttempt, lastSuccessAt: meta.lastSuccessAt, stale: meta.stale }
      : { lastAttempt: null, lastSuccessAt: snapshot.status === 'ok' || snapshot.status === 'empty' ? snapshot.checkedAt ?? null : null, stale: false } };
}
export function saveHistoryAttempt<T extends HistorySnapshot>(
  ctx: ServiceContext, key: string, schemaVersion: number, result: T, path: string, keepPrevious = true, scopeOnSuccessOnly = false,
): T {
  const previous = state(ctx, key);
  const scope = result.status === 'error' && scopeOnSuccessOnly && previous ? previous.scope : scopeId(path);
  const failed = result.status === 'error';
  const preserve = failed && keepPrevious && previous?.scope === scope && previous.lastSuccessAt !== null;
  const at = result.checkedAt ?? new Date(ctx.now()).toISOString();
  const meta: SyncState = { scope, lastAttempt: { at, status: result.status === 'not_scanned' ? 'error' : result.status, message: result.message },
    lastSuccessAt: preserve ? previous!.lastSuccessAt : failed ? null : at, stale: preserve };
  tx(ctx.db, () => {
    const source = key.replace(/^history\./, '') as LocalHistorySource;
    if (LOCAL_HISTORY_SOURCES.includes(source)) saveDetailAttempt(ctx, source, scope, result);
    if (source === 'codex') {
      const localStatus = localDetailStatus(result);
      if (localStatus === 'ok' || localStatus === 'empty') {
        setSetting(ctx.db, 'history.codex.localIndexSnapshot', JSON.stringify({ scope, snapshot: result.localSnapshot ?? result }));
      }
    }
    if (!preserve) setSetting(ctx.db, key, JSON.stringify({ schemaVersion, ...result }));
    setSetting(ctx.db, `${key}.sync`, JSON.stringify(meta));
  });
  // POST reports the attempted operation; GET returns the retained snapshot.
  return withHistorySync(ctx, key, result);
}
