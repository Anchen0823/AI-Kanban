/**
 * 运行时配置。
 *
 * 所有可配置项的默认值都在这里，用户的覆盖值存在 SQLite 的 `app_settings` 里
 * （而不是散落在多个 .env 文件里），这样「恢复备份」能连设置一起恢复。
 *
 * 与 §19 的关系：设计稿列的待确认项（本机 Node 版本、数据目录、展示时区、
 * 备份位置）都在这里给出默认值，用户可以在「设置与连接」页改。
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（apps/server/src → ../../..）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  backupDir: string;
  dbFile: string;
  exportDir: string;
  /** 展示用时区（IANA）。数据库里一律存 UTC（INV-14）。 */
  displayTimezone: string;
  /** 允许调用写入 API 的 Origin。默认只允许本机开发端口。 */
  allowedOrigins: string[];
  /** 静态前端产物目录（生产模式下由本服务提供）。 */
  webDistDir: string;
  /** 额度快照默认新鲜度阈值（秒）。6 小时。 */
  quotaStaleSeconds: number;
  /** 请求体上限，导入文本也受此限制。 */
  maxBodyBytes: number;
  /** 单次导入允许的最大字节数。 */
  maxImportBytes: number;
  /** 预检里的行数上限，防止一次导入把界面卡死。 */
  maxImportRows: number;
}

export const DEFAULTS = {
  quotaStaleSeconds: 21600,
  quotaStaleSecondsMin: 60,
  quotaStaleSecondsMax: 31536000,
  contextShortBudget: 1000,
  contextStandardBudget: 2500,
  maxBodyBytes: 8 * 1024 * 1024,
  maxImportBytes: 4 * 1024 * 1024,
  maxImportRows: 20000,
} as const;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function envPort(): number {
  const raw = env('AICC_PORT');
  if (!raw) return 8787;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`AICC_PORT 不是合法端口：${raw}`);
  }
  return n;
}

function envDataDir(): string {
  const raw = env('AICC_DATA_DIR');
  if (!raw) return join(REPO_ROOT, 'data');
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}

export function loadConfig(): AppConfig {
  const dataDir = envDataDir();
  const host = env('AICC_HOST') ?? '127.0.0.1';
  const port = envPort();
  const backupDir = env('AICC_BACKUP_DIR')
    ? resolve(env('AICC_BACKUP_DIR') as string)
    : join(dataDir, 'backups');

  const origins = (env('AICC_ALLOWED_ORIGINS') ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    host,
    port,
    dataDir,
    backupDir,
    dbFile: join(dataDir, 'ai-control-center.sqlite'),
    exportDir: join(dataDir, 'exports'),
    displayTimezone: env('AICC_TZ') ?? 'Asia/Shanghai',
    allowedOrigins: origins,
    webDistDir: join(REPO_ROOT, 'apps', 'web', 'dist'),
    quotaStaleSeconds: DEFAULTS.quotaStaleSeconds,
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    maxImportBytes: DEFAULTS.maxImportBytes,
    maxImportRows: DEFAULTS.maxImportRows,
  };
}

/**
 * 绑定地址必须是回环地址。
 *
 * §14 明确要求「默认绑定 127.0.0.1，不开公网和局域网监听」。与其在文档里提醒，
 * 不如直接拒绝：把服务暴露到局域网上是一个无法用「用户同意了」来兜底的错误。
 */
export function assertLoopbackHost(host: string): void {
  const allowed = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!allowed.has(host)) {
    throw new Error(
      `拒绝绑定到 ${host}。本系统只监听得回环地址（127.0.0.1 / ::1 / localhost）。` +
        '如果确实需要手机访问，请按设计稿 §7.4 先完成远程认证设计，不要直接把本地服务暴露到局域网。',
    );
  }
}
