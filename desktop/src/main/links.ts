export function linkKind(raw: string, gateway: string, previewHost: string, loginOrigins: readonly string[]) {
  let url: URL;
  try { url = new URL(raw); } catch { return 'blocked'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked';
  if (url.origin === gateway || (url.protocol === 'https:' && loginOrigins.includes(url.origin))) return 'main';
  if (url.origin === 'https://' + previewHost) return 'preview';
  return 'external';
}

export function deepTarget(raw: string, protocol: string, gateway: string) {
  let url: URL;
  try { url = new URL(raw); } catch { return; }
  if (url.protocol !== protocol + ':' || url.host !== 'open' || url.username || url.password ||
      !['', '/'].includes(url.pathname)) return;
  const path = url.searchParams.get('path') ?? '/';
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/.test(path)) return;
  const target = new URL(path, gateway);
  if (target.origin === gateway) return target.href;
}

type NavigationSource = 'navigation' | 'redirect' | 'click' | 'popup' | 'preview-toolbar';
export function navigationPolicy(gateway: string, previewHost: string, loginOrigins: string[],
    openExternal: (url: string) => void, now = Date.now) {
  let lastOpen = -Infinity;
  return (url: string, source: NavigationSource, gesture = false) => {
    const target = linkKind(url, gateway, previewHost, loginOrigins);
    if (source === 'popup' && !gesture) return 'blocked';
    const toolbar = source === 'preview-toolbar' && target === 'preview';
    if (target !== 'external' && !toolbar) return target;
    if (gesture && (source === 'click' || source === 'popup' || toolbar) && now() - lastOpen >= 5000) {
      lastOpen = now();
      openExternal(new URL(url).href);
    }
    return 'blocked';
  };
}

// Each top-level document owns one click. Every attempted use consumes it.
export function linkGesture(now = Date.now) {
  let href: string | undefined;
  let expires = 0;
  return {
    record(url?: string) { href = url; expires = now() + 1000; },
    consume(url: string) {
      const allowed = url === href && now() < expires;
      href = undefined;
      return allowed;
    }
  };
}
