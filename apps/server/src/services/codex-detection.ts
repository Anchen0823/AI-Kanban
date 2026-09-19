/**
 * Codex 额度检测的轻量持久化状态。
 *
 * 额度窗口不强制归属到本系统的 billing_account：检测页首先要回答的是
 * 「本机 Codex 当前能否读到额度」，不能要求用户为了这一问先登记账户。
 * 因此这里只保存脱敏后的检测结果；真正需要进入工作台额度总览时，仍由
 * integration-probe 显式挂到用户选择的账户，两个口径不相加。
 */

import type { ServiceContext } from '../service-context.js';
import { getSetting, setSetting } from '../db/repos/system.js';
import { probeCodex, type CodexProbeResult, type QuotaSnapshotDraft } from '../collectors/codex-usage.js';

const SETTING_KEY = 'detection.codex';
const SCHEMA_VERSION = 1;

export interface CodexDetectionWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: string | null;
  windowSeconds: number | null;
}

export interface CodexDetectionResponse {
  status: 'ok' | 'error' | 'not_configured';
  checkedAt: string | null;
  lastSuccessAt: string | null;
  windows: CodexDetectionWindow[];
  message: string;
  clientVersion: string | null;
}

interface StoredCodexDetection extends Omit<CodexDetectionResponse, 'status'> {
  schemaVersion: number;
  status: 'ok' | 'error';
}

type Probe = () => Promise<CodexProbeResult>;

const inFlight = new WeakMap<ServiceContext, Promise<CodexDetectionResponse>>();

function asWindow(value: unknown): CodexDetectionWindow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.label !== 'string' ||
    typeof row.usedPercent !== 'number' ||
    !Number.isFinite(row.usedPercent) ||
    typeof row.remainingPercent !== 'number' ||
    !Number.isFinite(row.remainingPercent) ||
    (row.resetAt !== null && typeof row.resetAt !== 'string') ||
    (row.windowSeconds !== null && (typeof row.windowSeconds !== 'number' || !Number.isFinite(row.windowSeconds)))
  ) {
    return null;
  }
  return {
    label: row.label,
    usedPercent: row.usedPercent,
    remainingPercent: row.remainingPercent,
    resetAt: row.resetAt as string | null,
    windowSeconds: row.windowSeconds as number | null,
  };
}

function saved(ctx: ServiceContext): StoredCodexDetection | null {
  const raw = getSetting(ctx.db, SETTING_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      (value.status !== 'ok' && value.status !== 'error') ||
      typeof value.checkedAt !== 'string' ||
      (value.lastSuccessAt !== null && typeof value.lastSuccessAt !== 'string') ||
      !Array.isArray(value.windows) ||
      typeof value.message !== 'string' ||
      (value.clientVersion !== null && typeof value.clientVersion !== 'string')
    ) {
      return null;
    }
    const windows = value.windows.map(asWindow);
    if (windows.some((window) => window === null)) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      status: value.status,
      checkedAt: value.checkedAt,
      lastSuccessAt: value.lastSuccessAt,
      windows: windows as CodexDetectionWindow[],
      message: value.message,
      clientVersion: value.clientVersion,
    };
  } catch {
    return null;
  }
}

function notConfigured(): CodexDetectionResponse {
  return {
    status: 'not_configured',
    checkedAt: null,
    lastSuccessAt: null,
    windows: [],
    message: '尚未运行 Codex 额度检测。检测只读取本机 Codex 的账户额度，不会修改额度或登录状态。',
    clientVersion: null,
  };
}

function fromDraft(draft: QuotaSnapshotDraft): CodexDetectionWindow {
  const percent = (ratio: number): number => Number((ratio * 100).toFixed(4));
  return {
    label: draft.bucketLabel,
    usedPercent: percent(draft.usedRatio),
    remainingPercent: percent(draft.remainingRatio),
    resetAt: draft.resetAt,
    windowSeconds: draft.windowSeconds,
  };
}

/** 不让 app-server 的错误文本把账号身份或凭据带到 API 或 app_settings。 */
function safeMessage(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隐藏邮箱]')
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|bearer|cookie)\s*(?::|=|\s)\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1 [已隐藏]',
    );
}

function persist(ctx: ServiceContext, result: StoredCodexDetection): CodexDetectionResponse {
  setSetting(ctx.db, SETTING_KEY, JSON.stringify(result));
  const { schemaVersion: _schemaVersion, ...response } = result;
  return response;
}

/** 读取最近一次结果；不存在或损坏的旧值一律如实显示为尚未配置。 */
export function getCodexDetection(ctx: ServiceContext): CodexDetectionResponse {
  const result = saved(ctx);
  if (!result) return notConfigured();
  const { schemaVersion: _schemaVersion, ...response } = result;
  return response;
}

async function execute(ctx: ServiceContext, probe: Probe): Promise<CodexDetectionResponse> {
  const previous = saved(ctx);
  const checkedAt = new Date(ctx.now()).toISOString();

  try {
    const result = await probe();
    if (result.report.status === 'verified' && result.quotaSnapshots.length > 0) {
      const windows = result.quotaSnapshots.map(fromDraft);
      return persist(ctx, {
        schemaVersion: SCHEMA_VERSION,
        status: 'ok',
        checkedAt,
        lastSuccessAt: checkedAt,
        windows,
        message: `已从本机 Codex 读取 ${windows.length} 个额度窗口。额度快照独立展示，不参与用量或费用求和。`,
        clientVersion: result.report.clientVersion,
      });
    }

    return persist(ctx, {
      schemaVersion: SCHEMA_VERSION,
      status: 'error',
      checkedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      windows: previous?.windows ?? [],
      message: safeMessage(result.report.notes),
      clientVersion: result.report.clientVersion,
    });
  } catch (error) {
    return persist(ctx, {
      schemaVersion: SCHEMA_VERSION,
      status: 'error',
      checkedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      windows: previous?.windows ?? [],
      message: safeMessage(`Codex 检测进程未能完成：${error instanceof Error ? error.message : String(error)}`),
      clientVersion: null,
    });
  }
}

/**
 * 执行一次只读检测。同一 app/context 的并发刷新复用同一个 Promise，避免同时启动多个
 * codex app-server 进程争用本地状态。
 */
export function runCodexDetection(
  ctx: ServiceContext,
  options: { probe?: Probe } = {},
): Promise<CodexDetectionResponse> {
  const pending = inFlight.get(ctx);
  if (pending) return pending;

  const probe = options.probe ?? (() => probeCodex({ command: ctx.config.codexCommand }));
  const task = execute(ctx, probe);
  inFlight.set(ctx, task);
  void task.finally(() => {
    if (inFlight.get(ctx) === task) inFlight.delete(ctx);
  }).catch(() => undefined);
  return task;
}
