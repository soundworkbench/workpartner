const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const version = process.argv.find(arg => arg.startsWith('--wp-version='))?.slice('--wp-version='.length);

if (process.isMainFrame) {
  if (version) contextBridge.exposeInMainWorld('__WP_DESKTOP__', { version, platform: process.platform });
  const trusted = (event: MouseEvent) => event.isTrusted && (event.button === 0 || event.button === 1);
  for (const type of ['click', 'auxclick'] as const) {
    window.addEventListener(type, event => {
      if (!trusted(event)) return;
      // WindowOpenHandler does not expose Chromium's userGesture flag.
      ipcRenderer.send('wp-gesture', true);
      setTimeout(() => ipcRenderer.send('wp-gesture', false), 0);
    }, true);
    window.addEventListener(type, event => {
      if (!trusted(event) || event.defaultPrevented) return;
      const anchor = event.composedPath().find(el => el instanceof HTMLAnchorElement);
      if (anchor && !anchor.hasAttribute('download')) ipcRenderer.send('wp-link', anchor.href);
    });
  }
  window.addEventListener('offline', event => {
    if (event.isTrusted) ipcRenderer.send('wp-offline');
  });
}
