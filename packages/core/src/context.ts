/**
 * 上下文包构建（设计稿 §6.5 / §4.3，不变量 INV-13）。
 *
 * 两条硬规则：
 * 1. **先权限过滤，再检索**。不允许「先全库捞出来，再指望模型自觉不泄露」。
 * 2. 固定项超预算时**提示用户取舍**，不静默截断最重要约束。
 *
 * token 计数只有确定了目标 tokenizer 才算「精确」。本系统没有绑定任何 tokenizer，
 * 所以一律标注为估算 —— 不假装精确。
 */

import type { ContextBudgetKind, MemoryKind, MemoryScope, SensitivityLevel } from './enums.js';
import { CONTEXT_BUDGET_DEFAULTS } from './enums.js';

/** 待筛选的记忆条目（由服务端从库里读出后传入）。 */
export interface ContextCandidate {
  memoryId: string;
  version: number;
  title: string;
  content: string;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  sensitivity: SensitivityLevel;
  /** 是否被用户固定（固定项优先保留）。 */
  pinned: boolean;
  updatedAt: string;
  /** 相关性分数，越大越相关；由服务端按标题/标签匹配算出。 */
  relevance: number;
}

export interface ContextBuildOptions {
  /** 权限边界：允许访问的项目 ID。`null` 表示不限定项目（仅用户本机会话可这样用）。 */
  allowedProjectIds: readonly string[] | null;
  /** 目标项目。 */
  projectId: string;
  /** 是否允许纳入 global 范围记忆。默认 **false**（避免把整份个人画像塞给每个 agent）。 */
  includeGlobalMemory?: boolean;
  /** 允许的敏感等级上限。默认仅 `normal`。 */
  maxSensitivity?: SensitivityLevel;
  /** 预算 token 数。 */
  budgetTokens: number;
  /** 任务描述，用于相关性排序与包内「本次目标」段。 */
  task?: string | null;
  now?: number;
}

export interface ContextSelection {
  selected: ContextCandidate[];
  /** 被预算挤掉的条目（仍会出现在清单里，供用户核对）。 */
  dropped: ContextCandidate[];
  /** 因权限/范围/敏感等级被排除的条目数（不暴露内容）。 */
  excludedByPolicy: number;
  estimatedTokens: number;
  budgetTokens: number;
  tokenCountKind: 'estimated';
  warnings: string[];
  /** 固定项本身就超预算时为 true —— 此时必须由用户决定取舍，系统不代为删除。 */
  requiresUserChoice: boolean;
}

const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
  normal: 0,
  private: 1,
  restricted: 2,
};

/**
 * Token 估算：中日韩字符按 1 token/字，其余按 4 字符/token。
 * 这是估算，不是某家 tokenizer 的精确结果。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (
      (cp >= 0x3000 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x1100 && cp <= 0x11ff)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/** 单条记忆在包里的渲染体（含来源与版本，便于下游核对）。 */
export function renderCandidate(item: ContextCandidate): string {
  const lines = [
    `### ${item.title}`,
    `- 记忆 ID：\`${item.memoryId}\`（v${item.version}）`,
    `- 类型：${item.kind} / 范围：${item.scope}${item.projectId ? `（${item.projectId}）` : ''}`,
    `- 更新于：${item.updatedAt}`,
    '',
    item.content.trim(),
  ];
  return lines.join('\n');
}

/**
 * 选择进入上下文包的条目。
 *
 * 顺序：权限过滤 → 项目/范围过滤 → 敏感等级过滤 → 固定项 → 相关性/新鲜度。
 */
