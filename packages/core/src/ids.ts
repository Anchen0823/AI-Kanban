import { sha256Bytes, shortFingerprint, sha256Hex, toHex } from './sha256.js';

/**
 * ID 与指纹。
 *
 * ID 带类型前缀（`mem_`、`prp_`），便于在日志、审计和上下文包清单里一眼看出实体类型，
 * 也便于在 UI 上排查「这个 ID 到底是谁」。
 */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(n: number): string {
  const bytes = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    // 理论上不可达：Node 22 与所有现代浏览器都提供 WebCrypto。
    // 这里的兜底只为了让 core 在极端环境下仍能构造 ID，不作为安全随机源。
    for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += ID_ALPHABET[(bytes[i] as number) % ID_ALPHABET.length];
  }
  return out;
}

export const ID_PREFIXES = {
  client: 'cli',
  account: 'acc',
  subscription: 'sub',
  project: 'prj',
  session: 'ses',
  usage: 'obs',
  charge: 'chg',
  quota: 'qta',
  memory: 'mem',
  revision: 'rev',
  proposal: 'prp',
  source: 'src',
  importJob: 'imp',
  integration: 'itg',
  contextExport: 'ctx',
  credential: 'cred',
  audit: 'aud',
  tombstone: 'tmb',
} as const;

export type IdEntity = keyof typeof ID_PREFIXES;

/** 生成 `prj_1a2b3c4d5e6f7g8h` 形式的 ID。 */
export function newId(entity: IdEntity): string {
  return `${ID_PREFIXES[entity]}_${randomChars(16)}`;
}

/** 会话/凭据令牌：高熵随机串。只以哈希形式落库（INV-15）。 */
export function newToken(): string {
  return `${randomChars(42)}${Date.now().toString(36)}`;
}

/** 时间一律以 UTC ISO-8601 存储（INV-14）。 */
export function nowIso(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString();
}

/**
 * 稳定 JSON 序列化：对象键排序、数组保序、忽略 `undefined`。
 * 用于构造内容指纹 —— 键序不同但语义相同的两份数据必须得到同一个指纹。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) return 'null';
    return String(value);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'bigint') return `"${(value as bigint).toString()}"`;
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 内容指纹：用于「这条记录是否见过」。 */
export function contentFingerprint(value: unknown): string {
  return shortFingerprint(canonicalJson(value));
}

/** 文件指纹：用于导入批次重放幂等（INV-05）。 */
export function fileFingerprint(fileName: string, bytes: string | Uint8Array): string {
  const digest = typeof bytes === 'string' ? sha256Hex(bytes) : toHex(sha256Bytes(bytes));
  return shortFingerprint(`${fileName}|${digest}`);
}

/** 记忆正文指纹：墓碑只保留它，不保留正文（INV-12）。 */
export function memoryContentHash(title: string, content: string): string {
  return sha256Hex(`title:${title}\ncontent:${content}`);
}

/** 一段文本的规范化：去首尾空白、统一换行、折叠行尾空格。 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}
