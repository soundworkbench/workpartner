import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { Duplex, Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { createDesktopAuth } from '../desktop-auth.mjs';
import { createDesktopRelay, rejectUpgrade } from '../desktop-relay.mjs';
import { createGatewayServices } from '../services.mjs';
import { createMigration } from '../migration.mjs';
import { issueToken } from '../market-auth.mjs';
import { organizationData } from '../organization/resolve.mjs';

const key = 'relay-test-signing-key';
const person = { unionId: 'test-union-a', slug: 'person-a', backend: 'aionui' };
const other = { unionId: 'test-union-b', slug: 'person-b', backend: 'aionui' };
function token(user = person, extra = {}) {
  const value = { u: user.unionId, g: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, did: 'Test', ...extra };
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signing = crypto.createHmac('sha256', key).update('wp-desktop-token-v1').digest();
  return `wpd.${data}.${crypto.createHmac('sha256', signing).update(`wpd.${data}`).digest('base64url')}`;
}
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-relay-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function inbox(ws) {
  const queue = [], waiting = [];
  ws.on('message', bytes => { const message = JSON.parse(bytes); const receive = waiting.shift(); if (receive) receive(message); else queue.push(message); });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve));
}
async function connect(url, { id = crypto.randomUUID(), bearer = token(), headers = {}, hello = {}, autoPong = true, skipHello = false, createConnection } = {}) {
  const ws = new WebSocket(url, { autoPong, createConnection, headers: { authorization: `Bearer ${bearer}`, 'x-wp-device-id': id, ...headers } });
  const next = inbox(ws), closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  await once(ws, 'open');
  if (!skipHello) ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, deviceId: id, deviceName: 'Test computer', platform: 'linux', arch: 'x64', appVersion: '0.3.0', capabilities: ['fs.read'], allowedRoots: ['/documents'], ...hello }));
  return { ws, id, next, closed, send: message => ws.send(JSON.stringify(message)), ack: skipHello ? null : await next() };
}
async function rejected(url, headers = {}, createConnection) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { createConnection, headers: { 'x-wp-device-id': crypto.randomUUID(), ...headers } });
    ws.on('unexpected-response', (req, res) => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
    ws.on('error', reject); ws.on('open', () => { ws.terminate(); reject(new Error('Expected rejection')); });
  });
}
// Execute the production listener without starting the gateway's unrelated services.
const upgradeSource = fs.readFileSync(new URL('../gateway.mjs', import.meta.url), 'utf8').match(/server\.on\("upgrade",[\s\S]*?\n\}\);/)[0];
function gatewayUpgrade(desktopRelay, migration, context = {}) {
  let listener;
  runInNewContext(upgradeSource, { URL, desktopRelay, migration, rejectUpgrade, preview: undefined,
    server: { on(event, handler) { assert.equal(event, 'upgrade'); listener = handler; } }, ...context });
  return listener;
}

function memoryGateway(t, kind, owner = kind) {
  const dir = directory(t), ownersFile = path.join(dir, 'owners.json');
  fs.writeFileSync(ownersFile, JSON.stringify({ version: 1, default: owner, users: {} }));
  const migration = createMigration({ runtime: { kind, migration: { ownersFile, peerOrigin: 'http://peer.example.test' } } });
  const forward = t.mock.method(migration, 'forward');
  const auth = createDesktopAuth({ organization: { runtime: { stateDirectory: dir }, server: { publicOrigin: 'http://gateway.example.test' } },
    organizationData: () => ({ desktop: { enabled: true, allow: ['*'] } }), users: () => [person, other], sessionKey: key });
  const relay = createDesktopRelay({ desktopAuth: auth, migration, allowedHost: host => host === 'gateway.example.test', audit() {} });
  const server = http.createServer();
  server.on('upgrade', gatewayUpgrade(relay, migration));
  const sockets = new Set();
  // Real HTTP parsing and ws frames over paired streams; no listening socket is needed.
  function createConnection() {
    const client = new Duplex({ read() {}, write(chunk, encoding, done) { remote.push(chunk); done(); }, final(done) { remote.push(null); done(); } });
    const remote = new Duplex({ read() {}, write(chunk, encoding, done) { client.push(chunk); done(); }, final(done) { client.push(null); done(); } });
    for (const socket of [client, remote]) { sockets.add(socket); socket.on('error', () => {}); }
    client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
    server.emit('connection', remote);
    return client;
  }
  t.after(() => { relay.close(); for (const socket of sockets) socket.destroy(); server.close(); });
  const url = 'ws://gateway.example.test/_wp/desktop/ws';
  return { relay, migration, forward, createConnection, ownersFile,
    connect: options => connect(url, { ...options, createConnection }),
    rejected: headers => rejected(url, headers, createConnection) };
}

