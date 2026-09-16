/**
 * 测试脚手架。
 *
 * 每个用例都在**独立的临时数据目录**里跑一套完整服务：真实 SQLite 文件、真实迁移、
 * 真实 HTTP 路由（用 Fastify 的 inject，不占端口）。不 mock 数据库 —— 因为本项目
 * 最容易出错的地方恰恰是 SQL 约束、事务边界与幂等键，mock 掉它们等于把要测的东西删了。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import { DEFAULTS } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { SessionStore } from '../src/http/auth.js';
import { buildServer } from '../src/http/server.js';

export interface TestHarness {
  app: App;
  fastify: FastifyInstance;
  config: AppConfig;
  dir: string;
  sessions: SessionStore;
  cookie: string;
  /** 带 Cookie 与 CSRF 头调用 API。 */
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    options?: { cookie?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
  /** 不带任何身份调用 API（但仍会带上 CSRF 头，测试「有 CSRF 但无身份」这一层）。 */
  anonymous<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
  /**
   * 完全原样的请求：不加 Cookie、不加 CSRF 头。
   * 用于模拟「恶意网页发起的跨站请求」—— 它既没有会话，也带不上自定义头。
   */
  raw<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
  close(): void;
}

export function testConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    backupDir: join(dir, 'backups'),
    dbFile: join(dir, 'test.sqlite'),
    exportDir: join(dir, 'exports'),
    displayTimezone: 'Asia/Shanghai',
    allowedOrigins: [],
    webDistDir: join(dir, 'web-dist-missing'),
    quotaStaleSeconds: DEFAULTS.quotaStaleSeconds,
    maxBodyBytes: DEFAULTS.maxBodyBytes,
    maxImportBytes: DEFAULTS.maxImportBytes,
    maxImportRows: DEFAULTS.maxImportRows,
    ...overrides,
  };
}

export async function createHarness(options: { config?: Partial<AppConfig> } = {}): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'aicc-test-'));
  const config = testConfig(dir, options.config ?? {});
  const app = createApp(config);
  app.bootstrap();

  const sessions = new SessionStore();
  const fastify = buildServer({ app, sessions, config });
  await fastify.ready();

  const pairing = await fastify.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-aicc-request': '1' },
    payload: { code: sessions.code, label: '测试会话' },
  });

  if (pairing.statusCode !== 200) {
    throw new Error(`测试脚手架配对失败：${pairing.statusCode} ${pairing.body}`);
  }
  const setCookie = pairing.headers['set-cookie'];
  const rawCookie = Array.isArray(setCookie) ? (setCookie[0] as string) : String(setCookie ?? '');
  const cookie = rawCookie.split(';')[0] as string;

  const call = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload: unknown,
    useCookie: string | null,
    extraHeaders: Record<string, string> = {},
    autoCsrfHeader = true,
  ): Promise<{ status: number; body: T; headers: Record<string, unknown> }> => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (method !== 'GET' && autoCsrfHeader) headers['x-aicc-request'] = '1';
    if (useCookie) headers.cookie = useCookie;

    const response = await fastify.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

    let body: unknown;
    try {
      body = response.body.length > 0 ? JSON.parse(response.body) : null;
    } catch {
      body = response.body;
    }

    return {
      status: response.statusCode,
      body: body as T,
      headers: response.headers as Record<string, unknown>,
    };
  };

  return {
    app,
    fastify,
    config,
    dir,
    sessions,
    cookie,
    request: (method, url, payload, opts) =>
      call(method, url, payload, opts?.cookie === undefined ? cookie : opts.cookie, opts?.headers ?? {}),
    anonymous: (method, url, payload, headers) => call(method, url, payload, null, headers ?? {}),
    raw: (method, url, payload, headers) => call(method, url, payload, null, headers ?? {}, false),
    close: () => {
      void fastify.close();
      app.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 上偶发文件占用，清理失败不影响测试结论
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* 常用构造器                                                          */
/* ------------------------------------------------------------------ */

export async function makeProject(h: TestHarness, title = '测试项目'): Promise<string> {
  const res = await h.request<{ project: { id: string } }>('POST', '/api/projects', { title });
  if (res.status !== 200) throw new Error(`创建项目失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body.project.id;
}

export async function makeAccount(h: TestHarness, currency = 'CNY'): Promise<string> {
  const res = await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
    provider: '测试供应商',
    alias: `账户-${currency}`,
    currency,
  });
  if (res.status !== 200) throw new Error(`创建账户失败：${res.status} ${JSON.stringify(res.body)}`);
  return res.body.account.id;
}

/** CSV 导入（默认 usage_csv）。 */
export async function importCsv(
  h: TestHarness,
  fileName: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.request('POST', '/api/imports', {
    kind: 'usage_csv',
    fileName,
    content,
    ...extra,
  });
  return { status: res.status, body: res.body as Record<string, unknown> };
}

/**
 * 让脚手架真的监听一个随机端口，返回可被外部进程访问的地址。
 *
 * 进程内 `inject` 到不了「另一个进程通过 TCP 调本服务」这条路径 ——
 * MCP 子进程正属于这种情况，所以那些测试必须走真实 socket。
 * 监听之后 `inject` 依然可用，两种调用方式可以混用。
 */
export async function listenForRealHttp(h: TestHarness): Promise<string> {
  const address = await h.fastify.listen({ host: '127.0.0.1', port: 0 });
  // Fastify 在 IPv6 环境下可能返回 [::1]，MCP 侧要用 MCP 自己的 Host 头校验逻辑，
  // 统一成 127.0.0.1 更贴近真实启动时的形态。
  return address.replace('[::1]', '127.0.0.1');
}
