/**
 * 组合根：装配数据库、服务上下文与生命周期。
 *
 * 只有这里知道「连接要被关掉再打开」这件事。恢复备份需要换掉底层的数据库文件，
 * 如果让业务服务自己持有连接，就必须在每个服务里都写一遍「我可能已经失效了」的判断。
 */

import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { migrate, openDatabase, type DbConnection } from './db/database.js';
import { createServiceContext, type ServiceContext } from './service-context.js';
import { allSettings, getSetting, insertIntegration, listIntegrations, setSetting } from './db/repos/system.js';
import { DEFAULTS } from './config.js';
import { createBackup, planRestore, restoreInPlace, type BackupReport, type RestorePlan } from './services/backup.js';

export interface BootstrapInfo {
  driver: string;
  driverAttempts: Array<{ driver: string; ok: boolean; error?: string }>;
  dbFile: string;
  dataDir: string;
  schemaVersion: number;
  migrationsApplied: number[];
  createdIntegrations: string[];
  restored?: boolean;
}

export interface App {
  config: AppConfig;
  ctx: ServiceContext;
  get db(): DbConnection;
  get driver(): string;
  bootstrapInfo: BootstrapInfo;
  bootstrap(): BootstrapInfo;
  /** 关闭并重新打开数据库（用于恢复备份之后）。 */
  reopen(): void;
  close(): void;
  backup(note?: string | null): BackupReport;
  planRestore(backupName: string): RestorePlan;
  restore(backupName: string): { plan: RestorePlan; preRestoreBackup: string | null };
  settings(): Record<string, string>;
}

/**
 * 首次启动时登记的连接能力。
 *
 * 全部以 `documented` 或 `unknown` 起步 —— **没有一条是 `verified`**。
 * 这是刻意的：§3.1 要求「官方文档描述支持」与「本机已验证」在界面上分开，
 * 而 M0 根本没有实现任何外部接口探测（那是 M1 的事）。
 */
const BASELINE_INTEGRATIONS: Array<{
  id: string;
  name: string;
  category: 'usage' | 'memory' | 'chatgpt_bridge' | 'quota';
  transport: string;
  authMode: string;
  capabilityStatus: 'documented' | 'unknown' | 'unsupported';
  detail: Record<string, unknown>;
  envRequirement: string | null;
  notes: string;
}> = [
  {
    id: 'itg_codex_usage',
    name: 'Codex 用量接口',
    category: 'usage',
    transport: '本机只读探测（未实现）',
    authMode: '使用官方组件自身的认证流程',
    capabilityStatus: 'documented',
    detail: {
      documented_methods: ['account/rateLimits/read', 'account/usage/read', 'thread/tokenUsage/updated'],
      implemented: false,
      milestone: 'M1',
      caution: '额度快照、账户活动汇总、线程活动三者职责不同，不能互相替代也不能相加。',
    },
    envRequirement: '需要本机安装 Codex；探测逻辑在 M1 实现',
    notes: '官方文档描述支持本地/远程 MCP 与额度查询，但本机尚未验证，因此状态为 documented。',
  },
  {
    id: 'itg_cursor_usage',
    name: 'Cursor 用量 / 费用',
    category: 'usage',
    transport: '用户可导出的文件（未验证）',
    authMode: '不假设拥有企业 API',
    capabilityStatus: 'unknown',
    detail: {
      implemented: false,
      milestone: 'M1',
      caution: '官方公开的 Admin / Analytics API 面向 Enterprise teams，普通个人账户不适用。',
    },
    envRequirement: null,
    notes: '普通个人账户默认走手动或用户自己导出的文件。未做任何探测。',
  },
  {
    id: 'itg_workbuddy_memory',
    name: 'WorkBuddy 记忆接入',
    category: 'memory',
    transport: '待联调确认',
    authMode: '待联调确认',
    capabilityStatus: 'unknown',
    detail: { implemented: false, milestone: 'M1', requirement: '传输方式、版本、工具调用行为需实际验证' },
    envRequirement: null,
    notes: '官方文档确认可连接外部工具，但正文未抓取成功，未做联调。不拿「文档支持」当运行证据。',
  },
  {
    id: 'itg_chatgpt_bridge',
    name: 'ChatGPT App 桥接（粘贴模式）',
    category: 'chatgpt_bridge',
    transport: '剪贴板 / 文本粘贴',
    authMode: '无连接，不使用任何凭据',
    capabilityStatus: 'documented',
    detail: {
      implemented: true,
      milestone: 'M0',
      modes: ['生成候选提示词', '粘贴候选到收集箱', '导出上下文包'],
      caution: '没有外部工具回执时，界面只显示「已生成候选」，不显示「已同步」。',
    },
    envRequirement: null,
    notes: '基础模式不依赖任何新连接，这是 M0 唯一完整可用的跨工具路径（B01 / B03）。',
  },
  {
    id: 'itg_local_mcp',
    name: '本地 MCP 服务',
    category: 'memory',
    transport: 'stdio MCP server（未实现）',
    authMode: '按客户端与项目发放凭据',
    capabilityStatus: 'unknown',
    detail: {
      implemented: false,
      milestone: 'M1',
      ready: ['api_credential 表与项目范围校验', 'agent 契约的服务端实现', '只读 / 提案权限分离'],
    },
    envRequirement: '需要 MCP TypeScript SDK',
    notes: 'M0 只完成凭据模型与权限边界，MCP 传输层未实现。',
  },
];