async function fixture(t, options = {}) {
  const dir = directory(t), config = { desktop: { enabled: true, allow: ['*'] } }, users = [person, other], audit = [], published = [];
  const organization = { features: {}, model: {}, runtime: { stateDirectory: dir, secureDirectory: dir, internalPort: 0, uid: 1001 }, server: { publicHost: '127.0.0.1', publicOrigin: 'http://127.0.0.1' } };
  let relay;
  const auth = createDesktopAuth({ organization, organizationData: () => config, users: () => users, sessionKey: key, onRevoke: id => relay.revoke(id) });
  relay = createDesktopRelay({ desktopAuth: auth, allowedHost: host => host.startsWith('127.0.0.1:'), migration: options.migration, audit: record => audit.push(record), timing: options.timing, now: options.now });
  const server = http.createServer(async (req, res) => {
    if (await auth(req, res, new URL(req.url, 'http://gateway'))) return;
    res.writeHead(404); res.end();
  });
  server.on('upgrade', gatewayUpgrade(relay, options.migration ?? createMigration({ runtime: {} })));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const services = await createGatewayServices({ organization, organizationData: () => config, desktopRelay: relay,
    runtime: { putFiles: async (...args) => published.push(args) }, SESSION_KEY: key, users: () => users, userFor: () => ({}), aionui: {} });
  const internal = services.listen(); await once(internal, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`, internalUrl = `http://127.0.0.1:${internal.address().port}/desktop-mcp`;
  t.after(async () => { relay.close(); server.closeAllConnections(); internal.closeAllConnections(); await services.close(); await new Promise(resolve => server.close(resolve)); });
  const call = (args = { path: '/documents/a.txt' }, user = person, name = 'desktop_read_file', signal) => relay.call(user, { name, arguments: args }, signal);
  const mcp = (message, bearer = issueToken(key, person), options = {}) => fetch(internalUrl, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: typeof message === 'string' ? message : JSON.stringify(message), ...options });
  return { relay, auth, url, wsUrl: url.replace('http:', 'ws:') + '/_wp/desktop/ws', call, mcp, config, users, dir, audit, published, services, internal };
}
function code(result, expected) { assert.equal(result.isError, true); assert.match(result.content[0].text, new RegExp(`^\\[${expected}\\]`)); }
const data = result => JSON.parse(result.content[0].text);
async function respond(client, result = { content: 'hello' }) { const req = await client.next(); assert.equal(req.type, 'rpc_req'); client.send({ type: 'rpc_res', reqId: req.reqId, ok: true, data: result }); return req; }

test('handshake accepts only valid desktop bearer; validates host, protocol, UUID and query', async t => {
  const f = await fixture(t);
  const client = await connect(f.wsUrl); assert.equal(client.ack.type, 'hello_ack');
  assert.deepEqual([client.ack.heartbeatSec, client.ack.heartbeatTimeoutSec, client.ack.maxConcurrency, client.ack.maxFrameBytes], [25, 60, 4, 1048576]);
  for (const bearer of ['', token(person, { exp: 1 }), token() + 'x', issueToken(key, person), 'wp_sid=fake']) {
    assert.equal((await rejected(f.wsUrl, bearer ? { authorization: `Bearer ${bearer}` } : {})).status, 401);
  }
  assert.equal((await rejected(f.wsUrl, { cookie: 'wp_sid=fake' })).status, 401);
  assert.equal((await rejected(f.wsUrl + '?token=' + token(), { authorization: `Bearer ${token()}` })).status, 401);
  for (const version of ['0', '2', '1.0', '-1', 'abc']) {
    const response = await rejected(f.wsUrl, { 'x-wp-protocol-version': version });
    assert.equal(response.status, 426); assert.equal(response.headers['x-wp-min-protocol-version'], '1'); assert.equal(response.headers['x-wp-max-protocol-version'], '1');
  }
  for (const id of ['invalid', crypto.randomUUID().toUpperCase(), '']) assert.equal((await rejected(f.wsUrl, { 'x-wp-device-id': id })).status, 400);
  assert.equal((await rejected(f.wsUrl, { host: 'untrusted.example.test' })).status, 403);
});

test('hello deadline, unsupported version, malformed and binary frames close 4004', async t => {
  const f = await fixture(t, { timing: { hello: 40 } });
  const silent = await connect(f.wsUrl, { skipHello: true }); assert.deepEqual(await silent.closed, { code: 4004, reason: 'hello_timeout' });
  for (const message of [{ type: 'hello', protocolVersion: 2 }, { type: 'hello', protocolVersion: 1, deviceId: crypto.randomUUID() }, [], 'not-json', Buffer.from('binary')]) {
    const c = await connect(f.wsUrl, { skipHello: true });
    c.ws.send(typeof message === 'string' || Buffer.isBuffer(message) ? message : JSON.stringify(message));
    assert.equal((await c.closed).code, 4004);
  }
  const c = await connect(f.wsUrl); c.send({ type: 'state_update', allowedRoots: Array(33).fill('/documents') }); assert.equal((await c.closed).code, 4004);
});

