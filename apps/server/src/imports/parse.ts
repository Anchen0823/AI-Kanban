/**
 * 通用 CSV / JSON 解析与列映射（设计稿 §12 的「通用手动 / CSV」这一层）。
 *
 * 设计取舍：
 * - 不猜字段含义。未知列原样保留进 `raw_usage` 并给出警告，而不是按名字相似度塞进
 *   某个归一化列 —— 那会凭空造出一个「看起来合理」的 token 数（§5.3 明确禁止）。
 * - 列名别名表是显式白名单。想支持新写法就加一行，而不是靠正则去模糊匹配。
 */

/** 解析出的原始表格。 */
export interface ParsedTable {
  delimiter: string;
  headers: string[];
  rows: Record<string, string>[];
  warnings: string[];
}

const DELIMITERS = [',', '\t', ';', '|'] as const;

/** 猜分隔符：取第一行里出现次数最多、且能切出多列的那个。 */
function detectDelimiter(firstLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 风格 CSV 解析：支持引号包裹、字段内换行、双引号转义、BOM、CRLF。
 *
 * 自己写而不是拉一个库：本系统需要「局部失败」语义（某一行坏了要能指出是第几行），
 * 而多数 CSV 库遇到坏行会直接抛异常，或者静默吞掉。
 */
export function parseCsv(text: string, forcedDelimiter?: string): ParsedTable {
  const warnings: string[] = [];
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1); // 去 BOM

  const firstLineEnd = input.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? input : input.slice(0, firstLineEnd);
  const delimiter = forcedDelimiter ?? detectDelimiter(firstLine);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    record.push(field);
    field = '';
  };
  const pushRecord = (): void => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < input.length) {
    const ch = input[i] as string;

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      pushRecord();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    warnings.push('文件结尾处存在未闭合的引号，最后一行的解析结果可能不完整。');
  }
  if (field.length > 0 || record.length > 0) pushRecord();

  const nonEmpty = records.filter((r) => r.some((c) => c.trim().length > 0));
  if (nonEmpty.length === 0) {
    return { delimiter, headers: [], rows: [], warnings: [...warnings, '文件里没有任何数据行'] };
  }

  const headerRow = (nonEmpty[0] as string[]).map((h) => h.trim());
  const seen = new Map<string, number>();
  const headers = headerRow.map((h, idx) => {
    const name = h.length > 0 ? h : `column_${idx + 1}`;
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) {
      warnings.push(`表头出现重复列名 ${JSON.stringify(name)}，第 ${count + 1} 次出现被重命名为 ${name}__${count + 1}`);
      return `${name}__${count + 1}`;
    }
    return name;
  });

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < nonEmpty.length; r += 1) {
    const cells = nonEmpty[r] as string[];
    if (cells.length > headers.length) {
      warnings.push(`第 ${r + 1} 行列数（${cells.length}）多于表头（${headers.length}），多出的部分被忽略。`);
    }
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c] as string] = (cells[c] ?? '').trim();
    }
    rows.push(obj);
  }

  return { delimiter, headers, rows, warnings };
}

/**
 * JSON 导入：接受数组，或常见的包裹键。
 *
 * `candidates` 必须在列表里：§7.2 的提示词明确要求模型输出
 * `{ "schema_version": "1.0", "candidates": [...] }`，而 §6.3 的示例是单个对象。
 * 少了这个键，用户按提示词生成的内容会被整个判定为「缺少 title 或 content」。
 */
const RECORD_ARRAY_KEYS = ['candidates', 'data', 'rows', 'items', 'records', 'usage'] as const;

