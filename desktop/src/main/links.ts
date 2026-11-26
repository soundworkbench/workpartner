const loginOrigins = new Set(['https://accounts.feishu.cn', 'https://open.feishu.cn', 'https://passport.feishu.cn']);

export function linkKind(raw: string, gateway: string, previewHost: string) {
  let url: URL;
  try { url = new URL(raw); } catch { return 'blocked'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return 'blocked';
  if (url.origin === gateway || loginOrigins.has(url.origin)) return 'main';
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