test('device names reject empty, whitespace-only and 129 characters in hello and state_update', async t => {
  const f = memoryGateway(t, 'docker');
  const devices = async () => data(await f.relay.call(person, { name: 'desktop_list_devices', arguments: {} })).devices;
  for (const deviceName of ['', ' \t\n ', 'x'.repeat(129)]) {
    const c = await f.connect({ skipHello: true });
    c.send({ type: 'hello', protocolVersion: 1, deviceId: c.id, deviceName, platform: 'linux', arch: 'x64',
      appVersion: '0.3.0', capabilities: ['fs.read'], allowedRoots: ['/documents'] });
    assert.deepEqual(await c.closed, { code: 4004, reason: 'invalid_hello' });
    assert.equal((await devices()).length, 0);
    const ready = await f.connect();
    ready.send({ type: 'state_update', deviceName });
    assert.deepEqual(await ready.closed, { code: 4004, reason: 'invalid_hello' });
    assert.equal((await devices()).length, 0);
  }
  for (const deviceName of ['x', 'x'.repeat(128), ' Test computer ']) {
    const c = await f.connect({ hello: { deviceName } });
    assert.equal(c.ack.type, 'hello_ack');
    assert.equal((await devices())[0].device_name, deviceName.trim());
    c.ws.close(); await c.closed;
  }
});

test('desktop with or without feishuAuthorization publishes a container token accepted by internal MCP', async t => {
  t.mock.method(http.Server.prototype, 'listen', function () { return this; });
  for (const feishuAuthorization of [false, true]) {
    await t.test(`feishuAuthorization=${feishuAuthorization}`, async t => {
      const dir = directory(t), f = memoryGateway(t, 'docker');
      const organization = { features: { feishuAuthorization, marketSkills: false }, desktop: { enabled: true },
        runtime: { stateDirectory: dir, internalPort: 0, internalOrigin: 'http://gateway.example.test:3091', uid: 1001 },
        server: { publicOrigin: 'https://gateway.example.test' }, identity: { callbackPath: '/_wp/callback' }, appearance: {} };
      const runtime = { async putFiles(slug, files, options) {
        const volume = path.join(dir, slug);
        fs.mkdirSync(volume, { recursive: true, mode: options.directoryMode });
        for (const file of files) fs.writeFileSync(path.join(volume, file.path), file.content, { mode: file.mode });
      } };
      const services = await createGatewayServices({ organization, runtime, desktopRelay: f.relay,
        SESSION_KEY: key, users: () => [person], userFor: () => ({}), aionui: {} });
      t.after(() => services.close());
      const filename = path.join(dir, person.slug, '.zp-market-token');
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
      const bearer = fs.readFileSync(filename, 'utf8').trim();
      if (feishuAuthorization) {
        const config = JSON.parse(fs.readFileSync(path.join(dir, person.slug, '.wp-feishu-cli.json'), 'utf8'));
        assert.equal(config.identityFile, '/data/.zp-market-token');
      }
      const server = services.listen();
      const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))]);
      Object.assign(req, { method: 'POST', url: '/desktop-mcp', headers: { authorization: `Bearer ${bearer}` } });
      let status, body;
      await server.listeners('request')[0](req, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
      assert.equal(status, 200);
      assert.equal(body.result.serverInfo.name, 'workpartner-desktop');
    });
  }
});

test('same-user RPC, explicit cross-user isolation, offline latency and local list_devices', async t => {
  const f = await fixture(t);
  const start = performance.now(); code(await f.call(), 'DEVICE_OFFLINE'); assert.ok(performance.now() - start < 50);
  assert.deepEqual(data(await f.call({}, person, 'desktop_list_devices')), { count: 0, devices: [] });
  const c = await connect(f.wsUrl);
  const result = f.call(); const req = await respond(c); assert.equal(req.timeoutMs, 15000);
  assert.equal(data(await result).device_id, c.id);
  const list = data(await f.call({}, person, 'desktop_list_devices')); assert.equal(list.count, 1); assert.deepEqual(list.devices[0].allowed_roots, ['/documents']);
  code(await f.call({}, other), 'INVALID_PARAMS');
  code(await f.call({ path: '/documents/a.txt', device_id: c.id }, other), 'DEVICE_NOT_FOUND');
  assert.deepEqual(data(await f.call({}, other, 'desktop_list_devices')), { count: 0, devices: [] });
  code(await f.call({ path: '/documents/a', unionId: person.unionId }, other), 'INVALID_PARAMS');
});

test('memory upgrade: local desktop user bypasses migration.forward, including delegated handshakes', async t => {
  const local = memoryGateway(t, 'docker');
  for (const headers of [{}, { 'x-workpartner-delegated': '1' }]) {
    const client = await local.connect({ headers });
    assert.equal(client.ack.type, 'hello_ack');
  }
  assert.equal(local.forward.mock.callCount(), 0);
  assert.equal(local.relay.registry.get(person.unionId).size, 2);
});

