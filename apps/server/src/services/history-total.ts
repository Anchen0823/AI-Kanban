/** 可扩展的跨来源历史 token 总览。 */

import type { WorkspaceScope } from '../db/repos/workspace.js';
import type { ServiceContext } from '../service-context.js';
import { getCodexHistory } from './codex-history.js';
import { getDeepseekHistory } from './deepseek-history.js';
import { importedHistory } from './history-imported.js';

export interface HistoryTotalSource {
  id: string;
  label: string;
  totalTokens: number | null;
  included: boolean;
  reason: string | null;
}

/**
 * 每个新来源 adapter 只需产出这一结构；aggregateHistoryTotal 不读取数据库，便于独立验证。
 */
export interface HistoryTotalCandidate extends HistoryTotalSource {
  partial?: boolean;
  warnings?: string[];
}

export interface HistoryTotalResponse {
  totalTokens: number | null;
  partial: boolean;
  sources: HistoryTotalSource[];
  warnings: string[];
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

/** 纯聚合：只累计 included 来源一次；任何精度风险都返回未知而不是舍入。 */
export function aggregateHistoryTotal(candidates: HistoryTotalCandidate[]): HistoryTotalResponse {
  const warnings: string[] = [];
  let partial = candidates.length === 0;
  let sum = 0;
  let includedCount = 0;
  let overflow = false;
  const seenIds = new Set<string>();
  const uniqueCandidates: HistoryTotalCandidate[] = [];
  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) {
      partial = true;
      addWarning(warnings, `发现重复来源 id ${candidate.id}，仅采用首次结果。`);
      continue;
    }
    seenIds.add(candidate.id);
    uniqueCandidates.push(candidate);
  }

  const sources = uniqueCandidates.map((candidate): HistoryTotalSource => {
    for (const warning of candidate.warnings ?? []) addWarning(warnings, warning);
    partial ||= candidate.partial === true;

    if (!candidate.included) {
      if (candidate.reason) partial = true;
      return {
        id: candidate.id,
        label: candidate.label,
        totalTokens: candidate.totalTokens,
        included: false,
        reason: candidate.reason,
      };
    }

    if (candidate.totalTokens === null || !Number.isSafeInteger(candidate.totalTokens) || candidate.totalTokens < 0) {
      partial = true;
      addWarning(warnings, `${candidate.label} 没有可安全累计的总 token，已从总数排除。`);
      return {
        id: candidate.id,
        label: candidate.label,
        totalTokens: null,
        included: false,
        reason: candidate.reason ?? '总 token 未知或超出安全整数范围',
      };
    }

    includedCount += 1;
    const next = sum + candidate.totalTokens;
    if (!Number.isSafeInteger(next)) overflow = true;
    else if (!overflow) sum = next;
    return {
      id: candidate.id,
      label: candidate.label,
      totalTokens: candidate.totalTokens,
      included: true,
      reason: null,
    };
  });

  if (overflow) {
    partial = true;
    addWarning(warnings, '跨来源 token 合计超过安全整数范围，总数已标为未知。');
  }
  if (includedCount === 0) partial = true;
  return {
    totalTokens: includedCount === 0 || overflow ? null : sum,
    partial,
    sources,
    warnings,
  };
}

function importedOverlapsCodex(provider: string): boolean {
  const normalized = provider.trim();
  return normalized === '未分类' || /^(?:codex|openai)(?:$|[\s_-])/i.test(normalized);
}

/** 从现有脱敏缓存和已导入历史构造当前工作区的来源列表。 */
export function historyTotal(
  ctx: ServiceContext,
  workspace: WorkspaceScope = 'real',
): HistoryTotalResponse {
  const imported = importedHistory(ctx, workspace);
  const candidates: HistoryTotalCandidate[] = [];

  // 示例工作区不得读取或根据真实专用缓存作出任何判断。
  let codexKnown = false;
  let deepseekKnown = false;
  if (workspace === 'real') {
    const codex = getCodexHistory(ctx);
    codexKnown = codex.status === 'ok' && codex.totals.totalTokens !== null;
    candidates.push({
      id: 'codex',
      label: 'Codex 本机历史',
      totalTokens: codex.totals.totalTokens,
      included: codexKnown,
      reason: codexKnown ? null : '尚无可用的 Codex 专用历史总量',
      partial: codex.warnings.length > 0 || !codexKnown,
      warnings: codex.warnings,
    });

    const deepseek = getDeepseekHistory(ctx);
    deepseekKnown = deepseek.status === 'ok' && deepseek.totals.totalTokens !== null;
    candidates.push({
      id: 'deepseek',
      label: 'DeepSeek 官方导出',
      totalTokens: deepseek.totals.totalTokens,
      included: deepseekKnown,
      reason: deepseekKnown ? null : '尚无可用的 DeepSeek 官方导出总量',
      partial: deepseek.warnings.length > 0 || !deepseekKnown,
      warnings: deepseek.warnings,
    });
  }

  for (const provider of imported.providers) {
    let reason: string | null = null;
    if (provider.provider === 'DeepSeek' && deepseekKnown) {
      reason = '已有 DeepSeek 官方导出，通用导入可能重叠';
    } else if (importedOverlapsCodex(provider.provider) && codexKnown) {
      reason = '已有 Codex 专用历史，Codex、OpenAI 或未分类导入存在潜在重叠';
    } else if (provider.totals.totalTokens === null) {
      reason = '该导入来源的总 token 未知';
    }
    const overlap = reason?.includes('重叠') === true;
    candidates.push({
      id: `imported:${provider.provider}`,
      label: `已导入：${provider.provider}`,
      totalTokens: provider.totals.totalTokens,
      included: reason === null,
      reason,
      partial: overlap || provider.provider === '未分类' || provider.totals.totalTokens === null,
      warnings: [
        ...(provider.provider === '未分类'
          ? ['未分类导入无法确认供应商归属，跨来源总数可能不完整或重叠。']
          : []),
        ...(overlap
          ? ['部分通用导入因可能与专用历史重叠而排除；这不是逐请求精确去重。']
          : []),
      ],
    });
  }

  if (imported.partial && imported.providers.length > 0) {
    for (const candidate of candidates) {
      if (candidate.id.startsWith('imported:')) {
        candidate.partial = true;
        candidate.warnings = [
          ...(candidate.warnings ?? []),
          '已导入历史存在字段缺失、混合口径或未知日期，来源总量可能不完整。',
        ];
      }
    }
  }
  return aggregateHistoryTotal(candidates);
}
