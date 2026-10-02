import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const results = [];
for (const task of ['build', 'typecheck', 'test', 'test:desktop', 'verify:sqlite', 'verify:smoke']) {
  const start = Date.now();
  const run = spawnSync(process.execPath, [process.env.npm_execpath, 'run', task], { cwd: root, stdio: 'inherit', windowsHide: true });
  results.push({ task, passed: run.status === 0, durationMs: Date.now() - start });
  mkdirSync(new URL('../tmp/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../tmp/verification.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2));
  if (run.status !== 0) process.exit(run.status || 1);
}
console.log('PASS: all automated verification gates. Desktop UI and standalone packaging use verify:desktop / verify:release.');
