/** DeepSeek 控制台导出 ZIP/CSV 的脱敏历史汇总。 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { unzipSync } from 'fflate';
import { getSetting, setSetting } from '../db/repos/system.js';
import { parseCsv } from '../imports/parse.js';
import type { ServiceContext } from '../service-context.js';

const SETTING_KEY = 'history.deepseek';
const SCHEMA_VERSION = 1;
const MAX_SOURCE_FILES = 100;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100;
const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ROWS = 1_000_000;
const MAX_WARNINGS = 40;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const AMOUNT_HEADERS = [
  'user_id', 'start_time_iso', 'end_time_iso', 'model', 'api_key_name', 'api_key', 'type', 'price', 'amount',
] as const;
const COST_HEADERS = ['user_id', 'start_time_iso', 'end_time_iso', 'model', 'wallet_type', 'cost', 'currency'] as const;
const KNOWN_TYPES = new Set([
  'input_cache_hit_tokens',
  'input_cache_miss_tokens',
  'output_tokens',
  'request_count',
]);

export interface DeepseekHistoryTotals {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requestCount: number | null;
}

export interface DeepseekHistoryResponse {
  status: 'not_scanned' | 'ok' | 'empty' | 'error';
  checkedAt: string | null;
  totals: DeepseekHistoryTotals;
  firstAt: string | null;
  lastAt: string | null;
  byModel: Array<{ model: string; totals: DeepseekHistoryTotals }>;
  byDay: Array<{ day: string; totals: DeepseekHistoryTotals }>;
  costs: Array<{ currency: string; amount: string }>;
  fileCount: number;
  warnings: string[];
  message: string;
}

interface StoredDeepseekHistory extends DeepseekHistoryResponse {
  schemaVersion: 1;
}

export interface DeepseekHistoryScanOptions {
  directory: string;
  now?: () => number;
}

interface AmountRow {
  startAt: string;
  endAt: string;
  day: string;
  model: string;
  type: string;
  amount: bigint;
}

interface CostRow {
  startAt: string;
  endAt: string;
  currency: string;
  cost: Decimal;
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}

interface Accumulator {
  cacheHit: bigint;
  cacheMiss: bigint;
  output: bigint;
  requests: bigint;
  rows: number;
  seenCacheHit: boolean;
  seenCacheMiss: boolean;
  seenOutput: boolean;
  seenRequests: boolean;
}

interface SourceRange {
  start: string;
  end: string;
}

class ScanError extends Error {}

const EMPTY_TOTALS = (): DeepseekHistoryTotals => ({
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  totalTokens: null,
  requestCount: null,
});

function emptyResponse(
  message: string,
  status: 'not_scanned' | 'empty' | 'error' = 'not_scanned',
  checkedAt: string | null = null,
  fileCount = 0,
  warnings: string[] = [],
): DeepseekHistoryResponse {
  return {
    status,
    checkedAt,
    totals: EMPTY_TOTALS(),
    firstAt: null,
    lastAt: null,
    byModel: [],
    byDay: [],
    costs: [],
    fileCount,
    warnings,
    message,
  };
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
}

function hashIdentity(userId: string, apiKey = ''): string {
  return createHash('sha256').update(userId).update('\0').update(apiKey).digest('hex');
}

function timestamp(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function dayFrom(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
  return match?.[1] ?? null;
}

function parseInteger(value: string): bigint | null {
  const text = value.trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

function parseDecimal(value: string): Decimal | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? '';
  const sign = match[1] === '-' ? -1n : 1n;
  return { coefficient: sign * BigInt(`${match[2]}${fraction}`), scale: fraction.length };
}

function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return {
    coefficient: a.coefficient * (10n ** BigInt(scale - a.scale)) + b.coefficient * (10n ** BigInt(scale - b.scale)),
    scale,
  };
}

function decimalString(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, '0');
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const integer = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function accumulator(): Accumulator {
  return {
    cacheHit: 0n,
    cacheMiss: 0n,
    output: 0n,
    requests: 0n,
    rows: 0,
    seenCacheHit: false,
    seenCacheMiss: false,
    seenOutput: false,
    seenRequests: false,
  };
}

function addAmount(target: Accumulator, row: AmountRow): void {
  if (row.type === 'input_cache_hit_tokens') {
    target.cacheHit += row.amount;
    target.seenCacheHit = true;
  } else if (row.type === 'input_cache_miss_tokens') {
    target.cacheMiss += row.amount;
    target.seenCacheMiss = true;
  } else if (row.type === 'output_tokens') {
    target.output += row.amount;
    target.seenOutput = true;
  } else if (row.type === 'request_count') {
    target.requests += row.amount;
    target.seenRequests = true;
  }
  target.rows += 1;
}

function safeNumber(value: bigint, warnings: string[]): number | null {
  if (value > MAX_SAFE_BIGINT) {
    addWarning(warnings, '部分历史计数超过 JavaScript 安全整数范围，受影响字段已标为未知。');
    return null;
  }
  return Number(value);
}

function totals(value: Accumulator, warnings: string[]): DeepseekHistoryTotals {
  if (value.rows === 0) return EMPTY_TOTALS();
  const input = value.cacheHit + value.cacheMiss;
  const inputKnown = value.seenCacheHit || value.seenCacheMiss;
  if (inputKnown && value.seenCacheHit !== value.seenCacheMiss) {
    addWarning(warnings, '部分分组只出现一种输入 token bucket；输入合计仅包含已导出的 bucket。');
  }
  if ((inputKnown && !value.seenOutput) || (!inputKnown && value.seenOutput)) {
    addWarning(warnings, '部分分组缺少输入或输出 token bucket；总 token 仅包含已导出的 bucket。');
  }
  return {
    inputTokens: inputKnown ? safeNumber(input, warnings) : null,
    cachedInputTokens: value.seenCacheHit ? safeNumber(value.cacheHit, warnings) : null,
    outputTokens: value.seenOutput ? safeNumber(value.output, warnings) : null,
    totalTokens: inputKnown || value.seenOutput ? safeNumber(input + value.output, warnings) : null,
    requestCount: value.seenRequests ? safeNumber(value.requests, warnings) : null,
  };
}

function rangeFromName(name: string): SourceRange | null {
  const match = /(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:\.zip|\.csv)$/i.exec(name);
  return match ? { start: match[1] as string, end: match[2] as string } : null;
}

function rangeSummary(ranges: SourceRange[], warnings: string[]): string {
  if (ranges.length === 0) return '导出文件名没有可识别的日期范围';
  const unique = [...new Map(ranges.map((range) => [`${range.start}:${range.end}`, range])).values()]
    .sort((a, b) => a.start.localeCompare(b.start));
  let gaps = 0;
  let furthestEnd = unique[0]?.end as string;
  for (const range of unique.slice(1)) {
    const nextDay = new Date(`${furthestEnd}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (range.start > nextDay.toISOString().slice(0, 10)) gaps += 1;
    if (range.end > furthestEnd) furthestEnd = range.end;
  }
  if (gaps > 0) addWarning(warnings, `检测到 ${gaps} 个导出日期范围空档；缺失范围没有按 0 用量处理。`);
  return `导出文件声明范围 ${unique[0]?.start ?? '未知'} 至 ${furthestEnd}${gaps > 0 ? `，其中有 ${gaps} 个范围空档` : ''}`;
}

function validHeaders(headers: string[], required: readonly string[]): boolean {
  const present = new Set(headers);
  return required.every((header) => present.has(header));
}

function parseCsvRows(
  text: string,
  amountRows: Map<string, AmountRow>,
  costRows: Map<string, CostRow>,
  warnings: string[],
  state: { rows: number },
): void {
  const parsed = parseCsv(text);
  if (parsed.warnings.length > 0) addWarning(warnings, '部分 CSV 存在格式提示；已继续解析可识别的数据行。');
  const amountFile = validHeaders(parsed.headers, AMOUNT_HEADERS);
  const costFile = validHeaders(parsed.headers, COST_HEADERS);
  if (!amountFile && !costFile) {
    addWarning(warnings, '发现表头不符合已确认 DeepSeek 导出格式的 CSV，已跳过。');
    return;
  }

  state.rows += parsed.rows.length;
  if (state.rows > MAX_ROWS) throw new ScanError(`导出数据超过 ${MAX_ROWS} 行安全上限，已停止扫描。`);

  for (const row of parsed.rows) {
    const startRaw = row.start_time_iso?.trim() ?? '';
    const endRaw = row.end_time_iso?.trim() ?? '';
    const startAt = timestamp(startRaw);
    const endAt = timestamp(endRaw);
    const day = dayFrom(startRaw);
    const model = row.model?.trim() ?? '';
    if (!startAt || !endAt || !day || endAt < startAt || !model) {
      addWarning(warnings, '部分导出行缺少有效时间或模型，已跳过。');
      continue;
    }

    if (amountFile) {
      const type = row.type?.trim() ?? '';
      if (!KNOWN_TYPES.has(type)) {
        addWarning(warnings, '发现无法识别的 DeepSeek 用量类型，已跳过且没有猜测其含义。');
        continue;
      }
      const amount = parseInteger(row.amount ?? '');
      const rawPrice = row.price?.trim() ?? '';
      // 官方 request_count 行没有计价，price 留空；它仍是稳定 bucket 的一部分。
      const parsedPrice = type === 'request_count' && rawPrice === '' ? null : parseDecimal(rawPrice);
      if (amount === null || (type !== 'request_count' && parsedPrice === null)) {
        addWarning(warnings, '部分用量行含无效的 amount 或 price，已跳过。');
        continue;
      }
      const price = parsedPrice ? decimalString(parsedPrice) : 'not-priced';
      const identity = hashIdentity(row.user_id?.trim() ?? '', row.api_key?.trim() ?? '');
      const key = [day, startRaw, endRaw, model, identity, type, price].join('\0');
      const existing = amountRows.get(key);
      if (existing) {
        if (existing.amount !== amount) addWarning(warnings, '发现同一用量 bucket 的金额冲突；已保留首次值且没有重复累计。');
        continue;
      }
      amountRows.set(key, { startAt, endAt, day, model, type, amount });
      continue;
    }

    const cost = parseDecimal(row.cost ?? '');
    const currency = row.currency?.trim().toUpperCase() ?? '';
    const wallet = row.wallet_type?.trim() ?? '';
    if (!cost || !currency || !wallet) {
      addWarning(warnings, '部分消费行缺少有效 cost、currency 或 wallet_type，已跳过。');
      continue;
    }
    if (wallet !== 'Paid' && wallet !== 'Granted') {
      addWarning(warnings, '发现未识别的钱包类型；仍按官方 cost 计入对应币种，并保留提示。');
    }
    const identity = hashIdentity(row.user_id?.trim() ?? '');
    const key = [day, startRaw, endRaw, model, identity, wallet, currency].join('\0');
    const existing = costRows.get(key);
    if (existing) {
      if (decimalString(existing.cost) !== decimalString(cost)) {
        addWarning(warnings, '发现同一消费 bucket 的金额冲突；已保留首次值且没有重复累计。');
      }
      continue;
    }
    costRows.set(key, { startAt, endAt, currency, cost });
  }
}

function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ScanError('发现不是有效 UTF-8 的 CSV，已停止扫描。');
  }
}

async function csvContents(path: string, extension: string, limits: { uncompressed: number }): Promise<string[]> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new ScanError('发现符号链接或非普通导出文件，已停止扫描。');
  if (extension === '.csv') {
    if (info.size > MAX_CSV_BYTES) throw new ScanError('单个 CSV 超过安全大小限制，已停止扫描。');
    limits.uncompressed += info.size;
    if (limits.uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new ScanError('导出内容解压后超过总大小限制，已停止扫描。');
    }
    return [decodeCsv(await readFile(path))];
  }

  if (info.size > MAX_ARCHIVE_BYTES) throw new ScanError('单个 ZIP 超过安全大小限制，已停止扫描。');
  const bytes = await readFile(path);
  let entries = 0;
  const names = new Set<string>();
  let archiveUncompressed = 0;
  try {
    const files = unzipSync(bytes, {
      filter(entry) {
        entries += 1;
        if (entries > MAX_ARCHIVE_ENTRIES) throw new ScanError('ZIP 条目数超过安全限制，已停止扫描。');
        const direct = !entry.name.includes('/') && !entry.name.includes('\\') && !entry.name.includes('\0');
        const csv = entry.name.toLowerCase().endsWith('.csv');
        if (!direct || !csv) return false;
        if (names.has(entry.name)) throw new ScanError('ZIP 含重复条目名，已停止扫描。');
        names.add(entry.name);
        if (entry.size > MAX_ARCHIVE_BYTES || entry.originalSize > MAX_CSV_BYTES) {
          throw new ScanError('ZIP 内单个 CSV 超过安全大小限制，已停止扫描。');
        }
        archiveUncompressed += entry.originalSize;
        if (archiveUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES - limits.uncompressed) {
          throw new ScanError('导出内容解压后超过总大小限制，已停止扫描。');
        }
        return true;
      },
    });
    limits.uncompressed += archiveUncompressed;
    return Object.values(files).map(decodeCsv);
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('ZIP 无法安全解压或格式无效，已停止扫描。');
  }
}

function stored(ctx: ServiceContext): DeepseekHistoryResponse | null {
  const raw = getSetting(ctx.db, SETTING_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredDeepseekHistory;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !['ok', 'empty', 'error'].includes(value.status) ||
      typeof value.checkedAt !== 'string' ||
      !value.totals ||
      !Array.isArray(value.byModel) ||
      !Array.isArray(value.byDay) ||
      !Array.isArray(value.costs) ||
      !Array.isArray(value.warnings) ||
      typeof value.fileCount !== 'number' ||
      typeof value.message !== 'string'
    ) return null;
    const { schemaVersion: _schemaVersion, ...response } = value;
    return response;
  } catch {
    return null;
  }
}

export function getDeepseekHistory(ctx: ServiceContext): DeepseekHistoryResponse {
  return stored(ctx) ?? emptyResponse('尚未扫描 DeepSeek 控制台导出。');
}

/** 只读扫描指定目录；不会保存原始身份、API Key、文件名或目录。 */
export async function scanDeepseekHistory(options: DeepseekHistoryScanOptions): Promise<DeepseekHistoryResponse> {
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const warnings: string[] = [];
  const directory = options.directory.trim();
  if (!directory || !isAbsolute(directory)) {
    return emptyResponse('请选择有效的绝对导出目录。', 'error', checkedAt);
  }

  let entries;
  try {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      return emptyResponse('所选路径不是可安全读取的普通目录。', 'error', checkedAt);
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return emptyResponse('无法读取所选 DeepSeek 导出目录。', 'error', checkedAt);
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && /\.(?:zip|csv)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length > MAX_SOURCE_FILES) {
    return emptyResponse(`直接子文件超过 ${MAX_SOURCE_FILES} 个安全上限，已停止扫描。`, 'error', checkedAt);
  }

  const amountRows = new Map<string, AmountRow>();
  const costRows = new Map<string, CostRow>();
  const state = { rows: 0 };
  const limits = { uncompressed: 0 };
  const ranges: SourceRange[] = [];
  let fileCount = 0;
  try {
    for (const entry of candidates) {
      const extension = entry.name.toLowerCase().endsWith('.zip') ? '.zip' : '.csv';
      const range = rangeFromName(entry.name);
      if (range) ranges.push(range);
      const contents = await csvContents(join(directory, entry.name), extension, limits);
      fileCount += 1;
      for (const content of contents) parseCsvRows(content, amountRows, costRows, warnings, state);
    }
  } catch (error) {
    const message = error instanceof ScanError ? error.message : '扫描 DeepSeek 导出时发生读取错误。';
    return emptyResponse(message, 'error', checkedAt, fileCount, warnings);
  }

  const coverage = rangeSummary(ranges, warnings);
  if (amountRows.size === 0 && costRows.size === 0) {
    return emptyResponse(
      `已扫描 ${fileCount} 个直接子文件，但没有找到可用的 DeepSeek 历史行。${coverage}；结果并非完整历史。`,
      'empty', checkedAt, fileCount, warnings,
    );
  }

  const aggregate = accumulator();
  const models = new Map<string, Accumulator>();
  const days = new Map<string, Accumulator>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const row of amountRows.values()) {
    addAmount(aggregate, row);
    const model = models.get(row.model) ?? accumulator();
    addAmount(model, row);
    models.set(row.model, model);
    const day = days.get(row.day) ?? accumulator();
    addAmount(day, row);
    days.set(row.day, day);
    if (firstAt === null || row.startAt < firstAt) firstAt = row.startAt;
    if (lastAt === null || row.endAt > lastAt) lastAt = row.endAt;
  }

  const costByCurrency = new Map<string, Decimal>();
  for (const row of costRows.values()) {
    costByCurrency.set(row.currency, addDecimal(costByCurrency.get(row.currency) ?? { coefficient: 0n, scale: 0 }, row.cost));
    if (firstAt === null || row.startAt < firstAt) firstAt = row.startAt;
    if (lastAt === null || row.endAt > lastAt) lastAt = row.endAt;
  }

  return {
    status: 'ok',
    checkedAt,
    totals: totals(aggregate, warnings),
    firstAt,
    lastAt,
    byModel: [...models.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, value]) => ({
      model,
      totals: totals(value, warnings),
    })),
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({
      day,
      totals: totals(value, warnings),
    })),
    costs: [...costByCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({
      currency,
      amount: decimalString(amount),
    })),
    fileCount,
    warnings,
    message: `已从 ${fileCount} 个 DeepSeek 导出文件汇总历史用量。${coverage}；可能存在未导出的日期，结果仅代表所选导出范围，并非完整历史。`,
  };
}

export async function runDeepseekHistory(
  ctx: ServiceContext,
  options: DeepseekHistoryScanOptions,
): Promise<DeepseekHistoryResponse> {
  const result = await scanDeepseekHistory({ ...options, now: () => ctx.now() });
  // 扫描失败不覆盖最近一次成功/空结果，避免一次错误路径让已有历史统计永久消失。
  if (result.status !== 'error') {
    const storedResult: StoredDeepseekHistory = { schemaVersion: SCHEMA_VERSION, ...result };
    setSetting(ctx.db, SETTING_KEY, JSON.stringify(storedResult));
  }
  return result;
}
