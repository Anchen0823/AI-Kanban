export interface TokenTotals {
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  reasoningOutputTokens?: number | null; totalTokens: number | null;
}
export interface LocalHistory {
  status: string; checkedAt?: string | null; totals: TokenTotals;
  sessionCount?: number | null; firstAt: string | null; lastAt: string | null;
  byDay: { day: string; totals: TokenTotals }[];
  byModel: { model: string; totals: TokenTotals }[];
  warnings: string[]; message: string;
}
export interface ImportedHistory {
  providers: { provider: string; totals: TokenTotals; firstAt: string | null; lastAt: string | null;
    byDay: { date: string; totalTokens: number | null }[];
    byModel: { model: string | null; totalTokens: number | null }[] }[];
}
export interface TotalHistory {
  totalTokens: number | null; partial: boolean; warnings: string[];
  sources: { id: string; label: string; totalTokens: number | null; included: boolean; reason: string | null }[];
}
export interface SourceData {
  id: string; label: string; included: boolean; reason: string | null; total: number | null;
  totals?: TokenTotals; days: { day: string; value: number | null }[];
  models: { name: string; value: number | null }[]; checkedAt?: string | null; warnings: string[];
}
export const LOCAL_SOURCES = [['codex', 'Codex'], ['deepseek', 'DeepSeek'], ['workbuddy', 'WorkBuddy'], ['opencode', 'OpenCode'], ['minimax', 'MiniMax Code']] as const;
export const formatNumber = (n: number | null | undefined, compact = false): string => {
  if (n == null) return '—';
  if (!compact || n < 10000) return n.toLocaleString('zh-CN');
  return `${(n / (n >= 1e9 ? 1e9 : n >= 1e6 ? 1e6 : 1e3)).toFixed(2)}${n >= 1e9 ? 'B' : n >= 1e6 ? 'M' : 'K'}`;
};
export function sumKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => v != null && Number.isFinite(v));
  const sum = known.reduce((a, b) => a + b, 0);
  return known.length && Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
}
export function buildSources(total: TotalHistory, local: Record<string, LocalHistory>, imported?: ImportedHistory): SourceData[] {
  return total.sources.map(source => {
    const history = local[source.id];
    const provider = imported?.providers.find(p => `imported:${p.provider}` === source.id);
    return { ...source, label: LOCAL_SOURCES.find(([id]) => id === source.id)?.[1] ?? source.label.replace('已导入：', ''), total: source.totalTokens,
      totals: history?.totals ?? provider?.totals, checkedAt: history?.checkedAt,
      days: history?.byDay.map(row => ({ day: row.day, value: row.totals.totalTokens })) ?? provider?.byDay.map(row => ({ day: row.date, value: row.totalTokens })) ?? [],
      models: history?.byModel.map(row => ({ name: row.model, value: row.totals.totalTokens })) ?? provider?.byModel.map(row => ({ name: row.model ?? '未记录模型', value: row.totalTokens })) ?? [],
      warnings: history?.warnings ?? [],
    };
  });
}
export function aggregate(sources: SourceData[], selected: string) {
  const active = sources.filter(s => selected === 'all' ? s.included : s.id === selected);
  const days = new Map<string, (number | null)[]>();
  const models = new Map<string, (number | null)[]>();
  for (const source of active) {
    for (const row of source.days) {
      const date = Date.parse(`${row.day}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !Number.isFinite(date) || new Date(date).toISOString().slice(0,10) !== row.day) continue;
      days.set(row.day, [...(days.get(row.day) ?? []), row.value]);
    }
    for (const row of source.models) models.set(row.name, [...(models.get(row.name) ?? []), row.value]);
  }
  return { active,
    input: sumKnown(active.map(s => s.totals?.inputTokens)), output: sumKnown(active.map(s => s.totals?.outputTokens)),
    cached: sumKnown(active.map(s => s.totals?.cachedInputTokens)), reasoning: sumKnown(active.map(s => s.totals?.reasoningOutputTokens)),
    partial: active.some(s => !s.totals || s.totals.inputTokens == null || s.totals.outputTokens == null),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, value: sumKnown(values) })),
    models: [...models].map(([name, values]) => ({ name, value: sumKnown(values) })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
  };
}
// Missing calendar days remain unknown: no record is not evidence of zero usage.
export function calendarDays(days: { day: string; value: number | null }[], count: number, end = days.at(-1)?.day): { day: string; value: number | null }[] {
  if (!end) return [];
  const map = new Map(days.map(row => [row.day, row.value]));
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(last - (count - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { day, value: map.get(day) ?? null };
  });
}
