const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const version = process.argv.find(arg => arg.startsWith('--wp-version='))?.slice('--wp-version='.length);

if (process.isMainFrame) {
  if (version) contextBridge.exposeInMainWorld('__WP_DESKTOP__', { version, platform: process.platform });
  const anchors = new WeakMap<MouseEvent, HTMLAnchorElement>();
  for (const type of ['click', 'auxclick'] as const) {
    window.addEventListener(type, event => {
      if (!event.isTrusted || !navigator.userActivation.isActive || event.button > 1 || event.altKey || event.defaultPrevented) return;
      const anchor = event.composedPath().find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && el.hasAttribute('href'));
      if (anchor?.hasAttribute('download')) return;
      if (anchor) anchors.set(event, anchor);
      // Register before page handlers can synchronously call window.open().
      ipcRenderer.sendSync('wp-gesture', anchor?.href ?? null);
    }, true);
    window.addEventListener(type, event => {
      const anchor = anchors.get(event);
      if (!anchor || event.defaultPrevented || anchor.hasAttribute('download')) return;
      const target = (anchor.target || document.querySelector<HTMLBaseElement>('base[target]')?.target || '').toLowerCase();
      if (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey ||
          (target && !['_self', '_top', '_parent'].includes(target))) {
        event.preventDefault();
        // The gateway can rewrite a loopback anchor to its preview during document capture.
        ipcRenderer.send('wp-open-link', anchor.href);
      }
    });
  }
  window.addEventListener('offline', event => {
    if (event.isTrusted) ipcRenderer.send('wp-offline');
  });
}
