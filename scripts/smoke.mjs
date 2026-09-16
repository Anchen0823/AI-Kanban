/**
 * 端到端冒烟验证。
 *
 * 前面的验收测试用的是 Fastify 的 `inject`（进程内注入），它跳过了真实的 socket、
 * Host 头、Cookie 收发与静态资源服务。这个脚本补上这一段：真的启动服务进程、
 * 真的在 127.0.0.1 上发 HTTP 请求、真的从终端读到配对码再拿 Cookie。
 *
 * 用一个独立的临时数据目录，绝不碰你的真实数据。
 *
 * 用法：node scripts/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8791;
const HOST = `127.0.0.1:${PORT}`;
const BASE = `http://${HOST}`;

const results = [];
const ok = (name, extra = '') => results.push({ ok: true, name, extra });
const fail = (name, detail) => results.push({ ok: false, name, detail });

const dataDir = mkdtempSync(join(tmpdir(), 'aicc-smoke-'));
let child = null;
let cookie = '';

function cleanup() {
  if (child && !child.killed) child.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用，忽略 */
  }
}

async function req(method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-aicc-request'] = '1';
  }
  if (cookie) headers.cookie = cookie;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'apps/server/dist/index.js'],
      {
        cwd: process.cwd(),
        env: { ...process.env, AICC_PORT: String(PORT), AICC_DATA_DIR: dataDir },
      },
    );

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/配对码：([A-Z0-9]{6,12})/);
      if (match) {
        child.stdout.off('data', onData);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[server] ${chunk.toString('utf8')}`);
    });
    child.on('exit', (code) => {
      if (!buffer.includes('配对码')) {
        reject(new Error(`服务提前退出，code=${code}`));
      }
    });
    setTimeout(() => reject(new Error('等待启动超时（20 秒）')), 20_000);
  });
}

async function main() {
  if (!existsSync('apps/server/dist/index.js')) {
    throw new Error('请先执行 npm run build，缺少 apps/server/dist/index.js');
  }

  const pairingCode = await startServer();
  ok('服务启动并打印配对码', pairingCode.length >= 6 ? '已从 stdout 解析到' : '');

  // 1) 未配对时读会话
  const anon = await req('GET', '/api/session');
  if (anon.status === 200 && anon.body.authenticated === false) {
    ok('未配对时 /api/session 返回 authenticated=false');
  } else {
    fail('未配对时 /api/session', `status=${anon.status} body=${JSON.stringify(anon.body)}`);
  }

  // 2) 静态资源：构建产物由服务端直接提供（不是占位页）
  const page = await req('GET', '/');
  if (page.status === 200 && typeof page.body === 'string' && page.body.includes('<div id="root">')) {
    ok('服务端提供已构建的前端页面');
  } else {
    fail('服务端提供前端页面', `status=${page.status}，返回内容前 120 字符：${String(page.body).slice(0, 120)}`);
  }

  // 3) 缺 CSRF 头 → 403
  const noCsrf = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://${HOST}` },
    body: JSON.stringify({ title: 'x' }),
  });
  if (noCsrf.status === 403) {
    ok('缺 CSRF 头的写请求被拒（403）');
  } else {
    fail('缺 CSRF 头应被拒', `实际 ${noCsrf.status}`);
  }

  // 4) 错误配对码
  const badPair = await req('POST', '/api/session/pair', { code: 'ZZZZZZZZ', label: 'smoke' });
  if (badPair.status === 401) {
    ok('错误配对码被拒（401）');
  } else {
    fail('错误配对码应被拒', `实际 ${badPair.status}`);
  }

  // 5) 正确配对码 → 拿到 HttpOnly Cookie
  const paired = await req('POST', '/api/session/pair', { code: pairingCode, label: 'smoke 测试' });
  if (paired.status === 200 && cookie.startsWith('aicc_session=')) {
    ok('配对成功并收到会话 Cookie');
  } else {
    fail('配对', `status=${paired.status} cookie=${cookie}`);
  }

  // 6) 配对码一次性：同一个码再用应当失败
  const saved = cookie;
  cookie = '';
  const reuse = await req('POST', '/api/session/pair', { code: pairingCode, label: 'smoke 重放' });
  cookie = saved;
  if (reuse.status === 401) {
    ok('配对码一次性（重放被拒）');
  } else {
    fail('配对码应一次性', `实际 ${reuse.status}`);
  }

  // 7) 自检
  const selfCheck = await req('GET', '/api/self-check');
  if (selfCheck.status === 200 && selfCheck.body.driver) {
    ok('自检接口可用', `驱动 ${selfCheck.body.driver}，schema v${selfCheck.body.schemaVersion}`);
  } else {
    fail('自检接口', `status=${selfCheck.status}`);
  }

  // 8) 建项目 → 建候选 → 批准 → 生成上下文包
  const project = await req('POST', '/api/projects', { title: '冒烟验证项目' });
  if (project.status !== 200) fail('创建项目', JSON.stringify(project.body));
  else ok('创建项目');

  const account = await req('POST', '/api/accounts', { provider: '冒烟供应商', alias: '冒烟账户', currency: 'CNY' });
  if (account.status === 200) ok('创建计费账户');
  else fail('创建计费账户', JSON.stringify(account.body));

  // 9) 导入同一份 CSV 两次，验证真实网络路径下的幂等
  const csv = ['occurred_at,request_id,model,input_tokens,output_tokens,cached_tokens', '2026-09-16T00:00:00Z,smoke-1,model-a,10000,2000,6000'].join('\n');
  const first = await req('POST', '/api/imports', {
    kind: 'usage_csv',
    fileName: 'smoke.csv',
    content: csv,
    accountId: account.body?.account?.id ?? null,
    projectId: project.body?.project?.id ?? null,
  });
  const second = await req('POST', '/api/imports', {
    kind: 'usage_csv',
    fileName: 'smoke.csv',
    content: csv,
    accountId: account.body?.account?.id ?? null,
    projectId: project.body?.project?.id ?? null,
  });

  if (first.status === 200 && first.body.acceptedRows === 1 && second.body.replayedRows === 1) {
    ok('真实 HTTP 下重复导入幂等', `首次新增 1 行，第二次重放 1 行`);
  } else {
    fail(
      '重复导入幂等',
      `first=${JSON.stringify({ s: first.status, a: first.body?.acceptedRows })} second=${JSON.stringify({ s: second.status, r: second.body?.replayedRows })}`,
    );
  }

  const overview = await req('GET', '/api/overview');
  const observed = overview.body?.tokens?.observed;
  if (observed === 12000) {
    ok('概览已观测 token = 12,000（子项未重复相加）');
  } else {
    fail('概览 token 口径', `期望 12000，实际 ${JSON.stringify(observed)}，coverage=${overview.body?.tokens?.coverage}`);
  }

  // 10) 候选导入 → 批准 → 上下文包
  const candidates = JSON.stringify({
    schema_version: '1.0',
    candidates: [
      {
        operation: 'create',
        scope: 'project',
        project_id: '冒烟验证项目',
        kind: 'decision',
        title: '冒烟决策',
        content: '这条内容用于验证真实 HTTP 路径下的候选 → 批准 → 上下文导出。',
        source: { kind: 'chatgpt_summary', source_ref: null, evidence_status: 'user_confirmation_required' },
      },
    ],
  });
  const imported = await req('POST', '/api/memory-proposals/import', {
    fileName: 'smoke.json',
    content: candidates,
    projectMapping: {},
    defaultProjectId: project.body?.project?.id ?? null,
  });
  const proposalId = imported.body?.created?.[0]?.proposalId;
  if (proposalId) ok('候选导入成功（粘贴模式）');
  else fail('候选导入', JSON.stringify(imported.body));

  const approved = await req('POST', `/api/memory-proposals/${proposalId}/review`, {
    decision: 'approve',
    reviewedBy: 'smoke',
  });
  if (approved.status === 200 && approved.body?.memory?.id) ok('候选批准后生成正式记忆');
  else fail('批准候选', JSON.stringify(approved.body));

  const context = await req('POST', '/api/context-exports', {
    projectId: project.body?.project?.id,
    budgetKind: 'short',
  });
  if (context.status === 200 && String(context.body?.markdown ?? '').includes('冒烟决策')) {
    ok('生成上下文包并包含刚批准的记忆');
  } else {
    fail('生成上下文包', `status=${context.status}`);
  }

  // 11) 代理凭据：能读授权项目，不能读别的项目，也不能审批
  const client = await req('POST', '/api/clients', { kind: 'cursor', displayName: '冒烟客户端' });
  const otherProject = await req('POST', '/api/projects', { title: '冒烟项目 B' });
  const credential = await req('POST', '/api/credentials', {
    clientId: client.body?.client?.id,
    label: '冒烟凭据',
    projectIds: [project.body?.project?.id],
    scopes: ['memory_search', 'memory_get', 'context_build', 'memory_propose'],
  });
  const token = credential.body?.token;

  const savedCookie = cookie;
  cookie = '';
  const crossProject = await req(
    'POST',
    '/api/agent/memory_search',
    { query: '', project_id: otherProject.body?.project?.id },
    { authorization: `Bearer ${token}` },
  );
  const ownProject = await req(
    'POST',
    '/api/agent/memory_search',
    { query: '', project_id: project.body?.project?.id },
    { authorization: `Bearer ${token}` },
  );
  const tryReview = await req(
    'POST',
    `/api/memory-proposals/${proposalId}/review`,
    { decision: 'approve', reviewedBy: 'attacker' },
    { authorization: `Bearer ${token}` },
  );
  cookie = savedCookie;

  if (crossProject.status === 403) ok('凭据读取未授权项目被拒（403）');
  else fail('凭据越权应被拒', `实际 ${crossProject.status}`);

  if (ownProject.status === 200 && ownProject.body?.count === 1) ok('凭据读取授权项目成功');
  else fail('凭据读取授权项目', `status=${ownProject.status} body=${JSON.stringify(ownProject.body).slice(0, 160)}`);

  if (tryReview.status === 403) ok('凭据调用审批接口被拒（403）');
  else fail('凭据审批应被拒', `实际 ${tryReview.status}`);

  // 12) 备份 → 恢复预览
  const backup = await req('POST', '/api/backups', { note: 'smoke' });
  if (backup.status === 200) ok('生成备份');
  else fail('生成备份', JSON.stringify(backup.body));

  const plan = await req('POST', `/api/backups/${backup.body?.name}/restore-plan`);
  if (plan.status === 200 && plan.body?.plan?.integrity === 'ok') ok('恢复预览通过完整性校验');
  else fail('恢复预览', JSON.stringify(plan.body));

  // 13) demo 数据生成与清空
  const seeded = await req('POST', '/api/demo/seed');
  if (seeded.status === 200) ok('生成示例数据');
  else fail('生成示例数据', JSON.stringify(seeded.body).slice(0, 200));

  const overviewWithDemo = await req('GET', '/api/overview');
  if (overviewWithDemo.body?.tokens?.observed === 12000) {
    ok('示例数据未污染真实统计（已观测 token 仍为 12,000）');
  } else {
    fail('示例数据污染统计', `示例生成后 observed=${overviewWithDemo.body?.tokens?.observed}`);
  }

  const reset = await req('POST', '/api/demo/reset');
  if (reset.status === 200) ok(`清空示例数据（删除 ${reset.body?.totalDeleted} 行）`);
  else fail('清空示例数据', JSON.stringify(reset.body));

  // 14) 审计里应当留下被拒绝的记录
  const audit = await req('GET', '/api/audit?limit=100');
  const rejections = (audit.body?.events ?? []).filter((e) => e.result === 'rejected');
  if (rejections.length >= 3) {
    ok(`被拒绝的动作有审计记录（${rejections.length} 条）`);
  } else {
    fail('拒绝动作审计', `只有 ${rejections.length} 条拒绝记录`);
  }
}

main()
  .catch((err) => {
    fail('脚本异常', err instanceof Error ? (err.stack ?? err.message) : String(err));
  })
  .finally(() => {
    cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log('');
    for (const r of results) {
      const mark = r.ok ? 'OK  ' : 'FAIL';
      console.log(`${mark} ${r.name}${r.extra ? ` — ${r.extra}` : ''}`);
      if (!r.ok && r.detail) console.log(`     ${r.detail}`);
    }
    console.log('');
    console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
