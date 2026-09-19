/**
 * 从本机 Codex rollout 历史提取 token 汇总。
 *
 * 每行会被解析，但只会提取 session id、模型、时间戳和 `total_token_usage` 数字字段。
 * 聊天文本、工具参数、cwd、邮箱以及任何凭据都不会进入汇总、API 响应或 app_settings。
 * 这些日志只代表当前机器尚保留的历史，不能证明跨设备或已清理会话的完整总用量。
 */

import { createReadStream } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ServiceContext } from '../service-context.js';
import { getSetting, setSetting } from '../db/repos/system.js';

const SETTING_KEY = 'history.codex';
const SCHEMA_VERSION = 1;
const MAX_FILES = 10_000;
const MAX_LINE_CHARS = 1_000_000;
const MAX_WARNINGS = 40;

export interface CodexHistoryTotals {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}

export interface CodexHistoryBreakdown {
  model?: string;
  day?: string;
  totals: CodexHistoryTotals;
  sessionCount: number;
}

export interface CodexHistoryResponse {
  status: 'not_scanned' | 'ok' | 'empty' | 'error';
  checkedAt: string | null;
  totals: CodexHistoryTotals;
  sessionCount: number | null;
  firstAt: string | null;
  lastAt: string | null;
  byModel: Array<Required<Pick<CodexHistoryBreakdown, 'model'>> & Omit<CodexHistoryBreakdown, 'model' | 'day'>>;
  byDay: Array<Required<Pick<CodexHistoryBreakdown, 'day'>> & Omit<CodexHistoryBreakdown, 'model' | 'day'>>;
  warnings: string[];
  message: string;
}

interface StoredCodexHistory extends CodexHistoryResponse {
  schemaVersion: number;
}

type TokenKey = keyof CodexHistoryTotals;
type NumericTotals = Partial<Record<TokenKey, number>>;

interface UsageEvent {
  key: string;
  ordinal: number | null;
  timestamp: string | null;
  model: string | null;
  totals: NumericTotals;
}

interface SessionData {
  events: Map<string, UsageEvent>;
  parentIds: Set<string>;
}

interface MutableBreakdown {
  totals: CodexHistoryTotals;
  sessionIds: Set<string>;
}

export interface CodexHistoryScanOptions {
  /** 测试可注入目录；生产默认 CODEX_HOME，再回退到 ~/.codex。 */
  codexHome?: string;
  /** 防止意外目录树造成无限扫描；命中时会明确返回警告。 */
  maxFiles?: number;
  now?: () => number;
}

const EMPTY_TOTALS = (): CodexHistoryTotals => ({
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  totalTokens: null,
});

const inFlight = new WeakMap<ServiceContext, Promise<CodexHistoryResponse>>();
const overflowedFields = new WeakMap<CodexHistoryTotals, Set<TokenKey>>();

function noHistory(message: string, status: 'not_scanned' | 'empty' | 'error' = 'not_scanned'): CodexHistoryResponse {
  return {
    status,
    checkedAt: null,
    totals: EMPTY_TOTALS(),
    sessionCount: status === 'empty' ? 0 : null,
    firstAt: null,
    lastAt: null,
    byModel: [],
    byDay: [],
    warnings: [],
    message,
  };
}

function validNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isoTimestamp(value: unknown): string | null {
  const text = readString(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 仅接受累计计数；刻意不读取 last_token_usage，避免把同一轮的累计与增量叠加。 */
function readTotalUsage(payload: Record<string, unknown>): { totals: NumericTotals; partial: boolean } | null {
  if (payload.type !== 'token_count') return null;
  const info = asRecord(payload.info);
  const tokenCount = asRecord(payload.token_count);
  const candidates = [
    info && asRecord(info.total_token_usage),
    tokenCount && asRecord(tokenCount.total_token_usage),
    asRecord(payload.total_token_usage),
  ];
  const source = candidates.find((candidate) => candidate && (
    'total_tokens' in candidate || 'totalTokens' in candidate || 'input_tokens' in candidate || 'inputTokens' in candidate
  ));
  if (!source) return null;

  const field = (snake: string, camel: string): number | undefined => validNumber(source[snake] ?? source[camel]);
  const totals: NumericTotals = {
    inputTokens: field('input_tokens', 'inputTokens'),
    cachedInputTokens: field('cached_input_tokens', 'cachedInputTokens'),
    outputTokens: field('output_tokens', 'outputTokens'),
    reasoningOutputTokens: field('reasoning_output_tokens', 'reasoningOutputTokens'),
    totalTokens: field('total_tokens', 'totalTokens'),
  };
  if (!Object.values(totals).some((value) => value !== undefined)) return null;
  return { totals, partial: Object.values(totals).some((value) => value === undefined) };
}

function eventScore(event: UsageEvent): number {
  return Object.values(event.totals).reduce<number>((score, value) => score + (value ?? 0), 0);
}

function addWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
}

async function* rolloutFiles(root: string, maxFiles: number): AsyncGenerator<string> {
  const pending = [root];
  let yielded = 0;
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      // 不跟随链接，避免扫描被重定向到用户不期望的目录树。
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && /^rollout.*\.jsonl$/i.test(entry.name)) {
        yield path;
        yielded += 1;
        if (yielded >= maxFiles) return;
      }
    }
  }
}

