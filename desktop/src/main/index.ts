import { app, BrowserWindow, dialog, Menu, Notification, powerMonitor, safeStorage, session } from 'electron';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { testMode, testLog } from './test-mode.js';
import { join } from 'node:path';
import { createWindow, type Brand } from './window.js';
import { registerProtocol } from './protocol.js';
import { deepTarget } from './links.js';
import { createTray } from './tray.js';
import { settingsWindow } from './settings-window.js';
import { connectionLabels, logoutAction, type SettingsView } from './settings-actions.js';
import { HelperSettings } from './helper-settings.js';
import { DesktopRelay } from './relay.js';
import { logoutDesktop } from './logout.js';
import { DesktopAuth } from './auth.js';
import { authorize, permissions } from './session.js';

const brand: Brand = JSON.parse(readFileSync(join(app.getAppPath(), 'brand/default/brand.json'), 'utf8'));
const origin = new URL(brand.defaultGatewayUrl).origin;
if (origin !== brand.defaultGatewayUrl.replace(/\/$/, '') || !origin.startsWith('https://') ||
    !/^[a-z][a-z0-9+.-]+$/.test(brand.protocol)) throw new Error('桌面品牌配置无效');
app.setName(brand.productName);
app.commandLine.appendSwitch('lang', 'zh-CN');
if (testMode) {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'wp-desktop-test-')));
  app.commandLine.appendSwitch('use-mock-keychain');
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
}
let open: ((url?: string) => void) | undefined;
let pending: string | undefined;
let quitting = false;
function receive(raw?: string) {
  const url = raw && deepTarget(raw, brand.protocol, origin);
  if (raw && !url) return;
  if (url) testLog('处理深链', url);
  if (open) open(url);
  else if (url) pending = url;
}
const fromArgs = (args: string[]) => args.find(arg => arg.startsWith(brand.protocol + '://'));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('open-url', (event, url) => { event.preventDefault(); receive(url); });
  app.on('second-instance', (_event, args) => receive(fromArgs(args)));
  receive(fromArgs(process.argv));
  app.on('before-quit', () => { quitting = true; });
  app.on('activate', () => open?.());
  void app.whenReady().then(start);
}

