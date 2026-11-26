const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const version = process.argv.find(arg => arg.startsWith('--wp-version='))?.slice('--wp-version='.length);

if (process.isMainFrame) {
  if (version) contextBridge.exposeInMainWorld('__WP_DESKTOP__', { version, platform: process.platform });
  const trusted = (event: MouseEvent) => event.isTrusted && (event.button === 0 || event.button === 1);
  for (const type of ['click', 'auxclick'] as const) {
    window.addEventListener(type, event => {
      if (!trusted(event)) return;
      const anchor = event.composedPath().find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && el.hasAttribute('href'));
      // Deliver the original href before page handlers or the default navigation can run.
      ipcRenderer.sendSync('wp-gesture', anchor && !anchor.hasAttribute('download') ? anchor.href : null);
    }, true);
  }
  window.addEventListener('offline', event => {
    if (event.isTrusted) ipcRenderer.send('wp-offline');
  });
}