export function selectContextItems(
  candidates: readonly ContextCandidate[],
  options: ContextBuildOptions,
): ContextSelection {
  const warnings: string[] = [];
  const maxSensitivity = SENSITIVITY_ORDER[options.maxSensitivity ?? 'normal'];
  const includeGlobal = options.includeGlobalMemory === true;

  let excludedByPolicy = 0;
  const eligible: ContextCandidate[] = [];

  for (const item of candidates) {
    // INV-13：权限过滤先于任何检索与排序
    if (options.allowedProjectIds !== null) {
      if (item.projectId !== null && !options.allowedProjectIds.includes(item.projectId)) {
        excludedByPolicy += 1;
        continue;
      }
    }
    if (item.scope === 'global' && !includeGlobal) {
      excludedByPolicy += 1;
      continue;
    }
    if (item.scope === 'project' && item.projectId !== options.projectId) {
      excludedByPolicy += 1;
      continue;
    }
    if (item.scope === 'session' && item.projectId !== options.projectId) {
      excludedByPolicy += 1;
      continue;
    }
    if (SENSITIVITY_ORDER[item.sensitivity] > maxSensitivity) {
      excludedByPolicy += 1;
      continue;
    }
    eligible.push(item);
  }

  const pinned = eligible.filter((i) => i.pinned);
  const rest = eligible.filter((i) => !i.pinned);

  const pinnedTokens = pinned.reduce((acc, i) => acc + estimateTokens(renderCandidate(i)), 0);
  if (pinnedTokens > options.budgetTokens) {
    return {
      selected: pinned,
      dropped: rest,
      excludedByPolicy,
      estimatedTokens: pinnedTokens,
      budgetTokens: options.budgetTokens,
      tokenCountKind: 'estimated',
      warnings: [
        ...warnings,
        `固定项合计约 ${pinnedTokens} token，已超过预算 ${options.budgetTokens}。` +
          '系统不会自动删除固定项，请先取消部分固定或提高预算。',
      ],
      requiresUserChoice: true,
    };
  }

  const ordered = [...rest].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });

  const selected: ContextCandidate[] = [...pinned];
  const dropped: ContextCandidate[] = [];
  let used = pinnedTokens;

  for (const item of ordered) {
    const cost = estimateTokens(renderCandidate(item));
    if (used + cost <= options.budgetTokens) {
      selected.push(item);
      used += cost;
    } else {
      dropped.push(item);
    }
  }

  if (dropped.length > 0) {
    warnings.push(
      `有 ${dropped.length} 条记忆因预算未纳入本次上下文包。包内清单会列出被删减项数量，便于你判断是否需要提高预算。`,
    );
  }

  return {
    selected,
    dropped,
    excludedByPolicy,
    estimatedTokens: used,
    budgetTokens: options.budgetTokens,
    tokenCountKind: 'estimated',
    warnings,
    requiresUserChoice: false,
  };
}

/** 上下文包清单：记录 `memory_id + version`，证明服务返回了什么，不证明模型读了什么。 */
export interface ContextManifest {
  packageId: string;
  projectId: string;
  task: string | null;
  generatedAt: string;
  budgetKind: ContextBudgetKind;
  budgetTokens: number;
  estimatedTokens: number;
  tokenCountKind: 'estimated' | 'exact';
  items: Array<{ memoryId: string; version: number; kind: MemoryKind; scope: MemoryScope; pinned: boolean }>;
  droppedCount: number;
  excludedByPolicy: number;
  warnings: string[];
  /** 该包能证明什么、不能证明什么，直接写进产物里。 */
  disclaimer: string;
}

export const CONTEXT_DISCLAIMER =
  '本清单记录本系统向调用方返回了哪些记忆及其版本，不能证明目标模型已阅读、理解或遵守其中任何一条。' +
  '记忆内容可能已在本包生成后被更新，请以记忆 ID 与版本的当前状态为准。';

/** §4.3 要求的包内章节顺序。 */
export const CONTEXT_SECTIONS: Array<{ key: MemoryKind; title: string }> = [
  { key: 'fact', title: '已确认事实' },
  { key: 'preference', title: '用户偏好' },
  { key: 'decision', title: '当前决策' },
  { key: 'lesson', title: '已尝试且失败的路径 / 经验' },
  { key: 'handoff', title: '交接说明' },
  { key: 'hypothesis', title: '尚未验证的猜想' },
];

export interface ContextPackage {
  manifest: ContextManifest;
  task: string | null;
  projectTitle: string;
  sections: Array<{ title: string; items: ContextCandidate[] }>;
  selection: ContextSelection;
}

export function buildContextPackage(input: {
  packageId: string;
  projectId: string;
  projectTitle: string;
  task?: string | null;
  budgetKind: ContextBudgetKind;
  selection: ContextSelection;
  generatedAt: string;
}): ContextPackage {
  const sections = CONTEXT_SECTIONS.map(({ key, title }) => ({
    title,
    items: input.selection.selected.filter((i) => i.kind === key),
  })).filter((s) => s.items.length > 0);

  const known = new Set(CONTEXT_SECTIONS.map((s) => s.key));
  const unclassified = input.selection.selected.filter((i) => !known.has(i.kind));
  if (unclassified.length > 0) {
    sections.push({ title: '其他', items: unclassified });
  }

  const manifest: ContextManifest = {
    packageId: input.packageId,
    projectId: input.projectId,
    task: input.task ?? null,
    generatedAt: input.generatedAt,
    budgetKind: input.budgetKind,
    budgetTokens: input.selection.budgetTokens,
    estimatedTokens: input.selection.estimatedTokens,
    tokenCountKind: input.selection.tokenCountKind,
    items: input.selection.selected.map((i) => ({
      memoryId: i.memoryId,
      version: i.version,
      kind: i.kind,
      scope: i.scope,
      pinned: i.pinned,
    })),
    droppedCount: input.selection.dropped.length,
    excludedByPolicy: input.selection.excludedByPolicy,
    warnings: input.selection.warnings,
    disclaimer: CONTEXT_DISCLAIMER,
  };

  return {
    manifest,
    task: input.task ?? null,
    projectTitle: input.projectTitle,
    sections,
    selection: input.selection,
  };
}