async function scanFile(path: string, sessions: Map<string, SessionData>, warnings: string[]): Promise<void> {
  let sessionId: string | null = null;
  let currentModel: string | null = null;
  const pendingEvents: UsageEvent[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (line.length > MAX_LINE_CHARS) {
        addWarning(warnings, '发现超过大小限制的历史行，已跳过；其余历史仍会继续扫描。');
        continue;
      }
      let row: Record<string, unknown> | null = null;
      try {
        row = asRecord(JSON.parse(line));
      } catch {
        addWarning(warnings, '发现无法解析的历史行，已跳过；其余历史仍会继续扫描。');
        continue;
      }
      if (!row) continue;
      const payload = asRecord(row.payload);
      if (!payload) continue;

      if (row.type === 'session_meta') {
        sessionId = readString(payload.id) ?? readString(payload.session_id);
        const session = sessionId ? sessions.get(sessionId) ?? { events: new Map<string, UsageEvent>(), parentIds: new Set<string>() } : null;
        if (sessionId && session) {
          for (const key of ['forked_from_id', 'forked_from_session_id', 'parent_session_id', 'parent_id']) {
            const parentId = readString(payload[key]);
            if (parentId) session.parentIds.add(parentId);
          }
          sessions.set(sessionId, session);
        }
        continue;
      }
      if (row.type === 'turn_context') {
        currentModel = readString(payload.model) ?? currentModel;
        continue;
      }
      if (row.type !== 'event_msg') continue;

      const usage = readTotalUsage(payload);
      if (!usage) continue;
      if (usage.partial) addWarning(warnings, '部分累计 token 记录缺少字段；未出现的字段保持未知，不能视为完整统计。');
      const info = asRecord(payload.info);
      const eventModel = (info && readString(info.model)) ?? currentModel;
      const ordinal = validNumber(row.ordinal) ?? null;
      const timestamp = isoTimestamp(row.timestamp);
      // ordinal 是 rollout 内稳定的事件位置；缺失时只用数值与时间做去重键，不读正文。
      const key = ordinal === null
        ? `${timestamp ?? 'unknown'}:${Object.values(usage.totals).join(':')}`
        : `ordinal:${ordinal}`;
      pendingEvents.push({ key, ordinal, timestamp, model: eventModel, totals: usage.totals });
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (!sessionId) {
    if (pendingEvents.length > 0) addWarning(warnings, '发现缺少 session id 的用量记录，已跳过以避免误合并。');
    return;
  }
  const session = sessions.get(sessionId) ?? { events: new Map<string, UsageEvent>(), parentIds: new Set<string>() };
  sessions.set(sessionId, session);
  for (const event of pendingEvents) {
    const existing = session.events.get(event.key);
    // archived_sessions 与 sessions 可能是同一会话的备份；同 ordinal 仅保留累计数更完整的那份。
    if (!existing || eventScore(event) > eventScore(existing)) session.events.set(event.key, event);
  }
}

function addDelta(target: CodexHistoryTotals, delta: NumericTotals, warnings: string[]): void {
  const overflowed = overflowedFields.get(target) ?? new Set<TokenKey>();
  overflowedFields.set(target, overflowed);
  for (const key of Object.keys(target) as TokenKey[]) {
    const value = delta[key];
    if (value === undefined || overflowed.has(key)) continue;
    const next = (target[key] ?? 0) + value;
    if (!Number.isSafeInteger(next)) {
      target[key] = null;
      overflowed.add(key);
      addWarning(warnings, '历史 token 汇总超过安全整数范围；受影响字段已标为未知。');
    } else {
      target[key] = next;
    }
  }
}

function breakdown(map: Map<string, MutableBreakdown>, key: string): MutableBreakdown {
  const current = map.get(key);
  if (current) return current;
  const created = { totals: EMPTY_TOTALS(), sessionIds: new Set<string>() };
  map.set(key, created);
  return created;
}

function outputByModel(input: Map<string, MutableBreakdown>): CodexHistoryResponse['byModel'] {
  return [...input.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, value]) => ({ model, totals: value.totals, sessionCount: value.sessionIds.size }));
}

