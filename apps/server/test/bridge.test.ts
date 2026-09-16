import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, makeProject } from './helpers.js';

/**
 * ChatGPT 桥接与跨工具交接：B01、B03，以及设计稿 §15 要求的「最低端到端演示」。
 */

async function seedMemory(
  h: Awaited<ReturnType<typeof createHarness>>,
  projectId: string,
  input: { kind: string; title: string; content: string; pinned?: boolean },
): Promise<string> {
  const created = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
    operation: 'create',
    scope: 'project',
    projectId,
    kind: input.kind,
    title: input.title,
    content: input.content,
    sourceKind: 'manual_input',
    evidenceStatus: 'verified',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const reviewed = await h.request<{ memory: { id: string } }>(
    'POST',
    `/api/memory-proposals/${created.body.proposalId}/review`,
    { decision: 'approve', reviewedBy: '测试用户' },
  );
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  const memoryId = reviewed.body.memory.id;

  if (input.pinned) {
    const pinned = await h.request('POST', `/api/memories/${memoryId}/pin`, { pinned: true });
    assert.equal(pinned.status, 200);
  }
  return memoryId;
}

test('B01：没有连接外部写工具时，界面得到的是「已生成候选」而不是虚假同步回执', async () => {
  const h = await createHarness();
  try {
    const status = await h.request<{
      mode: string;
      modes: { paste: { available: boolean }; remoteMcp: { available: boolean } };
      limitations: string[];
    }>('GET', '/api/bridge/status');

    assert.equal(status.status, 200);
    assert.equal(status.body.mode, 'paste');
    assert.equal(status.body.modes.paste.available, true);
    assert.equal(status.body.modes.remoteMcp.available, false, '远程接入不属于 M0，不能谎称可用');
    assert.ok(status.body.limitations.some((l) => l.includes('原生 Memory')));
    assert.ok(status.body.limitations.some((l) => l.includes('localhost')));

    const prompt = await h.request<{ prompt: string; usage: string[]; caveat: string }>('GET', '/api/bridge/prompt');
    assert.equal(prompt.status, 200);
    // §7.2 提示词的关键约束必须在产物里
    assert.match(prompt.body.prompt, /不要把你的建议改写成我的偏好/);
    assert.match(prompt.body.prompt, /没有可靠原文、日期或链接时写 unknown，不要编造/);
    assert.match(prompt.body.prompt, /不要声称已经写入或同步/);
    assert.match(prompt.body.caveat, /不会说「已同步」/);
  } finally {
    h.close();
  }
});

