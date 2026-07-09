// ══════════════════════════════════════════════════════════════
//  Face AI Tracker — Electron desktop shell
//  Loads the SAME web app from ./app (copied by build-app.js) and
//  talks to the same backend. One codebase, three platforms.
// ══════════════════════════════════════════════════════════════
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#080a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Grant camera/mic ONLY — deny everything else. This is the desktop
  // equivalent of the browser permission prompt, scoped tightly.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    return permission === 'media';
  });

  // External links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
