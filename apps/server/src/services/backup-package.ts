import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_MAX_BYTES, BACKUP_PACKAGE_VERSION } from '@aicc/core';
import type { ServiceContext } from '../service-context.js';
import { backupName, inspectBackup, planRestore, validateBackupDatabase } from './backup.js';
import { TxAbort, SCHEMA_VERSION } from '../db/database.js';

const MAGIC = Buffer.from('AICCBK01');
const invalid = () => new TxAbort('invalid_input', '备份包损坏、密码不正确或版本不受支持。');
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key)));
}
export function localPackage(ctx: ServiceContext, name: string): Buffer {
  const plan = planRestore(ctx, name);
  const manifest = readFileSync(join(plan.dir, 'manifest.json'));
  const db = readFileSync(plan.sqlitePath);
  const size = Buffer.alloc(4); size.writeUInt32BE(manifest.length);
  const body = Buffer.concat([size, manifest, db]);
  if (body.length > BACKUP_MAX_BYTES - 8192) throw new TxAbort('too_large', '备份超过 128 MiB 上限。');
  return envelope({ version: BACKUP_PACKAGE_VERSION, encrypted: false }, body);
}
function envelope(header: Record<string, unknown>, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json, payload]);
}
function parse(bytes: Buffer): { header: Record<string, unknown>; aad: Buffer; payload: Buffer } {
  if (bytes.length < 16 || bytes.length > BACKUP_MAX_BYTES || !bytes.subarray(0, 8).equals(MAGIC)) throw invalid();
  const length = bytes.readUInt32BE(8);
  if (length > 4096 || length < 2 || 12 + length >= bytes.length) throw invalid();
  let header: Record<string, unknown>;
  try { header = JSON.parse(bytes.subarray(12, 12 + length).toString()); } catch { throw invalid(); }
  if (!header || header.version !== 1 || typeof header.encrypted !== 'boolean') throw invalid();
  return { header, aad: bytes.subarray(0, 12 + length), payload: bytes.subarray(12 + length) };
}
export async function encryptPackage(plain: Buffer, password: string): Promise<Buffer> {
  if (password.length < 12 || password.length > 1024) throw new TxAbort('invalid_input', '备份密码需要 12–1024 个字符。');
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = { version: 1, encrypted: true, kdf: 'scrypt-32768-8-1', salt: salt.toString('hex'), iv: iv.toString('hex') };
  const aad = envelope(header, Buffer.alloc(0));
  const key = await derive(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const result = Buffer.concat([aad, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    if (result.length > BACKUP_MAX_BYTES) throw new TxAbort('too_large', '备份超过 128 MiB 上限。');
    return result;
  } finally { key.fill(0); }
}
export async function decryptPackage(bytes: Buffer, password?: string, requireEncrypted = false): Promise<Buffer> {
  const { header, aad, payload } = parse(bytes);
  if (!header.encrypted) { if (requireEncrypted) throw invalid(); return bytes; }
  if (!password || password.length > 1024 || header.kdf !== 'scrypt-32768-8-1' || !/^[a-f0-9]{32}$/.test(String(header.salt)) || !/^[a-f0-9]{24}$/.test(String(header.iv)) || payload.length < 17) throw invalid();
  const key = await derive(password, Buffer.from(String(header.salt), 'hex'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(header.iv), 'hex'));
    decipher.setAAD(aad); decipher.setAuthTag(payload.subarray(-16));
    return Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
  } catch { throw invalid(); } finally { key.fill(0); }
}
export async function importPackage(ctx: ServiceContext, bytes: Buffer, password?: string, requireEncrypted = false): Promise<string> {
  const plain = await decryptPackage(bytes, password, requireEncrypted);
  const { header, payload } = parse(plain);
  if (header.encrypted || payload.length < 5) throw invalid();
  const length = payload.readUInt32BE(0);
  if (length < 2 || length > 1024 * 1024 || length + 4 >= payload.length) throw invalid();
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(payload.subarray(4, 4 + length).toString()); } catch { throw invalid(); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw invalid();
  mkdirSync(ctx.config.backupDir, { recursive: true });
  const staging = mkdtempSync(join(ctx.config.backupDir, '.import-'));
  try {
    // Files are fixed names; no archive-supplied filesystem paths are interpreted.
    const base = backupName(ctx.now()); let name = base, n = 2;
    while (existsSync(join(ctx.config.backupDir, name))) name = `${base}-${n++}`;
    manifest.name = name;
    const dir = join(staging, name); mkdirSync(dir);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const db = join(dir, 'ai-control-center.sqlite'); writeFileSync(db, payload.subarray(4 + length));
    const report = inspectBackup(dir);
    if (report.integrity !== 'ok') throw invalid();
    if (report.schemaVersion > SCHEMA_VERSION) throw new TxAbort('invalid_input', '请升级应用后导入此备份。');
    validateBackupDatabase(ctx.config, db, report.schemaVersion);
    renameSync(dir, join(ctx.config.backupDir, name));
    return name;
  } finally { plain.fill(0); rmSync(staging, { recursive: true, force: true }); }
}
