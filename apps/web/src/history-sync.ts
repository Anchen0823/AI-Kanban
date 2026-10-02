import type { HistorySnapshot } from '@aicc/core';
import { api, getWorkspace, isAuthenticationLost, onAuthenticationLost } from './api.js';

export interface SourceProgress { phase: 'queued' | 'running' | 'ok' | 'error'; message?: string }
type Job = { id: string; body: unknown; resolve: () => void; promise: Promise<void> };
export class HistorySyncCoordinator {
  private active = 0;
  private queue: Job[] = [];
  private jobs = new Map<string, Job>();
  private listeners = new Set<() => void>();
  private completed = new Set<() => void>();
  private progress: Record<string, SourceProgress> = {};
  private started = false;
  constructor(private run: (id: string, body: unknown) => Promise<HistorySnapshot>, private allowed: () => boolean) {}
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = (): Record<string, SourceProgress> => this.progress;
  onCompleted(fn: () => void): () => void { this.completed.add(fn); return () => { this.completed.delete(fn); }; }
  private update(id: string, value: SourceProgress): void {
    this.progress = { ...this.progress, [id]: value };
    for (const listener of this.listeners) listener();
  }
  startOnce(): Promise<void> {
    if (this.started || !this.allowed()) return Promise.resolve();
    this.started = true;
    return this.sync(['codex', 'workbuddy', 'opencode', 'minimax']);
  }
  resetStartup(): void { this.started = false; }
  sync(ids: string[], body: unknown = {}): Promise<void> {
    if (!this.allowed()) return Promise.resolve();
    const promises = ids.map(id => {
      const old = this.jobs.get(id);
      if (old) return old.promise;
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      const job = { id, body, resolve, promise };
      this.jobs.set(id, job); this.queue.push(job);
      this.update(id, { phase: 'queued' });
      return promise;
    });
    this.resume();
    return Promise.all(promises).then(() => undefined);
  }
  cancelQueued(): void {
    for (const job of this.queue.splice(0)) {
      this.jobs.delete(job.id); this.update(job.id, { phase: 'error', message: '同步已暂停，请恢复会话后重试。' }); job.resolve();
    }
  }
  resume(): void {
    while (this.allowed() && this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++; this.update(job.id, { phase: 'running' });
      void Promise.resolve().then(() => this.run(job.id, job.body)).then(result => {
        this.update(job.id, { phase: result.status === 'error' ? 'error' : 'ok', message: result.message });
      }, error => { this.update(job.id, { phase: 'error', message: error instanceof Error ? error.message : '同步失败' }); })
        .finally(() => {
          this.active--; this.jobs.delete(job.id); job.resolve();
          for (const listener of this.completed) listener();
          this.resume();
        });
    }
  }
}

export const historySync = new HistorySyncCoordinator((id, body) => api.post(`/api/history/${id}`, body),
  () => getWorkspace() === 'real' && !isAuthenticationLost());
const STARTUP_KEY = 'aicc.history.startup.v03';
export function startHistorySync(): void {
  if (getWorkspace() !== 'real' || isAuthenticationLost()) return;
  // A window reload or workspace remount must not scan again. New windows start a new session.
  try {
    if (sessionStorage.getItem(STARTUP_KEY)) { historySync.resume(); return; }
    sessionStorage.setItem(STARTUP_KEY, '1');
  } catch { /* In-memory guard still handles restricted storage and StrictMode. */ }
  void historySync.startOnce();
}
onAuthenticationLost(() => {
  historySync.cancelQueued(); historySync.resetStartup();
  try { sessionStorage.removeItem(STARTUP_KEY); } catch { /* storage unavailable */ }
});
