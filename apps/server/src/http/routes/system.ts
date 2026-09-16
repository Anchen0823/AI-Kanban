/**
 * 系统路由：配对、设置、自检、审计、备份恢复、demo、能力登记、凭据。
 *
 * 这里集中了所有「只有用户会话能调用」的管理动作。代理凭据走到这些路由会被
 * `requireUser` 拒绝 —— 这是 §11.2「MCP 普通客户端凭据不能调用审批、删除或连接管理接口」
 * 的落点之一。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId, newToken, zCreateCredential, zProbeIntegrationInput } from '@aicc/core';
import { audit, readAudit } from '../../services/audit.js';
import { deleteBackup, listBackups } from '../../services/backup.js';
import { demoStatus, resetDemo, seedDemo } from '../../services/demo.js';
import { CODEX_ADAPTER_ID, CODEX_ADAPTER_VERSION, probeCodex } from '../../collectors/codex-usage.js';
import { storeProbeQuotaSnapshots } from '../../services/integration-probe.js';
import { SCHEMA_VERSION } from '../../db/database.js';
import { getClient, listClients } from '../../db/repos/registry.js';
import {
  databaseCounts,
  getIntegration,
  insertCredential,
  listCredentials,
  listIntegrations,
  recordProbe,
  revokeCredential,
  setSetting,
} from '../../db/repos/system.js';
import { ApiError } from '../errors.js';
import { parseCookies, SESSION_COOKIE, type SessionStore } from '../auth.js';
import type { ServiceContext } from '../../service-context.js';
import { requirePrincipal, requireUser, workspaceOf, type HttpDeps } from '../server.js';
const zPairInput = z.object({
  code: z.string().min(4).max(32),
  label: z.string().max(120).default('本机浏览器'),
});

const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;

const zSettingsPatch = z.object({
  displayTimezone: z.string().max(80).optional(),
  dataDir: z.string().max(500).optional(),
  backupDir: z.string().max(500).optional(),
  quotaStaleSeconds: z.number().int().positive().max(31536000).optional(),
  contextShortBudget: z.number().int().positive().max(100000).optional(),
  contextStandardBudget: z.number().int().positive().max(200000).optional(),
});

export function registerSystemRoutes(fastify: FastifyInstance, deps: HttpDeps): void {
  const { app, sessions } = deps;
  const ctx = app.ctx;

  /* ---------------- 会话与配对 ---------------- */

  fastify.post('/api/session/pair', async (request, reply) => {
    const input = zPairInput.parse(request.body ?? {});
    const result = pairOrThrow(sessions, input.code, input.label, ctx);
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    );
    audit(ctx, { action: 'auth.login', entityType: 'session', entityId: 'local', detail: { label: input.label } });
    return {
      ok: true,
      expiresAt: result.expiresAt,
      note: '会话 Cookie 为 HttpOnly + SameSite=Strict。本地 http 环境不设置 Secure 标志（否则浏览器不会回传）。',
    };
  });
  fastify.get('/api/session', async (request) => {
    const principal = request.principal;
    if (!principal) {
      return {
        authenticated: false,
        hint: '需要配对码。服务启动时终端会打印一个一次性配对码；配对成功后配对码会立即更换。',
      };
    }
    return {
      authenticated: true,
      kind: principal.kind,
      label: principal.label,
      projectScope: principal.kind === 'credential' ? principal.projectIds : null,
      scopes: principal.kind === 'credential' ? principal.scopes : 'user-session',
      // 主动告诉前端当前主体不能做什么，避免界面显示出点了必然失败的按钮
      forbiddenActions:
        principal.kind === 'credential'
          ? ['proposal_review', 'memory_delete', 'connection_manage', 'credential_manage', 'backup_restore', 'demo_reset']
          : [],
    };
  });

  fastify.delete('/api/session', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.revoke(token);
    reply.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    audit(ctx, { action: 'auth.reject', entityType: 'session', entityId: 'local', detail: { reason: 'logout' } });
    return { ok: true };
  });

  /* ---------------- 自检 ---------------- */

  fastify.get('/api/self-check', async (request) => {
    requireUser(request);
    return {
      schemaVersion: SCHEMA_VERSION,
      driver: app.bootstrapInfo.driver,
      driverAttempts: app.bootstrapInfo.driverAttempts,
      dataDir: app.config.dataDir,
      dbFile: app.config.dbFile,
      backupDir: app.config.backupDir,
      webBuilt: existsSync(`${app.config.webDistDir}/index.html`),
      migrationsApplied: app.bootstrapInfo.migrationsApplied,
      counts: databaseCounts(app.db, true),
      realCounts: databaseCounts(app.db, false),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      activeSessions: sessions.count(),
      checks: [
        { name: 'SQLite 驱动可用', ok: true, detail: `实际使用 ${app.bootstrapInfo.driver}` },
        { name: 'WAL 模式与事务', ok: true, detail: 'journal_mode=WAL；业务写入与审计同事务提交' },
        {
          name: '热备份（wal_checkpoint + VACUUM INTO）',
          ok: true,
          detail: '备份前先合并 WAL，避免「文件看起来正常但缺了最近提交的数据」',
        },
        {
          name: '本地 MCP 服务',
          ok: false,
          detail: 'M0 未实现（计划 M1）。当前只提供 HTTP API、凭据模型与项目范围隔离。',
        },
        {
          name: '外部用量接口探测',
          ok: false,
          detail: 'M0 未实现任何外部探测（计划 M1），集成能力状态保持 documented / unknown，不预填 verified。',
        },
        {
          name: 'ChatGPT 导出包解析',
          ok: false,
          detail: 'M0 未实现（计划 M2）。当前只支持粘贴候选与手动 / CSV / JSON 导入。',
        },
      ],
    };
  });

  /* ---------------- 设置 ---------------- */

  fastify.get('/api/settings', async (request) => {
    requireUser(request);
    return {
      settings: app.settings(),
      defaults: {
        displayTimezone: app.config.displayTimezone,
        host: app.config.host,
        port: app.config.port,
        dataDir: app.config.dataDir,
        dbFile: app.config.dbFile,
        backupDir: app.config.backupDir,
        allowedOrigins: app.config.allowedOrigins,
        maxImportBytes: app.config.maxImportBytes,
        maxImportRows: app.config.maxImportRows,
      },
    };
  });

  fastify.patch('/api/settings', async (request) => {
    requireUser(request);
    const patch = zSettingsPatch.parse(request.body ?? {});
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      setSetting(app.db, key, String(value));
    }
    audit(ctx, {
      action: 'backup.create',
      entityType: 'settings',
      entityId: 'app_settings',
      detail: { changed: Object.keys(patch) },
    });
    return { ok: true, settings: app.settings() };
  });

  /* ---------------- 审计 ---------------- */

  fastify.get('/api/audit', async (request) => {
    requireUser(request);
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100), action: z.string().max(80).optional() })
      .parse(request.query ?? {});
    return {
      events: readAudit(ctx, { ...q, workspace: workspaceOf(request) }),
      note: '审计只保留动作、ID、时间与结果，不复制被删除内容的全文。',
    };
  });

  /* ---------------- 备份与恢复 ---------------- */

  fastify.get('/api/backups', async (request) => {
    requireUser(request);
    return {
      backups: listBackups(app.config),
      backupDir: app.config.backupDir,
      notes: [
        '备份使用 SQLite 自身的导出机制，且备份前先合并 WAL，不会遗漏未合并的事务。',
        '备份件默认不进入 Git、不上传云端。包含敏感内容的普通本地文件并非天然加密。',
      ],
    };
  });

  fastify.post('/api/backups', async (request) => {
    requireUser(request, '备份');
    const input = z.object({ note: z.string().max(500).nullable().optional() }).parse(request.body ?? {});
    const report = app.backup(input.note ?? null);
    return {
      ok: true,
      name: report.name,
      dir: report.dir,
      manifest: report.manifest,
      note: '备份已生成。恢复前请先做「恢复预览」，核对会变成什么状态。',
    };
  });

  fastify.post('/api/backups/:name/restore-plan', async (request) => {
    requireUser(request, '备份');
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(request.params);
    return {
      plan: app.planRestore(name),
      note: '这是预览，不会修改任何数据。恢复会覆盖当前数据库，执行前系统会自动先备份一次。',
    };
  });

  fastify.post('/api/backups/:name/restore', async (request) => {
    requireUser(request, '恢复备份（会覆盖当前数据库）');
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(request.params);
    // 必须在请求体里显式写 true。恢复是不可逆的高风险动作，不接受默认值。
    z.object({ confirm: z.literal(true) }).parse(request.body ?? {});

    const result = app.restore(name);
    audit(ctx, {
      action: 'backup.restore',
      entityType: 'backup',
      entityId: name,
      detail: {
        preRestoreBackup: result.preRestoreBackup,
        fromSchemaVersion: result.plan.backupSchemaVersion,
        toSchemaVersion: result.plan.currentSchemaVersion,
      },
    });
    return {
      ok: true,
      restored: name,
      preRestoreBackup: result.preRestoreBackup,
      counts: databaseCounts(app.db, false),
      note: '恢复完成，数据库连接已重新打开。恢复前的自动备份仍然保留，可以回退。',
    };
  });

  fastify.delete('/api/backups/:name', async (request) => {
    requireUser(request, '删除备份');
    const { name } = z.object({ name: z.string().min(1).max(200) }).parse(request.params);
    deleteBackup(app.config, name);
    return { ok: true, deleted: name };
  });

  /* ---------------- Demo ---------------- */

  fastify.get('/api/demo/status', async (request) => {
    requireUser(request);
    return demoStatus(ctx);
  });

  fastify.post('/api/demo/seed', async (request) => {
    requireUser(request, '生成示例数据');
    return seedDemo(ctx);
  });

  fastify.post('/api/demo/reset', async (request) => {
    requireUser(request, '清空示例数据');
    return resetDemo(ctx);
  });

  /* ---------------- 能力登记 ---------------- */

  fastify.get('/api/integrations', async (request) => {
    requirePrincipal(request);
    return {
      integrations: listIntegrations(app.db, workspaceOf(request)),
      statusMeaning: {
        documented: '官方文档或公开资料支持，但本机尚未验证。界面不得显示为「已同步」。',
        verified: '本机实测通过，并且附了证据。',
        unsupported: '明确不支持（已尝试，或有官方说明）。',
        unknown: '未做任何探测，或探测结果无法判定。',
      },
    };
  });

  fastify.post('/api/integrations/:id/probe', async (request) => {
    requireUser(request, '连接管理');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const input = zProbeIntegrationInput.parse(request.body ?? {});

    // M1：Codex 这一条真的去探测。
    //
    // 注意它是**只读**的：只尝试 account/read、account/usage/read、account/rateLimits/read
    // 三个查询方法，不触碰任何充值 / 重置 / 发信类方法（§3.2）。进程用完即关，
    // 不与用户正在用的 Codex 抢状态。前两个里 account/usage/read 只是「确认它存不存在」——
    // 实测来看 codex 0.130.0 没有这个方法，探测会如实记为 unsupported 而不是猜一个等价实现。
    if (id === 'itg_codex_usage') {
      const probe = await probeCodex({ command: ctx.config.codexCommand });
      const before = getIntegration(app.db, id);

      const updated = recordProbe(app.db, id, {
        capabilityStatus: probe.report.status,
        // 探测结论写在 probe 键下，不摊平进顶层 —— 这样种子的描述字段
        // （implemented / milestone / method_notes …）在下次启动刷新时不会被弄丢。
        capabilityDetail: {
          ...(before?.capabilityDetail ?? {}),
          probe: probe.report.detail,
        },
        evidence: probe.report.evidence,
        clientVersion: probe.report.clientVersion,
        note: input.note?.trim() ? `${probe.report.notes}\n\n用户备注：${input.note.trim()}` : probe.report.notes,
      });

      // 只有真的拿到快照才需要账户；没给账户就不落库并如实说明。
      const store = storeProbeQuotaSnapshots(ctx, input.accountId ?? null, probe.quotaSnapshots, CODEX_ADAPTER_VERSION);
      const storedSnapshots = store.stored;

      audit(ctx, {
        action: 'integration.probe',
        entityType: 'integration',
        entityId: id,
        result: probe.report.status === 'verified' ? 'ok' : 'rejected',
        detail: {
          adapter: CODEX_ADAPTER_ID,
          adapterVersion: CODEX_ADAPTER_VERSION,
          clientVersion: probe.report.clientVersion,
          capabilityStatus: probe.report.status,
          reasonCode: (probe.report.detail as { reason_code?: unknown }).reason_code ?? null,
          storedSnapshots,
        },
      });

      return {
        integration: updated,
        probeExecuted: true,
        adapter: { id: CODEX_ADAPTER_ID, version: CODEX_ADAPTER_VERSION },
        capabilityStatus: probe.report.status,
        clientVersion: probe.report.clientVersion,
        evidence: probe.report.evidence,
        quotaBucketsFound: probe.quotaSnapshots.length,
        storedSnapshots,
        warnings: [...probe.warnings, ...store.warnings],
        note: probe.report.status === 'verified' ? '已实测通过，证据已写入连接记录。' : probe.report.notes,
      };
    }

    const updated = recordProbe(app.db, id, {
      capabilityStatus: 'unknown',
      note:
        (input.note ?? '').trim() ||
        '这条连接还没有实现探测适配器。此处只登记「尚未验证」，不把状态改成 verified，也不凭空设计供应商接口。',
      evidence: null,
    });

    audit(ctx, {
      action: 'integration.probe',
      entityType: 'integration',
      entityId: id,
      result: 'rejected',
      detail: { reason: 'no_adapter_for_integration' },
    });

    return {
      integration: updated,
      probeExecuted: false,
      capabilityStatus: 'unknown',
      note:
        '这条连接还没有探测适配器（M1 只实现了 Codex 用量接口）。本接口记录「本次未验证」这一事实，' +
        '不会把能力状态改成「已验证」—— 因为那会让界面显示一个我们没有证据的结论。',
    };
  });

  /* ---------------- 凭据 ---------------- */

  fastify.get('/api/credentials', async (request) => {
    requireUser(request, '凭据管理');
    const q = z.object({ clientId: z.string().max(64).optional() }).parse(request.query ?? {});
    return { credentials: listCredentials(app.db, q.clientId) };
  });

  fastify.post('/api/credentials', async (request) => {
    requireUser(request, '凭据管理');
    const input = zCreateCredential.parse(request.body ?? {});
    const client = getClient(app.db, input.clientId);
    if (!client) throw new ApiError(404, 'not_found', `客户端不存在：${input.clientId}`);

    const token = newToken();
    const id = newId('credential');
    insertCredential(app.db, {
      id,
      clientId: input.clientId,
      label: input.label,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      tokenPrefix: token.slice(0, 8),
      projectIds: input.projectIds,
      scopes: input.scopes,
    });

    audit(ctx, {
      action: 'credential.create',
      entityType: 'api_credential',
      entityId: id,
      detail: { clientId: input.clientId, scopes: input.scopes, projectIds: input.projectIds },
    });

    return {
      id,
      token,
      note: '这是唯一一次显示完整凭据，服务端只保存哈希。该凭据在类型层面就无法调用审批、删除、连接管理或备份恢复。',
      scopes: input.scopes,
      projectIds: input.projectIds,
    };
  });

  fastify.post('/api/credentials/:id/revoke', async (request) => {
    requireUser(request, '凭据管理');
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    const revoked = revokeCredential(app.db, id);
    if (!revoked) throw new ApiError(404, 'not_found', `凭据不存在：${id}`);
    audit(ctx, { action: 'credential.revoke', entityType: 'api_credential', entityId: id });
    return { ok: true, credential: revoked };
  });

  /* ---------------- 工作区摘要 ---------------- */

  fastify.get('/api/workspace/summary', async (request) => {
    requirePrincipal(request);
    return {
      clients: listClients(app.db),
      integrations: listIntegrations(app.db, workspaceOf(request)),
      demo: demoStatus(ctx),
      counts: databaseCounts(app.db, false),
    };
  });
}

function pairOrThrow(
  sessions: SessionStore,
  code: string,
  label: string,
  ctx: ServiceContext,
): { token: string; expiresAt: string } {
  const result = sessions.pair(code, label);
  if (result.ok) return { token: result.token, expiresAt: result.expiresAt };

  // 配对失败要留痕：连续失败是「有东西在猜配对码」的唯一可观测信号。
  const reason = result.reason === 'rate_limited' ? 'pairing_rate_limited' : 'pairing_bad_code';
  audit(ctx, {
    actor: '匿名请求',
    action: 'auth.reject',
    entityType: 'session',
    entityId: 'local',
    result: 'rejected',
    detail: { reason, label, codeLength: code.trim().length },
  });

  if (result.reason === 'rate_limited') {
    throw new ApiError(
      429,
      'rate_limited',
      `配对尝试过于频繁，请在 ${Math.ceil((result.retryAfterMs ?? 0) / 1000)} 秒后重试。`,
    );
  }
  throw new ApiError(
    401,
    'bad_pairing_code',
    `配对码不正确。${result.remaining !== undefined ? `还可尝试 ${result.remaining} 次。` : ''}`,
  );
}
