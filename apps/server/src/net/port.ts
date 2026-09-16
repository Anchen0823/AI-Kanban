/**
 * 启动前的端口可用性检查。
 *
 * 为什么要在监听之前单独探一次，而不是直接用 `fastify.listen()` 的报错：
 *
 * 1. **顺序**。原来的流程是「开数据库 → 跑迁移 → 再监听」。端口被占时，
 *    用户已经白白等了一轮迁移，看到的却是 `listen EADDRINUSE` 堆栈。
 * 2. **可行动性**。`EADDRINUSE` 只说「地址被占用」，不说「怎么办」。
 *    本地单用户场景下最可能的原因就是「上一个实例还开着」，而用户往往
 *    是把终端关了以为进程就没了 —— 这在 Windows 上尤其常见。
 *
 * 刻意**不做**的事：自动改端口重试。配对码与 Origin 白名单都绑定在
 * 配置的端口上，静默换端口会让用户打开一个错误的地址。宁可响亮地失败。
 */

import { createServer } from 'node:net';

/** 端口被占用。单独一个类型，便于入口区分「可预期的失败」与真正的崩溃。 */
export class PortInUseError extends Error {
  readonly code = 'port_in_use';

  constructor(
    readonly host: string,
    readonly port: number,
  ) {
    super(`端口 ${port} 已被占用：${host}:${port}`);
    this.name = 'PortInUseError';
  }
}

/**
 * 探测端口能否被独占绑定。
 *
 * 用 `exclusive: true` 而不是 `SO_REUSEADDR`：我们要的就是「这个端口现在
 * 归我一个人」这个事实，允许复用等于把检查做成心理安慰。
 */
export function assertPortAvailable(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new PortInUseError(host, port));
        return;
      }
      if (err.code === 'EACCES') {
        reject(new Error(`没有权限绑定端口 ${port}。请换一个大于 1024 的端口（AICC_PORT=8788）。`));
        return;
      }
      reject(err);
    });

    probe.once('listening', () => {
      // 探完立刻释放，避免自己成为占用者
      probe.close(() => resolve());
    });

    probe.listen({ host, port, exclusive: true });
  });
}

/** 端口被占用时给用户的提示。按平台给出实际能复制粘贴的命令。 */
export function portInUseHint(host: string, port: number): string {
  const isWindows = process.platform === 'win32';
  const findCmd = isWindows
    ? `netstat -ano | findstr :${port}`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
  const killCmd = isWindows
    ? 'taskkill /PID <上面最后一列的 PID> /F'
    : 'kill <上面第二列的 PID>';

  return [
    '',
    `启动失败：端口 ${port} 已被占用（${host}:${port}）。`,
    '',
    '最常见的原因是上一个实例还在运行 —— 关掉终端窗口并不会结束进程。',
    '',
    '  1) 查出是哪个进程占着这个端口：',
    `       ${findCmd}`,
    '',
    '  2) 确认那确实是自己开的服务后，结束它：',
    `       ${killCmd}`,
    '',
    '  3) 或者换一个端口启动（配对码与允许来源都跟着新端口走）：',
    isWindows ? `       $env:AICC_PORT=8788; npm start` : `       AICC_PORT=8788 npm start`,
    '',
    '如果查到的进程不是 node，而是 Docker / WSL / 其他软件，那说明它先占了这个端口，',
    '换端口比结束它更省事。',
    '',
  ].join('\n');
}
