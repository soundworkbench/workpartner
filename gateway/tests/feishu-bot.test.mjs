import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { organizationData } from '../organization/resolve.mjs';
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
const empty = { bots: [], agents: [], subAgents: { enabled: false, limit: 5, count: 0 } };
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
  assert.deepEqual(await f.request(), { status: 200, data: empty, raw: JSON.stringify(empty) });
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
  assert.deepEqual((await f.request('/bots?refresh=1')).data, { ...empty, bots: [{ agentId: 'main', appId: 'cli_Ab123', name: '名'.repeat(64), avatar: bot.avatar,
    online: 'online', activate: true, lastEventAt: bot.lastEventAt, error: null, openUrl: 'https://applink.feishu.cn/client/bot/open?appId=cli_Ab123' }] });
  assert.deepEqual(f.calls[0], ['tang', ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'info', '--refresh'], { user: '1001', timeout: 10000, maxOutputBytes: 1024 * 1024 }]);
  for (const kind of ['png', 'jpeg', 'gif', 'webp']) {
    f.reply({ ok: true, bots: [{ ...bot, avatar: `data:image/${kind};base64,YQ==` }] });
    assert.equal((await f.request()).data.bots[0].avatar, `data:image/${kind};base64,YQ==`);
  }
  for (const avatar of ['https://private/avatar', 'data:image/svg+xml;base64,YQ==', 'javascript:alert(1)', {}, null]) {
    f.reply({ ok: true, bots: [{ ...bot, avatar, name: null, online: 'bad', activate: {}, lastEventAt: { token: 'private' }, error: 'private' }] });
    assert.deepEqual((await f.request()).data.bots[0], { agentId: 'main', appId: bot.appId, name: null, avatar: null, online: 'unknown', activate: null,
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
  f.reply({ ok: true, bots: [] }); assert.deepEqual((await f.request()).data, empty);
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
  assert.deepEqual((await Promise.all([first, second])).map(r => r.data), [empty, empty]);
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
  assert.deepEqual((await f.request()).data, empty);
  release();
  assert.deepEqual((await Promise.all(requests)).map(r => [r.status, r.data]),
    Array.from({ length: 3 }, () => succeeds ? [200, { ok: true }] : [503, { error: 'unavailable' }]));
  f.reply({ ok: true });
  assert.equal((await f.request('/reconnect', post)).status, 200);
  assert.equal(f.calls.length, 4);
});

const mainAgent = { id: 'main', name: '主助手', kind: 'main', setup: 'connected', appId: 'cli_Main', createdAt: null };
const sub = (i, extra = {}) => ({ id: 's' + i.toString(16).padStart(8, '0'), name: '助手' + i, kind: 'sub', setup: 'none', appId: null,
  createdAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`, ...extra });
const admittedConfig = (allow = ['tang']) => ({ features: { feishuBot: true }, feishuBot: { allow: ['tang'], subAgents: { allow } } });
const result = (data, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(data), stderr: 'app_secret private token' });
const named = name => ({ ...post, body: JSON.stringify({ name }) });
async function subFixture(t, initial = []) {
  const f = await fixture(t); f.config(admittedConfig());
  let agents = [mainAgent, ...initial];
  f.execute(async (_slug, cmd, options) => {
    const action = cmd[2];
    if (action === 'info') return result({ ok: true, agents, bots: [{ appId: 'cli_Main', agentId: 'main' }], limit: 5 });
    if (action === 'create') {
      const agent = sub(agents.length, { name: JSON.parse(options.stdin).name }); agents.push(agent);
      return result({ ok: true, agent });
    }
    if (action === 'start') return {};
    if (action === 'status') return result({ status: 'waiting', qr: 'data:image/png;base64,YQ==' });
    if (action === 'rename') {
      const agent = agents.find(a => a.id === cmd[3]);
      agent.name = JSON.parse(options.stdin).name; return result({ ok: true, agent });
    }
    if (action === 'delete') agents = agents.filter(a => a.id !== cmd[3]);
    return result({ ok: true });
  });
  return f;
}

test('sub-agent policy is live, needs both lists, accepts slug/unionId/* and denies malformed lists', async t => {
  const f = await subFixture(t, [sub(1)]);
  for (const allow of [['tang'], ['union-tang'], ['*']]) {
    f.config(admittedConfig(allow));
    assert.deepEqual((await f.request()).data.subAgents, { enabled: true, count: 1, limit: 5 });
    assert.equal((await f.request('/agents/s00000001/setup')).status, 200);
  }
  for (const allow of [[], ['other'], '*', ['*', 1], null, {}]) {
    f.config(admittedConfig(allow));
    const response = (await f.request()).data;
    assert.deepEqual(response.agents, [{ id: 'main', name: '主助手', kind: 'main', setup: 'connected', appId: 'cli_Main' }]);
    assert.deepEqual(response.subAgents, { enabled: false, count: 0, limit: 5 });
    for (const [route, options] of [['/agents', named('助理')], ['/agents/s00000001/setup', {}],
      ...['rename', 'delete', 'restart', 'setup'].map(action => ['/agents/s00000001/' + action, post])]) {
      const before = f.calls.length; assert.equal((await f.request(route, options)).status, 404); assert.equal(f.calls.length, before);
    }
    assert.equal((await f.request('/agents/main/restart', post)).status, 200);
  }
  for (const config of [{ ...admittedConfig(), features: { feishuBot: false } },
    { ...admittedConfig(), feishuBot: { allow: [], subAgents: { allow: ['*'] } } }]) {
    f.config(config); assert.equal((await f.request('/agents', named('助理'))).status, 404);
  }
});

test('agent and bot public fields are filtered, ordered and isolated from removed users', async t => {
  const f = await subFixture(t);
  f.reply({ ok: true, limit: 9, bots: [ { appId: 'cli_Main' }, { appId: 'cli_Sub', agentId: 's00000001', token: 'private' },
    ...['bad', 's1234567g', 's12345678\n', null].map(agentId => ({ appId: 'cli_Bad', agentId })) ],
    agents: [sub(2, { name: '字'.repeat(20), setup: 'bad', appId: 'javascript:bad', token: 'private' }), mainAgent, sub(1),
      sub(3, { id: 'bad' }), sub(4, { kind: 'bad' }), sub(5, { id: 's12345678\n' }), sub(6, { kind: 'main' })] });
  const data = (await f.request()).data;
  assert.deepEqual(data.agents, [{ id: 'main', name: '主助手', kind: 'main', setup: 'connected', appId: 'cli_Main' },
    { id: 's00000001', name: '助手1', kind: 'sub', setup: 'none', appId: null },
    { id: 's00000002', name: '字'.repeat(16), kind: 'sub', setup: 'failed', appId: null }]);
  assert.deepEqual(data.bots.map(b => b.agentId), ['main', 's00000001']);
  assert.equal(data.subAgents.limit, 5); assert.doesNotMatch(JSON.stringify(data), /private|token|createdAt/);
  f.config(admittedConfig([])); assert.deepEqual((await f.request()).data.bots.map(b => b.agentId), ['main']);
});

test('name validation happens before exec; create sends normalized stdin and detached start without stdin', async t => {
  const f = await subFixture(t);
  for (const name of ['字'.repeat(17), '主助手', 'main', 'Main', 'a  b', 'a\nb', '🤖', '', null, 2, 'é', 'a/b']) {
    const before = f.calls.length;
    assert.deepEqual((await f.request('/agents', named(name))).data, { error: 'invalid_name' });
    assert.equal((await f.request('/agents', named(name))).status, 400);
    assert.equal(f.calls.length, before);
  }
  const response = await f.request('/agents', named('  中文 Agent_1-·  '));
  assert.equal(response.status, 201);
  assert.deepEqual(response.data, { agent: { id: 's00000001', name: '中文 Agent_1-·', kind: 'sub', setup: 'preparing' } });
  assert.deepEqual(f.calls.map(c => c[1]), [ ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'info'],
    ['python3', '/opt/workpartner/bin/wp-agent', 'create'], ['python3', '/opt/workpartner/bin/feishu-onboard.py', 'start', '--agent', 's00000001'] ]);
  assert.deepEqual(f.calls[1][2], { user: '1001', timeout: 20000, maxOutputBytes: 1048576, stdin: '{"name":"中文 Agent_1-·"}' });
  assert.deepEqual(f.calls[2][2], { user: '1001', timeout: 10000, maxOutputBytes: 1048576, detached: true });
});

test('create enforces container limit capped at five, including unconnected agents, and old images fail closed', async t => {
  const f = await subFixture(t);
  for (const limit of [5, 99, 2]) {
    f.reply({ ok: true, bots: [], agents: [mainAgent, ...Array.from({ length: Math.min(5, limit) }, (_, i) => sub(i + 1))], limit });
    const before = f.calls.length;
    assert.equal((await f.request('/agents', named('助理'))).status, 409);
    assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1)[1][2], 'info');
  }
  f.reply({ ok: true, bots: [] });
  assert.deepEqual((await f.request()).data, empty);
  assert.equal((await f.request('/agents', named('助理'))).status, 503);
  f.execute(async (_slug, cmd) => cmd[2] === 'info' ? result({ ok: true, bots: [], agents: [] }) : { exitCode: 127, stdout: 'wp-agent missing app_secret' });
  assert.deepEqual((await f.request('/agents', named('助理'))).data, { error: 'unavailable' });
});

test('simultaneous creates serialize and second info observes the newly created fifth agent', async t => {
  const f = await subFixture(t, [1, 2, 3, 4].map(i => sub(i)));
  const responses = await Promise.all([f.request('/agents', named('甲')), f.request('/agents', named('乙'))]);
  assert.deepEqual(responses.map(r => r.status), [201, 409]);
  assert.deepEqual(responses[1].data, { error: 'limit_reached' });
  assert.deepEqual(f.calls.map(c => c[1][2]), ['info', 'create', 'start', 'info']);
});

test('all mutations check origin, JSON object size, exact id and main restrictions before exec', async t => {
  const f = await subFixture(t);
  for (const route of ['/agents', ...['setup', 'rename', 'delete', 'restart'].map(a => '/agents/s00000001/' + a)]) {
    for (const headers of [{}, { origin: 'https://evil.test', 'content-type': 'application/json' }, { origin: ORIGIN, 'content-type': 'text/plain' }]) {
      assert.equal((await f.request(route, { ...post, headers })).status, 403);
    }
    for (const body of ['null', '[]', '{', '"text"', '{"name":"' + '中'.repeat(400) + '"}']) {
      assert.equal((await f.request(route, { ...post, body })).status, 400);
    }
  }
  for (const id of ['bad', 's1234567g', 's123456789', 's12345678%0a']) for (const action of ['setup', 'rename', 'delete', 'restart']) {
    assert.equal((await f.request('/agents/' + id + '/' + action, post)).status, 404);
  }
  for (const action of ['setup', 'rename', 'delete']) {
    assert.deepEqual((await f.request('/agents/main/' + action, post)).data, { error: 'main_agent' });
    assert.equal((await f.request('/agents/main/' + action, post)).status, 400);
  }
  assert.equal((await f.request('/agents/main/setup')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('setup whitelists status/QR/expiry and starts only none, expired or failed', async t => {
  const f = await subFixture(t);
  for (const state of ['unconnected', 'none', 'preparing', 'waiting', 'needs_identity', 'expired', 'failed', 'connected']) {
    f.execute(async (_slug, cmd) => cmd[2] === 'start' ? {} : result({ status: state,
      expiresAt: '2026-11-13T00:00:00Z', qr: 'data:image/png;base64,YQ==', token: 'private' }));
    const expected = { status: state === 'unconnected' ? 'none' : state, expiresAt: '2026-11-13T00:00:00Z',
      ...(state === 'waiting' ? { qr: 'data:image/png;base64,YQ==' } : {}) };
    assert.deepEqual((await f.request('/agents/s00000001/setup')).data, expected);
    const before = f.calls.length, starts = ['unconnected', 'none', 'expired', 'failed'].includes(state);
    assert.deepEqual((await f.request('/agents/s00000001/setup', post)).data, starts ? { status: 'preparing' } : expected);
    assert.equal(f.calls.length, before + (starts ? 2 : 1));
    assert.deepEqual(f.calls[before][1], ['python3', '/opt/workpartner/bin/feishu-onboard.py', 'status', '--agent', 's00000001']);
  }
  for (const qr of ['https://private', 'data:image/svg+xml;base64,YQ==', 'data:image/png;base64,YQ==\n', {}]) {
    f.reply({ status: 'waiting', qr, expiresAt: { token: 'private' } });
    assert.deepEqual((await f.request('/agents/s00000001/setup')).data, { status: 'waiting' });
  }
  f.reply({ status: 'unknown', token: 'private' }); assert.equal((await f.request('/agents/s00000001/setup')).status, 503);
});

test('rename/delete/restart use exact commands and invalidate info after writes', async t => {
  const f = await subFixture(t, [sub(1)]);
  assert.equal((await f.request('/agents/s00000001/rename', named('新名字'))).data.agent.name, '新名字');
  assert.equal((await f.request()).data.agents[1].name, '新名字');
  for (const route of ['/agents/s00000001/restart', '/agents/main/restart', '/reconnect', '/agents/s00000001/delete']) {
    assert.deepEqual((await f.request(route, post)).data, { ok: true });
  }
  assert.equal((await f.request()).data.agents.length, 1);
  assert.deepEqual(f.calls.filter(c => c[1][2] !== 'info').map(c => c[1]), [
    ['python3', '/opt/workpartner/bin/wp-agent', 'rename', 's00000001'],
    ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'restart', '--agent', 's00000001'],
    ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'restart'], ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'restart'],
    ['python3', '/opt/workpartner/bin/wp-agent', 'delete', 's00000001'] ]);
  assert.equal(f.calls[0][2].stdin, '{"name":"新名字"}');
  assert.ok(f.calls.slice(1).every(c => !('stdin' in c[2])));
});

test('container errors on exit 1 map to fixed responses; failures remain opaque on every endpoint', async t => {
  const f = await subFixture(t);
  const routes = ['/agents', '/agents/s00000001/setup', '/agents/s00000001/rename', '/agents/s00000001/delete', '/agents/s00000001/restart'];
  for (const [error, status] of Object.entries({ invalid_name: 400, name_taken: 409, limit_reached: 409, not_found: 404, main_agent: 400, no_supervisor: 503, secret: 503 })) {
    f.execute(async (_slug, cmd) => cmd[2] === 'info' ? result({ ok: true, bots: [], agents: [] }) : result({ ok: false, error, token: 'private' }, 1));
    for (const route of routes) {
      const response = await f.request(route, named('名字'));
      assert.equal(response.status, status); assert.deepEqual(response.data, { error: status === 503 ? 'unavailable' : error });
    }
  }
  for (const failure of [() => { throw new Error('timeout token'); }, () => ({ exitCode: 0, stdout: 'app_secret' }),
    () => ({ exitCode: 1, stdout: '{"ok":true}' }), () => ({ exitCode: 127, stdout: '{"ok":false,"error":"not_found"}' })]) {
    f.execute(async (_slug, cmd) => cmd[2] === 'info' ? result({ ok: true, bots: [], agents: [] }) : failure());
    for (const route of routes) assert.deepEqual((await f.request(route, named('名字'))).data, { error: 'unavailable' });
    assert.deepEqual((await f.request('/agents/s00000001/setup')).data, { error: 'unavailable' });
  }
  f.execute(async (_slug, cmd) => cmd[2] === 'info' ? result({ ok: true, bots: [], agents: [] })
    : cmd[2] === 'create' ? result({ ok: true, agent: sub(1) }) : { exitCode: 1 });
  assert.equal((await f.request('/agents', named('名字'))).status, 503);
});


test('organization deep merge preserves disabled sub-agent defaults under a first-step override', async t => {
  const defaults = organizationData({});
  assert.equal(defaults.features.feishuBot, false);
  assert.deepEqual(defaults.feishuBot, { allow: [], subAgents: { allow: [] } });
  const directory = mkdtempSync(join(tmpdir(), 'feishu-subagents-org-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'organization.json'), JSON.stringify({ features: { feishuBot: true }, feishuBot: { allow: ['tang'] } }));
  const config = organizationData({ WORKPARTNER_ORG_DIR: directory });
  assert.deepEqual(config.feishuBot, { allow: ['tang'], subAgents: { allow: [] } });
  const f = await subFixture(t, [sub(1)]); f.config(config);
  assert.equal((await f.request()).data.subAgents.enabled, false);
  assert.equal((await f.request('/agents', named('新助手'))).status, 404);
});

test('setup permits numeric expiry but never arbitrary objects or extra stdout fields', async t => {
  const f = await subFixture(t);
  f.reply({ status: 'waiting', expiresAt: 1800000000, qr: 'data:image/png;base64,YQ==', app_secret: 'private' });
  assert.deepEqual((await f.request('/agents/s00000001/setup')).data,
    { status: 'waiting', expiresAt: 1800000000, qr: 'data:image/png;base64,YQ==' });
});

test('failed writes release the per-user queue; rename and delete never overlap', async t => {
  const f = await subFixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.execute(async (_slug, cmd) => {
    if (cmd[2] === 'rename') { await blocked; return result({ ok: false, error: 'name_taken' }, 1); }
    return result({ ok: true });
  });
  const rename = f.request('/agents/s00000001/rename', named('新名字'));
  const deletion = f.request('/agents/s00000001/delete', post);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(c => c[1][2]), ['rename']);
  release(); assert.deepEqual((await Promise.all([rename, deletion])).map(r => r.status), [409, 200]);
  assert.deepEqual(f.calls.map(c => c[1][2]), ['rename', 'delete']);
});


test('worker error codes must be literal allowlisted strings', async t => {
  const f = await subFixture(t);
  for (const error of [['not_found'], { code: 'invalid_name' }, 'not_found\n', 'app_secret']) {
    f.execute(async () => result({ ok: false, error }, 1));
    const response = await f.request('/agents/s00000001/delete', post);
    assert.equal(response.status, 503); assert.deepEqual(response.data, { error: 'unavailable' });
  }
});
