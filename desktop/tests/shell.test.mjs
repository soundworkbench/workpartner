import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepTarget, linkKind } from '../dist/main/links.js';

const origin = 'https://desk.example.org';
const preview = 'preview.example.org';
test('工作区、登录、预览和外部导航使用不同的窗口策略', () => {
  for (const host of ['accounts', 'passport', 'open']) assert.equal(linkKind('https://' + host + '.feishu.cn', origin, preview), 'main');
  assert.equal(linkKind(origin + '/_wp/login', origin, preview), 'main');
  assert.equal(linkKind('https://' + preview + '/view', origin, preview), 'preview');
  for (const url of ['https://docs.example.org', 'http://' + preview, 'https://' + preview + '.example.org']) {
    assert.equal(linkKind(url, origin, preview), 'external');
  }
  for (const url of ['file:///tmp/file', 'javascript:void(0)', 'feishu://open', 'https://name@desk.example.org', 'invalid']) {
    assert.equal(linkKind(url, origin, preview), 'blocked');
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
