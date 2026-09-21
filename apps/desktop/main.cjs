const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const { fork } = require('node:child_process');
const { join, resolve } = require('node:path');

app.setName('AI Control Center');
// Test runs can use an isolated profile without touching the user's real data.
if (process.env.AICC_DESKTOP_PROFILE) app.setPath('userData', resolve(process.env.AICC_DESKTOP_PROFILE));
let window;
let child;
let quitting = false;
let backendUrl;
const dataDir = process.env.AICC_DATA_DIR || join(app.getPath('userData'), 'data');

function startBackend() {
  const root = app.isPackaged ? join(process.resourcesPath, 'runtime') : resolve(__dirname, '../..');
  const node = app.isPackaged ? join(root, 'node.exe') : process.env.AICC_NODE_EXECUTABLE;
  if (!node) throw new Error('请使用 npm run desktop 启动开发版本。');
  child = fork(join(root, 'apps/desktop/backend.mjs'), [], {
    execPath: node, cwd: root, windowsHide: true,
    env: { ...process.env, AICC_DATA_DIR: dataDir, AICC_HOST: '127.0.0.1', AICC_PORT: '8787' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  return new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('本地服务启动超时。' + diagnostics)), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('本地服务启动失败。' + diagnostics));
      if (backendUrl && !quitting) {
        dialog.showErrorBox('本地服务已停止', '请重新打开 AI Control Center。\n' + diagnostics);
        app.quit();
      }
    });
    child.on('message', message => {
      if (message.type === 'ready') { clearTimeout(timer); resolveReady(message); }
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
    });
  });
}

async function connect(code) {
  const response = await fetch(`${backendUrl}/api/session/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aicc-request': '1', origin: backendUrl },
    body: JSON.stringify({ code, label: '桌面应用' }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('桌面端自动配对失败。');
  const token = response.headers.get('set-cookie')?.match(/^aicc_session=([^;]+)/)?.[1];
  if (!token) throw new Error('本地服务未返回会话。');
  await session.defaultSession.cookies.set({ url: backendUrl, name: 'aicc_session', value: token,
    httpOnly: true, sameSite: 'strict', path: '/' });
}

async function openWindow() {
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 700,
    title: 'AI Control Center', icon: join(__dirname, 'assets/icon.png'), backgroundColor: '#f5f7fb', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== backendUrl) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== backendUrl) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  await window.loadURL(`${backendUrl}/?desktop=1`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const ready = await startBackend();
    backendUrl = ready.url;
    await connect(ready.code);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '应用', submenu: [
        { label: '打开数据目录', click: () => shell.openPath(dataDir) },
        { label: '重新启动', click: () => { app.relaunch(); app.quit(); } },
        { type: 'separator' }, { label: '退出', role: 'quit' },
      ] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
      { label: '帮助', submenu: [{ label: '关于', click: () => dialog.showMessageBox(window, {
        type: 'info', title: 'AI Control Center', message: `AI Control Center ${app.getVersion()}`,
        detail: '个人 AI 历史用量工作台\n数据保存在本机。关闭窗口会同时停止本地服务。\n会话过期后请重新打开应用。',
      }) }] },
    ]));
    await openWindow();
  }).catch(error => { dialog.showErrorBox('无法启动 AI Control Center', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !child || child.exitCode !== null) return;
    event.preventDefault();
    quitting = true;
    const timer = setTimeout(() => { child.kill(); app.exit(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); app.quit(); });
    if (child.connected) child.send({ type: 'shutdown' });
    else child.kill();
  });
}
