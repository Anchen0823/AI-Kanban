/**
 * 备份与恢复（设计稿 §14.2，验收项 R01）。
 *
 * 关键约束：**不能直接拷主文件**。WAL 模式下未合并的事务还在 `-wal` 里，
 * 拷出来的 `.sqlite` 会缺少最近提交的数据，而且它在多数情况下看起来完全正常 ——
 * 直到你真正需要恢复时才发现少了一批记录。
 *
 * 所以这里的流程是：`wal_checkpoint(TRUNCATE)` → `VACUUM INTO` → 校验和清单。
 * 备份件带 schema 版本与每一行的哈希，恢复前先校验再切换。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { databaseCounts, type DemoCounts } from '../db/repos/system.js';
import { TxAbort, SCHEMA_VERSION } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { ServiceContext } from '../service-context.js';
import { audit } from './audit.js';

export interface BackupManifest {
  formatVersion: 1;
  name: string;
  createdAt: string;
  schemaVersion: number;
  sqliteDriver: string;
  appVersion: string;
  sourceDbFile: string;
  counts: DemoCounts;
  files: Array<{ name: string; bytes: number; sha256: string }>;
  notes: string[];
}

export interface BackupReport {
  name: string;
  dir: string;
  manifest: BackupManifest;
  files: string[];
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function backupName(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes(),
  )}${pad(d.getUTCSeconds())}`;
}

export function createBackup(ctx: ServiceContext, options: { note?: string | null } = {}): BackupReport {
  // 同一秒内做两次备份（例如「手动备份」紧接着「恢复前的自动备份」）不能撞名。
  // 撞名就抛错会让恢复流程半途失败，那时库已经被关掉了。
  const base = backupName(ctx.now());
  let name = base;
  let dir = join(ctx.config.backupDir, name);
  let suffix = 2;
  while (existsSync(dir)) {
    name = `${base}-${suffix}`;
    dir = join(ctx.config.backupDir, name);
    suffix += 1;
  }
  mkdirSync(dir, { recursive: true });

  const sqlitePath = join(dir, 'ai-control-center.sqlite');
  ctx.db.backupTo(sqlitePath);

  const manifest: BackupManifest = {
    formatVersion: 1,
    name,
    createdAt: new Date(ctx.now()).toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sqliteDriver: ctx.driver,
    appVersion: '0.1.0',
    sourceDbFile: basename(ctx.db.filePath),
    counts: databaseCounts(ctx.db, false),
    files: [{ name: 'ai-control-center.sqlite', bytes: statSync(sqlitePath).size, sha256: sha256File(sqlitePath) }],
    notes: [
      '备份前已执行 wal_checkpoint(TRUNCATE)，未合并的 WAL 数据已包含在内。',
      '备份件默认不进入 Git、不上传到任何云端（§14.2）。',
      '包含敏感内容的普通本地文件并非天然加密，请自行选择受保护的存储位置。',
      options.note ? `备注：${options.note}` : '未填写备注。',
    ],
  };

  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  audit(ctx, {
    action: 'backup.create',
    entityType: 'backup',
    entityId: name,
    detail: { dir, bytes: manifest.files[0]?.bytes ?? 0, schemaVersion: SCHEMA_VERSION, driver: ctx.driver },
  });

  return { name, dir, manifest, files: manifest.files.map((f) => join(dir, f.name)) };
}

export interface BackupListing {
  name: string;
  dir: string;
  createdAt: string;
  schemaVersion: number;
  bytes: number;
  counts: DemoCounts;
  /** 清单是否可读、校验和是否仍然匹配。 */
  integrity: 'ok' | 'checksum_mismatch' | 'manifest_missing' | 'file_missing';
}

