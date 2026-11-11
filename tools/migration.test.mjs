import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { PassThrough, Duplex } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { proxyHttp, proxyUpgrade } from '../preview/transport.mjs';
import { createMigration, previewSessionUser } from '../gateway/migration.mjs';
import { createAionui } from '../gateway/aionui.mjs';
import { createFeishu } from '../gateway/feishu.mjs';
import { createGatewayServices } from '../gateway/services.mjs';
import { resolveOrganization } from '../gateway/organization/resolve.mjs';

const user = { slug: 'user1', unionId: 'union-1', backend: 'aionui' };
const other = { slug: 'user2', unionId: 'union-2', backend: 'aionui' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'owners.json');
  const write = (users = {}, owner = 'docker') => {
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, default: owner, users }));
    fs.renameSync(file + '.tmp', file);
  };
  const logs = [];
  const migration = createMigration({ runtime: { kind: 'k8s', migration: { ownersFile: file } } }, line => logs.push(line));
  return { dir, file, write, migration, logs };
}

test('ownership follows defaults, overrides, legacy precedence, replacement and last valid cache', t => {
  const f = fixture(t);
  assert.equal(f.migration.owns(user), false);
  f.write({ user1: 'k8s' });
  assert.equal(f.migration.owner(user), 'k8s');
  assert.equal(f.migration.owns(other), false);
  assert.equal(f.migration.owner({ ...user, backend: 'legacy' }), 'docker');
  f.write({}, 'k8s');
  assert.equal(f.migration.owns(other), true);
  f.write();
  assert.equal(f.migration.owns(user), false);
  fs.unlinkSync(f.file);
  assert.equal(f.migration.owns(user), false);
  for (const kind of [undefined, 'docker', 'k8s']) {
    const m = createMigration({ runtime: { kind } });
    for (const backend of ['aionui', 'legacy', undefined]) assert.equal(m.owns({ ...user, backend }), true);
  }
});

test('unreadable or malformed ownership fails closed without a cache and retains a valid cache', t => {
  const f = fixture(t);
  const values = [null, '{broken', ...[
    { version: 2, default: 'docker', users: {} }, { version: 1, default: 'docker', users: [] },
    { version: 1, default: 'k8s', users: { user1: 'unknown' } },
  ].map(JSON.stringify)];
  for (const value of values) {
    if (value !== null) fs.writeFileSync(f.file, value);
    assert.equal(f.migration.owns(user), false);
    assert.equal(f.migration.owner(user), null);
    assert.equal(f.migration.owns({ ...user, backend: 'legacy' }), false);
    const runtime = f.migration.guardRuntime({ start() { assert.fail('unexpected start'); }, create() { assert.fail('unexpected create'); } }, () => [user]);
    for (const [method, arg] of [['start', user.slug], ['create', user]]) {
      assert.throws(() => runtime[method](arg), { code: 'WORKSPACE_NOT_OWNED', status: 503 });
    }
    for (const person of [user, null]) {
      let status;
      assert.equal(f.migration.forward({ headers: {} }, { writeHead(code) { status = code; }, end() {} }, person), true);
      assert.equal(status, 503);
    }
  }
  assert.ok(f.logs.some(line => line.includes('requests and runtime writes disabled')));
  f.write({}, 'k8s'); assert.equal(f.migration.owns(user), true);
  fs.writeFileSync(f.file, '{broken'); assert.equal(f.migration.owns(user), true);
  fs.unlinkSync(f.file); assert.equal(f.migration.owns(user), true);
  fs.mkdirSync(f.file); assert.equal(f.migration.owns(user), true);
  assert.ok(f.logs.some(line => line.includes('using last valid ownership')));
  const fresh = createMigration({ runtime: { migration: { ownersFile: f.file, peerOrigin: 'http://peer.test' } } }, () => {});
  assert.equal(fresh.owns(user), false);
  fs.rmdirSync(f.file); f.write(); assert.equal(f.migration.owns(user), false);
});

