// Test-package entry point. Run its executable with --test-preview-links.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, session } from 'electron';
import { installPreviewClient } from './preview-client.mjs';
import { testMode } from './main/build-mode.js';
import { createWindow } from './main/window.js';

async function run() {
  assert.equal(testMode, true);
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'wp-preview-smoke-')));
  app.commandLine.appendSwitch('use-mock-keychain');
  app.disableHardwareAcceleration();
  await app.whenReady();

  const gateway = 'https://desk.example.org', previewHost = 'preview.example.org';
  const final = 'https://' + previewHost + '/_wp_preview/start?owner=sample&port=8080&path=%2Fguide';
  const visits = [];
  const html = `<!doctype html><style>a{position:fixed;inset:0}</style><a href="http://localhost:8080/guide">Preview A</a>
    <script>
      (${installPreviewClient})({ previewHost: ${JSON.stringify(previewHost)}, scope: 'sample' });
      document.querySelector('a').onclick = event => {
        window.trusted = event.isTrusted;
        if (window.tryOther) {
          event.preventDefault();
          window.open('https://${previewHost}/other', '_blank');
        }
      };
    </script>`;
  session.defaultSession.protocol.handle('https', req => {
    visits.push(req.url);
    return new Response(req.url === gateway + '/' ? html : '<title>Preview</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  });
  const { win } = createWindow({ defaultGatewayUrl: gateway, previewHost, displayName: 'Smoke', loginOrigins: [] }, () => {});
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  async function click(other) {
    await win.loadURL(gateway + '/');
    await wc.executeJavaScript(`window.tryOther = ${other};
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const x = 40, y = 40;
    assert.equal(await wc.executeJavaScript('document.elementFromPoint(40, 40)?.tagName'), 'A');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    assert.equal(await wc.executeJavaScript('window.trusted'), true);
    assert.equal(await wc.executeJavaScript('document.querySelector("a").href'), final);
    assert.equal(await wc.executeJavaScript('document.querySelector("a").target'), '_blank');
  }

  try {
    wc.debugger.attach();
    await click(true);
    // window.open is synchronous: an admitted request already created its child.
    assert.equal(win.getChildWindows().length, 0, '点击 A 后脚本请求 B 必须被拒绝');
    assert.ok(!visits.includes('https://' + previewHost + '/other'));
    console.log('PASS 点击 A 后脚本请求 B 被拒绝');

    await click(false);
    for (let i = 0; i < 100 && !visits.includes(final); i++) await delay(20);
    assert.ok(visits.includes(final), '预览窗口必须加载网关改写后的完整 URL');
    assert.equal(win.getChildWindows().length, 1);
    assert.ok([win, ...win.getChildWindows()].every(window => !window.isVisible()));
    console.log('PASS 真实点击本地链接，网关改写 HTTPS，预览窗口加载最终地址');
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
    win.destroy();
  }
}

if (process.argv.includes('--test-preview-links')) {
  run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  await import('./main/index.js');
}
