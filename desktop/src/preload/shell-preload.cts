const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const version = process.argv.find(arg => arg.startsWith('--wp-version='))?.slice('--wp-version='.length);

if (process.isMainFrame) {
  if (version) contextBridge.exposeInMainWorld('__WP_DESKTOP__', { version, platform: process.platform });
  const trusted = (event: MouseEvent) => event.isTrusted && (event.button === 0 || event.button === 1);
  for (const type of ['click', 'auxclick'] as const) {
    window.addEventListener(type, event => {
      if (!trusted(event) || !navigator.userActivation.isActive || event.defaultPrevented || event.altKey) return;
      const anchor = event.composedPath().find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && el.hasAttribute('href'));
      if (!anchor || anchor.hasAttribute('download')) return;
      // The gateway rewrites loopback links during document capture. Read the result
      // in window bubble, while the trusted click still has transient activation.
      const href = anchor.href;
      ipcRenderer.sendSync('wp-gesture', href);
      const target = (anchor.target || document.querySelector<HTMLBaseElement>('base[target]')?.target || '').toLowerCase();
      if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey ||
          (target && !['_self', '_top', '_parent'].includes(target))) {
        event.preventDefault();
        ipcRenderer.send('wp-open-link', href);
      }
    });
  }
  window.addEventListener('offline', event => {
    if (event.isTrusted) ipcRenderer.send('wp-offline');
  });
}
