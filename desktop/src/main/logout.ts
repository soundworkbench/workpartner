import type { DesktopAuth } from './auth.js';

export async function logoutDesktop(all: boolean, auth: Pick<DesktopAuth, 'clear' | 'revokeAll'>,
    closePreviews: () => void, clearCookies: (url: string) => Promise<void>, origin: string, previewHost: string,
    navigate: (url: string) => void, status: (message: string) => void) {
  let revokeFailed = false;
  if (all) {
    try { await auth.revokeAll(); } catch { revokeFailed = true; }
  }
  auth.clear();
  closePreviews();
  await Promise.allSettled([clearCookies(origin), clearCookies('https://' + previewHost)]);
  navigate(origin + '/_wp/logout');
  if (revokeFailed) status('本机已退出，其他桌面设备的退出未确认');
}
