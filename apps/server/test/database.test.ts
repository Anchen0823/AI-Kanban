import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, transactionDepth, tx } from '../src/db/database.js';
import { createHarness } from './helpers.js';

/**
 * 数据层自身的测试：事务语义与 demo 隔离。
 *
 * 这两类问题都不会在单条服务的单元测试里暴露 —— 它们只在「服务调用服务」
 * 或「先有真实数据再操作示例数据」时出现，所以必须专门测。
 */

function withTempDb<T>(fn: (db: ReturnType<typeof openDatabase>['db'], dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aicc-db-'));
  const opened = openDatabase({ filePath: join(dir, 'test.sqlite') });
  migrate(opened.db);
  try {
    return fn(opened.db, dir);
  } finally {
    opened.db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶发占用 */
    }
  }
}

test('事务可重入：嵌套 tx() 不会抛 "cannot start a transaction within a transaction"', () => {
  withTempDb((db) => {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');

    const result = tx(db, () => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
      const inner = tx(db, () => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
        // 再套一层，确认深度计数正确
        return tx(db, () => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('deepest');
          return 'ok';
        });
      });
      return inner;
    });

    assert.equal(result, 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get<{ n: number }>()?.n, 3);
    assert.equal(transactionDepth(db), 0, '事务结束后深度必须归零');
  });
});

test('嵌套事务里内层抛错 → 整个外层事务一起回滚', () => {
  withTempDb((db) => {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');

    assert.throws(
      () =>
        tx(db, () => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
          tx(db, () => {
            db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
            throw new Error('内层失败');
          });
        }),
      /内层失败/,
    );

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM t').get<{ n: number }>()?.n,
      0,
      '外层写入也必须被回滚，不能留下半截数据',
    );
    assert.equal(transactionDepth(db), 0);
  });
});

test('事务失败后连接仍然可用（深度被正确复位）', () => {
  withTempDb((db) => {
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    assert.throws(() =>
      tx(db, () => {
        throw new Error('boom');
      }),
    );

    // 如果深度没复位，这一次调用会被当成「已在事务里」，从而不提交也不回滚
    tx(db, () => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('after-failure');
    });

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get<{ n: number }>()?.n, 1);
  });
});

test('先有真实数据时仍然可以生成示例数据（回归）', async () => {
  const h = await createHarness();
  try {
    // 关键前提：先建真实客户端与项目。早期实现用「表里有没有数据」判断，
    // 导致此时生成示例数据会报「已存在 demo 数据」。
    await h.request('POST', '/api/clients', { kind: 'codex', displayName: '真实客户端' });
    await h.request('POST', '/api/projects', { title: '真实项目' });
    await h.request('POST', '/api/accounts', { provider: '真实供应商', alias: '真实账户', currency: 'CNY' });

    const seeded = await h.request<{ created: Record<string, number> }>('POST', '/api/demo/seed');
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    assert.ok((seeded.body.created.clients as number) > 0);

    // 真实数据一行都没被动
    const projects = await h.request<{ projects: Array<{ title: string }> }>('GET', '/api/projects');
    assert.ok(projects.body.projects.some((p) => p.title === '真实项目'), '真实项目还在');

    const status = await h.request<{ hasDemoData: boolean; counts: Record<string, number> }>('GET', '/api/demo/status');
    assert.equal(status.body.hasDemoData, true);
    assert.ok(Object.keys(status.body.counts).length > 0);

    // 重复生成会被明确拒绝，而不是产生两套示例
    const again = await h.request<{ error: { message: string } }>('POST', '/api/demo/seed');
    assert.equal(again.status, 500);
    assert.match(again.body.error.message, /已存在示例数据/);

    // 清空只删示例
    const reset = await h.request<{ totalDeleted: number }>('POST', '/api/demo/reset');
    assert.equal(reset.status, 200);
    assert.ok(reset.body.totalDeleted > 0);

    const afterReset = await h.request<{ projects: Array<{ title: string }> }>('GET', '/api/projects');
    assert.equal(afterReset.body.projects.length, 1);
    assert.equal(afterReset.body.projects[0]?.title, '真实项目');

    const finalStatus = await h.request<{ hasDemoData: boolean }>('GET', '/api/demo/status');
    assert.equal(finalStatus.body.hasDemoData, false);
  } finally {
    h.close();
  }
});

