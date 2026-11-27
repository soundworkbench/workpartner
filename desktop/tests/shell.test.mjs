import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { deepTarget, linkKind, logTarget, navigationPolicy } from '../dist/main/links.js';

const origin = 'https://desk.example.org';
const preview = 'preview.example.org';
const { loginOrigins } = JSON.parse(readFileSync(new URL('../brand/default/brand.json', import.meta.url)));
test('工作区、登录、预览和外部导航使用不同的窗口策略', () => {
  for (const host of ['accounts', 'passport', 'open']) assert.equal(linkKind('https://' + host + '.feishu.cn', origin, preview, loginOrigins), 'main');
  // 飞书登录页会先顶层跳到字节统一账号做静默登录检查，再跳回飞书。
  assert.equal(linkKind('https://accounts.doubao.com/flow-account/oauth/authorize/', origin, preview, loginOrigins), 'main');
  assert.equal(linkKind('https://www.feishu.cn/suite/passport/authentication/idpx/doubao/callback', origin, preview, loginOrigins), 'main');
  assert.equal(linkKind('https://security.feishu.cn/link/safety', origin, preview, loginOrigins), 'main');
  assert.equal(linkKind(origin + '/_wp/login', origin, preview, loginOrigins), 'main');
  assert.equal(linkKind('https://' + preview + '/view', origin, preview, loginOrigins), 'preview');
  for (const url of ['https://docs.example.org', 'http://' + preview, 'https://' + preview + '.example.org']) {
    assert.equal(linkKind(url, origin, preview, loginOrigins), 'external');
  }
  for (const url of ['file:///tmp/file', 'javascript:void(0)', 'feishu://open', 'https://name@desk.example.org', 'invalid']) {
    assert.equal(linkKind(url, origin, preview, loginOrigins), 'blocked');
  }
});
test('深链只接受本站路径', () => {
  const target = path => deepTarget('workpartner://open?path=' + encodeURIComponent(path), 'workpartner', origin);
  assert.equal(target('/chat?a=1#last'), origin + '/chat?a=1#last');
  for (const path of ['//elsewhere.org', '/\\elsewhere.org', 'https://elsewhere.org', 'noslash', '/\n/test']) {
    assert.equal(target(path), undefined);
  }
  assert.equal(deepTarget('other://open?path=/', 'workpartner', origin), undefined);
});

function shell() {
  let time = 100;
  const opened = [];
  const route = navigationPolicy(origin, preview, loginOrigins, url => opened.push(url), () => time);
  return { opened, route, advance: ms => { time += ms; } };
}
test('重定向到飞书及 Lark 登录域保留在主窗口', () => {
  const { route, opened } = shell();
  for (const domain of ['feishu.cn', 'larksuite.com']) {
    for (const host of ['accounts', 'open', 'passport', 'login']) {
      assert.equal(route('https://' + host + '.' + domain + '/accounts/trap', 'redirect'), 'main');
    }
  }
  assert.deepEqual(opened, []);
});
test('第三方点击只外开一次，所有窗口共享五秒限速', () => {
  const { route, opened, advance } = shell();
  const url = 'https://docs.example.org/guide';
  route(url, 'popup', false);
  route(url, 'click', false);
  assert.deepEqual(opened, []);
  route(url, 'click', true);
  route(url, 'popup', true);
  advance(4999);
  route(url + '/other', 'click', true);
  assert.deepEqual(opened, [url]);
  advance(1);
  route(url, 'popup', true);
  assert.deepEqual(opened, [url, url]);
});
test('连续重定向和程序导航都不能外开', () => {
  const { route, opened } = shell();
  for (const source of ['redirect', 'navigation']) {
    for (const path of ['/auth', '/_wp/callback']) assert.equal(route(origin + path, source), 'main');
    for (const site of ['one', 'two', 'three']) assert.equal(route('https://' + site + '.example.org', source, true), 'blocked');
  }
  assert.deepEqual(opened, []);
});
test('自定义协议在点击、新窗口和重定向中均被拦截', () => {
  const { route, opened } = shell();
  for (const url of ['lark://open', 'feishu://open', 'file:///tmp/file', 'mailto:user@example.org']) {
    for (const source of ['click', 'popup', 'redirect']) assert.equal(route(url, source, true), 'blocked');
  }
  assert.deepEqual(opened, []);
});

test('无手势的三次预览弹窗全部拒绝', () => {
  const { route } = shell();
  const decisions = Array.from({ length: 3 }, () => route('https://' + preview + '/view', 'popup', false));
  assert.deepEqual(decisions, Array(3).fill('blocked'));
});
test('点击凭证只允许原链接，一次有效，一秒过期', async () => {
  const { linkGesture } = await import('../dist/main/links.js');
  const { opened, route } = shell();
  let now = 100;
  const click = linkGesture(() => now);
  const a = 'https://docs.example.org/a', b = 'https://docs.example.org/b';
  click.record(a);
  route(b, 'popup', click.consume(b));
  assert.deepEqual(opened, []);
  click.record(a);
  assert.equal(click.consume(a), true);
  assert.equal(click.consume(a), false);
  click.record(a);
  now += 1000;
  assert.equal(click.consume(a), false);
});

test('发布构建不会从运行环境启用测试模式', async () => {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { testMode } from './dist/main/test-mode.js'; process.exitCode = Number(testMode)"],
    { cwd: new URL('../', import.meta.url), env: { ...process.env, WP_DESKTOP_TEST: '1' } });
  assert.equal(child.status, 0);
});

test('导航日志不记录凭据、查询串和片段', () => {
  assert.equal(logTarget('https://user:secret@evil.example.org/p?code=abc#frag'), 'https://evil.example.org/p');
  assert.equal(logTarget('https://security.feishu.cn/link/safety?target=https%3A%2F%2Fa:b@x.example.org%2Fq%3Fcode%3D1'),
    'https://security.feishu.cn/link/safety → https://x.example.org');
  assert.equal(logTarget('javascript:alert(document.cookie)'), 'javascript:');
  assert.equal(logTarget('not a url'), '(无法解析的地址)');
});