test('runtime writes recheck ownership and default mode preserves calls and return values', async t => {
  const f = fixture(t); f.write();
  const calls = [];
  const methods = ['ensureIsolation', 'create', 'start', 'stop', 'restart', 'remove', 'exec', 'processes', 'runOnce', 'putFiles', 'removeFiles'];
  const runtime = Object.fromEntries([...methods, 'execNamed'].map(name => [name, (...args) => { calls.push([name, ...args]); return 'ok'; }]));
  const guarded = f.migration.guardRuntime(runtime, () => [user]);
  for (const method of methods) assert.throws(() => guarded[method](method === 'create' ? user : user.slug), { code: 'WORKSPACE_NOT_OWNED' });
  assert.throws(() => f.migration.guardRuntime(runtime, () => [], user).execNamed('model', []), { code: 'WORKSPACE_NOT_OWNED' });
  assert.deepEqual(calls, []);
  f.write({ user1: 'k8s' });
  assert.equal(guarded.start(user.slug), 'ok');
  f.write();
  assert.throws(() => guarded.start(user.slug), { code: 'WORKSPACE_NOT_OWNED' });
  const defaultRuntime = createMigration({ runtime: {} }).guardRuntime(runtime, () => { throw new Error('must not read users.json'); });
  for (const method of methods) assert.equal(defaultRuntime[method](method === 'create' ? user : user.slug), 'ok');
  assert.equal(calls.length, methods.length + 1);
});

test('foreign requests show a migration page and delegated requests cannot loop, including upgrades', t => {
  const f = fixture(t); f.write();
  for (const delegated of [false, true]) {
    const req = { headers: delegated ? { 'x-workpartner-delegated': '1' } : {} };
    let status, body;
    assert.equal(f.migration.forward(req, { writeHead(code) { status = code; }, end(value) { body = value; } }, user), true);
    assert.equal(status, delegated ? 502 : 503); assert.match(body, /工作区迁移中/);
    f.migration.forward(req, { end(value) { body = value; } }, user, Buffer.alloc(0));
    assert.match(body, new RegExp(`^HTTP/1.1 ${status}`));
  }
});

test('preview ownership requires a valid, unexpired, domain-separated session and current roster', () => {
  const key = 'fixture-key', host = 'preview.example.test', now = () => 100000;
  const value = { u: user.unionId, h: host, p: 8080, e: 200, until: 300 };
  const req = (v, purpose = 'session') => {
    const data = Buffer.from(JSON.stringify(v)).toString('base64url');
    const mac = crypto.createHmac('sha256', key).update(`${purpose}:${data}`).digest('hex');
    return { headers: { cookie: `__Host-zp-preview=${data}.${mac}` } };
  };
  const options = { key, host, now, users: () => [user] };
  assert.deepEqual(previewSessionUser(req(value), options), user);
  for (const change of [{ e: 100 }, { until: 100 }, { h: 'other.example.test' }, { u: 'missing' }, { p: 22 }]) {
    assert.equal(previewSessionUser(req({ ...value, ...change }), options), null);
  }
  assert.equal(previewSessionUser(req(value, 'grant'), options), null);
  assert.equal(previewSessionUser({ headers: { cookie: '__Host-zp-preview=forged' } }, options), null);
});

