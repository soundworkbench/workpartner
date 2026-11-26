import { testMode } from './build-mode.js';
export { testMode };

export function testLog(action: string, url?: string) {
  if (!testMode) return;
  // Authorization codes and callback state must stay out of the logs.
  const target = url && new URL(url);
  console.log('[桌面测试]', action, target ? target.origin + target.pathname : '');
}
