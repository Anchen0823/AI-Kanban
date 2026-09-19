import { useEffect, useState, type ReactNode } from 'react';
import { api, getWorkspace } from '../api.js';
import type { PageProps } from '../App.js';
import { Badge, Modal, formatDateTime } from '../ui.js';
import './quota-dashboard.css';
import { HistorySummary } from './HistorySummary.js';

interface Detection {
  status: 'ok' | 'error' | 'not_configured';
  checkedAt: string | null;
  lastSuccessAt: string | null;
  message: string;
}
interface CodexDetection extends Detection {
  windows: { label: string; usedPercent: number; remainingPercent: number; resetAt: string | null; windowSeconds: number | null }[];
  clientVersion: string | null;
}
interface DeepseekDetection extends Detection {
  configured: boolean;
  isAvailable: boolean | null;
  balances: { currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }[];
}
type Provider = 'codex' | 'deepseek';
function DetectionStatus({ data }: { data: Detection | null }): ReactNode {
  return <Badge tone={data?.status === 'ok' ? 'ok' : data?.status === 'error' ? 'warn' : 'neutral'}>
    {data?.status === 'ok' ? '已更新' : data?.status === 'error' ? '检测失败' : '待连接'}
  </Badge>;
}
export function OverviewPage({ navigate, refreshToken }: PageProps): ReactNode {
  const demo = getWorkspace() === 'demo';
  const [codex, setCodex] = useState<CodexDetection | null>(null);
  const [deepseek, setDeepseek] = useState<DeepseekDetection | null>(null);
  const [busy, setBusy] = useState<Record<Provider, boolean>>({ codex: false, deepseek: false });
  const [errors, setErrors] = useState<Partial<Record<Provider, string>>>({});
  const [loading, setLoading] = useState(!demo);
  const [connecting, setConnecting] = useState(false);
  const [apiKey, setApiKey] = useState('');
  useEffect(() => {
    let cancelled = false;
    if (demo) { setLoading(false); return; }
    setLoading(true);
    void Promise.allSettled([
      api.get<CodexDetection>('/api/detection/codex'),
      api.get<DeepseekDetection>('/api/detection/deepseek'),
    ]).then(([c, d]) => {
      if (cancelled) return;
      if (c.status === 'fulfilled') setCodex(c.value);
      if (d.status === 'fulfilled') setDeepseek(d.value);
      setErrors({
        ...(c.status === 'rejected' ? { codex: String(c.reason instanceof Error ? c.reason.message : c.reason) } : {}),
        ...(d.status === 'rejected' ? { deepseek: String(d.reason instanceof Error ? d.reason.message : d.reason) } : {}),
      });
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [demo, refreshToken]);
  async function detect(provider: Provider, key?: string): Promise<void> {
    setBusy(current => ({ ...current, [provider]: true }));
    setErrors(current => ({ ...current, [provider]: undefined }));
    try {
      if (provider === 'codex') setCodex(await api.post<CodexDetection>('/api/detection/codex', {}));
      else {
        const result = await api.post<DeepseekDetection>('/api/detection/deepseek', key ? { apiKey: key } : {});
        setDeepseek(result);
        if (result.status === 'ok') { setConnecting(false); setApiKey(''); }
      }
    } catch (error) {
      setErrors(current => ({ ...current, [provider]: error instanceof Error ? error.message : String(error) }));
    } finally { setBusy(current => ({ ...current, [provider]: false })); }
  }
  const disabled = demo || loading;
  const closeConnect = (): void => { setConnecting(false); setApiKey(''); };
  const issue = (provider: Provider, data: Detection | null): ReactNode => {
    const message = errors[provider] ?? (data?.status === 'error' ? data.message : null);
    return message ? <div className="detector-error" role="alert">{message}{data?.lastSuccessAt ? ' · 当前显示上次成功结果' : ''}</div> : null;
  };
  return <div className="quota-dashboard">
    <HistorySummary navigate={navigate} refreshToken={refreshToken} />
    <details className="current-balances">
    <summary>当前额度与余额</summary>
    <div className="quota-toolbar">
      <button className="primary" disabled={disabled || busy.codex || busy.deepseek} onClick={() => { void detect('codex'); void detect('deepseek'); }}>
        {busy.codex || busy.deepseek ? '检测中…' : '刷新额度与余额'}
      </button>
    </div>
    <div className="detector-grid">
      <section className="detector-card" aria-label="DeepSeek 余额">
        <div className="detector-heading"><div><span className="provider-mark deepseek-mark">D</span><h2>DeepSeek</h2></div><DetectionStatus data={deepseek} /></div>
        <div className="detector-content">
          {deepseek?.balances.length ? deepseek.balances.map((balance, index) => <div className="balance-block" key={`${balance.currency}-${index}`}>
            <span className="quota-label">可用余额 · {balance.currency}</span>
            <div className="quota-number">{balance.totalBalance}</div>
            <details className="quota-details"><summary>余额明细</summary><p>充值 {balance.toppedUpBalance} · 赠送 {balance.grantedBalance}</p></details>
          </div>) : <div className="quota-empty"><strong>{loading ? '加载中…' : '尚未检测'}</strong></div>}
          {deepseek?.isAvailable === false && <div className="detector-error">余额不足，API 暂不可用。</div>}
          {issue('deepseek', deepseek)}
        </div>
        <div className="detector-footer"><span>{deepseek?.lastSuccessAt ? `更新于 ${formatDateTime(deepseek.lastSuccessAt)}` : '官方余额接口'}</span><div>
          <button disabled={disabled || busy.deepseek} onClick={() => setConnecting(true)}>{deepseek?.configured ? '更换密钥' : '连接'}</button>
          <button disabled={disabled || busy.deepseek} onClick={() => deepseek?.configured ? void detect('deepseek') : setConnecting(true)}>{busy.deepseek ? '检测中…' : '检测余额'}</button>
        </div></div>
      </section>
      <section className="detector-card" aria-label="Codex 额度">
        <div className="detector-heading"><div><span className="provider-mark">C</span><h2>Codex</h2></div><DetectionStatus data={codex} /></div>
        <div className="detector-content">
          {codex?.windows.length ? codex.windows.map((window, index) => <div className="quota-window" key={`${window.label}-${index}`}>
            <div className="quota-window-heading"><span className="quota-label">{window.label}</span><strong>{Number(window.remainingPercent.toFixed(1))}<small>% 剩余</small></strong></div>
            <progress value={window.remainingPercent} max={100} aria-label={`${window.label} 剩余额度`} />
            {window.resetAt && <span className="quota-reset">重置于 {formatDateTime(window.resetAt)}</span>}
          </div>) : <div className="quota-empty"><strong>{loading ? '加载中…' : '尚未检测'}</strong></div>}
          {issue('codex', codex)}
        </div>
        <div className="detector-footer"><span>{codex?.lastSuccessAt ? `更新于 ${formatDateTime(codex.lastSuccessAt)}` : '本机 Codex'}</span><button disabled={disabled || busy.codex} onClick={() => void detect('codex')}>{busy.codex ? '检测中…' : '检测额度'}</button></div>
      </section>
    </div>
    </details>
    {connecting && <Modal title="连接 DeepSeek" onClose={closeConnect}>
      <form className="quota-connect" onSubmit={event => { event.preventDefault(); void detect('deepseek', apiKey.trim()); }}>
        <label htmlFor="deepseek-api-key">API Key</label>
        <input id="deepseek-api-key" type="password" autoComplete="off" autoFocus value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="sk-…" required />
        <p>密钥仅保留到服务关闭，不写入磁盘。</p>
        {issue('deepseek', deepseek)}
        <button className="primary" type="submit" disabled={!apiKey.trim() || busy.deepseek}>{busy.deepseek ? '连接中…' : '连接并检测'}</button>
      </form>
    </Modal>}
  </div>;
}
