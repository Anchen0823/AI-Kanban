import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeAccount, makeProject } from './helpers.js';

test('代理 scope 不授予工作台管理与历史数据的读取权限', async () => {
  const h = await createHarness();
  try {
    const authorized = await makeProject(h, '代理项目');
    const account = await makeAccount(h);
    const other = await makeProject(h, '用户的另一项目');
    const proposal = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
      operation: 'create', scope: 'project', projectId: other, kind: 'fact',
      title: '仅用户可见', content: '另一项目的已批准内容', sourceKind: 'manual_input',
    });
    assert.equal((await h.request('POST', `/api/memory-proposals/${proposal.body.proposalId}/review`, {
      decision: 'approve', reviewedBy: '测试用户',
    })).status, 200);
    const exported = await h.request<{ exportId: string }>('POST', '/api/context-exports', { projectId: other });
    assert.equal(exported.status, 200);
    const client = await h.request<{ client: { id: string } }>('POST', '/api/clients', { kind: 'codex', displayName: '测试代理' });
    const credential = await h.request<{ token: string }>('POST', '/api/credentials', {
      clientId: client.body.client.id, label: '仅代理项目', projectIds: [authorized],
      scopes: ['memory_search', 'memory_get', 'context_build', 'memory_propose', 'session_propose', 'integration_status'],
    });
    const headers = { authorization: `Bearer ${credential.body.token}` };
    const paths = [
      '/api/clients', '/api/accounts', '/api/subscriptions', '/api/projects', '/api/sessions',
      '/api/overview', '/api/usage', '/api/charges', '/api/quota', `/api/quota/history?accountId=${account}&bucketId=test`, '/api/imports',
      '/api/integrations', '/api/workspace/summary', '/api/bridge/status',
      '/api/context-exports', `/api/context-exports/${exported.body.exportId}`,
      `/api/projects/${other}/context-preview`,
    ];
    for (const path of paths) {
      assert.equal((await h.request('GET', path)).status, 200, `用户仍可读取 ${path}`);
      const denied = await h.anonymous('GET', path, undefined, headers);
      assert.equal(denied.status, 403, `代理不应读取 ${path}`);
      assert.doesNotMatch(JSON.stringify(denied.body), /另一项目的已批准内容/);
    }
    assert.equal((await h.anonymous('GET', '/api/imports/unknown-id', undefined, headers)).status, 403);
    const status = await h.anonymous<{ projects: Array<{ id: string }> }>('GET', '/api/agent/integration_status', undefined, headers);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.projects.map((p) => p.id), [authorized]);
    const build = await h.anonymous('POST', '/api/agent/context_build', { project_id: authorized }, headers);
    assert.equal(build.status, 200);
  } finally { h.close(); }
});