test('工作区隔离是双向的：示例不污染真实，真实也不混进示例', async () => {
  const h = await createHarness();
  try {
    // 真实数据：一个账户、一条用量、一个项目、一条记忆
    const accountId = (
      await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
        provider: '真实供应商',
        alias: '真实账户',
        currency: 'CNY',
      })
    ).body.account.id;

    await h.request('POST', '/api/usage', {
      accountId,
      rawUsage: { input_tokens: 5000, output_tokens: 1000 },
      basis: 'openai_inclusive',
      measurementQuality: 'provider_reported',
    });

    const project = await h.request<{ project: { id: string } }>('POST', '/api/projects', {
      title: '真实项目',
    });
    const realProjectId = project.body.project.id;

    const realProposal = await h.request<{ proposalId: string }>('POST', '/api/memory-proposals', {
      operation: 'create',
      scope: 'project',
      projectId: realProjectId,
      kind: 'fact',
      title: '真实记忆标题',
      content: '这是真实工作区里的内容。',
      sourceKind: 'manual_input',
      evidenceStatus: 'verified',
    });
    await h.request('POST', `/api/memory-proposals/${realProposal.body.proposalId}/review`, {
      decision: 'approve',
      reviewedBy: '测试用户',
    });

    // 生成示例数据
    const seeded = await h.request('POST', '/api/demo/seed');
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

    /* ---- 真实视图：一行示例都不出现 ---- */
    const realOverview = await h.request<{
      workspace: string;
      tokens: { observed: number | null };
      quota: { groups: Array<{ buckets: unknown[] }> };
      memory: { pendingProposals: number; active: number };
    }>('GET', '/api/overview');
    assert.match(realOverview.body.workspace, /真实/);
    assert.equal(realOverview.body.tokens.observed, 6000, '真实 token 不受示例影响');
    assert.equal(realOverview.body.quota.groups.length, 0, '示例额度桶不出现在真实视图');
    assert.equal(realOverview.body.memory.pendingProposals, 0);
    assert.equal(realOverview.body.memory.active, 1, '只有那条真实记忆');

    const realMemories = await h.request<{ items: Array<{ title: string }> }>('GET', '/api/memories');
    assert.deepEqual(
      realMemories.body.items.map((m) => m.title),
      ['真实记忆标题'],
    );

    /* ---- 示例视图：示例数据必须真的能看到，且不含真实数据 ---- */
    const demoOverview = await h.request<{
      workspace: string;
      tokens: { observed: number | null; coverage: string };
      quota: { groups: Array<{ buckets: unknown[] }> };
      memory: { pendingProposals: number; active: number };
      usage: { suspectDuplicates: number };
      attention: Array<{ level: string; text: string }>;
    }>('GET', '/api/overview?workspace=demo');

    assert.match(demoOverview.body.workspace, /示例/);
    assert.ok(
      demoOverview.body.quota.groups.length > 0,
      '示例额度桶必须能在示例工作区里看到 —— 否则「生成示例数据」等于白生成',
    );
    assert.equal(
      demoOverview.body.memory.pendingProposals,
      2,
      '示例里刻意留了 2 条待审候选',
    );
    assert.equal(demoOverview.body.memory.active, 1, '示例记忆 1 条');
    assert.ok(demoOverview.body.usage.suspectDuplicates > 0, '示例里刻意留了疑似重复记录');
    assert.ok(
      demoOverview.body.attention.some((a) => a.text.includes('示例数据工作区')),
      '示例视图必须明确标注自己是示例',
    );

    const demoMemories = await h.request<{ items: Array<{ title: string }> }>(
      'GET',
      '/api/memories?workspace=demo',
    );
    const demoTitles = demoMemories.body.items.map((m) => m.title);
    assert.ok(demoTitles.length > 0, '示例记忆可见');
    assert.ok(
      !demoTitles.includes('真实记忆标题'),
      '真实记忆不得出现在示例工作区里（隔离是双向的）',
    );

    const demoUsage = await h.request<{ total: number; totals: { tokenValue: number | null } }>(
      'GET',
      '/api/usage?workspace=demo&includeNonPrimary=true',
    );
    assert.ok(demoUsage.body.total > 0, '示例用量明细可见');

    const realUsage = await h.request<{ total: number }>('GET', '/api/usage?includeNonPrimary=true');
    assert.equal(realUsage.body.total, 1, '真实用量仍然只有那一条');

    /* ---- 默认值必须是「真实」 ---- */
    const noParam = await h.request<{ workspace: string }>('GET', '/api/overview');
    assert.match(noParam.body.workspace, /真实/, '不传 workspace 时必须默认真实工作区');
  } finally {
    h.close();
  }
});

test('示例数据不进入真实统计，清空后也不留残影', async () => {
  const h = await createHarness();
  try {
    const accountId = (await h.request<{ account: { id: string } }>('POST', '/api/accounts', {
      provider: '真实',
      alias: '真实账户',
      currency: 'CNY',
    })).body.account.id;

    await h.request('POST', '/api/usage', {
      accountId,
      rawUsage: { input_tokens: 1000, output_tokens: 200 },
      basis: 'openai_inclusive',
      measurementQuality: 'provider_reported',
    });

    await h.request('POST', '/api/demo/seed');

    const withDemo = await h.request<{ tokens: { observed: number | null } }>('GET', '/api/overview');
    assert.equal(withDemo.body.tokens.observed, 1200, '示例数据不得计入真实统计');

    await h.request('POST', '/api/demo/reset');

    const afterReset = await h.request<{ tokens: { observed: number | null } }>('GET', '/api/overview');
    assert.equal(afterReset.body.tokens.observed, 1200, '清空示例后真实数据仍然完整');
  } finally {
    h.close();
  }
});
