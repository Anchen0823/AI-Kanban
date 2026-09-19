/** DeepSeek 官方余额接口的只读检测与无凭据结果持久化。 */

import { z } from 'zod';
import { getSetting, setSetting } from '../db/repos/system.js';
import type { ServiceContext } from '../service-context.js';

const ENDPOINT = 'https://api.deepseek.com/user/balance';
const SETTING_KEY = 'detection.deepseek';
const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;

const zMoney = z.string().min(1).max(100).regex(/^-?\d+(?:\.\d+)?$/);
const zBalanceResponse = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.string().min(1).max(16),
    total_balance: zMoney,
    granted_balance: zMoney,
    topped_up_balance: zMoney,
  })).max(20),
});

export interface DeepseekBalance {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface DeepseekDetectionResponse {
  status: 'ok' | 'error' | 'not_configured';
  checkedAt: string | null;
  lastSuccessAt: string | null;
  isAvailable: boolean | null;
  balances: DeepseekBalance[];
  message: string;
  configured: boolean;
}

interface StoredDeepseekDetection extends Omit<DeepseekDetectionResponse, 'configured'> {
  schemaVersion: 1;
  status: 'ok' | 'error';
}

export interface DeepseekDetectionOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 测试用覆盖；省略时读取 DEEPSEEK_API_KEY。 */
  envApiKey?: string | null;
}

/** API key 只保存在当前服务进程关联的上下文中。 */
const connectedKeys = new WeakMap<ServiceContext, string>();

function normalizeKey(value: string | null | undefined): string | null {
  const key = value?.trim();
  return key ? key : null;
}

function environmentKey(options: DeepseekDetectionOptions): string | null {
  if (options.envApiKey !== undefined) return normalizeKey(options.envApiKey);
  return normalizeKey(process.env.DEEPSEEK_API_KEY);
}

function configured(ctx: ServiceContext, options: DeepseekDetectionOptions): boolean {
  return connectedKeys.has(ctx) || environmentKey(options) !== null;
}

function asBalance(value: unknown): DeepseekBalance | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.currency !== 'string' ||
    typeof row.totalBalance !== 'string' ||
    typeof row.grantedBalance !== 'string' ||
    typeof row.toppedUpBalance !== 'string'
  ) return null;
  return {
    currency: row.currency,
    totalBalance: row.totalBalance,
    grantedBalance: row.grantedBalance,
    toppedUpBalance: row.toppedUpBalance,
  };
}

function saved(ctx: ServiceContext): StoredDeepseekDetection | null {
  const raw = getSetting(ctx.db, SETTING_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      (value.status !== 'ok' && value.status !== 'error') ||
      typeof value.checkedAt !== 'string' ||
      (value.lastSuccessAt !== null && typeof value.lastSuccessAt !== 'string') ||
      (value.isAvailable !== null && typeof value.isAvailable !== 'boolean') ||
      !Array.isArray(value.balances) ||
      typeof value.message !== 'string'
    ) return null;
    const balances = value.balances.map(asBalance);
    if (balances.some((balance) => balance === null)) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      status: value.status,
      checkedAt: value.checkedAt,
      lastSuccessAt: value.lastSuccessAt,
      isAvailable: value.isAvailable,
      balances: balances as DeepseekBalance[],
      message: value.message,
    };
  } catch {
    return null;
  }
}

function withoutSchema(result: StoredDeepseekDetection, isConfigured: boolean): DeepseekDetectionResponse {
  const { schemaVersion: _schemaVersion, ...response } = result;
  return { ...response, configured: isConfigured };
}

function persist(
  ctx: ServiceContext,
  result: StoredDeepseekDetection,
  isConfigured: boolean,
): DeepseekDetectionResponse {
  setSetting(ctx.db, SETTING_KEY, JSON.stringify(result));
  return withoutSchema(result, isConfigured);
}

function notConfigured(previous: StoredDeepseekDetection | null = null): DeepseekDetectionResponse {
  return {
    status: 'not_configured',
    checkedAt: previous?.checkedAt ?? null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    isAvailable: previous?.isAvailable ?? null,
    balances: previous?.balances ?? [],
    message: previous
      ? 'DeepSeek API Key 当前未配置；已保留上次成功余额，请重新连接后再检测。'
      : '尚未配置 DeepSeek API Key。可在检测时提供，或设置 DEEPSEEK_API_KEY。',
    configured: false,
  };
}

/** GET 使用：只读最近结果，绝不发起网络请求。 */
export function getDeepseekDetection(
  ctx: ServiceContext,
  options: Pick<DeepseekDetectionOptions, 'envApiKey'> = {},
): DeepseekDetectionResponse {
  const previous = saved(ctx);
  const isConfigured = configured(ctx, options);
  return previous ? withoutSchema(previous, isConfigured) : { ...notConfigured(), configured: isConfigured };
}

function statusMessage(status: number): string {
  if (status === 401) return 'DeepSeek API Key 无效或已失效。';
  if (status === 403) return 'DeepSeek 拒绝了余额查询，请检查 API Key 权限。';
  if (status === 429) return 'DeepSeek 请求过于频繁，请稍后再试。';
  if (status >= 500) return 'DeepSeek 服务暂时不可用，请稍后再试。';
  return `DeepSeek 余额接口返回 HTTP ${status}。`;
}

function failure(
  ctx: ServiceContext,
  previous: StoredDeepseekDetection | null,
  checkedAt: string,
  message: string,
): DeepseekDetectionResponse {
  return persist(ctx, {
    schemaVersion: SCHEMA_VERSION,
    status: 'error',
    checkedAt,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    isAvailable: previous?.isAvailable ?? null,
    balances: previous?.balances ?? [],
    message,
  }, true);
}

/** 执行一次官方只读余额查询。API key 从不进入数据库、日志或响应。 */
export async function runDeepseekDetection(
  ctx: ServiceContext,
  options: DeepseekDetectionOptions = {},
): Promise<DeepseekDetectionResponse> {
  const provided = normalizeKey(options.apiKey);
  if (provided) connectedKeys.set(ctx, provided);
  const apiKey = provided ?? connectedKeys.get(ctx) ?? environmentKey(options);
  const previous = saved(ctx);
  if (!apiKey) return notConfigured(previous);

  const checkedAt = new Date(ctx.now()).toISOString();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(ENDPOINT, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return failure(ctx, previous, checkedAt, statusMessage(response.status));

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure(ctx, previous, checkedAt, 'DeepSeek 返回了无法解析的余额数据。');
    }
    const parsed = zBalanceResponse.safeParse(payload);
    if (!parsed.success) {
      return failure(ctx, previous, checkedAt, 'DeepSeek 返回的余额数据格式不符合预期。');
    }

    const balances = parsed.data.balance_infos.map((balance) => ({
      currency: balance.currency,
      totalBalance: balance.total_balance,
      grantedBalance: balance.granted_balance,
      toppedUpBalance: balance.topped_up_balance,
    }));
    return persist(ctx, {
      schemaVersion: SCHEMA_VERSION,
      status: 'ok',
      checkedAt,
      lastSuccessAt: checkedAt,
      isAvailable: parsed.data.is_available,
      balances,
      message: `已从 DeepSeek 官方接口读取 ${balances.length} 个余额币种。`,
    }, true);
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    return failure(
      ctx,
      previous,
      checkedAt,
      timedOut ? 'DeepSeek 余额查询超时，请稍后再试。' : '无法连接 DeepSeek 余额接口，请稍后再试。',
    );
  } finally {
    clearTimeout(timer);
  }
}
