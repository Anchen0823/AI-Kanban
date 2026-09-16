import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { PortInUseError, assertPortAvailable, portInUseHint } from '../src/net/port.js';

/**
 * 启动期的端口检查。
 *
 * 这条路径原先没有任何测试，代价是用户自己撞了一次 `EADDRINUSE` 才发现
 * 提示语不可用。端口检查的价值几乎全在「端口确实被占」这一支，
 * 所以两个方向都要测：空闲时要放行，被占时要给出可执行的提示。
 */

/** 占住一个由系统分配的端口，返回端口号和关闭函数。 */
function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('没能取得监听端口'));
        return;
      }
      resolve({
        port: address.port,
        release: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('端口空闲时放行（不误报）', async () => {
  // 先拿一个端口再立刻释放，得到一个「刚刚还活着」的端口号。
  const { port, release } = await occupyPort();
  await release();

  // 这里必须真的通过：如果探测逻辑把「曾经被占用」也判成占用，
  // 表现就是服务永远起不来，而且原因极难看出来。
  await assert.doesNotReject(() => assertPortAvailable('127.0.0.1', port));
});

test('端口被占用时抛出 PortInUseError，且带出 host 与 port', async () => {
  const { port, release } = await occupyPort();
  try {
    await assert.rejects(
      () => assertPortAvailable('127.0.0.1', port),
      (err: unknown) => {
        assert.ok(err instanceof PortInUseError, `期望 PortInUseError，实际是 ${String(err)}`);
        assert.equal(err.code, 'port_in_use');
        assert.equal(err.port, port);
        assert.equal(err.host, '127.0.0.1');
        return true;
      },
    );
  } finally {
    await release();
  }
});

test('占用提示里包含端口号和可复制的排查命令', () => {
  const hint = portInUseHint('127.0.0.1', 8787);

  assert.match(hint, /8787/, '要写出到底是哪个端口');
  assert.match(hint, /netstat|findstr|lsof/, '要给出「谁占着端口」的查询命令');
  assert.match(hint, /AICC_PORT/, '要给出换端口的办法');
  assert.match(hint, /taskkill|kill/, '要给出结束进程的命令');
  // 只报错不给办法等于把问题丢回给用户，所以提示必须够长到包含步骤
  assert.ok(hint.split('\n').length >= 10, '提示应包含分步骤的排查指引');
});

test('探测完成后不会自己变成占用者', async () => {
  const { port, release } = await occupyPort();
  await release();

  await assertPortAvailable('127.0.0.1', port);
  // 再探一次：如果上一次探测没有释放监听 socket，这一次会失败。
  await assertPortAvailable('127.0.0.1', port);
});
