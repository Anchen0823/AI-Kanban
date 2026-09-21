# Windows 桌面端

Windows x64 便携版位于 `release/AI-Control-Center-0.2.0-x64.exe`，双击即可运行，不需要额外安装 Node 或手动启动服务。便携版启动时需要解压，请稍等窗口出现；每次启动使用独立临时目录，避免干扰已运行的实例。经常使用时可直接运行 `release/win-unpacked/AI Control Center.exe`，省去重复解压，分享此目录时必须保留全部文件。

桌面版复用现有的用量总览、导入、额度、记忆、备份和 MCP 功能。主进程启动随包携带的 Node 服务，通过私有 IPC 获取一次性配对码，完成原有 HTTP 配对，再把 HttpOnly 会话 Cookie 写入隔离的桌面浏览器。页面不能访问 Node，窗口启用 sandbox 和 contextIsolation，拒绝外部跳转、弹窗和设备权限。

## 数据与生命周期

- 默认数据目录：`%APPDATA%/AI Control Center/data`。在「应用 → 打开数据目录」中查看；数据和备份均不会写到程序解压目录。
- 可用 `AICC_DATA_DIR` 指定现有数据目录。迁移网页版本时，先退出原服务，再指定原项目的 `data` 绝对路径启动桌面版；避免两个服务同时操作同一数据库。桌面版不会自动搬移或覆盖网页版本的数据。
- 关闭窗口或选择「退出应用」会关闭 HTTP 服务、数据库和子进程。父进程意外断开时，服务也会退出。
- 重复打开应用会聚焦已有窗口。会话有效期为 12 小时，到期可选择「应用 → 重新启动」自动重新配对。
- 服务仅绑定 `127.0.0.1`，使用系统分配的空闲端口，避免与网页版本冲突。MCP 配置使用当次实际端口；重启桌面版后需要在「设置 → 代理凭据」重新复制配置。便携单文件的解压路径也可能变化，长期 MCP 接入建议继续使用仓库的 `npm start` 服务。
- `AICC_DESKTOP_PROFILE` 可为验证指定独立配置目录；常规使用无需设置。

## 从源码运行与打包

```powershell
npm ci
npm run desktop             # 构建并启动桌面端
npm run desktop:pack        # Windows x64：构建、准备内置 Node 与依赖、生成便携 EXE
```

打包需要 Windows x64、Node >= 22.5 和联网下载依赖。准备脚本只复制生产依赖、构建产物及 Node 许可证，不包含数据库、用户配置、源码或测试数据。构建产物在 `release/`，暂存目录为 `.desktop-runtime/`，二者均不提交 Git。包未做商业代码签名，Windows 可能显示未知发布者提示。

若 npm 禁止了 Electron 安装脚本，可显式执行 `node node_modules/electron/install.js`。下载失败时可设置 `ELECTRON_MIRROR`；安装器仍检查 Electron 包附带的校验和。

## 验证

```powershell
npm run build
npm run typecheck
npm test
npm run test:desktop
npm run verify:desktop
node scripts/verify-desktop.mjs "release/win-unpacked/AI Control Center.exe"
```

后端测试覆盖真实 SQLite、匿名拒绝、一次性配对、来源限制、设置持久化、正常关闭和父进程断开。窗口验证使用临时独立数据目录，检查自动登录、页面导航、重复启动、页面无 Node 权限、匿名请求无法共享会话及关窗后端口释放，截图写入 `tmp/desktop-verification/desktop.png`。远程调试参数仅由验证脚本传入，常规启动不启用。分发前还需将 `win-unpacked` 整个目录复制到项目外，再对该目录中的 EXE 执行验证，防止缺失依赖被仓库的 `node_modules` 掩盖。

实现参考：[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)、[electron-builder Windows 打包](https://www.electron.build/v26/docs/win/)。
