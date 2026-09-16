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
import {
  allSettings,
  getSetting,
  insertIntegration,
  listIntegrations,
  recordProbe,
  refreshIntegrationSeed,
  setSetting,
} from './db/repos/system.js';
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
  /** 本次启动刷新了描述文案的种子条目（老库升级时用得上）。 */
  reseededIntegrations: string[];
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
 * 除「本地 MCP 服务」外，全部以 `documented` 或 `unknown` 起步 —— 这是刻意的：
 * §3.1 要求「官方文档描述支持」与「本机已验证」在界面上分开。真实的外部能力
 * 只能由用户按下探测之后才可能变成 `verified`，种子数据不许替它下结论。
 *
 * `seedRev` 的作用：种子里的这些文字是**会被更新的产品事实**，不是一次性的初始值。
 * 老库里的行如果还停在旧 revision，启动时会刷新描述性字段（transport /
 * auth_mode / notes / capability_detail），但**不碰** capability_status、
 * verified_at、evidence —— 那些是探测结果的领地，不能被种子覆盖。
 */
const SEED_REV = 2;

const BASELINE_INTEGRATIONS: Array<{
  id: string;
  name: string;
  category: 'usage' | 'memory' | 'chatgpt_bridge' | 'quota';
  transport: string;
  authMode: string;
  capabilityStatus: 'documented' | 'unknown' | 'unsupported' | 'verified';
  detail: Record<string, unknown>;
  evidence?: string | null;
  envRequirement: string | null;
  notes: string;
}> = [
  {
    id: 'itg_codex_usage',
    name: 'Codex 用量接口',
    category: 'usage',
    transport: '本机只读探测：codex app-server（stdio）',
    authMode: '使用 Codex 自己的认证状态；本适配器不接触任何凭据',
    capabilityStatus: 'documented',
    detail: {
      seed_rev: SEED_REV,
      implemented: true,
      milestone: 'M1',
      /**
       * 实测结论（codex-cli 0.130.0）：设计稿 §3.2 列的三个方法里，
       * 只有一个是可查询接口。这些字段是种子里的"已知事实"，
       * 真正跑过探测后会由 capability_detail.probe 覆盖更细的结论。
       */
      documented_methods: ['account/rateLimits/read', 'account/usage/read', 'thread/tokenUsage/updated'],
      method_notes: {
        'account/rateLimits/read': '可查询请求；采集为额度快照。',
        'account/usage/read': '在 0.130.0 的合法方法枚举里不存在 —— 属于「文档提到但该版本没有」。',
        'thread/tokenUsage/updated': '存在但是通知，只对活动线程推送，不能当采集源。',
      },
      caution: '额度快照、账户活动汇总、线程活动三者职责不同，不能互相替代也不能相加。',
    },
    envRequirement: '需要本机安装 Codex CLI（提供 codex app-server）',
    notes: '官方文档描述支持额度查询；实际可用性以「按下探测」后的实测结论为准，不预填 verified。',
  },
  {
    id: 'itg_cursor_usage',
    name: 'Cursor 用量 / 费用',
    category: 'usage',
    transport: '用户可导出的文件；记忆侧走 stdio MCP',
    authMode: '不假设拥有企业 API',
    capabilityStatus: 'unknown',
    detail: {
      seed_rev: SEED_REV,
      implemented: false,
      milestone: 'M1',
      memory_side: '可用于 @aicc/mcp（stdio），与本工作台的记忆工具兼容；需在本机实际联调确认。',
      caution: '官方公开的 Admin / Analytics API 面向 Enterprise teams，普通个人账户不适用。',
    },
    envRequirement: null,
    notes: '普通个人账户默认走手动或用户自己导出的文件。费用侧未做任何探测。',
  },
  {
    id: 'itg_workbuddy_memory',
    name: 'WorkBuddy 记忆接入',
    category: 'memory',
    transport: '待联调确认（MCP 服务端已就绪，客户端侧未验证）',
    authMode: '待联调确认',
    capabilityStatus: 'unknown',
    detail: {
      seed_rev: SEED_REV,
      implemented: false,
      milestone: 'M1',
      requirement: '传输方式、版本、工具调用行为需实际验证',
      not_blocking: true,
    },
    envRequirement: null,
    notes:
      '官方文档确认可连接外部工具，但正文未抓取成功，未做联调。不拿「文档支持」当运行证据；' +
      '它也不阻塞已经可用的功能。',
  },
  {
    id: 'itg_chatgpt_bridge',
    name: 'ChatGPT App 桥接（粘贴模式）',
    category: 'chatgpt_bridge',
    transport: '剪贴板 / 文本粘贴',
    authMode: '无连接，不使用任何凭据',
    capabilityStatus: 'documented',
    detail: {
      seed_rev: SEED_REV,
      implemented: true,
      milestone: 'M0',
      modes: ['生成候选提示词', '粘贴候选到收集箱', '导出上下文包'],
      caution: '没有外部工具回执时，界面只显示「已生成候选」，不显示「已同步」。',
    },
    envRequirement: null,
    notes: '基础模式不依赖任何新连接，这是唯一完整可用且不需要任何客户端配合的跨工具路径（B01 / B03）。',
  },
  {
    id: 'itg_local_mcp',
    name: '本地 MCP 服务',
    category: 'memory',
    transport: 'stdio MCP server（apps/mcp，零外部依赖）',
    authMode: '按客户端与项目发放凭据（api_credential）',
    /**
     * 这一条是**我们自己的组件**，所以它的 verified 建立在本仓库自己的测试上，
     * 而不是对第三方接口的推断 —— 与外部能力那条纪律不冲突。
     */
    capabilityStatus: 'verified',
    evidence:
      'apps/server/test/mcp-e2e.test.ts：spawn 真实 MCP 子进程 + 真实 TCP + 真实凭据，' +
      '覆盖握手、tools/list（六个工具）、tools/call、越权拒绝与审计留痕。\n' +
      '运行：npm test -w @aicc/server',
    detail: {
      seed_rev: SEED_REV,
      implemented: true,
      milestone: 'M1',
      entry: 'node apps/mcp/dist/index.js',
      env: ['AICC_API_URL', 'AICC_TOKEN'],
      tools: ['memory_search', 'memory_get', 'context_build', 'memory_propose', 'session_propose', 'integration_status'],
      design: '纯代理：不读数据库，只调本地 HTTP API（§9.2），权限校验只有一处实现。',
      defaults: {
        read_from_global_memory: false,
        credential_can_write_global_memory: false,
        credential_can_approve_or_delete: false,
      },
      caution: '本地 MCP 不等于数据不出机器：工具返回的文本可能进入所连接的模型服务（§14）。',
    },
    envRequirement: '需要一个支持 stdio MCP 的客户端；不需要额外的 SDK 依赖',
    notes: '传输层已实现并通过端到端测试。真实客户端联调（Codex / Cursor）需要在各自客户端里实际配置一次。',
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
      reseededIntegrations: [],
    },

    bootstrap(): BootstrapInfo {
      mkdirSync(config.dataDir, { recursive: true });
      mkdirSync(config.backupDir, { recursive: true });
      mkdirSync(config.exportDir, { recursive: true });

      const result = migrate(ctx.db);
      const created: string[] = [];
      const seeded: string[] = [];
      const existingIntegrations = listIntegrations(ctx.db);
      for (const baseline of BASELINE_INTEGRATIONS) {
        const existing = existingIntegrations.find((i) => i.id === baseline.id);
        if (!existing) {
          insertIntegration(ctx.db, {
            id: baseline.id,
            name: baseline.name,
            category: baseline.category,
            transport: baseline.transport,
            authMode: baseline.authMode,
            capabilityStatus: baseline.capabilityStatus,
            capabilityDetail: baseline.detail,
            evidence: baseline.evidence ?? null,
            envRequirement: baseline.envRequirement,
            notes: baseline.notes,
          });
          created.push(baseline.id);
          continue;
        }

        /**
         * 老库的种子文案刷新。
         *
         * 判断依据是 capability_detail.seed_rev；探测写回的结论放在
         * capability_detail.probe 下，所以刷新种子字段不会覆盖它。
         *
         * 能力状态只在一个前提下跟随种子：**这一条从未被探测过**
         * （没有 probed_at）。否则种子会盖掉用户的真实探测结果 ——
         * 「本地 MCP 服务」这类我们自己组件的条目会因此永远显示成未判定。
         */
        const currentRev = Number((existing.capabilityDetail as { seed_rev?: unknown }).seed_rev ?? 0);
        if (currentRev >= SEED_REV) continue;

        const preservedProbe = (existing.capabilityDetail as { probe?: unknown }).probe;
        const probed = (existing.capabilityDetail as { probed_at?: unknown }).probed_at !== undefined || preservedProbe !== undefined;

        refreshIntegrationSeed(ctx.db, baseline.id, {
          transport: baseline.transport,
          authMode: baseline.authMode,
          capabilityDetail: preservedProbe === undefined ? baseline.detail : { ...baseline.detail, probe: preservedProbe },
          envRequirement: baseline.envRequirement,
          notes: baseline.notes,
        });
        seeded.push(baseline.id);

        if (!probed && existing.capabilityStatus !== baseline.capabilityStatus) {
          recordProbe(ctx.db, baseline.id, {
            capabilityStatus: baseline.capabilityStatus,
            evidence: baseline.evidence ?? null,
          });
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
        reseededIntegrations: seeded,
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
