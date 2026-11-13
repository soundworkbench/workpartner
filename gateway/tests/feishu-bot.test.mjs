import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Script } from 'node:vm';
import { createFeishuBot } from '../feishu-bot.mjs';
import { createDockerRuntime } from '../runtime/docker.mjs';

const API = '/_wp/feishu-bot', ORIGIN = 'https://workspace.example.test';
const tang = { slug: 'tang', unionId: 'union-tang', backend: 'aionui' };
async function fixture(t) {
  const organization = { server: { publicOrigin: ORIGIN }, runtime: { uid: 1001 }, features: { feishuBot: true } };
  let config = { features: { feishuBot: true }, feishuBot: { allow: ['tang'] } };
  const calls = [];
  let execute = async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, bots: [] }) });
  const handler = createFeishuBot({ organization, organizationData: () => { if (config instanceof Error) throw config; return config; },
    authenticate: req => req.headers.cookie === 'tang' ? tang : req.headers.cookie === 'other' ? { slug: 'other', unionId: 'union-other', backend: 'aionui' }
      : req.headers.cookie === 'other-backend' ? { ...tang, backend: 'claude' }
      : req.headers.cookie === 'no-backend' ? { ...tang, backend: undefined } : null,
    runtime: { exec: (...args) => { calls.push(args); return execute(...args); } } });
  const request = async (route = '/bots', { who = 'tang', method = 'GET', headers = {}, body } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method; req.headers = { cookie: who, ...headers };
    let status, responseHeaders, raw;
    const handled = await handler(req, {
      writeHead: (code, values) => { status = code; responseHeaders = values; },
      end: value => { raw = value || ''; },
    }, new URL(API + route, ORIGIN));
    assert.equal(handled, true);
    assert.equal(responseHeaders['cache-control'], 'no-store');
    assert.equal(responseHeaders['x-content-type-options'], 'nosniff');
    return { status, data: raw ? JSON.parse(raw) : null, raw };
  };
  return { handler, calls, request, config: value => { config = value; }, execute: fn => { execute = fn; },
    reply: value => { execute = async () => ({ exitCode: 0, stdout: JSON.stringify(value) }); } };
}
const post = { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' };

test('non-aionui users receive neither API access nor client even on the allowlist', async t => {
  const f = await fixture(t);
  for (const allow of [['tang'], ['union-tang'], ['*']]) {
    f.config({ features: { feishuBot: true }, feishuBot: { allow } });
    for (const who of ['other-backend', 'no-backend']) {
      assert.equal((await f.request('/bots', { who })).status, 404);
      assert.equal((await f.request('/reconnect', { ...post, who })).status, 404);
    }
    for (const backend of ['claude', undefined]) assert.equal(f.handler.clientFor({ ...tang, backend }), '');
  }
  assert.equal(f.calls.length, 0);
});

test('valid stdout with noisy stderr succeeds for info and reconnect without exposing output', async t => {
  const f = await fixture(t);
  const stdout = '{"ok":true,"bots":[]}', stderr = 'diagnostic: token app_secret private\n';
  f.execute(async () => ({ exitCode: 0, stdout, stderr, logs: stderr + stdout }));
  assert.deepEqual(await f.request(), { status: 200, data: { bots: [] }, raw: '{"bots":[]}' });
  assert.deepEqual(await f.request('/reconnect', post), { status: 200, data: { ok: true }, raw: '{"ok":true}' });
});

test('runtime output limit failures are opaque 503 on both endpoints', async t => {
  const f = await fixture(t);
  const stdout = Buffer.from(JSON.stringify({ ok: true, bots: [], padding: 'x'.repeat(1024 * 1024) }));
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(stdout.length, 4);
  const runtime = createDockerRuntime({ docker: async (_method, route) => route.endsWith('/start')
    ? { status: 200, body: Buffer.concat([header, stdout]) }
    : route.endsWith('/json') ? { status: 200, body: '{"ExitCode":0}' }
    : { status: 201, body: '{"Id":"output-limit-test"}' } });
  f.execute(runtime.exec);
  for (const [route, options] of [['/bots', {}], ['/reconnect', post]]) {
    assert.deepEqual(await f.request(route, options), { status: 503, data: { error: 'unavailable' }, raw: '{"error":"unavailable"}' });
  }
  for (const call of f.calls) assert.equal(call[2].maxOutputBytes, 1024 * 1024);
});

test('live feature and slug, unionId, wildcard admission govern HTTP and client', async t => {
  const f = await fixture(t);
  for (const allow of [['tang'], ['union-tang'], ['*']]) {
    f.config({ features: { feishuBot: true }, feishuBot: { allow } });
    assert.equal((await f.request()).status, 200);
    const script = f.handler.clientFor(tang); assert.ok(script.includes('我的飞书机器人')); new Script(script);
  }
  for (const config of [{ features: { feishuBot: false }, feishuBot: { allow: ['*'] } },
    { features: { feishuBot: true }, feishuBot: { allow: ['other'] } },
    { features: { feishuBot: true }, feishuBot: { allow: ['*', 2] } }, {}, new Error('unreadable')]) {
    f.config(config);
    const before = f.calls.length;
    assert.equal((await f.request()).status, 404);
    assert.equal((await f.request('/reconnect', post)).status, 404);
    assert.equal(f.handler.clientFor(tang), ''); assert.equal(f.calls.length, before);
  }
  f.config({ features: { feishuBot: true }, feishuBot: { allow: ['tang', 'union-tang'] } });
  for (const who of ['other', '']) assert.equal((await f.request('/bots', { who })).status, 404);
  for (const user of [null, { ...tang, slug: '../tang' }, { ...tang, slug: 'tang\n' }, { ...tang, unionId: undefined }, { slug: 'other', unionId: 'union-other' }]) assert.equal(f.handler.clientFor(user), '');
});

test('info uses fixed argv and returns only validated public fields', async t => {
  const f = await fixture(t);
  const bot = { project: 'private', appId: 'cli_Ab123', name: '名'.repeat(70), avatar: 'data:image/png;base64,YQ==', online: 'online',
    activate: true, lastEvent: 'private', lastEventAt: '2026-11-13T00:00:00Z', error: null, app_secret: 'private', token: 'private' };
  f.reply({ ok: true, bots: [bot, ...['javascript:bad', 'cli_a?token=bad', 'cli_a-b', 'cli_tail\n', '', null].map(appId => ({ ...bot, appId })), null] });
  assert.deepEqual((await f.request('/bots?refresh=1')).data, { bots: [{ appId: 'cli_Ab123', name: '名'.repeat(64), avatar: bot.avatar,
    online: 'online', activate: true, lastEventAt: bot.lastEventAt, error: null, openUrl: 'https://applink.feishu.cn/client/bot/open?appId=cli_Ab123' }] });
  assert.deepEqual(f.calls[0], ['tang', ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'info', '--refresh'], { user: '1001', timeout: 10000, maxOutputBytes: 1024 * 1024 }]);
  for (const kind of ['png', 'jpeg', 'gif', 'webp']) {
    f.reply({ ok: true, bots: [{ ...bot, avatar: `data:image/${kind};base64,YQ==` }] });
    assert.equal((await f.request()).data.bots[0].avatar, `data:image/${kind};base64,YQ==`);
  }
  for (const avatar of ['https://private/avatar', 'data:image/svg+xml;base64,YQ==', 'javascript:alert(1)', {}, null]) {
    f.reply({ ok: true, bots: [{ ...bot, avatar, name: null, online: 'bad', activate: {}, lastEventAt: { token: 'private' }, error: 'private' }] });
    assert.deepEqual((await f.request()).data.bots[0], { appId: bot.appId, name: null, avatar: null, online: 'unknown', activate: null,
      lastEventAt: null, error: null, openUrl: 'https://applink.feishu.cn/client/bot/open?appId=cli_Ab123' });
  }
  for (const error of ['feishu_unreachable', 'feishu_auth_failed']) {
    f.reply({ ok: true, bots: [{ ...bot, error, online: 'offline', activate: false }] });
    const result = (await f.request()).data.bots[0];
    assert.equal(result.error, error); assert.equal(result.online, 'offline'); assert.equal(result.activate, false);
  }
  assert.deepEqual(f.calls.at(-1)[1], ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'info']);
});

