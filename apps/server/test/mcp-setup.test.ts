import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeMcpSetup } from '../src/services/mcp-setup.js';
import { createHarness, listenForRealHttp } from './helpers.js';

test('接入配置检查构建产物，正确格式化 IPv6 地址，不声称客户端已验证', async () => {
  const h = await createHarness();
  try {
    const runtime = { repoRoot: h.dir, nodeExecutable: process.execPath };
    const address = { host: '::1', port: 8788 };
    assert.equal(describeMcpSetup(address, runtime).built, false);
    const dist = join(h.dir, 'apps', 'mcp', 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '// fixture');
    const setup = describeMcpSetup(address, runtime);
    assert.equal(setup.built, true);
    assert.equal(setup.apiUrl, 'http://[::1]:8788');
    assert.equal(setup.command, process.execPath);
    assert.deepEqual(setup.args, [join(dist, 'index.js')]);
    assert.equal(setup.clientVerified, false);
    assert.throws(() => describeMcpSetup({ host: 'example.com', port: 8788 }, runtime));
  } finally { h.close(); }
});

test('接入配置仅用户可读，使用实际监听端口，且不改变能力登记', async () => {
  const h = await createHarness();
  try {
    const url = await listenForRealHttp(h);
    const before = await h.request('GET', '/api/integrations');
    const result = await h.request<{ apiUrl: string; clientVerified: boolean }>('GET', '/api/mcp/setup');
    assert.equal(result.status, 200);
    assert.equal(result.body.apiUrl, url);
    assert.equal(result.body.clientVerified, false);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await h.anonymous('GET', '/api/mcp/setup')).status, 401);
    const client = await h.request<{ client: { id: string } }>('POST', '/api/clients', { kind: 'codex', displayName: '接入测试' });
    const credential = await h.request<{ token: string }>('POST', '/api/credentials', {
      clientId: client.body.client.id, label: '只读接入测试', scopes: ['integration_status'],
    });
    assert.equal((await h.anonymous('GET', '/api/mcp/setup', undefined, {
      authorization: `Bearer ${credential.body.token}`,
    })).status, 403);
    assert.deepEqual((await h.request('GET', '/api/integrations')).body, before.body);
    const check = await h.request<{ checks: Array<{ name: string; detail: string }> }>('GET', '/api/self-check');
    assert.match(check.body.checks.find((row) => row.name === '外部用量接口探测')!.detail, /已实现 Codex/);
    assert.doesNotMatch(JSON.stringify(check.body.checks), /M0 未实现/);
  } finally { h.close(); }
});
