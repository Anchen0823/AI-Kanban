import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertLoopbackHost, REPO_ROOT } from '../config.js';

/** Only inspect our own runtime. Generating a config does not probe or change a client. */
export function describeMcpSetup(
  address: { host: string; port: number },
  runtime = { repoRoot: REPO_ROOT, nodeExecutable: process.execPath },
) {
  assertLoopbackHost(address.host);
  const entry = join(runtime.repoRoot, 'apps', 'mcp', 'dist', 'index.js');
  const host = address.host === '::1' ? '[::1]' : address.host;
  return {
    command: runtime.nodeExecutable,
    args: [entry],
    apiUrl: `http://${host}:${address.port}`,
    built: existsSync(entry) && statSync(entry).isFile(),
    transport: 'stdio' as const,
    clientVerified: false as const,
    note: '配置生成不代表客户端已连接。保持工作台运行，在客户端重载后实际调用工具完成验证。',
  };
}
