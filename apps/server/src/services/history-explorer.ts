import { HISTORY_TOKEN_FIELDS, LOCAL_HISTORY_SOURCES, type ExplorerFilter, type ExplorerMetrics,
  type ExplorerSession, type ExplorerWorkspace, type ExplorerContext, type ExplorerList, type ExplorerAnalytics,
  type ExplorerSessionDetail, type ExplorerWorkspaceDetail, type LocalHistorySource } from '@aicc/core';
import { tx, type SqlParam } from '../db/database.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';
import type { ServiceContext } from '../service-context.js';
import { historyTotal } from './history-total.js';
import { ApiError } from '../http/errors.js';
import { EMPTY_DETAIL_TOKENS, DetailBuilder, insertDetailBuilder } from './history-detail-store.js';

const LABELS: Record<LocalHistorySource, string> = { codex: 'Codex', workbuddy: 'WorkBuddy', opencode: 'OpenCode', minimax: 'MiniMax Code' };
const FROM = 'FROM history_detail_bucket b JOIN history_detail_session s ON s.id=b.session_id';
const PAGE_SIZE = 50;
type Row = Record<string, unknown>;
const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
// TOTAL uses doubles instead of throwing SQLite's integer-overflow error. Guard absolute sums too.
const AGG = [
  'COUNT(DISTINCT s.id) AS sessions', 'TOTAL(b.records) AS records', 'MIN(b.first_at) AS first_at', 'MAX(b.last_at) AS last_at',
  'TOTAL(b.sample_input) AS sample_input', 'TOTAL(b.sample_cached) AS sample_cached', 'TOTAL(b.matched) AS matched',
  'SUM(CASE WHEN b.matched>0 AND (b.sample_input IS NULL OR b.sample_cached IS NULL) THEN 1 ELSE 0 END) AS sample_invalid',
  ...HISTORY_TOKEN_FIELDS.flatMap(f => [`TOTAL(b.${f}) AS ${f}`, `TOTAL(ABS(b.${f})) AS ${f}_abs`, `TOTAL(b.${f}_known) AS ${f}_known`,
    `SUM(CASE WHEN b.${f}_known>0 AND b.${f} IS NULL THEN 1 ELSE 0 END) AS ${f}_invalid`]),
].join(',');
const TOTAL_AGG = 'TOTAL(b.totalTokens) AS totalTokens,TOTAL(ABS(b.totalTokens)) AS totalTokens_abs,TOTAL(b.totalTokens_known) AS totalTokens_known,SUM(CASE WHEN b.totalTokens_known>0 AND b.totalTokens IS NULL THEN 1 ELSE 0 END) AS totalTokens_invalid';
function metrics(row: Row | undefined): ExplorerMetrics {
  const r = row ?? {}, totals = EMPTY_DETAIL_TOKENS();
  const coverage = {} as ExplorerMetrics['coverage'];
  for (const field of HISTORY_TOKEN_FIELDS) {
    const known = Number(r[`${field}_known`] ?? 0);
    totals[field] = known > 0 && !r[`${field}_invalid`] && integer(r[`${field}_abs`]) !== null ? integer(r[field]) : null;
    coverage[field] = totals[field] === null ? 'unknown' : known === r.records ? 'complete' : 'partial';
  }
  const input = integer(r.sample_input), cached = integer(r.sample_cached);
  return { totals, coverage, sessionCount: Number(r.sessions ?? 0), firstAt: r.first_at as string | null ?? null, lastAt: r.last_at as string | null ?? null,
    ...(Number(r.matched) > 0 && !r.sample_invalid && input !== null && cached !== null
      ? { cacheInputSample: { inputTokens: input, cachedInputTokens: cached, matchedRecords: Number(r.matched), totalRecords: Number(r.records) } } : {}) };
}
function session(row: Row): ExplorerSession {
  return { ...metrics(row), id: String(row.id), source: row.source as LocalHistorySource, sourceSessionId: String(row.source_session_id),
    title: row.title as string | null, directory: row.directory as string | null, workspaceId: String(row.workspace_id), models: JSON.parse(String(row.models)) as string[] };
}
function workspace(row: Row): ExplorerWorkspace {
  return { ...metrics(row), id: String(row.workspace_id), directory: row.directory as string | null, sources: JSON.parse(String(row.sources)) as LocalHistorySource[] };
}
interface Selection { where: string; args: SqlParam[]; context: ExplorerContext }
function selection(ctx: ServiceContext, scope: WorkspaceScope, filter: ExplorerFilter): Selection {
  if (scope === 'all') throw new ApiError(400, 'invalid_input', '明细查询必须选择真实或示例数据。');
  const demo = scope === 'demo' ? 1 : 0;
  const states = ctx.db.prepare('SELECT * FROM history_detail_source WHERE is_demo=?').all<Row>(demo);
  const totals = demo ? [] : historyTotal(ctx, 'real', true).sources;
  const capabilities = ctx.db.prepare(`SELECT source,COUNT(*) AS sessions,SUM(title IS NOT NULL) AS titles,SUM(directory IS NOT NULL) AS directories FROM history_detail_session WHERE is_demo=? GROUP BY source`).all<Row>(demo);
  const sources: ExplorerContext['sources'] = LOCAL_HISTORY_SOURCES.map(id => {
    const state = states.find(row => row.source === id), cap = capabilities.find(row => row.source === id);
    const policy = totals.find(row => row.id === id);
    return { id, label: LABELS[id], included: demo ? !!state?.last_success_at : policy?.included ?? false, reason: demo ? null : policy?.reason ?? null,
      indexed: !!state?.last_success_at, sessions: Number(cap?.sessions ?? 0), titles: Number(cap?.titles ?? 0), directories: Number(cap?.directories ?? 0),
      sync: { stale: !!state?.stale, lastSuccessAt: state?.last_success_at as string | null ?? null,
        lastAttempt: state ? { at: String(state.last_attempt_at), status: state.status === 'empty' ? 'empty' : state.status === 'ok' ? 'ok' : 'error', message: state.stale ? '本机明细同步失败，显示上次成功数据。' : state.status === 'not_scanned' ? '同步以建立本机明细。' : '本机明细索引' } : null } };
  });
  const included = filter.source ? [filter.source] : sources.filter(s => s.included).map(s => s.id);
  const args: SqlParam[] = [demo, ...included];
  const conditions = ['s.is_demo=?', included.length ? `s.source IN (${included.map(() => '?').join(',')})` : '0'];
  const facetsWhere = conditions.join(' AND '), facetsArgs = [...args];
  for (const [value, clause] of [[filter.workspaceId, 's.workspace_id=?'], [filter.model, 'b.model=?'], [filter.sessionId, 's.id=?']] as const) {
    if (value) { conditions.push(clause); args.push(value); }
  }
  if (filter.q) {
    conditions.push("(s.title LIKE ? ESCAPE '!' OR s.source_session_id LIKE ? ESCAPE '!' OR s.directory LIKE ? ESCAPE '!')");
    const value = `%${filter.q.replace(/[!%_]/g, '!$&')}%`; args.push(value, value, value);
  }
  const unknown = ctx.db.prepare(`SELECT TOTAL(b.records) AS n ${FROM} WHERE ${conditions.join(' AND ')} AND b.day=''`).get<{n:number}>(...args)?.n ?? 0;
  if (filter.from || filter.to) conditions.push("b.day<>''");
  if (filter.from) { conditions.push('b.day>=?'); args.push(filter.from); }
  if (filter.to) { conditions.push('b.day<=?'); args.push(filter.to); }
  const dirs = ctx.db.prepare(`SELECT s.workspace_id AS id, MIN(s.directory) AS directory ${FROM} WHERE ${facetsWhere} GROUP BY s.workspace_id ORDER BY directory`).all<{id:string;directory:string|null}>(...facetsArgs);
  const models = ctx.db.prepare(`SELECT DISTINCT b.model ${FROM} WHERE ${facetsWhere} ORDER BY b.model`).all<{model:string}>(...facetsArgs).map(r => r.model);
  return { where: conditions.join(' AND '), args, context: { basis: 'local', sources, unknownDateRecords: unknown, workspaces: dirs, models } };
}
function order(filter: ExplorerFilter, mode: 'sessions' | 'workspaces'): string {
  const sort = filter.sort ?? (mode === 'sessions' ? 'recent' : 'tokens');
  const field = sort === 'recent' ? 'last_at' : sort === 'name' ? mode === 'sessions' ? "COALESCE(s.title,s.source_session_id)" : "COALESCE(MIN(s.directory),'')" : 'totalTokens';
  const direction = filter.direction === 'asc' ? 'ASC' : 'DESC';
  return `${field} ${direction} NULLS LAST,${mode === 'sessions' ? 's.id' : 's.workspace_id'} ASC`;
}
function list<T>(ctx: ServiceContext, filter: ExplorerFilter, sel: Selection, mode: 'sessions' | 'workspaces'): ExplorerList<T> {
  const group = mode === 'sessions' ? 's.id' : 's.workspace_id';
  const fields = mode === 'sessions' ? 's.*,json_group_array(DISTINCT b.model) AS models' : 's.workspace_id,MIN(s.directory) AS directory,json_group_array(DISTINCT s.source) AS sources';
  const base = `${FROM} WHERE ${sel.where}`;
  const total = ctx.db.prepare(`SELECT COUNT(DISTINCT ${group}) AS n ${base}`).get<{n:number}>(...sel.args)!.n;
  const page = Math.max(1, Math.min(filter.page ?? 1, Math.max(1, Math.ceil(total / PAGE_SIZE))));
  const rows = ctx.db.prepare(`SELECT ${fields},${AGG} ${base} GROUP BY ${group} ORDER BY ${order(filter, mode)} LIMIT ? OFFSET ?`).all<Row>(...sel.args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { items: rows.map(row => mode === 'sessions' ? session(row) : workspace(row)) as T[], total, page, pageSize: PAGE_SIZE,
    summary: metrics(ctx.db.prepare(`SELECT ${AGG} ${base}`).get<Row>(...sel.args)), context: sel.context };
}
export function explorerSessions(ctx: ServiceContext, scope: WorkspaceScope, filter: ExplorerFilter): ExplorerList<ExplorerSession> {
  return tx(ctx.db, () => list(ctx, filter, selection(ctx, scope, filter), 'sessions'));
}
export function explorerWorkspaces(ctx: ServiceContext, scope: WorkspaceScope, filter: ExplorerFilter): ExplorerList<ExplorerWorkspace> {
  return tx(ctx.db, () => list(ctx, filter, selection(ctx, scope, filter), 'workspaces'));
}
function analytics(ctx: ServiceContext, filter: ExplorerFilter, sel: Selection): ExplorerAnalytics {
  const base = `${FROM} WHERE ${sel.where}`;
  const period = filter.granularity === 'month' ? "substr(b.day,1,7)" : filter.granularity === 'week' ? "date(b.day,'-' || ((CAST(strftime('%w',b.day) AS INTEGER)+6)%7) || ' days')" : 'b.day';
  const split = filter.split === 'source' ? 's.source' : 'b.model';
  const trendRows = ctx.db.prepare(`SELECT ${period} AS period,${split} AS series,${TOTAL_AGG} ${base} AND b.day<>'' GROUP BY period,series ORDER BY period,series`).all<Row>(...sel.args);
  const periods = ctx.db.prepare(`SELECT ${period} AS period,${AGG} ${base} AND b.day<>'' GROUP BY period ORDER BY period`).all<Row>(...sel.args);
  const trend = periods.map(row => ({ period: String(row.period), totals: metrics(row).totals,
    series: trendRows.filter(r => r.period === row.period).map(r => ({ name: String(r.series), totalTokens: metrics(r).totals.totalTokens })) }));
  const modelRows = ctx.db.prepare(`SELECT b.model,${TOTAL_AGG} ${base} GROUP BY b.model ORDER BY totalTokens DESC,b.model`).all<Row>(...sel.args);
  const byModel = modelRows.map(r => ({ model: String(r.model), totalTokens: metrics(r).totals.totalTokens }));
  const dirs = ctx.db.prepare(`SELECT s.workspace_id AS id,MIN(s.directory) AS directory,${TOTAL_AGG} ${base} GROUP BY s.workspace_id ORDER BY totalTokens DESC,s.workspace_id LIMIT 20`).all<Row>(...sel.args);
  const topModels = byModel.slice(0, 10).map(r => r.model);
  const matrixSelect = `SELECT s.workspace_id AS workspaceId,MIN(s.directory) AS directory,b.model,${TOTAL_AGG} ${base}`;
  const matrixGroup = 'GROUP BY s.workspace_id,b.model';
  const total = ctx.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${base} ${matrixGroup})`).get<{n:number}>(...sel.args)!.n;
  const page = Math.max(1, Math.min(filter.page ?? 1, Math.max(1, Math.ceil(total / PAGE_SIZE))));
  const mapRow = (r: Row) => ({ workspaceId: String(r.workspaceId), directory: r.directory as string | null, model: String(r.model), totalTokens: metrics(r).totals.totalTokens });
  const rows = ctx.db.prepare(`${matrixSelect} ${matrixGroup} ORDER BY totalTokens DESC,s.workspace_id,b.model LIMIT ? OFFSET ?`).all<Row>(...sel.args, PAGE_SIZE, (page - 1) * PAGE_SIZE).map(mapRow);
  const topRows = dirs.length && topModels.length ? ctx.db.prepare(`${matrixSelect} AND s.workspace_id IN (${dirs.map(() => '?').join(',')}) AND b.model IN (${topModels.map(() => '?').join(',')}) ${matrixGroup}`).all<Row>(...sel.args, ...dirs.map(r => String(r.id)), ...topModels).map(mapRow) : [];
  return { summary: metrics(ctx.db.prepare(`SELECT ${AGG} ${base}`).get<Row>(...sel.args)), context: sel.context, trend, byModel,
    matrix: { rows, topRows, total, page, pageSize: PAGE_SIZE, workspaces: dirs.map(r => ({ id: String(r.id), directory: r.directory as string | null })), models: topModels } };
}
export function explorerAnalytics(ctx: ServiceContext, scope: WorkspaceScope, filter: ExplorerFilter): ExplorerAnalytics {
  return tx(ctx.db, () => analytics(ctx, filter, selection(ctx, scope, filter)));
}
export function explorerSessionDetail(ctx: ServiceContext, scope: WorkspaceScope, filter: ExplorerFilter, id: string): ExplorerSessionDetail {
  return tx(ctx.db, () => {
    const f = { ...filter, sessionId: id, page: 1 }, sel = selection(ctx, scope, f);
    const item = list<ExplorerSession>(ctx, f, sel, 'sessions').items[0];
    if (!item) throw new ApiError(404, 'not_found', '当前筛选下没有该会话。');
    return { ...analytics(ctx, f, sel), session: item };
  });
}
export function explorerWorkspaceDetail(ctx: ServiceContext, scope: WorkspaceScope, filter: ExplorerFilter, id: string): ExplorerWorkspaceDetail {
  return tx(ctx.db, () => {
    const f = { ...filter, workspaceId: id }, sel = selection(ctx, scope, f);
    const item = list<ExplorerWorkspace>(ctx, { ...f, page: 1 }, sel, 'workspaces').items[0];
    if (!item) throw new ApiError(404, 'not_found', '当前筛选下没有该工作区。');
    return { ...analytics(ctx, f, sel), workspace: item, sessions: list(ctx, { ...f, sort: filter.sort ?? 'recent' }, sel, 'sessions') };
  });
}
export function seedExplorerDemo(ctx: ServiceContext): void {
  for (const [index, source] of LOCAL_HISTORY_SOURCES.entries()) {
    const builder = new DetailBuilder();
    for (let i = 0; i < 18; i++) {
      const id = `demo-${source}-${i}`;
      builder.metadata(id, `【示例】${['构建数据视图', '优化查询', '验证交互'][i % 3]} ${i + 1}`, i === 17 ? null : `D:\\示例项目\\${['星图', '观测站', '云端笔记'][i % 3]}`);
      for (let d = 0; d < 7; d++) {
        const at = new Date(ctx.now() - (i * 3 + d) * 86400000).toISOString();
        const input = 5000 + i * 137 + d * 250 + index * 1200, output = 600 + d * 93;
        builder.add(id, ['model-alpha', 'model-beta', 'model-gamma'][(i + d + index) % 3]!, at,
          { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedInputTokens: d === 6 ? null : Math.floor(input * .6), reasoningOutputTokens: null });
      }
    }
    insertDetailBuilder(ctx, source, 'demo', builder, true);
    const at = new Date(ctx.now()).toISOString();
    ctx.db.prepare('INSERT INTO history_detail_source VALUES(?,1,?,?,?,?,0)').run(source, 'demo', at, at, 'ok');
  }
}
