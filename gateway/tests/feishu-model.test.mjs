/** Messaging-app model list: per-person resolution, key filtering, the sidebar page and switching through the bridge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { organizationData, nextModelConfig, nextEnvironment, feishuCatalog } from '../organization/resolve.mjs';
import { createFeishuModel, keyAllows } from '../feishu-model.mjs';
import { PROFILE } from '../my-key.mjs';

const ORIGIN = 'https://workspace.example.test', API = '/_wp/api/model';
const feishu = [
  { name: 'Large', key: 'vendor/large' },
  { name: 'Other', key: 'other/model' },
  { name: 'Trial', key: 'trial/deep/model', only: ['tang'] },
];

function organization(t, model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-feishu-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = value => fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({ model: value }));
  write(model);
  return { write, data: () => organizationData({ WORKPARTNER_ORG_DIR: dir }) };
}

test('each person receives the entries open to them, and the image keeps the injected list as is', t => {
  const org = organization(t, { catalog: { feishu } });
  const open = [{ name: 'Large', key: 'vendor/large' }, { name: 'Other', key: 'other/model' }];
  assert.deepEqual(nextModelConfig(org.data(), {}, 'other').catalog.feishu, open);
  const tang = nextModelConfig(org.data(), {}, 'tang');
  assert.deepEqual(tang.catalog.feishu, [...open, { name: 'Trial', key: 'trial/deep/model' }]);
  // The web picker is unchanged by the messaging list.
  assert.deepEqual(tang.catalog.claude, nextModelConfig(organization(t, {}).data(), {}, 'tang').catalog.claude);
  const injected = nextEnvironment(org.data(), { MODEL_BASE_URL: 'https://models.example.test/v1', WORKPARTNER_MODEL_CONFIG: JSON.stringify(tang) });
  assert.equal(injected.WORKPARTNER_MODEL_CONFIG, JSON.stringify(tang));
  // A person with no open entry receives no list.
  assert.equal(nextModelConfig(organization(t, { catalog: { feishu: [feishu[2]] } }).data(), {}, 'other').catalog.feishu, undefined);
  assert.equal(nextModelConfig(organization(t, {}).data(), {}, 'tang').catalog.feishu, undefined);
});

test('model.catalog.feishu is validated', t => {
  for (const value of [[], {}, 'x', [{ name: 'A' }], [{ key: 'a' }], [{ name: 'A', key: 'a\nb' }], [{ name: 'A', key: 'a', only: [] }],
    [{ name: 'A', key: 'a', only: 'tang' }], [{ name: 'A', key: 'a', only: [''] }], [null]]) {
    assert.throws(() => organization(t, { catalog: { feishu: value } }).data(), /model\.catalog\.feishu/, JSON.stringify(value));
  }
  assert.equal(feishuCatalog(undefined), undefined);
});

test('key ids match exactly or by a trailing wildcard', () => {
  assert.equal(keyAllows(['vendor/large'], 'vendor/large'), true);
  assert.equal(keyAllows(['vendor/*'], 'vendor/large'), true);
  assert.equal(keyAllows(['trial/*'], 'trial/deep/model'), true);
  assert.equal(keyAllows(['vendor/large-2'], 'vendor/large'), false);
  assert.equal(keyAllows(['vendor/'], 'vendor/large'), false);
  assert.equal(keyAllows([], 'vendor/large'), false);
  // Multi-instance and bare listings answer to the catalog's provider-qualified names.
  assert.equal(keyAllows(['mp-q/vendor/large'], 'vendor/large'), true);
  assert.equal(keyAllows(['mp-q/claude/claude-x-1'], 'claude/claude-x-1'), true);
  assert.equal(keyAllows(['gpt-x-1'], 'codex/gpt-x-1'), true);
  assert.equal(keyAllows(['mp-q/vendor/large'], 'other/large'), false);
});

async function fixture(t) {
  const state = { models: [{ id: 'other/*' }, { id: 'trial/deep/model' }], current: 'other/model', profile: true, calls: [] };
  const upstream = http.createServer((req, res) => {
    state.authorization = req.headers.authorization;
    if (req.url !== '/v1' + PROFILE || !state.profile) { res.writeHead(500); return res.end('{}'); }
    res.end(JSON.stringify({ name: 'private-caller-name', models: state.models }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const org = organization(t, { catalog: { feishu } });
  const people = { tang: { slug: 'tang', unionId: 'union-tang' }, other: { slug: 'other', unionId: 'union-other' } };
  const handler = createFeishuModel({
    organization: { server: { publicOrigin: ORIGIN }, runtime: { uid: 1001 }, model: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` } },
    organizationData: org.data, authenticate: req => people[req.headers.cookie] || null,
    keyFor: user => `key-${user.slug}\n`,
    runtime: { exec: async (slug, command, options) => {
      state.calls.push({ slug, command, options });
      if (command[2] === 'get') return { exitCode: 0, stdout: JSON.stringify({ ok: true, model: state.current }) };
      state.current = command[3];
      return { exitCode: 0, stdout: '{"ok":true}' };
    } },
  });
  const request = async (route, { who = 'tang', method = 'GET', headers = {}, body } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method; req.headers = { cookie: who, ...headers };
    let status, responseHeaders, raw;
    assert.equal(await handler(req, { writeHead: (code, values) => { status = code; responseHeaders = values; }, end: value => { raw = value || ''; } },
      new URL(route, ORIGIN)), true);
    assert.equal(responseHeaders['cache-control'], 'no-store');
    return { status, headers: responseHeaders, raw, data: responseHeaders['content-type']?.startsWith('application/json') && raw ? JSON.parse(raw) : null };
  };
  return { state, org, request };
}

const post = model => ({ method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ model }) });

test('the list keeps entries open to the person and allowed by their key, with the current model', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request(API)).data, { models: [{ name: 'Other', key: 'other/model' }, { name: 'Trial', key: 'trial/deep/model' }], current: 'other/model' });
  assert.equal(f.state.authorization, 'Bearer key-tang');
  assert.deepEqual(f.state.calls[0], { slug: 'tang', command: ['python3', '/opt/workpartner/bin/wp-bridge-model.py', 'get'], options: { user: '1001', timeout: 10000, maxOutputBytes: 65536 } });
  assert.deepEqual((await f.request(API, { who: 'other' })).data.models, [{ name: 'Other', key: 'other/model' }]);
  // Editing the organization file takes effect on the next request.
  f.org.write({ catalog: { feishu: [feishu[1]] } });
  assert.deepEqual((await f.request(API)).data.models, [{ name: 'Other', key: 'other/model' }]);
  f.org.write({});
  assert.equal((await f.request(API)).status, 404);
  assert.equal((await f.request('/_wp/model')).status, 404);
  f.state.profile = false; f.org.write({ catalog: { feishu } });
  assert.equal((await f.request(API)).status, 503);
});

test('switching accepts only a visible model from the same origin and goes through the bridge', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(API, { ...post('vendor/large') })).status, 400);
  assert.equal((await f.request(API, { ...post('trial/deep/model'), who: 'other' })).status, 400);
  assert.equal((await f.request(API, { ...post('trial/deep/model'), headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' } })).status, 403);
  assert.equal((await f.request(API, { ...post('trial/deep/model'), who: 'nobody' })).status, 401);
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual((await f.request(API, post('trial/deep/model'))).data, { current: 'trial/deep/model' });
  assert.deepEqual(f.state.calls.at(-1).command, ['python3', '/opt/workpartner/bin/wp-bridge-model.py', 'set', 'trial/deep/model']);
  assert.equal((await f.request(API)).data.current, 'trial/deep/model');
});

test('the page asks for login first and is served to listed people', async t => {
  const f = await fixture(t);
  const anonymous = await f.request('/_wp/model', { who: 'nobody' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, '/_wp/login?next=%2F_wp%2Fmodel');
  const page = await f.request('/_wp/model');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.raw, /<h1>模型<\/h1>/);
  assert.match(page.raw, /width=device-width/);
  assert.equal(await createFeishuModel({ organization: { server: { publicOrigin: ORIGIN }, model: {} },
    organizationData: () => ({}), authenticate: () => null })({}, {}, new URL('/_wp/other', ORIGIN)), false);
});