test('memory upgrade: authenticated desktop migration reaches owner once and completes hello/RPC', async t => {
  const source = memoryGateway(t, 'docker', 'k8s'), target = memoryGateway(t, 'k8s');
  const request = http.request, forwarded = [];
  t.mock.method(http, 'request', function (options, ...args) {
    if (options.hostname !== 'peer.example.test') return request.call(this, options, ...args);
    forwarded.push(options);
    return request.call(this, { ...options, createConnection: target.createConnection }, ...args);
  });
  const c = await source.connect();
  assert.equal(c.ack.type, 'hello_ack');
  assert.equal(source.forward.mock.callCount(), 1);
  assert.equal(source.forward.mock.calls[0].arguments[2], person);
  assert.equal(target.forward.mock.callCount(), 0);
  assert.equal(forwarded.length, 1);
  const sent = forwarded[0];
  assert.equal(sent.hostname, 'peer.example.test');
  assert.equal(sent.path, '/_wp/desktop/ws');
  assert.equal(sent.headers['x-workpartner-delegated'], '1');
  assert.equal(sent.headers.authorization, source.forward.mock.calls[0].arguments[0].headers.authorization);
  assert.equal(sent.headers['x-wp-device-id'], c.id);
  assert.equal(source.relay.registry.size, 0);
  assert.equal(target.relay.registry.size, 1);
  const result = target.relay.call(person, { name: 'desktop_read_file', arguments: { path: '/documents/a' } });
  await respond(c); assert.equal(data(await result).content, 'hello');
});

test('memory upgrade: conflicting gateway ownership rejects delegated desktop handshake without looping', async t => {
  const source = memoryGateway(t, 'docker', 'k8s'), target = memoryGateway(t, 'k8s', 'docker');
  const request = http.request, forwarded = [];
  t.mock.method(http, 'request', function (options, ...args) {
    if (options.hostname !== 'peer.example.test') return request.call(this, options, ...args);
    forwarded.push(options);
    return request.call(this, { ...options, createConnection: target.createConnection }, ...args);
  });
  assert.equal((await source.rejected({ authorization: `Bearer ${token()}` })).status, 502);
  assert.equal(forwarded.length, 1);
  assert.equal(source.forward.mock.callCount(), 1);
  assert.equal(target.forward.mock.callCount(), 1);
  assert.equal(target.forward.mock.calls[0].arguments[2], person);
  assert.equal(target.forward.mock.calls[0].arguments[0].headers['x-workpartner-delegated'], '1');
  assert.equal(source.relay.registry.size, 0); assert.equal(target.relay.registry.size, 0);
});

test('memory upgrade: unauthenticated desktop requests reject 401 before migration even when owners are unavailable', async t => {
  const source = memoryGateway(t, 'docker', 'k8s');
  // Remove ownership before the first read to exercise the fail-closed migration state.
  fs.unlinkSync(source.ownersFile);
  const owns = t.mock.method(source.migration, 'owns');
  for (const bearer of ['', token(person, { exp: 1 }), token() + 'x', issueToken(key, person)]) {
    for (const delegated of [false, true]) {
      const headers = { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(delegated ? { 'x-workpartner-delegated': '1' } : {}) };
      assert.equal((await source.rejected(headers)).status, 401);
    }
  }
  assert.equal(owns.mock.callCount(), 0);
  assert.equal(source.forward.mock.callCount(), 0);
});

test('memory upgrade: unavailable ownership rejects authenticated desktop with migration 503', async t => {
  const source = memoryGateway(t, 'docker');
  fs.unlinkSync(source.ownersFile);
  assert.equal((await source.rejected({ authorization: `Bearer ${token()}` })).status, 503);
  assert.equal(source.forward.mock.callCount(), 1);
  assert.equal(source.forward.mock.calls[0].arguments[2], person);
  assert.equal(source.relay.registry.size, 0);
});

test('memory upgrade: non-desktop paths keep migration, preview, identity and legacy ordering', async () => {
  for (const scenario of ['unavailable', 'preview', 'preview-origin', 'legacy']) {
    const calls = [], socket = { destroy() { calls.push('destroy'); } }, head = Buffer.alloc(0);
    const req = { url: '/socket', headers: { host: scenario === 'preview' ? 'preview.example.test' : 'gateway.example.test',
      ...(scenario === 'preview-origin' ? { origin: 'https://preview.example.test' } : {}) } };
    const migration = { forward(r, s, user, h) { assert.equal(r, req); assert.equal(s, socket); assert.equal(h, head); calls.push(user === null ? 'anonymous' : 'user'); return scenario === 'unavailable'; } };
    const upgrade = gatewayUpgrade({ upgrade() { calls.push('desktop'); } }, migration, {
      preview: { isPreviewHost: host => host === 'preview.example.test', upgrade() { calls.push('preview'); } },
      previewSessionUser() { calls.push('preview-session'); return person; }, SESSION_KEY: key, organization: { server: {} }, users: () => [person],
      userFor() { calls.push('session'); return { user: person }; }, legacy: { upgrade() { calls.push('legacy'); return true; } },
    });
    await upgrade(req, socket, head);
    assert.deepEqual(calls, scenario === 'unavailable' ? ['anonymous'] : scenario === 'preview' ? ['anonymous', 'preview-session', 'user', 'preview']
      : scenario === 'preview-origin' ? ['anonymous', 'destroy'] : ['anonymous', 'session', 'user', 'legacy']);
  }
});

