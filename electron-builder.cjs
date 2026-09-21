module.exports = {
  appId: 'io.aicc.desktop', productName: 'AI Control Center',
  directories: { app: 'apps/desktop', output: 'release' },
  files: ['main.cjs', 'package.json', 'assets/*'],
  extraResources: [{ from: '.desktop-runtime', to: 'runtime' }],
  // electron-builder's dependency collector excludes nested node_modules from
  // extraResources. Copy the standalone backend dependencies explicitly, and
  // dereference workspace junctions so the package never points into this repo.
  afterPack: async ({ appOutDir }) => {
    const { cpSync } = require('node:fs');
    const { join } = require('node:path');
    cpSync('.desktop-runtime/node_modules', join(appOutDir, 'resources/runtime/node_modules'), {
      recursive: true, dereference: true,
    });
  },
  asar: true, npmRebuild: false,
  electronDist: 'node_modules/electron/dist',
  win: { target: ['portable'], icon: 'apps/desktop/assets/icon.ico', signExecutable: false },
  artifactName: 'AI-Control-Center-${version}-${arch}.${ext}',
};
