import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BackupJob, BackupSettings, RemoteBackup } from '@aicc/core';
import { api, getWorkspace, type BackupListing } from '../api.js';
import { Modal } from '../ui.js';
import './data-management.css';

const date = (v?: string) => v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '尚无记录';
const phase: Record<BackupJob['phase'], string> = { queued: '等待中', snapshot: '创建快照', encrypting: '加密中', uploading: '上传中', verifying: '回读校验', downloading: '下载中', importing: '校验并导入', done: '已完成', error: '失败' };
interface RestorePlan { backupName: string; currentCounts: Record<string, number>; backupCounts: Record<string, number>; warnings: string[] }
export function DataManagement(): ReactNode {
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [backups, setBackups] = useState<BackupListing[]>([]);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [remote, setRemote] = useState<RemoteBackup[] | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ endpoint: '', username: '', webdavPassword: '', backupPassword: '', enabled: false });
  const [restorePassword, setRestorePassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const lastLocalAt = useRef<string | undefined>(undefined);
  const demo = getWorkspace() === 'demo';
  const load = useCallback(async () => {
    const [s, b, j] = await Promise.all([api.get<BackupSettings>('/api/backup-settings'), api.get<{ backups: BackupListing[] }>('/api/backups'), api.get<{ jobs: BackupJob[] }>('/api/backup-jobs')]);
    lastLocalAt.current = s.lastLocalAt; setSettings(s); setBackups(b.backups); setJobs(j.jobs); return s;
  }, []);
  useEffect(() => {
    if (demo) return;
    let alive = true;
    void load().then(s => { if (alive) setForm(f => ({ ...f, endpoint: s.endpoint, username: s.username, enabled: s.enabled })); }).catch(e => { if (alive) setError(e.message); });
    // Do not re-hash every database backup on each progress poll.
    const timer = setInterval(() => {
      void Promise.all([api.get<BackupSettings>('/api/backup-settings'), api.get<{jobs: BackupJob[]}>('/api/backup-jobs')]).then(async ([s,j]) => {
        if (!alive) return; setSettings(s); setJobs(j.jobs);
        if (s.lastLocalAt !== lastLocalAt.current) {
          lastLocalAt.current = s.lastLocalAt;
          const b = await api.get<{backups: BackupListing[]}>('/api/backups'); if (alive) setBackups(b.backups);
        }
      }).catch(e => { if (alive) setError(e.message); });
    }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [load, demo]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('');
    try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const preview = async (name: string) => { const result = await api.post<{ plan: RestorePlan }>(`/api/backups/${name}/restore-plan`, {}); setPlan(result.plan); };
  const working = busy || jobs.some(j => !['done', 'error'].includes(j.phase));
  if (demo) return <section className="backup-page"><h1>数据管理</h1><p>示例数据只读。请切换到真实数据后管理备份。</p></section>;
  return <section className="backup-page">
    <header><div className="backup-eyebrow">DATA SAFETY</div><h1>数据管理<span>备份，让记录安心留存。</span></h1><p>完整保存本机工作台；云端只接收使用独立密码加密的备份。</p></header>
    {error && <div className="backup-alert error" role="alert">{error}</div>}
    {message && <div className="backup-alert" role="status">{message}</div>}
    {settings?.authBlocked && <div className="backup-alert error">WebDAV 认证失败，自动任务已暂停。请更新应用密码并保存配置。</div>}
    {settings?.syncPaused && <div className="backup-alert">恢复后已暂停自动同步与自动备份，当前展示恢复的数据。<button disabled={busy} onClick={() => void act(async () => { await api.post('/api/backup-settings/resume-sync'); setMessage('已恢复自动同步与备份，下次打开窗口按正常流程同步。'); })}>恢复自动运行</button></div>}
    <div className="backup-status-grid">
      <article className="glass"><span>最近本地备份</span><strong>{date(settings?.lastLocalAt)}</strong><small>成功快照独立保存</small></article>
      <article className="glass"><span>最近云端上传</span><strong>{date(settings?.lastCloudAt)}</strong><small>上传并回读校验成功后更新</small></article>
      <article className="glass"><span>自动备份</span><strong>{settings?.enabled ? settings.unlocked ? settings.syncPaused ? '已暂停' : '每日一次' : '待解锁' : '未启用'}</strong><small>仅应用运行时执行 · 关窗即停止</small></article>
    </div>
    <section className="data-panel backup-panel">
      <div className="backup-panel-head"><div><h2>本地备份</h2><p>恢复前先预览数据规模，并自动保留恢复前副本。</p></div><button className="backup-primary" disabled={working} onClick={() => void act(async () => { const result = await api.post<{ name: string }>('/api/backups', {}); setMessage(`本地备份已生成：${result.name}`); })}>立即备份</button></div>
      <div className="backup-table-wrap"><table><thead><tr><th>备份时间</th><th>大小</th><th>完整性</th><th>操作</th></tr></thead><tbody>{backups.map(b => <tr key={b.name}><td>{b.createdAt ? date(b.createdAt) : b.name}<small>{b.name}</small></td><td>{(b.bytes / 1024 / 1024).toFixed(2)} MB</td><td>{b.integrity === 'ok' ? '校验通过' : '不可恢复：' + b.integrity}</td><td><div className="backup-actions"><a href={`/api/backups/${b.name}/package`} download>下载</a><button disabled={working || b.integrity !== 'ok'} onClick={() => void act(() => preview(b.name))}>恢复预览</button><button disabled={working || !settings?.unlocked || b.integrity !== 'ok'} onClick={() => void act(async () => { await api.post('/api/backup-jobs', { kind: 'upload', localName: b.name }); setMessage('已开始加密上传，请查看任务记录。'); })}>上传云端</button><button disabled={working} onClick={() => { if (window.confirm(`删除本地备份 ${b.name}？不会删除当前数据库或云端副本。`)) void act(async () => { await api.delete(`/api/backups/${b.name}`); }); }}>删除</button></div></td></tr>)}</tbody></table></div>
      {!backups.length && <p className="backup-empty">还没有备份。创建第一份副本，或导入已有备份包。</p>}
      <div className="backup-import"><label>导入备份包<input type="file" accept=".aiccbackup" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label><label>导入／远端恢复密码（仅加密包需要）<input type="password" autoComplete="off" value={restorePassword} onChange={e => setRestorePassword(e.target.value)} placeholder="旧备份可使用原密码" /></label><button disabled={working || !file} onClick={() => void act(async () => {
        if (!file || file.size > 128 * 1024 * 1024) throw new Error('文件不能超过 128 MiB。');
        const bytes = new TextEncoder().encode(restorePassword); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        const response = await fetch('/api/backups/import', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-aicc-request': '1', 'x-backup-password': btoa(binary) }, body: file });
        const result = await response.json() as { name: string; error?: { message: string } }; if (!response.ok) throw new Error(result.error?.message ?? '导入失败');
        setRestorePassword(''); setMessage('备份包已导入，当前数据未改变。'); await preview(result.name);
      })}>导入并预览</button></div>
      <p className="backup-note">本地下载包包含数据库及设置，默认未加密；不会包含客户端原始日志。最大支持 128 MiB。</p>
    </section>
    <section className="data-panel backup-panel">
      <div className="backup-panel-head"><div><h2>WebDAV 云端备份</h2><p>配置一个 HTTPS 网盘地址。不同设备的备份分目录保存。</p></div><span className="backup-pill">{settings?.unlocked ? '已解锁' : '待配置／解锁'}</span></div>
      <form onSubmit={e => { e.preventDefault(); void act(async () => {
        const next = await api.patch<BackupSettings>('/api/backup-settings', { endpoint: form.endpoint, username: form.username, enabled: form.enabled, ...(form.webdavPassword ? { webdavPassword: form.webdavPassword } : {}), ...(form.backupPassword ? { backupPassword: form.backupPassword } : {}) });
        setSettings(next); setForm(f => ({ ...f, webdavPassword: '', backupPassword: '' })); setRemote(null); setMessage('云端配置已保存。可先测试连接，再上传备份。');
      }); }}>
        <div className="backup-form-grid"><label>WebDAV 地址<input type="url" required value={form.endpoint} onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))} placeholder="https://dav.example.com/backup/" /></label><label>用户名<input required autoComplete="off" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} /></label><label>网盘应用密码<input type="password" autoComplete="new-password" value={form.webdavPassword} onChange={e => setForm(f => ({ ...f, webdavPassword: e.target.value }))} placeholder={settings?.unlocked ? '留空保留已保存密码' : '输入应用密码'} /></label><label>独立备份密码<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={form.backupPassword} onChange={e => setForm(f => ({ ...f, backupPassword: e.target.value }))} placeholder="至少 12 字符；请另行妥善保存" /></label></div>
        <p className="backup-note">{settings?.persistentSecrets ? '密码由 Windows 系统密钥存储保护。' : '当前密码仅保存在服务内存，重启后需要重新输入。'} 忘记备份密码无法恢复；更改密码后，旧备份仍需原密码。</p>
        <label className="backup-checkbox"><input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />启用每日自动备份并加密上传（运行时执行，不自动删除历史备份）</label>
        <div className="backup-actions"><button className="backup-primary" disabled={working}>保存配置</button><button type="button" disabled={working || !settings?.unlocked} onClick={() => void act(async () => { await api.post('/api/backup-jobs', { kind: 'test' }); setMessage('连接测试已开始，将验证读写、重命名和删除权限。'); })}>测试连接</button><button type="button" disabled={working || !settings?.unlocked} onClick={() => void act(async () => { await api.post('/api/backup-jobs', { kind: 'upload' }); setMessage('已开始创建本地快照并加密上传。'); })}>立即备份并上传</button></div>
      </form>
    </section>
    <section className="data-panel backup-panel"><div className="backup-panel-head"><div><h2>云端副本</h2><p>下载验证后进入本地列表，不会直接覆盖当前数据库。</p></div><button disabled={working || !settings?.unlocked} onClick={() => void act(async () => { setRemote((await api.get<{ backups: RemoteBackup[] }>('/api/backup-remote')).backups); })}>刷新云端列表</button></div>
      {remote === null ? <p className="backup-empty">配置并解锁后，点击刷新查看所有设备的云端副本。</p> : !remote.length ? <p className="backup-empty">云端暂无已完成的备份。</p> : <div className="backup-table-wrap"><table><thead><tr><th>备份</th><th>修改时间</th><th>操作</th></tr></thead><tbody>{remote.map(r => <tr key={r.id}><td>{r.name}<small>{r.id.split('/')[1]} · {(r.bytes / 1048576).toFixed(2)} MB</small></td><td>{r.modified ? date(r.modified) : '未知'}</td><td><div className="backup-actions"><button disabled={working} onClick={() => void act(async () => { await api.post('/api/backup-jobs', { kind: 'download', remoteId: r.id, ...(restorePassword ? { password: restorePassword } : {}) }); setRestorePassword(''); setMessage('开始下载并校验，完成后可在本地列表恢复。'); })}>下载到本地</button><button disabled={working} onClick={() => { if (window.confirm('永久删除此云端副本？此操作不会删除本地备份。')) void act(async () => { await api.delete(`/api/backup-remote?id=${encodeURIComponent(r.id)}&confirm=true`); setRemote(remote.filter(row => row.id !== r.id)); }); }}>删除</button></div></td></tr>)}</tbody></table></div>}
    </section>
    <section className="data-panel backup-panel"><h2>任务记录</h2><p className="backup-note">上传失败仍保留本地副本。网络错误自动有限重试，认证错误需修改配置。</p>{!jobs.length ? <p className="backup-empty">暂无云端任务。</p> : <ul className="backup-jobs">{jobs.slice(0, 30).map(j => <li key={j.id}><div><strong>{j.kind === 'test' ? '连接测试' : j.kind === 'upload' ? '备份上传' : '下载备份'} · {phase[j.phase]}</strong><small>{date(j.updatedAt)}{j.localName ? ` · 本地副本 ${j.localName}` : ''}</small>{j.error && <p role="status">{j.error}</p>}{j.retryAt && <small>下次重试：{date(j.retryAt)}</small>}</div>{j.phase === 'error' && <button disabled={working || !settings?.unlocked} onClick={() => void act(async () => { await api.post(`/api/backup-jobs/${j.id}/retry`, restorePassword ? { password: restorePassword } : {}); setRestorePassword(''); })}>重试</button>}</li>)}</ul>}</section>
    {plan && <Modal title="确认恢复备份" subtitle={plan.backupName} onClose={() => { if (!busy) setPlan(null); }} footer={<><button disabled={busy} onClick={() => setPlan(null)}>取消</button><button className="backup-primary" disabled={working} onClick={() => void act(async () => { await api.post(`/api/backups/${plan.backupName}/restore`, { confirm: true }); window.location.reload(); })}>确认覆盖并恢复</button></>}>
      <p>将覆盖当前工作台数据库。系统会先备份当前数据，恢复后暂停自动同步。</p>{plan.warnings.map(w => <p key={w}>{w}</p>)}<div className="backup-table-wrap"><table><thead><tr><th>数据</th><th>当前</th><th>备份中</th></tr></thead><tbody>{Object.keys(plan.currentCounts).filter(key => plan.currentCounts[key] || plan.backupCounts[key]).map(key => <tr key={key}><td>{({ history_detail_session: '历史会话', history_detail_bucket: '用量分桶', history_detail_source: '明细来源', memory: '记忆', project: '项目', usage_observation: '用量记录' } as Record<string, string>)[key] ?? key}</td><td>{plan.currentCounts[key]}</td><td>{plan.backupCounts[key] ?? '旧版未记录'}</td></tr>)}</tbody></table></div>
    </Modal>}
  </section>;
}
