// Test-package entry point. Run its executable with --test-preview-links.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mock } from 'node:test';
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
  app.on('window-all-closed', () => {}); // Each case uses a fresh workspace.
  await app.whenReady();

  const gateway = 'https://desk.example.org', previewHost = 'preview.example.org';
  const provider = 'https://accounts.feishu.cn', preview = 'https://' + previewHost;
  const local = 'http://localhost:8080/guide';
  const final = preview + '/_wp_preview/start?owner=sample&port=8080&path=%2Fguide';
  const visits = [];
  const html = `<!doctype html><style>button,a{display:block;width:180px;height:42px}</style>
    <button>Preview</button><a href="${local}">Preview A</a><iframe srcdoc="<p>Frame</p>"></iframe>
    <script>
      (${installPreviewClient})({ previewHost: ${JSON.stringify(previewHost)}, scope: 'sample' });
      window.addEventListener('click', e => { window.trusted = e.isTrusted && navigator.userActivation.isActive; }, true);
    </script>`;
  const connect = '/_wp/feishu/connect?return=settings&display=redirect';
  session.defaultSession.protocol.handle('https', req => {
    visits.push(req.url);
    if (req.url === gateway + connect) return Response.redirect(provider + '/authorize', 302);
    return new Response(req.url === gateway + '/' ? html : '<title>Fixture</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  });

  async function until(predicate, message) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await delay(20);
    }
    assert.fail(message);
  }
  const failures = [];
  async function check(name, action) {
    const { win } = createWindow({ defaultGatewayUrl: gateway, previewHost, displayName: 'Smoke', loginOrigins: [provider] }, () => {});
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    const js = script => wc.executeJavaScript(script);
    async function click(handler, selector = 'button') {
      const point = await js(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.onclick = event => { ${handler} };
        const { x, y } = el.getBoundingClientRect();
        return { x: x + 5, y: y + 5 };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    }
    const none = async () => {
      await delay(150);
      assert.equal(win.getChildWindows().length, 0, '预览窗口数');
      assert.ok(!visits.some(url => url.startsWith(preview + '/')), '不应访问预览域');
    };
    try {
      visits.length = 0;
      wc.debugger.attach();
      await win.loadURL(gateway + '/');
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await action({ click, js, none, wc, win });
      assert.ok([win, ...win.getChildWindows()].every(window => !window.isVisible()));
      console.log('PASS', name);
    } catch (error) {
      console.error('FAIL', name, error.message);
      failures.push(name);
    } finally {
      if (wc.debugger.isAttached()) wc.debugger.detach();
      for (const child of win.getChildWindows()) child.destroy();
      win.destroy();
    }
  }
  const open = 'window.open(' + JSON.stringify(local) + ', "_blank", "noopener")';
  const loaded = () => until(() => visits.includes(final), '预览窗口没有加载网关改写后的完整地址');
  await check('真实按钮点击通过 window.open 打开预览', async ({ click, js, win }) => {
    await click(open);
    assert.equal(await js('window.trusted'), true);
    await loaded();
    assert.equal(win.getChildWindows().length, 1);
  });
  await check('没有点击的 window.open 被拒绝', async ({ js, none }) => {
    await js('void ' + open);
    await none();
  });
  await check('点击超过一秒的 window.open 被拒绝', async ({ click, js, none }) => {
    await click('');
    assert.equal(await js('window.trusted'), true);
    await delay(1150);
    await js('void ' + open);
    await none();
  });
  await check('一次点击连开两次仅加载第一个地址', async ({ click, win }) => {
    await click(open + '; window.open("https://preview.example.org/second")');
    await loaded();
    assert.equal(win.getChildWindows().length, 1);
    assert.ok(!visits.includes(preview + '/second'));
  });
  await check('无点击的脚本预览导航产生零个预览窗口', async ({ js, none }) => {
    await js('location.assign("https://preview.example.org/script")');
    await none();
  });
  await check('子 frame 发起顶层预览导航不能使用主 frame 凭证', async ({ click, js, none }) => {
    await click('');
    assert.equal(await js('window.trusted'), true);
    await js('frames[0].eval(\'top.location.assign("https://preview.example.org/frame")\')');
    await none();
  });
  await check('可信按钮导航到预览域加载预览', async ({ click, win }) => {
    await click('location.assign(' + JSON.stringify(final) + ')');
    await loaded();
    assert.equal(win.getChildWindows().length, 1);
  });
  await check('点击 A 后脚本请求 B 被拒绝', async ({ click, none }) => {
    await click('event.preventDefault(); window.open("https://preview.example.org/other")', 'a');
    await none();
  });
  await check('真实点击本地链接加载改写后的完整预览地址', async ({ click, js, win }) => {
    await click('', 'a');
    await loaded();
    assert.equal(await js('document.querySelector("a").href'), final);
    assert.equal(win.getChildWindows().length, 1);
  });
  await check('脚本外链与点击地址相同时才外开', async ({ click, js }) => {
    const external = 'https://docs.example.org/guide';
    const log = mock.method(console, 'log');
    try {
      await js('document.querySelector("a").href = ' + JSON.stringify(external));
      await click('event.preventDefault(); window.open("https://docs.example.org/other")', 'a');
      await click('event.preventDefault(); window.open(' + JSON.stringify(external) + ')', 'a');
      const opened = log.mock.calls.filter(call => call.arguments[1] === '记录外链');
      assert.deepEqual(opened.map(call => call.arguments[2]), [external]);
    } finally { log.mock.restore(); }
  });
  await check('个人授权弹窗回退且登录页新标签链接留在主窗口', async ({ click, wc, js, none }) => {
    await click(`if (!window.open('/_wp/feishu/connect?return=settings&display=popup', 'wp-feishu-personal')) location.assign('${connect}')`);
    await until(() => wc.getURL() === provider + '/authorize', '个人授权没有回到主窗口');
    assert.ok(visits.includes(gateway + connect));
    await js(`document.body.innerHTML = '<a href="/login" target="_blank">Continue</a>'`);
    await click('', 'a');
    await until(() => wc.getURL() === provider + '/login', '登录域的链接没有在主窗口继续');
    await none();
  });
  assert.deepEqual(failures, []);
}

if (process.argv.includes('--test-preview-links')) {
  run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else {
  await import('./main/index.js');
}