export function parseJsonRecords(text: string): { records: Record<string, unknown>[]; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (Array.isArray(parsed)) {
    return { records: parsed.filter(isRecord), warnings };
  }
  if (isRecord(parsed)) {
    for (const key of RECORD_ARRAY_KEYS) {
      const candidate = parsed[key];
      if (Array.isArray(candidate)) {
        if (key !== 'candidates') {
          warnings.push(`从顶层键 ${JSON.stringify(key)} 读取记录数组。`);
        }
        return { records: candidate.filter(isRecord), warnings };
      }
    }
    // 单个对象也接受，当成一行（§6.3 的记忆候选示例就是单个对象）
    warnings.push('顶层是单个对象，已按一行记录处理。');
    return { records: [parsed], warnings };
  }

  throw new Error('JSON 顶层既不是数组也不是对象，无法识别为记录');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/* 列名映射                                                            */
/* ------------------------------------------------------------------ */

export interface ColumnSpec {
  field: string;
  aliases: string[];
}

/**
 * 用量列表的显式别名白名单。**按顺序取值，先出现的列生效。**
 *
 * 为什么不模糊匹配：`in` / `out` 这种短列名在不同工具里含义完全不同
 * （有的指请求数，有的指 token）。猜错的代价是一条错误的用量记录进了主库，
 * 而它看起来和真实数据一模一样。
 */
export const USAGE_COLUMN_SPECS: readonly ColumnSpec[] = [
  { field: 'occurredAt', aliases: ['occurred_at', 'timestamp', 'time', 'datetime', 'date', 'created_at', 'created'] },
  { field: 'providerRequestId', aliases: ['provider_request_id', 'request_id', 'requestId', 'id', 'trace_id', 'completion_id'] },
  { field: 'model', aliases: ['model', 'model_name', 'model_id'] },
  { field: 'accountAlias', aliases: ['account', 'account_alias', 'account_name', 'account_id'] },
  { field: 'projectRef', aliases: ['project', 'project_id', 'project_name'] },
  { field: 'clientRef', aliases: ['client', 'client_id', 'client_name', 'tool'] },
  { field: 'inputTotal', aliases: ['input_tokens', 'prompt_tokens', 'input_token_count', 'input'] },
  { field: 'outputTotal', aliases: ['output_tokens', 'completion_tokens', 'output_token_count', 'output'] },
  { field: 'totalReported', aliases: ['total_tokens', 'total_token_count', 'total'] },
  { field: 'cachedInput', aliases: ['cached_tokens', 'cached_input_tokens', 'cache_read_tokens', 'input_cached_tokens'] },
  { field: 'reasoningOutput', aliases: ['reasoning_tokens', 'reasoning_output_tokens', 'thinking_tokens'] },
  { field: 'cacheWriteInput', aliases: ['cache_write_tokens', 'cache_creation_input_tokens'] },
  { field: 'requests', aliases: ['requests', 'request_count', 'calls'] },
  { field: 'periodStart', aliases: ['period_start', 'window_start'] },
  { field: 'periodEnd', aliases: ['period_end', 'window_end'] },
  { field: 'coverageScope', aliases: ['coverage_scope', 'coverage', 'scope'] },
  { field: 'measurementQuality', aliases: ['measurement_quality', 'quality'] },
  { field: 'collectionMethod', aliases: ['collection_method', 'source_method'] },
  { field: 'sourceRef', aliases: ['source_ref', 'source', 'url', 'link'] },
];

/** 收费列表的列名白名单。 */
export const CHARGE_COLUMN_SPECS: readonly ColumnSpec[] = [
  { field: 'occurredAt', aliases: ['occurred_at', 'timestamp', 'time', 'date', 'created_at', 'paid_at'] },
  { field: 'periodStart', aliases: ['period_start', 'billing_period_start', 'start'] },
  { field: 'periodEnd', aliases: ['period_end', 'billing_period_end', 'end'] },
  { field: 'billingRef', aliases: ['billing_ref', 'invoice_id', 'invoice', 'bill_id', 'receipt'] },
  { field: 'accountAlias', aliases: ['account', 'account_alias', 'account_name', 'account_id'] },
  { field: 'subscriptionRef', aliases: ['subscription', 'subscription_id', 'plan', 'plan_name'] },
  { field: 'amount', aliases: ['amount', 'total', 'price', 'cost', 'charged'] },
  { field: 'currency', aliases: ['currency', 'cur', 'unit'] },
  { field: 'kind', aliases: ['kind', 'type', 'charge_type'] },
  { field: 'status', aliases: ['status', 'payment_status'] },
  { field: 'note', aliases: ['note', 'description', 'memo', 'item'] },
  { field: 'sourceRef', aliases: ['source_ref', 'source', 'url', 'link'] },
];

export interface MappingResult {
  mapped: Record<string, string>;
  unknownColumns: string[];
  /** 别名命中了多个列，只取第一个，其余进未知列。 */
  ambiguous: Array<{ field: string; usedColumn: string; ignoredColumns: string[] }>;
}

/**
 * 把一行原始表头对应的数据映射到规范字段。
 * 命中的列**保留在 raw_usage 里**（数据不丢），未命中的列也保留并列入 unknownColumns。
 */
export function mapColumns(
  row: Record<string, string>,
  specs: readonly ColumnSpec[],
): MappingResult {
  const lower = new Map<string, string>();
  for (const key of Object.keys(row)) lower.set(key.toLowerCase(), key);

  const mapped: Record<string, string> = {};
  const consumed = new Set<string>();
  const ambiguous: MappingResult['ambiguous'] = [];

  for (const spec of specs) {
    const hits = spec.aliases
      .map((a) => lower.get(a.toLowerCase()))
      .filter((v): v is string => v !== undefined && (row[v] ?? '').trim().length > 0);
    if (hits.length === 0) continue;
    const [first, ...rest] = hits as [string, ...string[]];
    mapped[spec.field] = (row[first] ?? '').trim();
    consumed.add(first);
    if (rest.length > 0) ambiguous.push({ field: spec.field, usedColumn: first, ignoredColumns: rest });
    for (const h of hits) consumed.add(h);
  }

  const unknownColumns = Object.keys(row).filter((k) => !consumed.has(k));
  return { mapped, unknownColumns, ambiguous };
}
