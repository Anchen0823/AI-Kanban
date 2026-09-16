/**
 * Token 归一化（设计稿 §5.3，不变量 INV-01 / INV-02 / INV-07）。
 *
 * 三件事必须同时成立：
 * 1. 未知就是未知 —— `null`，永远不用 0 冒充「没有消耗」（INV-01）。
 * 2. 子集字段不重复相加 —— cached 是 input 的子集，reasoning 是 output 的子集（INV-02）。
 * 3. 累计计数回退按新窗口处理，不产生负数（INV-07）。
 *
 * 原始字段一律保留在 `raw_usage`，归一化只写「适配器明确知道字段包含关系」时才填。
 */

export type TokenValue = number | null;

/** 归一化依据。决定总量怎么算 —— 不同依据不能混着加。 */
export type TokenBasis =
  /** 子集式：cached ⊆ input，reasoning ⊆ output，total = input + output。 */
  | 'openai_inclusive'
  /** 互斥桶式：各桶互不重叠，total = 各桶之和。 */
  | 'exclusive_buckets'
  /** 未知依据：不填归一化总量，只保留原始字段。 */
  | 'unknown';

export interface NormalizedTokens {
  inputTotal: TokenValue;
  outputTotal: TokenValue;
  totalReported: TokenValue;
  cachedInput: TokenValue;
  reasoningOutput: TokenValue;
  cacheWriteInput: TokenValue;
  basis: TokenBasis;
  warnings: string[];
}

export const EMPTY_TOKENS: NormalizedTokens = {
  inputTotal: null,
  outputTotal: null,
  totalReported: null,
  cachedInput: null,
  reasoningOutput: null,
  cacheWriteInput: null,
  basis: 'unknown',
  warnings: [],
};

/**
 * 读取一个 token 字段。
 * 非整数、负数、`null`、`undefined`、字符串数字以外的内容 → 一律 `null` 并记录警告。
 * 这里刻意不做「看起来合理」的补全（§5.3 最后一段）。
 */
