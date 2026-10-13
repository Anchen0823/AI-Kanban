import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupJob, BackupPhase, BackupSettings } from '@aicc/core';
import type { App } from '../app.js';
import { ApiError } from '../http/errors.js';
import { encryptPackage, importPackage, localPackage } from './backup-package.js';
import { DavError, normalizeEndpoint, WebDav } from './webdav.js';
import { runCodexHistory } from './codex-history.js';
import { runWorkbuddyHistory } from './workbuddy-history.js';
import { runOpencodeHistory } from './opencode-history.js';
import { runMinimaxHistory } from './minimax-history.js';

export interface BackupSecrets { webdavPassword: string; backupPassword: string; endpoint?: string; username?: string }
export interface SecretStore { load(): Promise<BackupSecrets | null>; save(secrets: BackupSecrets): Promise<void> }
interface State {
  endpoint: string; username: string; enabled: boolean; deviceId: string; jobs: BackupJob[];
  lastLocalAt?: string; lastCloudAt?: string; automaticDay?: string; syncPaused: boolean;
  authBlocked?: boolean;
}
export class BackupManager {
  private state: State;
  private file: string;
  private secrets: BackupSecrets | null = null;
  private store?: SecretStore;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopped = false;
  private abort = new AbortController();
  private startupSynced = false;
  private startupSync?: Promise<void>;
  constructor(private app: App, private transport: typeof fetch = fetch, private initialSync?: () => Promise<void>) {
    this.file = join(app.config.dataDir, 'backup-control.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as State : {
      endpoint: '', username: '', enabled: false, deviceId: randomUUID(), jobs: [], syncPaused: false,
    };
    for (const job of this.state.jobs) if (!['done', 'error'].includes(job.phase)) {
      job.phase = 'error'; job.error = '上次任务中断，可重试。';
      if (job.kind === 'upload') job.retryAt = this.now();
    }
  }
  private now(): string { return new Date(this.app.ctx.now()).toISOString(); }
  private persist(): void {
    mkdirSync(this.app.config.dataDir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600, flush: true });
    renameSync(`${this.file}.tmp`, this.file);
  }
  async useSecretStore(store: SecretStore): Promise<void> { const secrets = await store.load(); this.store = store; this.secrets = secrets?.endpoint === this.state.endpoint && secrets?.username === this.state.username ? secrets : null; }
  markStartupSynced(): void { this.startupSynced = true; }
  settings(): BackupSettings {
    const { endpoint, username, enabled, deviceId, lastLocalAt, lastCloudAt, syncPaused } = this.state;
    return { endpoint, username, enabled, deviceId, lastLocalAt, lastCloudAt, syncPaused,
      authBlocked: !!this.state.authBlocked,
      unlocked: !!this.secrets?.webdavPassword && !!this.secrets?.backupPassword, persistentSecrets: !!this.store };
  }
  async configure(input: { endpoint?: string; username?: string; enabled?: boolean; webdavPassword?: string; backupPassword?: string }): Promise<void> {
    if (this.active || this.startupSync) throw new ApiError(409, 'busy', '请等待当前备份任务完成后修改配置。');
    const endpoint = input.endpoint === undefined ? this.state.endpoint : input.endpoint ? normalizeEndpoint(input.endpoint) : '';
    const username = input.username ?? this.state.username;
    const changedTarget = endpoint !== this.state.endpoint || username !== this.state.username;
    const secrets = { endpoint, username, webdavPassword: input.webdavPassword ?? (changedTarget ? '' : this.secrets?.webdavPassword ?? ''),
      backupPassword: input.backupPassword ?? this.secrets?.backupPassword ?? '' };
    if (input.enabled && (!endpoint || !username || !secrets.webdavPassword || secrets.backupPassword.length < 12)) throw new ApiError(400, 'invalid_input', '启用自动备份前请填写地址、用户名、应用密码及至少 12 字符的备份密码。');
    if (secrets.backupPassword && secrets.backupPassword.length < 12) throw new ApiError(400, 'invalid_input', '备份密码至少需要 12 个字符。');
    if (this.store) await this.store.save(secrets);
    this.secrets = secrets;
    this.state.endpoint = endpoint; this.state.username = username;
    this.state.enabled = input.enabled ?? (changedTarget ? false : this.state.enabled);
    if (changedTarget || input.webdavPassword !== undefined) this.state.authBlocked = false;
    if (changedTarget) { this.state.lastCloudAt = undefined; this.state.automaticDay = undefined; }
    this.persist();
  }
  noteLocal(): void { this.state.lastLocalAt = this.now(); this.persist(); }
  pauseSync(): void { this.state.syncPaused = true; this.persist(); }
  resumeSync(): void { this.state.syncPaused = false; this.persist(); }
  jobs(): BackupJob[] { return this.state.jobs.map(j => ({ ...j })); }
  private client(): WebDav {
    if (!this.state.endpoint || !this.secrets?.webdavPassword || !this.secrets.backupPassword) throw new ApiError(409, 'locked', '请先配置并解锁云端备份。');
    return new WebDav(this.state.endpoint, this.state.username, this.secrets.webdavPassword, this.abort.signal, this.transport);
  }
  async remote(): Promise<Awaited<ReturnType<WebDav['backups']>>> { return this.client().backups(); }
  async deleteRemote(id: string): Promise<void> { this.remoteId(id); await this.client().remove(id); }
  private remoteId(id: string): void { if (!/^AI-Control-Center\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.aiccbackup$/.test(id)) throw new ApiError(400, 'invalid_input', '远端备份标识无效。'); }
  start(kind: BackupJob['kind'], localName?: string, remoteId?: string, password?: string, automaticDay?: string): BackupJob {
    this.client();
    if (this.active || this.startupSync || this.app.maintenance.locked) throw new ApiError(409, 'busy', '已有备份或恢复任务正在运行。');
    if (remoteId) this.remoteId(remoteId);
    if (kind === 'download' && !remoteId) throw new ApiError(400, 'invalid_input', '请选择远端备份。');
    const job: BackupJob = { id: randomUUID(), kind, phase: 'queued', localName, remoteId, automaticDay,
      createdAt: this.now(), updatedAt: this.now(), attempts: 0, target: this.state.endpoint };
    if (automaticDay) this.state.automaticDay = automaticDay;
    this.state.jobs.unshift(job); this.persist(); this.launch(job, password); return { ...job };
  }
  retry(id: string, password?: string): BackupJob {
    const job = this.state.jobs.find(j => j.id === id);
    if (!job || job.phase !== 'error') throw new ApiError(400, 'invalid_input', '只能重试失败任务。');
    if (job.target !== this.state.endpoint) throw new ApiError(409, 'target_changed', '云端目标已改变，请创建新任务。');
    this.client(); if (this.active || this.startupSync || this.app.maintenance.locked) throw new ApiError(409, 'busy', '请等待当前任务完成。');
    this.launch(job, password); return { ...job };
  }
  private update(job: BackupJob, phase: BackupPhase): void { job.phase = phase; job.updatedAt = this.now(); this.persist(); }
  private launch(job: BackupJob, password?: string): void {
    const leave = this.app.maintenance.enter();
    job.retryAt = undefined; job.error = undefined; job.attempts++;
    try { this.update(job, 'queued'); } catch (error) { leave(); throw error; }
    this.active = this.run(job, password).catch(error => {
      job.error = error instanceof DavError ? error.message : '备份操作失败，请检查密码、备份完整性、磁盘空间及文件占用。';
      if (error instanceof DavError && error.code === 'auth') this.state.authBlocked = true;
      if (error instanceof DavError && error.code === 'network' && job.attempts < 4 && job.kind === 'upload') {
        job.retryAt = new Date(this.app.ctx.now() + [0, 60000, 300000, 900000][job.attempts]!).toISOString();
      }
      try { this.update(job, 'error'); } catch { job.phase = 'error'; job.error = '无法保存任务状态，请检查磁盘空间。'; }
    }).finally(() => { leave(); this.active = undefined; });
  }
  private async run(job: BackupJob, password?: string): Promise<void> {
    const client = this.client();
    if (job.kind === 'test') await client.test(this.state.deviceId);
    else if (job.kind === 'download') {
      this.update(job, 'downloading'); const bytes = await client.get(job.remoteId!);
      this.update(job, 'importing'); job.localName = await importPackage(this.app.ctx, bytes, password ?? this.secrets!.backupPassword, true); this.noteLocal();
    } else {
      if (!job.localName) { this.update(job, 'snapshot'); job.localName = this.app.backup('云端备份').name; this.noteLocal(); }
      if (job.automaticDay) { this.state.automaticDay = job.automaticDay; this.persist(); }
      const pending = join(this.app.config.dataDir, `cloud-${job.id}.aiccbackup`);
      if (!existsSync(pending)) {
        this.update(job, 'encrypting');
        const plain = localPackage(this.app.ctx, job.localName);
        try { const bytes = await encryptPackage(plain, this.secrets!.backupPassword); writeFileSync(`${pending}.tmp`, bytes, { flush: true }); renameSync(`${pending}.tmp`, pending); }
        finally { plain.fill(0); }
      }
      this.update(job, 'uploading');
      job.remoteId = await client.upload(this.state.deviceId, job.id, readFileSync(pending), () => this.update(job, 'verifying'));
      this.state.lastCloudAt = this.now();
      this.update(job, 'done'); rmSync(pending, { force: true }); return;
    }
    this.update(job, 'done');
  }
  startScheduler(): void { this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 30000); this.timer.unref(); }
  async tick(): Promise<void> {
    if (this.stopped || !this.state.enabled || !this.settings().unlocked || this.state.authBlocked || this.app.maintenance.busy || this.active || this.startupSync || this.state.syncPaused) return;
    if (!this.startupSynced) {
      const leave = this.app.maintenance.enter();
      this.startupSync = (async () => {
        if (this.initialSync) await this.initialSync();
        else for (const pair of [[runCodexHistory, runWorkbuddyHistory], [runOpencodeHistory, runMinimaxHistory]]) await Promise.allSettled(pair.map(fn => fn!(this.app.ctx)));
        this.startupSynced = true;
      })().finally(() => { leave(); this.startupSync = undefined; });
      await this.startupSync;
      if (this.stopped || this.app.maintenance.busy) return;
    }
    const retry = this.state.jobs.find(j => j.phase === 'error' && j.retryAt && j.retryAt <= this.now() && j.target === this.state.endpoint);
    if (retry) { this.retry(retry.id); return; }
    const now = new Date(this.app.ctx.now()), day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (day !== this.state.automaticDay) this.start('upload', undefined, undefined, undefined, day);
  }
  async idle(): Promise<void> { await this.startupSync; await this.active; }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.abort.abort(); await this.idle(); this.secrets = null; }
}
const managers = new WeakMap<App, BackupManager>();
export function backupManager(app: App): BackupManager {
  let manager = managers.get(app); if (!manager) { manager = new BackupManager(app); managers.set(app, manager); } return manager;
}
