/**
 * 到 `codex app-server` 的只读传输层（§3.2）。
 *
 * 只做四件事：启动官方组件、握手、发只读请求、关掉。**没有任何写操作** ——
 * 不调用充值、不重置额度、不发邮件（§3.2 明确禁止）。
 *
 * 协议形状不是猜的：方法名与返回结构取自本机 `codex app-server generate-json-schema`
 * 导出的定义（本地实测 codex-cli 0.130.0）。这一点很关键 —— 设计稿 §3.2 提到的
 * `account/usage/read` 在 0.130.0 里**根本不存在**，它的反面也写在启动失败时的
 * 方法枚举里。所以探测必须能区分「方法不支持」与「这次没能判定」。
 *
 * 进程生命周期上刻意保守：无论成功失败都 kill 掉子进程。MCP/采集进程泄漏
 * 在这类本地工具里非常难被发现 —— 用户只会觉得机器越来越慢。
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface CodexNotification {
  method: string;
  params: unknown;
}

export interface AppServerHandshake {
  /** initialize 的返回：codexHome / platformFamily / platformOs / userAgent。 */
  serverInfo: Record<string, unknown>;
  /** 服务端在握手中主动推来的通知（例如配置警告）。 */
  notifications: CodexNotification[];
}

export type CallOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; kind: 'method_not_supported'; message: string }
  | { ok: false; kind: 'rpc_error'; code: number; message: string }
  | { ok: false; kind: 'timeout'; message: string };

export interface CodexAppServerOptions {
  /** 可执行文件，默认 codex。 */
  command?: string;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 启动 + 握手的总超时（毫秒）。 */
  startupTimeoutMs?: number;
  /** 额外环境变量。 */
  env?: Record<string, string>;
  /**
   * 启动方式。默认直接 spawn 配置的命令；测试里换成一个「真子进程 + 真管道，
   * 但用假的可执行文件」的版本 —— 打桩函数会把要测的 stdio 分帧一起删掉。
   */
  spawnImpl?: typeof spawn;
}

export class CodexAppServer {
  private readonly child: ChildProcess;
  private buffer = '';
  private stderrText = '';
  private nextId = 1;
  private readonly pending = new Map<number, (value: { result?: unknown; error?: { code: number; message: string } }) => void>();
  private readonly notifications: CodexNotification[] = [];
  private closed = false;
  private readonly timeoutMs: number;

  private constructor(child: ChildProcess, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;

    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length === 0) continue;
        let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
        try {
          message = JSON.parse(line);
        } catch {
          // 非协议输出不致命，但它是排查时最有用的线索，留在 stderr 汇总里。
          this.stderrText += `[非 JSON 输出] ${line.slice(0, 200)}\n`;
          continue;
        }
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          const settle = this.pending.get(message.id) as (v: { result?: unknown; error?: { code: number; message: string } }) => void;
          this.pending.delete(message.id);
          settle(message);
          continue;
        }
        if (typeof message.method === 'string') {
          this.notifications.push({ method: message.method, params: message.params });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      // 只留最后一部分：app-server 在配置有问题时会重复刷同一条日志。
      this.stderrText += chunk.toString();
      if (this.stderrText.length > 8000) this.stderrText = this.stderrText.slice(-6000);
    });
  }

  get stderr(): string {
    return this.stderrText;
  }

  /** 握手中收到的通知，包含配置警告 —— 这些是要写进证据里的。 */
  get handshakeNotifications(): CodexNotification[] {
    return this.notifications;
  }

  static start(options: CodexAppServerOptions = {}): CodexAppServer {
    const command = options.command ?? 'codex';
    const spawnFn = options.spawnImpl ?? spawn;
    const child = spawnFn(command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上 codex 是 .cmd 包装，必须走 shell 才能启动。
      // 参数是常量字面量，没有注入面。测试注入的 spawnImpl 会自己关掉它。
      shell: options.spawnImpl ? false : process.platform === 'win32',
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return new CodexAppServer(child, options.timeoutMs ?? 12_000);
  }

  /**
   * 握手：`initialize` + 客户端主动发的 `initialized` 通知。
   *
   * 注意 codex 的 initialize 参数是 `clientInfo`（规范里叫这个名字），
   * 而它的返回直接是 serverInfo 形状，没有再包一层。
   */
  async initialize(startupTimeoutMs = 20_000): Promise<AppServerHandshake> {
    const outcome = await this.call<Record<string, unknown>>(
      'initialize',
      {
        clientInfo: { name: 'ai-control-center', title: 'AI Control Center 只读探测', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      },
      startupTimeoutMs,
    );
    if (!outcome.ok) {
      throw new Error(`codex app-server 握手失败：${outcome.message}`);
    }
    return { serverInfo: outcome.result, notifications: [...this.notifications] };
  }

  async call<T>(method: string, params: unknown = {}, timeoutOverride?: number): Promise<CallOutcome<T>> {
    if (this.closed) {
      return { ok: false, kind: 'rpc_error', code: 0, message: '进程已关闭' };
    }
    const id = this.nextId++;
    const timeout = timeoutOverride ?? this.timeoutMs;

    const raw = await new Promise<{ result?: unknown; error?: { code: number; message: string } } | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve('timeout');
      }, timeout);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      try {
        this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { code: 0, message: `无法写入 app-server：${(err as Error).message}` } });
      }
    });

    if (raw === 'timeout') {
      return { ok: false, kind: 'timeout', message: `${method} 在 ${timeout} 毫秒内没有响应` };
    }
    if (raw.error) {
      // codex 用 -32600 表达「不认识这个方法」，并把全部合法方法名列在 message 里。
      // 这是「不支持」与「出错了」的分界线 —— 必须分开处理，否则会把环境问题
      // 误报成「该版本不支持」。
      const notSupported = raw.error.code === -32600 && /unknown variant|unknown method|not found/i.test(raw.error.message);
      return notSupported
        ? { ok: false, kind: 'method_not_supported', message: raw.error.message }
        : { ok: false, kind: 'rpc_error', code: raw.error.code, message: raw.error.message };
    }
    return { ok: true, result: raw.result as T };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const settle of this.pending.values()) {
      settle({ error: { code: 0, message: '进程已关闭' } });
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      // 已经退出就无所谓
    }
  }
}

/** 从 RPC 错误信息里抠出该版本支持的方法名列表，作为「不支持」的证据。 */
export function extractMethodList(message: string): string[] {
  const match = message.match(/expected one of ((?:`[^`]+`(?:, )?)+)/);
  if (!match || !match[1]) return [];
  return [...match[1].matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/** `codex --version`。拿不到就返回 null —— 版本是证据的一部分，不能编。 */
export async function readCodexVersion(
  command = 'codex',
  timeoutMs = 15_000,
  spawnImpl?: typeof spawn,
): Promise<string | null> {
  const spawnFn = spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const child = spawnFn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: spawnImpl ? false : process.platform === 'win32',
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const trimmed = out.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}