test('migration.forward transparently upgrades and relays frames to owning gateway', async t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'owners.json'), JSON.stringify({ version: 1, default: 'k8s', users: {} }));
  const targetMigration = createMigration({ runtime: { kind: 'k8s', migration: { ownersFile: path.join(dir, 'owners.json'), peerOrigin: 'http://peer.example.test' } } });
  const targetForward = t.mock.method(targetMigration, 'forward');
  const target = await fixture(t, { migration: targetMigration });
  const migration = createMigration({ runtime: { kind: 'docker', migration: { ownersFile: path.join(dir, 'owners.json'), peerOrigin: target.url } } });
  const sourceForward = t.mock.method(migration, 'forward');
  const source = await fixture(t, { migration });
  const c = await connect(source.wsUrl); assert.equal(source.relay.registry.size, 0); assert.equal(target.relay.registry.size, 1);
  assert.equal(c.ack.type, 'hello_ack');
  assert.equal(sourceForward.mock.callCount(), 1); assert.equal(sourceForward.mock.calls[0].arguments[2], person);
  assert.equal(targetForward.mock.callCount(), 0);
  const result = target.call(); await respond(c); assert.equal(data(await result).content, 'hello');
  assert.equal((await rejected(source.wsUrl)).status, 401);
  assert.equal(sourceForward.mock.callCount(), 1);
});

test('heartbeat pings, no-pong eviction, valid activity and inFlight cleanup', async t => {
  const f = await fixture(t, { timing: { ping: 20, heartbeat: 85 } });
  const c = await connect(f.wsUrl, { autoPong: false }); let pings = 0; c.ws.on('ping', () => pings++);
  const result = f.call(); await c.next();
  assert.equal((await c.closed).code, 4008); code(await result, 'DEVICE_DISCONNECTED'); assert.ok(pings >= 2); assert.equal(f.relay.registry.size, 0);
  const live = await connect(f.wsUrl); await delay(130); assert.equal(live.ws.readyState, WebSocket.OPEN);
  const noPong = await connect(f.wsUrl, { autoPong: false });
  const activity = setInterval(() => noPong.send({ type: 'state_update', active: true }), 20);
  await delay(120); clearInterval(activity); assert.equal(noPong.ws.readyState, WebSocket.OPEN); assert.equal((await noPong.closed).code, 4008);
});

test('same-device replacement waits for hello, closes 4002; five-device cap includes pending hellos', async t => {
  const f = await fixture(t), clients = [];
  for (let i = 0; i < 5; i++) clients.push(await connect(f.wsUrl));
  assert.equal((await rejected(f.wsUrl, { authorization: `Bearer ${token()}` })).status, 429);
  const old = clients[0], result = f.call({ path: '/documents/a', device_id: old.id }); await old.next();
  const replacement = await connect(f.wsUrl, { id: old.id, skipHello: true }); assert.equal(old.ws.readyState, WebSocket.OPEN);
  replacement.send({ type: 'hello', protocolVersion: 1, deviceId: old.id, deviceName: 'New', platform: 'linux', arch: 'x64', appVersion: '0.3.0', capabilities: ['fs.read'], allowedRoots: ['/documents'] });
  assert.equal((await replacement.next()).type, 'hello_ack'); assert.equal((await old.closed).code, 4002); code(await result, 'DEVICE_DISCONNECTED');
  assert.equal(data(await f.call({}, person, 'desktop_list_devices')).count, 5);
  replacement.ws.close(1000, 'user_logout'); await replacement.closed;
  assert.equal(data(await f.call({}, person, 'desktop_list_devices')).count, 4);
  const pending = await connect(f.wsUrl, { skipHello: true });
  assert.equal((await rejected(f.wsUrl, { authorization: `Bearer ${token()}` })).status, 429); pending.ws.close();
});

test('revoke-all immediately closes every user session 4001 and fails outstanding calls', async t => {
  const f = await fixture(t), a = await connect(f.wsUrl), b = await connect(f.wsUrl), outsider = await connect(f.wsUrl, { bearer: token(other) });
  const result = f.call({ path: '/documents/a', device_id: a.id }); await a.next();
  const response = await fetch(f.url + '/_wp/api/desktop/revoke-all', { method: 'POST', headers: { authorization: `Bearer ${token()}` } });
  assert.equal(response.status, 200); assert.equal((await a.closed).code, 4001); assert.equal((await b.closed).code, 4001);
  code(await result, 'DEVICE_DISCONNECTED'); assert.equal(outsider.ws.readyState, WebSocket.OPEN);
  assert.equal((await rejected(f.wsUrl, { authorization: `Bearer ${token()}` })).status, 401);
});

