import { app, Menu, nativeImage, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from './relay.js';
import type { SettingsView } from './settings-actions.js';
import type { Brand } from './window.js';

// Use distinct shapes so the badge also works in a monochrome system tray.
const marks: Record<Connection, string[]> = {
  connected:  ['     #', '    ##', '#  ## ', '####  ', ' ##   '],
  connecting: ['      ', '      ', '##  ##', '##  ##', '      '],
  offline:    ['      ', '      ', '######', '######', '      '],
  revoked:    ['##  ##', ' #### ', '  ##  ', ' #### ', '##  ##'],
  paused:     ['##  ##', '##  ##', '##  ##', '##  ##', '##  ##']
};
function trayImage(state: Connection) {
  const icon = join(app.getAppPath(), 'brand/default/resources/tray-windows.ico');
  const pixels = Buffer.alloc(20 * 20 * 4);
  for (let y = 3; y < 18; y++) for (let x = 2; x < 18; x++) {
    const bubble = y < 15 && (y === 3 || y === 14 || x === 2 || x === 17 || (y === 8 && x % 4 === 1));
    if (bubble || (y >= 15 && x === 20 - y)) pixels[(20 * y + x) * 4 + 3] = 255;
  }
  if (process.platform === 'win32' && existsSync(icon)) {
    const branded = nativeImage.createFromPath(icon);
    if (!branded.isEmpty()) branded.resize({ width: 20, height: 20 }).toBitmap({ scaleFactor: 1 }).copy(pixels);
  }
  for (let y = 12; y < 20; y++) pixels.fill(0, (20 * y + 11) * 4, (20 * y + 20) * 4);
  const mark = marks[state];
  for (let y = 0; y < mark.length; y++) for (let x = 0; x < mark[y].length; x++) {
    if (mark[y][x] === '#') pixels[(20 * (13 + y) + 13 + x) * 4 + 3] = 255;
  }
  const image = nativeImage.createFromBitmap(pixels, { width: 20, height: 20 });
  image.setTemplateImage(true);
  return image;
}

type Actions = {
  show(): void; settings(): void; pause(value: boolean): void; retry(): void;
  logout(all: boolean): void; login(): void;
};
export function createTray(brand: Brand, view: () => SettingsView, actions: Actions) {
  let iconState = view().connection;
  const tray = new Tray(trayImage(iconState));
  const args = process.platform === 'win32' ? ['--hidden'] : [];
  function render() {
    const state = view();
    if (state.connection !== iconState) {
      iconState = state.connection;
      tray.setImage(trayImage(iconState));
    }
    const status = state.connection === 'paused' ? state.connectionLabel : '本机助手 · ' + state.connectionLabel;
    const count = state.allowedRoots.length;
    tray.setToolTip(brand.displayName + ' · ' + state.connectionLabel);
    const menu: Electron.MenuItemConstructorOptions[] = [{ label: status, enabled: false }];
    if (state.connection === 'connected') {
      menu.push({ label: state.deviceName + (state.preferred ? '（首选）' : ''), enabled: false },
        { label: count ? '已授权 ' + count + ' 个只读目录' : '尚未添加授权目录', enabled: false });
    } else if (state.detail) menu.push({ label: state.detail, enabled: false });
    if (state.notice) menu.push({ label: state.notice, enabled: false });
    if (state.canRetry) menu.push({ label: '立即重连', click: actions.retry });
    if (state.connection === 'revoked') menu.push({ label: '重新登录', click: actions.login });
    menu.push({ type: 'separator' }, { label: '打开' + brand.displayName, click: actions.show },
      { label: '本机访问设置…', click: actions.settings },
      { label: state.paused ? '恢复本机助手' : '暂停本机助手', enabled: state.connection !== 'revoked',
        click: () => actions.pause(!state.paused) }, { type: 'separator' },
      { label: '开机启动', type: 'checkbox', checked: app.getLoginItemSettings({ args }).openAtLogin,
        click: item => app.setLoginItemSettings({ openAtLogin: item.checked, args }) },
      { label: '退出登录（仅此设备）', click: () => actions.logout(false) },
      { label: '退出所有桌面设备…', enabled: state.canRevoke, click: () => actions.logout(true) },
      { type: 'separator' }, { label: '完全退出', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(menu));
  }
  render();
  tray.on('double-click', actions.show);
  if (process.platform === 'win32') tray.on('click', actions.show);
  return { tray, render };
}
