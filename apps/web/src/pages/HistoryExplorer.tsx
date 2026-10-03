import { useEffect, useState, type ReactNode } from 'react';
import type { ExplorerAnalytics, ExplorerContext, ExplorerList, ExplorerMetrics, ExplorerSession, ExplorerSessionDetail,
  ExplorerWorkspace, ExplorerWorkspaceDetail } from '@aicc/core';
import { api } from '../api.js';
import { AdaptiveNumber } from '../AdaptiveNumber.js';
import { explorerFilter, explorerHref, explorerQuery, readExplorerLocation, recentUtcRange } from '../explorer-state.js';
import './history-explorer.css';

const COLORS = ['#129faa', '#658ee0', '#41aa87', '#9a80d4', '#c99948', '#cc7c92', '#609cac', '#657786'];
const LABELS: Record<string, string> = { codex: 'Codex', workbuddy: 'WorkBuddy', opencode: 'OpenCode', minimax: 'MiniMax Code' };
type Result = ExplorerList<ExplorerSession> | ExplorerList<ExplorerWorkspace> | ExplorerAnalytics | ExplorerSessionDetail | ExplorerWorkspaceDetail;
const isSessionDetail = (value: Result): value is ExplorerSessionDetail => 'session' in value;
const isWorkspaceDetail = (value: Result): value is ExplorerWorkspaceDetail => 'workspace' in value;
const num = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('zh-CN');
const dirName = (v: string | null) => v ? v.replace(/[\\/]$/, '').split(/[\\/]/).at(-1) || v : '未归属工作区';
const dateTime = (v: string | null) => v ? `${v.slice(0, 10)} ${v.slice(11, 16)}` : '—';

