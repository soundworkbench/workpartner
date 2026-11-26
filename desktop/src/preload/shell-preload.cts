const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const version = process.argv.find(arg => arg.startsWith('--wp-version='))?.slice('--wp-version='.length);

if (process.isMainFrame) {
  if (version) contextBridge.exposeInMainWorld('__WP_DESKTOP__', { version, platform: process.platform });
  let activeClick: { event: MouseEvent; anchor?: HTMLAnchorElement; expires: number; used: boolean } | undefined;
  if (version) contextBridge.exposeInMainWorld('wpDesktop', {
    openPreview(url: string) {
      const click = activeClick;
      // eventPhase returns to NONE when synchronous event dispatch ends.
      if (!click || click.used || !click.event.isTrusted || click.event.eventPhase === Event.NONE ||
          !navigator.userActivation.isActive || performance.now() >= click.expires || typeof url !== 'string') return;
      click.used = true;
      if (!click.anchor) ipcRenderer.sendSync('wp-preview-gesture', url);
      ipcRenderer.send('wp-open-preview', url);
    }
  });
  const anchors = new WeakMap<MouseEvent, HTMLAnchorElement>();
  for (const type of ['click', 'auxclick'] as const) {
    window.addEventListener(type, event => {
      if (!event.isTrusted) return;
      activeClick = undefined;
      if (!navigator.userActivation.isActive || event.button > 1 || event.altKey || event.defaultPrevented) return;
      const anchor = event.composedPath().find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement && el.hasAttribute('href'));
      if (anchor?.hasAttribute('download')) return;
      activeClick = { event, anchor, expires: performance.now() + 1000, used: false };
      if (anchor) {
        anchors.set(event, anchor);
        ipcRenderer.sendSync('wp-gesture', anchor.href);
      }
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