test('keep-running starts only owned, existing, unpaused zero-replica workspaces and shares jobs', async t => {
  const f = fixture(t); f.write({ user1: 'k8s', paused: 'k8s', absent: 'k8s', pending: 'k8s', failed: 'k8s', unknown: 'k8s', omitted: 'k8s' });
  const roster = [user, other, ...['paused', 'absent', 'pending', 'failed', 'unknown', 'omitted'].map(slug => ({ ...user, slug })), { ...user, slug: 'legacy', backend: 'legacy' }];
  const calls = [], logs = [];
  let release;
  const runtime = {
    async inspect(slug) {
      calls.push(['inspect', slug]);
      return { exists: slug !== 'absent', replicas: slug === 'unknown' ? null : slug === 'omitted' ? undefined : slug === 'pending' ? 1 : 0, running: false, annotations: slug === 'paused' ? { 'workpartner/paused': '' } : {} };
    },
    async start(slug) { calls.push(['start', slug]); if (slug === 'failed') throw new Error('private detail'); await new Promise(resolve => { release = resolve; }); },
  };
  const aionui = createAionui({ runtime, owns: f.migration.owns, kind: 'k8s', log: value => logs.push(value) });
  const work = aionui.keepRunning(() => roster);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(aionui.pending(user.slug));
  assert.equal(await aionui.upstream(user), null);
  assert.equal(aionui.keepRunning(() => roster), work);
  release(); await work;
  assert.deepEqual(calls.filter(([name]) => name === 'start'), [['start', 'user1'], ['start', 'failed']]);
  assert.ok(!calls.some(([, slug]) => slug === 'user2' || slug === 'legacy'));
  assert.equal(aionui.pending(user.slug), undefined);
  assert.match(logs[0], /Workspace kept running: user1/);
  assert.ok(logs.every(line => !line.includes('private detail')));
  assert.equal(await aionui.upstream(other), null);
});

test('keep-running rechecks ownership after inspect and respects startup, interval, disabled and Docker modes', async t => {
  const f = fixture(t); f.write({ user1: 'k8s' });
  let inspected = 0, starts = 0;
  const runtime = { async inspect() { inspected++; f.write(); return { exists: true, replicas: 0, annotations: {} }; }, async start() { starts++; } };
  const aionui = createAionui({ runtime, owns: f.migration.owns, kind: 'k8s', log() {} });
  t.after(() => aionui.close());
  aionui.startKeepRunning(() => [user], 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(inspected, 0);
  aionui.startKeepRunning(() => [user], 10);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(inspected, 1); assert.equal(starts, 0);
  f.write({ user1: 'k8s' });
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(inspected, 2);
  const docker = createAionui({ runtime });
  await docker.keepRunning(() => [user]); docker.startKeepRunning(() => [user], 10);
  assert.equal(inspected, 2);
});

test('preparation skips foreign users at startup and after a live ownership change', async t => {
  const f = fixture(t); f.write();
  const organization = structuredClone(resolveOrganization({ PUBLIC_HOST: 'workspace.example.test', MODEL_BASE_URL: 'http://models.example.test/v1' }));
  organization.features.feishuAuthorization = false;
  organization.features.preview = true;
  organization.server.previewHost = 'preview.example.test';
  const calls = [];
  const runtime = { async readFile() { throw Object.assign(new Error(), { code: 'ENOENT' }); }, async putFiles(...args) { calls.push(args); } };
  const services = await createGatewayServices({ organization, runtime, migration: f.migration, SESSION_KEY: 'fixture-key', users: () => [user], userFor: () => ({}), aionui: {} });
  t.after(() => services.close());
  assert.deepEqual(calls, []);
  f.write({ user1: 'k8s' }); await services.prepareNextFeishu(user);
  assert.deepEqual(calls.map(([, files]) => files[0].path), ['.zp-market-token', '.zp-preview-relay-key']);
  f.write(); await services.prepareNextFeishu(user); assert.equal(calls.length, 2);
});

test('Feishu maintenance and token refresh only operate on owned users, including revocations', async t => {
  const f = fixture(t); f.write({ user1: 'k8s' });
  const record = { version: 1, state: 'connected', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 0, refreshExpiresAt: null };
  const file = id => path.join(f.dir, crypto.createHash('sha256').update(id).digest('hex') + '.json');
  for (const person of [user, other]) fs.writeFileSync(file(person.unionId), JSON.stringify({ ...record, userId: person.unionId }));
  const calls = [];
  const feishu = createFeishu({ stateDir: f.dir, appId: 'fixture', secret: () => 'fixture', publicOrigin: 'https://example.test', enabled: () => true,
    authenticate: req => req.user, sessionUser: req => req.user, readUsers: () => [user, other], owns: f.migration.owns,
    fetcher: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ access_token: 'updated', refresh_token: 'updated', expires_in: 7200 }) }; } });
  await feishu.maintain(); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file(user.unionId))).accessToken, 'updated');
  assert.equal(JSON.parse(fs.readFileSync(file(other.unionId))).accessToken, 'fixture-access');
  let status;
  await feishu.token({ method: 'POST', user: other }, { writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 403); assert.equal(calls.length, 1);
  fs.writeFileSync(file(other.unionId), JSON.stringify({ ...record, state: 'revoking', userId: other.unionId }));
  await feishu.maintain(); assert.equal(calls.length, 1);
  f.write({ user2: 'k8s' });
  fs.writeFileSync(file(other.unionId), JSON.stringify({ ...record, userId: other.unionId }));
  await feishu.maintain(); assert.equal(calls.length, 2);
});


