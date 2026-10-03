import type { ExplorerFilter } from '@aicc/core';
export type ExplorerView = 'overview' | 'sessions' | 'workspaces' | 'analytics' | 'sources';
export function readExplorerLocation(hash: string = window.location.hash): { view: ExplorerView; id?: string; params: URLSearchParams } {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const [name, id] = path.split('/');
  const view: ExplorerView = ['sessions', 'workspaces', 'analytics', 'sources'].includes(name ?? '') ? name as ExplorerView : 'overview';
  return { view, id: id || undefined, params: new URLSearchParams(query) };
}
export function explorerHref(view: ExplorerView, changes: Record<string, string | undefined> = {}, id?: string, hash?: string): string {
  const params = readExplorerLocation(hash).params;
  for (const [key, value] of Object.entries(changes)) { if (value) params.set(key, value); else params.delete(key); }
  const query = params.toString();
  return `#${view}${id ? `/${id}` : ''}${query ? `?${query}` : ''}`;
}
export function explorerFilter(params: URLSearchParams, q: string): ExplorerFilter {
  const filter: Record<string, string | number> = {};
  for (const key of ['source', 'workspaceId', 'model', 'from', 'to', 'sort', 'direction', 'granularity', 'split']) {
    const value = params.get(key); if (value) filter[key] = value;
  }
  const page = Number(params.get('page'));
  if (Number.isSafeInteger(page) && page > 0) filter.page = page;
  if (q.trim()) filter.q = q.trim();
  return filter as ExplorerFilter;
}
export function explorerQuery(filter: ExplorerFilter): string {
  return new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
}
export function recentUtcRange(days: number, now = Date.now()): { from?: string; to?: string } {
  if (!days) return {};
  const to = new Date(now).toISOString().slice(0, 10);
  return { from: new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10), to };
}
