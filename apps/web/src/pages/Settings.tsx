import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type BackupListing,
  type ClientRecord,
  type IntegrationRecord,
  type SelfCheck,
} from '../api.js';
import type { PageProps } from '../App.js';
import {
  Alert,
  Badge,
  CAPABILITY_LABEL,
  Card,
  EmptyState,
  Modal,
  StateDot,
  capabilityTone,
  copyText,
  formatBytes,
  formatDateTime,
  formatRelative,
} from '../ui.js';

/**
 * 设置与连接页。
 *
 * 这一页要对抗的是「文档说得支持，所以应该能跑」这种自我安慰。
 * 每个连接都带三样东西：能力状态（有没有验证过）、证据（凭什么这么说）、最后成功时间。
 * 「官方文档描述支持」显示为黄色，「本机已验证」才是绿色 —— 这个颜色差别是有意义的。
 */

export function SettingsPage({ refreshToken, reload, toast }: PageProps): ReactNode {
  const [tab, setTab] = useState<'selfcheck' | 'connections' | 'credentials' | 'backup' | 'audit' | 'demo'>('selfcheck');
  const [selfCheck, setSelfCheck] = useState<SelfCheck | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationRecord[]>([]);
  const [statusMeaning, setStatusMeaning] = useState<Record<string, string>>({});
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [backups, setBackups] = useState<BackupListing[]>([]);
  const [audit, setAudit] = useState<Array<{ at: string; action: string; entityType: string; entityId: string | null; result: string; actor: string; detail: Record<string, unknown> }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sc, it, cl, st, bk, au] = await Promise.all([
        api.get<SelfCheck>('/api/self-check'),
        api.get<{ integrations: IntegrationRecord[]; statusMeaning: Record<string, string> }>('/api/integrations'),
        api.get<{ clients: ClientRecord[] }>('/api/clients'),
        api.get<{ settings: Record<string, string> }>('/api/settings'),
        api.get<{ backups: BackupListing[]; backupDir: string }>('/api/backups'),
        api.get<{ events: typeof audit }>('/api/audit?limit=80'),
      ]);
      setSelfCheck(sc);
      setIntegrations(it.integrations);
      setStatusMeaning(it.statusMeaning);
      setClients(cl.clients);
      setSettings(st.settings);
      setBackups(bk.backups);
      setAudit(au.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  return (
    <div className="stack">
      <div className="pill-group">
        {(
          [
            ['selfcheck', '自检'],
            ['connections', '能力登记'],
            ['credentials', '代理凭据'],
            ['backup', '备份与恢复'],
            ['audit', '审计'],
            ['demo', '示例数据'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`tag-btn${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {error ? <Alert tone="danger" title="加载失败">{error}</Alert> : null}

      {tab === 'selfcheck' && selfCheck ? (
        <>
          <Card tight title="本机自检" hint="这些结论来自实际运行的服务，不是文档抄来的">
            <div className="kv">
              <dt>Node</dt>
              <dd className="mono">{selfCheck.nodeVersion}</dd>
              <dt>平台</dt>
              <dd className="mono">{selfCheck.platform}</dd>
              <dt>SQLite 驱动</dt>
              <dd className="mono">
                {selfCheck.driver}
                <span className="faint tiny">
                  {' '}
                  （尝试顺序：{selfCheck.driverAttempts.map((a) => `${a.driver} ${a.ok ? 'OK' : '失败'}`).join(' → ')}）
                </span>
              </dd>
              <dt>schema 版本</dt>
              <dd>
                v{selfCheck.schemaVersion}
                {selfCheck.migrationsApplied.length > 0 ? (
                  <span className="faint tiny"> · 本次已应用 v{selfCheck.migrationsApplied.join(', v')}</span>
                ) : (
                  <span className="faint tiny"> · 无需迁移</span>
                )}
              </dd>
              <dt>数据目录</dt>
              <dd className="mono">{selfCheck.dataDir}</dd>
              <dt>数据库文件</dt>
              <dd className="mono">{selfCheck.dbFile}</dd>
              <dt>备份目录</dt>
              <dd className="mono">{selfCheck.backupDir}</dd>
              <dt>前端已构建</dt>
              <dd>{selfCheck.webBuilt ? <Badge tone="ok">是</Badge> : <Badge tone="warn">否（当前由服务端返回占位页）</Badge>}</dd>
              <dt>活动会话</dt>
              <dd>{selfCheck.activeSessions}</dd>
            </div>
          </Card>

          <Card tight title="功能自检" hint="未实现的会明确标成「未实现」，不会含糊过去">
            <div className="stack" style={{ gap: 8 }}>
              {selfCheck.checks.map((check) => (
                <div key={check.name} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                  <div className="row tight" style={{ minWidth: 0 }}>
                    <StateDot tone={check.ok ? 'ok' : 'warn'} />
                    <strong style={{ fontSize: 12.5 }}>{check.name}</strong>
                  </div>
                  <div className="muted tiny" style={{ textAlign: 'right', maxWidth: '58%' }}>
                    {check.detail}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card tight title="当前生效的设置" hint="改这里的值会写进数据库，随备份一起恢复">
            <div className="grid cols-2">
              <div className="kv">
                <dt>展示时区</dt>
                <dd>{settings.displayTimezone ?? '—'}（数据库一律存 UTC）</dd>
                <dt>额度新鲜度阈值</dt>
                <dd>{settings.quotaStaleSeconds ?? '—'} 秒</dd>
                <dt>短版预算</dt>
                <dd>{settings.contextShortBudget ?? '—'} token</dd>
                <dt>标准版预算</dt>
                <dd>{settings.contextStandardBudget ?? '—'} token</dd>
              </div>
              <div className="kv">
                <dt>导入大小上限</dt>
                <dd>{settings.maxImportBytes ? formatBytes(Number(settings.maxImportBytes)) : '—'}</dd>
                <dt>导入行数上限</dt>
                <dd>{settings.maxImportRows ?? '—'} 行</dd>
              </div>
            </div>
            <div className="sep" />
            <div className="grid cols-2">
              <label className="field">
                <span>额度新鲜度阈值（秒）</span>
                <input
                  type="number"
                  defaultValue={settings.quotaStaleSeconds ?? '21600'}
                  onBlur={async (e) => {
                    const value = Number(e.target.value);
                    if (!Number.isInteger(value) || value <= 0) return;
                    try {
                      await api.patch('/api/settings', { quotaStaleSeconds: value });
                      toast('已保存。', 'ok');
                      await load();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err), 'danger');
                    }
                  }}
                />
                <span className="help">超过这个时长没有新观测，额度会显示为「已过期快照」。</span>
              </label>
              <label className="field">
                <span>标准版上下文预算（token）</span>
                <input
                  type="number"
                  defaultValue={settings.contextStandardBudget ?? '2500'}
                  onBlur={async (e) => {
                    const value = Number(e.target.value);
                    if (!Number.isInteger(value) || value <= 0) return;
                    try {
                      await api.patch('/api/settings', { contextStandardBudget: value });
                      toast('已保存。', 'ok');
                      await load();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err), 'danger');
                    }
                  }}
                />
              </label>
            </div>
          </Card>
        </>
      ) : null}

      {tab === 'connections' ? (
        <Card tight title="能力登记" hint="每个连接都必须说清「凭什么认为它可用」">
          <div className="stack" style={{ gap: 12 }}>
            {Object.entries(statusMeaning).map(([key, text]) => (
              <div key={key} className="notice">
                <Badge tone={capabilityTone(key)}>{CAPABILITY_LABEL[key] ?? key}</Badge> {text}
              </div>
            ))}
          </div>

          <div className="sep" />

          <div className="stack" style={{ gap: 12 }}>
            {integrations.length === 0 ? (
              <EmptyState kind="not_configured" title="还没有登记任何连接" />
            ) : (
              integrations.map((it) => (
                <div className="card tight" key={it.id} style={{ boxShadow: 'none' }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row tight">
                        <StateDot tone={capabilityTone(it.capabilityStatus)} />
                        <strong style={{ fontSize: 13 }}>{it.name}</strong>
                        <Badge tone="ghost">{it.category}</Badge>
                      </div>
                      <div className="faint tiny">
                        传输：{it.transport} · 认证：{it.authMode}
                      </div>
                      {it.envRequirement ? <div className="faint tiny">前提：{it.envRequirement}</div> : null}
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <Badge tone={capabilityTone(it.capabilityStatus)}>
                        {CAPABILITY_LABEL[it.capabilityStatus] ?? it.capabilityStatus}
                      </Badge>
                      <div className="faint tiny">
                        {it.verifiedAt ? `验证于 ${formatDateTime(it.verifiedAt)}` : '从未验证'}
                      </div>
                      <div className="faint tiny">
                        {it.lastSuccessAt ? `最后成功 ${formatRelative(it.lastSuccessAt)}` : '没有成功记录'}
                      </div>
                    </div>
                  </div>

                  {it.notes ? <div className="small-text muted" style={{ marginTop: 6 }}>{it.notes}</div> : null}

                  {it.evidence ? (
                    <div className="notice" style={{ marginTop: 6 }}>
                      证据：{it.evidence}
                    </div>
                  ) : (
                    <div className="notice warn-text" style={{ marginTop: 6 }}>
                      没有证据。因此状态不可能是「本机已验证」——把状态改成已验证时必须同时给出证据，
                      否则接口会拒绝。
                    </div>
                  )}

                  {Object.keys(it.capabilityDetail).length > 0 ? (
                    <details style={{ marginTop: 6 }}>
                      <summary className="faint tiny" style={{ cursor: 'pointer' }}>
                        能力细节
                      </summary>
                      <pre className="mono tiny" style={{ background: 'var(--surface-2)', padding: 8, borderRadius: 6, overflow: 'auto' }}>
                        {JSON.stringify(it.capabilityDetail, null, 2)}
                      </pre>
                    </details>
                  ) : null}

                  <div className="row tight" style={{ marginTop: 8 }}>
                    <button
                      className="small"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const result = await api.post<{ probeExecuted: boolean; note: string }>(
                            `/api/integrations/${it.id}/probe`,
                            { note: '本机手动点击探测' },
                          );
                          toast(result.note, 'info');
                          await load();
                        } catch (err) {
                          toast(err instanceof Error ? err.message : String(err), 'danger');
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      只读探测
                    </button>
                    <span className="faint tiny">
                      M0 不执行真实探测：点击后只会把「尚未验证」这一事实记下来。
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      ) : null}

      {tab === 'credentials' ? (
        <CredentialsPanel clients={clients} toast={toast} />
      ) : null}

      {tab === 'backup' ? (
        <Card
          tight
          title="备份与恢复"
          hint="备份使用 SQLite 自身的导出机制，备份前先合并 WAL"
          actions={
            <button
              className="primary small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api.post<{ name: string; manifest: { files: Array<{ bytes: number; sha256: string }> } }>(
                    '/api/backups',
                    {},
                  );
                  toast(`备份已生成：${result.name}`, 'ok');
                  await load();
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), 'danger');
                } finally {
                  setBusy(false);
                }
              }}
            >
              立即备份
            </button>
          }
        >
          <Alert tone="info" title="为什么不能直接拷 .sqlite 文件">
            <span>
              WAL 模式下，最近提交的事务可能还在 <span className="mono">-wal</span> 文件里。
              直接拷主文件看起来完全正常，直到你真的需要恢复时才发现少了一批记录。
            </span>
          </Alert>

          <div className="sep" />

          {backups.length === 0 ? (
            <EmptyState kind="connected_no_data" title="还没有任何备份">
              <span>升级前、恢复前、批量导入前都建议先备份一次。</span>
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>备份</th>
                    <th>时间</th>
                    <th>schema</th>
                    <th className="num">大小</th>
                    <th>完整性</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.name}>
                      <td className="mono tiny">{b.name}</td>
                      <td className="tiny">{formatDateTime(b.createdAt)}</td>
                      <td className="tiny">v{b.schemaVersion}</td>
                      <td className="num tiny">{formatBytes(b.bytes)}</td>
                      <td className="tiny">
                        {b.integrity === 'ok' ? (
                          <Badge tone="ok">校验和匹配</Badge>
                        ) : (
                          <Badge tone="danger">{b.integrity}</Badge>
                        )}
                      </td>
                      <td className="nowrap">
                        <RestoreButton
                          name={b.name}
                          disabled={busy || b.integrity !== 'ok'}
                          onDone={async () => {
                            await load();
                            reload();
                          }}
                          toast={toast}
                        />
                        <button
                          className="ghost small"
                          disabled={busy}
                          onClick={async () => {
                            if (!window.confirm(`删除备份 ${b.name}？此操作不可撤销。`)) return;
                            setBusy(true);
                            try {
                              await api.delete(`/api/backups/${b.name}`);
                              toast('备份已删除。', 'ok');
                              await load();
                            } catch (err) {
                              toast(err instanceof Error ? err.message : String(err), 'danger');
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="sep" />
          <ul className="list-plain">
            <li>备份件默认不进入 Git、不上传到任何云端。</li>
            <li>包含敏感内容的普通本地文件并非天然加密，请自行选择受保护的存储位置。</li>
            <li>恢复前会先自动做一次当前状态的备份，所以随时可以退回。</li>
          </ul>
        </Card>
      ) : null}

      {tab === 'audit' ? (
        <Card tight title="审计记录" hint="只记动作、ID、时间与结果，不复制被删除内容的全文">
          {audit.length === 0 ? (
            <EmptyState kind="real_zero" title="还没有任何操作记录" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>动作</th>
                    <th>对象</th>
                    <th>主体</th>
                    <th>结果</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((event, i) => (
                    <tr key={i}>
                      <td className="tiny nowrap">{formatDateTime(event.at)}</td>
                      <td className="mono tiny">{event.action}</td>
                      <td className="mono tiny">
                        {event.entityType}
                        {event.entityId ? ` / ${event.entityId.slice(0, 16)}…` : ''}
                      </td>
                      <td className="tiny">{event.actor}</td>
                      <td className="tiny">
                        <Badge tone={event.result === 'ok' ? 'ok' : event.result === 'conflict' ? 'warn' : 'danger'}>
                          {event.result}
                        </Badge>
                      </td>
                      <td className="tiny faint">
                        <span className="mono">{JSON.stringify(event.detail)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {tab === 'demo' ? (
        <Card tight title="示例数据" hint="示例数据不计入任何真实统计，可以一键清空">
          <Alert tone="info" title="示例数据刻意包含各种「不完美」状态">
            <span>
              未知 token、待刷新额度、疑似重复记录、待审候选、版本冲突 ——
              只放「一切正常」的样例会掩盖这个系统真正在解决的问题。
            </span>
          </Alert>
          <div className="sep" />
          <div className="row">
            <button
              className="primary small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api.post<{ notes: string[]; created: Record<string, number> }>('/api/demo/seed');
                  toast(`示例数据已生成：${Object.entries(result.created).map(([k, v]) => `${k} ${v}`).join('、')}`, 'ok');
                  reload();
                  await load();
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), 'danger');
                } finally {
                  setBusy(false);
                }
              }}
            >
              生成示例数据
            </button>
            <button
              className="danger small"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm('清空全部示例数据？is_demo = 0 的真实数据不会被触碰。')) return;
                setBusy(true);
                try {
                  const result = await api.post<{ totalDeleted: number; note: string }>('/api/demo/reset');
                  toast(`已删除 ${result.totalDeleted} 行示例数据。`, 'ok');
                  reload();
                  await load();
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), 'danger');
                } finally {
                  setBusy(false);
                }
              }}
            >
              清空示例数据
            </button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 凭据                                                                */
/* ------------------------------------------------------------------ */

const ALL_SCOPES = [
  { key: 'memory_search', label: '检索记忆' },
  { key: 'memory_get', label: '按 ID 读取记忆' },
  { key: 'context_build', label: '生成上下文包' },
  { key: 'memory_propose', label: '提交候选记忆' },
  { key: 'session_propose', label: '提交会话摘要' },
  { key: 'integration_status', label: '查看接入状态' },
] as const;

function CredentialsPanel({
  clients,
  toast,
}: {
  clients: ClientRecord[];
  toast: PageProps['toast'];
}): ReactNode {
  const [credentials, setCredentials] = useState<
    Array<{ id: string; clientId: string; label: string; tokenPrefix: string; projectIds: string[] | null; scopes: string[]; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }>
  >([]);
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([]);
  const [form, setForm] = useState({ clientId: '', label: '', projectIds: [] as string[], scopes: ['memory_search', 'memory_get', 'context_build', 'memory_propose'] as string[] });
  const [issued, setIssued] = useState<{ token: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        api.get<{ credentials: typeof credentials }>('/api/credentials'),
        api.get<{ projects: Array<{ id: string; title: string }> }>('/api/projects'),
      ]);
      setCredentials(c.credentials);
      setProjects(p.projects);
      if (!form.clientId && clients.length > 0) setForm((f) => ({ ...f, clientId: clients[0]?.id ?? '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clients, form.clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="stack">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Alert tone="info" title="代理凭据能做什么、不能做什么">
        <span>
          凭据只能调用上面列出的这几项。审批候选、删除记忆、管理连接、备份恢复<strong>不在可选范围内</strong> ——
          这不是靠约定，而是凭据的 scope 枚举里根本没有这些值。
        </span>
        <span className="alert-hint">
          另外，凭据的身份只来自令牌本身。请求体里写「我是别的客户端」不会改变服务端认定的身份。
        </span>
      </Alert>

      <Card
        tight
        title="签发新凭据"
        hint="明文只在签发时显示一次，服务端只保存哈希"
        actions={
          <button
            className="primary small"
            disabled={busy || !form.clientId || form.scopes.length === 0 || form.label.trim().length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api.post<{ token: string; note: string }>('/api/credentials', {
                  clientId: form.clientId,
                  label: form.label.trim(),
                  projectIds: form.projectIds.length > 0 ? form.projectIds : null,
                  scopes: form.scopes,
                });
                setIssued(result);
                setForm({ ...form, label: '' });
                await load();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'danger');
              } finally {
                setBusy(false);
              }
            }}
          >
            签发
          </button>
        }
      >
        <div className="grid cols-2">
          <label className="field">
            <span>绑定客户端</span>
            <select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
              <option value="">请选择</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
            <span className="help">没有客户端就先到「设置与连接 → 能力登记」旁边…… 其实直接调用 /api/clients 即可。</span>
          </label>
          <label className="field">
            <span>标签</span>
            <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="例如「Cursor 只读」" />
          </label>
        </div>

        <div style={{ marginTop: 10 }}>
          <div className="card-hint">允许的项目范围（不选 = 不限定，仅建议本机调试用）</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            {projects.length === 0 ? (
              <span className="faint tiny">还没有项目</span>
            ) : (
              projects.map((p) => (
                <label className="checkline" key={p.id}>
                  <input
                    type="checkbox"
                    checked={form.projectIds.includes(p.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        projectIds: e.target.checked
                          ? [...form.projectIds, p.id]
                          : form.projectIds.filter((id) => id !== p.id),
                      })
                    }
                  />
                  <span>{p.title}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div className="card-hint">scope</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            {ALL_SCOPES.map((s) => (
              <label className="checkline" key={s.key}>
                <input
                  type="checkbox"
                  checked={form.scopes.includes(s.key)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scopes: e.target.checked ? [...form.scopes, s.key] : form.scopes.filter((x) => x !== s.key),
                    })
                  }
                />
                <span>
                  {s.label} <span className="mono faint">{s.key}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </Card>

      {issued ? (
        <Modal
          title="凭据已签发"
          subtitle="这是唯一一次显示完整凭据。关闭后无法再取回，只能撤销后重新签发。"
          onClose={() => setIssued(null)}
          footer={
            <>
              <button
                className="ghost"
                onClick={async () => {
                  const ok = await copyText(issued.token);
                  toast(ok ? '已复制。' : '复制失败，请手动选中复制。', ok ? 'ok' : 'warn');
                }}
              >
                复制凭据
              </button>
              <button className="primary" onClick={() => setIssued(null)}>
                我已保存
              </button>
            </>
          }
        >
          <div className="stack">
            <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {issued.token}
            </pre>
            <Alert tone="warn" title="使用方式">
              <span className="mono">Authorization: Bearer &lt;凭据&gt;</span>
              <span className="alert-hint">
                凭据一旦进入某个 AI 客户端，它返回的文本就可能进入对方的模型服务。
                因此全局个人记忆默认不向每个 agent 开放，只授予必要的已批准项目事实。
              </span>
            </Alert>
          </div>
        </Modal>
      ) : null}

      <Card tight title={`已签发的凭据（${credentials.length} 个）`}>
        {credentials.length === 0 ? (
          <EmptyState kind="not_configured" title="还没有签发过任何凭据" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>标签</th>
                  <th>客户端</th>
                  <th>前缀</th>
                  <th>项目范围</th>
                  <th>scope</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr key={c.id}>
                    <td>{c.label}</td>
                    <td className="tiny">{clients.find((x) => x.id === c.clientId)?.displayName ?? c.clientId}</td>
                    <td className="mono tiny">{c.tokenPrefix}…</td>
                    <td className="tiny">
                      {c.projectIds === null ? (
                        <span className="warn-text">不限定（不推荐）</span>
                      ) : c.projectIds.length === 0 ? (
                        <span className="danger-text">无任何项目</span>
                      ) : (
                        c.projectIds.map((id) => projects.find((p) => p.id === id)?.title ?? id).join('、')
                      )}
                    </td>
                    <td className="tiny mono">{c.scopes.join(', ')}</td>
                    <td className="tiny">
                      {c.revokedAt ? (
                        <Badge tone="danger">已撤销</Badge>
                      ) : (
                        <>
                          <Badge tone="ok">有效</Badge>
                          {c.lastUsedAt ? <div className="faint">最后使用 {formatRelative(c.lastUsedAt)}</div> : <div className="faint">从未使用</div>}
                        </>
                      )}
                    </td>
                    <td>
                      {!c.revokedAt ? (
                        <button
                          className="ghost small"
                          onClick={async () => {
                            try {
                              await api.post(`/api/credentials/${c.id}/revoke`);
                              toast('凭据已撤销。', 'ok');
                              await load();
                            } catch (err) {
                              toast(err instanceof Error ? err.message : String(err), 'danger');
                            }
                          }}
                        >
                          撤销
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 恢复                                                                */
/* ------------------------------------------------------------------ */

function RestoreButton({
  name,
  disabled,
  onDone,
  toast,
}: {
  name: string;
  disabled: boolean;
  onDone: () => Promise<void>;
  toast: PageProps['toast'];
}): ReactNode {
  const [plan, setPlan] = useState<{
    backupSchemaVersion: number;
    currentSchemaVersion: number;
    currentCounts: Record<string, number>;
    backupCounts: Record<string, number>;
    warnings: string[];
  } | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);

  return (
    <>
      <button
        className="small"
        disabled={disabled}
        onClick={async () => {
          try {
            const result = await api.post<{ plan: typeof plan }>(`/api/backups/${name}/restore-plan`);
            setPlan(result.plan);
            setConfirmChecked(false);
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'danger');
          }
        }}
      >
        恢复
      </button>

      {plan ? (
        <Modal
          title={`恢复预览：${name}`}
          subtitle="这是预览，还没有修改任何数据。"
          onClose={() => setPlan(null)}
          footer={
            <>
              <button className="ghost" onClick={() => setPlan(null)}>
                取消
              </button>
              <button
                className="danger"
                disabled={!confirmChecked}
                onClick={async () => {
                  try {
                    const result = await api.post<{ preRestoreBackup: string; note: string }>(
                      `/api/backups/${name}/restore`,
                      { confirm: true },
                    );
                    toast(`已恢复。恢复前的状态已自动备份到 ${result.preRestoreBackup}`, 'ok');
                    setPlan(null);
                    await onDone();
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'danger');
                  }
                }}
              >
                确认恢复（覆盖当前数据库）
              </button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="warn" title="恢复会覆盖当前数据库">
              <span>
                执行前系统会自动把当前状态备份一份，所以可以退回。但恢复之后，
                「自动备份之后新增的数据」不会自动合并回来。
              </span>
            </Alert>

            {plan.warnings.map((w, i) => (
              <Alert tone="warn" key={i}>
                {w}
              </Alert>
            ))}

            <div className="grid cols-2">
              <Card tight title="当前数据库">
                <div className="kv">
                  {Object.entries(plan.currentCounts)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt className="mono tiny">{k}</dt>
                        <dd className="tiny">{v}</dd>
                      </div>
                    ))}
                </div>
              </Card>
              <Card tight title={`备份内容（schema v${plan.backupSchemaVersion}）`}>
                <div className="kv">
                  {Object.entries(plan.backupCounts)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => (
                      <div key={k} style={{ display: 'contents' }}>
                        <dt className="mono tiny">{k}</dt>
                        <dd className="tiny">{v}</dd>
                      </div>
                    ))}
                </div>
              </Card>
            </div>

            <label className="checkline">
              <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} />
              <span>我看过上面的对比，确认用备份覆盖当前数据库。</span>
            </label>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
