/**
 * 记忆生命周期与版本冲突（设计稿 §6，不变量 INV-10 / INV-11 / INV-12）。
 *
 * 核心立场：**正式记忆只能由人工批准产生**。这里定义的状态机是服务端唯一入口，
 * 任何从候选直接跳到 active 的路径都不存在。
 */

import { memoryContentHash } from './ids.js';
import type { MemoryStatus, ProposalOperation, ProposalStatus } from './enums.js';

/** 记忆状态迁移表。`deleted` 是终态 —— 要恢复只能走墓碑重新确认流程。 */
export const MEMORY_TRANSITIONS: Record<MemoryStatus, readonly MemoryStatus[]> = {
  active: ['superseded', 'archived', 'expired', 'deleted'],
  superseded: ['archived', 'deleted'],
  archived: ['active', 'deleted'],
  expired: ['active', 'archived', 'deleted'],
  deleted: [],
};

export function canTransitionMemory(from: MemoryStatus, to: MemoryStatus): boolean {
  if (from === to) return false;
  return (MEMORY_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 提案状态迁移。
 *
 * `conflict` 与 `approved` / `rejected` 一样是终态：基线版本已经变了，
 * 这个提案的差异就必须重新对照，不能「顺手修好」。用户要基于新版本重新提交一份提案。
 */
export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ['approved', 'rejected', 'conflict'],
  conflict: [],
  approved: [],
  rejected: [],
};

export function canTransitionProposal(from: ProposalStatus, to: ProposalStatus): boolean {
  return (PROPOSAL_TRANSITIONS[from] ?? []).includes(to);
}

/** 该状态下是否允许进入普通上下文（§6.2）。 */
export function isContextEligible(status: MemoryStatus): boolean {
  return status === 'active';
}

/** 过期内容不自动进上下文，但仍可在历史视图检索。 */
export function isHistorySearchable(status: MemoryStatus): boolean {
  return status !== 'deleted';
}

export interface VersionCheckOk {
  ok: true;
  /** 批准后新记忆的版本。create 为 1，update/archive 为 baseVersion + 1。 */
  nextVersion: number;
}

export interface VersionCheckConflict {
  ok: false;
  code: 'target_missing' | 'target_exists' | 'base_version_required' | 'base_version_mismatch';
  message: string;
  currentVersion: number | null;
  baseVersion: number | null;
}

export type VersionCheck = VersionCheckOk | VersionCheckConflict;

/**
 * 版本冲突检测（INV-11）。**不采用最后写入者获胜。**
 *
 * @param operation     提案操作
 * @param currentVersion 目标记忆当前版本；目标不存在时为 null
 * @param baseVersion   提案声明的基线版本
 */
export function checkBaseVersion(
  operation: ProposalOperation,
  currentVersion: number | null,
  baseVersion: number | null,
): VersionCheck {
  if (operation === 'create') {
    if (currentVersion !== null) {
      return {
        ok: false,
        code: 'target_exists',
        message: `create 提案不应指定已存在的目标（当前版本 ${currentVersion}）；如需修改请提交 update 提案`,
        currentVersion,
        baseVersion,
      };
    }
    if (baseVersion !== null) {
      return {
        ok: false,
        code: 'base_version_required',
        message: 'create 提案的 base_version 必须为 null',
        currentVersion: null,
        baseVersion,
      };
    }
    return { ok: true, nextVersion: 1 };
  }

  if (currentVersion === null) {
    return {
      ok: false,
      code: 'target_missing',
      message: '目标记忆不存在或已删除，无法基于它提交变更',
      currentVersion: null,
      baseVersion,
    };
  }

  if (baseVersion === null) {
    return {
      ok: false,
      code: 'base_version_required',
      message: '更新类提案必须携带 base_version，避免覆盖他人（或你自己另一端的）修改',
      currentVersion,
      baseVersion,
    };
  }

  if (baseVersion !== currentVersion) {
    return {
      ok: false,
      code: 'base_version_mismatch',
      message: `版本冲突：提案基于 v${baseVersion}，当前已是 v${currentVersion}。差异需重新核对，系统不会自动合并。`,
      currentVersion,
      baseVersion,
    };
  }

  return { ok: true, nextVersion: baseVersion + 1 };
}

/* ------------------------------------------------------------------ */
/* 差异展示                                                             */
/* ------------------------------------------------------------------ */

export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

export interface DiffSummary {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
  truncated: boolean;
}

const MAX_LCS_LINES = 1200;

/**
 * 行级差异。小文本用 LCS 精确对齐；超长文本退化为前缀/后缀比较，
 * 避免 O(n·m) 的内存爆炸（审核界面不应该因为一条长记忆卡死）。
 */
export function diffLines(before: string, after: string): DiffSummary {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');

  if (a.length + b.length > MAX_LCS_LINES) {
    return diffByEdges(a, b);
  }

  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] as string });
      i += 1;
      j += 1;
    } else {
      // 注意：不能写成 `lcs[i + 1][j] as number >= lcs[i][j + 1] as number`。
      // `as` 的优先级会把 `number >= ...` 整个吃掉，表达式变成 `x as (number >= y)`，
      // 剥掉类型后只剩 `if (x)` —— 一个真值判断。它「碰巧」在多数情况下给出正确答案，
      // 所以单测不一定抓得到；是 `tsc` 报的 TS2352 把它揪出来的。
      const moveDown = (lcs[i + 1] as number[])[j] ?? 0;
      const moveRight = (lcs[i] as number[])[j + 1] ?? 0;
      if (moveDown >= moveRight) {
        lines.push({ kind: 'remove', text: a[i] as string });
        i += 1;
      } else {
        lines.push({ kind: 'add', text: b[j] as string });
        j += 1;
      }
    }
  }
  while (i < n) {
    lines.push({ kind: 'remove', text: a[i] as string });
    i += 1;
  }
  while (j < m) {
    lines.push({ kind: 'add', text: b[j] as string });
    j += 1;
  }

  return summarize(lines, false);
}