export function readToken(raw: Record<string, unknown>, key: string): TokenValue {
  const v = raw[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return null;
    return v;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function readPath(raw: Record<string, unknown>, path: readonly string[]): TokenValue {
  let cur: unknown = raw;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur === null || cur === undefined) return null;
  if (typeof cur === 'number' && Number.isInteger(cur) && cur >= 0) return cur;
  if (typeof cur === 'string' && /^\d+$/.test(cur.trim())) return Number(cur.trim());
  return null;
}

/**
 * 子集式归一化（OpenAI 官方口径：cached ⊆ input，reasoning ⊆ output）。
 *
 * 例：input 10,000（其中 cached 6,000）、output 2,000（其中 reasoning 1,000）
 *     → total = 12,000，而不是 19,000。
 */
export function normalizeOpenAiLike(raw: Record<string, unknown>): NormalizedTokens {
  const warnings: string[] = [];

  const inputTotal = readToken(raw, 'input_tokens') ?? readToken(raw, 'prompt_tokens') ?? readPath(raw, ['usage', 'input_tokens']) ?? readPath(raw, ['usage', 'prompt_tokens']);
  const outputTotal = readToken(raw, 'output_tokens') ?? readToken(raw, 'completion_tokens') ?? readPath(raw, ['usage', 'output_tokens']) ?? readPath(raw, ['usage', 'completion_tokens']);

  const cachedInput =
    readPath(raw, ['input_tokens_details', 'cached_tokens']) ??
    readPath(raw, ['prompt_tokens_details', 'cached_tokens']) ??
    readPath(raw, ['usage', 'input_tokens_details', 'cached_tokens']) ??
    readToken(raw, 'cached_tokens');

  const reasoningOutput =
    readPath(raw, ['output_tokens_details', 'reasoning_tokens']) ??
    readPath(raw, ['completion_tokens_details', 'reasoning_tokens']) ??
    readPath(raw, ['usage', 'output_tokens_details', 'reasoning_tokens']) ??
    readToken(raw, 'reasoning_tokens');

  const cacheWriteInput =
    readToken(raw, 'cache_creation_input_tokens') ??
    readPath(raw, ['usage', 'cache_creation_input_tokens']) ??
    readPath(raw, ['input_tokens_details', 'cache_write_tokens']);

  if (cachedInput !== null && inputTotal !== null && cachedInput > inputTotal) {
    warnings.push(
      `cached_input(${cachedInput}) 大于 input_total(${inputTotal})，与子集语义矛盾；子项按原样保留但不参与总量计算。`,
    );
  }
  if (reasoningOutput !== null && outputTotal !== null && reasoningOutput > outputTotal) {
    warnings.push(
      `reasoning_output(${reasoningOutput}) 大于 output_total(${outputTotal})，与子集语义矛盾；子项按原样保留但不参与总量计算。`,
    );
  }

  const totalReported = inputTotal === null && outputTotal === null ? null : (inputTotal ?? 0) + (outputTotal ?? 0);

  const providerTotal = readToken(raw, 'total_tokens') ?? readPath(raw, ['usage', 'total_tokens']);
  if (providerTotal !== null && totalReported !== null && providerTotal !== totalReported) {
    warnings.push(
      `供应商 total_tokens(${providerTotal}) 与本系统按子集语义算出的总量(${totalReported}) 不一致；以子集语义为准，差异保留待核查。`,
    );
  }

  return {
    inputTotal,
    outputTotal,
    totalReported,
    cachedInput,
    reasoningOutput,
    cacheWriteInput,
    basis: 'openai_inclusive',
    warnings,
  };
}

export interface ExclusiveBucket {
  /** 桶名，例如 "text_input" / "image_input" / "tool_fee"。 */
  name: string;
  tokens: TokenValue;
}

/**
 * 互斥桶式归一化。只有适配器**明确声明**各桶互不重叠时才可使用。
 * 未知桶按 `null` 处理，不参与求和，但会标记为部分缺失。
 */
export function normalizeExclusiveBuckets(buckets: readonly ExclusiveBucket[]): NormalizedTokens {
  const warnings: string[] = [];
  const known = buckets.filter((b) => b.tokens !== null);
  const missing = buckets.filter((b) => b.tokens === null);

  if (missing.length > 0) {
    warnings.push(`有 ${missing.length} 个互斥桶缺失数值（${missing.map((b) => b.name).join(', ')}），总和不完整。`);
  }

  const total = known.length === 0 ? null : known.reduce((acc, b) => acc + (b.tokens as number), 0);

  return {
    inputTotal: null,
    outputTotal: null,
    totalReported: total,
    cachedInput: null,
    reasoningOutput: null,
    cacheWriteInput: null,
    basis: 'exclusive_buckets',
    warnings,
  };
}

/**
 * 由分量计算总量 —— U02 的直接实现。
 * `total = input + output`；子项（cached / reasoning）是注释性的，**不进总和**。
 */
export function computeTotalFromParts(parts: {
  inputTotal?: TokenValue;
  outputTotal?: TokenValue;
}): TokenValue {
  const { inputTotal = null, outputTotal = null } = parts;
  if (inputTotal === null && outputTotal === null) return null;
  return (inputTotal ?? 0) + (outputTotal ?? 0);
}

/** 校验一个归一化结果是否满足 INV-02。 */
export function checkSubsetInvariant(n: NormalizedTokens): string[] {
  const problems: string[] = [];
  if (n.cachedInput !== null && n.inputTotal !== null && n.cachedInput > n.inputTotal) {
    problems.push('cached_input 超出 input_total');
  }
  if (n.reasoningOutput !== null && n.outputTotal !== null && n.reasoningOutput > n.outputTotal) {
    problems.push('reasoning_output 超出 output_total');
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* INV-07：累计计数的单调性                                             */
/* ------------------------------------------------------------------ */

export type CumulativeOutcome =
  /** 同一会话的增量更新：更新同一条事件，不叠加。 */
  | { kind: 'updated'; total: number; delta: number }
  /** 计数回退：视为新窗口/新会话，另开一条记录，绝不生成负数。 */
  | { kind: 'reset'; total: number; previousTotal: number }
  /** 首次观测。 */
  | { kind: 'initial'; total: number };

/**
 * 流式响应反复报告累计 usage 时调用（§5.5）。
 * 新值 ≥ 旧值 → 同一事件更新；新值 < 旧值 → 新窗口，不得相减出负数。
 */
export function applyCumulativeUpdate(previousTotal: TokenValue, nextTotal: number): CumulativeOutcome {
  if (previousTotal === null) return { kind: 'initial', total: nextTotal };
  if (nextTotal >= previousTotal) {
    return { kind: 'updated', total: nextTotal, delta: nextTotal - previousTotal };
  }
  return { kind: 'reset', total: nextTotal, previousTotal };
}

/* ------------------------------------------------------------------ */
/* 聚合与覆盖率                                                         */
/* ------------------------------------------------------------------ */

export interface TokenAggregate {
  /** 已知值之和；全部未知时为 null（不是 0）。 */
  value: TokenValue;
  /** 是否只覆盖了部分记录 —— 界面必须显示覆盖范围，不能宣称「账户全量」。 */
  partial: boolean;
  knownCount: number;
  unknownCount: number;
  /** 因依据不同而未参与求和的记录数。 */
  skippedByBasis: number;
}

/**
 * 聚合 token。混合依据（子集式 / 互斥桶式）时只聚合同依据记录，
 * 其余计入 `skippedByBasis`，避免把不可比的量直接相加。
 */
export function aggregateTokens(
  items: readonly { tokens: NormalizedTokens; value: TokenValue }[],
): TokenAggregate {
  let sum = 0;
  let known = 0;
  let unknown = 0;
  let skipped = 0;
  const bases = new Set(items.map((i) => i.tokens.basis).filter((b) => b !== 'unknown'));

  if (bases.size > 1) {
    // 多于一种依据：不让调用方拿到一个「看起来很权威」的混杂总数
    return { value: null, partial: true, knownCount: 0, unknownCount: 0, skippedByBasis: items.length };
  }

  for (const item of items) {
    if (item.value === null) {
      unknown += 1;
      continue;
    }
    sum += item.value;
    known += 1;
  }

  if (known === 0) {
    return { value: null, partial: unknown > 0, knownCount: 0, unknownCount: unknown, skippedByBasis: skipped };
  }

  return {
    value: sum,
    partial: unknown > 0,
    knownCount: known,
    unknownCount: unknown,
    skippedByBasis: skipped,
  };
}

/** 覆盖率描述：界面用「已观测 token（覆盖 N/M 条记录）」代替一个假精确的总数。 */
export function describeCoverage(agg: TokenAggregate): string {
  if (agg.value === null && agg.unknownCount === 0 && agg.skippedByBasis > 0) {
    return `存在多种归一化依据，共 ${agg.skippedByBasis} 条未合并统计`;
  }
  if (agg.value === null) {
    return agg.unknownCount > 0 ? `供应商未报告 token（${agg.unknownCount} 条记录）` : '无数据';
  }
  const total = agg.knownCount + agg.unknownCount;
  if (agg.unknownCount === 0) return `覆盖 ${agg.knownCount} 条记录（无未知项）`;
  return `覆盖 ${agg.knownCount}/${total} 条记录，另有 ${agg.unknownCount} 条供应商未报告 token`;
}