function outputByDay(input: Map<string, MutableBreakdown>): CodexHistoryResponse['byDay'] {
  return [...input.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ day, totals: value.totals, sessionCount: value.sessionIds.size }));
}

function signature(event: UsageEvent): string {
  return `${event.timestamp ?? 'unknown'}:${Object.values(event.totals).join(':')}`;
}

/**
 * 分叉会话常从父会话的累计计数继续。只在 session_meta 明确给出父关系、且 timestamp +
 * 累计数字都相同的情况下删掉共有前缀，并把最后一个共有累计数作为子会话的新基线。
 */
function inheritedBaseline(
  session: SessionData,
  sessions: Map<string, SessionData>,
  warnings: string[],
): { baseline: NumericTotals; inheritedKeys: Set<string> } {
  const baseline: NumericTotals = {};
  const inheritedKeys = new Set<string>();
  for (const parentId of session.parentIds) {
    const parent = sessions.get(parentId);
    if (!parent) {
      addWarning(warnings, '发现分叉会话但本机没有对应父会话；无法精确排除其继承前缀。');
      continue;
    }
    const parentSignatures = new Set([...parent.events.values()].map(signature));
    const shared = [...session.events.values()]
      .filter((event) => parentSignatures.has(signature(event)))
      .sort((a, b) => (a.ordinal ?? -1) - (b.ordinal ?? -1));
    if (shared.length === 0) {
      addWarning(warnings, '发现分叉会话但没有可验证的共有累计记录；结果可能包含继承前缀。');
      continue;
    }
    const latest = shared.at(-1) as UsageEvent;
    for (const event of shared) inheritedKeys.add(event.key);
    for (const key of Object.keys(latest.totals) as TokenKey[]) baseline[key] = latest.totals[key];
    addWarning(warnings, '已按父子会话共有累计记录排除分叉继承前缀。');
  }
  return { baseline, inheritedKeys };
}