test('admission changes kick 4003 before calls and on periodic review; expiry/generation kick 4001', async t => {
  const f = await fixture(t, { timing: { review: 25 } });
  for (const change of [() => f.config.desktop.allow = [], () => f.config.desktop.enabled = false, () => f.users.splice(0, 1)]) {
    f.config.desktop.enabled = true; f.config.desktop.allow = ['*']; f.users.splice(0, f.users.length, person, other);
    const c = await connect(f.wsUrl); change(); code(await f.call(), 'DESKTOP_NOT_ADMITTED'); assert.equal((await c.closed).code, 4003);
  }
  f.users.splice(0, f.users.length, person, other); f.config.desktop.allow = ['*']; f.config.desktop.enabled = true;
  const c = await connect(f.wsUrl); f.config.desktop.allow = []; assert.equal((await c.closed).code, 4003);
  f.config.desktop.allow = ['*']; const changed = await connect(f.wsUrl);
  fs.mkdirSync(path.join(f.dir, 'desktop-auth'), { recursive: true }); fs.writeFileSync(path.join(f.dir, 'desktop-auth/generations.json'), JSON.stringify({ [person.unionId]: 1 }));
  assert.deepEqual(await changed.closed, { code: 4001, reason: 'token_revoked' });
  const expiring = await connect(f.wsUrl, { bearer: token(person, { g: 1, exp: Math.floor(Date.now() / 1000) + 1 }) });
  assert.deepEqual(await expiring.closed, { code: 4001, reason: 'token_expired' });
});

test('disconnect fails immediately; timeout and caller abort send rpc_cancel and release slots', async t => {
  const f = await fixture(t, { timing: { call: 65, search: 90 } });
  let c = await connect(f.wsUrl), result = f.call(); await c.next(); c.ws.close(1000, 'user_logout'); code(await result, 'DEVICE_DISCONNECTED'); await c.closed;
  c = await connect(f.wsUrl); result = f.call(); const req = await c.next();
  assert.deepEqual(await c.next(), { type: 'rpc_cancel', reqId: req.reqId, reason: 'timeout' }); code(await result, 'TOOL_TIMEOUT');
  c.send({ type: 'rpc_res', reqId: req.reqId, ok: true, data: { content: 'late' } });
  const controller = new AbortController(); result = f.call(undefined, person, undefined, controller.signal); const canceled = await c.next(); controller.abort();
  assert.deepEqual(await c.next(), { type: 'rpc_cancel', reqId: canceled.reqId, reason: 'caller_aborted' }); code(await result, 'INTERNAL_ERROR');
  result = f.call(); await respond(c); assert.equal((await result).isError, false);
});

test('routing uses explicit ID then preferred then latest activity; state changes and RPC refresh activity', async t => {
  let time = Date.now(); const f = await fixture(t, { now: () => time });
  const a = await connect(f.wsUrl, { hello: { preferred: true, deviceName: 'First' } }); time += 10;
  const b = await connect(f.wsUrl, { hello: { deviceName: 'Second' } });
  let result = f.call(); await respond(a); assert.equal(data(await result)._meta.routed_by, 'preferred');
  result = f.call({ path: '/documents/a', device_id: b.id }); await respond(b); assert.equal(data(await result).device_name, 'Second');
  a.send({ type: 'state_update', preferred: false }); await delay(5); time += 10; b.send({ type: 'state_update', active: true }); await delay(5);
  result = f.call(); await respond(b); const value = data(await result); assert.equal(value._meta.online_devices, 2); assert.equal(value._meta.routed_by, 'lastActiveAt');
  time += 10; a.send({ type: 'state_update', preferred: true, active: true }); b.send({ type: 'state_update', preferred: true }); await delay(5);
  result = f.call(); await respond(a); assert.equal(data(await result).device_id, a.id);
  a.send({ type: 'state_update', allowedRoots: [] }); await delay(5); code(await f.call(), 'NO_ALLOWED_ROOTS');
});

test('concurrency limits are four per device and eight per user; 1 MiB frames fail closed', async t => {
  const f = await fixture(t), a = await connect(f.wsUrl), b = await connect(f.wsUrl), c = await connect(f.wsUrl), outsider = await connect(f.wsUrl, { bearer: token(other) });
  const pending = [];
  for (const client of [a, b]) for (let i = 0; i < 4; i++) { pending.push(f.call({ path: '/documents/a', device_id: client.id })); await client.next(); }
  code(await f.call({ path: '/documents/a', device_id: a.id }), 'CONCURRENCY_LIMIT_EXCEEDED');
  code(await f.call({ path: '/documents/a', device_id: c.id }), 'CONCURRENCY_LIMIT_EXCEEDED');
  const independent = f.call(undefined, other); await respond(outsider); assert.equal((await independent).isError, false);
  a.ws.send('x'.repeat(1048577)); assert.equal((await a.closed).code, 1009);
  b.ws.close(); await b.closed; for (const promise of pending) code(await promise, 'DEVICE_DISCONNECTED');
  const result = f.call(); await respond(c); assert.equal((await result).isError, false);
});

