/**
 * 金额（设计稿 §5.4）。
 *
 * 规则：
 * - 用**十进制定点整数的十进制字符串**存主单位（`"1999"` = 19.99 元），绝不存浮点。
 * - 运算用 BigInt，避免超过 2^53 后静默丢精度。
 * - 保存原币种；**不同币种永不相加**（INV-08）。没有汇率就分币种展示。
 * - JSON 传输大整数金额时用字符串（本模块的 `amountMinor` 本来就是字符串）。
 */

export interface Money {
  /** 最小单位金额的十进制字符串，例如 "1999" 表示 19.99。 */
  amountMinor: string;
  /** ISO-4217 代码，例如 "CNY" / "USD" / "JPY"。 */
  currency: string;
}

/** 常见币种的最小单位位数；未列出的按 2 位处理。 */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  SGD: 2,
};

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

/**
 * 常见写法到 ISO-4217 的别名。
 *
 * 这不是「宽容」而是「正确」：如果 "RMB" 和 "CNY" 被当成两种币种，它们就会各自
 * 进入不同的汇总桶，用户在概览页会看到两行永远合不到一起的支出 —— 而 INV-08
 * 又禁止跨币种相加，系统自己也修不了。别名表让这种情况从源头上不发生。
 */
const CURRENCY_ALIASES: Record<string, string> = {
  RMB: 'CNY',
  CNH: 'CNY',
  USDT: 'USD',
  'US$': 'USD',
  RENMINBI: 'CNY',
};

export function normalizeCurrency(currency: string): string {
  const raw = currency.trim().toUpperCase();
  const c = CURRENCY_ALIASES[raw] ?? raw;
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new Error(`非法币种代码：${JSON.stringify(currency)}（需要 3 位 ISO-4217 字母代码，如 CNY / USD / JPY）`);
  }
  return c;
}

const MINOR_RE = /^-?(0|[1-9]\d*)$/;

export function parseAmountMinor(text: string | number | bigint): bigint {
  const s = typeof text === 'string' ? text.trim() : String(text);
  if (!MINOR_RE.test(s)) {
    throw new Error(`非法金额（要求十进制定点整数）：${JSON.stringify(text)}`);
  }
  return BigInt(s);
}

export function isValidAmountMinor(text: string): boolean {
  return MINOR_RE.test(text.trim());
}

/** 从「主单位的小数写法」构造 Money，例如 ("19.99", "cny")。 */
export function moneyFromDecimal(decimal: string, currency: string): Money {
  const cur = normalizeCurrency(currency);
  const digits = minorUnits(cur);
  const s = decimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`非法金额字面量：${JSON.stringify(decimal)}`);
  }
  const negative = s.startsWith('-');
  const unsigned = negative ? s.slice(1) : s;
  const [intPart = '0', fracRaw = ''] = unsigned.split('.');
  if (fracRaw.length > digits) {
    throw new Error(`${cur} 最多 ${digits} 位小数，收到 ${fracRaw.length} 位：${decimal}`);
  }
  const frac = fracRaw.padEnd(digits, '0');
  const minor = BigInt(intPart + frac) * (negative ? -1n : 1n);
  return { amountMinor: minor.toString(), currency: cur };
}

/** 主单位小数写法，仅用于展示与导出。 */
export function toDecimalString(money: Money): string {
  const cur = normalizeCurrency(money.currency);
  const digits = minorUnits(cur);
  const minor = parseAmountMinor(money.amountMinor);
  const negative = minor < 0n;
  const abs = (negative ? -minor : minor).toString().padStart(digits + 1, '0');
  if (digits === 0) return `${negative ? '-' : ''}${abs}`;
  const cut = abs.length - digits;
  return `${negative ? '-' : ''}${abs.slice(0, cut)}.${abs.slice(cut)}`;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, '相加');
  return { amountMinor: (parseAmountMinor(a.amountMinor) + parseAmountMinor(b.amountMinor)).toString(), currency: a.currency };
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, '相减');
  return { amountMinor: (parseAmountMinor(a.amountMinor) - parseAmountMinor(b.amountMinor)).toString(), currency: a.currency };
}

export function negateMoney(a: Money): Money {
  const v = parseAmountMinor(a.amountMinor);
  return { amountMinor: (-v).toString(), currency: a.currency };
}

export function isZeroMoney(a: Money): boolean {
  return parseAmountMinor(a.amountMinor) === 0n;
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  // INV-08：不同币种不能相加。要合并必须先显式换汇并记录汇率来源。
  if (normalizeCurrency(a.currency) !== normalizeCurrency(b.currency)) {
    throw new Error(`不同币种不能${op}：${a.currency} 与 ${b.currency}（需先按记录汇率换算）`);
  }
}

export interface MoneyByCurrency {
  currency: string;
  amountMinor: string;
  count: number;
}

/**
 * 按币种分组求和 —— 概览页与导出使用的唯一入口。
 * 绝不返回一个跨币种的「总消耗」（§4.1）。
 */
export function sumByCurrency(items: readonly Money[]): MoneyByCurrency[] {
  const buckets = new Map<string, { total: bigint; count: number }>();
  for (const item of items) {
    const cur = normalizeCurrency(item.currency);
    const bucket = buckets.get(cur) ?? { total: 0n, count: 0 };
    bucket.total += parseAmountMinor(item.amountMinor);
    bucket.count += 1;
    buckets.set(cur, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, { total, count }]) => ({ currency, amountMinor: total.toString(), count }));
}

/** 展示用格式：`¥19.99` / `US$12.00`。仅用于界面，不参与任何计算。 */
export function formatMoney(money: Money, locale = 'zh-CN'): string {
  const decimal = toDecimalString(money);
  const cur = normalizeCurrency(money.currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: minorUnits(cur),
      maximumFractionDigits: minorUnits(cur),
    }).format(Number(decimal));
  } catch {
    return `${cur} ${decimal}`;
  }
}

/** 汇率换算结果必须自带来源，否则不允许用于合并展示（§5.4）。 */
export interface FxConversion {
  from: string;
  to: string;
  rate: string;
  rateDate: string;
  rateSource: string;
}

export function convertMoney(money: Money, fx: FxConversion): Money {
  if (normalizeCurrency(money.currency) !== normalizeCurrency(fx.from) || normalizeCurrency(fx.to) === normalizeCurrency(fx.from)) {
    throw new Error(`汇率与金额币种不匹配：${money.currency} → ${fx.to}（记录的是 ${fx.from} → ${fx.to}）`);
  }
  // 定点乘法：rate 视作 1e-9 精度的定点数
  const SCALE = 1000000000n;
  const rateDigits = fx.rate.trim();
  if (!/^\d+(\.\d+)?$/.test(rateDigits)) {
    throw new Error(`非法汇率：${JSON.stringify(fx.rate)}`);
  }
  const [intPart = '0', fracRaw = ''] = rateDigits.split('.');
  const rateMinor = BigInt(intPart + fracRaw.padEnd(9, '0').slice(0, 9));
  const product = parseAmountMinor(money.amountMinor) * rateMinor;
  const rounded = product / SCALE;
  return { amountMinor: rounded.toString(), currency: normalizeCurrency(fx.to) };
}
