import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getWorkspace, setWorkspace, type SessionInfo, type Workspace } from './api.js';
import { Alert, Badge, Modal } from './ui.js';
import { OverviewPage } from './pages/Overview.js';
import { UsagePage } from './pages/Usage.js';
import { MemoryPage } from './pages/Memory.js';
import { ProjectsPage } from './pages/Projects.js';
import { BridgePage } from './pages/Bridge.js';
import { SettingsPage } from './pages/Settings.js';

/**
 * 应用外壳。
 *
 * 两个必须先解决的问题：
 *
 * 1. **配对。** 服务启动时终端打印一次性配对码，浏览器用它换一个 HttpOnly 会话 Cookie。
 *    没有配对就没有任何写权限，连概览也读不到。这不是多余的仪式：本地服务如果默认放行，
 *    任何一个网页都能偷偷调你的接口。
 *
 * 2. **demo 数据持续可见。** 只要库里存在示例数据，顶端就有一条常驻提示，
 *    且提供了一个一键清空入口。设计稿 §8 明确要求 demo 不能污染真实总览。
 */

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

interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

const NAV: Array<{ key: PageKey; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'usage', label: '用量与订阅' },
  { key: 'memory', label: '记忆中心' },
  { key: 'projects', label: '项目' },
  { key: 'bridge', label: 'ChatGPT 桥接' },
  { key: 'settings', label: '设置与连接' },
];

const PAGE_TITLE: Record<PageKey, string> = {
  overview: '概览',
  usage: '用量与订阅',
  memory: '记忆中心',
  projects: '项目',
  bridge: 'ChatGPT 桥接',
  settings: '设置与连接',
};

