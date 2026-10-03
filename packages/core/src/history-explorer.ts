import type { HistoryTokens, TokenCoverage, CacheInputSample, HistorySync } from './history.js';

export const LOCAL_HISTORY_SOURCES = ['codex', 'workbuddy', 'opencode', 'minimax'] as const;
export type LocalHistorySource = typeof LOCAL_HISTORY_SOURCES[number];
export interface ExplorerFilter {
  source?: LocalHistorySource; workspaceId?: string; model?: string; from?: string; to?: string;
  q?: string; sessionId?: string; page?: number; sort?: 'recent' | 'tokens' | 'name';
  direction?: 'asc' | 'desc'; granularity?: 'day' | 'week' | 'month'; split?: 'source' | 'model';
}
export interface ExplorerMetrics {
  totals: HistoryTokens; coverage: TokenCoverage; cacheInputSample?: CacheInputSample;
  sessionCount: number; firstAt: string | null; lastAt: string | null;
}
export interface ExplorerSession extends ExplorerMetrics {
  id: string; source: LocalHistorySource; sourceSessionId: string; title: string | null;
  workspaceId: string; directory: string | null; models: string[];
}
export interface ExplorerWorkspace extends ExplorerMetrics {
  id: string; directory: string | null; sources: LocalHistorySource[];
}
export interface ExplorerSource {
  id: LocalHistorySource; label: string; included: boolean; reason: string | null;
  indexed: boolean; sync: HistorySync; titles: number; directories: number; sessions: number;
}
export interface ExplorerContext {
  basis: 'local'; sources: ExplorerSource[]; unknownDateRecords: number;
  workspaces: { id: string; directory: string | null }[]; models: string[];
}
export interface ExplorerList<T> {
  items: T[]; total: number; page: number; pageSize: number; summary: ExplorerMetrics; context: ExplorerContext;
}
export interface ExplorerTrend {
  period: string; totals: HistoryTokens; series: { name: string; totalTokens: number | null }[];
}
export interface ExplorerMatrixRow {
  workspaceId: string; directory: string | null; model: string; totalTokens: number | null;
}
export interface ExplorerAnalytics {
  summary: ExplorerMetrics; context: ExplorerContext; trend: ExplorerTrend[];
  byModel: { model: string; totalTokens: number | null }[];
  matrix: { rows: ExplorerMatrixRow[]; total: number; page: number; pageSize: number;
    topRows: ExplorerMatrixRow[]; workspaces: { id: string; directory: string | null }[]; models: string[] };
}
export interface ExplorerSessionDetail extends ExplorerAnalytics { session: ExplorerSession }
export interface ExplorerWorkspaceDetail extends ExplorerAnalytics { workspace: ExplorerWorkspace; sessions: ExplorerList<ExplorerSession> }
