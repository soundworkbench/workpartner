import { net, systemPreferences, type Session, type WebContents } from 'electron';

export function authorize(session: Session, url: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, session, useSessionCookies: true, redirect: 'manual' });
    const timer = setTimeout(() => { reject(new Error('授权超时')); req.abort(); }, 15_000);
    req.once('redirect', (status, _method, location) => {
      clearTimeout(timer);
      resolve({ status, location });
      req.abort();
    });
    req.once('response', response => {
      clearTimeout(timer);
      resolve({ status: response.statusCode });
      req.abort();
    });
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

export function permissions(session: Session, origin: string, trusted: WebContents) {
  const permitted = (wc: WebContents | null, url: string, main: boolean) =>
    wc === trusted && main && URL.canParse(url) && new URL(url).origin === origin &&
    URL.canParse(trusted.getURL()) && new URL(trusted.getURL()).origin === origin;
  session.setPermissionCheckHandler((wc, permission, url, details) =>
    permitted(wc, url, details.isMainFrame) &&
    (['clipboard-sanitized-write', 'notifications'].includes(permission) ||
      (permission === 'media' && details.mediaType === 'audio')));
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!permitted(wc, details.requestingUrl, details.isMainFrame)) return callback(false);
    if (permission !== 'media') return callback(['clipboard-sanitized-write', 'notifications'].includes(permission));
    const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
    if (types?.length !== 1 || types[0] !== 'audio') return callback(false);
    if (process.platform !== 'darwin') return callback(true);
    systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
  });
}
