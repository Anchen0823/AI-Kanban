// A separate, bundled Node runtime keeps SQLite and CLI integrations independent of Electron.
import { loadConfig } from '../server/dist/config.js';
import { createApp } from '../server/dist/app.js';
import { SessionStore } from '../server/dist/http/auth.js';
import { buildServer } from '../server/dist/http/server.js';
import { backupManager } from '../server/dist/services/backup-manager.js';
import { randomUUID } from 'node:crypto';

if (!process.send) throw new Error('Desktop backend requires a private IPC parent.');
const config = { ...loadConfig(), host: '127.0.0.1', port: 0, allowedOrigins: [] };
let service;
let server;
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await server?.close(); service?.close(); }
  finally { process.exit(0); }
}
process.on('disconnect', shutdown);
process.on('message', message => { if (message?.type === 'shutdown') void shutdown(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  service = createApp(config);
  service.bootstrap();
  const secretRequest = (operation, value) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { process.off('message', response); reject(new Error('密钥服务不可用')); }, 2000);
    const response = message => {
      if (message?.type !== 'backup-secret-result' || message.id !== id) return;
      clearTimeout(timer); process.off('message', response);
      if (message.error) reject(new Error(message.error)); else resolve(message.value);
    };
    process.on('message', response); process.send({ type: 'backup-secret', id, operation, value });
  });
  try { await backupManager(service).useSecretStore({ load: () => secretRequest('load'), save: value => secretRequest('save', value) }); }
  catch { /* Locked memory-only mode is visible in backup settings; never save plaintext. */ }
  const sessions = new SessionStore();
  server = buildServer({ app: service, sessions, config });
  const url = await server.listen({ host: config.host, port: 0 });
  config.port = Number(new URL(url).port);
  process.send({ type: 'ready', url, code: sessions.code });
} catch (error) {
  process.send({ type: 'error', message: error.message });
  await shutdown();
}