export function App(): ReactNode {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [page, setPage] = useState<PageKey>('overview');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [demoCounts, setDemoCounts] = useState<Record<string, number>>({});
  const [clearingDemo, setClearingDemo] = useState(false);
  const [workspace, setWorkspaceState] = useState<Workspace>(getWorkspace());

  const toast = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text, tone }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const reload = useCallback(() => setRefreshToken((n) => n + 1), []);

  const loadSession = useCallback(async () => {
    try {
      const info = await api.get<SessionInfo>('/api/session');
      setSession(info);
      if (info.authenticated) {
        try {
          const demo = await api.get<{ hasDemoData: boolean; counts: Record<string, number> }>('/api/demo/status');
          setDemoCounts(demo.hasDemoData ? demo.counts : {});
        } catch {
          setDemoCounts({});
        }
      }
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
      setSession({ authenticated: false });
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const demoTotal = useMemo(() => Object.values(demoCounts).reduce((a, b) => a + b, 0), [demoCounts]);

  const switchWorkspace = useCallback(
    (next: Workspace) => {
      setWorkspace(next);
      setWorkspaceState(next);
      setPage('overview');
      reload();
    },
    [reload],
  );

  if (session === null) {
    return <div className="gate faint">正在读取本机会话…</div>;
  }

  if (!session.authenticated) {
    return <PairGate hint={session.hint} error={sessionError} onPaired={loadSession} />;
  }

  const forbidden = new Set(session.forbiddenActions ?? []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">AI Control Center</span>
          <span className="brand-sub">M0 · 本地单用户闭环</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`nav-item${page === item.key ? ' active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>主体：{session.label ?? '本机用户'}</span>
          <span>权限：{Array.isArray(session.scopes) ? `${session.scopes.length} 项 scope` : '完整用户会话'}</span>
          {forbidden.size > 0 ? <span className="warn-text">受限：审批 / 删除 / 连接管理不可用</span> : null}
        </div>
      </aside>

      <main className="main">
        <header className="page-head">
          <div>
            <h1>{PAGE_TITLE[page]}</h1>
            <PageSubtitle page={page} />
          </div>
          <div className="page-actions">
            {demoTotal > 0 ? (
              <div className="pill-group" title="示例数据独立存放，永不进入真实统计">
                <button
                  className={`tag-btn${workspace === 'real' ? ' active' : ''}`}
                  onClick={() => switchWorkspace('real')}
                >
                  真实数据
                </button>
                <button
                  className={`tag-btn${workspace === 'demo' ? ' active' : ''}`}
                  onClick={() => switchWorkspace('demo')}
                >
                  示例数据
                </button>
              </div>
            ) : null}
            <button className="ghost" onClick={reload}>
              刷新数据
            </button>
            <button
              className="ghost"
              onClick={async () => {
                await api.delete('/api/session');
                await loadSession();
              }}
            >
              退出配对
            </button>
          </div>
        </header>

        {workspace === 'demo' ? (
          <div style={{ marginBottom: 14 }}>
            <Alert tone="warn" title="你正在查看示例数据工作区">
              <span>
                这里显示的全部是合成数据，名称以「【示例】」开头。它们<strong>不会</strong>
                进入真实统计数据。
              </span>
              <span className="alert-hint">
                示例数据刻意包含了未知 token、待刷新额度、疑似重复、待审候选、版本冲突等「不完美」状态 ——
                只放「一切正常」的样例会掩盖这个系统真正在解决的问题。
              </span>
              <div className="row tight" style={{ marginTop: 6 }}>
                <button className="small" onClick={() => switchWorkspace('real')}>
                  切回真实数据
                </button>
              </div>
            </Alert>
          </div>
        ) : null}

        {demoTotal > 0 && workspace === 'real' ? (
          <div style={{ marginBottom: 14 }}>
            <Alert tone="info" title="库中存在示例数据（当前未显示）">
              <span>
                共 {demoTotal} 行示例数据（{Object.entries(demoCounts)
                  .map(([t, n]) => `${t} ${n}`)
                  .join('、')}
                ）。它们不计入本页任何数字。
              </span>
              <div className="row tight" style={{ marginTop: 6 }}>
                <button className="small" onClick={() => switchWorkspace('demo')}>
                  查看示例数据
                </button>
                <button
                  className="small"
                  disabled={clearingDemo || forbidden.has('demo_reset')}
                  onClick={async () => {
                    setClearingDemo(true);
                    try {
                      const result = await api.post<{ totalDeleted: number; note: string }>('/api/demo/reset');
                      toast(`已删除 ${result.totalDeleted} 行示例数据。真实数据未受影响。`, 'ok');
                      await loadSession();
                      reload();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err), 'danger');
                    } finally {
                      setClearingDemo(false);
                    }
                  }}
                >
                  清空示例数据
                </button>
              </div>
            </Alert>
          </div>
        ) : null}

        {page === 'overview' ? (
          <OverviewPage navigate={setPage} toast={toast} hasDemoData={demoTotal > 0} refreshToken={refreshToken} reload={reload} />
        ) : null}
        {page === 'usage' ? (
          <UsagePage navigate={setPage} toast={toast} hasDemoData={demoTotal > 0} refreshToken={refreshToken} reload={reload} />
        ) : null}
        {page === 'memory' ? (
          <MemoryPage navigate={setPage} toast={toast} hasDemoData={demoTotal > 0} refreshToken={refreshToken} reload={reload} />
        ) : null}
        {page === 'projects' ? (
          <ProjectsPage navigate={setPage} toast={toast} hasDemoData={demoTotal > 0} refreshToken={refreshToken} reload={reload} />
        ) : null}
        {page === 'bridge' ? (
          <BridgePage navigate={setPage} toast={toast} hasDemoData={demoTotal > 0} refreshToken={refreshToken} reload={reload} />
        ) : null}
        {page === 'settings' ? (
          <SettingsPage navigate={setPage} toast={toast} hasDemoData={demoTotal > 0} refreshToken={refreshToken} reload={reload} />
        ) : null}
      </main>

      <div style={{ position: 'fixed', right: 18, bottom: 18, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 80, maxWidth: 380 }}>
        {toasts.map((t) => (
          <div key={t.id} className={`alert ${t.tone}`}>
            <span style={{ wordBreak: 'break-word' }}>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PageSubtitle({ page }: { page: PageKey }): ReactNode {
  const text: Record<PageKey, string> = {
    overview: '分口径展示：各币种支出按状态分桶，token 只报「已观测」，额度是独立状态卡片。不给出一个看起来精确的「总消耗」。',
    usage: '用量明细与收费流水。默认只显示主统计源；证据行与待确认行需要显式展开。',
    memory: '候选箱与正式库。AI 只能提案，批准是你一个人的动作。',
    projects: '目标、当前状态、决策、失败路径与可归属费用。上下文包按项目生成。',
    bridge: '不依赖任何新连接的跨工具路径：把候选带进来，把上下文带出去。',
    settings: '登记、自检、能力台账、凭据、备份与审计。区分「官方文档说支持」与「本机已验证」。',
  };
  return <div className="sub">{text[page]}</div>;
}

/* ------------------------------------------------------------------ */
/* 配对门                                                              */
/* ------------------------------------------------------------------ */

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
          <Badge tone="ghost">M0</Badge>
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
