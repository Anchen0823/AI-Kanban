import { useEffect, useState, type ReactNode } from 'react';
import { api, getWorkspace } from '../api.js';
import type { PageProps } from '../App.js';
import { formatDateTime } from '../ui.js';
import { DeepseekHistory } from './DeepseekHistory.js';
import { AllAiTotal } from './AllAiTotal.js';
import { compareModels, compareDates } from '../history-sort.js';

interface Totals { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null }
interface CodexHistory {
  status: 'not_scanned' | 'ok' | 'empty' | 'error'; checkedAt: string | null; totals: Totals;
  sessionCount: number | null; firstAt: string | null; lastAt: string | null;
  byModel: { model: string; totals: Totals; sessionCount: number }[];
  byDay: { day: string; totals: Totals; sessionCount: number }[];
  warnings: string[]; message: string;
}
interface ImportedProvider {
  provider: string; totals: Totals; count: number; firstAt: string | null; lastAt: string | null;
  byModel: { model: string | null; totalTokens: number | null; count: number }[];
  byDay: { date: string; totalTokens: number | null; count: number }[];
}
interface ImportedHistory { providers: ImportedProvider[]; count: number; partial: boolean }
const number = (value: number | null | undefined): string => value == null ? '—' : value.toLocaleString('zh-CN');
const day = (value: string | null | undefined): string => value ? formatDateTime(value).split(' ')[0]! : '未知';

export function HistorySummary({ navigate, refreshToken }: Pick<PageProps, 'navigate' | 'refreshToken'>): ReactNode {
  const demo = getWorkspace() === 'demo';
  const [history, setHistory] = useState<CodexHistory | null>(null);
  const [imported, setImported] = useState<ImportedHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totalRevision, setTotalRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (!demo) void api.get<CodexHistory>('/api/history/codex').then(result => { if (!cancelled) setHistory(result); }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    void api.get<ImportedHistory>('/api/history/imported').then(result => { if (!cancelled) setImported(result); }).catch((e: Error) => { if (!cancelled) setImportError(e.message); });
    return () => { cancelled = true; };
  }, [demo, refreshToken]);
  async function scan(): Promise<void> {
    setBusy(true); setError(null);
    try { setHistory(await api.post<CodexHistory>('/api/history/codex', {})); setTotalRevision(value => value + 1); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="history-summary">
    <div className="history-title"><h2>历史用量</h2></div>
    <AllAiTotal refreshToken={`${refreshToken}:${totalRevision}`} />
    <div className="history-provider-grid">
    <section className="history-primary" aria-label="Codex 历史用量">
      <div className="history-source-title"><h3><span className="source-icon" aria-hidden="true">C</span>Codex</h3><button className="primary" disabled={demo || busy} onClick={() => void scan()}>{busy ? '同步中…' : '同步 Codex'}</button></div>
      <div className="history-total"><span>累计 Token</span><strong>{number(history?.totals.totalTokens)}</strong></div>
      <div className="history-metrics">
        <div><span>输入</span><strong>{number(history?.totals.inputTokens)}</strong></div>
        <div><span>输出</span><strong>{number(history?.totals.outputTokens)}</strong></div>
        <div><span title="已包含在输入中">缓存输入</span><strong>{number(history?.totals.cachedInputTokens)}</strong></div>
        <div><span title="已包含在输出中">推理输出</span><strong>{number(history?.totals.reasoningOutputTokens)}</strong></div>
      </div>
      <div className="history-coverage">{history?.firstAt ? `${day(history.firstAt)} — ${day(history.lastAt)} · ${number(history.sessionCount)} 个会话` : demo ? '示例工作区不读取本机历史。' : '点击同步，读取本机已保留的全部 Codex 历史。'}</div>
      {error && <div className="detector-error" role="alert">{error}</div>}
      {history?.status === 'error' || history?.status === 'empty' ? <div className="detector-error" role="status">{history.message}</div> : null}
      {history && history.byModel.length > 0 && <div className="history-breakdown">
        <details><summary>按模型查看</summary><div className="table-wrap"><table><thead><tr><th>模型</th><th>Token</th><th>会话</th></tr></thead><tbody>{[...history.byModel].sort((a, b) => compareModels(a.model, b.model)).map(row => <tr key={row.model}><td>{row.model}</td><td>{number(row.totals.totalTokens)}</td><td>{number(row.sessionCount)}</td></tr>)}</tbody></table></div></details>
        <details><summary>按日期查看</summary><div className="history-days table-wrap"><table><thead><tr><th>日期（UTC）</th><th>Token</th><th>会话</th></tr></thead><tbody>{[...history.byDay].sort((a, b) => compareDates(a.day, b.day)).map(row => <tr key={row.day}><td>{row.day}</td><td>{number(row.totals.totalTokens)}</td><td>{number(row.sessionCount)}</td></tr>)}</tbody></table></div></details>
      </div>}
    </section>
    <DeepseekHistory refreshToken={refreshToken} onSynced={() => setTotalRevision(value => value + 1)} />
    </div>
    {!!(imported?.count || importError) && <section className="history-imported" aria-label="其他导入记录">
      <div className="history-source-title"><h3>其他导入记录</h3><button onClick={() => navigate('usage')}>查看记录 →</button></div>
      {importError && <div className="detector-error" role="alert">{importError}</div>}
      {imported?.providers.length ? <div className="imported-providers">{imported.providers.map(provider => <div className="imported-provider" key={provider.provider}>
        <span>{provider.provider}</span><strong>{number(provider.totals.totalTokens)} <small>Token</small></strong>
        <p>{number(provider.count)} 条记录 · {day(provider.firstAt)} — {day(provider.lastAt)}</p>
        <details><summary>输入 / 输出</summary><p>输入 {number(provider.totals.inputTokens)} · 输出 {number(provider.totals.outputTokens)}</p></details>
        <details><summary>模型与日期明细</summary><div className="history-days"><table><thead><tr><th>模型</th><th>Token</th></tr></thead><tbody>{[...provider.byModel].sort((a, b) => compareModels(a.model, b.model)).map(row => <tr key={row.model ?? 'unknown'}><td>{row.model ?? '未记录模型'}</td><td>{number(row.totalTokens)}</td></tr>)}</tbody></table><table><thead><tr><th>日期（UTC）</th><th>Token</th></tr></thead><tbody>{[...provider.byDay].sort((a, b) => compareDates(a.date, b.date)).map(row => <tr key={row.date}><td>{row.date}</td><td>{number(row.totalTokens)}</td></tr>)}</tbody></table></div></details>
      </div>)}</div> : <p className="history-import-empty">DeepSeek 尚未导入历史。导入用量 CSV 或 API 响应 JSON 后，会在这里累计。</p>}
      {!!imported?.count && <p className="history-coverage">仅统计已导入记录，与上方本机 Codex 历史分开显示。{imported.partial ? '部分记录字段缺失。' : ''}</p>}
    </section>}
  </section>;
}
