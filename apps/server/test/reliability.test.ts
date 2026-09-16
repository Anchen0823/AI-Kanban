import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, importCsv, makeAccount, makeProject } from './helpers.js';
import { openDatabase, migrate } from '../src/db/database.js';
import { databaseCounts } from '../src/db/repos/system.js';

/**
 * 备份、恢复、局部失败与安全边界：R01、R02、R03。
 */

/** 固定 Host 头，让「同源」判定在 inject 环境下可预期。 */
const HOST = '127.0.0.1:8787';

test('R01：备份后在空目录恢复，正式记忆、版本、金额与引用关系一致', async () => {
  const h = await createHarness();
  const emptyDir = mkdtempSync(join(tmpdir(), 'aicc-restore-'));
  try {
    const projectId = await makeProject(h, '备份项目');
    const accountId = await makeAccount(h);

    await importCsv(h, 'usage.csv', ['occurred_at,input_tokens,output_tokens', '2026-09-10T00:00:00Z,1000,200'].join('\n'), {
      accountId,
      projectId,
    });

    await h.request('POST', '/api/charges', {
      accountId,
      kind: 'api',
      amountMinor: '1234',
      currency: 'CNY',
      status: 'paid',
      billingRef: 'inv-restore-1',
    });

    // 建一条记忆并更新一次，制造 v2 与两条历史版本
    const created = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
      operation: 'create',
      scope: 'project',
      projectId,
      kind: 'fact',
      title: '会经历两次版本的记忆',
      content: '第一版内容',
      sourceKind: 'manual_input',
      evidenceStatus: 'verified',
    });
    const first = await h.request<{ memory: { id: string } }>(
      'POST',
      `/api/memory-proposals/${created.body.proposalId}/review`,
      { decision: 'approve', reviewedBy: '测试用户' },
    );
    const memoryId = first.body.memory.id;

    const update = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
      operation: 'update',
      targetMemoryId: memoryId,
      baseVersion: 1,
      scope: 'project',
      projectId,
      kind: 'fact',
      title: '会经历两次版本的记忆',
      content: '第二版内容',
      sourceKind: 'manual_input',
      evidenceStatus: 'verified',
    });
    await h.request('POST', `/api/memory-proposals/${update.body.proposalId}/review`, {
      decision: 'approve',
      reviewedBy: '测试用户',
    });

    // 生成一个上下文包，验证「引用关系」也能恢复
    await h.request('POST', '/api/context-exports', { projectId, budgetKind: 'short' });

    const before = databaseCounts(h.app.db, false);

    // 备份
    const backup = await h.request<{ name: string; dir: string; manifest: { counts: Record<string, number> } }>(
      'POST',
      '/api/backups',
      { note: 'R01 用' },
    );
    assert.equal(backup.status, 200);
    assert.ok(existsSync(join(backup.body.dir, 'ai-control-center.sqlite')));
    assert.ok(existsSync(join(backup.body.dir, 'manifest.json')));
    assert.deepEqual(backup.body.manifest.counts, before, '清单里的计数应与备份前一致');

    // 恢复到空目录
    const plan = await h.request<{ plan: { sqlitePath: string; integrity: string; backupCounts: Record<string, number> } }>(
      'POST',
      `/api/backups/${backup.body.name}/restore-plan`,
    );
    assert.equal(plan.body.plan.integrity, 'ok');

    const target = join(emptyDir, 'restored.sqlite');
    // 直接复用服务层的恢复函数，目标目录是全新的
    const { restoreToEmptyPath, planRestore } = await import('../src/services/backup.js');
    const servicePlan = planRestore(h.app.ctx, backup.body.name);
    restoreToEmptyPath(servicePlan, target);
    assert.ok(existsSync(target));

    // 打开恢复出来的库，核对全部计数
    const restored = openDatabase({ filePath: target });
    try {
      migrate(restored.db); // 版本一致时应当是空操作
      const after = databaseCounts(restored.db, false);
      assert.deepEqual(after, before, '恢复后的计数应与备份前完全一致');

      // 记忆版本与引用关系
      const revisions = restored.db
        .prepare('SELECT version FROM memory_revision WHERE memory_id = ? ORDER BY version')
        .all<{ version: number }>(memoryId);
      assert.deepEqual(
        revisions.map((r) => r.version),
        [1, 2],
        '两个历史版本都在',
      );

      const refs = restored.db
        .prepare('SELECT memory_refs FROM context_export LIMIT 1')
        .get<{ memory_refs: string }>();
      assert.ok(refs);
      const parsed = JSON.parse(refs.memory_refs) as Array<{ memoryId: string; version: number }>;
      assert.equal(parsed[0]?.memoryId, memoryId);
      assert.equal(parsed[0]?.version, 2);

      const amount = restored.db
        .prepare('SELECT amount_minor, currency FROM charge WHERE billing_ref = ?')
        .get<{ amount_minor: string; currency: string }>('inv-restore-1');
      // node:sqlite 返回的是 null 原型对象，先摊平成普通对象再比较
      assert.deepEqual(amount ? { ...amount } : null, { amount_minor: '1234', currency: 'CNY' });
    } finally {
      restored.db.close();
    }
  } finally {
    h.close();
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('R01 补充：备份检验和校验——篡改过的备份会被拒绝恢复', async () => {
  const h = await createHarness();
  try {
    await makeProject(h, '校验项目');
    const backup = await h.request<{ name: string; dir: string }>('POST', '/api/backups', {});

    // 篡改数据库文件
    const dbPath = join(backup.body.dir, 'ai-control-center.sqlite');
    writeFileSync(dbPath, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 7)]));

    const plan = await h.request<{ error: { code: string; message: string } }>(
      'POST',
      `/api/backups/${backup.body.name}/restore-plan`,
    );
    assert.equal(plan.status, 400);
    assert.match(plan.body.error.message, /校验和|损坏/);
  } finally {
    h.close();
  }
});

