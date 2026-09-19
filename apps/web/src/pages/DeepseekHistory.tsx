import { useEffect, useState, type ReactNode } from 'react';
import { api, getWorkspace } from '../api.js';
import { formatDateTime } from '../ui.js';
import { compareModels, compareDates } from '../history-sort.js';
interface Totals { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; totalTokens: number | null; requestCount: number | null }
interface History {
  status: 'not_scanned' | 'ok' | 'empty' | 'error'; checkedAt: string | null;
  totals: Totals; firstAt: string | null; lastAt: string | null; fileCount: number;
  byModel: {model: string; totals: Totals}[]; byDay: {day: string; totals: Totals}[];
  costs: {currency: string; amount: string}[]; warnings: string[]; message: string;
}
const number = (value: number | null | undefined): string => value == null ? '—' : value.toLocaleString('zh-CN');
const day = (value: string | null): string => value ? formatDateTime(value).split(' ')[0]! : '未知';
export function DeepseekHistory({ refreshToken, onSynced }: {refreshToken: number; onSynced?: () => void}): ReactNode {
  const demo = getWorkspace() === 'demo';
  const [data, setData] = useState<History | null>(null);
  const [directory, setDirectory] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!demo) void api.get<History>('/api/history/deepseek').then(value => { if (!cancelled) setData(value); }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [demo, refreshToken]);
  async function sync(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const result = await api.post<History>('/api/history/deepseek', {directory: directory.trim()});
      setData(result);
      if (result.status === 'ok') setEditing(false);
      if (result.status !== 'error') onSynced?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="history-imported" aria-label="DeepSeek 历史用量">
    <div className="history-source-title"><h3><span className="source-icon deepseek-icon" aria-hidden="true">D</span>DeepSeek</h3><button disabled={demo || busy} onClick={() => setEditing(value => !value)}>{editing ? '收起' : '导入数据'}</button></div>
    {editing && <form className="history-directory" onSubmit={event => { event.preventDefault(); void sync(); }}>
      <label htmlFor="deepseek-history-folder">导出文件夹</label>
      <div><input id="deepseek-history-folder" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="包含 ZIP / CSV 的完整文件夹路径" required /><button className="primary" disabled={busy || !directory.trim()}>{busy ? '读取中…' : '读取并统计'}</button></div>
    </form>}
    <div className="history-total"><span>累计 Token</span><strong>{number(data?.totals.totalTokens)}</strong></div>
    <div className="history-metrics">
      <div><span>输入</span><strong>{number(data?.totals.inputTokens)}</strong></div>
      <div><span>输出</span><strong>{number(data?.totals.outputTokens)}</strong></div>
      <div><span title="已包含在输入中">缓存输入</span><strong>{number(data?.totals.cachedInputTokens)}</strong></div>
      <div><span>请求次数</span><strong>{number(data?.totals.requestCount)}</strong></div>
    </div>
    {!!data?.costs.length && <div className="history-costs"><span>累计消费</span>{data.costs.map(cost => <strong key={cost.currency}>{cost.amount} <small>{cost.currency}</small></strong>)}</div>}
    <p className="history-coverage">{data?.firstAt ? `${data.byDay[0]?.day ?? day(data.firstAt)} — ${data.byDay.at(-1)?.day ?? day(data.lastAt)} · ${data.fileCount} 个导出文件，仅覆盖已提供时段` : demo ? '示例工作区不读取本机导出。' : '尚未读取控制台历史导出。'}</p>
    {error && <div className="detector-error" role="alert">{error}</div>}
    {(data?.status === 'error' || data?.status === 'empty') && <div className="detector-error">{data.message}</div>}
    {data?.status === 'ok' && <div className="history-breakdown">
      <details><summary>按模型查看</summary><div className="table-wrap"><table><thead><tr><th>模型</th><th>Token</th><th>请求</th></tr></thead><tbody>{[...data.byModel].sort((a, b) => compareModels(a.model, b.model)).map(row => <tr key={row.model}><td>{row.model}</td><td>{number(row.totals.totalTokens)}</td><td>{number(row.totals.requestCount)}</td></tr>)}</tbody></table></div></details>
      <details><summary>按日期查看</summary><div className="table-wrap history-days"><table><thead><tr><th>导出日期</th><th>Token</th><th>请求</th></tr></thead><tbody>{[...data.byDay].sort((a, b) => compareDates(a.day, b.day)).map(row => <tr key={row.day}><td>{row.day}</td><td>{number(row.totals.totalTokens)}</td><td>{number(row.totals.requestCount)}</td></tr>)}</tbody></table></div></details>
    </div>}
  </section>;
}
