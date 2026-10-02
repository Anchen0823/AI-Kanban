/** Shared history contracts. Coverage describes the retained dataset, not the entire account. */
export interface HistoryTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens: number | null;
}
export const HISTORY_TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens'] as const;
export type TokenField = typeof HISTORY_TOKEN_FIELDS[number];
export type Coverage = 'complete' | 'partial' | 'unknown';
export type TokenCoverage = Record<TokenField, Coverage>;
export function unknownCoverage(): TokenCoverage {
  return Object.fromEntries(HISTORY_TOKEN_FIELDS.map(key => [key, 'unknown'])) as TokenCoverage;
}
export function tokenCoverage(rows: Partial<HistoryTokens>[], totals: HistoryTokens): TokenCoverage {
  return Object.fromEntries(HISTORY_TOKEN_FIELDS.map(key => [key,
    totals[key] == null || !Number.isSafeInteger(totals[key]) ? 'unknown'
      : rows.length > 0 && rows.every(row => row[key] != null) ? 'complete' : 'partial',
  ])) as TokenCoverage;
}
export interface HistorySync {
  lastAttempt: { at: string; status: 'ok' | 'empty' | 'error'; message: string } | null;
  lastSuccessAt: string | null;
  stale: boolean;
}
export interface HistorySnapshot {
  status: 'not_scanned' | 'ok' | 'empty' | 'error';
  checkedAt?: string | null;
  totals: HistoryTokens;
  coverage?: TokenCoverage;
  detailCoverage?: TokenCoverage;
  sync?: HistorySync;
  sessionCount?: number | null;
  firstAt: string | null;
  lastAt: string | null;
  byDay: { day: string; totals: HistoryTokens }[];
  byModel: { model: string; totals: HistoryTokens }[];
  warnings: string[];
  message: string;
  statisticsSource?: 'official' | 'local';
  dailySource?: 'official' | 'local';
  detailsSource?: 'official' | 'local';
  officialMessage?: string;
  localTotals?: HistoryTokens;
  detailTotals?: HistoryTokens;
  officialDetails?: { status: string; checkedThreads: number; availableThreads: number; message: string; totals: HistoryTokens };
}
export interface HistoryTotalSource {
  id: string; label: string; totalTokens: number | null; included: boolean; reason: string | null;
}
export interface HistoryTotalResponse {
  totalTokens: number | null; partial: boolean; sources: HistoryTotalSource[]; warnings: string[];
}
export interface ImportedHistoryView {
  providers: { provider: string; totals: HistoryTokens; coverage?: TokenCoverage; firstAt: string | null; lastAt: string | null;
    byDay: { date: string; totalTokens: number | null }[];
    byModel: { model: string | null; totalTokens: number | null }[] }[];
}
export interface HistoryDashboard {
  total: HistoryTotalResponse;
  local: Record<string, HistorySnapshot>;
  imported: ImportedHistoryView;
}