test('delegation streams HTTP bodies and preserves request and response headers', async t => {
  const f = fixture(t); f.write();
  const migration = createMigration({ runtime: { kind: 'k8s', migration: { ownersFile: f.file, peerOrigin: 'http://peer.example.test:8080' } } });
  let options, sent = '';
  t.mock.method(http, 'request', (value, callback) => {
    options = value;
    const outbound = new PassThrough();
    outbound.on('data', chunk => { sent += chunk; });
    outbound.on('finish', () => {
      const reply = new PassThrough(); reply.statusCode = 202;
      reply.headers = { 'set-cookie': ['one=1', 'two=2'], 'content-type': 'text/event-stream' };
      callback(reply); reply.end('data: fixture\n\n');
    });
    return outbound;
  });
  const req = new PassThrough();
  Object.assign(req, { url: '/resource?x=1', method: 'POST', headers: { host: 'workspace.example.test', cookie: 'fixture=1', authorization: 'Bearer fixture', origin: 'https://workspace.example.test', 'x-custom': 'value' } });
  const res = new PassThrough(); let status, responseHeaders, body = '';
  res.writeHead = (code, headers) => { status = code; responseHeaders = headers; };
  res.on('data', chunk => { body += chunk; });
  const done = once(res, 'end');
  assert.equal(migration.forward(req, res, user), true);
  req.write('first'); req.end('second'); await done;
  assert.deepEqual(options, { hostname: 'peer.example.test', port: '8080', path: '/resource?x=1', method: 'POST', headers: { ...req.headers, 'x-workpartner-delegated': '1' } });
  assert.equal(sent, 'firstsecond'); assert.equal(status, 202);
  assert.deepEqual(responseHeaders['set-cookie'], ['one=1', 'two=2']);
  assert.equal(body, 'data: fixture\n\n');
});

