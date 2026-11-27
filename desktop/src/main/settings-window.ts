import { BrowserWindow, session } from 'electron';
import { fileURLToPath } from 'node:url';
import type { HelperSettings } from './helper-settings.js';
import { settingsHandler, type SettingsView } from './settings-actions.js';
import { testMode } from './test-mode.js';

const page = new URL('../settings/index.html', import.meta.url);
const resources = new Set([page.href, ...['settings.css', 'settings.js'].map(name => new URL(name, page).href)]);

export function settingsWindow(title: string, settings: HelperSettings, view: () => SettingsView,
  logout: (all: boolean) => Promise<void>) {
  let window: BrowserWindow | undefined;
  function open() {
    if (window) {
      if (!testMode) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
      return;
    }
    const local = session.fromPartition('local-access-settings');
    local.webRequest.onBeforeRequest((request, done) => done({ cancel: !resources.has(request.url) }));
    local.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    local.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ title, width: 770, height: 750, minWidth: 500, minHeight: 420,
      show: false, autoHideMenuBar: true, webPreferences: { session: local, sandbox: true,
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
        disableDialogs: true, offscreen: testMode, preload: fileURLToPath(new URL('../preload/settings-preload.cjs', import.meta.url)) } });
    window = win;
    const wc = win.webContents;
    win.on('page-title-updated', event => event.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-frame-navigate', event => event.preventDefault());
    wc.on('will-redirect', event => event.preventDefault());
    wc.ipc.handle('local-access', settingsHandler(wc, page.href, settings, view, logout));
    win.once('closed', () => { window = undefined; });
    win.once('ready-to-show', () => { if (!testMode && !win.isDestroyed()) win.show(); });
    void win.loadFile(fileURLToPath(page)).catch(() => { if (!win.isDestroyed()) win.close(); });
  }
  function changed() {
    const wc = window?.webContents;
    if (wc && !wc.isDestroyed() && wc.getURL() === page.href) wc.send('local-access-changed');
  }
  return { open, changed, current: () => window };
}