function diffByEdges(a: string[], b: string[]): DiffSummary {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines: DiffLine[] = [];
  for (let k = 0; k < prefix; k += 1) lines.push({ kind: 'same', text: a[k] as string });
  for (let k = prefix; k < a.length - suffix; k += 1) lines.push({ kind: 'remove', text: a[k] as string });
  for (let k = prefix; k < b.length - suffix; k += 1) lines.push({ kind: 'add', text: b[k] as string });
  for (let k = a.length - suffix; k < a.length; k += 1) lines.push({ kind: 'same', text: a[k] as string });

  return summarize(lines, true);
}

function summarize(lines: DiffLine[], truncated: boolean): DiffSummary {
  return {
    lines,
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'remove').length,
    unchanged: lines.filter((l) => l.kind === 'same').length,
    truncated,
  };
}

/** 提案内容指纹：完全相同的候选建议合并，语义近似只提示不自动处理（§6.4）。 */
export function proposalContentHash(title: string, content: string): string {
  return memoryContentHash(title.trim(), content.trim());
}

/**
 * 相似度粗判（字符 2-gram Jaccard）。仅用于「提示可能重复」，
 * **绝不**用于自动删除或自动合并。
 */
export function textSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/\s+/g, '');
    const out = new Set<string>();
    if (t.length < 2) {
      if (t.length === 1) out.add(t);
      return out;
    }
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / (ga.size + gb.size - inter);
}

/** 冲突处理：批准替代版本时记录 supersedes 链（§6.4）。 */
export interface SupersedeLink {
  supersedes: string;
  supersededBy: string;
  at: string;
  note: string;
}

export function buildSupersedeLink(previousId: string, nextId: string, at: string, note: string): SupersedeLink {
  return { supersedes: previousId, supersededBy: nextId, at, note };
}
