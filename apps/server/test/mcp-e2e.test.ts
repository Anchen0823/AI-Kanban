import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, listenForRealHttp, makeProject, type TestHarness } from './helpers.js';

/**
 * MCP 传输层的端到端测试（M1 退出条件）。
 *
 * 这一层**必须** spawn 真实子进程：进程内注入到不了「另一个进程通过 TCP 调本服务」
 * 这条路径，而 MCP 的失败模式恰恰集中在那里 —— stdout 被日志污染、
 * 缺少 CSRF 头、Host 校验、凭据没被带上。这些在 inject 下全都会绿。
 *
 * 覆盖：M03 的 MCP 路径（授权隔离 + 拒绝留痕）、§11.2 的工具回执、
 * 以及「失败不能返回安慰文案」。
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MCP_ENTRY = join(REPO_ROOT, 'apps', 'mcp', 'src', 'index.ts');

interface McpMessage {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
}

interface McpProcess {
  call(method: string, params?: unknown): Promise<McpMessage>;
  notify(method: string, params?: unknown): void;
  stderr(): string;
  close(): void;
}

/** 极简 MCP 客户端：按行收发，够用来验证协议形状与工具行为。 */
function startMcp(env: Record<string, string>): McpProcess {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', MCP_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  let stderrText = '';
  let nextId = 1;
  const pending = new Map<number, (message: McpMessage) => void>();

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as McpMessage;
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const settle = pending.get(message.id) as (m: McpMessage) => void;
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  return {
    call(method, params) {
      const id = nextId++;
      return new Promise<McpMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP 调用 ${method} 超时；stderr：${stderrText.slice(-400)}`)), 25_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    stderr: () => stderrText,
    close() {
      child.kill();
    },
  };
}

async function initialize(mcp: McpProcess): Promise<Record<string, unknown>> {
  const res = await mcp.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'aicc-test', version: '0.1.0' },
  });
  assert.equal(res.error, undefined, `initialize 失败：${JSON.stringify(res.error)}`);
  mcp.notify('notifications/initialized');
  return res.result as Record<string, unknown>;
}

async function callTool(
  mcp: McpProcess,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await mcp.call('tools/call', { name, arguments: args });
  assert.ok(res.result, `tools/call(${name}) 返回了协议错误：${JSON.stringify(res.error)}`);
  const result = res.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') };
}

/** 建一套「真实监听 + 客户端 + 限定单个项目的凭据」的环境。 */
async function setup(): Promise<{
  h: TestHarness;
  baseUrl: string;
  authorizedProject: string;
  otherProject: string;
  token: string;
  cleanup: () => void;
}> {
  const h = await createHarness();
  const baseUrl = await listenForRealHttp(h);

  const authorizedProject = await makeProject(h, '被授权的项目');
  const otherProject = await makeProject(h, '另一个项目');

  const client = await h.request<{ client: { id: string } }>('POST', '/api/clients', {
    kind: 'codex',
    displayName: 'Codex（端到端测试）',
  });
  assert.equal(client.status, 200);

  const credential = await h.request<{ token: string }>('POST', '/api/credentials', {
    clientId: client.body.client.id,
    label: 'e2e-codex',
    projectIds: [authorizedProject],
    scopes: ['memory_search', 'memory_get', 'context_build', 'memory_propose', 'session_propose', 'integration_status'],
  });
  assert.equal(credential.status, 200);

  return {
    h,
    baseUrl,
    authorizedProject,
    otherProject,
    token: credential.body.token,
    cleanup: () => h.close(),
  };
}

/** 走工作台界面那条路径把一条记忆变成 active，供 MCP 检索。 */
async function seedMemory(h: TestHarness, projectId: string, title: string, content: string): Promise<string> {
  const proposal = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
    operation: 'create',
    scope: 'project',
    projectId,
    kind: 'decision',
    title,
    content,
    sourceKind: 'manual_input',
  });
  assert.equal(proposal.status, 200, JSON.stringify(proposal.body));

  const approved = await h.request<{ memory: { id: string } }>(
    'POST',
    `/api/memory-proposals/${proposal.body.proposalId}/review`,
    { decision: 'approve', reviewedBy: '端到端测试' },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body.memory.id;
}

/* ------------------------------------------------------------------ */

test('M1：MCP 子进程能握手、列出六个工具，并真的检索到工作台里的记忆', async () => {
  const env = await setup();
  const mcp = startMcp({ AICC_API_URL: env.baseUrl, AICC_TOKEN: env.token });
  try {
    const init = await initialize(mcp);
    assert.equal(init.protocolVersion, '2025-06-18');

    const list = (await mcp.call('tools/list')).result as { tools: Array<{ name: string }> };
    assert.deepEqual(
      list.tools.map((t) => t.name).sort(),
      ['context_build', 'integration_status', 'memory_get', 'memory_propose', 'memory_search', 'session_propose'],
    );

    const memoryId = await seedMemory(env.h, env.authorizedProject, '统一用 UTC 存时间', '所有时间戳以 UTC 存储，展示时再转本地时区。');

    const found = await callTool(mcp, 'memory_search', { query: '时区', project_id: env.authorizedProject });
    assert.equal(found.isError, false, found.text);
    assert.match(found.text, /统一用 UTC 存时间/);

    const got = await callTool(mcp, 'memory_get', { memory_id: memoryId });
    assert.equal(got.isError, false, got.text);
    assert.match(got.text, /所有时间戳以 UTC 存储/);
  } finally {
    mcp.close();
    env.cleanup();
  }
});

test('M03（MCP 路径）：跨项目检索与直取都被拒，且审计里有拒绝记录', async () => {
  const env = await setup();
  const mcp = startMcp({ AICC_API_URL: env.baseUrl, AICC_TOKEN: env.token });
  try {
    await initialize(mcp);
    const otherMemoryId = await seedMemory(env.h, env.otherProject, '另一个项目的秘密', '这条内容不该被这个凭据看到。');

    // 路径一：检索时申请未授权项目
    const search = await callTool(mcp, 'memory_search', { query: '', project_id: env.otherProject });
    assert.equal(search.isError, true, '跨项目检索必须被拒');
    assert.match(search.text, /forbidden/);
    assert.match(search.text, /没有产生任何变更/);

    // 路径二：拿到 ID 直接取（「不知道 ID」不构成安全控制）
    const direct = await callTool(mcp, 'memory_get', { memory_id: otherMemoryId });
    assert.equal(direct.isError, true, '跨项目直取必须被拒');
    assert.match(direct.text, /forbidden/);

    // 两种路径都要留痕，否则事后说不清「谁试过读什么」
    const audit = await env.h.request<{ events: Array<{ action: string; result: string; detail: unknown }> }>(
      'GET',
      '/api/audit?limit=50',
    );
    const rejections = audit.body.events.filter(
      (e) => e.action === 'auth.reject' && JSON.stringify(e.detail).includes('project_scope_violation'),
    );
    assert.ok(rejections.length >= 2, `期望至少两条越权拒绝记录，实际 ${rejections.length}`);
  } finally {
    mcp.close();
    env.cleanup();
  }
});

test('M1：memory_propose 回执给出 proposal_id 与 status=candidate，且候选未生效', async () => {
  const env = await setup();
  const mcp = startMcp({ AICC_API_URL: env.baseUrl, AICC_TOKEN: env.token });
  try {
    await initialize(mcp);

    const proposed = await callTool(mcp, 'memory_propose', {
      operation: 'create',
      project_id: env.authorizedProject,
      kind: 'fact',
      title: '这个项目用 npm workspaces',
      content: '三个包：packages/core、apps/server、apps/web。',
      source_kind: 'codex_session',
      sources: ['codex://thread/abc'],
    });
    assert.equal(proposed.isError, false, proposed.text);

    const receipt = JSON.parse(proposed.text) as { proposal_id: string; status: string; note: string };
    assert.ok(receipt.proposal_id.length > 0);
    assert.equal(receipt.status, 'candidate');
    assert.match(receipt.note, /人工批准/);

    // 候选不能直接出现在检索结果里（M01）
    const search = await callTool(mcp, 'memory_search', { query: 'npm workspaces', project_id: env.authorizedProject });
    assert.equal(search.isError, false);
    assert.doesNotMatch(search.text, /这个项目用 npm workspaces/, '未批准的候选不得进入正式检索');
  } finally {
    mcp.close();
    env.cleanup();
  }
});

test('M1：integration_status 反映凭据的项目范围，而不是参数里的自报身份', async () => {
  const env = await setup();
  const mcp = startMcp({ AICC_API_URL: env.baseUrl, AICC_TOKEN: env.token });
  try {
    await initialize(mcp);
    const status = await callTool(mcp, 'integration_status', {});
    assert.equal(status.isError, false, status.text);

    const parsed = JSON.parse(status.text) as {
      principal: { kind: string; project_scope: string[] };
      projects: Array<{ id: string }>;
      mcp_transport_available: boolean;
    };
    assert.equal(parsed.principal.kind, 'credential');
    assert.deepEqual(parsed.principal.project_scope, [env.authorizedProject]);
    assert.deepEqual(
      parsed.projects.map((p) => p.id),
      [env.authorizedProject],
      '只能看到被授权的项目',
    );
    assert.equal(parsed.mcp_transport_available, true, 'M1 之后这个标志应当为真');
  } finally {
    mcp.close();
    env.cleanup();
  }
});

test('M1：没有凭据时工具调用失败但协议本身可用', async () => {
  const env = await setup();
  const mcp = startMcp({ AICC_API_URL: env.baseUrl, AICC_TOKEN: '' });
  try {
    // 握手仍然成功 —— 让客户端能列出工具、也能看到明确的原因，
    // 比一个「MCP 服务启动失败」更容易查。
    await initialize(mcp);
    const result = await callTool(mcp, 'memory_search', { query: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.text, /token_missing/);
    assert.match(mcp.stderr(), /没有配置 AICC_TOKEN/);
  } finally {
    mcp.close();
    env.cleanup();
  }
});

test('M1：工作台没在运行时，检索失败并说明要先启动服务', async () => {
  const env = await setup();
  // 指向一个必然没有监听的端口
  const mcp = startMcp({ AICC_API_URL: 'http://127.0.0.1:1', AICC_TOKEN: env.token });
  try {
    await initialize(mcp);
    const result = await callTool(mcp, 'memory_search', { query: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.text, /backend_unreachable/);
    assert.match(result.text, /npm start/);
    assert.doesNotMatch(result.text, /"items":\s*\[\]/, '不能返回空结果假装成功');
  } finally {
    mcp.close();
    env.cleanup();
  }
});