test('offline MCP handshake, notifications, schemas, auth isolation, errors, HTTP limits and Docker token fallback', async t => {
  const f = await fixture(t);
  for (const [method, check] of [['initialize', r => assert.equal(r.protocolVersion, '2025-03-26')], ['ping', r => assert.deepEqual(r, {})], ['tools/list', r => { assert.equal(r.tools.length, 4); assert.equal(r.tools[2].inputSchema.properties.max_bytes.maximum, 262144); }]]) {
    const response = await f.mcp({ jsonrpc: '2.0', id: 1, method }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); check((await response.json()).result);
  }
  for (const method of ['notifications/initialized', 'notifications/test']) { const response = await f.mcp({ jsonrpc: '2.0', method }); assert.equal(response.status, 202); assert.equal(await response.text(), ''); }
  for (const bearer of [token(), 'invalid']) { const response = await f.mcp({}, bearer); assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'unauthorized' }); }
  assert.equal((await fetch(`http://127.0.0.1:${f.internal.address().port}/desktop-mcp`)).status, 405);
  for (const [body, expected] of [['{bad', -32700], [{ method: 'ping' }, -32600], [{ jsonrpc: '2.0', method: 'absent', id: 1 }, -32601]]) assert.equal((await (await f.mcp(body)).json()).error.code, expected);
  assert.equal((await f.mcp('x'.repeat(262145))).status, 413);
  f.config.desktop.enabled = false;
  code((await (await f.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desktop_list_devices' } })).json()).result, 'DESKTOP_NOT_ADMITTED');
  assert.equal(f.published.length, 2);
  for (const [, files] of f.published) { assert.equal(files[0].path, '.zp-market-token'); assert.equal(files[0].mode, 0o600); assert.ok(files[0].content.startsWith('zpd.')); }
});

test('path/parameter prechecks never forward sensitive or outside paths; remote errors and audit are sanitized', async t => {
  const f = await fixture(t), c = await connect(f.wsUrl);
  for (const target of ['/documents/.env', '/documents/.envrc/x', '/documents/.ENV.local', '/documents/.ssh/id', '/documents/key.pem', '/documents/.env/../visible', '/documents/.config/google-chrome/Default/Cookies', '/documents/.mozilla/firefox/profile']) code(await f.call({ path: target }), 'SENSITIVE_PATH_BLOCKED');
  for (const target of ['/documents-other/a', '/documents/../../missing', 'relative', '/documents/a\0b']) code(await f.call({ path: target }), 'PATH_NOT_ALLOWED');
  for (const args of [{}, { path: 1 }, { path: '/documents/a', max_bytes: 262145 }, { path: '/documents/a', start_line: 4, end_line: 3 }, { path: '/documents/a', extra: true }]) code(await f.call(args), 'INVALID_PARAMS');
  code(await f.call({}, person, 'desktop_write_file'), 'TOOL_NOT_SUPPORTED');
  const promise = f.call(); const req = await c.next(); const secret = 'PRIVATE-CONTENT-NEVER-LOG';
  c.send({ type: 'rpc_res', reqId: req.reqId, ok: false, error: { code: 'PATH_NOT_ALLOWED', message: secret + token(), retryable: true, stack: 'stack' } });
  const failure = await promise; code(failure, 'PATH_NOT_ALLOWED'); assert.ok(!JSON.stringify(failure).includes(secret));
  const success = f.call(); await respond(c, { content: secret }); await success;
  for (const record of f.audit) assert.ok(Object.keys(record).every(key => ['at', 'event', 'unionId', 'deviceId', 'tool', 'reqId', 'durationMs', 'status', 'errorCode', 'closeCode'].includes(key)));
  assert.ok(!JSON.stringify(f.audit).includes(secret)); assert.ok(!JSON.stringify(f.audit).includes('/documents')); assert.ok(!JSON.stringify(f.audit).includes('wpd.'));
  c.send({ type: 'state_update', allowedRoots: ['C:\\Docs'] }); await delay(5); c.ws.close(); await c.closed;
  const win = await connect(f.wsUrl, { hello: { platform: 'win32', allowedRoots: ['C:\\Docs'], capabilities: [] } });
  code(await f.call({ path: 'C:\\Docs\\a' }), 'TOOL_NOT_SUPPORTED'); win.ws.close(); await win.closed;
  await connect(f.wsUrl, { hello: { platform: 'win32', allowedRoots: ['C:\\Docs'] } });
  for (const target of ['C:Docs\\a', '\\\\server\\share', 'C:\\DocsOther\\a', 'C:\\Docs\\..\\outside']) code(await f.call({ path: target }), 'PATH_NOT_ALLOWED');
  code(await f.call({ path: 'C:\\Docs\\.envrc' }), 'SENSITIVE_PATH_BLOCKED');
});

test('real gateway mounts MCP only internally, validates WS before web auth, and keeps desktop disabled by default', async t => {
  // Capture the real HTTP servers without opening a listening port. This also works in restricted build sandboxes.
  const { spawnSync } = await import('node:child_process');
  for (const enabled of [false, true]) {
    const dir = directory(t), config = structuredClone(organizationData({}));
    config.publicHost = 'workspace.example.test'; config.model.baseUrl = 'https://models.example.test/v1'; config.extensions.gatewayModule = '';
    for (const flag of Object.keys(config.features)) config.features[flag] = false;
    config.desktop.enabled = enabled; config.desktop.allow = ['*'];
    Object.assign(config.runtime, { gatewayPort: 3090, internalPort: 3091, sessionKeyFile: path.join(dir, 'key'), usersFile: path.join(dir, 'users.json'), stateDirectory: dir, secureDirectory: dir });
    fs.writeFileSync(config.runtime.sessionKeyFile, key); fs.writeFileSync(config.runtime.usersFile, '[]'); fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(config));
    const script = `
import assert from 'node:assert/strict';
import http from 'node:http';
const servers = new Map();
http.Server.prototype.listen = function(port) { servers.set(port, this); return this; };
await import(${JSON.stringify(new URL('../gateway.mjs', import.meta.url).href)});
const server = servers.get(3090);
let status;
await server.listeners('request')[0]({ method: 'POST', url: '/desktop-mcp', headers: { host: 'workspace.example.test' } }, { writeHead(code) { status = code; }, end() {} });
assert.equal(status, 404);
assert.equal(servers.has(3091), ${enabled});
const upgrade = server.listeners('upgrade')[0];
for (const [headers, expected] of [
  [{}, ${enabled ? 400 : 404}],
  [{ 'x-wp-device-id': 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }, ${enabled ? 401 : 404}],
  [{ 'x-wp-protocol-version': '2' }, ${enabled ? 426 : 404}],
]) {
  let response = '';
  await upgrade({ url: '/_wp/desktop/ws', headers: { host: 'workspace.example.test', ...headers } }, { end(text) { response = text; }, destroy() { assert.fail('web proxy must not consume desktop upgrade'); } }, Buffer.alloc(0));
  assert.ok(response.startsWith('HTTP/1.1 ' + expected), response);
}
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, WORKPARTNER_ORG_DIR: dir }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('all three filesystem tools traverse MCP and return device metadata; search uses its own deadline', async t => {
  const f = await fixture(t), c = await connect(f.wsUrl);
  for (const [name, args, timeoutMs] of [['desktop_list_dir', { path: '/documents', max_depth: 3, limit: 200 }, 15000], ['desktop_read_file', { path: '/documents/a', max_bytes: 262144 }, 15000], ['desktop_search_files', { query: '*.md' }, 20000]]) {
    const response = f.mcp({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
    const req = await c.next(); assert.equal(req.type, 'rpc_req'); assert.equal(req.method, 'tools/call'); assert.equal(req.timeoutMs, timeoutMs); assert.deepEqual(req.params, { name, arguments: args });
    c.send({ type: 'rpc_res', reqId: req.reqId, ok: true, data: { marker: name } });
    const result = (await (await response).json()).result; assert.equal(data(result).marker, name); assert.equal(data(result).device_id, c.id);
  }
  const response = await f.mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'desktop_read_file', arguments: { path: '/documents/a', device_id: c.id } } }, issueToken(key, other));
  code((await response.json()).result, 'DEVICE_NOT_FOUND');
});

test('shutdown cancels outstanding jobs and closes 1001; unsupported remote error details never escape', async t => {
  const f = await fixture(t), c = await connect(f.wsUrl);
  let result = f.call(); let req = await c.next();
  c.send({ type: 'rpc_res', reqId: req.reqId, ok: false, error: { code: 'PRIVATE_ERROR', message: 'PRIVATE_MESSAGE' } });
  code(await result, 'INTERNAL_ERROR');
  result = f.call(); req = await c.next();
  c.send({ type: 'rpc_res', reqId: req.reqId, ok: false, error: { code: { toString: null }, message: 'PRIVATE_MESSAGE' } });
  code(await result, 'INTERNAL_ERROR');
  result = f.call(); req = await c.next();
  c.ws.send('{"type":"rpc_res","reqId":' + JSON.stringify(req.reqId) + ',"ok":true,"data":{"nested":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}}');
  code(await result, 'INTERNAL_ERROR');
  result = f.call(); req = await c.next(); f.relay.close();
  assert.deepEqual(await c.next(), { type: 'rpc_cancel', reqId: req.reqId, reason: 'gateway_shutdown' });
  assert.deepEqual(await c.closed, { code: 1001, reason: 'server_shutdown' }); code(await result, 'DEVICE_DISCONNECTED');
  assert.equal(f.relay.registry.size, 0);
});