test('delegation forwards WebSocket headers, buffered heads and both socket directions', async t => {
  const f = fixture(t); f.write();
  const migration = createMigration({ runtime: { kind: 'k8s', migration: { ownersFile: f.file, peerOrigin: 'http://peer.example.test' } } });
  const socket = () => {
    const chunks = [];
    const stream = new Duplex({ read() {}, write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    return { stream, chunks };
  };
  const local = socket(), remote = socket();
  t.after(() => { local.stream.destroy(); remote.stream.destroy(); });
  let options;
  t.mock.method(http, 'request', value => {
    options = value;
    const outbound = new EventEmitter(); outbound.destroy = () => {};
    outbound.end = () => queueMicrotask(() => outbound.emit('upgrade', { statusCode: 101, statusMessage: 'Switching Protocols', headers: { upgrade: 'websocket', connection: 'Upgrade' } }, remote.stream, Buffer.from('remote head')));
    return outbound;
  });
  const req = { url: '/socket', method: 'GET', headers: { host: 'workspace.example.test', cookie: 'fixture=1', upgrade: 'websocket', connection: 'Upgrade', 'x-custom': 'value' } };
  migration.forward(req, local.stream, user, Buffer.from('local head'));
  await new Promise(resolve => setImmediate(resolve));
  local.stream.push('client data'); remote.stream.push('server data');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(options.headers, { ...req.headers, 'x-workpartner-delegated': '1' });
  assert.deepEqual(remote.chunks, ['local head', 'client data']);
  assert.match(local.chunks[0], /^HTTP\/1.1 101 Switching Protocols/);
  assert.deepEqual(local.chunks.slice(1), ['remote head', 'server data']);
  local.stream.destroy(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(remote.stream.destroyed, true);
});

test('keep-running skips an active foreground preparation job', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'aionui-user1.pass'), 'fixture-password');
  let release, inspections = 0;
  const runtime = {
    async inspect() { inspections++; return { exists: false, replicas: null, annotations: {}, running: inspections > 1 }; },
    ensureIsolation: () => new Promise(resolve => { release = resolve; }),
    async create() {}, async address() { return null; },
  };
  const aionui = createAionui({ runtime, kind: 'k8s', secretDir: f.dir, log() {} });
  assert.equal(await aionui.upstream(user), null);
  const job = aionui.pending(user.slug); assert.ok(job);
  await aionui.keepRunning(() => [user]);
  assert.equal(inspections, 1);
  release(); await job;
  assert.equal(aionui.pending(user.slug), undefined);
});

test('revoking records for removed users are retried on either gateway; connected records stay untouched', async t => {
  const f = fixture(t); f.write();
  const stateDir = path.join(f.dir, 'feishu'); fs.mkdirSync(stateDir);
  const filename = path.join(stateDir, crypto.createHash('sha256').update(user.unionId).digest('hex') + '.json');
  const record = { version: 1, userId: user.unionId, state: 'revoking', accessToken: '', refreshToken: 'fixture-refresh', expiresAt: 0, refreshExpiresAt: null };
  for (const kind of ['docker', 'k8s']) {
    let revokes = 0;
    const migration = createMigration({ runtime: { kind, migration: { ownersFile: f.file } } });
    const service = createFeishu({ stateDir, owns: migration.owns, readUsers: () => [], enabled: () => true,
      appId: 'fixture', secret: () => 'fixture', publicOrigin: 'https://workspace.test',
      fetcher: async () => { revokes++; return { ok: true, text: async () => '{}' }; } });
    fs.writeFileSync(filename, JSON.stringify(record));
    await service.maintain(); assert.equal(revokes, 1); assert.equal(fs.existsSync(filename), false);
    fs.writeFileSync(filename, JSON.stringify({ ...record, state: 'connected' }));
    await service.maintain(); assert.equal(revokes, 1); assert.equal(fs.existsSync(filename), true);
  }
});

test('without ownersFile runtime guards and Feishu ownsId do not read the roster', async t => {
  const f = fixture(t);
  for (const config of [undefined, { peerOrigin: 'http://peer.test' }]) {
    const migration = createMigration({ runtime: { migration: config } });
    const unreadable = () => { throw new Error('users.json unavailable'); };
    const runtime = { start: slug => slug };
    assert.equal(migration.guardRuntime(runtime, unreadable).start(user.slug), user.slug);
    const service = createFeishu({ stateDir: f.dir, readUsers: unreadable, owns: migration.owns });
    assert.deepEqual(await service.disconnect(user.unionId), { connected: false });
  }
});

