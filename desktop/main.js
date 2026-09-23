const { app, BrowserWindow, session, shell, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// --- Secure credential store -------------------------------------------------
// The JWT is encrypted with the OS keychain (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) before being written to the user data directory.
function credFile() {
  return path.join(app.getPath('userData'), 'credentials.bin');
}

function registerCredentialHandlers() {
  ipcMain.handle('cred:save', (event, payload) => {
    try {
      const data = JSON.stringify(payload);
      if (safeStorage.isEncryptionAvailable()) {
        fs.writeFileSync(credFile(), safeStorage.encryptString(data));
        return { ok: true, encrypted: true };
      }
      fs.writeFileSync(credFile(), data, 'utf8');
      return { ok: true, encrypted: false };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('cred:load', () => {
    try {
      if (!fs.existsSync(credFile())) return null;
      const raw = fs.readFileSync(credFile());
      const text = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(raw)
        : raw.toString('utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  });

  ipcMain.handle('cred:clear', () => {
    try {
      if (fs.existsSync(credFile())) fs.unlinkSync(credFile());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Connecta',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

// Grant camera/microphone access to the renderer so WebRTC calls work.
function registerMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'mediaKeySystem', 'display-capture', 'notifications'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return ['media', 'mediaKeySystem', 'display-capture', 'notifications'].includes(permission);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerCredentialHandlers();
    registerMediaPermissions();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