test('B03：只需要粘贴的客户端也能完成一次完整交接', async () => {
  const h = await createHarness();
  try {
    const projectId = await makeProject(h, '交接演示项目');

    await seedMemory(h, projectId, {
      kind: 'fact',
      title: '已确认事实：默认思考时间 3 秒',
      content: '引擎默认思考时间 3 秒。',
      pinned: true,
    });
    await seedMemory(h, projectId, {
      kind: 'decision',
      title: '当前决策：先补测试再改搜索',
      content: '先把棋例边界用例补齐。',
    });
    await seedMemory(h, projectId, {
      kind: 'lesson',
      title: '失败路径：直接改搜索导致回归',
      content: '没有测试就直接改搜索，结果引入了三个回归。',
    });
    await seedMemory(h, projectId, {
      kind: 'hypothesis',
      title: '未验证猜想：分块搜索在残局收益更大',
      content: '这只是猜想，verification 仍然是 unverified。',
    });

    const exported = await h.request<{
      exportId: string;
      markdown: string;
      manifest: {
        items: Array<{ memoryId: string; version: number; kind: string }>;
        estimatedTokens: number;
        tokenCountKind: string;
        droppedCount: number;
        disclaimer: string;
      };
      note: string;
    }>('POST', '/api/context-exports', {
      projectId,
      task: '把当前状态交接给另一个客户端',
      budgetKind: 'standard',
    });

    assert.equal(exported.status, 200);
    const md = exported.body.markdown;

    // §4.3 要求包内包含的六类信息
    assert.match(md, /## 本次目标/);
    assert.match(md, /## 已确认事实/);
    assert.match(md, /## 当前决策/);
    assert.match(md, /## 已尝试且失败的路径/);
    assert.match(md, /## 尚未验证的猜想/);

    // 清单：每条都带 ID 与版本
    assert.equal(exported.body.manifest.items.length, 4);
    for (const item of exported.body.manifest.items) {
      assert.ok(item.memoryId.startsWith('mem_'));
      assert.equal(item.version, 1);
      assert.ok(md.includes(item.memoryId));
    }

    // token 计数必须是估算，不能假装精确
    assert.equal(exported.body.manifest.tokenCountKind, 'estimated');
    assert.match(md, /估算/);
    assert.ok(exported.body.manifest.estimatedTokens > 0);

    // 免责声明必须写进产物本身，而不是只放在界面上
    assert.match(md, /不能证明目标模型已阅读/);

    // 包的清单能证明返回了什么，不证明模型读了什么
    assert.match(exported.body.note, /不能证明目标模型/);
  } finally {
    h.close();
  }
});

test('端到端：候选 → 收集箱批准 → 两端检索到同一版本 → 更新后旧包失效', async () => {
  const h = await createHarness();
  try {
    const projectId = await makeProject(h, '端到端项目');

    // 1) 在「ChatGPT」里形成一条项目决策，粘贴候选 JSON 进来
    const candidate = {
      schema_version: '1.0',
      candidates: [
        {
          operation: 'create',
          scope: 'project',
          project_id: '端到端项目',
          kind: 'decision',
          title: '统一用 UTC 存时间',
          content: '所有时间戳以 UTC 存储，展示时再转本地时区。',
          source: { kind: 'chatgpt_summary', source_ref: null, evidence_status: 'user_confirmation_required' },
        },
      ],
    };

    const imported = await h.request<{ created: Array<{ proposalId: string }> }>(
      'POST',
      '/api/memory-proposals/import',
      { fileName: 'from-chatgpt.json', content: JSON.stringify(candidate), projectMapping: {}, defaultProjectId: projectId },
    );
    assert.equal(imported.body.created.length, 1);
    const proposalId = imported.body.created[0]?.proposalId as string;

    // 2) 人工核对后批准
    const approved = await h.request<{ memory: { id: string; version: number } }>(
      'POST',
      `/api/memory-proposals/${proposalId}/review`,
      { decision: 'approve', reviewedBy: '测试用户', reviewNote: '与我实际说法一致' },
    );
    assert.equal(approved.status, 200);
    const memoryId = approved.body.memory.id;

    // 3) 两个客户端（两个凭据）都能检索到同一版本
    const mkCredential = async (label: string): Promise<string> => {
      const client = await h.request<{ client: { id: string } }>('POST', '/api/clients', {
        kind: label === 'codex' ? 'codex' : 'cursor',
        displayName: label,
      });
      const cred = await h.request<{ token: string }>('POST', '/api/credentials', {
        clientId: client.body.client.id,
        label,
        projectIds: [projectId],
        scopes: ['memory_search', 'memory_get', 'context_build', 'memory_propose'],
      });
      return cred.body.token;
    };

    const codexToken = await mkCredential('codex');
    const cursorToken = await mkCredential('cursor');

    const readFrom = async (token: string): Promise<{ version: number; content: string }> => {
      const res = await h.anonymous(
        'POST',
        '/api/agent/memory_get',
        { memory_id: memoryId },
        { authorization: `Bearer ${token}` },
      );
      assert.equal(res.status, 200);
      return res.body as { version: number; content: string };
    };

    const fromCodex = await readFrom(codexToken);
    const fromCursor = await readFrom(cursorToken);
    assert.equal(fromCodex.version, 1);
    assert.equal(fromCursor.version, 1);
    assert.equal(fromCodex.content, fromCursor.content);

    // 生成一个上下文包，随后更新记忆，旧包应被标记失效
    const firstExport = await h.request<{ exportId: string }>('POST', '/api/context-exports', {
      projectId,
      budgetKind: 'short',
    });

    // 这次刻意**不带用户 Cookie**，只带代理凭据 —— 走的是 AI 提案那条路径
    const updateProposal = await h.request<{ proposal_id: string; status: string }>(
      'POST',
      '/api/agent/memory_propose',
      {
        operation: 'update',
        targetMemoryId: memoryId,
        baseVersion: 1,
        scope: 'project',
        projectId,
        kind: 'decision',
        title: '统一用 UTC 存时间',
        content: '所有时间戳以 UTC 存储，展示时再转本地时区（补充：数据库里不要存本地时间）。',
        sourceKind: 'codex_session',
        evidenceStatus: 'user_confirmation_required',
      },
      { cookie: null, headers: { authorization: `Bearer ${codexToken}` } },
    );
    assert.equal(updateProposal.status, 200);
    assert.equal(updateProposal.body.status, 'candidate', '代理接口返回的状态必须是 candidate，不是 active');

    const updated = await h.request<{ memory: { version: number } }>(
      'POST',
      `/api/memory-proposals/${updateProposal.body.proposal_id}/review`,
      { decision: 'approve', reviewedBy: '测试用户' },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.memory.version, 2);

    // 两端重新读取 → 拿到同一个新版本
    const afterCodex = await readFrom(codexToken);
    const afterCursor = await readFrom(cursorToken);
    assert.equal(afterCodex.version, 2);
    assert.equal(afterCursor.version, 2);
    assert.equal(afterCodex.content, afterCursor.content);

    // 旧包被标记失效，且说明了原因
    const exportDetail = await h.request<{ export: { invalidatedAt: string | null; invalidatedReason: string | null } }>(
      'GET',
      `/api/context-exports/${firstExport.body.exportId}`,
    );
    assert.ok(exportDetail.body.export.invalidatedAt, '旧包必须被标记为失效');
    assert.match(String(exportDetail.body.export.invalidatedReason), /已更新到 v2/);
  } finally {
    h.close();
  }
});

test('上下文包：固定项超预算时提示取舍而不是静默截断', async () => {
  const h = await createHarness();
  try {
    const projectId = await makeProject(h, '预算项目');
    await seedMemory(h, projectId, {
      kind: 'fact',
      title: '必读约束',
      content: '必须遵守的约束：'.concat('内容。'.repeat(500)),
      pinned: true,
    });

    const exported = await h.request<{
      requiresUserChoice: boolean;
      warnings: string[];
      note: string;
      manifest: { items: unknown[]; estimatedTokens: number };
    }>('POST', '/api/context-exports', { projectId, budgetKind: 'short' });

    assert.equal(exported.body.requiresUserChoice, true);
    assert.equal(exported.body.manifest.items.length, 1, '固定项不被自动删除');
    assert.match(exported.body.note, /不会自动删除固定项/);
  } finally {
    h.close();
  }
});

test('上下文包：默认不纳入 global 记忆，避免把整份个人画像塞给每个 agent', async () => {
  const h = await createHarness();
  try {
    const projectId = await makeProject(h, '范围项目');

    // 一条 global 记忆
    const globalProposal = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
      operation: 'create',
      scope: 'global',
      projectId: null,
      kind: 'preference',
      title: '全局偏好：回答用中文',
      content: '这是一条全局偏好。',
      sourceKind: 'manual_input',
      evidenceStatus: 'verified',
    });
    const approved = await h.request<{ memory: { id: string } }>(
      'POST',
      `/api/memory-proposals/${globalProposal.body.proposalId}/review`,
      { decision: 'approve', reviewedBy: '测试用户' },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    await seedMemory(h, projectId, { kind: 'fact', title: '项目事实', content: '只有项目内的事实。' });

    const withoutGlobal = await h.request<{ markdown: string; manifest: { items: unknown[] } }>(
      'POST',
      '/api/context-exports',
      { projectId, budgetKind: 'standard' },
    );
    assert.equal(withoutGlobal.body.manifest.items.length, 1);
    assert.ok(!withoutGlobal.body.markdown.includes('全局偏好'));

    const withGlobal = await h.request<{ manifest: { items: unknown[] } }>('POST', '/api/context-exports', {
      projectId,
      budgetKind: 'standard',
      includeGlobalMemory: true,
    });
    assert.equal(withGlobal.body.manifest.items.length, 2);
  } finally {
    h.close();
  }
});
