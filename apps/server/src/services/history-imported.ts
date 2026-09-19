/** 已导入历史用量的全量、去重后汇总。 */

import { aggregateTokens, type NormalizedTokens } from '@aicc/core';
import { getAccount } from '../db/repos/registry.js';
import { countedObservations, type UsageObservation } from '../db/repos/usage.js';
import type { WorkspaceScope } from '../db/repos/workspace.js';
import type { ServiceContext } from '../service-context.js';

export interface ImportedHistoryTotals {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}

export interface ImportedHistoryProvider {
  provider: string;
  totals: ImportedHistoryTotals;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  byModel: Array<{ model: string | null; totalTokens: number | null; count: number }>;
  byDay: Array<{ date: string; totalTokens: number | null; count: number }>;
}

export interface ImportedHistoryResponse {
  providers: ImportedHistoryProvider[];
  count: number;
  partial: boolean;
  note: string;
}

const NOTE = '仅汇总已导入的历史记录；可能与本机 Codex 数据重叠，不能直接相加。';
const UNKNOWN_PROVIDER = '未分类';
const UNKNOWN_DAY = '未知日期';
const DEEPSEEK_MODEL = /^deepseek(?:[-_/.:]|$)/i;

function normalized(row: UsageObservation): NormalizedTokens {
  return {
    inputTotal: row.inputTotal,
    outputTotal: row.outputTotal,
    totalReported: row.totalReported,
    cachedInput: row.cachedInput,
    reasoningOutput: row.reasoningOutput,
    cacheWriteInput: row.cacheWriteInput,
    basis: row.normalizationBasis,
    warnings: [],
  };
}

function total(rows: UsageObservation[]): { value: number | null; partial: boolean } {
  const result = aggregateTokens(rows.map((row) => ({ tokens: normalized(row), value: row.totalReported })));
  const safe = result.value === null || Number.isSafeInteger(result.value);
  return {
    value: safe ? result.value : null,
    partial: result.partial || result.skippedByBasis > 0 || !safe,
  };
}

function component(
  rows: UsageObservation[],
  value: (row: UsageObservation) => number | null,
): { value: number | null; partial: boolean } {
  const known = rows.map(value).filter((item): item is number => item !== null);
  let sum = 0;
  let safe = true;
  for (const item of known) {
    const next = sum + item;
    if (!Number.isSafeInteger(next)) {
      safe = false;
      break;
    }
    sum = next;
  }
  return {
    value: known.length === 0 || !safe ? null : sum,
    partial: known.length !== rows.length || !safe,
  };
}

function startAt(row: UsageObservation): string | null {
  return row.occurredAt ?? row.periodStart ?? row.periodEnd;
}

function endAt(row: UsageObservation): string | null {
  return row.occurredAt ?? row.periodEnd ?? row.periodStart;
}

function dayOf(row: UsageObservation): string {
  return (row.occurredAt ?? row.periodStart ?? row.periodEnd)?.slice(0, 10) ?? UNKNOWN_DAY;
}

function groupBy<K>(rows: UsageObservation[], key: (row: UsageObservation) => K): Map<K, UsageObservation[]> {
  const groups = new Map<K, UsageObservation[]>();
  for (const row of rows) {
    const value = key(row);
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return groups;
}

function providerSort(a: ImportedHistoryProvider, b: ImportedHistoryProvider): number {
  if (a.provider === UNKNOWN_PROVIDER) return b.provider === UNKNOWN_PROVIDER ? 0 : 1;
  if (b.provider === UNKNOWN_PROVIDER) return -1;
  return a.provider.localeCompare(b.provider, 'zh-CN');
}

export function importedHistory(
  ctx: ServiceContext,
  workspace: WorkspaceScope = 'real',
): ImportedHistoryResponse {
  // countedObservations 本身没有 LIMIT；证据行、待确认行和已确认重复行不会二次计数。
  const rows = countedObservations(ctx.db, workspace);
  const accountProviders = new Map<string, string | null>();
  const providerOf = (row: UsageObservation): string => {
    if (row.accountId) {
      if (!accountProviders.has(row.accountId)) {
        accountProviders.set(row.accountId, getAccount(ctx.db, row.accountId)?.provider.trim() || null);
      }
      const provider = accountProviders.get(row.accountId);
      if (provider) return /^deepseek$/i.test(provider) ? 'DeepSeek' : provider;
    }
    return row.model && DEEPSEEK_MODEL.test(row.model.trim()) ? 'DeepSeek' : UNKNOWN_PROVIDER;
  };

  let partial = false;
  const providers = [...groupBy(rows, providerOf)].map(([provider, providerRows]): ImportedHistoryProvider => {
    const input = component(providerRows, (row) => row.inputTotal);
    const cached = component(providerRows, (row) => row.cachedInput);
    const output = component(providerRows, (row) => row.outputTotal);
    const reasoning = component(providerRows, (row) => row.reasoningOutput);
    const totalTokens = total(providerRows);
    const starts = providerRows.map(startAt).filter((at): at is string => at !== null).sort();
    const ends = providerRows.map(endAt).filter((at): at is string => at !== null).sort();
    const hasUnknownDate = providerRows.some((row) => dayOf(row) === UNKNOWN_DAY);
    partial ||= input.partial || cached.partial || output.partial || reasoning.partial || totalTokens.partial || hasUnknownDate;

    const byModel = [...groupBy(providerRows, (row) => row.model)].map(([model, modelRows]) => ({
      model,
      totalTokens: total(modelRows).value,
      count: modelRows.length,
    })).sort((a, b) => {
      if (a.model === null) return b.model === null ? 0 : 1;
      if (b.model === null) return -1;
      return a.model.localeCompare(b.model);
    });

    const byDay = [...groupBy(providerRows, dayOf)].map(([date, dayRows]) => ({
      date,
      totalTokens: total(dayRows).value,
      count: dayRows.length,
    })).sort((a, b) => {
      if (a.date === UNKNOWN_DAY) return b.date === UNKNOWN_DAY ? 0 : 1;
      if (b.date === UNKNOWN_DAY) return -1;
      return a.date.localeCompare(b.date);
    });

    return {
      provider,
      totals: {
        inputTokens: input.value,
        cachedInputTokens: cached.value,
        outputTokens: output.value,
        reasoningOutputTokens: reasoning.value,
        totalTokens: totalTokens.value,
      },
      count: providerRows.length,
      firstAt: starts[0] ?? null,
      lastAt: ends.at(-1) ?? null,
      byModel,
      byDay,
    };
  }).sort(providerSort);

  return { providers, count: rows.length, partial, note: NOTE };
}