/** 渲染成 Markdown。这就是用户复制到别的客户端去的东西。 */
export function renderContextMarkdown(pkg: ContextPackage): string {
  const out: string[] = [];
  out.push(`# 项目上下文包：${pkg.projectTitle}`);
  out.push('');
  out.push(`- 包 ID：\`${pkg.manifest.packageId}\``);
  out.push(`- 项目：\`${pkg.manifest.projectId}\``);
  out.push(`- 生成时间（UTC）：${pkg.manifest.generatedAt}`);
  out.push(
    `- 预算：${pkg.manifest.budgetTokens} token（${pkg.manifest.budgetKind}），实际约 ${pkg.manifest.estimatedTokens} token（估算）`,
  );
  if (pkg.task) {
    out.push('');
    out.push('## 本次目标');
    out.push('');
    out.push(pkg.task.trim());
  }

  for (const section of pkg.sections) {
    out.push('');
    out.push(`## ${section.title}`);
    for (const item of section.items) {
      out.push('');
      out.push(renderCandidate(item));
    }
  }

  if (pkg.manifest.excludedByPolicy > 0 || pkg.manifest.droppedCount > 0) {
    out.push('');
    out.push('## 未纳入本包的条目');
    out.push('');
    if (pkg.manifest.excludedByPolicy > 0) {
      out.push(`- 因权限、范围或敏感等级被排除：${pkg.manifest.excludedByPolicy} 条（内容不外显）`);
    }
    if (pkg.manifest.droppedCount > 0) {
      out.push(`- 因预算未纳入：${pkg.manifest.droppedCount} 条`);
    }
  }

  if (pkg.manifest.warnings.length > 0) {
    out.push('');
    out.push('## 提醒');
    out.push('');
    for (const w of pkg.manifest.warnings) out.push(`- ${w}`);
  }

  out.push('');
  out.push('---');
  out.push('');
  out.push(pkg.manifest.disclaimer);
  out.push('');
  return out.join('\n');
}

export function renderContextJson(pkg: ContextPackage): string {
  const m = pkg.manifest;
  return `${JSON.stringify(
    {
      schema_version: '1.0',
      // 导出格式统一用 snake_case。之前 manifest 直接透传内部驼峰对象，
      // 导致同一个文件里 manifest 是 memoryId、sections 是 memory_id，
      // 下游解析时极容易踩坑。导出是给别人用的契约，必须自洽。
      manifest: {
        package_id: m.packageId,
        project_id: m.projectId,
        task: m.task,
        generated_at: m.generatedAt,
        budget_kind: m.budgetKind,
        budget_tokens: m.budgetTokens,
        estimated_tokens: m.estimatedTokens,
        token_count_kind: m.tokenCountKind,
        items: m.items.map((i) => ({
          memory_id: i.memoryId,
          version: i.version,
          kind: i.kind,
          scope: i.scope,
          pinned: i.pinned,
        })),
        dropped_count: m.droppedCount,
        excluded_by_policy: m.excludedByPolicy,
        warnings: m.warnings,
        disclaimer: m.disclaimer,
      },
      task: pkg.task,
      project_title: pkg.projectTitle,
      sections: pkg.sections.map((s) => ({
        title: s.title,
        items: s.items.map((i) => ({
          memory_id: i.memoryId,
          version: i.version,
          kind: i.kind,
          scope: i.scope,
          project_id: i.projectId,
          pinned: i.pinned,
          sensitivity: i.sensitivity,
          title: i.title,
          content: i.content,
          updated_at: i.updatedAt,
        })),
      })),
    },
    null,
    2,
  )}\n`;
}

export function budgetFor(kind: ContextBudgetKind, custom?: number): number {
  if (kind === 'custom') {
    if (typeof custom !== 'number' || !Number.isFinite(custom) || custom <= 0) {
      throw new Error('自定义预算必须是正数');
    }
    return Math.floor(custom);
  }
  return CONTEXT_BUDGET_DEFAULTS[kind];
}