test('exec failures, timeouts, invalid JSON and failed worker replies are opaque 503', async t => {
  const f = await fixture(t);
  for (const execute of [async () => { throw new Error('app_secret private stdout'); }, async () => { throw Object.assign(new Error('token timeout'), { code: 'ETIMEDOUT' }); },
    async () => ({ exitCode: 1, stdout: 'private app_secret' }), async () => ({ exitCode: 0, stdout: 'private token' }),
    async () => ({ exitCode: 0, stdout: '{"ok":false,"error":"private"}' }), async () => ({ exitCode: 0, stdout: '{"ok":true}' })]) {
    f.execute(execute);
    assert.deepEqual(await f.request(), { status: 503, data: { error: 'unavailable' }, raw: '{"error":"unavailable"}' });
  }
  f.reply({ ok: true, bots: [] }); assert.deepEqual((await f.request()).data, { bots: [] });
});

test('reconnect validates origin, JSON content type and body before executing', async t => {
  const f = await fixture(t); f.reply({ ok: true });
  for (const headers of [{}, { origin: 'https://evil.test', 'content-type': 'application/json' }, { origin: ORIGIN, 'content-type': 'text/plain' }]) {
    assert.equal((await f.request('/reconnect', { ...post, headers })).status, 403);
  }
  for (const body of ['', '{', 'null', '[]', '"value"', '{"x":"' + 'x'.repeat(1024) + '"}']) {
    assert.equal((await f.request('/reconnect', { ...post, body })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.request('/reconnect', post)).data, { ok: true });
  assert.deepEqual(f.calls[0], ['tang', ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'restart'], { user: '1001', timeout: 20000, maxOutputBytes: 1024 * 1024 }]);
  f.execute(async () => { throw new Error('private'); });
  assert.deepEqual((await f.request('/reconnect', post)).data, { error: 'unavailable' });
  assert.equal((await f.request('/reconnect', post)).status, 503);
  f.reply({ ok: false, error: 'private' }); assert.equal((await f.request('/reconnect', post)).status, 503);
  assert.equal((await f.request('/reconnect')).status, 405);
  assert.equal((await f.request('/bots', post)).status, 405);
});

