import { app, BrowserWindow, WebContentsView, net, screen, shell, type WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { linkKind } from './links.js';

export type Brand = { productName: string; displayName: string; appId: string; protocol: string; defaultGatewayUrl: string; previewHost: string };
const offlineFile = fileURLToPath(new URL('./offline.html', import.meta.url));
const offlineURL = pathToFileURL(offlineFile).href;
const safePrefs = { sandbox: true, contextIsolation: true, nodeIntegration: false };
const external = (url: string) => { void shell.openExternal(url).catch(() => {}); };

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
      preload: fileURLToPath(new URL('../preload/shell-preload.cjs', import.meta.url)),
      additionalArguments: ['--wp-version=' + app.getVersion()] } });
  const wc = win.webContents;
  const kind = (url: string) => linkKind(url, origin, brand.previewHost);
  let destination = origin + '/', offline = false, probing = false;

  function disconnected() {
    if (offline || win.isDestroyed()) return;
    offline = true;
    void win.loadFile(offlineFile).catch(() => {});
  }
  function navigate(url: string) {
    offline = false;
    if (new URL(url).origin === origin) destination = url;
    void win.loadURL(url).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_ABORTED') disconnected();
    });
  }
  async function probe() {
    if (win.isDestroyed()) return;
    if (!net.isOnline()) { disconnected(); return; }
    if (!offline || probing) return;
    probing = true;
    try {
      const response = await wc.session.fetch(origin + '/_wp/me', { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (offline && (response.ok || response.status === 401)) navigate(destination);
    } catch { /* Retry on the next tick. */ }
    finally { probing = false; }
  }

  function bind(contents: WebContents, preview: boolean) {
    const route = (url: string) => {
      switch (kind(url)) {
        case 'main': navigate(url); win.show(); break;
        case 'preview': openPreview(url); break;
        case 'external': external(url); break;
      }
    };
    contents.setWindowOpenHandler(({ url }) => { route(url); return { action: 'deny' }; });
    const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
      if (!event.isMainFrame) return;
      const { url } = event;
      if (!preview && offline && contents.getURL() === offlineURL && url === 'about:blank#retry') {
        event.preventDefault(); navigate(destination); return;
      }
      const category = kind(url);
      if (!preview && category === 'main') return;
      if (preview && (category === 'preview' || url.startsWith(origin + '/_wp/preview/authorize?'))) return;
      event.preventDefault();
      route(url);
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  }

  function openPreview(url: string) {
    const child = new BrowserWindow({ parent: win, title: '工作区预览', width: 960, height: 720, webPreferences: safePrefs });
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
      if (event.url === 'about:blank#browser') external(url);
    });
    void child.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';style-src \'unsafe-inline\'"><title>工作区预览</title><style>body{font:14px system-ui;margin:10px}a{margin-right:16px}</style><a href="about:blank#refresh">刷新</a><a href="about:blank#browser">在浏览器中打开</a>'));
    void page.loadURL(url).catch(() => {});
  }

  bind(wc, false);
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