export function listBackups(config: AppConfig): BackupListing[] {
  if (!existsSync(config.backupDir)) return [];
  const out: BackupListing[] = [];
  for (const entry of readdirSync(config.backupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(config.backupDir, entry.name);
    out.push(inspectBackup(dir));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function inspectBackup(dir: string): BackupListing {
  const manifestPath = join(dir, 'manifest.json');
  const sqlitePath = join(dir, 'ai-control-center.sqlite');

  if (!existsSync(manifestPath)) {
    return {
      name: basename(dir),
      dir,
      createdAt: '',
      schemaVersion: 0,
      bytes: existsSync(sqlitePath) ? statSync(sqlitePath).size : 0,
      counts: {},
      integrity: 'manifest_missing',
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  if (!existsSync(sqlitePath)) {
    return {
      name: manifest.name,
      dir,
      createdAt: manifest.createdAt,
      schemaVersion: manifest.schemaVersion,
      bytes: 0,
      counts: manifest.counts,
      integrity: 'file_missing',
    };
  }

  const expected = manifest.files.find((f) => f.name === 'ai-control-center.sqlite');
  const actual = sha256File(sqlitePath);
  const integrity = expected && expected.sha256 !== actual ? 'checksum_mismatch' : 'ok';

  return {
    name: manifest.name,
    dir,
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    bytes: statSync(sqlitePath).size,
    counts: manifest.counts,
    integrity,
  };
}

export interface RestorePlan {
  backupName: string;
  dir: string;
  sqlitePath: string;
  integrity: BackupListing['integrity'];
  backupSchemaVersion: number;
  currentSchemaVersion: number;
  /** 恢复后会被覆盖的当前数据规模，用于展示「你将失去什么」。 */
  currentCounts: DemoCounts;
  backupCounts: DemoCounts;
  warnings: string[];
  /** 必须先备份当前库，否则用户无法退回。 */
  requiresPreBackup: boolean;
}

/**
 * 恢复前的校验与预览。**不修改任何东西。**
 * 用户要先看清「恢复后会变成什么样」再确认。
 */
export function planRestore(ctx: ServiceContext, name: string): RestorePlan {
  const dir = join(ctx.config.backupDir, name);
  if (!existsSync(dir)) {
    throw new TxAbort('not_found', `备份不存在：${name}`);
  }
  const listing = inspectBackup(dir);
  const warnings: string[] = [];

  if (listing.integrity === 'manifest_missing') {
    throw new TxAbort('invalid_input', '该目录缺少 manifest.json，无法校验完整性，已拒绝恢复');
  }
  if (listing.integrity === 'file_missing') {
    throw new TxAbort('invalid_input', '该目录里没有数据库文件，已拒绝恢复');
  }
  if (listing.integrity === 'checksum_mismatch') {
    throw new TxAbort(
      'invalid_input',
      '备份文件的校验和与清单不一致，文件可能已损坏或被修改，已拒绝恢复',
    );
  }
  if (listing.schemaVersion > SCHEMA_VERSION) {
    throw new TxAbort(
      'invalid_state',
      `备份的 schema 版本（v${listing.schemaVersion}）高于本程序支持的版本（v${SCHEMA_VERSION}）。请先升级程序再恢复。`,
    );
  }
  if (listing.schemaVersion < SCHEMA_VERSION) {
    warnings.push(
      `备份来自 schema v${listing.schemaVersion}，本程序为 v${SCHEMA_VERSION}。恢复后会自动执行迁移补齐缺失的表结构。`,
    );
  }

  return {
    backupName: name,
    dir,
    sqlitePath: join(dir, 'ai-control-center.sqlite'),
    integrity: listing.integrity,
    backupSchemaVersion: listing.schemaVersion,
    currentSchemaVersion: SCHEMA_VERSION,
    currentCounts: databaseCounts(ctx.db, false),
    backupCounts: listing.counts,
    warnings,
    requiresPreBackup: true,
  };
}

/**
 * 把备份文件复制到目标数据库路径。
 *
 * 目标必须不存在 —— 这是「恢复到空目录」的语义（R01）。
 * 就地恢复请用 `restoreInPlace`，它会先关库再换文件。
 */
export function restoreToEmptyPath(plan: RestorePlan, targetDbPath: string): { bytes: number } {
  if (existsSync(targetDbPath)) {
    throw new TxAbort('already_exists', `目标位置已有文件，拒绝覆盖：${targetDbPath}`);
  }
  mkdirSync(join(targetDbPath, '..'), { recursive: true });
  const bytes = readFileSync(plan.sqlitePath);
  writeFileSync(targetDbPath, bytes);
  return { bytes: bytes.length };
}

/**
 * 就地恢复：关库 → 备份当前 → 换文件 → 清掉 WAL/SHM。
 * 返回后调用方必须重新打开数据库连接。
 */
export function restoreInPlace(ctx: ServiceContext, plan: RestorePlan): { preRestoreBackup: string | null } {
  const preBackup = createBackup(ctx, { note: `恢复 ${plan.backupName} 之前的自动备份` });

  const target = ctx.db.filePath;
  const walFile = `${target}-wal`;
  const shmFile = `${target}-shm`;

  ctx.db.checkpoint();
  ctx.db.close();

  try {
    const bytes = readFileSync(plan.sqlitePath);
    writeFileSync(target, bytes);
    for (const sidecar of [walFile, shmFile]) {
      if (existsSync(sidecar)) rmSync(sidecar, { force: true });
    }
  } catch (err) {
    throw new TxAbort(
      'internal',
      `恢复过程中断：${err instanceof Error ? err.message : String(err)}。` +
        `当前数据库可能处于不一致状态。恢复前的自动备份在：${join(preBackup.dir)}`,
    );
  }

  return { preRestoreBackup: preBackup.dir };
}

export function deleteBackup(config: AppConfig, name: string): void {
  const dir = join(config.backupDir, name);
  if (!existsSync(dir)) throw new TxAbort('not_found', `备份不存在：${name}`);
  rmSync(dir, { recursive: true, force: true });
}
