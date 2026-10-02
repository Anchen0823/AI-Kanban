import { mkdtempSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const distribution = join(root, 'release/current');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const portable = join(distribution, `AI-Control-Center-${version}-x64.exe`);
if (!existsSync(portable)) throw new Error('Run npm run desktop:pack before verifying this version.');
const external = mkdtempSync(join(tmpdir(), 'aicc-release-'));
const rel = relative(resolve(root), resolve(external));
if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Release verification must run outside the repository.');
cpSync(join(distribution, 'win-unpacked'), join(external, 'win-unpacked'), { recursive: true });
cpSync(portable, join(external, 'portable.exe'));
const env = { ...process.env, AICC_VERIFY_OFFICIAL_SYNC: '0' };
delete env.AICC_NODE_EXECUTABLE; delete env.NODE_PATH;
for (const executable of [join(external, 'win-unpacked', 'AI Control Center.exe'), join(external, 'portable.exe')]) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/verify-desktop.mjs'), executable], { cwd: external, env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
cpSync(join(external, 'tmp/desktop-verification'), join(root, 'tmp/release-verification'), { recursive: true });
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sources = git(['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).sort();
const digest = createHash('sha256');
for (const file of sources) { digest.update(file + '\0'); digest.update(readFileSync(join(root, file))); }
const manifest = {
  version, commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0,
  sourceSha256: digest.digest('hex'), node: process.version, verifiedAt: new Date().toISOString(),
  artifacts: [{ file: `AI-Control-Center-${version}-x64.exe`, sha256: createHash('sha256').update(readFileSync(portable)).digest('hex') }],
  verification: 'Both unpacked and portable executables passed outside the repository using their bundled runtime and isolated synthetic data.',
};
writeFileSync(join(distribution, 'manifest.json'), JSON.stringify(manifest, null, 2));
const temporaryRelative = relative(resolve(tmpdir()), resolve(external));
if (temporaryRelative.startsWith('aicc-release-') && !temporaryRelative.includes('..') && !isAbsolute(temporaryRelative)) {
  rmSync(external, { recursive: true, force: true });
}
console.log('Verified release manifest:', join(distribution, 'manifest.json'));
