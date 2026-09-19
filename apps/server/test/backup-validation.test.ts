import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from './helpers.js';
import { deleteBackup, planRestore } from '../src/services/backup.js';

test('备份恢复和删除拒绝路径，只接受备份目录的直接子名称', async () => {
  const h = await createHarness();
  try {
    const outside = join(h.dir, 'keep');
    mkdirSync(outside);
    const sentinel = join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'keep');
    const names = ['..', '../keep', '..\\keep', outside, '20260919-123000/../keep'];
    for (const name of names) {
      assert.throws(() => deleteBackup(h.config, name), /备份名称无效/);
      assert.throws(() => planRestore(h.app.ctx, name), /备份名称无效/);
    }
    for (const suffix of ['/restore-plan', '/restore', '']) {
      const response = await h.request(suffix ? 'POST' : 'DELETE',
        `/api/backups/${encodeURIComponent('../keep')}${suffix}`, { confirm: true });
      assert.equal(response.status, 400);
    }
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    const backup = await h.request<{ name: string; dir: string }>('POST', '/api/backups', {});
    assert.equal((await h.request('POST', `/api/backups/${backup.body.name}/restore-plan`)).status, 200);
    assert.equal((await h.request('DELETE', `/api/backups/${backup.body.name}`)).status, 200);
    assert.equal(existsSync(backup.body.dir), false);
  } finally { h.close(); }
});

test('备份损坏或缺失校验条目时拒绝恢复，但不让整个备份列表崩溃', async () => {
  const h = await createHarness();
  try {
    const bad = await h.request<{ name: string; dir: string }>('POST', '/api/backups');
    const good = await h.request<{ name: string }>('POST', '/api/backups');
    const path = join(bad.body.dir, 'manifest.json');
    const original = JSON.parse(readFileSync(path, 'utf8'));
    for (const manifest of [
      '{broken json',
      JSON.stringify({ ...original, files: [] }),
      JSON.stringify({ ...original, files: [{ ...original.files[0], sha256: undefined }] }),
      JSON.stringify({ ...original, name: good.body.name }),
      JSON.stringify({ ...original, schemaVersion: null }),
    ]) {
      writeFileSync(path, manifest);
      const listing = await h.request<{ backups: Array<{ name: string; integrity: string }> }>('GET', '/api/backups');
      assert.equal(listing.status, 200);
      assert.equal(listing.body.backups.find((b) => b.name === bad.body.name)?.integrity, 'manifest_invalid');
      assert.equal(listing.body.backups.find((b) => b.name === good.body.name)?.integrity, 'ok');
      assert.equal((await h.request('POST', `/api/backups/${bad.body.name}/restore-plan`)).status, 400);
    }
  } finally { h.close(); }
});

test('备份路径中的目录链接不能用于恢复或删除', async () => {
  const h = await createHarness();
  try {
    mkdirSync(h.config.backupDir, { recursive: true });
    const target = join(h.dir, 'linked-target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    const name = '20260919-123456';
    symlinkSync(target, join(h.config.backupDir, name), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => planRestore(h.app.ctx, name), /符号链接/);
    assert.throws(() => deleteBackup(h.config, name), /符号链接/);
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep');
    const list = await h.request<{ backups: unknown[] }>('GET', '/api/backups');
    assert.equal(list.status, 200);
    assert.equal(list.body.backups.length, 0);
  } finally { h.close(); }
});
