import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BACKUP_MAX_BYTES } from '@aicc/core';
import { requireUser, workspaceOf, type HttpDeps } from '../server.js';
import { ApiError } from '../errors.js';
import { backupManager } from '../../services/backup-manager.js';
import { importPackage, localPackage } from '../../services/backup-package.js';

export function registerBackupRoutes(server: FastifyInstance, deps: HttpDeps): void {
  const manager = backupManager(deps.app);
  server.register(async scope => {
    scope.addHook('preHandler', async (request, reply) => {
      requireUser(request, '备份管理'); reply.header('cache-control', 'no-store');
      if (workspaceOf(request) !== 'real') throw new ApiError(403, 'forbidden', '请切换到真实数据管理备份。');
    });
    scope.get('/api/backup-settings', async () => manager.settings());
    scope.patch('/api/backup-settings', async request => {
      const input = z.object({ endpoint: z.string().max(2048).optional(), username: z.string().max(256).optional(), enabled: z.boolean().optional(),
        webdavPassword: z.string().max(1024).optional(), backupPassword: z.string().min(12).max(1024).optional() }).strict().parse(request.body);
      await manager.configure(input); return manager.settings();
    });
    scope.post('/api/backup-settings/resume-sync', async () => { manager.resumeSync(); return { ok: true }; });
    scope.post('/api/backup-settings/startup-sync-complete', async () => { manager.markStartupSynced(); return { ok: true }; });
    scope.get('/api/backup-jobs', async () => ({ jobs: manager.jobs() }));
    scope.post('/api/backup-jobs', async (request, reply) => {
      const input = z.object({ kind: z.enum(['test', 'upload', 'download']), localName: z.string().regex(/^\d{8}-\d{6}(?:-[1-9]\d*)?$/).optional(),
        remoteId: z.string().max(200).optional(), password: z.string().max(1024).optional() }).parse(request.body);
      reply.status(202); return manager.start(input.kind, input.localName, input.remoteId, input.password);
    });
    scope.post('/api/backup-jobs/:id/retry', async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { password } = z.object({ password: z.string().max(1024).optional() }).parse(request.body ?? {});
      reply.status(202); return manager.retry(id, password);
    });
    scope.get('/api/backup-remote', async () => ({ backups: await manager.remote() }));
    scope.delete('/api/backup-remote', async request => {
      const { id, confirm } = z.object({ id: z.string().max(200), confirm: z.literal('true') }).parse(request.query);
      if (confirm) await manager.deleteRemote(id); return { ok: true };
    });
    scope.get('/api/backups/:name/package', async (request, reply) => {
      const { name } = z.object({ name: z.string().max(200) }).parse(request.params);
      reply.type('application/octet-stream').header('content-disposition', `attachment; filename="${name.replace(/[^a-zA-Z0-9-]/g, '')}.aiccbackup"`);
      return localPackage(deps.app.ctx, name);
    });
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: BACKUP_MAX_BYTES }, (_request, body, done) => done(null, body));
    scope.post('/api/backups/import', { bodyLimit: BACKUP_MAX_BYTES }, async request => {
      if (!Buffer.isBuffer(request.body)) throw new ApiError(400, 'invalid_input', '请选择 .aiccbackup 文件。');
      // Password is never in the URL and neither headers nor bodies are logged.
      const encoded = request.headers['x-backup-password'];
      const password = typeof encoded === 'string' ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
      const name = await importPackage(deps.app.ctx, request.body, password);
      manager.noteLocal(); return { name };
    });
  });
}
