import { cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = resolve(root, '.desktop-runtime');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此打包入口需要 Windows x64 Node。');
if (stage !== join(resolve(root), '.desktop-runtime')) throw new Error('Invalid staging path');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, file), join(stage, file));
for (const dir of ['packages/core', 'apps/server', 'apps/mcp', 'apps/web', 'apps/desktop']) {
  mkdirSync(join(stage, dir), { recursive: true });
  cpSync(join(root, dir, 'package.json'), join(stage, dir, 'package.json'));
  if (dir !== 'apps/desktop') cpSync(join(root, dir, 'dist'), join(stage, dir, 'dist'), { recursive: true });
}
cpSync(join(root, 'apps/desktop/backend.mjs'), join(stage, 'apps/desktop/backend.mjs'));
cpSync(process.execPath, join(stage, 'node.exe'));
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: stage, stdio: 'inherit', env: process.env,
});
if (result.status !== 0) process.exit(result.status || 1);
// Include the bundled runtime's license, including its third-party notices.
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
if (!license.ok) throw new Error('Failed to fetch Node license');
writeFileSync(join(stage, 'NODE-LICENSE.txt'), await license.text());
console.log('Desktop runtime prepared:', stage);
