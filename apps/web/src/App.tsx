import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, getWorkspace, setWorkspace, type SessionInfo, type Workspace } from './api.js';
import { Alert, Badge, Modal } from './ui.js';
import { Telemetry } from './pages/Telemetry.js';
export type PageKey = 'overview' | 'usage' | 'memory' | 'projects' | 'bridge' | 'settings';

export interface PageProps {
  navigate: (page: PageKey) => void;
  toast: (text: string, tone?: ToastTone) => void;
  /** demo 数据是否存在。页面用它决定要不要显示示例标识。 */
  hasDemoData: boolean;
  /** 触发全局刷新。 */
  refreshToken: number;
  reload: () => void;
}

export type ToastTone = 'info' | 'ok' | 'warn' | 'danger';



export function App(): ReactNode {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [workspace, setWorkspaceState] = useState<Workspace>(getWorkspace());
  const [hasDemo, setHasDemo] = useState(false);
  const [motion, setMotion] = useState(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [fullscreen, setFullscreen] = useState(false);
  const [section, setSection] = useState('overview');
  const reload = useCallback(() => setRefreshToken(n => n + 1), []);
  const loadSession = useCallback(async () => {
    try {
      const next = await api.get<SessionInfo>('/api/session');
      setSession(next); setSessionError(null);
      if (next.authenticated) {
        const demo = await api.get<{ hasDemoData: boolean }>('/api/demo/status');
        setHasDemo(demo.hasDemoData);
      }
    } catch (error) { setSessionError(error instanceof Error ? error.message : String(error)); setSession({ authenticated: false }); }
  }, []);
  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => { const change = () => setFullscreen(!!document.fullscreenElement); document.addEventListener('fullscreenchange', change); return () => document.removeEventListener('fullscreenchange', change); }, []);
  useEffect(() => {
    const scroll = () => setSection(['sources','models','activity'].find(id => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= 150) ?? 'overview');
    window.addEventListener('scroll', scroll, { passive: true });
    return () => window.removeEventListener('scroll', scroll);
  }, []);
  useEffect(() => { document.documentElement.style.scrollBehavior = motion ? 'smooth' : 'auto'; }, [motion]);
  function switchWorkspace(next: Workspace) { setWorkspace(next); setWorkspaceState(next); reload(); }
  if (!session) return <div className="gate faint">正在连接本机观测站…</div>;
  if (!session.authenticated) return <PairGate hint={session.hint} error={sessionError} onPaired={loadSession} />;
  return <div className="aqua-app" data-motion={motion ? 'on' : 'off'} id="overview">
    <div className="ambient-field" aria-hidden="true"><i /><i /><i /></div>
    <header className="observatory-nav glass">
      <a className="aqua-brand" href="#overview" aria-label="AI Control Center 首页"><span className="brand-prism" aria-hidden="true">✧</span><span>AI Control Center</span></a>
      <nav aria-label="统计区块">{[['overview','总览'],['activity','趋势'],['models','模型'],['sources','数据源']].map(([id,label]) => <a key={id} href={`#${id}`} aria-current={section === id ? 'location' : undefined}>{label}</a>)}</nav>
      <div className="nav-controls"><span className="connection-label"><i className="live-dot" />本地连接</span><button onClick={reload} aria-label="刷新统计" title="重新读取已同步的数据">↻</button><button aria-label="切换界面动效" aria-pressed={motion} onClick={() => setMotion(!motion)} title="切换界面动效">✧</button><button aria-label={fullscreen ? '退出全屏' : '进入全屏'} title={fullscreen ? '退出全屏' : '进入全屏'} onClick={async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { /* Keep the normal desktop window when fullscreen is unavailable. */ } }}>⛶</button></div>
    </header>
    <main className="observatory-main">
      {hasDemo && <div className="workspace-switch"><button aria-pressed={workspace === 'real'} onClick={() => switchWorkspace('real')}>真实数据</button><button aria-pressed={workspace === 'demo'} onClick={() => switchWorkspace('demo')}>示例数据</button>{workspace === 'demo' && <span>正在查看示例数据 · 合成数据不计入真实统计</span>}</div>}
      <Telemetry key={workspace} refreshToken={refreshToken} reload={reload} />
    </main>
  </div>;
}
function PairGate({
  hint,
  error,
  onPaired,
}: {
  hint?: string;
  error?: string | null;
  onPaired: () => Promise<void> | void;
}): ReactNode {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/api/session/pair', { code: code.trim(), label: '本机浏览器' });
      setCode('');
      await onPaired();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card card">
        <div className="card-head">
          <div>
            <div className="brand-name">AI Control Center</div>
            <div className="brand-sub">本地单用户工作台 · 需要配对</div>
          </div>
          <Badge tone="ghost">本地会话</Badge>
        </div>

        <div className="stack">
          <Alert tone="info" title="为什么要配对">
            <span>
              服务只监听了回环地址（127.0.0.1），但「只监听本地」并不等于「只有你能调用」——
              你打开的任何一个网页都能向 localhost 发请求。
            </span>
            <span className="alert-hint">
              所以启动服务时终端会打印一个一次性配对码，需要你手动抄进来。配对成功后该码立即更换。
            </span>
          </Alert>

          {hint ? <div className="notice">{hint}</div> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <label className="field">
            <span>配对码</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="例如 K7M2QP4R"
              autoFocus
              spellCheck={false}
              style={{ fontFamily: 'var(--mono)', letterSpacing: '0.12em', fontSize: 15 }}
            />
            <span className="help">在启动服务的那个终端窗口里，位于启动横幅的黄色一行。</span>
          </label>

          {message ? <Alert tone="danger">{message}</Alert> : null}

          <button className="primary" onClick={() => void submit()} disabled={busy || code.trim().length < 4}>
            {busy ? '配对着…' : '配对'}
          </button>

          <div className="notice">
            连续输错 5 次会在 5 分钟内被限流，并且每次失败都会写入审计记录。
          </div>
        </div>
      </div>
    </div>
  );
}

export { Modal };
