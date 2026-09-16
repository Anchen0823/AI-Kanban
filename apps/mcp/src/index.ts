#!/usr/bin/env node
/**
 * 本地 MCP 服务的入口。
 *
 * 配置全部通过环境变量，因为 MCP 客户端的配置格式就是「命令 + 参数 + 环境变量」：
 *
 *   AICC_API_URL  工作台地址，默认 http://127.0.0.1:8787
 *   AICC_TOKEN    工作台签发的代理凭据（**不要写进仓库**）
 *
 * 刻意不做的事：
 * - 不读 SQLite。§9.2：MCP 进程只是代理，数据权威只有服务端一个。
 * - 不打印 token，连前几位都不打印。MCP 客户端的日志经常被贴到 issue 里。
 * - 缺少 token 时**仍然启动**：客户端至少能列出工具、看到明确的原因，
 *   比一个「启动失败」更容易让人查明白。真正的失败信息在每次调用时给出。
 */

import process from 'node:process';
import { Backend } from './backend.js';
import { serveStdio } from './server.js';

const DEFAULT_API_URL = 'http://127.0.0.1:8787';

function main(): void {
  const baseUrl = (process.env.AICC_API_URL ?? '').trim() || DEFAULT_API_URL;
  const rawToken = (process.env.AICC_TOKEN ?? '').trim();
  const backend = new Backend({ baseUrl, token: rawToken.length > 0 ? rawToken : null });

  process.stderr.write(
    [
      '',
      'AI Control Center · 本地 MCP 服务（stdio）',
      `  工作台地址  ${backend.url}${backend.url === DEFAULT_API_URL ? '（默认）' : ''}`,
      `  凭据        ${backend.hasToken ? '已配置' : '未配置 AICC_TOKEN'}`,
      '  传输        stdio（本进程的 stdout 是协议通道，日志走 stderr）',
      '',
    ].join('\n'),
  );

  void serveStdio(backend).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`\n[aicc-mcp] 退出：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}

main();
