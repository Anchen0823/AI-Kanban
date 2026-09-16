/**
 * 并行启动 server 与 web，零额外依赖（不用 concurrently / npm-run-all）。
 *
 * 为什么自己写：§9.1 要求「不添加无必要基础设施」。一个 40 行的 spawn 脚本比多一个
 * 依赖更可控，而且能保证在 Windows 上正确转发 Ctrl+C。
 *
 * 用法：node scripts/dev.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const targets = [
  { name: 'server', color: '\u001b[36m', args: ['run', 'dev', '-w', '@aicc/server'] },
  { name: 'web', color: '\u001b[35m', args: ['run', 'dev', '-w', '@aicc/web'] },
];

// core 是 server/web 的依赖，且通过 dist 暴露类型与实现，所以必须先构建一次。
if (!existsSync(join(root, 'packages', 'core', 'dist', 'index.js'))) {
  console.log('\u001b[33m[dev] 首次运行：先构建 @aicc/core …\u001b[0m');
  const build = spawn(npm, ['run', 'build', '-w', '@aicc/core'], { cwd: root, stdio: 'inherit', shell: true });
  await new Promise((resolve, reject) => {
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`core 构建失败，退出码 ${code}`))));
  });
}

const children = [];
let shuttingDown = false;

for (const target of targets) {
  const child = spawn(npm, target.args, { cwd: root, shell: true });
  children.push(child);

  const prefix = `${target.color}[${target.name}]\u001b[0m `;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${prefix}进程退出（code=${code}），正在停止其余进程…`);
    shutdown(code ?? 0);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 150).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