function start() {
  const store = session.defaultSession;
  store.setUserAgent(app.userAgentFallback.replace(/(\(KHTML, like Gecko\)).*?( Chrome\/)/, '$1$2').replace(/\sElectron\/\S+/g, ''), 'zh-CN,zh');
  if (!testMode && app.isPackaged) {
    registerProtocol(brand.protocol, app.getPath('userData'), protocol => app.setAsDefaultProtocolClient(protocol));
  }
  let loggingOut = false;
  const sync = () => { if (!loggingOut && !quitting) void auth.sync(); };
  const { win, navigate, probe } = createWindow(brand, sync);
  open = url => {
    if (!testMode) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
    }
    if (url) navigate(url);
  };
  const filename = (name: string) => join(app.getPath('userData'), name);
  function closePreviews() {
    for (const child of win.getChildWindows()) child.close();
  }
  async function clearCookies(url: string) {
    for (const cookie of await store.cookies.get({ url })) {
      await store.cookies.remove(new URL(cookie.path || '/', url).href, cookie.name);
    }
  }
  let notice = '', authDetail = '尚未登录';
  function changed() { tray?.render(); access.changed(); }
  async function confirmAll() {
    if (testMode) return false;
    const options: Electron.MessageBoxOptions = { type: 'warning', title: brand.displayName,
      message: '退出所有桌面设备？', detail: '此账号下的所有桌面设备都将断开本机访问，需要重新登录。',
      buttons: ['取消', '退出所有桌面设备'], defaultId: 0, cancelId: 0, noLink: true };
    const owner = access.current();
    try {
      const answer = owner?.isVisible() ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      return answer.response === 1;
    } catch {
      notice = '未能打开退出确认框，请重试';
      changed();
      return false;
    }
  }
  const logout = logoutAction(() => auth.token(), confirmAll, async (all, relogin) => {
    loggingOut = true;
    try {
      notice = await logoutDesktop(all, relogin, auth, closePreviews, clearCookies, origin, brand.previewHost, url => open?.(url));
    } catch { notice = '退出登录未完成，请重试'; }
    finally { loggingOut = false; changed(); }
  });
  const settings: HelperSettings = new HelperSettings(app.getPath('userData'), async () => {
    const owner = access.current();
    if (testMode || !owner) return;
    const { canceled, filePaths } = await dialog.showOpenDialog(owner, { properties: ['openDirectory'] });
    if (!owner.isDestroyed() && !canceled && filePaths.length === 1) return filePaths[0];
  }, () => { relay.settingsChanged(); changed(); });
  const auth = new DesktopAuth(origin, filename('desktop-token.enc'), safeStorage, {
    cookie: async () => (await store.cookies.get({ url: origin, name: 'wp_sid' }))[0]?.value,
    authorize: url => authorize(store, url),
    fetch: (url, options) => store.fetch(url, { credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15_000), ...options })
  }, text => { authDetail = text; changed(); }, undefined, state => {
    if (state === 'available') { notice = ''; if (!quitting && !loggingOut) relay.connect(); changed(); }
    else if (state === 'revoked') relay.credentialsRevoked();
    else relay.stop('user_logout');
  }, () => settings.snapshot().deviceName);
  const relay: DesktopRelay = new DesktopRelay({ origin, settings, auth, appVersion: app.getVersion(), status: (text, connection) => {
    if (connection === 'revoked') authDetail = text;
    testLog(text); changed();
  } });
  function view(): SettingsView {
    const config = settings.snapshot();
    const connection = config.paused && relay.connection !== 'revoked' ? 'paused' : relay.connection;
    const detail = connection === 'paused' ? '已保留授权目录，恢复后可重新连接' :
      (relay.state === '尚未登录' || connection === 'revoked') ? authDetail : relay.state;
    return { ...config, connection, connectionLabel: connectionLabels[connection], detail, canRetry: relay.canRetry, canRevoke: !!auth.token(),
      notice, platform: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
      version: app.getVersion() };
  }
  const access = settingsWindow('本机访问 · ' + brand.displayName, settings, view, logout);
  const tray = testMode ? undefined : createTray(brand, view, {
    show: () => open?.(), settings: access.open, retry: () => relay.wake(),
    pause: value => {
      try { settings.setPaused(value); }
      catch { notice = '暂停设置保存失败，请重试'; changed(); }
    },
    logout, login: () => { void logout(false, true); }
  });
  win.on('focus', () => relay.active());
  win.webContents.ipc.on('wp-online', event => {
    if (event.senderFrame === win.webContents.mainFrame) relay.wake();
  });
  powerMonitor.on('unlock-screen', () => relay.wake());
  app.on('before-quit', () => relay.stop('app_quit'));
  store.cookies.on('changed', (_event, cookie, _cause, removed) => {
    const domain = cookie.domain?.replace(/^\./, '');
    if (cookie.name !== 'wp_sid' || !domain || !(new URL(origin).hostname === domain ||
      (cookie.domain?.startsWith('.') && new URL(origin).hostname.endsWith('.' + domain)))) return;
    if (removed) {
      auth.clear();
      closePreviews();
      void clearCookies('https://' + brand.previewHost).catch(() => {});
    }
    sync();
  });
  if (testMode) {
    store.setPermissionCheckHandler(() => false);
    store.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  } else permissions(store, origin, win.webContents);
  store.on('will-download', (event, item, owner) => {
    if (testMode) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: '保存文件', buttonLabel: '保存' });
    const host = BrowserWindow.fromWebContents(owner) || win;
    item.on('updated', () => {
      if (!host.isDestroyed()) host.setProgressBar(item.getTotalBytes() > 0 ? item.getReceivedBytes() / item.getTotalBytes() : 2);
    });
    item.once('done', () => { if (!host.isDestroyed()) host.setProgressBar(-1); });
  });
  if (!testMode) Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: brand.displayName, submenu: [{ label: '打开主窗口', click: () => open?.() }, { label: '完全退出', role: 'quit' }] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
    { label: '窗口', submenu: [{ label: '重新加载', role: 'reload' }, { label: '最小化', role: 'minimize' }, { label: '关闭窗口', role: 'close' }] }
  ]));
  win.on('close', event => {
    if (quitting || testMode) return;
    event.preventDefault();
    win.hide();
    const hint = filename('tray-hint');
    if (!existsSync(hint)) {
      writeFileSync(hint, '1');
      if (Notification.isSupported()) new Notification({ title: brand.displayName, body: brand.displayName + '仍在运行，可从系统托盘重新打开。' }).show();
    }
  });
  const timer = setInterval(sync, 5 * 60_000);
  powerMonitor.on('resume', () => { void probe(); relay.wake(); sync(); });
  app.on('will-quit', () => { clearInterval(timer); tray?.tray.destroy(); });
  navigate(pending || origin + '/');
  if (!testMode && (pending || (!process.argv.includes('--hidden') && !app.getLoginItemSettings().wasOpenedAtLogin))) win.show();
  if (testMode) testLog(win.isVisible() ? '窗口可见' : '无界面运行');
  void auth.sync();
}
