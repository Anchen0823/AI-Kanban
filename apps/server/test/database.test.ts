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
