import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { deepTarget, linkKind, navigationPolicy } from '../dist/main/links.js';

const origin = 'https://desk.example.org';
const preview = 'preview.example.org';
const { loginOrigins } = JSON.parse(readFileSync(new URL('../brand/default/brand.json', import.meta.url)));
test('工作区、登录、预览和外部导航使用不同的窗口策略', () => {
  for (const host of ['accounts', 'passport', 'open']) assert.equal(linkKind('https://' + host + '.feishu.cn', origin, preview, loginOrigins), 'main');
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
