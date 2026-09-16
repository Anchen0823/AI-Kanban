/**
 * MCP 进程到本地工作台 HTTP API 的适配层。
 *
 * §9.2 明确要求：**每个客户端的 stdio MCP 进程只是代理，不各自持有一个
 * 可独立写入的主数据库。** 所以这里不做任何本地存储，也不 import 任何仓储代码 ——
 * 所有读写都经过已经定义了权限边界的那套 HTTP 接口。
 *
 * 这样带来两个直接好处：
 * 1. 权限校验只有一处实现，不存在「MCP 路径比 HTTP 路径宽松」的可能。
 * 2. MCP 进程崩了、被卸载、被换成别的语言重写，都不影响数据。
 */

export interface BackendError {
  ok: false;
  /** HTTP 状态码；本地连接失败时为 0。 */
  status: number;
  code: string;
  message: string;
  details?: unknown;
  /** 给调用方（也就是模型）的下一步动作建议。 */
  hint?: string;
}

export type BackendResult<T> = { ok: true; data: T } | BackendError;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface BackendOptions {
  baseUrl: string;
  token: string | null;
  timeoutMs?: number;
  /** 便于测试注入。 */
  fetchImpl?: typeof fetch;
}

export class Backend {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  get hasToken(): boolean {
    return this.token !== null && this.token.length > 0;
  }

  async call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'POST' }): Promise<BackendResult<T>> {
    if (!this.hasToken) {
      return {
        ok: false,
        status: 0,
        code: 'token_missing',
        message: '没有配置凭据，无法访问工作台。',
        hint:
          '这个 MCP 服务需要一份工作台签发的代理凭据。在「设置与连接 → 代理凭据」里签发一个，' +
          '然后把 token 写进 MCP 客户端配置的 env.AICC_TOKEN。凭据是绑定客户端与项目范围的。',
      };
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token as string}`,
      accept: 'application/json',
      /**
       * 服务端要求**所有写方法**都带这个头，Bearer 凭据也不例外。
       *
       * 看起来多余：这是个非浏览器进程，CSRF 与它无关。但服务端那条规则是
       * 「凡写必带」，没有例外 —— 为了少数客户端开一个口子，就等于让「为什么
       * 这条可以不带」变成一个需要每次重新推理的问题。带上它的成本是零。
       *
       * 漏掉它会拿到 403 origin_rejected，而报错文案写的是「防止恶意网页调用本地写接口」，
       * 第一次联调时非常容易误判成权限配置错误。
       */
      'x-aicc-request': '1',
    };
    if (init.method === 'POST') headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.method === 'POST' ? { body: JSON.stringify(init.body ?? {}) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string }; name?: string }).cause?.code ?? (err as Error).name;
      const timeout = cause === 'TimeoutError' || (err as Error).name === 'TimeoutError';
      return {
        ok: false,
        status: 0,
        code: timeout ? 'backend_timeout' : 'backend_unreachable',
        message: timeout
          ? `工作台在 ${this.timeoutMs} 毫秒内没有响应（${this.baseUrl}）。`
          : `连接不上工作台服务（${this.baseUrl}）。${
              cause === 'ECONNREFUSED' ? '这个地址上没有进程在监听。' : String(cause ?? '')
            }`,
        hint: timeout
          ? '工作台可能正在处理一个大任务。不要重试到超时为止 —— 先告诉用户这次检索没有结果，而不是假装检索成功。'
          : '工作台服务需要先启动：在仓库根目录运行 npm start，它会打印配对码和实际监听地址。',
      };
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: response.status,
          code: 'backend_bad_response',
          message: `工作台返回了非 JSON 响应（HTTP ${response.status}）。`,
          details: text.slice(0, 400),
          hint: '这通常说明把 MCP 指向了错误的地址（比如指向了前端开发服务器而不是 API）。',
        };
      }
    }

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      return {
        ok: false,
        status: response.status,
        code: error?.code ?? `http_${response.status}`,
        message: error?.message ?? `工作台拒绝了这次调用（HTTP ${response.status}）。`,
        ...(error?.details === undefined ? {} : { details: error.details }),
        hint: hintForStatus(response.status, error?.code),
      };
    }

    return { ok: true, data: parsed as T };
  }
}

/**
 * 把状态码翻译成「下一步该做什么」。
 *
 * 这一段是给**模型**读的，不是给人读的。模型拿到 403 时最常见的错误反应是
 * 换个说法重试一次，所以必须明确写「不要重试、去告诉用户」。
 */
function hintForStatus(status: number, code: string | undefined): string {
  if (code === 'origin_rejected') {
    return (
      '这是服务端的外层请求守卫拦下的，不是权限配置问题。最可能的两种原因：' +
      'Host 头不是回环地址（AICC_API_URL 指向了非 127.0.0.1），或工作台版本早于 M1 ' +
      '（那时候代理接口还没有豁免逻辑）。检查 AICC_API_URL 是不是 http://127.0.0.1:<端口>。'
    );
  }
  if (status === 401) {
    return '凭据无效或已被撤销。不要重试 —— 让用户到「设置与连接 → 代理凭据」检查。';
  }
  if (status === 403) {
    return (
      `当前凭据没有这个权限或不在授权项目范围内（${code ?? 'forbidden'}）。` +
      '不要换参数重试同一件事 —— 这是授权边界，不是用法问题。请把拒绝原因如实告诉用户。'
    );
  }
  if (status === 404) return '目标不存在。确认 memory_id / project_id 是不是用户明确给过的那个。';
  if (status === 409) return '发生了版本冲突或状态冲突。把服务端返回的 currentVersion 告诉用户，让他决定怎么处理。';
  if (status === 413) return '内容太大。请缩小到关键部分再提交。';
  if (status === 422) return '内容没有通过校验。按 message 里的原因修正后重试。';
  if (status >= 500) return '工作台内部错误。不要假装成功；如实告诉用户这次调用失败了。';
  return '按 message 的内容处理。';
}
