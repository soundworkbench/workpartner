/** Exercise the gateway request handler without listening on network sockets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { organizationData } from '../gateway/organization/resolve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function callbackFixture(t, { callbackPath, kind = 'docker', ownersFile, feishuAuthorization = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-callback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = structuredClone(organizationData({}));
  org.publicHost = 'localhost';
  org.model.baseUrl = 'http://localhost/v1';
  for (const feature of Object.keys(org.features)) org.features[feature] = false;
  org.features.feishuAuthorization = feishuAuthorization;
  Object.assign(org.identity, { callbackPath, admission: 'unrestricted', appId: 'fixture-app', appSecretFile: path.join(dir, 'identity.secret') });
  Object.assign(org.runtime, { kind, uid: process.getuid(), migration: { ownersFile }, k8s: { keepRunningIntervalMs: 0 },
    sessionKeyFile: path.join(dir, 'session.key'), usersFile: path.join(dir, 'users.json'),
    secureDirectory: path.join(dir, 'secure'), stateDirectory: path.join(dir, 'state') });
  const user = { slug: 'user1', unionId: 'fixture-union', name: 'Fixture user', backend: 'aionui' };
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([user]));
  fs.writeFileSync(org.runtime.sessionKeyFile, 'fixture-session-key');
  fs.writeFileSync(org.identity.appSecretFile, 'fixture-secret');
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  fs.writeFileSync(path.join(dir, 'runtime.mjs'), `
const runtime = {
  putFiles: async () => { process.send({ write: 'putFiles' }); },
  inspect: async () => ({ exists: false, replicas: null, annotations: {} }),
};
export const createRuntime = () => runtime;
export const createLegacyRuntime = () => runtime;
`);
  fs.writeFileSync(path.join(dir, 'runner.mjs'), `
import { registerHooks } from 'node:module';
import http from 'node:http';
console.log = (...args) => process.send({ log: args.join(' ') });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './runtime/index.mjs' && context.parentURL?.endsWith('/gateway/gateway.mjs')) return { url: ${JSON.stringify(pathToFileURL(path.join(dir, 'runtime.mjs')).href)}, shortCircuit: true };
  return next(specifier, context);
} });
let server;
http.Server.prototype.listen = function (...args) { if (typeof args.at(-1) === 'function') server = this; return this; };
globalThis.fetch = async (url, init) => {
  const result = value => ({ ok: true, json: async () => value });
  if (String(url).endsWith('/user_info')) return result({ code: 0, data: { union_id: init.headers.authorization === 'Bearer new-access' ? 'new-union' : 'fixture-union', name: 'Fixture user' } });
  if (String(url).endsWith('/tenant_access_token/internal')) return result({ tenant_access_token: 'fixture-tenant' });
  if (String(url).endsWith('/scopes')) return result({ data: { scopes: [{ scope_type: 'user', grant_status: 1, scope_name: 'read:example' }] } });
  if (String(url).endsWith('/oauth/token')) return result({ access_token: JSON.parse(init.body).code === 'new' ? 'new-access' : 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 7200 });
  throw new Error('Unexpected fixture fetch');
};
await import(${JSON.stringify(pathToFileURL(path.join(root, 'gateway/gateway.mjs')).href)});
process.on('message', async ({ id, url, headers }) => {
  const response = { status: 200, headers: {}, body: '' };
  let ended = false;
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = name.toLowerCase() === 'set-cookie' && !Array.isArray(value) ? [value] : value; },
    writeHead(status, headers = {}) { response.status = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); this.headersSent = true; },
    end(body = '') { response.body = String(body); ended = true; },
  };
  await server.listeners('request')[0]({ method: 'GET', url, headers: { host: ${JSON.stringify(org.publicHost)}, ...headers } }, res);
  process.send({ id, response, ended });
});
process.send({ ready: true });
`);
  const child = fork(path.join(dir, 'runner.mjs'), [], { execArgv: [],
    env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir }, silent: true });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  const writes = [], logs = [], pending = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway startup timed out: ' + output)), 5000);
    child.on('message', message => {
      if (message.write) writes.push(message.write);
      if (message.log) logs.push(message.log);
      if (message.ready) { clearTimeout(timer); resolve(); }
      if (message.id) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Gateway exited ' + code + ': ' + output)); });
  });
  let id = 0;
  const request = (url, { headers = {} } = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timed out: ' + output)), 5000);
    pending.set(++id, message => {
      clearTimeout(timer);
      if (!message.ended) reject(new Error('Request did not end: ' + output));
      else resolve(message.response);
    });
    child.send({ id, url, headers });
  });
  async function login() {
    const started = await request('/_wp/login');
    const done = await request('/_wp/callback?code=fixture&state=' + new URL(started.headers.location).searchParams.get('state'), {
      headers: { cookie: started.headers['set-cookie'][0].split(';')[0] },
    });
    assert.equal(done.status, 302, output);
    return done.headers['set-cookie'][0].split(';')[0];
  }
  return { org, user, request, login, writes, logs, output: () => output };
}

test('configured callback and default callback both issue login sessions and preserve next', async t => {
  const callbackPath = '/_zp/callback';
  const f = await callbackFixture(t, { callbackPath });
  for (const route of [callbackPath, '/_wp/callback']) {
    for (const onboard of [false, true]) {
      const next = '/_wp/feishu/?tab=settings';
      const started = await f.request('/_wp/login?' + new URLSearchParams({ next, onboard: onboard ? '1' : '0' }));
      const authorization = new URL(started.headers.location);
      assert.equal(new URL(authorization.searchParams.get('redirect_uri')).pathname, callbackPath);
      const done = await f.request(route + '?code=fixture&state=' + authorization.searchParams.get('state'), {
        headers: { cookie: started.headers['set-cookie'][0].split(';')[0] },
      });
      assert.equal(done.status, 302, f.output());
      assert.equal(done.headers.location, onboard ? '/_wp/preparing' : next);
      const cookie = done.headers['set-cookie'][0];
      assert.match(cookie, /^wp_sid=.+; Path=\/; HttpOnly; Secure; SameSite=Lax;/);
      const me = await f.request('/_wp/me', { headers: { cookie: cookie.split(';')[0] } });
      assert.equal(me.status, 200);
      assert.equal(JSON.parse(me.body).name, f.user.name);
    }
    const invalid = await f.request(route + '?code=fixture&state=mismatch', { headers: { cookie: 'wp_state=expected|0|%2F' } });
    assert.match(invalid.body, /授权已过期或被取消/);
    assert.equal(invalid.headers['set-cookie'], undefined);
  }
});

test('configured callback sends feishu states to personal authorization', async t => {
  const callbackPath = '/_zp/callback';
  const f = await callbackFixture(t, { callbackPath });
  const cookie = await f.login();
  const connect = await f.request('/_wp/feishu/connect?return=settings&display=popup', { headers: { cookie } });
  const authorization = new URL(connect.headers.location);
  assert.equal(new URL(authorization.searchParams.get('redirect_uri')).pathname, callbackPath);
  assert.match(authorization.searchParams.get('state'), /^feishu-/);
  const done = await f.request(callbackPath + '?code=personal&state=' + authorization.searchParams.get('state'), {
    headers: { cookie: cookie + '; ' + connect.headers['set-cookie'][0].split(';')[0] },
  });
  assert.equal(done.status, 302, done.body);
  assert.match(done.headers.location, /feishu\/done\?display=popup$/);
  assert.ok(done.headers['set-cookie'].every(value => !value.startsWith('wp_sid=')));
  const status = await f.request('/_wp/feishu/status', { headers: { cookie } });
  assert.equal(JSON.parse(status.body).connected, true);
});

test('configured callback excludes feishu states from local login handling', async t => {
  const callbackPath = '/_zp/callback';
  const route = callbackPath + '?state=feishu-x&code=y';
  // Match wp_state so accidental login handling would successfully issue wp_sid.
  const stateCookie = 'wp_state=feishu-x|0|%2F';

  await t.test('a session owned by the peer follows migration routing', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-callback-owners-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ownersFile = path.join(dir, 'owners.json');
    fs.writeFileSync(ownersFile, JSON.stringify({ version: 1, default: 'docker', users: { user1: 'k8s' } }));
    const f = await callbackFixture(t, { callbackPath, kind: 'docker', ownersFile });
    const session = await f.login();
    assert.match(session, /^wp_sid=/);
    const result = await f.request(route, { headers: { cookie: session + '; ' + stateCookie } });
    // No peerOrigin is configured: migration routing must return unavailable.
    assert.equal(result.status, 503, result.body);
    assert.match(result.body, /工作区迁移中/);
    assert.ok((result.headers['set-cookie'] || []).every(value => !value.startsWith('wp_sid=')));
  });

  await t.test('disabled personal authorization does not fall through to login', async t => {
    const f = await callbackFixture(t, { callbackPath, feishuAuthorization: false });
    const result = await f.request(route, { headers: { cookie: stateCookie } });
    assert.ok((result.headers['set-cookie'] || []).every(value => !value.startsWith('wp_sid=')));
    assert.equal(result.status, 302, result.body);
    assert.equal(result.headers.location, '/_wp/login?next=' + encodeURIComponent(route));
  });
});

test('omitting callbackPath leaves alternate paths outside login handling', async t => {
  const f = await callbackFixture(t);
  for (const state of ['fixture', 'feishu-fixture']) {
    const route = '/_zp/callback?code=new&state=' + state;
    const result = await f.request(route, { headers: { cookie: 'wp_state=' + state + '|0|%2F' } });
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, '/_wp/login?next=' + encodeURIComponent(route));
    assert.equal(result.headers['set-cookie'], undefined);
  }
  assert.match(await f.login(), /^wp_sid=/);
});

for (const kind of ['docker', 'k8s']) {
  test(`${kind} gateway logs ownership when onboarding is denied on either callback`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-onboard-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ownersFile = path.join(dir, 'owners.json');
    const owner = kind === 'docker' ? 'k8s' : 'docker';
    fs.writeFileSync(ownersFile, JSON.stringify({ version: 1, default: owner, users: {} }));
    const f = await callbackFixture(t, { kind, ownersFile, callbackPath: '/_zp/callback' });
    const slug = 'u' + createHash('sha256').update('new-union').digest('hex').slice(0, 8);
    // An existing session owned by the peer must not divert login callbacks.
    const data = Buffer.from(JSON.stringify({ u: f.user.unionId, n: f.user.name, e: Date.now() / 1000 + 600 })).toString('base64url');
    const session = 'wp_sid=' + data + '.' + createHmac('sha256', 'fixture-session-key').update(data).digest('base64url');
    for (const route of ['/_zp/callback', '/_wp/callback']) {
      const result = await f.request(route + '?code=new&state=fixture', {
        headers: { cookie: session + '; wp_state=fixture|1|%2F_wp%2Fpreparing' },
      });
      assert.equal(result.status, 503);
      assert.match(result.body, /工作区迁移中/);
      assert.match(result.body, /请稍后重试。/);
      assert.equal(result.headers['set-cookie'], undefined);
    }
    const prefix = '[migration] Onboarding denied ';
    const lines = f.logs.filter(line => line.startsWith(prefix));
    assert.equal(lines.length, 2, JSON.stringify(f.logs));
    for (const line of lines) {
      assert.deepEqual(JSON.parse(line.slice(prefix.length)), { slug, name: 'Fixture user', owner, kind });
      assert.doesNotMatch(line, /new-union|fixture-union|new-access|fixture-access|fixture-refresh|fixture-secret/);
    }
    assert.deepEqual(f.writes, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.org.runtime.usersFile, 'utf8')), [f.user]);
  });
}

test('configured callback onboards an owned new user and issues a usable session', async t => {
  const f = await callbackFixture(t, { kind: 'k8s', callbackPath: '/_zp/callback' });
  const slug = 'u' + createHash('sha256').update('new-union').digest('hex').slice(0, 8);
  fs.mkdirSync(f.org.runtime.secureDirectory, { recursive: true });
  fs.writeFileSync(path.join(f.org.runtime.secureDirectory, f.org.model.keyPrefix + slug + '.key'), 'fixture-model-key');
  const started = await f.request('/_wp/login?onboard=1');
  const result = await f.request('/_zp/callback?code=new&state=' + new URL(started.headers.location).searchParams.get('state'), {
    headers: { cookie: started.headers['set-cookie'][0].split(';')[0] },
  });
  assert.equal(result.status, 302, f.output());
  assert.equal(result.headers.location, '/_wp/preparing');
  assert.ok(JSON.parse(fs.readFileSync(f.org.runtime.usersFile, 'utf8')).some(user => user.slug === slug && user.unionId === 'new-union'));
  const me = await f.request('/_wp/me', { headers: { cookie: result.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(me.status, 200);
  assert.equal(JSON.parse(me.body).name, 'Fixture user');
});
