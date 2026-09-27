import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.js';
interface TotalHistory {
  totalTokens: number | null;
  partial: boolean;
  sources: { id: string; label: string; totalTokens: number | null; included: boolean; reason: string | null }[];
  warnings: string[];
}
export function AllAiTotal({ refreshToken }: { refreshToken: string }): ReactNode {
  const [data, setData] = useState<TotalHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.get<TotalHistory>('/api/history/total').then(value => {
      if (!cancelled) { setData(value); setError(null); }
    }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [refreshToken]);
  const included = data?.sources.filter(source => source.included) ?? [];
  return <div className="overview-summary"><section className="all-ai-total" aria-label="全部 AI 累计 Token">
    <div className="total-eyebrow">TOTAL USAGE <span>全部历史</span></div>
    <div className="history-source-title"><h3>全部 AI 累计 Token</h3><span className="total-source-count">{data ? included.length : '—'} 个数据源</span></div>
    <div className="history-total"><strong>{data?.totalTokens == null ? '—' : data.totalTokens.toLocaleString('zh-CN')}</strong></div>
    <p className="all-ai-note">{error ? '刷新失败，当前数字可能不是最新。' : data?.partial ? '已知用量合计 · 部分历史不完整' : '已接入数据源的历史用量合计'}</p>
    {error && <div role="alert" className="detector-error">{error}</div>}
    <details className="all-ai-sources"><summary>查看统计口径与来源</summary>
      <div className="table-wrap"><table><thead><tr><th>来源</th><th>Token</th><th>计入情况</th></tr></thead><tbody>{data?.sources.map(source => <tr key={source.id}>
        <td>{source.label}</td><td>{source.totalTokens == null ? '未知' : source.totalTokens.toLocaleString('zh-CN')}</td><td>{source.included ? '已计入' : source.reason ?? '尚无数据'}</td>
      </tr>)}</tbody></table></div>
      {data?.warnings.map(warning => <p key={warning}>{warning}</p>)}
    </details>
  </section><section className="source-distribution" aria-label="来源占比">
    <div className="section-heading"><h2>来源占比</h2><span>Token</span></div>
    {included.length ? <div className="distribution-list">{[...included].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0)).map((source, index) => {
      const percent = data?.totalTokens ? (source.totalTokens ?? 0) / data.totalTokens * 100 : 0;
      return <div className="distribution-row" key={source.id}>
        <div><span><i className={`source-dot color-${index % 5}`} />{source.label}</span><strong>{source.totalTokens?.toLocaleString('zh-CN') ?? '—'}<small>{percent.toFixed(1)}%</small></strong></div>
        <div className="distribution-track"><span className={`color-${index % 5}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>
      </div>;
    })}</div> : <div className="distribution-empty"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M10 36V25M24 36V12M38 36V20" strokeLinecap="round" /></svg><strong>{error ? '暂时无法读取来源' : data ? '还没有用量数据' : '正在读取用量…'}</strong><p>{error ? '请点击刷新数据重试' : '在下方选择数据源，同步后查看分布'}</p></div>}
  </section></div>;
}
