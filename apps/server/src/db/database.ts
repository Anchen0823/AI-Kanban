/**
 * SQLite 驱动适配层。
 *
 * 为什么要有这一层：设计稿 §9.1 要求「先验证 Windows 安装与 SQLite 驱动的
 * 最小兼容样例」。本机实测结论是 `better-sqlite3` 没有预编译包（需要 MSVC 现场编译），
 * 而 Node 22 内置的 `node:sqlite` 全部检查项通过。所以默认走内置驱动，
 * 但只要装了 better-sqlite3 就优先用它（它更成熟、生态更广）。
 *
 * 两者 API 形状接近（同步的 exec / prepare / run / get / all），
 * 业务代码只依赖下面这两个接口，换驱动不需要改服务层。
 *
 * 参数清洗很重要：`node:sqlite` 对 `boolean` 和 `undefined` 会直接抛 TypeError。
 * SQLite 本身也没有布尔类型。所以在这一层统一转换，业务层永远只传
 * string / number / bigint / null / Uint8Array。
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from './schema.js';

const require = createRequire(import.meta.url);

export type SqlValue = string | number | bigint | null | Uint8Array;

/** 业务层允许冒泡下来的宽松类型；由本层负责收敛成 SqlValue。 */
export type SqlParam = SqlValue | boolean | undefined | Date;

export interface DbStatement {
  run(...params: SqlParam[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(...params: SqlParam[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlParam[]): T[];
}

export interface DbConnection {
  readonly driver: string;
  readonly filePath: string;
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  /** 一致性热备份。内部已处理 WAL。 */
  backupTo(targetPath: string): void;
  close(): void;
  /** `PRAGMA wal_checkpoint(TRUNCATE)`，备份与测试前后使用。 */
  checkpoint(): void;
}

/* ------------------------------------------------------------------ */
/* 参数清洗                                                            */
/* ------------------------------------------------------------------ */

export function toBind(value: SqlParam): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`不能把非有限数值写入数据库：${value}`);
    }
    return value;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 驱动实现                                                            */
/* ------------------------------------------------------------------ */

interface RawStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
}

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
];

function wrap(raw: RawDatabase, driver: string, filePath: string): DbConnection {
  return {
    driver,
    filePath,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => {
          const r = stmt.run(...params.map(toBind));
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
        },
        get: <T,>(...params: SqlParam[]) => stmt.get(...params.map(toBind)) as T | undefined,
        all: <T,>(...params: SqlParam[]) => stmt.all(...params.map(toBind)) as T[],
      };
    },
    backupTo: (targetPath) => {
      // 备份前先合并 WAL。否则直接拷主文件会丢掉尚未合并的事务（§14.2）。
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      if (existsSync(targetPath)) rmSync(targetPath, { force: true });
      mkdirSync(dirname(targetPath), { recursive: true });
      // VACUUM INTO 产出一致性快照，且不依赖驱动专有 API。
      raw.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
    },
    checkpoint: () => {
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },
    close: () => raw.close(),
  };
}

export interface OpenOptions {
  filePath: string;
  /** 测试里可以强制指定驱动。 */
  prefer?: 'better-sqlite3' | 'node:sqlite';
}

export interface OpenResult {
  db: DbConnection;
  /** 实际用上的驱动名，会写进启动日志和自检结果。 */
  driver: string;
  /** 尝试过的驱动及失败原因，便于在另一台机器上复现问题。 */
  attempts: Array<{ driver: string; ok: boolean; error?: string }>;
}

export function openDatabase(options: OpenOptions): OpenResult {
  const attempts: Array<{ driver: string; ok: boolean; error?: string }> = [];
  const order: Array<'better-sqlite3' | 'node:sqlite'> = options.prefer
    ? [options.prefer]
    : ['better-sqlite3', 'node:sqlite'];

  mkdirSync(dirname(options.filePath), { recursive: true });

  for (const name of order) {
    try {
      if (name === 'better-sqlite3') {
        const mod = require('better-sqlite3') as new (p: string) => RawDatabase;
        const raw = new mod(options.filePath);
        raw.exec('PRAGMA journal_mode = WAL');
        const db = wrap(raw, name, options.filePath);
        applyPragmas(db);
        attempts.push({ driver: name, ok: true });
        return { db, driver: name, attempts };
      }

      const mod = require('node:sqlite') as { DatabaseSync: new (p: string) => RawDatabase };
      const raw = new mod.DatabaseSync(options.filePath);
      const db = wrap(raw, name, options.filePath);
      applyPragmas(db);
      attempts.push({ driver: name, ok: true });
      return { db, driver: name, attempts };
    } catch (err) {
      attempts.push({ driver: name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const detail = attempts.map((a) => `  - ${a.driver}: ${a.error}`).join('\n');
  throw new Error(`无法打开 SQLite 数据库 ${options.filePath}。已尝试：\n${detail}`);
}

function applyPragmas(db: DbConnection): void {
  for (const pragma of PRAGMAS) db.exec(pragma);
}

/* ------------------------------------------------------------------ */
/* 迁移                                                                */
/* ------------------------------------------------------------------ */

export interface MigrationResult {
  applied: number[];
  fromVersion: number;
  toVersion: number;
}

export function currentVersion(db: DbConnection): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')
    .get<{ v: number }>();
  return row?.v ?? 0;
}

export function migrate(db: DbConnection, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const from = currentVersion(db);
  const pending = [...migrations].filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const applied: number[] = [];

  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `迁移 v${migration.version}（${migration.name}）失败，已回滚：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { applied, fromVersion: from, toVersion: currentVersion(db) };
}

/* ------------------------------------------------------------------ */
/* 事务                                                                */
/* ------------------------------------------------------------------ */

export class TxAbort extends Error {
  constructor(public readonly code: string, message: string, public readonly detail?: unknown) {
    super(message);
    this.name = 'TxAbort';
  }
}

/**
 * 当前连接的事务嵌套深度。
 *
 * 为什么需要它：SQLite 的 `BEGIN` **不可嵌套**。而服务层天然会出现嵌套调用 ——
 * 例如「生成示例数据」在自己事务里调用「创建候选」，后者也要保证原子性。
 * 早期实现直接 `BEGIN`，结果是 `cannot start a transaction within a transaction`，
 * 而且只在同时走了这两条路径时才会出现（单独测每个服务都是好的）。
 *
 * 语义：嵌套调用**加入外层事务**，不再单独提交。内层失败会连带回滚整个外层事务 ——
 * 这正是我们想要的「要么全成功要么全回滚」。
 */
const txDepth = new WeakMap<DbConnection, number>();

export function transactionDepth(db: DbConnection): number {
  return txDepth.get(db) ?? 0;
}

/**
 * 同步事务。业务写入、记忆版本与审计必须同一事务提交（§9.2）。
 *
 * 可重入：已经在外层事务里时，直接执行不再 BEGIN。
 * 抛出的异常一律回滚。`TxAbort` 用于携带一个有意义的错误码给 HTTP 层。
 */
export function tx<T>(db: DbConnection, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;

  if (depth > 0) {
    txDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      txDepth.set(db, depth);
    }
  }

  db.exec('BEGIN');
  txDepth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚本身失败（例如连接已断）时不要让原始错误被覆盖
    }
    throw err;
  } finally {
    txDepth.set(db, 0);
  }
}

export { SCHEMA_VERSION };