test('HTTP transport retains preview timeout and errors while delegation allows delayed headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.write();
  const migration = createMigration({ runtime: { kind: 'k8s', migration: { ownersFile: f.file, peerOrigin: 'http://peer.test' } } });
  let outbound, respond;
  t.mock.method(http, 'request', (options, callback) => {
    respond = callback; outbound = new PassThrough(); outbound.resume(); return outbound;
  });
  const run = (delegate, options) => {
    const req = new PassThrough(); Object.assign(req, { url: '/', method: 'GET', headers: {} });
    const res = new PassThrough(); let body = '', status;
    res.writeHead = code => { status = code; res.headersSent = true; };
    res.on('data', chunk => { body += chunk; });
    if (delegate) migration.forward(req, res, user);
    else proxyHttp(req, res, {}, {}, undefined, undefined, options);
    req.end();
    return { req, res, result: () => ({ body, status }) };
  };
  const preview = run(false);
  t.mock.timers.tick(9999); assert.equal(outbound.destroyed, false);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(preview.result(), { status: 502, body: '预览服务暂时不可用，请确认服务已经启动。' });
  const custom = run(false, { responseTimeoutMs: 25, errorMessage: 'custom unavailable' });
  t.mock.timers.tick(25); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(custom.result(), { status: 502, body: 'custom unavailable' });
  const delayed = run(true);
  t.mock.timers.tick(120000); assert.equal(outbound.destroyed, false);
  const reply = new PassThrough(); reply.statusCode = 200; reply.headers = { 'content-type': 'text/event-stream' };
  respond(reply); reply.write('data: first\n\n');
  t.mock.timers.tick(120000); assert.equal(outbound.destroyed, false);
  const done = once(delayed.res, 'end'); reply.end('data: last\n\n'); await done;
  assert.deepEqual(delayed.result(), { status: 200, body: 'data: first\n\ndata: last\n\n' });
  const failed = run(true);
  outbound.destroy(new Error('fixture failure')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(failed.result(), { status: 502, body: '服务暂时不可用，请稍后重试。' });
});

test('WebSocket transport retains preview timeout while delegation waits and returns a generic 502', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.write();
  const migration = createMigration({ runtime: { kind: 'k8s', migration: { ownersFile: f.file, peerOrigin: 'http://peer.test' } } });
  let outbound;
  t.mock.method(http, 'request', () => {
    outbound = new EventEmitter(); outbound.end = () => {};
    outbound.destroy = error => { outbound.destroyed = true; if (error) outbound.emit('error', error); };
    return outbound;
  });
  const req = { url: '/', method: 'GET', headers: {} };
  const preview = new PassThrough();
  proxyUpgrade(req, preview, Buffer.alloc(0), {}, {});
  t.mock.timers.tick(10000); assert.equal(preview.destroyed, true);
  const socket = new PassThrough(); let body = ''; socket.on('data', chunk => { body += chunk; });
  migration.forward(req, socket, user, Buffer.alloc(0));
  t.mock.timers.tick(120000); assert.notEqual(outbound.destroyed, true);
  const done = once(socket, 'end'); outbound.emit('error', new Error('fixture failure')); await done;
  assert.match(body, /^HTTP\/1.1 502 Bad Gateway/); assert.match(body, /服务暂时不可用/); assert.doesNotMatch(body, /预览/);
});

test('Docker foreground startup preserves inspect compatibility when replicas and annotations are undefined', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'aionui-user1.pass'), 'fixture-password');
  const calls = [];
  const runtime = {
    async inspect() { return { exists: true, running: false, image: 'fixture', imageId: 'fixture-id' }; },
    async imageId() { return 'fixture-id'; },
    async ensureIsolation(slug) { calls.push(['ensureIsolation', slug]); },
    async start(slug) { calls.push(['start', slug]); },
    async address() { return null; },
  };
  const aionui = createAionui({ runtime, image: 'fixture', secretDir: f.dir, log() {} });
  assert.equal(await aionui.upstream(user), null);
  await aionui.pending(user.slug);
  assert.deepEqual(calls, [['ensureIsolation', user.slug], ['start', user.slug]]);
  await aionui.keepRunning(() => [user]);
  assert.equal(calls.length, 2);
});