test('R01 补充：就地恢复会先自动备份当前状态，并刷新数据库连接', async () => {
  const h = await createHarness();
  try {
    const projectId = await makeProject(h, '就地恢复项目');
    const backup = await h.request<{ name: string }>('POST', '/api/backups', {});

    // 备份之后又加了一条项目
    await makeProject(h, '备份之后新增的项目');

    const beforeRestore = await h.request<{ projects: unknown[] }>('GET', '/api/projects');
    assert.equal(beforeRestore.body.projects.length, 2);

    const restored = await h.request<{
      preRestoreBackup: string;
      counts: Record<string, number>;
    }>('POST', `/api/backups/${backup.body.name}/restore`, { confirm: true });
    assert.equal(restored.status, 200);
    assert.ok(existsSync(restored.body.preRestoreBackup));
    assert.notEqual(
      restored.body.preRestoreBackup,
      join(h.config.backupDir, backup.body.name),
      '恢复前的自动备份是另一个目录，不能覆盖掉用户手动做的那份',
    );

    // 连接已重开，服务仍然可用，且回到备份时的状态
    const afterRestore = await h.request<{ projects: Array<{ id: string }> }>('GET', '/api/projects');
    assert.equal(afterRestore.status, 200);
    assert.equal(afterRestore.body.projects.length, 1);
    assert.equal(afterRestore.body.projects[0]?.id, projectId);

    // 恢复动作本身也被审计
    const audit = await h.request<{ events: Array<{ action: string }> }>('GET', '/api/audit?limit=20');
    assert.ok(audit.body.events.some((e) => e.action === 'backup.restore'));
  } finally {
    h.close();
  }
});

