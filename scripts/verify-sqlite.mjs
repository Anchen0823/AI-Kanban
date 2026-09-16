/*
 * 最小兼容性验证脚本（设计稿 §9.1：先验证 Windows 安装与 SQLite 驱动的最小兼容样例）。
 *
 * 目的：在写任何业务代码之前，确认本机 Node 运行时能打开 SQLite、
 * 能建表、能写事务、能回滚、能热备份。任何一项失败都不应继续实现。
 *
 * 用法：node scripts/verify-sqlite.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const report = [];
const fail = (name, err) => {
  report.push(`FAIL  ${name}: ${err?.message ?? err}`);
};
const pass = (name, extra = '') => {
  report.push(`OK    ${name}${extra ? ' — ' + extra : ''}`);
};

let driver = null;
let driverName = '';

// 优先尝试 better-sqlite3，回退到 Node 内置 node:sqlite。
try {
  const mod = require('better-sqlite3');
  const probe = new mod(':memory:');
  probe.exec('CREATE TABLE t(x INTEGER)');
  probe.close();
  driver = mod;
  driverName = 'better-sqlite3';
} catch (err) {
  try {
    const mod = require('node:sqlite');
    const probe = new mod.DatabaseSync(':memory:');
    probe.exec('CREATE TABLE t(x INTEGER)');
    probe.close();
    driver = mod.DatabaseSync;
    driverName = 'node:sqlite';
  } catch (err2) {
    fail('driver', `${err.message} / ${err2.message}`);
  }
}

if (!driver) {
  console.log(report.join('\n'));
  process.exit(1);
}
pass('driver', driverName);

const dir = mkdtempSync(join(tmpdir(), 'aicc-sqlite-'));
const file = join(dir, 'probe.sqlite');
let db;

try {
  db = new driver(file);
  pass('open');
} catch (err) {
  fail('open', err);
}

if (db) {
  try {
    db.exec('PRAGMA journal_mode = WAL');
    pass('pragma journal_mode=WAL');
  } catch (err) {
    fail('journal_mode', err);
  }
  try {
    db.exec(`CREATE TABLE charge (
      id TEXT PRIMARY KEY,
      amount_minor TEXT NOT NULL,
      currency TEXT NOT NULL
    )`);
    pass('create table');
  } catch (err) {
    fail('create table', err);
  }
  try {
    const ins = db.prepare('INSERT INTO charge VALUES (?, ?, ?)');
    ins.run('c1', '1999', 'CNY');
    ins.run('c2', '2500', 'USD');
    const rows = db.prepare('SELECT COUNT(*) AS n FROM charge').get();
    if (rows.n === 2) pass('insert + select', `n=${rows.n}`);
    else fail('insert + select', `expected 2, got ${rows.n}`);
  } catch (err) {
    fail('insert + select', err);
  }
  try {
    // 金额以字符串保存十进制定点整数，验证大整数不丢精度
    db.prepare('INSERT INTO charge VALUES (?, ?, ?)').run('c3', '9007199254740993', 'CNY');
    const r = db.prepare('SELECT amount_minor FROM charge WHERE id = ?').get('c3');
    if (r.amount_minor === '9007199254740993') pass('bigint as text');
    else fail('bigint as text', `got ${r.amount_minor}`);
  } catch (err) {
    fail('bigint as text', err);
  }
  try {
    db.exec('BEGIN');
    db.prepare('INSERT INTO charge VALUES (?, ?, ?)').run('c4', '1', 'CNY');
    db.exec('ROLLBACK');
    const n = db.prepare('SELECT COUNT(*) AS n FROM charge').get().n;
    if (n === 3) pass('transaction rollback');
    else fail('transaction rollback', `expected 3, got ${n}`);
  } catch (err) {
    fail('transaction rollback', err);
  }
  try {
    db.exec('CREATE UNIQUE INDEX ux_probe ON charge(id)');
    let threw = false;
    try {
      db.prepare('INSERT INTO charge VALUES (?, ?, ?)').run('c1', '1', 'CNY');
    } catch {
      threw = true;
    }
    if (threw) pass('unique constraint enforced');
    else fail('unique constraint enforced', 'duplicate accepted');
  } catch (err) {
    fail('unique constraint enforced', err);
  }
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    pass('wal_checkpoint(TRUNCATE)  — 备份前必须做的一步');
  } catch (err) {
    fail('wal_checkpoint', err);
  }

  // 热备份：node:sqlite 有 backup()，better-sqlite3 有 .backup()
  const backupFile = join(dir, 'backup.sqlite');
  try {
    if (typeof driver === 'function' && driverName === 'node:sqlite') {
      const { backup } = require('node:sqlite');
      await backup(db, backupFile);
      pass('backup (node:sqlite backup())');
    } else if (typeof db.backup === 'function') {
      await db.backup(backupFile);
      pass('backup (better-sqlite3 .backup())');
    } else {
      db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);
      pass('backup (VACUUM INTO fallback)');
    }
    const size = statSync(backupFile).size;
    pass('backup file written', `${size} bytes`);
  } catch (err) {
    fail('backup', err);
  }
  try {
    db.close();
    pass('close');
  } catch (err) {
    fail('close', err);
  }
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

const summary = {
  driver: driverName,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  ok: report.every((l) => l.startsWith('OK')),
  report,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
