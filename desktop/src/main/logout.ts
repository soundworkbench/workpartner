import type { DesktopAuth } from './auth.js';

export async function logoutDesktop(all: boolean, relogin: boolean, auth: Pick<DesktopAuth, 'clear' | 'revokeAll'>,
    closePreviews: () => void, clearCookies: (url: string) => Promise<void>, origin: string, previewHost: string,
    navigate: (url: string) => void) {
  let revokeFailed = false;
  if (all) {
    try { await auth.revokeAll(); } catch { revokeFailed = true; }
  }
  let cleaned = true;
  try { cleaned = auth.clear({ sessionEnded: false }) !== false; } catch { cleaned = false; }
  let previewsClosed = true;
  try { closePreviews(); } catch { previewsClosed = false; }
  const cleanup = await Promise.allSettled([origin, 'https://' + previewHost].map(async url => clearCookies(url)));
  const login = relogin && cleaned && previewsClosed && cleanup.every(result => result.status === 'fulfilled');
  navigate(origin + (login ? '/_wp/login' : '/_wp/logout'));
  return [revokeFailed && '本机已退出，其他桌面设备的退出未确认',
    !cleaned && '本机凭据清理未完成', !previewsClosed && '预览窗口关闭失败'].filter(Boolean).join('；');
}
