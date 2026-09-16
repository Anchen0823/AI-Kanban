/**
 * 服务入口。
 *
 * 启动顺序刻意如此：先断言绑定地址是回环地址（拒绝把本地服务暴露到局域网），
 * 再打开数据库并跑迁移，然后打印配对码 —— 因为配对码是访问界面的唯一入口，
 * 必须在 http 开始监听之前就让用户看得到。
 */

import { assertLoopbackHost, loadConfig } from './config.js';
import { createApp } from './app.js';
import { SessionStore } from './http/auth.js';
import { buildServer } from './http/server.js';
import { DEFAULTS } from './config.js';
import { setSetting, getSetting } from './db/repos/system.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertLoopbackHost(config.host);

  const app = createApp(config);
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
    `${c.bold}AI Control Center${c.reset} ${c.dim}M0 · 本地单用户闭环${c.reset}`,
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
    `${c.dim}本版本未实现：本地 MCP 传输层、外部接口探测、ChatGPT 导出包解析、内置 AI 提炼（对应 M1 / M2）${c.reset}`,
    '',
    `${c.cyan}提示：界面上「官方文档描述支持」与「本机已验证」是两种不同状态，不会混为一谈。${c.reset}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
