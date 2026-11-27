import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { HelperSettings } from './helper-settings.js';
import type { Connection } from './relay.js';

export const connectionLabels: Record<Connection, string> = {
  connected: '已连接网关', connecting: '连接中…', offline: '离线',
  revoked: '凭据已吊销，需重新登录', paused: '本机助手已暂停'
};

export type SettingsView = ReturnType<HelperSettings['snapshot']> & {
  connection: Connection; connectionLabel: string; detail: string; canRetry: boolean; canRevoke: boolean;
  platform: string; version: string; notice: string;
};

export function settingsHandler(owner: WebContents, page: string, settings: HelperSettings,
  view: () => SettingsView, logout: (all: boolean) => Promise<void>) {
  return (event: IpcMainInvokeEvent, action: unknown, ...args: unknown[]) => {
    const frame = event.senderFrame;
    if (owner.isDestroyed() || event.sender !== owner || !frame || frame !== owner.mainFrame ||
        frame.url !== page || owner.getURL() !== page) throw new Error('设置请求来源无效');
    const [value] = args;
    switch (action) {
      case 'read': if (!args.length) return view(); break;
      case 'addDirectory': if (!args.length) return settings.addDirectory(); break;
      case 'removeDirectory':
        if (args.length === 1 && typeof value === 'string' && settings.snapshot().allowedRoots.includes(value))
          return settings.removeDirectory(value);
        break;
      case 'setDeviceName':
        if (args.length === 1 && typeof value === 'string' && value.trim() && value.length <= 128 &&
            !/[\u0000-\u001f\u007f-\u009f]/.test(value)) return settings.setDeviceName(value);
        break;
      case 'setPreferred':
        if (args.length === 1 && typeof value === 'boolean') return settings.setPreferred(value);
        break;
      case 'setPaused':
        if (args.length === 1 && typeof value === 'boolean') return settings.setPaused(value);
        break;
      case 'logout': if (!args.length) return logout(false); break;
      case 'logoutAll': if (!args.length) return logout(true); break;
    }
    throw new Error('设置参数无效');
  };
}

// Both entry points share the prompt and the in-progress guard.
export function logoutAction(token: () => string | undefined, confirmAll: () => Promise<boolean>,
  perform: (all: boolean, relogin: boolean) => Promise<void>) {
  let busy = false;
  return async (all: boolean, relogin = false) => {
    if (busy) return;
    busy = true;
    try {
      if (all) {
        const before = token();
        if (!before || !await confirmAll() || token() !== before) return;
      }
      await perform(all, relogin);
    } finally { busy = false; }
  };
}
