/** Run the exported gateway, including optional services, against local HTTP fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { organizationData, nextModelConfig } from '../gateway/organization/resolve.mjs';
import { issueToken, tokenUser } from '../gateway/market-auth.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

function fixtureOrganization(t) {
  const baseline = structuredClone(organizationData({}));
  t.after(() => assert.deepEqual(organizationData({}), baseline, 'fixtures must not mutate shared organization defaults'));
  // organizationData shares omitted nested fields with its cached defaults.
  return structuredClone(baseline);
}

test('gateway preserves a reused extension result and refreshes its upstream address on each request', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-legacy-resolve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = fixtureOrganization(t);
  org.market.sharedDirectory = path.join(dir, 'shared-skills');
  org.publicHost = 'workspace.example.test';
  org.model.baseUrl = 'http://models.example.test/v1';
  for (const key of Object.keys(org.features)) org.features[key] = false;
  Object.assign(org.runtime, { gatewayPort: 0, uid: process.getuid(),
    sessionKeyFile: path.join(dir, 'session.key'), usersFile: path.join(dir, 'users.json') });
  org.extensions.gatewayModule = './extension.mjs';
  fs.writeFileSync(org.runtime.sessionKeyFile, 'fixture-session-key');
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([{ slug: 'person', unionId: 'fixture-union', backend: 'legacy' }]));
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  fs.writeFileSync(path.join(dir, 'extension.mjs'), `
export const up = { ip: 'old-host' };
export const cached = { up, port: 9000, cookie: 'legacy-session', backend: 'legacy' };
export const seen = [];
export let context;
export function createGatewayExtension(options) {
  context = options;
  return { handle: async () => false, resolve: async () => cached, prepared: async result => { seen.push(result); } };
}
`);
  const script = `
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
let server;
const logs = [];
console.log = (...args) => logs.push(args.join(' '));
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function () { server = this; return this; };
await import(${JSON.stringify(pathToFileURL(path.join(root, 'gateway/gateway.mjs')).href)});
http.Server.prototype.listen = listen;
const { up, cached, seen, context } = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'extension.mjs')).href)});
const data = Buffer.from(JSON.stringify({ u: 'fixture-union', n: 'Fixture', e: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
const mac = crypto.createHmac('sha256', 'fixture-session-key').update(data).digest('base64url');
const handle = server.listeners('request')[0];
for (const host of ['old-host', 'new-host']) {
  up.ip = host;
  let status, location, response, ended = false;
  await handle({ method: 'GET', url: '/_wp/preparing', headers: { host: 'workspace.example.test', cookie: 'wp_sid=' + data + '.' + mac } },
    { writeHead(code, headers) { status = code; location = headers.location; }, end(body) { response = body; ended = true; } });
  assert.equal(status, 302, JSON.stringify({ logs, response }));
  assert.equal(location, '/?zp-welcome=1');
  assert.equal(ended, true);
}
assert.equal(seen.length, 2);
assert.deepEqual(seen.map(result => result.up.address), [{ host: 'old-host', port: 9000 }, { host: 'new-host', port: 9000 }]);
assert.equal(cached.up, up, 'the extension retains its original upstream object');
assert.deepEqual(up, { ip: 'new-host' });
for (const result of seen) {
  assert.notEqual(result, cached);
  assert.notEqual(result.up, up);
  assert.equal(result.cookie, 'legacy-session');
  assert.equal(result.backend, 'legacy');
}
assert.deepEqual(Object.keys(context.runtime).sort(), ['address', 'exec', 'putFiles', 'readFile', 'remove', 'removeFiles', 'stop']);
await assert.rejects(context.runtime.address('person'), /Legacy runtime does not support.*existing/i);
assert.equal(typeof context.personalRuntime.create, 'function');
assert.equal(typeof context.personalRuntime.inspect, 'function');
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
});

async function fixture(t, { disabled = false, extension = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-services-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = fixtureOrganization(t);
  org.market.sharedDirectory = path.join(dir, 'shared-skills');
  org.publicHost = 'workspace.example.test';
  org.model.baseUrl = 'http://models.example.test/v1';
  org.features.feishuAuthorization = true;
  if (!disabled) {
    org.extensions.gatewayModule = 'greedy-extension.mjs';
    fs.writeFileSync(path.join(dir, 'greedy-extension.mjs'), `export async function createGatewayExtension() { return { async handle(req, res, url) { if (!url.pathname.startsWith('/_wp/market/shared')) return false; res.writeHead(500); res.end('Extension must not own core skill routes'); return true; } }; }`);
  }
  if (disabled) for (const key of Object.keys(org.features)) org.features[key] = false;
  Object.assign(org.runtime, { gatewayPort: 0, internalPort: 0, uid: process.getuid(), nextImage: 'fixture-image',
    sessionKeyFile: path.join(dir, 'session.key'), usersFile: path.join(dir, 'users.json'), cookieFile: path.join(dir, 'cookies.json'),
    nextDirectory: path.join(dir, 'workspaces'), stateDirectory: path.join(dir, 'state'), secureDirectory: path.join(dir, 'secure') });
  org.identity.appId = 'fixture-app'; org.identity.appSecretFile = path.join(dir, 'identity.secret');
  fs.writeFileSync(org.runtime.sessionKeyFile, 'fixture-session-key');
  fs.writeFileSync(org.identity.appSecretFile, 'fixture-app-secret');
  fs.mkdirSync(path.join(dir, 'secure/aionui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secure/aionui/aionui-user1.pass'), 'fixture-password');
  fs.writeFileSync(path.join(dir, 'secure/model-user1.key'), 'fixture-model-key');
  const user = { slug: 'user1', unionId: 'fixture-union', name: 'Fixture user', backend: 'aionui' };
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([user]));
  if (extension) {
    org.extensions.gatewayModule = './extension.mjs';
    fs.writeFileSync(path.join(dir, 'extension.mjs'), `
import fs from 'node:fs';
import { writeContainerToken } from ${JSON.stringify(pathToFileURL(path.join(root, 'gateway/market-auth.mjs')).href)};
export function createGatewayExtension({ docker, runtime, personalRuntime, SESSION_KEY, users, organization }) {
  return { internal: async (req, res) => {
    if (req.url !== '/compatibility') return false;
    const result = await docker('POST', '/containers/compat/exec', { Cmd: ['fixture'] }, 25000);
    const root = organization.directory + '/legacy';
    const returned = writeContainerToken(SESSION_KEY, users()[0], root, organization.runtime.uid);
    const token = fs.readFileSync(root + '/' + users()[0].slug + '/.zp-market-token', 'utf8');
    res.end(JSON.stringify({ status: result.status, buffer: Buffer.isBuffer(result.body), body: result.body.toString(),
      synchronous: returned === undefined, token, runtime: typeof runtime.exec, personalRuntime: typeof personalRuntime.exec }));
    return true;
  } };
}
`);
  }
  const calls = [], upstreamHits = [];
  let conversation = { id: 'new-chat', name: 'Initial', extra: { backend: 'codex' } };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/login') { res.writeHead(200, { 'set-cookie': 'personal-session=fixture; HttpOnly' }); return res.end('{}'); }
    upstreamHits.push({ path: req.url, headers: req.headers });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'PATCH') conversation = { ...conversation, ...JSON.parse(Buffer.concat(chunks)) };
    res.setHeader('content-type', 'application/json'); res.setHeader('set-cookie', 'private-cookie=upstream');
    res.end(req.url.startsWith('/api/conversations') ? JSON.stringify({ data: conversation }) : 'workspace response');
  });
  const frame = data => { const bytes = Buffer.from(JSON.stringify(data)), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]); };
  const docker = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({ method: req.method, path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/exec')) { res.writeHead(201); return res.end('{"Id":"command"}'); }
    if (req.url === '/exec/command/json') return res.end('{"ExitCode":0}');
    if (req.url === '/exec/command/start') {
      const command = calls.findLast(call => call.body?.Cmd)?.body.Cmd;
      const value = command?.includes('status') ? { status: 'connected', ignored_private_field: 'not-returned' }
        : command?.includes('install') ? { name: 'personal-skill' }
        : { skills: [{ id: 'one', name: 'one', description: 'Skill', preinstalled: true }] };
      return res.end(frame(value));
    }
    if (req.url.startsWith('/containers/')) return res.end(JSON.stringify({ Config: { Image: 'fixture-image', Env: ['WORKPARTNER_MODEL_CONFIG=' + JSON.stringify(nextModelConfig(org)), 'WORKPARTNER_SHARED_SKILLS=' + org.market.containerDirectory, 'WORKPARTNER_MARKET_PREINSTALLED=' + JSON.stringify(org.market.preinstalled)] }, Image: 'sha256:fixture', State: { Running: true }, NetworkSettings: { Networks: { 'workpartner-next-user1-net': { IPAddress: '127.0.0.1' } } } }));
    if (req.url.startsWith('/images/')) return res.end('{"Id":"sha256:fixture"}');
    if (req.url.startsWith('/networks/')) return res.end('{"Containers":{}}');
    res.writeHead(500); res.end('{}');
  });
  for (const server of [upstream, docker]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  }
  org.runtime.nextPort = upstream.address().port;
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  fs.writeFileSync(path.join(dir, 'transport.mjs'), `
import http from 'node:http';
const request = http.request;
http.request = (options, ...rest) => request.call(http, options.socketPath ? { ...options, socketPath: undefined, host: '127.0.0.1', port: ${docker.address().port} } : options, ...rest);
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...args) { const kind = typeof args.at(-1) === 'function' ? 'gateway' : 'internal'; this.once('listening', () => process.send({ kind, port: this.address().port })); return listen.apply(this, args); };
globalThis.fetch = async (url, init) => {
  url = String(url);
  const result = value => ({ ok: true, json: async () => value });
  if (url.endsWith('/authen/v2/oauth/token')) return result({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 7200, refresh_token_expires_in: 86400 });
  if (url.endsWith('/authen/v1/user_info')) return result({ code: 0, data: { union_id: 'fixture-union', name: 'Fixture user' } });
  if (url.endsWith('/auth/v3/tenant_access_token/internal')) return result({ tenant_access_token: 'fixture-tenant' });
  if (url.endsWith('/application/v6/scopes')) return result({ data: { scopes: [{ scope_type: 'user', grant_status: 1, scope_name: 'read:example' }] } });
  if (url.endsWith('/models')) return result({ data: [{ id: 'gpt-6-luna' }] });
  if (url.endsWith('/chat/completions')) return result({ choices: [{ message: { content: '自动标题' } }] });
  return fetchOriginal(url, init);
};
` .replace('globalThis.fetch =', 'const fetchOriginal = globalThis.fetch;\nglobalThis.fetch ='));
  const child = fork(path.join(root, 'gateway/gateway.mjs'), [], { execArgv: ['--import', path.join(dir, 'transport.mjs')],
    env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir, PREVIEW_HOST: 'preview.example.test' }, silent: true });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  const ports = {};
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway startup timed out: ' + output)), 5000);
    child.on('message', msg => { ports[msg.kind] = msg.port; if (ports.gateway && ((disabled && !extension) || ports.internal)) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Gateway exited ' + code + ': ' + output)); });
  });
  const request = (url, { method = 'GET', headers = {}, body, internal = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ports[internal ? 'internal' : 'gateway'], path: url, method,
      headers: { host: org.publicHost, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  async function login() {
    const started = await request('/_wp/login');
    const url = new URL(started.headers.location);
    const done = await request('/_wp/callback?code=fixture&state=' + url.searchParams.get('state'), { headers: { cookie: started.headers['set-cookie'][0].split(';')[0] } });
    assert.equal(done.status, 302, output);
    return done.headers['set-cookie'][0].split(';')[0];
  }
  return { request, login, calls, upstreamHits, dir, org, user, output: () => output };
}

test('exported gateway serves authorization, skill uploads, automatic titles and private previews', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/_wp/me')).status, 401);
  assert.equal((await f.request('/_wp/market/skills')).status, 401);
  assert.equal((await f.request('/token', { method: 'POST', internal: true })).status, 401);
  const cookie = await f.login(), headers = { cookie, origin: 'https://' + f.org.publicHost };
  assert.equal((await f.request('/_wp/me', { headers })).status, 200);
  assert.equal((await f.request('/_wp/feishu/status', { headers })).status, 200);
  assert.equal(JSON.parse((await f.request('/_wp/feishu/status', { headers })).body).connected, false);
  const connect = await f.request('/_wp/feishu/connect?return=settings&display=popup', { headers });
  const authorization = new URL(connect.headers.location);
  const connected = await f.request('/_wp/callback?code=personal&state=' + authorization.searchParams.get('state'),
    { headers: { ...headers, cookie: cookie + '; ' + connect.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(connected.status, 302);
  assert.match(connected.headers.location, /feishu\/done\?display=popup$/);
  const token = fs.readFileSync(path.join(f.org.runtime.nextDirectory, 'user1/.zp-market-token'), 'utf8').trim();
  assert.deepEqual(tokenUser({ headers: { authorization: 'Bearer ' + token } }, 'fixture-session-key', [f.user]), f.user);
  assert.equal(tokenUser({ headers: { authorization: 'Bearer ' + token } }, 'other-key', [f.user]), null);
  const settings = JSON.parse(fs.readFileSync(path.join(f.org.runtime.nextDirectory, 'user1/.wp-feishu-cli.json')));
  const dockerfile = fs.readFileSync(path.join(root, 'image/Dockerfile'), 'utf8');
  assert.match(dockerfile, /WORKPARTNER_IDENTITY_CONFIG=\/data\/\.wp-feishu-cli\.json/);
  assert.match(settings.tokenUrl, /\/token$/);
  assert.equal(settings.authorizationUrl, 'https://' + f.org.publicHost + '/_wp/feishu/');
  const issued = await f.request('/token', { method: 'POST', internal: true, headers: { authorization: 'Bearer ' + token } });
  assert.equal(issued.status, 200); assert.equal(JSON.parse(issued.body).user_access_token, 'fixture-access');
  const forged = issueToken('other-signing-key', f.user);
  assert.equal((await f.request('/token', { method: 'POST', internal: true, headers: { authorization: 'Bearer ' + forged } })).status, 401);
  assert.equal((await f.request('/_wp/market/skills', { headers })).status, 200);
  const shared = await f.request('/_wp/market/shared', { headers });
  assert.equal(shared.status, 200); assert.deepEqual(JSON.parse(shared.body).company, []);
  const before = f.calls.length;
  assert.equal((await f.request('/_wp/market/skills?filename=SKILL.md', { method: 'POST', headers: { ...headers, origin: 'https://other.example.test', 'content-type': 'application/octet-stream' }, body: 'invalid' })).status, 403);
  assert.equal(f.calls.length, before);
  const upload = await f.request('/_wp/market/skills?filename=SKILL.md', { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: '---\nname: personal-skill\ndescription: Example\n---\n# Example\n' });
  assert.equal(upload.status, 200, upload.body);
  assert.equal(JSON.parse(upload.body).name, 'personal-skill');
  assert.ok(f.calls.some(call => call.body?.Cmd?.includes('/opt/workpartner/bin/wp-skill')));
  assert.equal((await f.request('/_wp/aionui/feishu/status', { headers })).body, '{"status":"connected"}');
  const created = await f.request('/api/conversations', { method: 'POST', headers, body: '{}' });
  assert.equal(created.status, 200);
  assert.equal(created.headers['set-cookie'], undefined);
  await f.request('/api/conversations/new-chat/messages', { method: 'POST', headers, body: '{"content":"帮我整理报告"}' });
  const title = await f.request('/_wp/next-title/new-chat', { method: 'POST', headers });
  assert.equal(title.status, 200); // The message-triggered background job may already have set the title.
  const chat = JSON.parse((await f.request('/api/conversations/new-chat', { headers })).body);
  assert.equal(chat.data.name, '自动标题');
  const preview = await f.request('/_wp/preview/open?port=8080&path=%2F', { headers });
  assert.equal(preview.status, 302);
  assert.equal(new URL(preview.headers.location).hostname, 'preview.example.test');
  assert.ok(fs.existsSync(path.join(f.org.runtime.nextDirectory, 'user1/.zp-preview-relay-key')));
  assert.equal((await f.request('/api/private', { headers: { ...headers, origin: 'https://preview.example.test' } })).status, 403);
  assert.equal((await f.request('/_wp/desktop-login', { headers })).status, 404);
  assert.ok(!fs.existsSync(f.org.runtime.cookieFile), 'legacy cookie state is not read or written');
});

test('organization switches disable integrations without loading private code or state', async t => {
  const f = await fixture(t, { disabled: true });
  const headers = { cookie: await f.login() };
  for (const route of ['/_wp/feishu/status', '/_wp/aionui/feishu/status', '/_wp/market/skills', '/_wp/preview/open?port=8080&path=%2F']) {
    assert.equal((await f.request(route, { headers })).status, 404, route);
  }
  assert.ok(!fs.existsSync(f.org.runtime.stateDirectory));
  assert.ok(!fs.existsSync(f.org.runtime.nextDirectory));
});

test('existing organization extensions retain Docker and synchronous token dependencies', async t => {
  const f = await fixture(t, { disabled: true, extension: true });
  const result = await f.request('/compatibility', { internal: true });
  assert.equal(result.status, 200);
  const { token, ...compatibility } = JSON.parse(result.body);
  assert.deepEqual(compatibility, { status: 201, buffer: true, body: '{"Id":"command"}', synchronous: true,
    runtime: 'function', personalRuntime: 'function' });
  assert.deepEqual(tokenUser({ headers: { authorization: `Bearer ${token.trim()}` } }, 'fixture-session-key', [f.user]), f.user);
  assert.deepEqual(f.calls.find(call => call.path === '/containers/compat/exec'), {
    method: 'POST', path: '/containers/compat/exec', body: { Cmd: ['fixture'] },
  });
});

async function migrationGateway(t, { kind, ownersFile, peerOrigin, extension = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = fixtureOrganization(t);
  org.market.sharedDirectory = path.join(dir, 'shared-skills');
  org.publicHost = 'workspace.example.test';
  org.model.baseUrl = 'http://models.example.test/v1';
  org.features.feishuAuthorization = true;
  org.features.preview = true;
  org.identity.admission = 'unrestricted';
  org.identity.appId = 'fixture-app';
  org.identity.appSecretFile = path.join(dir, 'identity.secret');
  Object.assign(org.runtime, { kind, gatewayPort: 0, internalPort: 0, uid: process.getuid(),
    migration: { ownersFile, peerOrigin }, k8s: { keepRunningIntervalMs: 0, loadGatewayExtension: extension },
    sessionKeyFile: path.join(dir, 'session.key'), usersFile: path.join(dir, 'users.json'),
    secureDirectory: path.join(dir, 'secure'), stateDirectory: path.join(dir, 'state') });
  const user = { slug: 'user1', unionId: 'fixture-union', name: 'Fixture user', backend: 'aionui' };
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([user]));
  fs.writeFileSync(org.runtime.sessionKeyFile, 'fixture-session-key');
  fs.writeFileSync(org.identity.appSecretFile, 'fixture-secret');
  org.extensions.gatewayModule = './extension.mjs';
  fs.writeFileSync(path.join(dir, 'extension.mjs'), `export function createGatewayExtension() { process.send({ extension: true }); return null; }`);
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  fs.writeFileSync(path.join(dir, 'runtime.mjs'), `
const runtime = Object.fromEntries(['ensureIsolation', 'create', 'start', 'stop', 'restart', 'remove', 'exec', 'execNamed', 'processes', 'runOnce', 'putFiles', 'removeFiles'].map(name => [name, async (...args) => { process.send({ write: { name, slug: args[0]?.slug || args[0] } }); return {}; }]));
runtime.readFile = async () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); };
runtime.inspect = async () => ({ exists: false, replicas: null, annotations: {} });
export const createRuntime = () => runtime;
export const createLegacyRuntime = () => runtime;
`);
  fs.writeFileSync(path.join(dir, 'preload.mjs'), `
import { registerHooks } from 'node:module';
import http from 'node:http';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './runtime/index.mjs' && context.parentURL?.endsWith('/gateway/gateway.mjs')) return { url: ${JSON.stringify(pathToFileURL(path.join(dir, 'runtime.mjs')).href)}, shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (${JSON.stringify(kind)} === 'k8s' && url.endsWith('/runtime/docker.mjs')) throw new Error('Docker transport loaded in k8s mode');
  return next(url, context);
} });
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...args) {
  const kind = typeof args.at(-1) === 'function' ? 'gateway' : 'internal';
  this.once('listening', () => process.send({ kind, port: this.address().port }));
  return listen.apply(this, args);
};
globalThis.fetch = async (url, init) => {
  const result = value => ({ ok: true, json: async () => value });
  if (String(url).endsWith('/user_info')) return result({ code: 0, data: { union_id: init.headers.authorization === 'Bearer personal-access' ? 'fixture-union' : 'new-union', name: 'Fixture user' } });
  if (String(url).endsWith('/tenant_access_token/internal')) return result({ tenant_access_token: 'fixture-tenant' });
  if (String(url).endsWith('/scopes')) return result({ data: { scopes: [{ scope_type: 'user', grant_status: 1, scope_name: 'read:example' }] } });
  return result({ access_token: JSON.parse(init.body).code === 'personal' ? 'personal-access' : 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 7200 });
};
`);
  const child = fork(path.join(root, 'gateway/gateway.mjs'), [], { execArgv: ['--import', path.join(dir, 'preload.mjs')],
    env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir, PREVIEW_HOST: 'preview.example.test' }, silent: true });
  const writes = [], ports = {}; let output = '', loadedExtension = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Migration gateway startup timed out: ' + output)), 5000);
    child.on('message', message => {
      if (message.write) writes.push(message.write);
      if (message.extension) loadedExtension = true;
      if (message.kind) ports[message.kind] = message.port;
      if (ports.gateway && ports.internal) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Migration gateway exited ${code}: ${output}`)); });
  });
  const request = (url, { method = 'GET', headers = {}, body, internal = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ports[internal ? 'internal' : 'gateway'], path: url, method,
      headers: { host: org.publicHost, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  return { org, user, request, writes, ports, loadedExtension, output: () => output };
}

test('two migration gateways preserve HTTP and WebSocket requests, local entry routes and live ownership', { timeout: 15000 }, async t => {
  const crypto = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-owners-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ownersFile = path.join(dir, 'owners.json');
  const assign = owner => {
    fs.writeFileSync(ownersFile + '.tmp', JSON.stringify({ version: 1, default: owner, users: {} }));
    fs.renameSync(ownersFile + '.tmp', ownersFile);
  };
  assign('docker');
  const seen = [], sockets = new Set();
  const peer = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(201, { 'set-cookie': ['peer=one; HttpOnly', 'peer2=two'], 'x-peer': 'fixture' }); res.end('peer response');
  });
  peer.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url, headers: req.headers });
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.on('data', data => socket.write(data));
  });
  peer.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => peer.close(resolve)); });
  const k8s = await migrationGateway(t, { kind: 'k8s', ownersFile, peerOrigin: `http://127.0.0.1:${peer.address().port}` });
  const docker = await migrationGateway(t, { kind: 'docker', ownersFile, peerOrigin: `http://127.0.0.1:${k8s.ports.gateway}` });
  assert.equal(k8s.loadedExtension, false);
  assert.equal(docker.loadedExtension, true);
  const data = Buffer.from(JSON.stringify({ u: k8s.user.unionId, n: 'Fixture user', e: Date.now() / 1000 + 600 })).toString('base64url');
  const cookie = `wp_sid=${data}.${crypto.createHmac('sha256', 'fixture-session-key').update(data).digest('base64url')}`;
  const headers = { cookie, authorization: 'Bearer fixture-header', origin: 'https://workspace.example.test', 'x-custom': 'preserved' };
  const response = await k8s.request('/api/example?x=1', { method: 'POST', headers, body: 'streamed request' });
  assert.equal(response.status, 201); assert.equal(response.body, 'peer response');
  assert.deepEqual(response.headers['set-cookie'], ['peer=one; HttpOnly', 'peer2=two']);
  assert.equal(seen.at(-1).url, '/api/example?x=1');
  assert.equal(seen.at(-1).method, 'POST');
  assert.equal(seen.at(-1).body, 'streamed request');
  for (const [key, value] of Object.entries({ ...headers, host: 'workspace.example.test', 'x-workpartner-delegated': '1' })) assert.equal(seen.at(-1).headers[key], value);
  const upgrade = (gateway, host = 'workspace.example.test', session = cookie) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gateway.ports.gateway, path: '/socket?x=1', headers: {
      ...headers, host, cookie: session, origin: `https://${host}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'Zml4dHVyZS13ZWJzb2NrZXQ=', 'sec-websocket-version': '13',
    } });
    req.on('upgrade', (res, socket, head) => {
      assert.equal(res.statusCode, 101);
      if (head.length) { socket.destroy(); resolve(head.toString()); return; }
      socket.once('data', chunk => { socket.destroy(); resolve(chunk.toString()); });
      socket.write('fixture echo');
    });
    req.on('response', res => reject(new Error(`Upgrade rejected: ${res.statusCode}`)));
    req.on('error', reject); req.end();
  });
  assert.equal(await upgrade(k8s), 'fixture echo');
  assert.equal(seen.at(-1).headers.host, 'workspace.example.test');
  assert.equal(seen.at(-1).headers.cookie, cookie);
  assert.equal(seen.at(-1).headers['x-custom'], 'preserved');
  assert.equal(seen.at(-1).headers['x-workpartner-delegated'], '1');
  let count = seen.length;
  assert.equal((await k8s.request('/api/example', { headers: { ...headers, 'x-workpartner-delegated': '1' } })).status, 502);
  for (const route of ['/_wp/login', '/_wp/logout', '/_wp/callback']) {
    assert.notEqual((await k8s.request(route, { headers })).body, 'peer response');
  }
  assert.equal(seen.length, count);
  assert.equal((await k8s.request('/_wp/callback?state=feishu-fixture&code=fixture', { headers })).status, 201);
  assert.equal(seen.length, ++count, 'authorization callbacks delegate to the owner');
  assert.equal((await k8s.request('/_wp/preparing', { headers })).status, 201);
  assert.equal(seen.length, ++count, 'listed users preparing their workspace delegate to the owner');
  const newData = Buffer.from(JSON.stringify({ u: 'new-union', n: 'New user', e: Date.now() / 1000 + 600 })).toString('base64url');
  const newCookie = `wp_sid=${newData}.${crypto.createHmac('sha256', 'fixture-session-key').update(newData).digest('base64url')}`;
  const preparing = await k8s.request('/_wp/preparing', { headers: { cookie: newCookie } });
  assert.equal(preparing.status, 200); assert.match(preparing.body, /工作伙伴待开通/);
  assert.equal(seen.length, count, 'unlisted users stay at the entry gateway');
  const onboarding = await k8s.request('/_wp/callback?state=fixture&code=fixture', { headers: { cookie: 'wp_state=fixture|1|%2F_wp%2Fpreparing' } });
  assert.equal(onboarding.status, 503); assert.match(onboarding.body, /工作区迁移中/);
  assert.equal((await k8s.request('/token', { method: 'POST', internal: true, headers: { authorization: 'Bearer ' + issueToken('fixture-session-key', k8s.user) } })).status, 403);
  const open = await k8s.request('/_wp/preview/open?port=8080&path=%2F', { headers });
  const start = await k8s.request(new URL(open.headers.location).pathname + new URL(open.headers.location).search, { headers: { host: 'preview.example.test' } });
  assert.equal(start.status, 302); assert.equal(seen.length, count);
  const authorizeUrl = new URL(start.headers.location);
  const authorize = await k8s.request(authorizeUrl.pathname + authorizeUrl.search, { headers });
  const redeemUrl = new URL(authorize.headers.location);
  const redeem = await k8s.request(redeemUrl.pathname + redeemUrl.search, { headers: { host: 'preview.example.test', cookie: start.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(redeem.status, 302); assert.equal(seen.length, count);
  const previewCookie = redeem.headers['set-cookie'][0].split(';')[0];
  assert.equal((await k8s.request('/preview-app', { headers: { host: 'preview.example.test', cookie: previewCookie } })).status, 201);
  assert.equal(seen.at(-1).headers.cookie, previewCookie); assert.equal(seen.at(-1).headers.host, 'preview.example.test');
  assert.equal(await upgrade(k8s, 'preview.example.test', previewCookie), 'fixture echo');
  assert.equal((await k8s.request('/preview-app', { headers: { host: 'preview.example.test', cookie: previewCookie, 'x-workpartner-delegated': '1' } })).status, 502);
  for (const route of ['/_wp/market/skills', '/_wp/aionui/feishu/status', '/_wp/feishu/status']) await k8s.request(route, { headers });
  assert.deepEqual(k8s.writes, [], 'a foreign user never prepares or writes through the runtime');
  assign('k8s'); count = seen.length;
  assert.equal((await k8s.request('/_wp/me', { headers })).status, 200);
  assert.equal((await docker.request('/_wp/me', { headers })).status, 200, 'the second gateway delegates to the new owner');
  assert.equal(seen.length, count);
  const connect = await docker.request('/_wp/feishu/connect?return=settings&display=popup', { headers });
  assert.equal(connect.status, 302);
  const state = new URL(connect.headers.location).searchParams.get('state');
  assert.match(state, /^feishu-/);
  const connected = await docker.request('/_wp/callback?state=' + state + '&code=personal', {
    headers: { cookie: cookie + '; ' + connect.headers['set-cookie'][0].split(';')[0] },
  });
  assert.equal(connected.status, 302, connected.body);
  assert.match(connected.headers.location, /feishu\/done\?display=popup$/);
  const desktopHeaders = { authorization: 'Bearer ' + issueToken('fixture-session-key', docker.user) };
  const desktopToken = await docker.request('/_wp/feishu/desktop-token', { method: 'POST', headers: desktopHeaders });
  assert.equal(desktopToken.status, 200, desktopToken.body);
  assert.equal(JSON.parse(desktopToken.body).user_access_token, 'personal-access');
  const desktopStatus = await docker.request('/_wp/feishu/desktop-status', { method: 'POST', headers: desktopHeaders });
  assert.equal(desktopStatus.status, 200); assert.equal(JSON.parse(desktopStatus.body).connected, true);
  assert.equal((await docker.request('/_wp/feishu/desktop-status', { method: 'POST', headers: { authorization: 'Bearer ' + issueToken('wrong-key', docker.user) } })).status, 401);
  assert.equal((await docker.request('/token', { method: 'POST', internal: true, headers: desktopHeaders })).status, 403);
  const before = docker.writes.length;
  await docker.request('/api/example', { headers: { ...headers, 'x-workpartner-delegated': '1' } });
  assert.equal(docker.writes.length, before);
});

test('k8s gateway startup, local entry routes and ownership guards work without Docker and honor extension opt-in', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-migration-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = fixtureOrganization(t);
  org.market.sharedDirectory = path.join(dir, 'shared-skills');
  org.publicHost = 'workspace.example.test'; org.model.baseUrl = 'http://models.example.test/v1';
  for (const key of Object.keys(org.features)) org.features[key] = false;
  Object.assign(org.runtime, { kind: 'k8s', gatewayPort: 0, k8s: { keepRunningIntervalMs: 0 },
    migration: { ownersFile: path.join(dir, 'owners.json') },
    usersFile: path.join(dir, 'users.json'), sessionKeyFile: path.join(dir, 'session.key') });
  org.extensions.gatewayModule = './extension.mjs';
  fs.writeFileSync(path.join(dir, 'extension.mjs'), `export function createGatewayExtension() { globalThis.extensionLoaded = true; return null; }`);
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([{ slug: 'user1', unionId: 'fixture-union', backend: 'aionui' }]));
  fs.writeFileSync(org.runtime.sessionKeyFile, 'fixture-session-key');
  fs.writeFileSync(org.runtime.migration.ownersFile, JSON.stringify({ version: 1, default: 'docker', users: {} }));
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
const fake = 'data:text/javascript,' + encodeURIComponent('export const createRuntime = () => new Proxy({}, { get() { return () => { throw new Error("Unexpected runtime call"); }; } }); export const createLegacyRuntime = () => { throw new Error("Legacy runtime must not be created"); };');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './runtime/index.mjs' && context.parentURL?.endsWith('/gateway/gateway.mjs')) return { url: fake, shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith('/runtime/docker.mjs')) throw new Error('Docker transport must not be imported');
  return next(url, context);
} });
const logs = []; console.error = (...args) => logs.push(args.join(' '));
let server;
http.Server.prototype.listen = function() { server = this; return this; };
await import(${JSON.stringify(pathToFileURL(path.join(root, 'gateway/gateway.mjs')).href)});
assert.equal(globalThis.extensionLoaded, process.env.TEST_EXTENSION === '1' ? true : undefined);
const data = Buffer.from(JSON.stringify({ u: 'fixture-union', n: 'Fixture', e: Date.now() / 1000 + 600 })).toString('base64url');
const cookie = 'wp_sid=' + data + '.' + crypto.createHmac('sha256', 'fixture-session-key').update(data).digest('base64url');
async function request(url, extra = {}, method = 'GET') {
  const req = new PassThrough(); Object.assign(req, { url, method, headers: { host: 'workspace.example.test', cookie, ...extra } });
  const res = new PassThrough(); let status, body = '', headers;
  res.writeHead = (value, fields) => { status = value; headers = fields; }; res.setHeader = () => {};
  res.on('data', chunk => { body += chunk; });
  const done = new Promise(resolve => res.on('end', () => resolve({ status, body, headers })));
  await server.listeners('request')[0](req, res); req.end();
  return done;
}
if (process.env.TEST_PEER) {
  const seen = [];
  http.request = (options, callback) => {
    seen.push(options); const up = new PassThrough(); up.resume();
    queueMicrotask(() => { const reply = new PassThrough(); reply.statusCode = 201; reply.headers = {}; callback(reply); reply.end('peer response'); });
    return up;
  };
  for (const route of ['/_wp/callback?state=feishu-fixture', '/_wp/preparing']) {
    assert.equal((await request(route)).status, 201); assert.equal(seen.at(-1).path, route);
  }
  const tokenData = Buffer.from(JSON.stringify({ u: 'fixture-union', e: Date.now() / 1000 + 600 })).toString('base64url');
  const token = 'zpd.' + tokenData + '.' + crypto.createHmac('sha256', 'fixture-session-key').update('zpd.' + tokenData).digest('base64url');
  for (const route of ['/_wp/feishu/desktop-token', '/_wp/feishu/desktop-status']) {
    assert.equal((await request(route, { cookie: '', authorization: 'Bearer ' + token })).status, 201);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer ' + token);
    assert.equal(seen.at(-1).headers['x-workpartner-delegated'], '1');
  }
  const count = seen.length;
  assert.equal((await request('/_wp/login')).status, 302);
  assert.equal((await request('/_wp/callback?state=login')).status, 200);
  assert.equal((await request('/_wp/preparing', { cookie: '' })).status, 302);
  assert.equal(seen.length, count);
  process.exit(0);
}
if (process.env.TEST_OWNERS_FAILURE) {
  for (const route of ['/', '/_wp/login', '/_wp/callback?state=fixture', '/_wp/callback?state=feishu-fixture', '/_wp/preparing']) {
    const result = await request(route); assert.equal(result.status, 503, route); assert.match(result.body, /工作区迁移中/);
  }
  assert.equal((await request('/', { 'x-workpartner-delegated': '1' })).status, 503);
  assert.ok(logs.some(line => line.includes('Owners file unavailable')), JSON.stringify(logs));
  process.exit(0);
}
for (const route of ['/', '/api/example', '/_wp/market/skills', '/_wp/aionui/feishu/status', '/_wp/preparing']) {
  const result = await request(route); assert.equal(result.status, 503, route); assert.match(result.body, /工作区迁移中/);
}
assert.equal((await request('/', { 'x-workpartner-delegated': '1' })).status, 502);
assert.equal((await request('/_wp/login')).status, 302);
assert.equal((await request('/_wp/logout')).status, 200);
assert.equal((await request('/_wp/callback')).status, 200);
fs.writeFileSync(${JSON.stringify(org.runtime.migration.ownersFile)}, JSON.stringify({ version: 1, default: 'k8s', users: {} }));
assert.equal((await request('/_wp/me')).status, 200);
// The public unknown-route entry must not dispatch the internal prepare handler.
const missing = await request('/unregistered-route', { cookie: '' }, 'POST');
const prepare = await request('/internal/adopt/prepare/user1', { cookie: '' }, 'POST');
assert.notEqual(prepare.status, 204);
assert.equal(prepare.status, missing.status);
assert.equal(prepare.body, missing.body);
`;
  for (const enabled of [false, true]) {
    org.runtime.k8s.loadGatewayExtension = enabled;
    fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
    fs.writeFileSync(org.runtime.migration.ownersFile, JSON.stringify({ version: 1, default: 'docker', users: {} }));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir, TEST_EXTENSION: enabled ? '1' : '0' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
  }
  org.runtime.migration.peerOrigin = 'http://peer.test';
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  fs.writeFileSync(org.runtime.migration.ownersFile, JSON.stringify({ version: 1, default: 'docker', users: {} }));
  const peerResult = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir, TEST_EXTENSION: '1', TEST_PEER: '1' },
  });
  assert.equal(peerResult.status, 0, peerResult.stdout + peerResult.stderr + (peerResult.error?.message || ''));
  for (const invalid of [false, true]) {
    if (invalid) fs.writeFileSync(org.runtime.migration.ownersFile, '{broken');
    else fs.unlinkSync(org.runtime.migration.ownersFile);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir, TEST_EXTENSION: '1', TEST_OWNERS_FAILURE: '1' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
  }
});

test('configured missing or invalid ownership returns 503 without provisioning or runtime writes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-owners-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const invalid of [false, true]) {
    const ownersFile = path.join(dir, invalid ? 'invalid.json' : 'missing.json');
    if (invalid) fs.writeFileSync(ownersFile, '{broken');
    const gateway = await migrationGateway(t, { kind: 'k8s', ownersFile, peerOrigin: 'http://peer.invalid' });
    for (const route of ['/', '/_wp/login', '/_wp/callback?state=fixture&code=fixture', '/_wp/callback?state=feishu-fixture', '/_wp/preparing']) {
      const response = await gateway.request(route);
      assert.equal(response.status, 503, route); assert.match(response.body, /工作区迁移中/);
    }
    const token = await gateway.request('/token', { method: 'POST', internal: true,
      headers: { authorization: 'Bearer ' + issueToken('fixture-session-key', gateway.user) } });
    assert.equal(token.status, 503);
    assert.deepEqual(gateway.writes, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(gateway.org.runtime.usersFile)), [gateway.user]);
    assert.match(gateway.output(), /Owners file unavailable/);
  }
});

test('without migration forwarding, previews, internal tokens and keep-running preserve main behavior', async t => {
  const { createAionui } = await import('../gateway/aionui.mjs');
  const f = await fixture(t);
  assert.equal(f.org.runtime.migration, undefined);
  const cookie = await f.login(), headers = { cookie, 'x-workpartner-delegated': '1' };
  const page = await f.request('/api/example', { headers });
  assert.equal(page.status, 200); assert.equal(page.body, 'workspace response');
  assert.equal(f.upstreamHits.at(-1).path, '/api/example');
  assert.equal((await f.request('/app', { headers: { host: 'preview.example.test' } })).status, 401);
  const open = await f.request('/_wp/preview/open?port=8080&path=%2F', { headers });
  assert.equal(open.status, 302); assert.equal(new URL(open.headers.location).host, 'preview.example.test');
  assert.ok(fs.existsSync(path.join(f.org.runtime.nextDirectory, 'user1/.zp-preview-relay-key')));
  const connect = await f.request('/_wp/feishu/connect', { headers });
  const state = new URL(connect.headers.location).searchParams.get('state');
  const callback = await f.request('/_wp/callback?code=personal&state=' + state,
    { headers: { cookie: cookie + '; ' + connect.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(callback.status, 302);
  const token = await f.request('/token', { method: 'POST', internal: true,
    headers: { authorization: 'Bearer ' + issueToken('fixture-session-key', f.user) } });
  assert.equal(token.status, 200); assert.equal(JSON.parse(token.body).user_access_token, 'fixture-access');
  let inspections = 0;
  for (const kind of [undefined, 'docker']) {
    const aionui = createAionui({ kind, runtime: { async inspect() { inspections++; return { exists: true, running: false }; },
      async start() { assert.fail('Docker must not run the keep-running worker'); } } });
    t.after(() => aionui.close());
    await aionui.keepRunning(() => [f.user]); aionui.startKeepRunning(() => [f.user], 1);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(inspections, 0, 'Docker inspect fields may be undefined and no keep-running timer starts');
});
