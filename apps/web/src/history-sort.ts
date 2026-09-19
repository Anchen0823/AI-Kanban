/** 历史用量明细的确定性排序，避免字符串排序把 5.10 放到 5.6 后面。 */

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function normalized(value: string | null): string {
  return value?.trim().toLowerCase() ?? '';
}

function isUnknownModel(value: string): boolean {
  return value.length === 0 || /^(未记录模型|未记录|unknown(?: model)?|n\/a|null|-|—)$/.test(value);
}

function version(value: string): number[] | null {
  // Codex 常写 gpt-5.6，DeepSeek 同时存在 deepseek-v4 与 v4-pro 两种命名。
  const match = value.match(/(?:\bgpt[-_ ]?|\bdeepseek[-_ ]?v?|\bv)(\d+(?:\.\d+)*)(?![\d.])/i);
  if (!match?.[1]) return null;
  return match[1].split('.').map(Number);
}

function compareVersionDescending(left: number[] | null, right: number[] | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return b - a;
  }
  return 0;
}

function variantRank(value: string): number {
  if (/astra\b/.test(value)) return -1;
  if (/\bsol\b/.test(value)) return 0;
  if (/\bterra\b/.test(value)) return 1;
  if (/\bluna\b/.test(value)) return 2;
  if (/\bpro\b/.test(value)) return 3;
  if (/\bflash\b/.test(value)) return 4;
  return 5;
}

/**
 * 模型按版本倒序；同版本依次是 sol、terra、luna、pro、flash。Codex 自动审核
 * 在普通模型之后、未记录模型之前，便于历史表优先显示用户实际选择的模型。
 */
export function compareModels(a: string | null, b: string | null): number {
  const left = normalized(a);
  const right = normalized(b);
  const leftUnknown = isUnknownModel(left);
  const rightUnknown = isUnknownModel(right);
  if (leftUnknown || rightUnknown) {
    if (leftUnknown && rightUnknown) return collator.compare(left, right);
    return leftUnknown ? 1 : -1;
  }

  const leftReview = left === 'codex-auto-review';
  const rightReview = right === 'codex-auto-review';
  if (leftReview || rightReview) {
    if (leftReview && rightReview) return 0;
    return leftReview ? 1 : -1;
  }

  const byVersion = compareVersionDescending(version(left), version(right));
  if (byVersion !== 0) return byVersion;
  const byVariant = variantRank(left) - variantRank(right);
  return byVariant !== 0 ? byVariant : collator.compare(left, right);
}

function dateValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** ISO 日期最新优先；“未知日期”和畸形日期始终排在最后。 */
export function compareDates(a: string, b: string): number {
  const left = dateValue(a);
  const right = dateValue(b);
  if (left === null || right === null) {
    if (left === null && right === null) return collator.compare(a, b);
    return left === null ? 1 : -1;
  }
  return right - left || collator.compare(a, b);
}
