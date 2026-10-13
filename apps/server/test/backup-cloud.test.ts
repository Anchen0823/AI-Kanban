import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from './helpers.js';
import { createApp } from '../src/app.js';
import { decryptPackage, encryptPackage, importPackage, localPackage } from '../src/services/backup-package.js';
import { BackupManager } from '../src/services/backup-manager.js';
import { WebDav } from '../src/services/webdav.js';
import { backupManager } from '../src/services/backup-manager.js';
import { setSetting } from '../src/db/repos/system.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

function davFixture() {
  const files = new Map<string, Buffer>(), directories = new Set<string>(['/dav/']);
  let failure: 'none' | 'auth' | 'network' | 'corrupt' | 'move-lost' = 'none';
  const calls: string[] = [];
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname), method = options?.method ?? 'GET'; calls.push(`${method} ${path}`);
    assert.equal(url.origin, 'https://dav.test'); assert.equal(options?.redirect, 'error');
    assert.equal((options?.headers as Record<string,string>).authorization, `Basic ${Buffer.from('user:app-secret').toString('base64')}`);
    if (failure === 'auth') return new Response('', { status: 401 });
    if (failure === 'network') throw new Error('do not leak app-secret');
    if (method === 'MKCOL') { const old = directories.has(path); directories.add(path); return new Response(null, { status: old ? 405 : 201 }); }
    if (method === 'PUT') { files.set(path, Buffer.from(options!.body as Uint8Array)); return new Response(null, { status: 201 }); }
    if (method === 'GET') { const bytes = files.get(path); return new Response(bytes ? new Uint8Array(failure === 'corrupt' ? Buffer.from('bad') : bytes) : null, { status: bytes ? 200 : 404 }); }
    if (method === 'DELETE') { files.delete(path); return new Response(null, { status: 204 }); }
    if (method === 'MOVE') {
      const target = decodeURIComponent(new URL((options?.headers as Record<string,string>).Destination!).pathname);
      if (!files.has(path)) return new Response(null, { status: 404 });
      files.set(target, files.get(path)!); files.delete(path);
      if (failure === 'move-lost') { failure = 'none'; throw new Error('lost response'); }
      return new Response(null, { status: 201 });
    }
    if (method === 'PROPFIND') {
      const rows = [...directories, ...files.keys()].filter(key => key.startsWith(path) && !key.slice(path.length).replace(/\/$/, '').includes('/'));
      return new Response(`<d:multistatus xmlns:d="DAV:">${rows.map(key => `<d:response><d:href>${key}</d:href><d:propstat><d:prop><d:resourcetype>${directories.has(key) ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${files.get(key)?.length ?? 0}</d:getcontentlength><d:getlastmodified>Tue, 13 Oct 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`, { status: 207 });
    }
    throw new Error(method);
  };
  return { transport, files, calls, fail(value: typeof failure) { failure = value; } };
}
const settings = { endpoint: 'https://dav.test/dav/', username: 'user', webdavPassword: 'app-secret', backupPassword: 'a long backup password', enabled: false };

test('authenticated package roundtrip, wrong password, modified header/body and plaintext cloud rejection', async () => {
  const h = await createHarness();
  try {
    const b = h.app.backup(); const plain = localPackage(h.app.ctx, b.name);
    const encrypted = await encryptPackage(plain, settings.backupPassword);
    assert.ok(!encrypted.includes(Buffer.from('SQLite format')));
    assert.deepEqual(await decryptPackage(encrypted, settings.backupPassword), plain);
    assert.notDeepEqual(await encryptPackage(plain, settings.backupPassword), encrypted);
    await assert.rejects(decryptPackage(encrypted, 'wrong password'), /密码/);
    const altered = Buffer.from(encrypted); altered[altered.length - 30]! ^= 1;
    await assert.rejects(importPackage(h.app.ctx, altered, settings.backupPassword));
    await assert.rejects(importPackage(h.app.ctx, plain, settings.backupPassword, true));
    const badVersion = Buffer.from(plain); const versionAt = badVersion.indexOf(Buffer.from('"version":1')); badVersion[versionAt + 10] = 57;
    await assert.rejects(importPackage(h.app.ctx, badVersion));
    const name = await importPackage(h.app.ctx, encrypted, settings.backupPassword, true);
    assert.notEqual(name, b.name); assert.equal(h.app.planRestore(name).integrity, 'ok');
    assert.equal(readdirSync(h.config.backupDir).filter(x => x.startsWith('.import')).length, 0);
  } finally { h.close(); }
});

test('backup package import ignores no paths: malformed file declarations and oversized header are rejected', async () => {
  const h = await createHarness();
  try {
    const b = h.app.backup();
    const plain = localPackage(h.app.ctx, b.name), bad = Buffer.from(plain); bad.writeUInt32BE(0xffffffff, 8);
    await assert.rejects(importPackage(h.app.ctx, bad));
    const headerSize = plain.readUInt32BE(8), manifestAt = 12 + headerSize, size = plain.readUInt32BE(manifestAt);
    const manifest = JSON.parse(plain.subarray(manifestAt + 4, manifestAt + 4 + size).toString()); manifest.files[0].name = '../evil.sqlite';
    const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(json.length);
    await assert.rejects(importPackage(h.app.ctx, Buffer.concat([plain.subarray(0, manifestAt), length, json, plain.subarray(manifestAt + 4 + size)])));
    assert.ok(!existsSync(join(h.dir, 'evil.sqlite')));
  } finally { h.close(); }
});

test('restore reopening failure rolls back the original live database and leaves service usable', async () => {
  const h = await createHarness();
  try {
    const b = h.app.backup();
    setSetting(h.app.db, 'rollback-sentinel', 'keep');
    const reopen = h.app.reopen; let once = true;
    h.app.reopen = () => { if (once) { once = false; throw new Error('injected reopen failure'); } reopen(); };
    assert.throws(() => h.app.restore(b.name), /原数据已保留/);
    assert.equal(h.app.db.prepare('SELECT value FROM app_settings WHERE key=?').get<{value:string}>('rollback-sentinel')?.value, 'keep');
    assert.ok(!existsSync(`${h.config.dbFile}.restore-journal`));
    assert.equal((await h.request('GET', '/api/self-check')).status, 200);
  } finally { h.close(); }
});

test('interrupted restore is rolled back on next startup, incomplete backup is never published', async () => {
  const h = await createHarness();
  try {
    const original = h.app.db.backupTo;
    h.app.db.backupTo = () => { throw new Error('ENOSPC'); };
    assert.throws(() => h.app.backup(), /ENOSPC/); assert.deepEqual(readdirSync(h.config.backupDir), []);
    h.app.db.backupTo = original;
    h.app.db.checkpoint(); h.app.close();
    copyFileSync(h.config.dbFile, `${h.config.dbFile}.restore-old`);
    writeFileSync(`${h.config.dbFile}.restore-journal`, 'prepared'); writeFileSync(h.config.dbFile, 'partial');
    const recovered = createApp(h.config);
    try { recovered.bootstrap(); assert.ok(recovered.db.prepare('SELECT COUNT(*) n FROM client').get()); }
    finally { recovered.close(); }
    assert.ok(!existsSync(`${h.config.dbFile}.restore-journal`));
  } finally { h.close(); }
});

test('restore waits for in-flight writes and rejects new ones; automatic sync stays paused', async () => {
  const h = await createHarness();
  try {
    const b = h.app.backup(), release = h.app.maintenance.enter();
    const restoring = h.request('POST', `/api/backups/${b.name}/restore`, { confirm: true });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal((await h.request('PATCH', '/api/settings', { displayTimezone: 'UTC' })).status, 503);
    release(); assert.equal((await restoring).status, 200);
    assert.equal(backupManager(h.app).settings().syncPaused, true);
    assert.equal((await h.request('POST', '/api/history/codex', { automatic: true })).status, 409);
  } finally { h.close(); }
});

test('WebDAV verifies permissions and upload; download on a fresh machine restores the full workspace', async () => {
  const first = await createHarness(), second = await createHarness(), fixture = davFixture();
  const upload = new BackupManager(first.app, fixture.transport), download = new BackupManager(second.app, fixture.transport);
  try {
    setSetting(first.app.db, 'restore-sentinel', 'complete');
    await upload.configure(settings); upload.start('test'); await upload.idle(); assert.equal(upload.jobs()[0]!.phase, 'done');
    upload.start('upload'); await upload.idle(); assert.equal(upload.jobs()[0]!.phase, 'done');
    assert.ok(upload.settings().lastLocalAt); assert.ok(upload.settings().lastCloudAt);
    await download.configure(settings);
    const remote = await download.remote(); assert.equal(remote.length, 1);
    download.start('download', undefined, remote[0]!.id); await download.idle();
    const job = download.jobs()[0]!; assert.equal(job.phase, 'done'); second.app.restore(job.localName!);
    assert.equal(second.app.db.prepare('SELECT value FROM app_settings WHERE key=?').get<{value:string}>('restore-sentinel')?.value, 'complete');
    assert.notEqual(download.settings().deviceId, upload.settings().deviceId);
    for (const dir of [first.dir, second.dir]) assert.doesNotMatch(readFileSync(join(dir, 'backup-control.json'), 'utf8'), /app-secret|a long backup password/);
  } finally { await upload.stop(); await download.stop(); first.close(); second.close(); }
});

test('network retry is durable and idempotent after lost MOVE; auth errors do not auto-retry', async () => {
  const h = await createHarness(), f = davFixture(); let manager = new BackupManager(h.app, f.transport);
  try {
    await manager.configure(settings); f.fail('move-lost'); manager.start('upload'); await manager.idle();
    let job = manager.jobs()[0]!; assert.equal(job.phase, 'error'); assert.ok(job.retryAt); assert.ok(job.localName); assert.equal(manager.settings().lastCloudAt, undefined);
    await manager.stop(); manager = new BackupManager(h.app, f.transport);
    assert.equal(manager.settings().unlocked, false); await manager.configure(settings); manager.retry(job.id); await manager.idle();
    assert.equal(manager.jobs()[0]!.phase, 'done'); assert.equal((await manager.remote()).length, 1);
    f.fail('auth'); manager.start('upload'); await manager.idle(); job = manager.jobs()[0]!;
    assert.equal(job.phase, 'error'); assert.equal(job.retryAt, undefined); assert.doesNotMatch(job.error!, /app-secret/);
    assert.equal(manager.settings().authBlocked, true);
    await manager.configure({ enabled: true }); await manager.tick(); assert.equal(manager.jobs().length, 2);
    await manager.configure({ webdavPassword: settings.webdavPassword }); assert.equal(manager.settings().authBlocked, false);
  } finally { await manager.stop(); h.close(); }
});

test('corrupt remote readback never publishes a completed backup', async () => {
  const h = await createHarness(), f = davFixture(), manager = new BackupManager(h.app, f.transport);
  try { await manager.configure(settings); f.fail('corrupt'); manager.start('upload'); await manager.idle(); assert.equal(manager.jobs()[0]!.phase, 'error'); assert.equal(manager.settings().lastCloudAt, undefined); assert.ok([...f.files.keys()].every(p => p.endsWith('.partial'))); }
  finally { await manager.stop(); h.close(); }
});

test('automatic scheduling waits for initial sync, deduplicates days and stops on close', async () => {
  const h = await createHarness(), f = davFixture(); let syncs = 0, now = new Date(2026, 9, 13, 12).getTime(); h.app.ctx.now = () => now;
  const manager = new BackupManager(h.app, f.transport, async () => { syncs++; });
  try {
    await manager.configure({ ...settings, enabled: true }); await manager.tick(); await manager.idle(); assert.equal(syncs, 1); assert.equal(manager.jobs().length, 1);
    await manager.tick(); assert.equal(manager.jobs().length, 1);
    now += 86400000; await manager.tick(); await manager.idle(); assert.equal(manager.jobs().length, 2);
    manager.pauseSync(); now += 86400000; await manager.tick(); assert.equal(manager.jobs().length, 2);
    manager.resumeSync(); await manager.stop(); await manager.tick(); assert.equal(manager.jobs().length, 2);
  } finally { await manager.stop(); h.close(); }
});

test('settings and binary transfer require a user, reject demo mutations and never return secrets', async () => {
  const h = await createHarness();
  try {
    assert.equal((await h.anonymous('GET', '/api/backup-settings')).status, 401);
    assert.equal((await h.request('PATCH', '/api/backup-settings?workspace=demo', settings)).status, 403);
    const configured = await h.request('PATCH', '/api/backup-settings', settings); assert.equal(configured.status, 200); assert.doesNotMatch(JSON.stringify(configured.body), /app-secret|a long backup password/);
    const b = h.app.backup(), bytes = localPackage(h.app.ctx, b.name);
    const imported = await h.fastify.inject({ method: 'POST', url: '/api/backups/import', headers: { cookie: h.cookie, 'x-aicc-request': '1', 'content-type': 'application/octet-stream' }, payload: bytes });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal((await h.raw('POST', '/api/backup-jobs', { kind: 'test' }, { cookie: h.cookie })).status, 403);
    assert.throws(() => new WebDav('http://example.test/', 'u', 'p'), /HTTPS/);
  } finally { h.close(); }
});

test('failed staged migration and occupied staging path leave current database readable', async () => {
  const h = await createHarness();
  try {
    const b = h.app.backup(), prepared = `${h.config.dbFile}.restore-new`;
    mkdirSync(prepared);
    assert.throws(() => h.app.restore(b.name));
    assert.equal((await h.request('GET', '/api/self-check')).status, 200);
    rmSync(prepared, { recursive: true });
    // A structurally invalid SQLite with an internally matching manifest is still rejected.
    const manifestPath = join(b.dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const { openDatabase } = await import('../src/db/database.js');
    const db = openDatabase({ filePath: join(b.dir, 'ai-control-center.sqlite') });
    db.db.exec('DROP TABLE history_detail_bucket'); db.db.checkpoint(); db.db.close();
    const { createHash } = await import('node:crypto'); const bytes = readFileSync(join(b.dir, 'ai-control-center.sqlite'));
    manifest.files[0].bytes = bytes.length; manifest.files[0].sha256 = createHash('sha256').update(bytes).digest('hex'); writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => h.app.planRestore(b.name), /结构或迁移/);
    assert.equal((await h.request('GET', '/api/self-check')).status, 200);
  } finally { h.close(); }
});

test('secret store restart unlocks only matching target and credentials never enter backup package', async () => {
  const h = await createHarness(), f = davFixture();
  let saved: import('../src/services/backup-manager.js').BackupSecrets | null = null;
  const store = { async load() { return saved; }, async save(value: NonNullable<typeof saved>) { saved = value; } };
  const first = new BackupManager(h.app, f.transport);
  try {
    await first.useSecretStore(store); await first.configure(settings); await first.stop();
    const second = new BackupManager(h.app, f.transport); await second.useSecretStore(store);
    assert.equal(second.settings().unlocked, true);
    const plain = localPackage(h.app.ctx, h.app.backup().name);
    assert.ok(!plain.includes(Buffer.from(settings.webdavPassword)) && !plain.includes(Buffer.from(settings.backupPassword)));
    await second.configure({ endpoint: 'https://another.test/dav/' }); assert.equal(second.settings().unlocked, false);
    await second.stop();
  } finally { await first.stop(); h.close(); }
});

test('WebDAV rejects malicious XML, off-directory hrefs, oversized bodies and redirects', async () => {
  const badXml: typeof fetch = async () => new Response('<!DOCTYPE d [<!ENTITY file SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"/>', { status: 207 });
  await assert.rejects(new WebDav(settings.endpoint, 'u', 'p', undefined, badXml).backups(), /XML/);
  const cross: typeof fetch = async () => new Response('<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://evil.test/AI-Control-Center/x</d:href><d:prop><d:collection/></d:prop></d:response></d:multistatus>', { status: 207 });
  assert.deepEqual(await new WebDav(settings.endpoint, 'u', 'p', undefined, cross).backups(), []);
  const tooBig: typeof fetch = async () => new Response('small', { headers: { 'content-length': String(129 * 1024 * 1024) } });
  await assert.rejects(new WebDav(settings.endpoint, 'u', 'p', undefined, tooBig).get('test'), /大小/);
  const redirect: typeof fetch = async (_url, options) => { assert.equal(options?.redirect, 'error'); return new Response(null, { status: 302 }); };
  await assert.rejects(new WebDav(settings.endpoint, 'u', 'p', undefined, redirect).get('test'), /302/);
});

test('file replacement failure after close reopens the original database', async t => {
  const h = await createHarness();
  const rename = fs.renameSync;
  try {
    const b = h.app.backup(); setSetting(h.app.db, 'file-lock-sentinel', 'keep');
    t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
      if (String(source) === `${h.config.dbFile}.restore-new`) throw Object.assign(new Error('File in use'), { code: 'EBUSY' });
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    assert.throws(() => h.app.restore(b.name), /原数据已保留/);
    assert.equal(h.app.settings()['file-lock-sentinel'], 'keep');
    assert.equal((await h.request('GET', '/api/self-check')).status, 200);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); h.close(); }
});
