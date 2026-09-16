/**
 * HTTP 服务装配。
 *
 * 三层防护对应设计稿 §14 与 R03：
 * 1. `onRequest`：校验 Host 必须是回环地址、Origin 必须在白名单内。
 * 2. `onRequest`：写操作（POST/PUT/PATCH/DELETE）必须带自定义头 `x-aicc-request: 1`，
 *    配合 SameSite=Strict 的会话 Cookie 构成 CSRF 防护。跨站请求无法在不触发预检的
 *    情况下加上自定义头，而预检会因为 Origin 不在白名单而被拒。
 * 3. 路由级：写接口再校验主体身份与 scope。
 *
 * 静态前端由本服务提供，路径经过真实路径前缀比对，阻止 `..` 穿越。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import type { AppConfig } from '../config.js';
import { findCredentialByTokenHash, touchCredential } from '../db/repos/system.js';
import { parseWorkspace, type WorkspaceScope } from '../db/repos/workspace.js';
import { appendAudit } from '../db/repos/system.js';
import { ApiError, errorBody, toApiError } from './errors.js';
import { isUser, parseCookies, SESSION_COOKIE, type Principal, type SessionStore } from './auth.js';
import { registerRegistryRoutes } from './routes/registry.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerContextRoutes } from './routes/context.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerAgentRoutes } from './routes/agent.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    requestId: string;
  }
}

export interface HttpDeps {
  app: App;
  sessions: SessionStore;
  config: AppConfig;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildServer(deps: HttpDeps): FastifyInstance {
  const { config } = deps;

  const fastify = Fastify({
    // logger: false 已经关掉了请求日志；不要再加 disableRequestLogging，
    // 它在 Fastify 5.12 起已废弃（fastify 6 会移除），加了只会每次测试刷一行弃用警告。
    logger: false,
    bodyLimit: config.maxBodyBytes,
    // 本地单用户：不做信任代理推断，直接看真实 socket 地址
    trustProxy: false,
  });

  fastify.decorateRequest('requestId', '');

  /**
   * 空 JSON 请求体按 `{}` 处理。
   *
   * 默认行为是：只要带 `content-type: application/json` 而请求体为空，就直接报错
   * （"Body cannot be empty when content-type is set to 'application/json'"），
   * 而且这个错误会被包成 500。像 `curl -X POST -H 'content-type: application/json'`、
   * 或者前端 `fetch(url, {method:'POST', headers:{...}})` 不带 body 这种很常见的写法，
   * 会拿到一个「服务器内部错误」——完全看不出真正原因。
   *
   * 这里把它变成 `{}`，与「没写请求体」完全等价；**语法错误的 JSON 依然会报错**，
   * 并不会被这层宽容吞掉。
   */
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === undefined || body === null || (typeof body === 'string' && body.trim().length === 0)) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  fastify.addHook('onRequest', async (request, reply) => {
    request.requestId = `req_${Math.random().toString(36).slice(2, 10)}`;
    reply.header('x-request-id', request.requestId);
    // 本地服务，禁止被当作跨域资源被任意站点读取
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');

    /**
     * 被拦下的请求必须留痕。
     *
     * 只返回 403 而不记录，事后就完全说不清「是谁、什么时候、试着做什么」——
     * 而这恰恰是判断「这台机器上是不是有页面在偷偷调本地接口」的唯一线索。
     * 审计写入失败不能影响拒绝本身，所以单独 try/catch。
     */
    const deny = (reason: string, message: string): never => {
      try {
        appendAudit(deps.app.db, {
          actor: '匿名请求',
          actorKind: 'user',
          action: 'auth.reject',
          entityType: 'http_request',
          entityId: null,
          result: 'rejected',
          detail: {
            reason,
            method: request.method,
            url: request.url.length > 200 ? `${request.url.slice(0, 200)}…` : request.url,
            origin: request.headers.origin ?? null,
            host: request.headers.host ?? null,
            hasCsrfHeader: request.headers['x-aicc-request'] === '1',
            hasSessionCookie: typeof request.headers.cookie === 'string',
          },
          requestId: request.requestId,
        });
      } catch {
        // 审计失败不能把 403 变成 500
      }
      throw new ApiError(403, 'origin_rejected', message);
    };

    const hostname = (request.hostname ?? '').toLowerCase();
    const hostOk = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
    if (!hostOk) {
      deny('host_not_loopback', `Host 头 ${JSON.stringify(hostname)} 不是回环地址，已拒绝请求`);
    }

    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isAllowedOrigin(origin, request, config)) {
      deny('origin_not_allowed', `Origin ${origin} 不在允许列表内`);
    }

    if (WRITE_METHODS.has(request.method) && request.headers['x-aicc-request'] !== '1') {
      deny(
        'csrf_header_missing',
        '写操作缺少 x-aicc-request 请求头。这是防止恶意网页调用本地写接口的 CSRF 防护。',
      );
    }
  });

  // 解析主体：会话 Cookie 优先，其次 Bearer 凭据
  fastify.addHook('preHandler', async (request) => {
    request.principal = resolvePrincipal(request, deps);
  });

  fastify.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500) {
      reply.header('x-error-detail', 'internal');
    }
    reply.status(apiError.status).send(errorBody(apiError, request.requestId));
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.status(404).send(errorBody(new ApiError(404, 'not_found', `没有这个接口：${request.url}`)));
      return;
    }
    serveStatic(reply, config, request.url);
  });

  registerSystemRoutes(fastify, deps);
  registerRegistryRoutes(fastify, deps);
  registerUsageRoutes(fastify, deps);
  registerMemoryRoutes(fastify, deps);
  registerContextRoutes(fastify, deps);
  registerAgentRoutes(fastify, deps);

  fastify.get('/', (_request, reply) => {
    serveStatic(reply, config, '/');
  });

  return fastify;
}