export function createApp(config: AppConfig): App {
  let opened = openDatabase({ filePath: config.dbFile });
  let ctx = createServiceContext({ db: opened.db, config, driver: opened.driver });

  const app: App = {
    config,
    ctx,
    get db() {
      return ctx.db;
    },
    get driver() {
      return ctx.driver;
    },
    bootstrapInfo: {
      driver: opened.driver,
      driverAttempts: opened.attempts,
      dbFile: config.dbFile,
      dataDir: config.dataDir,
      schemaVersion: 0,
      migrationsApplied: [],
      createdIntegrations: [],
    },

    bootstrap(): BootstrapInfo {
      mkdirSync(config.dataDir, { recursive: true });
      mkdirSync(config.backupDir, { recursive: true });
      mkdirSync(config.exportDir, { recursive: true });

      const result = migrate(ctx.db);
      const created: string[] = [];
      for (const baseline of BASELINE_INTEGRATIONS) {
        if (!listIntegrations(ctx.db).some((i) => i.id === baseline.id)) {
          insertIntegration(ctx.db, {
            id: baseline.id,
            name: baseline.name,
            category: baseline.category,
            transport: baseline.transport,
            authMode: baseline.authMode,
            capabilityStatus: baseline.capabilityStatus,
            capabilityDetail: baseline.detail,
            envRequirement: baseline.envRequirement,
            notes: baseline.notes,
          });
          created.push(baseline.id);
        }
      }

      // 默认设置只在缺失时写入，不覆盖用户改过的值
      const defaultsToApply: Record<string, string> = {};
      if (!getSetting(ctx.db, 'quotaStaleSeconds')) defaultsToApply.quotaStaleSeconds = String(DEFAULTS.quotaStaleSeconds);
      if (!getSetting(ctx.db, 'displayTimezone')) defaultsToApply.displayTimezone = config.displayTimezone;
      if (!getSetting(ctx.db, 'contextShortBudget')) defaultsToApply.contextShortBudget = String(DEFAULTS.contextShortBudget);
      if (!getSetting(ctx.db, 'contextStandardBudget'))
        defaultsToApply.contextStandardBudget = String(DEFAULTS.contextStandardBudget);
      for (const [k, v] of Object.entries(defaultsToApply)) setSetting(ctx.db, k, v);

      app.bootstrapInfo = {
        driver: ctx.driver,
        driverAttempts: opened.attempts,
        dbFile: config.dbFile,
        dataDir: config.dataDir,
        schemaVersion: result.toVersion,
        migrationsApplied: result.applied,
        createdIntegrations: created,
      };
      return app.bootstrapInfo;
    },

    reopen(): void {
      try {
        ctx.db.close();
      } catch {
        // 已经关过就忽略
      }
      opened = openDatabase({ filePath: config.dbFile });
      ctx.db = opened.db;
      ctx.driver = opened.driver;
      migrate(ctx.db);
    },

    close(): void {
      try {
        ctx.db.close();
      } catch {
        // 忽略重复关闭
      }
    },

    backup(note?: string | null): BackupReport {
      return createBackup(ctx, { note: note ?? null });
    },

    planRestore(backupName: string): RestorePlan {
      return planRestore(ctx, backupName);
    },

    /**
     * 就地恢复。执行后数据库连接会被替换成新的，调用方不需要自己重开。
     */
    restore(backupName: string): { plan: RestorePlan; preRestoreBackup: string | null } {
      const plan = planRestore(ctx, backupName);
      const result = restoreInPlace(ctx, plan);
      app.reopen();
      return { plan, preRestoreBackup: result.preRestoreBackup };
    },

    settings(): Record<string, string> {
      return allSettings(ctx.db);
    },
  };

  return app;
}

export function describeDataDir(config: AppConfig): string {
  return existsSync(config.dataDir) ? config.dataDir : `${config.dataDir}（尚未创建）`;
}
