import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AdaptiveNumber } from '../AdaptiveNumber.js';
import { api, getWorkspace } from '../api.js';
import { aggregate, buildSources, calendarDays, formatNumber as number, LOCAL_SOURCES, sumKnown, type ImportedHistory, type LocalHistory, type SourceData, type TotalHistory } from '../analytics.js';

const COLORS = ['#18aab8', '#63a4ee', '#52bea2', '#9a98df', '#e4b06b', '#6c9da9'];
type Point = { day: string; value: number | null };
export function Telemetry({ refreshToken, reload }: { refreshToken: number; reload: () => void }): ReactNode {
  const [total, setTotal] = useState<TotalHistory | null>(null);
  const [sources, setSources] = useState<SourceData[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState('all');
  const [period, setPeriod] = useState(30);
  const [chart, setChart] = useState<'area' | 'bar'>('area');
  const [modelView, setModelView] = useState<'bars' | 'table'>('bars');
  const [directory, setDirectory] = useState('');
  const [deepseekOpen, setDeepseekOpen] = useState(false);
  const [updated, setUpdated] = useState<string | null>(null);
  const syncLock = useRef(false);
  const demo = getWorkspace() === 'demo';
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const requests = [...(demo ? [] : LOCAL_SOURCES.map(([id]) => [id, `/api/history/${id}`] as const)), ['imported', '/api/history/imported'], ['total', '/api/history/total']] as const;
    void Promise.allSettled(requests.map(([, path]) => api.get(path))).then(results => {
      if (cancelled) return;
      const local: Record<string, LocalHistory> = {};
      let imported: ImportedHistory | undefined;
      let nextTotal: TotalHistory | undefined;
      const issues: string[] = [];
      results.forEach((result, i) => {
        const key = requests[i]![0];
        if (result.status === 'rejected') { issues.push(`${key}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`); return; }
        if (key === 'total') nextTotal = result.value as TotalHistory;
        else if (key === 'imported') imported = result.value as ImportedHistory;
        else local[key] = result.value as LocalHistory;
      });
      if (nextTotal) { setTotal(nextTotal); setSources(buildSources(nextTotal, local, imported)); setUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false })); }
      setErrors(issues); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshToken, demo]);
  const sync = useCallback(async (id: string) => {
    if (syncLock.current || demo) return;
    syncLock.current = true; setBusy(id); setErrors([]);
    const issues: string[] = [];
    try {
      for (const target of id === 'all' ? ['codex', 'workbuddy', 'opencode', 'minimax'] : [id]) {
        try {
          const result = await api.post<LocalHistory>(`/api/history/${target}`, target === 'deepseek' ? { directory: directory.trim() } : {});
          if (result.status === 'error') issues.push(`${target}: ${result.message}`);
          if (target === 'deepseek' && result.status === 'ok') setDeepseekOpen(false);
        } catch (error) { issues.push(`${target}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (issues.length) setSyncMessage(issues.join(' / '));
      else setSyncMessage('同步完成，已重新读取可用统计。');
      reload();
    } finally { syncLock.current = false; setBusy(null); }
  }, [demo, directory, reload]);
  const [syncMessage, setSyncMessage] = useState('');
  const data = useMemo(() => aggregate(sources, selected), [sources, selected]);
  const visibleDays = useMemo(() => calendarDays(data.days, period || (data.days.length ? Math.round((Date.parse(data.days.at(-1)!.day) - Date.parse(data.days[0]!.day)) / 86400000) + 1 : 0)), [data.days, period]);
  const heatDays = useMemo(() => calendarDays(data.days, 91), [data.days]);
  const activeTotal = selected === 'all' ? total?.totalTokens : sources.find(s => s.id === selected)?.total;
  const cachedRate = data.input != null && data.input > 0 && data.cached != null ? Math.min(100, data.cached / data.input * 100) : null;
  const endDay = data.days.at(-1)?.day;
  const dailySum = sumKnown(visibleDays.map(p => p.value));
  const peak = visibleDays.reduce<Point | null>((best, p) => p.value != null && (best == null || p.value > (best.value ?? -1)) ? p : best, null);
  const fmt = (v: number | null | undefined) => <AdaptiveNumber value={v} />;
  const included = sources.filter(s => s.included && s.total != null);
  return <div className="telemetry" aria-busy={loading}>
    <div className="telemetry-heading"><div><h1>用量统计<span className="heading-dot">.</span></h1></div><div className="head-instrument" aria-hidden="true"><div className="orb"><i /><i /><i /><b>AI</b></div></div></div>
    <div className="control-deck glass"><div className="scope-controls"><select aria-label="统计来源" value={selected} onChange={e => setSelected(e.target.value)}><option value="all">全部来源</option>{sources.map(s => <option key={s.id} value={s.id}>{s.label}{s.included ? '' : ' · 单独查看'}</option>)}</select></div><div className="deck-actions"><button className="sync-button" disabled={!!busy || demo} onClick={() => void sync('all')}><span className={busy ? 'spin' : ''}>↻</span>{busy ? '正在同步…' : '同步本机用量'}</button></div></div>
    {!!errors.length && <div className="telemetry-notice error" role="alert">部分数据读取失败，现有数据可能不是最新。{errors.join(' / ')}<button onClick={reload}>重试</button></div>}
    {!!syncMessage && <div className="telemetry-notice" role="status">{syncMessage}<button aria-label="关闭同步提示" onClick={() => setSyncMessage('')}>×</button></div>}
    <section className="kpi-grid" aria-label="核心用量指标">
      <Kpi title="累计 Token" value={fmt(activeTotal)} exact={number(activeTotal)} note={total?.partial ? '已知用量合计' : '历史累计'} hero><MiniSpark days={data.days} /></Kpi>
      <Kpi title="输入 Token" value={fmt(data.input)} exact={number(data.input)}><span className="kpi-glyph">↗</span></Kpi>
      <Kpi title="输出 Token" value={fmt(data.output)} exact={number(data.output)}><span className="kpi-glyph">↙</span></Kpi>
      <Kpi title="缓存输入占比" value={cachedRate == null ? '—' : `${cachedRate.toFixed(1)}%`} exact={`${number(data.cached)} / ${number(data.input)}`}><svg className="cache-ring" viewBox="0 0 50 50" aria-hidden="true"><circle cx="25" cy="25" r="19" /><circle cx="25" cy="25" r="19" pathLength="100" strokeDasharray={`${cachedRate ?? 0} 100`} /></svg></Kpi>
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
        {data.models.length ? modelView === 'bars' ? <div className="model-ranks">{data.models.slice(0,8).map((model,i) => <div className="model-rank" key={model.name}><span className="rank-index">{String(i + 1).padStart(2,'0')}</span><div><div className="rank-label"><span title={model.name}>{model.name}</span><strong title={number(model.value)}>{fmt(model.value)}</strong></div><div className="rank-track"><i style={{ width: `${data.models[0]?.value ? Math.max(0,(model.value ?? 0) / data.models[0].value * 100) : 0}%`, background: COLORS[i % COLORS.length] }} /></div></div></div>)}</div> : <div className="analytics-table"><table><thead><tr><th>模型</th><th className="num">累计 Token</th></tr></thead><tbody>{data.models.map(model => <tr key={model.name}><td>{model.name}</td><td className="num">{number(model.value)}</td></tr>)}</tbody></table></div> : <ChartEmpty text="暂无模型数据" />}
        {modelView === 'bars' && data.models.length > 0 && <p className="panel-note">前 8 名</p>}
      </section>
      <section className="data-panel composition-panel"><PanelHead title="Token 构成" /><div className="composition-total"><span>输入 + 输出</span><strong>{fmt(sumKnown([data.input, data.output]))}</strong></div><div className="composition-track" aria-label="输入与输出比例">{[['输入',data.input],['输出',data.output]].map(([name,value],i) => <span key={name} title={`${name} ${number(value as number | null)}`} style={{ width: `${(sumKnown([data.input,data.output]) ?? 0) > 0 ? Number(value ?? 0) / sumKnown([data.input,data.output])! * 100 : 0}%`, background: COLORS[i] }} />)}</div><div className="composition-rows">{[['输入',data.input],['输出',data.output],['缓存输入',data.cached],['推理输出',data.reasoning]].map(([name,value],i) => <div key={name}><span><i style={{background:COLORS[i % 2]}} />{name}</span><strong title={number(value as number | null)}>{fmt(value as number | null)}</strong></div>)}</div><p className="panel-note">缓存、推理为子项</p></section>
      <section className="data-panel heat-panel"><PanelHead title="活动热力图" accessory={<span className="subtle-chip">13 周</span>} /><Heatmap days={heatDays} /><div className="heat-insight"><strong>{heatDays.some(d => d.value != null) ? heatDays.filter(d => d.value != null && d.value > 0).length : '—'}</strong><span>活跃天数<br /><small>{endDay ? `截至 ${endDay}` : '尚未同步'}</small></span></div></section>
    </div>
    <section className="data-panel source-panel" id="sources"><PanelHead title="数据源" accessory={<span className="read-time">{loading ? '读取中…' : updated ? `读取于 ${updated}` : '尚未读取'}</span>} />
      <div className="source-strip">{LOCAL_SOURCES.map(([id,name],index) => { const source = sources.find(s => s.id === id); return <div className="source-tile" key={id}><div className="source-tile-top"><span className="provider-icon" style={{color:COLORS[index]}}>{name[0]}</span><strong>{name}</strong><span className={`source-led ${source?.included ? 'ready' : ''}`} title={source?.included ? '已计入统计' : '尚未计入'} /></div><strong className="source-value" title={number(source?.total)}>{fmt(source?.total)}</strong><span className="source-state">{demo ? '示例模式' : source?.included ? '已计入' : source?.total != null ? '可能重叠' : '等待同步'}</span><button disabled={!!busy || demo} onClick={() => id === 'deepseek' ? setDeepseekOpen(!deepseekOpen) : void sync(id)}>{busy === id || busy === 'all' && id !== 'deepseek' ? '同步中…' : id === 'deepseek' ? '读取历史导出 ↗' : '同步 ↻'}</button></div>; })}</div>
      {deepseekOpen && <form className="deepseek-form" onSubmit={e => { e.preventDefault(); void sync('deepseek'); }}><label htmlFor="deepseek-directory">DeepSeek 导出目录</label><div><input id="deepseek-directory" value={directory} onChange={e => setDirectory(e.target.value)} placeholder="包含 ZIP / CSV 的文件夹路径" required /><button className="sync-button" disabled={!!busy || !directory.trim()}>读取并统计</button></div></form>}
      <details className="methodology"><summary>统计口径</summary><div className="analytics-table"><table><thead><tr><th>来源</th><th className="num">Token</th><th>合计规则</th></tr></thead><tbody>{sources.map(source => <tr key={source.id}><td>{source.label}</td><td className="num">{number(source.total)}</td><td>{source.included ? '已计入' : source.reason ?? '未知'}</td></tr>)}</tbody></table></div><p>总量以服务端统计为准，图表仅聚合已计入的来源；无记录的日期保持未知。本机记录按 UTC 日期，DeepSeek 按导出日期，跨来源的日边界可能不同。</p>{[...new Set([...(total?.warnings ?? []),...data.active.flatMap(s => s.warnings)])].map(w => <p key={w}>{w}</p>)}</details>
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
  return <svg viewBox="0 0 130 40"><path d={points.length > 1 ? points.map((p,i) => `${i ? 'L' : 'M'} ${i / (points.length-1)*130} ${37-p.value!/max*32}`).join(' ') : 'M0 32H130'} fill="none" stroke="currentColor" strokeWidth="2" /></svg>;
}
function TrendChart({ days, mode }: { days: Point[]; mode: 'area' | 'bar' }) {
  const [hover,setHover] = useState<number | null>(null);
  const max = Math.max(1,...days.map(p => p.value ?? 0));
  const width=720, height=190, left=52, right=704, top=12, bottom=157;
  const x = (i:number) => left + (i+.5)/Math.max(1,days.length)*(right-left);
  const y = (v:number) => bottom-v/max*(bottom-top);
  const groups: {p:Point;i:number}[][] = [];
  let group: {p:Point;i:number}[] = [];
  days.forEach((p,i) => { if(p.value == null) { if(group.length) groups.push(group); group=[]; } else group.push({p,i}); }); if(group.length) groups.push(group);
  const current = hover != null ? days[hover] : null;
  return <div className="trend-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`每日 Token ${mode === 'area' ? '曲线图' : '柱状图'}`} onMouseLeave={() => setHover(null)}>
    <defs><linearGradient id="aqua-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3abdc7" stopOpacity=".27"/><stop offset="100%" stopColor="#3abdc7" stopOpacity=".015"/></linearGradient></defs>
    {[0,.25,.5,.75,1].map(f => <g key={f}><line x1={left} x2={right} y1={y(max*f)} y2={y(max*f)} stroke="#e5edef" strokeDasharray="3 5"/><text x={left-10} y={y(max*f)+4} textAnchor="end">{number(max*f,true)}</text></g>)}
    {mode === 'area' ? groups.map((g,i) => { const d=g.map(({p,i},index) => `${index?'L':'M'}${x(i)},${y(p.value!)}`).join(' '); return <g key={i}><path d={`${d} L${x(g.at(-1)!.i)},${bottom} L${x(g[0]!.i)},${bottom} Z`} fill="url(#aqua-area)"/><path d={d} fill="none" stroke="#16a9b5" strokeWidth="2.5" strokeLinejoin="round"/>{g.length===1 && <circle cx={x(g[0]!.i)} cy={y(g[0]!.p.value!)} r="3" fill="#16a9b5"/>}</g>; }) : days.map((p,i) => p.value == null ? null : <rect key={p.day} x={x(i)-Math.max(1,(right-left)/days.length*.62)/2} y={y(p.value)} width={Math.max(1,(right-left)/days.length*.62)} height={Math.max(1,bottom-y(p.value))} rx="2" fill="#38b6c2"/>)}
    {days.map((p,i) => <rect key={p.day} x={left+i/days.length*(right-left)} y={top} width={(right-left)/days.length} height={bottom-top} fill="transparent" onMouseEnter={() => setHover(i)}><title>{p.day}: {p.value == null ? '没有记录' : `${number(p.value)} Token`}</title></rect>)}
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
