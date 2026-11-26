import { app, BrowserWindow, WebContentsView, net, screen, shell, type WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testLog, testMode } from './test-mode.js';
import { navigationPolicy } from './links.js';

export type Brand = { productName: string; displayName: string; appId: string; protocol: string; defaultGatewayUrl: string; previewHost: string; loginOrigins: string[] };
const offlineFile = fileURLToPath(new URL('./offline.html', import.meta.url));
const offlineURL = pathToFileURL(offlineFile).href;
const safePrefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: testMode,
  offscreen: testMode, preload: fileURLToPath(new URL('../preload/shell-preload.cjs', import.meta.url)) };

function initialBounds(file: string) {
  try {
    const bounds = JSON.parse(readFileSync(file, 'utf8'));
    if (['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key])) && bounds.width >= 600 && bounds.height >= 400 &&
        screen.getAllDisplays().some(({ workArea: a }) => bounds.x + 80 <= a.x + a.width && bounds.x + bounds.width >= a.x + 80 &&
          bounds.y >= a.y && bounds.y + 40 <= a.y + a.height)) return bounds as Electron.Rectangle;
  } catch { /* First launch or removed display. */ }
  return { width: 1160, height: 800 };
}

export function createWindow(brand: Brand, onGateway: () => void) {
  const origin = new URL(brand.defaultGatewayUrl).origin;
  const file = join(app.getPath('userData'), 'window.json');
  const win = new BrowserWindow({ ...initialBounds(file), show: false, title: brand.displayName,
    minWidth: 600, minHeight: 400, webPreferences: { ...safePrefs,
      additionalArguments: ['--wp-version=' + app.getVersion()] } });
  const wc = win.webContents;
  const route = navigationPolicy(origin, brand.previewHost, brand.loginOrigins, url => {
    if (testMode) testLog('记录外链', url);
    else void shell.openExternal(url).catch(() => {});
  });
  let destination = origin + '/', offline = false, probing = false;

  function disconnected() {
    if (offline || win.isDestroyed()) return;
    offline = true;
    testLog('显示离线页');
    void win.loadFile(offlineFile).catch(() => {});
  }
  function navigate(url: string) {
    offline = false;
    if (new URL(url).origin === origin) destination = url;
    testLog('加载', url);
    // did-fail-load handles network errors. A cancelled redirect is not a disconnect.
    void win.loadURL(url).catch(() => {});
  }
  async function probe() {
    if (win.isDestroyed()) return;
    if (!net.isOnline()) { disconnected(); return; }
    if (!offline || probing) return;
    probing = true;
    try {
      if (wc.getURL() !== offlineURL || !await wc.executeJavaScript('navigator.onLine')) return;
      const response = await wc.session.fetch(origin + '/_wp/me', { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (offline && (response.ok || response.status === 401)) navigate(destination);
    } catch { /* Retry on the next tick. */ }
    finally { probing = false; }
  }

  function bind(contents: WebContents, preview: boolean) {
    let gestureUntil = 0;
    contents.ipc.on('wp-gesture', (event, active) => {
      if (event.senderFrame === contents.mainFrame) gestureUntil = active === true ? Date.now() + 500 : 0;
    });
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame) gestureUntil = 0;
    });
    contents.ipc.on('wp-link', (event, url) => {
      if (event.senderFrame === contents.mainFrame && typeof url === 'string') route(url, 'click', true);
    });
    contents.setWindowOpenHandler(({ url }) => {
      const target = route(url, 'popup', Date.now() < gestureUntil);
      gestureUntil = 0;
      if (target === 'main') navigate(url);
      if (target === 'preview') openPreview(url);
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>, redirect: boolean) => {
      const { url } = event;
      if (!event.isMainFrame) {
        if (!/^(https?:|about:|blob:|data:)/i.test(url)) event.preventDefault();
        return;
      }
      if (!preview && offline && contents.getURL() === offlineURL && url === 'about:blank#retry') {
        event.preventDefault(); navigate(destination); return;
      }
      const target = route(url, redirect ? 'redirect' : 'navigation');
      if (redirect) testLog('重定向 ' + target, url);
      if (!preview && target === 'main') return;
      if (preview && (target === 'preview' || url.startsWith(origin + '/_wp/preview/authorize?'))) return;
      event.preventDefault();
      if (target === 'preview') openPreview(url);
      if (target === 'main') navigate(url);
    };
    contents.on('will-frame-navigate', event => guard(event, false));
    contents.on('will-redirect', event => guard(event, true));
  }

  function openPreview(url: string) {
    const child = new BrowserWindow({ parent: win, show: !testMode, title: '工作区预览', width: 960, height: 720, webPreferences: safePrefs });
    const view = new WebContentsView({ webPreferences: safePrefs });
    const page = view.webContents;
    bind(page, true);
    child.contentView.addChildView(view);
    const layout = () => {
      const [width, height] = child.getContentSize();
      view.setBounds({ x: 0, y: 42, width, height: Math.max(0, height - 42) });
    };
    layout();
    child.on('resize', layout);
    child.on('closed', () => { if (!page.isDestroyed()) page.close(); });
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', event => {
      event.preventDefault();
      if (event.url === 'about:blank#refresh') page.reload();
    });
    child.webContents.ipc.on('wp-link', (event, href) => {
      if (event.senderFrame === child.webContents.mainFrame && href === 'about:blank#browser') {
        route(url, 'preview-toolbar', true);
      }
    });
    void child.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';style-src \'unsafe-inline\'"><title>工作区预览</title><style>body{font:14px system-ui;margin:10px}a{margin-right:16px}</style><a href="about:blank#refresh">刷新</a><a href="about:blank#browser">在浏览器中打开</a>'));
    void page.loadURL(url).catch(() => {});
  }

  bind(wc, false);
  wc.ipc.on('wp-offline', event => { if (event.senderFrame === wc.mainFrame) disconnected(); });
  wc.on('did-fail-load', (_event, code, _desc, _url, main) => { if (main && code !== -3) disconnected(); });
  wc.on('did-finish-load', () => {
    if (URL.canParse(wc.getURL()) && new URL(wc.getURL()).origin === origin) {
      // Restart from home if a failed navigation interrupted a one-use login callback.
      destination = origin + '/';
      onGateway();
    }
  });
  const interval = setInterval(() => void probe(), 5000);
  let debounce: NodeJS.Timeout;
  const remember = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (!win.isDestroyed()) writeFileSync(file, JSON.stringify(win.getNormalBounds()), { mode: 0o600 });
    }, 300);
  };
  win.on('move', remember);
  win.on('resize', remember);
  win.on('closed', () => { clearInterval(interval); clearTimeout(debounce); });
  return { win, navigate, probe };
}
