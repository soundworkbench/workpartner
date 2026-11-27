import { app, Menu, nativeImage, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Brand } from './window.js';

function trayImage() {
  const icon = join(app.getAppPath(), 'brand/default/resources/tray-windows.ico');
  if (process.platform === 'win32' && existsSync(icon)) return nativeImage.createFromPath(icon);
  const pixels = Buffer.alloc(20 * 20 * 4);
  for (let y = 3; y < 18; y++) for (let x = 2; x < 18; x++) {
    const bubble = y < 15 && (y === 3 || y === 14 || x === 2 || x === 17 || (y === 8 && x % 4 === 1));
    if (bubble || (y >= 15 && x === 20 - y)) pixels[(20 * y + x) * 4 + 3] = 255;
  }
  const image = nativeImage.createFromBitmap(pixels, { width: 20, height: 20 });
  image.setTemplateImage(true);
  return image;
}

export function createTray(brand: Brand, show: () => void, logout: () => void) {
  const tray = new Tray(trayImage());
  const args = process.platform === 'win32' ? ['--hidden'] : [];
  let status = '尚未登录';
  function render() {
    tray.setToolTip(brand.displayName + ' · ' + status);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开工作伙伴', click: show }, { label: status, enabled: false }, { type: 'separator' },
      { label: '开机启动', type: 'checkbox', checked: app.getLoginItemSettings({ args }).openAtLogin,
        click: item => app.setLoginItemSettings({ openAtLogin: item.checked, args }) },
      { label: '退出登录', click: logout }, { type: 'separator' }, { label: '完全退出', click: () => app.quit() }
    ]));
  }
  render();
  tray.on('double-click', show);
  if (process.platform === 'win32') tray.on('click', show);
  return { tray, status: (value: string) => { if (value !== status) { status = value; render(); } } };
}
