// A separate, bundled Node runtime keeps SQLite and CLI integrations independent of Electron.
import { loadConfig } from '../server/dist/config.js';
import { createApp } from '../server/dist/app.js';
import { SessionStore } from '../server/dist/http/auth.js';
import { buildServer } from '../server/dist/http/server.js';

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
  const sessions = new SessionStore();
  server = buildServer({ app: service, sessions, config });
  const url = await server.listen({ host: config.host, port: 0 });
  config.port = Number(new URL(url).port);
  process.send({ type: 'ready', url, code: sessions.code });
} catch (error) {
  process.send({ type: 'error', message: error.message });
  await shutdown();
}