test('concurrent info including refresh shares one exec, clears after failure and isolates users', async t => {
  const f = await fixture(t);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.execute(async () => { started(); await new Promise(resolve => { release = resolve; }); return { exitCode: 0, stdout: '{"ok":true,"bots":[]}' }; });
  const first = f.request('/bots?refresh=1'); await ready;
  const second = f.request();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.calls.length, 1); release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.data), [{ bots: [] }, { bots: [] }]);
  f.config({ features: { feishuBot: true }, feishuBot: { allow: ['*'] } });
  f.reply({ ok: true, bots: [] });
  await Promise.all([f.request(), f.request('/bots', { who: 'other' })]);
  assert.deepEqual(f.calls.slice(1).map(call => call[0]).sort(), ['other', 'tang']);
});

for (const succeeds of [true, false]) test(`concurrent reconnect shares restart, isolates users and permits retry (${succeeds})`, async t => {
  const f = await fixture(t);
  f.config({ features: { feishuBot: true }, feishuBot: { allow: ['*'] } });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.execute(async () => {
    await blocked;
    if (!succeeds) throw new Error('private restart failure');
    return { exitCode: 0, stdout: '{"ok":true}' };
  });
  const requests = [f.request('/reconnect', post), f.request('/reconnect', post), f.request('/reconnect', { ...post, who: 'other' })];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(call => [call[0], call[1].at(-1)]).sort(), [['other', 'restart'], ['tang', 'restart']]);
  // An info request must not share the pending restart result.
  f.reply({ ok: true, bots: [] });
  assert.deepEqual((await f.request()).data, { bots: [] });
  release();
  assert.deepEqual((await Promise.all(requests)).map(r => [r.status, r.data]),
    Array.from({ length: 3 }, () => succeeds ? [200, { ok: true }] : [503, { error: 'unavailable' }]));
  f.reply({ ok: true });
  assert.equal((await f.request('/reconnect', post)).status, 200);
  assert.equal(f.calls.length, 4);
});