test('R02：未知导入字段与坏行 → 局部失败，好的行仍然入库，手动功能不受影响', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    const csv = [
      'occurred_at,input_tokens,output_tokens,完全未知的列,另一个未知列',
      '2026-09-11T00:00:00Z,100,20,x,y',
      '2026-09-11T01:00:00Z,not-a-number,30,p,q',      // 坏值：按未知处理并告警
      '不是时间,50,10,z,w',                             // 坏时间
      '2026-09-11T03:00:00Z,,,只有未知列',              // 没有任何可识别数值 → 拒绝
    ].join('\n');

    const result = await importCsv(h, 'messy.csv', csv, { accountId });
    assert.equal(result.status, 200);

    assert.equal(result.body.totalRows, 4);
    assert.equal(result.body.acceptedRows, 3, '3 行成功（含降级处理的行）');
    assert.equal(result.body.rejectedRows, 1, '1 行因没有任何可识别数值被拒绝');

    const warnings = (result.body.warnings as string[]).join('\n');
    assert.match(warnings, /以下列未被识别/);
    assert.match(warnings, /完全未知的列/);
    assert.match(warnings, /不是非负整数/);
    assert.match(warnings, /无法解析，按「时间未知」处理/);

    const errors = result.body.errors as Array<{ row: number; message: string }>;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.row, 5, '错误报告精确到行号');

    // 未知列的原始值仍然保留，没有被丢弃
    const usage = await h.request<{ items: Array<{ rawUsage: Record<string, unknown> }> }>('GET', '/api/usage');
    const withUnknown = usage.body.items.find((i) => '完全未知的列' in (i.rawUsage ?? {}));
    assert.ok(withUnknown, '未知列的原始值必须保留在 raw_usage 里，而不是被猜测含义');

    // 手动功能仍然可用
    const manual = await h.request('POST', '/api/usage', {
      accountId,
      rawUsage: { input_tokens: 1, output_tokens: 1 },
      basis: 'openai_inclusive',
      measurementQuality: 'estimated',
    });
    assert.equal(manual.status, 200);

    // 已批准的记忆与手动功能都不受导入失败影响
    const selfCheck = await h.request<{ checks: unknown[] }>('GET', '/api/self-check');
    assert.equal(selfCheck.status, 200);
  } finally {
    h.close();
  }
});

test('R02 补充：采集器崩溃式的输入（空文件 / 只有表头）不污染既有数据', async () => {
  const h = await createHarness();
  try {
    const accountId = await makeAccount(h);
    await importCsv(h, 'ok.csv', ['occurred_at,input_tokens', '2026-09-12T00:00:00Z,10'].join('\n'), { accountId });

    const empty = await importCsv(h, 'empty.csv', '', { accountId });
    assert.equal(empty.status, 400, '空内容在 schema 层就被拒绝');
    assert.equal((empty.body.error as { code: string }).code, 'invalid_input');

    const whitespaceOnly = await importCsv(h, 'blank.csv', '   \n  \n', { accountId });
    assert.equal(whitespaceOnly.status, 200);
    assert.equal(whitespaceOnly.body.totalRows, 0, '只有空白行的文件不产生任何记录');

    const headerOnly = await importCsv(h, 'header-only.csv', 'occurred_at,input_tokens', { accountId });
    assert.equal(headerOnly.status, 200);
    assert.equal(headerOnly.body.acceptedRows, 0);
    assert.equal(headerOnly.body.rejectedRows, 0);

    const usage = await h.request<{ total: number }>('GET', '/api/usage');
    assert.equal(usage.body.total, 1, '既有数据一行都没变');
  } finally {
    h.close();
  }
});

test('R03：恶意网页无法调用本地写接口（Origin / CSRF / 认证 三道校验）', async () => {
  const h = await createHarness();
  try {
    // 1) 缺少 CSRF 自定义头 → 403
    //    这里显式给出同源 Host 与 Origin，让请求**通过** Origin 校验，
    //    从而单独验证 CSRF 这一层（否则会被更靠前的 Origin 检查拦掉，测不到这一层）。
    const noCsrf = await h.raw(
      'POST',
      '/api/projects',
      { title: '来自恶意页面' },
      { origin: `http://${HOST}`, host: HOST },
    );
    assert.equal(noCsrf.status, 403);
    assert.equal((noCsrf.body as { error: { code: string } }).error.code, 'origin_rejected');
    assert.match(String((noCsrf.body as { error: { message: string } }).error.message), /CSRF/);

    // 2) 带了自定义头，但 Origin 是外部站点 → 403
    const foreignOrigin = await h.raw(
      'POST',
      '/api/projects',
      { title: '来自恶意页面' },
      { 'x-aicc-request': '1', origin: 'https://evil.example.com', host: HOST },
    );
    assert.equal(foreignOrigin.status, 403);
    assert.match(String((foreignOrigin.body as { error: { message: string } }).error.message), /Origin/);

    // 3) Origin 合法（同源）但没有会话 → 401
    const noSession = await h.raw(
      'POST',
      '/api/projects',
      { title: '没有身份' },
      { 'x-aicc-request': '1', origin: `http://${HOST}`, host: HOST },
    );
    assert.equal(noSession.status, 401);

    // 4) Host 头不是回环地址 → 403（即使能连上本地端口）
    const badHost = await h.raw('GET', '/api/overview', undefined, { host: 'evil.example.com' });
    assert.equal(badHost.status, 403);
    assert.match(String((badHost.body as { error: { message: string } }).error.message), /回环地址/);

    // 5) 配对码错误 → 401，且连续错误会被限流
    let sawRateLimit = false;
    let lastStatus = 0;
    for (let i = 0; i < 7; i += 1) {
      const res = await h.raw(
        'POST',
        '/api/session/pair',
        { code: 'WRONGCODE', label: '攻击者' },
        { 'x-aicc-request': '1', host: HOST },
      );
      lastStatus = res.status;
      if (res.status === 429) sawRateLimit = true;
    }
    assert.equal(lastStatus, 429, '连续 7 次错误配对码后应被限流');
    assert.equal(sawRateLimit, true);

    // 6) 项目没有被创建
    const projects = await h.request<{ projects: unknown[] }>('GET', '/api/projects');
    assert.equal(projects.body.projects.length, 0);

    // 7) 拒绝动作都留下了审计记录
    const audit = await h.request<{ events: Array<{ action: string; result: string }> }>('GET', '/api/audit?limit=50');
    assert.ok(
      audit.body.events.some((e) => e.result === 'rejected' || e.action === 'auth.reject'),
      '被拒绝的动作必须留痕',
    );
  } finally {
    h.close();
  }
});