/** 扫描当前机器保留的 rollout 日志。可单独调用，便于只读实测且不会写应用数据库。 */
export async function scanCodexHistory(options: CodexHistoryScanOptions = {}): Promise<CodexHistoryResponse> {
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const roots = [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')];
  const warnings: string[] = [];
  const sessions = new Map<string, SessionData>();
  let files = 0;
  const maxFiles = options.maxFiles ?? MAX_FILES;

  for (const root of roots) {
    try {
      await access(root);
    } catch {
      continue;
    }
    try {
      for await (const path of rolloutFiles(root, maxFiles - files)) {
        try {
          await scanFile(path, sessions, warnings);
        } catch {
          addWarning(warnings, '部分历史文件无法读取，已跳过；其余文件仍继续扫描。');
        }
        files += 1;
        if (files >= maxFiles) {
          addWarning(warnings, `历史文件超过 ${maxFiles} 个，已停止扫描；结果不是完整历史。`);
          break;
        }
      }
    } catch {
      addWarning(warnings, '部分历史目录无法读取，已跳过；结果只覆盖可读取文件。');
    }
    if (files >= maxFiles) break;
  }

  if (files === 0) {
    return {
      ...noHistory('未找到本机 Codex rollout 历史；没有把它当作 0 token。', 'error'),
      checkedAt,
      warnings,
    };
  }

  const totals = EMPTY_TOTALS();
  const models = new Map<string, MutableBreakdown>();
  const days = new Map<string, MutableBreakdown>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let records = 0;

  for (const [sessionId, session] of sessions) {
    const inheritance = inheritedBaseline(session, sessions, warnings);
    const previous: NumericTotals = inheritance.baseline;
    // 不修改 session.events：它仍是下一层分叉识别共有前缀的完整父会话视图。
    const events = [...session.events.values()].filter((event) => !inheritance.inheritedKeys.has(event.key)).sort((a, b) => {
      if (a.ordinal !== null && b.ordinal !== null) return a.ordinal - b.ordinal;
      if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp);
      return a.key.localeCompare(b.key);
    });
    for (const event of events) {
      const delta: NumericTotals = {};
      const currentTotal = event.totals.totalTokens;
      const previousTotal = previous.totalTokens;
      // total_tokens 是累计段的权威边界。只在它下降时把整组计数视作新段，避免
      // 某个 input/output 分项被上游向下修正时把该分项从零再累计一次。
      const reset = currentTotal !== undefined && previousTotal !== undefined && currentTotal < previousTotal;
      let correctedComponent = false;
      for (const key of Object.keys(event.totals) as TokenKey[]) {
        const current = event.totals[key];
        if (current === undefined) continue;
        const before = previous[key];
        if (before === undefined) delta[key] = current;
        else if (reset) {
          // total_tokens 已重置：新的累计段从零开始，旧段不会重复加入。
          delta[key] = current;
        } else if (currentTotal !== undefined && previousTotal !== undefined) {
          // 同一 total 段内，分项可能被 provider 校正而下降。保留这个有符号差分，
          // 才不会破坏原始快照中 total = input + output 的关系。
          delta[key] = current - before;
          if (current < before && key !== 'totalTokens') correctedComponent = true;
        } else if (current >= before) {
          delta[key] = current - before;
        } else {
          // 没有 total_tokens 时无法判断整段是否重置，只能保守地从该分项的新段累计。
          delta[key] = current;
          correctedComponent = true;
        }
        previous[key] = current;
      }
      if (Object.keys(delta).length === 0) continue;
      if (reset) addWarning(warnings, '发现会话累计 token 计数重置，已按新计数段累计且未重复旧段。');
      if (correctedComponent) {
        addWarning(warnings, '部分 token 分项在总计数未重置时被上游向下修正；已使用上游差分保持总量关系，分项历史可能被修订。');
      }

      addDelta(totals, delta, warnings);
      const model = event.model ?? '未记录模型';
      const modelBucket = breakdown(models, model);
      addDelta(modelBucket.totals, delta, warnings);
      modelBucket.sessionIds.add(sessionId);

      const day = event.timestamp?.slice(0, 10) ?? '未知日期';
      const dayBucket = breakdown(days, day);
      addDelta(dayBucket.totals, delta, warnings);
      dayBucket.sessionIds.add(sessionId);
      if (event.timestamp) {
        const timestamp = event.timestamp;
        if (firstAt === null || timestamp < firstAt) firstAt = timestamp;
        if (lastAt === null || timestamp > lastAt) lastAt = timestamp;
      } else {
        addWarning(warnings, '部分用量记录没有可用时间，已归入“未知日期”。');
      }
      records += 1;
    }
  }

  if (records === 0) {
    const result = {
      ...noHistory('已扫描本机 Codex 历史，但没有找到可用的累计 token 记录；没有把它当作 0 token。', 'empty'),
      checkedAt,
      warnings,
    };
    result.sessionCount = sessions.size;
    return result;
  }
  if (models.has('未记录模型')) {
    addWarning(warnings, '部分用量记录未带模型，已归入“未记录模型”。');
  }
  return {
    status: 'ok',
    checkedAt,
    totals,
    sessionCount: sessions.size,
    firstAt,
    lastAt,
    byModel: outputByModel(models),
    byDay: outputByDay(days),
    warnings,
    message: `已从本机保留的 ${files} 个 Codex rollout 文件汇总历史 token。该结果不包含其他设备、已删除或未保留的会话。`,
  };
}

function stored(ctx: ServiceContext): CodexHistoryResponse | null {
  const raw = getSetting(ctx.db, SETTING_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredCodexHistory;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      !['ok', 'empty', 'error'].includes(value.status) ||
      typeof value.checkedAt !== 'string' ||
      !value.totals ||
      !Array.isArray(value.byModel) ||
      !Array.isArray(value.byDay) ||
      !Array.isArray(value.warnings) ||
      typeof value.message !== 'string'
    ) return null;
    const { schemaVersion: _schemaVersion, ...response } = value;
    return response;
  } catch {
    return null;
  }
}

export function getCodexHistory(ctx: ServiceContext): CodexHistoryResponse {
  return stored(ctx) ?? noHistory('尚未扫描本机 Codex 历史。扫描只保存汇总数字，不保存聊天正文。');
}

export function runCodexHistory(ctx: ServiceContext, options: CodexHistoryScanOptions = {}): Promise<CodexHistoryResponse> {
  const pending = inFlight.get(ctx);
  if (pending) return pending;
  const task = scanCodexHistory({ ...options, now: () => ctx.now() }).then((result) => {
    const storedResult: StoredCodexHistory = { schemaVersion: SCHEMA_VERSION, ...result };
    setSetting(ctx.db, SETTING_KEY, JSON.stringify(storedResult));
    return result;
  });
  inFlight.set(ctx, task);
  void task.finally(() => {
    if (inFlight.get(ctx) === task) inFlight.delete(ctx);
  }).catch(() => undefined);
  return task;
}
