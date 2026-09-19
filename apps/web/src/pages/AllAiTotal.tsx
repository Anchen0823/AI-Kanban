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
  return <section className="all-ai-total" aria-label="全部 AI 累计 Token">
    <div className="history-source-title"><h3>全部 AI 累计 Token</h3><span className="total-source-count">{data ? included.length : '—'} 个数据源</span></div>
    <div className="history-total"><strong>{data?.totalTokens == null ? '—' : data.totalTokens.toLocaleString('zh-CN')}</strong></div>
    <p className="all-ai-note">{error ? '刷新失败，当前数字可能不是最新。' : data?.partial ? '已知用量合计 · 部分历史不完整' : '已接入数据源的历史用量合计'}</p>
    {error && <div role="alert" className="detector-error">{error}</div>}
    <details className="all-ai-sources"><summary>来源明细</summary>
      <div className="table-wrap"><table><thead><tr><th>来源</th><th>Token</th><th>计入情况</th></tr></thead><tbody>{data?.sources.map(source => <tr key={source.id}>
        <td>{source.label}</td><td>{source.totalTokens == null ? '未知' : source.totalTokens.toLocaleString('zh-CN')}</td><td>{source.included ? '已计入' : source.reason ?? '尚无数据'}</td>
      </tr>)}</tbody></table></div>
    </details>
  </section>;
}