export function HistoryExplorer({ hash, refreshToken, reload }: { hash: string; refreshToken: number; reload: () => void }): ReactNode {
  const { view, id, params } = readExplorerLocation(hash);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<{ key: string; data: Result | null; error: string | null } | null>(null);
  const [context, setContext] = useState<ExplorerContext | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer); }, [search]);
  const filter = explorerFilter(params, query);
  const queryString = explorerQuery(filter);
  const endpoint = view === 'sources' ? 'sessions' : view;
  const requestKey = `${endpoint}/${id ?? ''}?${queryString}:${refreshToken}`;
  const result = response?.key === requestKey ? response.data : null;
  const error = response?.key === requestKey ? response.error : null;
  const loading = response?.key !== requestKey;
  useEffect(() => {
    let cancelled = false;
    void api.get<Result>(`/api/history/${endpoint}${id ? `/${encodeURIComponent(id)}` : ''}?${queryString}`).then(value => {
      if (!cancelled) { setResponse({ key: requestKey, data: value, error: null }); setContext(value.context); }
    }).catch(err => { if (!cancelled) setResponse({ key: requestKey, data: null, error: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [endpoint, id, queryString, refreshToken, requestKey]);
  const update = (changes: Record<string, string | undefined>, next = view, nextId = id) => {
    window.location.hash = explorerHref(next, { page: undefined, ...changes }, nextId);
  };
  const clear = () => {
    setSearch(''); setQuery(''); window.location.hash = `#${view}`;
  };
  const summary = result?.summary;
  const selectedSource = context?.sources.find(s => s.id === filter.source);
  const fullContext = result?.context ?? context;
  if (view === 'sources') return <section className="data-panel explorer-capabilities"><header className="panel-head"><h2>本机明细支持情况</h2></header>
    {error ? <p role="alert">{error}</p> : <Capabilities context={fullContext} />}
    <p className="panel-note">DeepSeek 账单与无会话关联的通用导入仅参与总览。标题与项目目录保存在本机，不保存聊天正文。</p></section>;
  return <div className="explorer" aria-busy={loading}>
    <div className="telemetry-heading"><div><div className="explorer-eyebrow">LOCAL USAGE EXPLORER</div><h1>{view === 'sessions' ? '会话' : view === 'workspaces' ? '工作区' : '联动分析'}<span className="heading-dot">.</span></h1></div><span className="subtle-chip">本机已记录用量 · UTC</span></div>
    <p className="explorer-intro">从项目目录到每一次会话，查看用量去了哪里。所有指标跟随下方筛选，账户官方累计见<a href="#overview">总览</a>。</p>
    <section className="explorer-filters data-panel" aria-label="明细筛选">
      <div className="explorer-filter-row">
        <label>来源<select aria-label="明细来源" value={filter.source ?? ''} onChange={e => update({ source: e.target.value || undefined, workspaceId: undefined, model: undefined })}><option value="">全部已纳入来源</option>{fullContext?.sources.map(s => <option key={s.id} value={s.id}>{s.label}{!s.included ? ' · 单独查看' : ''}</option>)}</select></label>
        <label>工作区<select aria-label="项目工作区" value={filter.workspaceId ?? ''} onChange={e => update({ workspaceId: e.target.value || undefined })}><option value="">全部工作区</option>{fullContext?.workspaces.map(w => <option key={w.id} value={w.id}>{w.directory ?? '未归属工作区'}</option>)}</select></label>
        <label>模型<select aria-label="明细模型" value={filter.model ?? ''} onChange={e => update({ model: e.target.value || undefined })}><option value="">全部模型</option>{fullContext?.models.map(m => <option key={m}>{m}</option>)}</select></label>
        <label className="explorer-search">搜索<input type="search" aria-label="搜索会话标题、标识或目录" placeholder="标题、会话标识或目录" value={search} maxLength={200} onChange={e => { setSearch(e.target.value); if (params.has('page')) update({ page: undefined }); }} /></label>
      </div>
      <div className="explorer-filter-row explorer-dates"><span>日期范围 · UTC</span><div className="segmented">{[0, 7, 30, 90].map(days => {
        const range = recentUtcRange(days); return <button key={days} aria-pressed={filter.from === range.from && filter.to === range.to} onClick={() => update(range)}>{days ? `${days} 天` : '全部'}</button>;
      })}</div><label>从<input type="date" aria-label="开始日期 UTC" value={filter.from ?? ''} onChange={e => update({ from: e.target.value || undefined })} /></label><label>至<input type="date" aria-label="结束日期 UTC" value={filter.to ?? ''} onChange={e => update({ to: e.target.value || undefined })} /></label><button className="explorer-reset" onClick={clear}>清除筛选</button></div>
    </section>
    {selectedSource && !selectedSource.included && <div className="telemetry-notice">当前单独查看 {selectedSource.label}：{selectedSource.reason ?? '此来源未纳入全部来源合计。'}</div>}
    {!!fullContext?.sources.filter(s => filter.source ? s.id === filter.source : s.included).some(s => s.sync.stale) && <div className="telemetry-notice" role="status">部分来源同步失败，当前显示上次成功的本机明细。<a href="#sources">查看数据源</a></div>}
    {!!fullContext?.unknownDateRecords && <div className="explorer-note">有 {num(fullContext.unknownDateRecords)} 条记录缺少日期，{filter.from || filter.to ? '已从当前日期范围排除' : '已纳入全部历史，但不绘入趋势'}。</div>}
    {!loading && fullContext && !fullContext.sources.some(s => s.indexed) && <div className="telemetry-notice">尚未建立会话明细索引。旧汇总仍可在总览查看，请前往<a href="#sources">数据源</a>同步本机历史。</div>}
    {error && <div className="telemetry-notice error" role="alert">{error}<button onClick={reload}>重试</button>{id && <a href={explorerHref(view, {}, undefined)}>返回列表</a>}</div>}
    {loading && <div className="explorer-loading" role="status">正在读取本机明细…</div>}
    {summary && <MetricCards summary={summary} />}
    {result && isSessionDetail(result) && <>
      <section className="data-panel explorer-detail"><a className="explorer-back" href={explorerHref('sessions', {}, undefined)}>← 会话列表</a><h2>{result.session.title ?? '未命名会话'}</h2><dl><dt>来源</dt><dd>{LABELS[result.session.source]}</dd><dt>会话标识</dt><dd>{result.session.sourceSessionId}</dd><dt>项目目录</dt><dd><a href={explorerHref('workspaces', { source: result.session.source, page: undefined }, result.session.workspaceId)}>{result.session.directory ?? '未归属工作区'}</a></dd><dt>首次已记录用量</dt><dd>{dateTime(result.session.firstAt)} UTC</dd><dt>最近已记录用量</dt><dd>{dateTime(result.session.lastAt)} UTC</dd></dl><TokenDetails summary={result.summary} /></section>
      <AnalysisPanels data={result} params={params} update={update} />
    </>}
    {result && isWorkspaceDetail(result) && <>
      <section className="data-panel explorer-detail"><a className="explorer-back" href={explorerHref('workspaces', {}, undefined)}>← 工作区列表</a><h2>{dirName(result.workspace.directory)}</h2><p className="explorer-path">{result.workspace.directory ?? '没有明确记录项目目录'}</p><p>{result.workspace.sources.map(s => LABELS[s]).join(' · ')} · 最近已记录用量 {dateTime(result.workspace.lastAt)} UTC</p><TokenDetails summary={result.summary} /></section>
      <AnalysisPanels data={result} params={params} update={update} />
      <SessionTable data={result.sessions} params={params} update={update} />
    </>}
    {result && !id && view === 'sessions' && 'items' in result && <SessionTable data={result as ExplorerList<ExplorerSession>} params={params} update={update} />}
    {result && !id && view === 'workspaces' && 'items' in result && <WorkspaceTable data={result as ExplorerList<ExplorerWorkspace>} params={params} update={update} />}
    {result && !id && view === 'analytics' && 'trend' in result && <AnalysisPanels data={result} params={params} update={update} />}
  </div>;
}
type Update = (changes: Record<string, string | undefined>) => void;
function MetricCards({ summary }: { summary: ExplorerMetrics }) {
  const sample = summary.cacheInputSample;
  const rate = sample && sample.inputTokens > 0 ? sample.cachedInputTokens / sample.inputTokens * 100 : null;
  return <div className="explorer-kpis">{[['已知 Token', summary.totals.totalTokens], ['会话数', summary.sessionCount], ['输入 Token', summary.totals.inputTokens], ['输出 Token', summary.totals.outputTokens]].map(([label, value]) => <article className="glass" key={String(label)}><span>{label}</span><strong title={num(value as number | null)}><AdaptiveNumber value={value as number | null} /></strong></article>)}<article className="glass"><span>缓存输入占比</span><strong>{rate === null ? '—' : `${rate.toFixed(1)}%`}</strong><small title={sample ? `配对记录 ${sample.matchedRecords} / ${sample.totalRecords}，已知配对输入 ${num(sample.inputTokens)}` : '没有有效配对记录'}>{sample && sample.matchedRecords < sample.totalRecords ? '部分记录 · 有效配对口径' : '有效配对口径'}</small></article></div>;
}
function TokenDetails({ summary }: { summary: ExplorerMetrics }) {
  return <div className="explorer-token-details">{(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const).map((key, i) => <div key={key}><span>{['输入', '输出', '缓存输入（子项）', '推理输出（子项）'][i]}</span><strong>{num(summary.totals[key])}</strong><small>{summary.coverage[key] === 'complete' ? '字段完整' : summary.coverage[key] === 'partial' ? '部分记录' : '未知'}</small></div>)}</div>;
}
function Sorting({ params, update, defaultSort }: { params: URLSearchParams; update: Update; defaultSort: string }) {
  return <div className="explorer-sort"><label>排序<select aria-label="排序字段" value={params.get('sort') ?? defaultSort} onChange={e => update({ sort: e.target.value })}><option value="recent">最近用量</option><option value="tokens">Token</option><option value="name">名称</option></select></label><button aria-label="切换排序方向" onClick={() => update({ direction: params.get('direction') === 'asc' ? 'desc' : 'asc' })}>{params.get('direction') === 'asc' ? '↑ 升序' : '↓ 降序'}</button></div>;
}
function Pagination({ data, update }: { data: { total: number; page: number; pageSize: number }; update: Update }) {
  return <div className="explorer-pagination"><span>共 {num(data.total)} 项 · 每页 {data.pageSize} 项</span><div><button disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) })}>上一页</button><span>{data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button disabled={data.page * data.pageSize >= data.total} onClick={() => update({ page: String(data.page + 1) })}>下一页</button></div></div>;
}
function Empty() { return <div className="explorer-empty">当前条件下没有记录。可调整日期、来源或清除筛选。</div>; }
function SessionTable({ data, params, update }: { data: ExplorerList<ExplorerSession>; params: URLSearchParams; update: Update }) {
  return <section className="data-panel"><header className="panel-head"><h2>会话记录</h2><Sorting params={params} update={update} defaultSort="recent" /></header>{data.items.length ? <div className="explorer-table-scroll"><table className="explorer-table"><thead><tr><th>会话</th><th>工作区</th><th>模型</th><th>Token</th><th>最近用量 · UTC</th></tr></thead><tbody>{data.items.map(s => <tr key={s.id}><td><a className="explorer-title-link" href={explorerHref('sessions', { source: params.get('source') ?? undefined }, s.id)}>{s.title ?? '未命名会话'}</a><small>{LABELS[s.source]} · {s.sourceSessionId.slice(0, 16)} · {s.coverage.totalTokens === 'complete' ? '总量字段完整' : '已知部分'}</small></td><td><a title={s.directory ?? ''} href={explorerHref('workspaces', {}, s.workspaceId)}>{dirName(s.directory)}</a></td><td><span title={s.models.join('\n')}>{s.models.length === 1 ? s.models[0] : `${s.models.length} 个模型`}</span></td><td className="num">{num(s.totals.totalTokens)}</td><td>{dateTime(s.lastAt)}</td></tr>)}</tbody></table></div> : <Empty />}<Pagination data={data} update={update} /></section>;
}
function WorkspaceTable({ data, params, update }: { data: ExplorerList<ExplorerWorkspace>; params: URLSearchParams; update: Update }) {
  const table = params.get('layout') === 'table', max = Math.max(1, ...data.items.map(w => w.totals.totalTokens ?? 0));
  return <section className="data-panel"><header className="panel-head"><h2>项目目录</h2><div className="explorer-controls"><div className="segmented"><button aria-pressed={!table} onClick={() => update({ layout: undefined })}>排行</button><button aria-pressed={table} onClick={() => update({ layout: 'table' })}>表格</button></div><Sorting params={params} update={update} defaultSort="tokens" /></div></header>
    {!data.items.length ? <Empty /> : table ? <div className="explorer-table-scroll"><table className="explorer-table"><thead><tr><th>项目目录</th><th>Token</th><th>会话数</th><th>来源数</th><th>最近用量 · UTC</th></tr></thead><tbody>{data.items.map(w => <tr key={w.id}><td><a href={explorerHref('workspaces', {}, w.id)}>{w.directory ?? '未归属工作区'}</a></td><td className="num">{num(w.totals.totalTokens)}</td><td>{num(w.sessionCount)}</td><td>{w.sources.length}</td><td>{dateTime(w.lastAt)}</td></tr>)}</tbody></table></div> : <div className="explorer-workspace-ranks">{data.items.map((w, i) => <a key={w.id} className="explorer-workspace-rank" href={explorerHref('workspaces', {}, w.id)}><span className="rank-index">{(i + 1 + (data.page - 1) * data.pageSize).toString().padStart(2, '0')}</span><div><div className="explorer-rank-heading"><strong>{dirName(w.directory)}</strong><strong>{num(w.totals.totalTokens)} <small>Token</small></strong></div><p>{w.directory ?? '没有明确记录项目目录'}</p><div className="rank-track"><i style={{ width: `${Math.max(0, (w.totals.totalTokens ?? 0) / max * 100)}%`, background: COLORS[i % COLORS.length] }} /></div><small>{w.sessionCount} 个会话 · {w.sources.length} 个来源 · {dateTime(w.lastAt)} UTC</small></div></a>)}</div>}
    <Pagination data={data} update={update} /></section>;
}
function AnalysisPanels({ data, params, update }: { data: ExplorerAnalytics; params: URLSearchParams; update: Update }) {
  const table = params.get('matrix') === 'table';
  const drill = (workspaceId: string, model: string) => explorerHref('sessions', { workspaceId, model, page: undefined }, undefined);
  const matrixMax = Math.max(1, ...data.matrix.topRows.map(r => r.totalTokens ?? 0));
  return <>
    <section className="data-panel"><header className="panel-head"><h2>用量趋势分解</h2><div className="explorer-controls"><label>粒度<select aria-label="趋势粒度" value={params.get('granularity') ?? 'day'} onChange={e => update({ granularity: e.target.value })}><option value="day">日</option><option value="week">周</option><option value="month">月</option></select></label><label>分组<select aria-label="趋势分组" value={params.get('split') ?? 'model'} onChange={e => update({ split: e.target.value })}><option value="model">模型</option><option value="source">来源</option></select></label><div className="segmented"><button aria-pressed={params.get('chart') !== 'line'} onClick={() => update({ chart: undefined })}>堆叠柱状图</button><button aria-pressed={params.get('chart') === 'line'} onClick={() => update({ chart: 'line' })}>折线</button></div></div></header><TrendChart data={data} line={params.get('chart') === 'line'} source={params.get('split') === 'source'} update={update} /><p className="panel-note">日期采用 UTC；周从周一开始。仅绘制已知记录，缺失不补零；分项修正保留原始差分。</p></section>
    <div className="explorer-models data-panel"><header className="panel-head"><h2>模型分布</h2><span className="subtle-chip">点击筛选</span></header><div>{data.byModel.map((m, i) => <button key={m.model} onClick={() => update({ model: params.get('model') === m.model ? undefined : m.model })}><i style={{ background: COLORS[i % COLORS.length] }} /><span>{m.model}</span><strong>{num(m.totalTokens)}</strong></button>)}</div></div>
    <section className="data-panel"><header className="panel-head"><h2>工作区 × 模型</h2><div className="segmented"><button aria-pressed={!table} onClick={() => update({ matrix: undefined })}>热力图</button><button aria-pressed={table} onClick={() => update({ matrix: 'table' })}>完整表格</button></div></header><p className="panel-note">{table ? '完整交叉结果，按用量排序；点击进入关联会话。' : `当前展示前 ${data.matrix.workspaces.length} 个工作区 × ${data.matrix.models.length} 个模型；点击单元格查看会话。灰色表示没有记录。`}</p>
      {!data.matrix.total ? <Empty /> : table ? <><div className="explorer-table-scroll"><table className="explorer-table"><thead><tr><th>工作区</th><th>模型</th><th>Token</th></tr></thead><tbody>{data.matrix.rows.map(r => <tr key={`${r.workspaceId}:${r.model}`}><td><a href={drill(r.workspaceId, r.model)}>{r.directory ?? '未归属工作区'}</a></td><td>{r.model}</td><td className="num">{num(r.totalTokens)}</td></tr>)}</tbody></table></div><Pagination data={data.matrix} update={update} /></> : <div className="explorer-table-scroll"><table className="explorer-matrix"><thead><tr><th>工作区 / 模型</th>{data.matrix.models.map(m => <th key={m} title={m}>{m}</th>)}</tr></thead><tbody>{data.matrix.workspaces.map(w => <tr key={w.id}><th title={w.directory ?? ''}>{dirName(w.directory)}</th>{data.matrix.models.map(m => { const cell = data.matrix.topRows.find(r => r.workspaceId === w.id && r.model === m); return <td key={m}>{cell ? <a href={drill(w.id, m)} style={{ background: cell.totalTokens == null ? '#edf1f4' : `color-mix(in srgb, #18aab8 ${12 + Math.max(0, cell.totalTokens) / matrixMax * 60}%, #f1fafa)` }} title={`${w.directory ?? '未归属工作区'} · ${m} · ${num(cell.totalTokens)} Token`}>{num(cell.totalTokens)}</a> : <span aria-label="没有记录">—</span>}</td>; })}</tr>)}</tbody></table></div>}
    </section>
  </>;
}
function TrendChart({ data, line, source, update }: { data: ExplorerAnalytics; line: boolean; source: boolean; update: Update }) {
  if (!data.trend.length) return <Empty />;
  const names = [...new Set(data.trend.flatMap(p => p.series.map(s => s.name)))];
  const width = Math.max(720, data.trend.length * 13), left = 65, right = width - 25, top = 20, bottom = 230;
  const max = Math.max(1, ...data.trend.map(p => p.series.reduce((sum, s) => sum + Math.max(0, s.totalTokens ?? 0), 0)));
  const negative = data.trend.some(p => p.series.some(s => (s.totalTokens ?? 0) < 0));
  const min = Math.min(0, ...data.trend.map(p => p.series.reduce((sum, s) => sum + Math.min(0, s.totalTokens ?? 0), 0)));
  const y = (v: number) => bottom - (v - min) / (max - min) * (bottom - top);
  const band = (right - left) / data.trend.length;
  const x = (i: number) => left + band * (i + .5);
  return <><div className="explorer-chart-scroll"><svg className="explorer-trend" width={width} height="270" viewBox={`0 0 ${width} 270`} role="img" aria-label={line ? '本机用量分组折线图' : '本机用量堆叠柱状图'}>
    {[0, .5, 1].map(t => <g key={t}><line x1={left} x2={right} y1={y(min + (max - min) * t)} y2={y(min + (max - min) * t)} stroke="#e4edf0" /><text x={left - 8} y={y(min + (max - min) * t) + 4} textAnchor="end">{new Intl.NumberFormat('zh-CN', { notation: 'compact' }).format(min + (max - min) * t)}</text></g>)}
    {line ? names.map((name, n) => { const points = data.trend.map((p, i) => { const v = p.series.find(s => s.name === name)?.totalTokens; return v == null ? null : { i, v, period: p.period }; }); let path = ''; let continuous = false; for (const p of points) { if (!p) { continuous = false; continue; } path += `${continuous ? ' L' : ' M'}${x(p.i)},${y(p.v)}`; continuous = true; } return <g key={name}><path d={path} fill="none" stroke={COLORS[n % COLORS.length]} strokeWidth="2" />{points.filter(p => p !== null).map(p => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="3" fill={COLORS[n % COLORS.length]}><title>{p.period} · {LABELS[name] ?? name} · {num(p.v)} Token</title></circle>)}</g>; }) : data.trend.map((p, i) => { let pos = 0, neg = 0; return <g key={p.period}>{names.map((name, n) => { const value = p.series.find(s => s.name === name)?.totalTokens; if (value == null) return null; const start = value >= 0 ? pos : neg; if (value >= 0) pos += value; else neg += value; return <rect key={name} x={x(i) - band * .35} y={Math.min(y(start), y(start + value))} width={band * .7} height={Math.max(1, Math.abs(y(start + value) - y(start)))} fill={COLORS[n % COLORS.length]}><title>{p.period} · {LABELS[name] ?? name} · {num(value)} Token</title></rect>; })}</g>; })}
    {data.trend.filter((_, i) => i % Math.max(1, Math.ceil(data.trend.length / 8)) === 0).map(p => <text key={p.period} x={x(data.trend.indexOf(p))} y="257" textAnchor="middle">{p.period}</text>)}
    {negative && <line x1={left} x2={right} y1={y(0)} y2={y(0)} stroke="#83969c" />}
  </svg></div><div className="explorer-chart-legend">{names.map((name, i) => <button key={name} onClick={() => update(source ? { source: name } : { model: name })}><i style={{ background: COLORS[i % COLORS.length] }} />{LABELS[name] ?? name}</button>)}</div></>;
}
function Capabilities({ context }: { context: ExplorerContext | null }) {
  return <div className="explorer-table-scroll"><table className="explorer-table"><thead><tr><th>来源</th><th>会话索引</th><th>已有标题</th><th>已有目录</th><th>最近成功同步</th></tr></thead><tbody>{context?.sources.map(s => <tr key={s.id}><td>{s.label}</td><td>{s.indexed ? `${s.sessions} 个会话${s.sync.stale ? ' · 旧数据' : ''}` : '同步后建立'}</td><td>{s.indexed ? `${s.titles} / ${s.sessions}` : '—'}</td><td>{s.indexed ? `${s.directories} / ${s.sessions}` : '—'}</td><td>{dateTime(s.sync.lastSuccessAt)} UTC</td></tr>)}</tbody></table></div>;
}
