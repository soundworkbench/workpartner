/** What a person sees while their workspace is created, restarted or replaced for an update. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNavigation, notReady, updatingText } from '../gateway/starting.mjs';
import { createAionui } from '../gateway/aionui.mjs';

const request = (headers = {}, method = 'GET', url = '/') => ({ method, url, headers });

test('page loads are told apart from requests made by the page', () => {
  assert.equal(isNavigation(request({ 'sec-fetch-mode': 'navigate', accept: 'text/html' })), true);
  assert.equal(isNavigation(request({ 'sec-fetch-mode': 'cors', accept: 'application/json' }, 'GET', '/api/conversations')), false);
  assert.equal(isNavigation(request({ 'sec-fetch-mode': 'no-cors', accept: '*/*' }, 'GET', '/assets/index.js')), false);
  assert.equal(isNavigation(request({ accept: 'text/html,application/xhtml+xml' })), true, 'browsers without fetch metadata');
  assert.equal(isNavigation(request({ accept: '*/*' })), false);
  assert.equal(isNavigation(request({ 'sec-fetch-mode': 'navigate' }, 'POST')), false);
});

test('the update notice follows the preferred browser language', () => {
  assert.deepEqual(updatingText(request({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }))[0], '正在更新，约 1 分钟');
  assert.deepEqual(updatingText(request({ 'accept-language': 'en-US,en;q=0.9' }))[0], 'Updating, about 1 minute');
  assert.deepEqual(updatingText(request({ 'accept-language': 'fr-FR' }))[0], '正在更新，约 1 分钟');
  assert.deepEqual(updatingText(request())[0], '正在更新，约 1 分钟');
});

test('requests made by the page receive a retryable 503 instead of the notice page', () => {
  let status, headers, body;
  notReady({ writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; } });
  assert.equal(status, 503);
  assert.equal(headers['retry-after'], '3');
  assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(body), { error: 'workspace_starting' });
});

function fixture(t, info) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-starting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'aionui-person.pass'), 'fixture');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const logs = [];
  const runtime = {
    inspect: async () => info,
    imageId: async () => 'new-id',
    ensureIsolation: async () => {},
    stop: async () => {}, remove: async () => {}, create: async () => {},
    start: async () => { await gate; },
    address: async () => null,
  };
  const aionui = createAionui({ runtime, kind: 'k8s', image: 'workspace:new', secretDir: dir, log: line => logs.push(line) });
  return { aionui, release, logs };
}

test('replacing an existing workspace is reported as an update until the job ends, with phase timings', async t => {
  const { aionui, release, logs } = fixture(t, { exists: true, running: false, image: 'workspace:old', imageId: 'old-id', address: null, env: [] });
  assert.equal(await aionui.upstream({ slug: 'person' }), null);
  assert.equal(aionui.updating('person'), true);
  release();
  await aionui.pending('person');
  assert.equal(aionui.updating('person'), false);
  const line = logs.find(entry => entry.includes('准备失败'));
  assert.match(line, /删除 \d+\.\ds、创建 \d+\.\ds、启动容器 \d+\.\ds/);
});

test('a first-time workspace is preparing, not updating', async t => {
  const { aionui, release } = fixture(t, { exists: false, running: false, image: null, imageId: null, address: null, env: [] });
  assert.equal(await aionui.upstream({ slug: 'person' }), null);
  assert.equal(aionui.updating('person'), false);
  release();
  await aionui.pending('person');
});
