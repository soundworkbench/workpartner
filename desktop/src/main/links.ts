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

// A loopback anchor can change during document capture, after the preload recorded it.
function rewrittenPreview(href: string, url: string) {
  const source = URL.parse(href), target = new URL(url);
  return source?.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(source.hostname) &&
    !source.username && !source.password && target.pathname === '/_wp_preview/start' &&
    target.searchParams.get('port') === (source.port || '80') &&
    target.searchParams.get('path') === source.pathname + source.search + source.hash;
}

// Each top-level document owns one click. Every attempted use consumes it.
export function linkGesture(now = () => performance.now()) {
  let grant: { href: string | null; expires: number } | undefined;
  return {
    record(href: string | null) { grant = { href, expires: now() + 1000 }; },
    clear() { grant = undefined; },
    consume(url: string, preview = false) {
      const click = grant;
      grant = undefined;
      if (!click || now() >= click.expires) return false;
      return click.href === url || (preview && (click.href === null || rewrittenPreview(click.href, url)));
    }
  };
}