test('ownership unavailable prevents preparation and keep-running without inspecting or writing runtime', async t => {
  const f = fixture(t);
  const runtime = new Proxy({}, { get() { return () => assert.fail('runtime must not be accessed'); } });
  const aionui = createAionui({ runtime, kind: 'k8s', owns: f.migration.owns });
  assert.equal(await aionui.upstream(user), null);
  await aionui.keepRunning(() => [user]);
  const organization = structuredClone(resolveOrganization({ PUBLIC_HOST: 'workspace.test', MODEL_BASE_URL: 'http://models.test/v1' }));
  organization.features.feishuAuthorization = false;
  organization.features.preview = true; organization.server.previewHost = 'preview.test';
  const services = await createGatewayServices({ organization, runtime, migration: f.migration, SESSION_KEY: 'fixture-key',
    users: () => [user], userFor: () => ({}), aionui });
  t.after(() => services.close());
  await services.prepareNextFeishu(user);
});

test('internal adoption prepare accepts only loopback POST for a currently owned next user and refills cached files', async t => {
  const f = fixture(t); f.write();
  const organization = structuredClone(resolveOrganization({ PUBLIC_HOST: 'workspace.example.test', MODEL_BASE_URL: 'http://models.example.test/v1' }));
  organization.runtime.stateDirectory = f.dir;
  organization.features.feishuAuthorization = true;
  organization.features.preview = true;
  organization.server.previewHost = 'preview.example.test';
  const calls = [];
  let failed = false;
  const runtime = {
    async readFile() { throw Object.assign(new Error(), { code: 'ENOENT' }); },
    async putFiles(slug, files) { if (failed) throw new Error('fixture-private-value'); calls.push({ slug, files }); },
  };
  const services = await createGatewayServices({ organization, runtime, migration: f.migration, SESSION_KEY: 'fixture-key',
    users: () => [user, { ...other, backend: 'legacy' }], userFor: () => ({}), aionui: {} });
  t.after(() => services.close());
  let handle;
  t.mock.method(http, 'createServer', handler => {
    handle = handler;
    return {
      listen(port, host) { assert.equal(port, organization.runtime.internalPort); assert.equal(host, '0.0.0.0'); },
      close(callback) { callback(); },
    };
  });
  services.listen();
  async function request({ method = 'POST', url = '/internal/adopt/prepare/user1', peer = '127.0.0.1' } = {}) {
    let status, body;
    await handle({ method, url, socket: { remoteAddress: peer } }, {
      writeHead(value) { status = value; }, end(value) { body = value; },
    });
    assert.equal(body, undefined, 'no upstream errors or secret values in the response');
    return { status };
  }
  assert.equal((await request()).status, 409);
  f.write({ user1: 'k8s' });
  assert.equal((await request({ peer: '192.0.2.20' })).status, 403);
  assert.equal((await request({ method: 'GET' })).status, 405);
  assert.equal((await request({ url: '/internal/adopt/prepare/../user1' })).status, 400);
  assert.equal((await request({ url: '/internal/adopt/prepare/missing-user' })).status, 404);
  assert.equal((await request({ url: '/internal/adopt/prepare/user2' })).status, 404);
  assert.equal((await request({ url: '/unrelated' })).status, 404);
  assert.equal(calls.length, 0);
  f.migration.kind = 'docker';
  assert.equal((await request()).status, 409);
  f.migration.kind = 'k8s';
  assert.equal((await request()).status, 204);
  assert.deepEqual(calls.flatMap(call => call.files.map(file => file.path)).sort(), ['.wp-feishu-cli.json', '.zp-market-token', '.zp-preview-relay-key']);
  // A repeated takeover must restore the token/config even inside the normal one-day cache window.
  assert.equal((await request({ peer: '::ffff:127.0.0.1' })).status, 204);
  assert.equal(calls.length, 4);
  failed = true;
  assert.equal((await request()).status, 503);
  failed = false;
  f.write();
  assert.equal((await request()).status, 409); assert.equal(calls.length, 4);
});