test('M03：代理凭据读取其他项目记忆被拒，并留下拒绝日志', async () => {
  const h = await createHarness();
  try {
    const projectA = await makeProject(h, 'A 项目');
    const projectB = await makeProject(h, 'B 项目');

    const seed = async (projectId: string, title: string): Promise<string> => {
      const p = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
        operation: 'create',
        scope: 'project',
        projectId,
        kind: 'fact',
        title,
        content: `内容：${title}`,
        sourceKind: 'manual_input',
        evidenceStatus: 'verified',
      });
      const r = await h.request<{ memory: { id: string } }>(
        'POST',
        `/api/memory-proposals/${p.body.proposalId}/review`,
        { decision: 'approve', reviewedBy: '测试用户' },
      );
      return r.body.memory.id;
    };

    const memoryA = await seed(projectA, 'A 的记忆');
    const memoryB = await seed(projectB, 'B 的机密记忆');

    const client = await h.request<{ client: { id: string } }>('POST', '/api/clients', {
      kind: 'cursor',
      displayName: '只能看 A 的客户端',
    });
    const credential = await h.request<{ token: string }>('POST', '/api/credentials', {
      clientId: client.body.client.id,
      label: 'A 项目专用',
      projectIds: [projectA],
      scopes: ['memory_search', 'memory_get', 'context_build'],
    });
    const token = credential.body.token;
    const auth = { authorization: `Bearer ${token}` };

    // 搜列表：即使不指定项目，也只能看到 A 的
    const list = await h.anonymous('GET', '/api/memories', undefined, auth);
    assert.equal(list.status, 200);
    const ids = (list.body as { items: Array<{ id: string }> }).items.map((i) => i.id);
    assert.deepEqual(ids, [memoryA], 'B 项目的记忆不出现在列表里');

    // 直接按 ID 取 B 的记忆：两条路径都必须被拒
    const direct = await h.anonymous('POST', '/api/agent/memory_get', { memory_id: memoryB }, auth);
    assert.equal(direct.status, 403);
    assert.match(String((direct.body as { error: { message: string } }).error.message), /未被授权访问/);

    const httpGet = await h.anonymous('GET', `/api/memories/${memoryB}`, undefined, auth);
    assert.equal(httpGet.status, 403);

    // 生成 B 的上下文包：被拒
    const ctx = await h.anonymous('POST', '/api/agent/context_build', { project_id: projectB }, auth);
    assert.equal(ctx.status, 403);

    // 拒绝日志在
    const audit = await h.request<{ events: Array<{ action: string; result: string; detail: Record<string, unknown> }> }>(
      'GET',
      '/api/audit?limit=50',
    );
    const rejections = audit.body.events.filter((e) => e.result === 'rejected');
    assert.ok(rejections.length >= 2, '至少记下了两次拒绝');
    assert.ok(
      rejections.some((e) => JSON.stringify(e.detail).includes('project_scope_violation')),
      '拒绝原因要写清楚是项目范围越权',
    );
  } finally {
    h.close();
  }
});
