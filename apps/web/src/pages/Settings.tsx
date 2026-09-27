import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  api,
  type BackupListing,
} from '../api.js';
import type { PageProps } from '../App.js';
import { RegistryPanel } from './Registry.js';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Modal,
  formatBytes,
  formatDateTime,
} from '../ui.js';

/** Data registration, backups, and audit for the usage workspace. */

export function SettingsPage({ refreshToken, reload, toast }: PageProps): ReactNode {
  const [tab, setTab] = useState<'registry' | 'backup' | 'audit' | 'demo'>('registry');
  const [backups, setBackups] = useState<BackupListing[]>([]);
  const [audit, setAudit] = useState<Array<{ at: string; action: string; entityType: string; entityId: string | null; result: string; actor: string; detail: Record<string, unknown> }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [bk, au] = await Promise.all([
        api.get<{ backups: BackupListing[]; backupDir: string }>('/api/backups'),
        api.get<{ events: typeof audit }>('/api/audit?limit=80'),
      ]);
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
    <div className="stack settings-page">
      <div className="page-tabs">
        {(
          [
            ['registry', '数据来源'],
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

      {tab === 'registry' ? <RegistryPanel toast={toast} reload={reload} /> : null}

      {tab === 'backup' ? (
        <Card
          tight
          title="备份与恢复"
          hint="为本机数据创建可恢复的副本"
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
<p className="muted small-text">备份包含当前工作台数据。恢复前会校验文件完整性，并保留一份恢复前备份。</p>

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
<p className="muted small-text">使用独立的示例工作区体验统计与筛选，不影响真实用量。</p>
          <div className="sep" />
          <div className="row">
            <button
              className="primary small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post('/api/demo/seed');
                  toast('示例数据已准备好，可在右上角切换查看。', 'ok');
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
