import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export function registerProtocol(protocol: string, userData: string, register: (protocol: string) => boolean) {
  let message = '桌面深链协议注册失败 ' + protocol;
  try {
    if (register(protocol)) return;
  } catch (error) {
    message += ' ' + String(error);
  }
  console.warn(message);
  try {
    appendFileSync(join(userData, 'desktop.log'), new Date().toISOString() + ' ' + message + '\n', { mode: 0o600 });
  } catch (error) {
    console.warn('无法写入桌面日志', error);
  }
}
