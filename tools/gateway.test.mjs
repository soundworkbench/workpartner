/** Run the exported gateway, including optional services, against local HTTP fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { organizationData, nextModelConfig } from '../gateway/organization/resolve.mjs';
import { issueToken, tokenUser } from '../gateway/market-auth.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, { disabled = false, extension = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-services-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = organizationData({});
  org.publicHost = 'workspace.example.test';
  org.model.baseUrl = 'http://models.example.test/v1';
  org.features.feishuAuthorization = true;
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
    if (req.url.startsWith('/containers/')) return res.end(JSON.stringify({ Config: { Image: 'fixture-image', Env: ['WORKPARTNER_MODEL_CONFIG=' + JSON.stringify(nextModelConfig(org))] }, Image: 'sha256:fixture', State: { Running: true }, NetworkSettings: { Networks: { 'workpartner-next-user1-net': { IPAddress: '127.0.0.1' } } } }));
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
  assert.equal(title.body, '{"changed":true}');
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
