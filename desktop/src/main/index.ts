import { app, BrowserWindow, Menu, Notification, powerMonitor, safeStorage, session } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWindow, type Brand } from './window.js';
import { deepTarget } from './links.js';
import { createTray } from './tray.js';
import { DesktopAuth } from './auth.js';
import { authorize, permissions } from './session.js';

const brand: Brand = JSON.parse(readFileSync(join(app.getAppPath(), 'brand/default/brand.json'), 'utf8'));
const origin = new URL(brand.defaultGatewayUrl).origin;
if (origin !== brand.defaultGatewayUrl.replace(/\/$/, '') || !origin.startsWith('https://') ||
    !/^[a-z][a-z0-9+.-]+$/.test(brand.protocol)) throw new Error('桌面品牌配置无效');
app.setName(brand.productName);
app.commandLine.appendSwitch('lang', 'zh-CN');
let open: ((url?: string) => void) | undefined;
let pending: string | undefined;
let quitting = false;
function receive(raw?: string) {
  const url = raw && deepTarget(raw, brand.protocol, origin);
  if (raw && !url) return;
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
  if (app.isPackaged) app.setAsDefaultProtocolClient(brand.protocol);
  const { win, navigate, probe } = createWindow(brand, () => void auth.sync());
  open = url => {
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
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
  const tray = createTray(brand, () => open?.(), () => {
    auth.clear();
    closePreviews();
    void Promise.all([clearCookies(origin), clearCookies('https://' + brand.previewHost)])
      .finally(() => open?.(origin + '/_wp/logout')).catch(() => tray.status('退出登录未完成，请重试'));
  });
  const auth = new DesktopAuth(origin, filename('desktop-token.enc'), safeStorage, {
    cookie: async () => (await store.cookies.get({ url: origin, name: 'wp_sid' }))[0]?.value,
    authorize: url => authorize(store, url),
    fetch: (url, options) => store.fetch(url, { credentials: 'omit', cache: 'no-store',
      redirect: 'error', signal: AbortSignal.timeout(15_000), ...options })
  }, tray.status);
  store.cookies.on('changed', (_event, cookie, _cause, removed) => {
    const domain = cookie.domain?.replace(/^\./, '');
    if (cookie.name !== 'wp_sid' || !domain || !(new URL(origin).hostname === domain ||
      (cookie.domain?.startsWith('.') && new URL(origin).hostname.endsWith('.' + domain)))) return;
    if (removed) {
      auth.clear();
      closePreviews();
      void clearCookies('https://' + brand.previewHost).catch(() => {});
    }
    void auth.sync();
  });
  permissions(store, origin, win.webContents);
  store.on('will-download', (_event, item, owner) => {
    item.setSaveDialogOptions({ title: '保存文件', buttonLabel: '保存' });
    const host = BrowserWindow.fromWebContents(owner) || win;
    item.on('updated', () => {
      if (!host.isDestroyed()) host.setProgressBar(item.getTotalBytes() > 0 ? item.getReceivedBytes() / item.getTotalBytes() : 2);
    });
    item.once('done', () => { if (!host.isDestroyed()) host.setProgressBar(-1); });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: brand.displayName, submenu: [{ label: '打开主窗口', click: () => open?.() }, { label: '完全退出', role: 'quit' }] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
    { label: '窗口', submenu: [{ label: '重新加载', role: 'reload' }, { label: '最小化', role: 'minimize' }, { label: '关闭窗口', role: 'close' }] }
  ]));
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    const hint = filename('tray-hint');
    if (!existsSync(hint)) {
      writeFileSync(hint, '1');
      if (Notification.isSupported()) new Notification({ title: brand.displayName, body: '工作伙伴仍在运行，可从系统托盘重新打开。' }).show();
    }
  });
  const timer = setInterval(() => void auth.sync(), 5 * 60_000);
  powerMonitor.on('resume', () => { void probe(); void auth.sync(); });
  app.on('will-quit', () => { clearInterval(timer); tray.tray.destroy(); });
  navigate(pending || origin + '/');
  if (pending || (!process.argv.includes('--hidden') && !app.getLoginItemSettings().wasOpenedAtLogin)) win.show();
  void auth.sync();
}
