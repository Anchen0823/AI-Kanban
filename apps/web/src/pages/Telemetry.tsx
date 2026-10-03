import type { HistoryDashboard } from '@aicc/core';
import { historySync, startHistorySync } from '../history-sync.js';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { smoothPath } from '../chart-path.js';
import { AdaptiveNumber } from '../AdaptiveNumber.js';
import { api, getWorkspace } from '../api.js';
import { aggregate, cacheInputSummary, buildSources, calendarDays, formatNumber as number, LOCAL_SOURCES, sumKnown, type SourceData, type TotalHistory } from '../analytics.js';

const COLORS = ['#18aab8', '#63a4ee', '#52bea2', '#9a98df', '#e4b06b', '#6c9da9'];
type Point = { day: string; value: number | null };
export function Telemetry({ refreshToken, reload, sourceOnly = false }: { refreshToken: number; reload: () => void; sourceOnly?: boolean }): ReactNode {
  const [total, setTotal] = useState<TotalHistory | null>(null);
  const [sources, setSources] = useState<SourceData[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingSource, setSwitchingSource] = useState(false);
  const switchCodexSource = async (source: 'official' | 'local') => {
    setSwitchingSource(true);
    try {
      await api.post('/api/history/codex/source', { source });
      const snapshot = await api.get<HistoryDashboard>('/api/history/dashboard');
      setTotal(snapshot.total);
      setSources(buildSources(snapshot.total, snapshot.local, snapshot.imported));
    } catch (error) { setErrors([error instanceof Error ? error.message : String(error)]); }
    finally { setSwitchingSource(false); }
  };
  const progress = useSyncExternalStore(historySync.subscribe, historySync.snapshot);
  const busy = Object.values(progress).some(p => p.phase === 'queued' || p.phase === 'running');
  const [selected, setSelectedState] = useState('all');
  const setSelected = (value: string) => {
    setSelectedState(value);
    if (sourceOnly) window.location.hash = '#overview';
  };
  const [period, setPeriod] = useState(30);
  const [chart, setChart] = useState<'area' | 'bar'>('area');
  const [modelView, setModelView] = useState<'bars' | 'table'>('bars');
  const [directory, setDirectory] = useState('');
  const [deepseekOpen, setDeepseekOpen] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const demo = getWorkspace() === 'demo';
  const [navTarget, setNavTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setNavTarget(document.getElementById('nav-sync')), []);
  useEffect(() => historySync.onCompleted(reload), [reload]);
  useEffect(() => { if (demo) { setDirectory(''); setDeepseekOpen(false); } }, [demo]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.get<HistoryDashboard>('/api/history/dashboard').then(snapshot => {
      if (cancelled) return;
      setTotal(snapshot.total);
      const next = buildSources(snapshot.total, snapshot.local, snapshot.imported);
      setSources(next);
      if (!demo && snapshot.local.deepseek?.sourceDirectory) setDirectory(current => current || snapshot.local.deepseek!.sourceDirectory!);
      const latest = next.map(s => s.sync ? s.sync.lastSuccessAt : s.checkedAt).filter((at): at is string => !!at).sort().at(-1);
      setUpdated(latest ? new Date(latest).toLocaleString('zh-CN', { hour12: false }) : null);
      setErrors([]); setLoading(false);
      if (!demo) startHistorySync();
    }).catch(error => {
      if (!cancelled) { setErrors([error instanceof Error ? error.message : String(error)]); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [refreshToken, demo]);
  const sync = useCallback(async (id: string) => {
    if (demo) return;
    await historySync.sync(id === 'all' ? ['codex', 'workbuddy', 'opencode', 'minimax'] : [id],
      id === 'deepseek' ? { directory: directory.trim() } : {});
    if (id === 'deepseek' && historySync.snapshot().deepseek?.phase === 'ok') setDeepseekOpen(false);
  }, [demo, directory]);
  const data = useMemo(() => aggregate(sources, selected), [sources, selected]);
  const visibleDays = useMemo(() => calendarDays(data.days, period || (data.days.length ? Math.round((Date.parse(data.days.at(-1)!.day) - Date.parse(data.days[0]!.day)) / 86400000) + 1 : 0)), [data.days, period]);
  const heatDays = useMemo(() => calendarDays(data.days, 91), [data.days]);
  const activeTotal = selected === 'all' ? total?.totalTokens : sources.find(s => s.id === selected)?.total;
  const cacheSummary = cacheInputSummary(data.active);
  const cachedRate = cacheSummary.rate;
  const endDay = data.days.at(-1)?.day;
  const dailySum = sumKnown(visibleDays.map(p => p.value));
  const peak = visibleDays.reduce<Point | null>((best, p) => p.value != null && (best == null || p.value > (best.value ?? -1)) ? p : best, null);
  const fmt = (v: number | null | undefined) => <AdaptiveNumber value={v} />;
  const included = sources.filter(s => s.included && s.total != null);
  const codexSource = data.active.find(s => s.id === 'codex');
  const officialCodex = codexSource?.statisticsSource === 'official';
  const codexNote = total?.partial ? '已知用量合计' : '历史累计';
  return <div className={`telemetry${sourceOnly ? ' telemetry-source-only' : ''}`} aria-busy={loading}>
    <div className="telemetry-heading"><div><h1>用量统计<span className="heading-dot">.</span></h1></div><div className="codex-source-switch"><span>Codex</span><div className="segmented" role="group" aria-label="Codex 统计来源">{(['official', 'local'] as const).map(source => <button key={source} disabled={demo || loading || switchingSource} aria-pressed={(sources.find(s => s.id === 'codex')?.selectedSource ?? 'official') === source} onClick={() => void switchCodexSource(source)}>{source === 'official' ? '官方' : '本地'}</button>)}</div></div></div>
    {navTarget && createPortal(<button className="nav-sync-button" aria-label="同步本机用量" title={busy ? '正在同步…' : '同步并刷新本机用量'} disabled={!!busy || demo} onClick={() => void sync('all')}><span className={busy ? 'spin' : ''}>↻</span></button>, navTarget)}
    {!!errors.length && <div className="telemetry-notice error" role="alert">部分数据读取失败，现有数据可能不是最新。{errors.join(' / ')}<button onClick={reload}>重试</button></div>}
    {codexSource?.officialMessage && !officialCodex && <div className="telemetry-notice" role="status">Codex：{codexSource.officialMessage}</div>}
    <section className="kpi-grid" aria-label="核心用量指标">
      <Kpi title="累计 Token" value={fmt(activeTotal)} exact={number(activeTotal)} note={codexNote} hero><MiniSpark days={data.days} /></Kpi>
      <Kpi title="输入 Token" value={fmt(data.input)} exact={number(data.input)}><span className="kpi-glyph">↗</span></Kpi>
      <Kpi title="输出 Token" value={fmt(data.output)} exact={number(data.output)}><span className="kpi-glyph">↙</span></Kpi>
      <Kpi title="缓存输入占比" value={cachedRate == null ? '—' : `${cachedRate.toFixed(1)}%`} exact={cacheSummary.explanation} note={cacheSummary.note}><svg className="cache-ring" viewBox="0 0 50 50" aria-hidden="true"><circle cx="25" cy="25" r="19" /><circle cx="25" cy="25" r="19" pathLength="100" strokeDasharray={`${cachedRate ?? 0} 100`} /></svg></Kpi>
    </section>
    <div className="chart-grid" id="activity">
      <section className="data-panel trend-panel"><PanelHead title="用量趋势" accessory={<div className="segmented" aria-label="趋势时间范围">{[[7,'7 天'],[30,'30 天'],[90,'90 天'],[0,'全部']].map(([value,text]) => <button key={value} aria-pressed={period === value} onClick={() => setPeriod(Number(value))}>{text}</button>)}</div>} />
        <div className="trend-meta"><div><strong>{fmt(dailySum)}</strong><span>区间 Token</span></div><div className="segmented chart-switch"><button aria-pressed={chart === 'area'} onClick={() => setChart('area')}>曲线</button><button aria-pressed={chart === 'bar'} onClick={() => setChart('bar')}>柱状</button></div></div>
        <TrendChart days={visibleDays} mode={chart} />
        <div className="chart-foot"><span><i className="legend-dot" />{endDay ? `截至 ${endDay}` : '等待首份历史记录'}</span><span>峰值 {peak ? `${peak.day.slice(5)} / ${number(peak.value)}` : '—'}</span></div>
      </section>
      <section className="data-panel distribution-panel"><PanelHead title="来源占比" accessory={<span className="subtle-chip">{included.length} 个来源</span>} /><SourceDonut sources={included} selected={selected} select={setSelected} /></section>
    </div>
    <div className="detail-grid" id="models">
      <section className="data-panel model-panel"><PanelHead title="模型排行" accessory={<div className="segmented"><button aria-pressed={modelView === 'bars'} onClick={() => setModelView('bars')}>排行</button><button aria-pressed={modelView === 'table'} onClick={() => setModelView('table')}>表格</button></div>} />
        {data.models.length ? modelView === 'bars' ? <div className="model-ranks">{data.models.map((model,i) => <div className="model-rank" key={model.name}><span className="rank-index">{String(i + 1).padStart(2,'0')}</span><div><div className="rank-label"><span title={model.name}>{model.name}</span><strong title={number(model.value)}>{fmt(model.value)}</strong></div><div className="rank-track"><i style={{ width: `${data.models[0]?.value ? Math.max(0,(model.value ?? 0) / data.models[0].value * 100) : 0}%`, background: COLORS[i % COLORS.length] }} /></div></div></div>)}</div> : <div className="analytics-table"><table><thead><tr><th>模型</th><th className="num">累计 Token</th></tr></thead><tbody>{data.models.map(model => <tr key={model.name}><td>{model.name}</td><td className="num">{number(model.value)}</td></tr>)}</tbody></table></div> : <ChartEmpty text="暂无模型数据" />}
      </section>
      <section className="data-panel composition-panel"><PanelHead title="Token 构成" /><div className="composition-total"><span>输入 + 输出</span><strong>{fmt(sumKnown([data.input, data.output]))}</strong></div><div className="composition-track" aria-label="输入与输出比例">{[['输入',data.input],['输出',data.output]].map(([name,value],i) => <span key={name} title={`${name} ${number(value as number | null)}`} style={{ width: `${(sumKnown([data.input,data.output]) ?? 0) > 0 ? Number(value ?? 0) / sumKnown([data.input,data.output])! * 100 : 0}%`, background: COLORS[i] }} />)}</div><div className="composition-rows">{[['输入',data.input],['输出',data.output],['缓存输入',data.cached],['推理输出',data.reasoning]].map(([name,value],i) => <div key={name}><span><i style={{background:COLORS[i % 2]}} />{name}</span><strong title={number(value as number | null)}>{fmt(value as number | null)}</strong></div>)}</div><p className="panel-note">缓存、推理为子项</p></section>
      <section className="data-panel heat-panel"><PanelHead title="活动热力图" accessory={<span className="subtle-chip">13 周</span>} /><Heatmap days={heatDays} /><div className="heat-insight"><strong>{heatDays.some(d => d.value != null) ? heatDays.filter(d => d.value != null && d.value > 0).length : '—'}</strong><span>活跃天数<br /><small>{endDay ? `截至 ${endDay}` : '尚未同步'}</small></span></div></section>
    </div>
    <section className="data-panel source-panel" id="sources"><PanelHead title="数据源" accessory={<span className="read-time">{loading ? '读取中…' : updated ? `最近成功同步 ${updated}` : '尚无成功同步'}</span>} />
      {selected !== 'all' && <div className="source-selection" role="status"><span>正在查看：{sources.find(s => s.id === selected)?.label}{sources.find(s => s.id === selected)?.included === false ? ' · ' + (sources.find(s => s.id === selected)?.reason ?? '未计入全部合计') : ''}</span><button onClick={() => setSelected('all')}>查看全部</button></div>}
      <div className="source-strip">{LOCAL_SOURCES.map(([id,name],index) => {
        const source = sources.find(s => s.id === id);
        const task = progress[id];
        const running = task?.phase === 'running' || task?.phase === 'queued';
        const failed = task?.phase === 'error' || source?.sync?.lastAttempt?.status === 'error';
        const lastSuccess = source?.sync ? source.sync.lastSuccessAt : source?.checkedAt;
        const failure = task?.phase === 'error' ? task.message : source?.sync?.lastAttempt?.message;
        return <div className="source-tile" key={id} data-source={id}><div className="source-tile-top"><span className="provider-icon" style={{color:COLORS[index]}}>{name[0]}</span><strong>{name}</strong><span className={`source-led ${source?.included ? 'ready' : ''}`} title={source?.included ? '已计入统计' : '尚未计入'} /></div>
          <strong className="source-value" title={number(source?.total)}>{fmt(source?.total)}</strong>
          <span className="source-state" title={failed ? failure : source?.reason ?? ''}>{demo ? '示例模式' : running ? task.phase === 'queued' ? '等待同步' : '同步中…' : failed ? source?.sync?.stale ? '同步失败 · 显示旧数据' : '同步失败' : source?.included ? '已计入' : source?.total != null ? '未计入总量' : source?.sync?.lastAttempt?.status === 'empty' ? '未发现记录' : '等待同步'}</span>
          <time className="source-time" dateTime={lastSuccess ?? undefined} title={lastSuccess ?? '尚无成功同步'}>{lastSuccess ? new Date(lastSuccess).toLocaleString('zh-CN', {hour12:false}) : '尚无成功同步'}</time>
          <div className="source-actions"><button disabled={running || demo} onClick={() => id === 'deepseek' ? setDeepseekOpen(!deepseekOpen) : void sync(id)}>{running ? '同步中…' : id === 'deepseek' ? '读取历史导出 ↗' : failed ? '重试 ↻' : '同步 ↻'}</button><button aria-pressed={selected === id} disabled={source?.total == null} onClick={() => setSelected(selected === id ? 'all' : id)}>查看</button></div>
          {failed && !demo && <details className="source-error"><summary>失败原因</summary><p>{failure}</p></details>}
        </div>;
      })}</div>
      {deepseekOpen && <form className="deepseek-form" onSubmit={e => { e.preventDefault(); void sync('deepseek'); }}><label htmlFor="deepseek-directory">DeepSeek 导出目录</label><div><input id="deepseek-directory" value={directory} onChange={e => setDirectory(e.target.value)} placeholder="包含 ZIP / CSV 的文件夹路径" required /><button className="sync-button" disabled={progress.deepseek?.phase === 'running' || progress.deepseek?.phase === 'queued' || !directory.trim()}>读取并统计</button></div><p className="panel-note">记住上次成功读取的目录，下次自动填入；仍由你按需读取。</p></form>}
      <details className="methodology"><summary>统计口径</summary><div className="analytics-table"><table><thead><tr><th>来源</th><th className="num">Token</th><th>合计规则</th></tr></thead><tbody>{sources.map(source => <tr key={source.id} data-source={source.id}><td>{source.label}{source.id === 'codex' ? source.statisticsSource === 'official' ? '（官方统计）' : '（本机日志）' : ''}</td><td className="num">{number(source.total)}</td><td>{source.included ? '已计入' : source.reason ?? '未知'} <button disabled={source.total == null} aria-label={`查看 ${source.label}`} onClick={() => setSelected(source.id)}>查看</button></td></tr>)}</tbody></table></div><p>总量以服务端统计为准，图表仅聚合已计入的来源；无记录的日期保持未知；曲线跨缺失日期实线连接仅用于展示趋势，不补入每日数值或区间合计。Codex 优先采用官方累计与每日记录。官方会话估算明细完整且与官方累计核对一致时，输入、输出、缓存及模型排行采用官方明细，否则采用本机日志。部分明细不冒充全账户明细，官方累计与本机日志不相加，未知分项不按比例补齐。官方数据不可用时回退并标明原因。本机记录按 UTC 日期，官方及 DeepSeek 按返回日期，跨来源的日边界可能不同。</p>{codexSource?.officialDetails && <p>{codexSource.officialDetails.message}{codexSource.officialDetails.status === 'partial' ? ` 已返回明细合计 ${number(codexSource.officialDetails.totals.totalTokens)} Token。` : ''}</p>}{[...new Set([...(total?.warnings ?? []),...data.active.flatMap(s => s.warnings)])].map(w => <p key={w}>{w}</p>)}</details>
    </section>
    <footer className="observatory-footer"><span><i className="live-dot" /> 本地存储</span></footer>
  </div>;
}
function Kpi({ title, value, exact, note, hero, children }: { title: string; value: ReactNode; exact: string; note?: string; hero?: boolean; children: ReactNode }) {
  return <article className={`kpi glass${hero ? ' hero-kpi' : ''}`}><span className="kpi-label">{title}</span><strong className="kpi-value" title={exact}>{value}</strong>{note ? <span className="kpi-note">{note}</span> : null}<div className="kpi-art" aria-hidden="true">{children}</div></article>;
}
function PanelHead({ title, accessory }: {title: string; accessory?: ReactNode}) { return <header className="panel-head"><div><h2>{title}</h2></div>{accessory}</header>; }
function ChartEmpty({text}: {text:string}) { return <div className="chart-empty"><span aria-hidden="true">⌁</span><strong>{text}</strong></div>; }
function MiniSpark({days}: {days:Point[]}) {
  const points = days.filter(d => d.value != null).slice(-20); const max = Math.max(1,...points.map(p => p.value!));
  return <svg viewBox="0 0 130 40"><path d={points.length > 1 ? smoothPath(points.map((p,i) => ({x:i / (points.length-1)*130,y:37-p.value!/max*32}))) : 'M0 32H130'} fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
}
export function TrendChart({ days, mode }: { days: Point[]; mode: 'area' | 'bar' }) {
  const [hover,setHover] = useState<number | null>(null);
  const max = Math.max(1,...days.map(p => p.value ?? 0));
  const width=720, height=190, left=52, right=704, top=12, bottom=157;
  const x = (i:number) => left + (i+.5)/Math.max(1,days.length)*(right-left);
  const y = (v:number) => bottom-v/max*(bottom-top);
  // Keep calendar positions while connecting observations across missing days.
  // Missing dates remain unknown in totals, bars and tooltips.
  const group = days.map((p,i) => ({p,i})).filter(({p}) => p.value != null);
  const groups = group.length ? [group] : [];
  const current = hover != null ? days[hover] : null;
  return <div className="trend-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`每日 Token ${mode === 'area' ? '曲线图' : '柱状图'}`} onMouseLeave={() => setHover(null)}>
    <defs><linearGradient id="aqua-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3abdc7" stopOpacity=".27"/><stop offset="100%" stopColor="#3abdc7" stopOpacity=".015"/></linearGradient></defs>
    {[0,.25,.5,.75,1].map(f => <g key={f}><line x1={left} x2={right} y1={y(max*f)} y2={y(max*f)} stroke="#e5edef" strokeDasharray="3 5"/><text x={left-10} y={y(max*f)+4} textAnchor="end">{number(max*f,true)}</text></g>)}
    {mode === 'area' ? groups.map((g,i) => { const d=smoothPath(g.map(({p,i}) => ({x:x(i),y:y(p.value!)}))); return <g key={i}><path d={`${d} L${x(g.at(-1)!.i)},${bottom} L${x(g[0]!.i)},${bottom} Z`} fill="url(#aqua-area)"/><path d={d} fill="none" stroke="#16a9b5" strokeWidth="2.5" strokeLinejoin="round"/>{g.length===1 && <circle cx={x(g[0]!.i)} cy={y(g[0]!.p.value!)} r="3" fill="#16a9b5"/>}</g>; }) : days.map((p,i) => p.value == null ? null : <rect key={p.day} x={x(i)-Math.max(1,(right-left)/days.length*.62)/2} y={y(p.value)} width={Math.max(1,(right-left)/days.length*.62)} height={Math.max(1,bottom-y(p.value))} rx="2" fill="#38b6c2"/>)}
    {days.map((p,i) => <rect key={p.day} x={left+i/days.length*(right-left)} y={top} width={(right-left)/days.length} height={bottom-top} fill="transparent" onMouseEnter={() => setHover(i)}><title>{`${p.day}: ${p.value == null ? '没有记录' : `${number(p.value)} Token`}`}</title></rect>)}
    {hover != null && current && <g pointerEvents="none"><line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke="#499ea8" strokeDasharray="3 4"/>{current.value != null && <circle cx={x(hover)} cy={y(current.value)} r="4" fill="#fff" stroke="#16a9b5" strokeWidth="2"/>}</g>}
    {[...new Set([0,Math.floor((days.length-1)/2),days.length-1])].filter(i=>i>=0 && days[i]).map(i => <text key={i} x={x(i)} y="182" textAnchor="middle">{days[i]!.day.slice(5)}</text>)}
  </svg>{!days.some(d=>d.value!=null) && <div className="chart-no-data">暂无趋势数据</div>}{current && <div className="chart-tooltip" role="status">{current.day} <b>{current.value == null ? '没有记录' : `${number(current.value)} Token`}</b></div>}</div>;
}
function SourceDonut({ sources, selected, select }: {sources:SourceData[]; selected:string; select:(id:string)=>void}) {
  const total=sumKnown(sources.map(s=>s.total)) ?? 0; let offset=0;
  return <div className="donut-layout"><div className="donut-visual"><svg viewBox="0 0 180 180" role="img" aria-label="来源用量环形图"><circle className="donut-guide" cx="90" cy="90" r="80"/><circle cx="90" cy="90" r="62" fill="none" stroke="#edf3f5" strokeWidth="17"/>{sources.map((s,i) => {const percent=total>0?s.total!/total*100:0; const start=offset;offset+=percent;return <circle key={s.id} cx="90" cy="90" r="62" fill="none" stroke={COLORS[i%COLORS.length]} strokeWidth={selected===s.id?21:17} pathLength="100" strokeDasharray={`${percent} ${100-percent}`} strokeDashoffset={-start} transform="rotate(-90 90 90)" opacity={selected==='all'||selected===s.id?1:.28}><title>{s.label} {number(s.total)} Token</title></circle>;})}</svg><div className="donut-center"><span>来源</span><strong>{sources.length.toString().padStart(2,'0')}</strong></div></div><div className="donut-legend">{sources.length ? sources.map((s,i) => <button className={selected===s.id?'selected':''} aria-pressed={selected===s.id} key={s.id} onClick={()=>select(selected===s.id?'all':s.id)}><i style={{background:COLORS[i%COLORS.length]}}/><span>{s.label}</span><strong title={number(s.total)}><AdaptiveNumber value={s.total} /></strong><small>{total>0?(s.total!/total*100).toFixed(1):'0'}%</small></button>) : <p className="empty-legend">暂无数据</p>}</div></div>;
}
function Heatmap({days}: {days:Point[]}) {
  const max=Math.max(1,...days.map(p=>p.value??0));
  return <><div className="heatmap" aria-label="过去十三周已记录用量">{(days.length?days:Array.from({length:91},(_,i)=>({day:`待同步 ${i+1}`,value:null}))).map(p=><div key={p.day} tabIndex={0} className="heat-cell" style={{background:p.value==null?'#eef3f5':p.value===0?'#d4e9eb':`color-mix(in srgb, #16a9b5 ${25+p.value/max*75}%, #e5f7f5)`}} title={`${p.day} · ${p.value==null?'没有记录':`${number(p.value)} Token`}`} aria-label={`${p.day} ${p.value==null?'没有记录':`${number(p.value)} Token`}`}/>)}</div><div className="heat-legend"><span>低</span>{['#d4e9eb','#a4dfdf','#64c7ce','#16a9b5'].map(c=><i key={c} style={{background:c}}/>)}<span>高</span></div></>;
}