function isAllowedOrigin(origin: string, request: FastifyRequest, config: AppConfig): boolean {
  // 同源（自己给自己发的请求）永远允许
  const selfOrigin = `${request.protocol}://${request.headers.host ?? ''}`;
  if (origin === selfOrigin) return true;
  return config.allowedOrigins.includes(origin);
}

/**
 * 解析请求主体。
 *
 * 用户会话（Cookie）拿到全部权限；代理凭据（Bearer）拿到受限权限。
 * 两者都不会因为「参数里写了 client_id」而改变身份 —— 身份只来自凭据本身（§11.2）。
 */
export function resolvePrincipal(request: FastifyRequest, deps: HttpDeps): Principal | undefined {
  const cookies = parseCookies(request.headers.cookie);
  const sessionToken = cookies[SESSION_COOKIE];
  if (sessionToken) {
    const session = deps.sessions.verify(sessionToken);
    if (session) {
      return { kind: 'user', label: session.label, sessionId: session.id, projectIds: null, scopes: null };
    }
  }

  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token.length > 0) {
      const found = deps.app.ctx ? findCredential(deps, token) : undefined;
      if (found) return found;
    }
  }

  return undefined;
}

function findCredential(deps: HttpDeps, token: string): Principal | undefined {
  const hash = sha256Hex(token);
  const found = findCredentialByTokenHash(deps.app.db, hash);
  if (!found) return undefined;
  if (found.credential.revokedAt !== null) return undefined;
  touchCredential(deps.app.db, found.credential.id);
  return {
    kind: 'credential',
    credentialId: found.credential.id,
    clientId: found.credential.clientId,
    label: found.credential.label,
    projectIds: found.credential.projectIds,
    scopes: found.credential.scopes,
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function requireUser(request: FastifyRequest, action?: string): Extract<Principal, { kind: 'user' }> {
  const principal = request.principal;
  if (!principal) {
    throw new ApiError(401, 'unauthenticated', '需要在本机浏览器完成配对后才能执行此操作');
  }
  if (!isUser(principal)) {
    throw new ApiError(
      403,
      'forbidden',
      `代理凭据（${principal.label}）不能执行${action ? `「${action}」` : '该'}操作。` +
        '审批、删除、连接管理与备份恢复只允许用户会话调用。',
    );
  }
  return principal;
}

export function requirePrincipal(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) {
    throw new ApiError(401, 'unauthenticated', '缺少有效身份：请先完成本机配对，或提供 Bearer 凭据');
  }
  return principal;
}

export function requireScope(request: FastifyRequest, scope: string): Principal {
  const principal = requirePrincipal(request);
  if (principal.kind === 'user') return principal;
  if (!principal.scopes.includes(scope)) {
    throw new ApiError(403, 'forbidden', `当前凭据缺少 ${scope} 权限`);
  }
  return principal;
}

export { principalProjectScope, isUser } from './auth.js';

/**
 * 读取请求里的工作区范围。
 *
 * 默认 'real'：真实视图里一行示例数据都不出现（设计稿 §8「不能污染真实总览」）。
 * 要看示例数据必须显式传 workspace=demo。前端切工作区时会给所有读取一起带上这个参数，
 * 避免出现「概览是示例、明细是真实」这种混搭。
 */
export function workspaceOf(request: FastifyRequest): WorkspaceScope {
  const query = request.query as Record<string, unknown> | undefined;
  return parseWorkspace(query?.workspace);
}

/** 静态资源：只允许读取 web/dist 之下的文件。 */
function serveStatic(
  reply: import('fastify').FastifyReply,
  config: AppConfig,
  url: string,
): void {
  const distRoot = resolve(config.webDistDir);
  const indexPath = join(distRoot, 'index.html');

  if (!existsSync(indexPath)) {
    reply.status(200).type('text/html; charset=utf-8').send(placeholderPage(config));
    return;
  }

  const rawPath = url.split('?')[0] ?? '/';
  const candidate = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
  const resolved = resolve(distRoot, normalize(candidate));

  // 真实路径前缀比对：`../` 之类在 normalize 之后会跳出 distRoot，这里直接拦掉
  if (resolved !== distRoot && !resolved.startsWith(distRoot + sep)) {
    reply.status(403).send('forbidden');
    return;
  }

  const target = existsSync(resolved) && statSync(resolved).isFile() ? resolved : indexPath;
  const body = readFileSync(target);
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  reply.status(200).type(type).send(body);
}

/** 前端还没构建时的占位页：明确说明「服务在跑、界面没构建」，而不是一个空白页或 500。 */
function placeholderPage(config: AppConfig): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>AI Control Center</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;line-height:1.7;color:#1f2933}
 code,pre{background:#f4f6f8;border-radius:6px}
 code{padding:.15em .4em}
 pre{padding:1rem;overflow:auto}
 .box{border:1px solid #d8dee9;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0}
 ul{padding-left:1.2rem}
</style></head><body>
<h1>服务已启动，前端尚未构建</h1>
<div class="box">
<p>API 已经在 <code>${config.host}:${config.port}</code> 上运行，数据目录是 <code>${config.dataDir}</code>。</p>
<p>但 <code>apps/web/dist/index.html</code> 还不存在，所以没有界面可以显示。</p>
</div>
<h2>接下来</h2>
<pre>npm run build      # 构建前端
npm start          # 由本服务提供界面</pre>
<p>或者开发模式：</p>
<pre>npm run dev        # 同时启动 API 与 Vite 开发服务器</pre>
<p>API 自检：<code>GET /api/self-check</code>（需要先配对）。</p>
</body></html>`;
}
