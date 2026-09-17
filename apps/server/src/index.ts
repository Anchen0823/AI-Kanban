/**
 * 服务入口。
 *
 * 启动顺序刻意如此：先断言绑定地址是回环地址（拒绝把本地服务暴露到局域网），
 * 再确认端口可用，然后打开数据库并跑迁移，最后才监听并打印配对码 ——
 * 每一步都保证「失败时不会留下半开的资源」。
 *
 * 端口检查放在开库之前是有意的：端口被占是最常见的一类启动失败，而它跟数据库
 * 毫无关系。先探端口，用户就不用为一个必然会失败的启动白白等一轮迁移。
 */

import { assertLoopbackHost, loadConfig } from './config.js';
import { createApp } from './app.js';
import { SessionStore } from './http/auth.js';
import { buildServer } from './http/server.js';
import { DEFAULTS } from './config.js';
import { setSetting, getSetting } from './db/repos/system.js';
import { PortInUseError, assertPortAvailable, portInUseHint } from './net/port.js';

/** 供顶层错误处理使用：启动过程中已经拿到的资源要能在这里释放。 */
let openedApp: ReturnType<typeof createApp> | null = null;
let activeConfig: ReturnType<typeof loadConfig> | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  activeConfig = config;
  assertLoopbackHost(config.host);
  await assertPortAvailable(config.host, config.port);

  const app = createApp(config);
  openedApp = app;
  const info = app.bootstrap();

  // 把「导入上限」等安全参数固化进设置，让界面能如实展示当前生效值
  if (!getSetting(app.db, 'maxImportBytes')) setSetting(app.db, 'maxImportBytes', String(DEFAULTS.maxImportBytes));
  if (!getSetting(app.db, 'maxImportRows')) setSetting(app.db, 'maxImportRows', String(DEFAULTS.maxImportRows));

  const sessions = new SessionStore();
  const fastify = buildServer({ app, sessions, config });

  const address = await fastify.listen({ host: config.host, port: config.port });

  printBanner(address, config, info, sessions.code);

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n收到 ${signal}，正在关闭…\n`);
    try {
      await fastify.close();
      app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function printBanner(
  address: string,
  config: ReturnType<typeof loadConfig>,
  info: ReturnType<ReturnType<typeof createApp>['bootstrap']>,
  pairingCode: string,
): void {
  const c = {
    dim: '\u001b[2m',
    bold: '\u001b[1m',
    green: '\u001b[32m',
    yellow: '\u001b[33m',
    cyan: '\u001b[36m',
    reset: '\u001b[0m',
  };
  const lines = [
    '',
    `${c.bold}AI Control Center${c.reset} ${c.dim}M1 · 本地单用户闭环${c.reset}`,
    '',
    `  ${c.dim}地址${c.reset}      ${address}`,
    `  ${c.dim}数据库${c.reset}    ${info.dbFile}`,
    `  ${c.dim}驱动${c.reset}      ${info.driver}${info.migrationsApplied.length > 0 ? `（本次应用迁移 v${info.migrationsApplied.join(', v')}）` : '（schema 已是最新）'}`,
    `  ${c.dim}数据目录${c.reset}  ${info.dataDir}`,
    `  ${c.dim}备份目录${c.reset}  ${config.backupDir}`,
    `  ${c.dim}允许来源${c.reset}  ${config.allowedOrigins.join('、')}`,
    '',
    `${c.yellow}${c.bold}  配对码：${pairingCode}${c.reset}`,
    `  ${c.dim}在浏览器打开界面后输入这个码。它是一次性的，配对成功后会自动更换。${c.reset}`,
    '',
    `${c.dim}本版本已实现：登记 / 用量导入与去重 / 额度快照 / 记忆候选审核与版本 / 上下文包 / 备份恢复${c.reset}`,
    `${c.dim}本版本已实现：本地 MCP 传输层（六个工具）、Codex 用量只读探测${c.reset}`,
    `${c.dim}本版本未实现：真实客户端联调、Cursor 探测、ChatGPT 导出包解析、内置 AI 提炼（M1 剩余 / M2）${c.reset}`,
    '',
    `${c.cyan}提示：界面上「官方文档描述支持」与「本机已验证」是两种不同状态，不会混为一谈。${c.reset}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * 把「端口被占」从各种可能的抛出点归一到一个类型。
 *
 * 预检已经挡掉了绝大多数情况，但预检释放端口到 `fastify.listen()` 真正绑定之间
 * 存在一个极短的空窗（另一个进程可能恰好在这个瞬间抢进去）。这里作为兜底，
 * 保证用户看到的仍是同一个可读提示，而不是 `listen EADDRINUSE` 堆栈。
 */
function asPortInUse(err: unknown): PortInUseError | null {
  if (err instanceof PortInUseError) return err;
  if (err !== null && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    return new PortInUseError(activeConfig?.host ?? '127.0.0.1', activeConfig?.port ?? 8787);
  }
  return null;
}

main().catch((err: unknown) => {
  const portIssue = asPortInUse(err);
  if (portIssue) {
    process.stderr.write(portInUseHint(portIssue.host, portIssue.port));
  } else {
    process.stderr.write(`\n启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }

  try {
    // 已打开的数据库要关掉，否则 WAL 文件会留在磁盘上，下一次启动看不到原因。
    openedApp?.close();
  } catch {
    // 关闭本身失败时不要让原始错误被覆盖
  }

  process.exit(1);
});
