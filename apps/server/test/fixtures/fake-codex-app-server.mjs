/**
 * 假的 codex app-server，用于让探测器的四种结论分支都可重复验证。
 *
 * 为什么需要一个独立的可执行文件而不是打桩函数：这里的被测对象横跨
 * 「spawn 子进程」这件事本身，打桩会把要测的那一段（stdio 分帧、退出码、
 * 协议错误码）一起删掉。用一个真实子进程 + 真实管道，只有在行为上造假。
 *
 * 通过 FAKE_CODEX_MODE 控制行为：
 *   ok                    —— 全部正常，rateLimits 返回两个窗口
 *   empty-windows         —— 调用成功但没有任何窗口
 *   no-rate-limits-method —— rateLimits 不在合法方法枚举里
 *   call-fails            —— rateLimits 调用失败（模拟网络/登录问题）
 *   no-version            —— --version 不输出任何东西
 */

const MODE = process.env.FAKE_CODEX_MODE ?? 'ok';

const LEGAL_METHODS = [
  'initialize',
  'thread/start',
  'thread/list',
  'account/read',
  'account/rateLimits/read',
  'mcpServerStatus/list',
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (process.argv.includes('--version')) {
  if (MODE === 'no-version') {
    process.exit(0);
  }
  process.stdout.write('codex-cli 0.130.0-fake\n');
  process.exit(0);
}

if (process.argv.includes('app-server')) {
  // 握手时先推一条配置警告，探测器应当把它写进证据而不是吞掉。
  send({
    jsonrpc: '2.0',
    method: 'configWarning',
    params: { summary: 'Invalid configuration; using defaults.', path: 'C:\\fake\\config.toml' },
  });

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;

      const message = JSON.parse(line);
      const { id, method, params } = message;

      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            userAgent: 'fake-codex/0.130.0',
            codexHome: 'C:\\fake\\.codex',
            platformFamily: 'windows',
            platformOs: 'windows',
          },
        });
        continue;
      }

      if (method === 'account/read') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            account: { type: 'chatgpt', email: 'someone@example.com', planType: 'prolite' },
            requiresOpenaiAuth: true,
          },
        });
        continue;
      }

      if (method === 'account/usage/read') {
        // 在真实 0.130.0 上就是这个形状：方法不在枚举里，报错同时列出全部合法方法。
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32600,
            message: `Invalid request: unknown variant \`account/usage/read\`, expected one of ${LEGAL_METHODS.map(
              (m) => `\`${m}\``,
            ).join(', ')}`,
          },
        });
        continue;
      }

      if (method === 'account/rateLimits/read') {
        if (MODE === 'no-rate-limits-method') {
          send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32600,
              message: `Invalid request: unknown variant \`account/rateLimits/read\`, expected one of ${LEGAL_METHODS.filter(
                (m) => m !== 'account/rateLimits/read',
              )
                .map((m) => `\`${m}\``)
                .join(', ')}`,
            },
          });
          continue;
        }
        if (MODE === 'call-fails') {
          send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: 'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)',
            },
          });
          continue;
        }
        if (MODE === 'empty-windows') {
          send({ jsonrpc: '2.0', id, result: { rateLimits: { limitId: 'codex', planType: 'prolite' } } });
          continue;
        }
        send({
          jsonrpc: '2.0',
          id,
          result: {
            rateLimits: {
              limitId: 'codex',
              limitName: 'Codex',
              planType: 'prolite',
              primary: { usedPercent: 42, resetsAt: 1790000000, windowDurationMins: 300 },
              secondary: { usedPercent: 8, resetsAt: 1790500000, windowDurationMins: 10080 },
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: 'codex',
                limitName: 'Codex',
                planType: 'prolite',
                primary: { usedPercent: 42, resetsAt: 1790000000, windowDurationMins: 300 },
                secondary: { usedPercent: 8, resetsAt: 1790500000, windowDurationMins: 10080 },
              },
              code_review: {
                limitId: 'code_review',
                limitName: 'Code Review',
                primary: { usedPercent: 100, resetsAt: 1790000000, windowDurationMins: 1440 },
              },
            },
          },
        });
        continue;
      }

      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: `Invalid request: unknown variant \`${method}\`, expected one of ${LEGAL_METHODS.map((m) => `\`${m}\``).join(', ')}`,
        },
      });
    }
  });
  // keepalive：等父进程关掉 stdin 之后自己退出。
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
}
