import type { DesktopAuth } from './auth.js';

export async function logoutDesktop(all: boolean, relogin: boolean, auth: Pick<DesktopAuth, 'clear' | 'revokeAll'>,
    closePreviews: () => void, clearCookies: (url: string) => Promise<void>, origin: string, previewHost: string,
    navigate: (url: string) => void) {
  let revokeFailed = false;
  if (all) {
    try { await auth.revokeAll(); } catch { revokeFailed = true; }
  }
  auth.clear();
  closePreviews();
  const cleanup = await Promise.allSettled([clearCookies(origin), clearCookies('https://' + previewHost)]);
  const login = relogin && cleanup.every(result => result.status === 'fulfilled');
  navigate(origin + (login ? '/_wp/login' : '/_wp/logout'));
  return revokeFailed ? '本机已退出，其他桌面设备的退出未确认' : '';
}
