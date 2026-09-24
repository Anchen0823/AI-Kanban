import { useEffect, useState, type ReactNode } from 'react';
import { api, getWorkspace } from '../api.js';
import { compareModels, compareDates } from '../history-sort.js';

interface Totals { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null }
interface History {
  status: string; totals: Totals; sessionCount: number | null; firstAt: string | null; lastAt: string | null;
  byModel: { model: string; totals: Totals; sessionCount: number }[];
  byDay: { day: string; totals: Totals; sessionCount: number }[];
  warnings: string[]; message: string;
}
const number = (x: number | null | undefined): string => x == null ? '—' : x.toLocaleString('zh-CN');
export function WorkbuddyHistory({ refreshToken, onSynced }: { refreshToken: number; onSynced: () => void }): ReactNode {
  const demo = getWorkspace() === 'demo';
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setHistory(null); setError(null);
    if (!demo) void api.get<History>('/api/history/workbuddy').then(data => { if (!cancelled) setHistory(data); }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [demo, refreshToken]);
  async function sync(): Promise<void> {
    setBusy(true); setError(null);
    try { setHistory(await api.post<History>('/api/history/workbuddy', {})); onSynced(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="history-primary" aria-label="WorkBuddy 历史用量">
    <div className="history-source-title"><h3><span className="source-icon" aria-hidden="true">W</span>WorkBuddy</h3><button className="primary" disabled={demo || busy} onClick={() => void sync()}>{busy ? '同步中…' : '同步 WorkBuddy'}</button></div>
    <div className="history-total"><span>累计 Token</span><strong>{number(history?.totals.totalTokens)}</strong></div>
    <div className="history-metrics">
      <div><span>输入</span><strong>{number(history?.totals.inputTokens)}</strong></div>
      <div><span>输出</span><strong>{number(history?.totals.outputTokens)}</strong></div>
      <div><span title="已包含在输入中">缓存输入</span><strong>{number(history?.totals.cachedInputTokens)}</strong></div>
      <div><span title="已包含在输出中">推理输出</span><strong>{number(history?.totals.reasoningOutputTokens)}</strong></div>
    </div>
    <p className="history-coverage">{demo ? '示例工作区不读取本机历史。' : history?.firstAt ? `${history.firstAt.slice(0, 10)} — ${history.lastAt?.slice(0, 10)} · ${number(history.sessionCount)} 个会话` : '点击同步，读取本机保留的 WorkBuddy 用量。'}</p>
    {error && <div role="alert" className="detector-error">{error}</div>}
    {history && <p className="history-coverage">{history.message}</p>}
    {!!history?.byModel.length && <div className="history-breakdown">
      <details><summary>按模型查看</summary><div className="table-wrap"><table><thead><tr><th>模型</th><th>Token</th><th>会话</th></tr></thead><tbody>{[...history.byModel].sort((a, b) => compareModels(a.model, b.model)).map(row => <tr key={row.model}><td>{row.model}</td><td>{number(row.totals.totalTokens)}</td><td>{row.sessionCount}</td></tr>)}</tbody></table></div></details>
      <details><summary>按日期查看</summary><div className="history-days table-wrap"><table><thead><tr><th>日期（UTC）</th><th>Token</th><th>会话</th></tr></thead><tbody>{[...history.byDay].sort((a, b) => compareDates(a.day, b.day)).map(row => <tr key={row.day}><td>{row.day}</td><td>{number(row.totals.totalTokens)}</td><td>{row.sessionCount}</td></tr>)}</tbody></table></div></details>
    </div>}
  </section>;
}
