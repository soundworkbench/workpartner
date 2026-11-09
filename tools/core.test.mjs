/** Exercise the exported gateway process; external identity and Docker use local fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { organizationData } from '../gateway/organization/resolve.mjs';
import { materializeAppearance } from '../gateway/organization/materialize-appearance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function seedModels(ids) {
  const result = spawnSync('python3', ['-I', '-c', `
import ast, json, sys
from pathlib import Path
source = Path(sys.argv[1])
tree = ast.parse(source.read_text())
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'model_names']
scope = {}
exec(compile(ast.Module(functions, []), str(source), 'exec'), scope)
print(json.dumps(sorted({name for model in json.load(sys.stdin) for name in scope['model_names'](model)})))
`, path.join(root, 'image/bin/wp-seed.py')], { input: JSON.stringify(ids), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function modelPicker(t, permissions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-picker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const org = organizationData({});
  Object.assign(org.model.defaults, { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5-5' });
  materializeAppearance(dir, org);
  const overlay = fs.readFileSync(path.join(root, 'image/rebrand/overlay/wp-overlay.js'), 'utf8')
    .replace('  /* __WP_COPY__ */', fs.readFileSync(path.join(dir, 'copy.js'), 'utf8'))
    .replace('  /* __WP_MODEL_CATALOG__ */', fs.readFileSync(path.join(dir, 'models.js'), 'utf8'));
  const window = new EventTarget();
  const fetch = async () => ({ json: async () => ({ data: { 'wp.models': permissions } }) });
  window.fetch = fetch;
  window.WpSmoothText = { SmoothText: class {}, protectedLines: () => [], repairStreamingMarkdown: s => s };
  const context = vm.createContext({ window, fetch, Event,
    document: { body: {}, documentElement: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    location: { hash: '#/guid' }, innerWidth: 320, localStorage: { getItem: () => null },
    MutationObserver: class { observe() {} }, requestAnimationFrame() {},
    setTimeout() {}, clearTimeout() {}, setInterval() {},
  });
  const end = overlay.lastIndexOf('})();');
  assert.ok(end > 0);
  vm.runInContext(overlay.slice(0, end) + 'window.picker = { modelsFor, MODELS };' + overlay.slice(end), context);
  await new Promise(resolve => setImmediate(resolve));
  return window.picker;
}

test('prefixed model permissions retain both default models and exclude unavailable models', async t => {
  for (const [codex, claude] of [
    ['codex/gpt-6.1-sol', 'claude/claude-sonnet-5-5'],
    ['group/gpt-6.1-sol', 'group/claude-sonnet-5-5'],
    ['auto/gpt-6.1-sol', 'auto/claude-sonnet-5-5'],
    ['mp-codex/gpt-6.1-sol', 'mp-q/claude/claude-sonnet-5-5'],
    ['provider/gpt-6.1-sol', 'provider/claude-sonnet-5-5'],
  ]) await t.test(codex, async t => {
    const picker = await modelPicker(t, seedModels([codex, claude]));
    picker.MODELS.codex.push({ id: 'gpt-6.1-terra', key: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' });
    picker.MODELS.claude.push({ id: 'claude-haiku-5-5', key: 'claude-haiku-5-5', name: 'Haiku 5.5' });
    assert.deepEqual(Array.from(picker.modelsFor('codex'), m => m.id), ['gpt-6.1-sol']);
    assert.deepEqual(Array.from(picker.modelsFor('claude'), m => m.id), ['claude-sonnet-5-5']);
    assert.equal(picker.modelsFor('codex', ['default'])[0].value, 'default');
    assert.equal(picker.modelsFor('claude', ['default'])[0].value, 'default');
  });
});

test('empty permission matches restore the available catalog even with a current model', async t => {
  for (const permissions of [[], ['provider/unknown-model']]) {
    const picker = await modelPicker(t, permissions);
    picker.MODELS.codex.push({ id: 'gpt-6.1-terra', key: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' });
    picker.MODELS.claude.push({ id: 'claude-haiku-5-5', key: 'claude-haiku-5-5', name: 'Haiku 5.5' });
    assert.deepEqual(Array.from(picker.modelsFor('codex', null, 'gpt-6.1-terra'), m => m.id), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    assert.deepEqual(Array.from(picker.modelsFor('claude', null, 'claude-haiku-5-5'), m => m.id), ['claude-sonnet-5-5', 'claude-haiku-5-5']);
    assert.deepEqual(Array.from(picker.modelsFor('codex', ['default'], 'custom-current'), m => m.value), ['custom-current', 'default']);
  }
});

test('neutral image inputs assemble without a private organization', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-image-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'image'), path.join(dir, 'image'), { recursive: true });
  const built = spawnSync(process.execPath, [path.join(root, 'gateway/organization/materialize-next.mjs'), dir], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(built.status, 0, built.stderr);
  const selected = JSON.parse(fs.readFileSync(path.join(dir, 'organization/selected/organization.json')));
  assert.equal(selected.organizationId, 'default');
  assert.deepEqual(selected.image.skills, []);
  assert.equal(selected.bridge.template, '');
  assert.ok(fs.existsSync(path.join(dir, 'brand/skin.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'image/bin/legacy-instructions.json'))), []);
});

test('selected model defaults reach both engine templates and the browser catalog', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-defaults-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgDir = path.join(dir, 'org');
  fs.cpSync(path.join(root, 'org/default'), orgDir, { recursive: true });
  const file = path.join(orgDir, 'organization.json');
  const org = JSON.parse(fs.readFileSync(file));
  Object.assign(org.model.defaults, { codex: 'gpt-6.1-sol', claude: 'claude-custom', effort: 'high' });
  fs.writeFileSync(file, JSON.stringify(org));
  const context = path.join(dir, 'context');
  fs.cpSync(path.join(root, 'image'), path.join(context, 'image'), { recursive: true });
  const built = spawnSync(process.execPath, [path.join(root, 'gateway/organization/materialize-next.mjs'), context],
    { encoding: 'utf8', env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: orgDir } });
  assert.equal(built.status, 0, built.stderr);
  const codex = fs.readFileSync(path.join(context, 'image/home/codex-config.toml'), 'utf8');
  assert.match(codex, /^model = "gpt-6.1-sol"$/m);
  assert.match(codex, /^model_reasoning_effort = "high"$/m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(context, 'image/home/claude-settings.json'))),
    { model: 'claude-custom', effortLevel: 'high' });
  const catalog = vm.runInNewContext(fs.readFileSync(path.join(context, 'brand/models.js'), 'utf8') + '\nMODELS', { window: {} });
  assert.equal(catalog.codex[0].id, 'gpt-6.1-sol');
  assert.equal(catalog.claude[0].id, 'claude-custom');
  const runtime = spawnSync(process.execPath, [path.join(context, 'organization/resolve.mjs'), 'next-env'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: path.join(context, 'organization/selected'), MODEL_BASE_URL: 'https://models.example.test/v1' } });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(runtime.stdout, /export ANTHROPIC_MODEL='claude-custom'/);
});

test('gateway login, session isolation, personal routing, caching and logout', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hits = [];
  const upstream = http.createServer((req, res) => {
    if (req.url === '/login') { res.writeHead(200, { 'set-cookie': 'aionui-session=fixture; HttpOnly' }); return res.end('{}'); }
    hits.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'upstream-cookie=fixture' });
    res.end('workspace response');
  });
  const docker = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/containers/')) return res.end(JSON.stringify({ Config: { Image: 'fixture-image' }, Image: 'sha256:fixture', State: { Running: true }, NetworkSettings: { Networks: { 'workpartner-next-user1-net': { IPAddress: '127.0.0.1' } } } }));
    if (req.url.startsWith('/images/')) return res.end('{"Id":"sha256:fixture"}');
    if (req.url.endsWith('/connect')) return res.end('{}');
    if (req.url.startsWith('/networks/')) return res.end('{"Containers":{}}');
    res.writeHead(500); res.end('{}');
  });
  for (const server of [upstream, docker]) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  }
  const org = organizationData({});
  org.publicHost = 'workspace.example.test'; org.model.baseUrl = 'http://models.example.test/v1';
  Object.assign(org.runtime, { gatewayPort: 0, uid: process.getuid(), nextImage: 'fixture-image', nextPort: upstream.address().port,
    sessionKeyFile: path.join(dir, 'session.key'), usersFile: path.join(dir, 'users.json'), cookieFile: path.join(dir, 'cookies.json'), secureDirectory: path.join(dir, 'secure') });
  org.identity.appId = 'fixture-app'; org.identity.appSecretFile = path.join(dir, 'identity.secret');
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  fs.writeFileSync(org.runtime.sessionKeyFile, 'fixture-session-secret');
  fs.writeFileSync(org.identity.appSecretFile, 'fixture-app-secret');
  fs.mkdirSync(path.join(dir, 'secure/aionui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secure/aionui/aionui-user1.pass'), 'fixture-password');
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([{ slug: 'user1', unionId: 'fixture-union', name: 'Fixture user', backend: 'aionui' }]));
  fs.writeFileSync(path.join(dir, 'transport.mjs'), `
import http from 'node:http';
const request = http.request;
http.request = (options, ...rest) => request.call(http, options.socketPath ? { ...options, socketPath: undefined, host: '127.0.0.1', port: ${docker.address().port} } : options, ...rest);
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(...args) { if (typeof args.at(-1) === 'function') this.once('listening', () => process.send({ port: this.address().port })); return listen.apply(this, args); };
globalThis.fetch = async url => {
  if (String(url).endsWith('/authen/v2/oauth/token')) return { json: async () => ({ access_token: 'fixture-access' }) };
  if (String(url).endsWith('/authen/v1/user_info')) return { json: async () => ({ code: 0, data: { union_id: 'fixture-union', name: 'Fixture user' } }) };
  throw new Error('Unexpected outbound request');
};
`);
  const child = fork(path.join(root, 'gateway/gateway.mjs'), [], { execArgv: ['--import', path.join(dir, 'transport.mjs')], env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: dir }, silent: true });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + output)), 10000);
    child.once('message', msg => { clearTimeout(timer); resolve(msg.port); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Gateway exited ' + code + ': ' + output)); });
  });
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers: { host: org.publicHost, ...headers } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  assert.equal((await get('/_wp/me')).status, 401);
  assert.equal((await get('/api/private')).status, 401);
  const login = await get('/_wp/login');
  const auth = new URL(login.headers.location);
  assert.equal(auth.searchParams.get('client_id'), 'fixture-app');
  const callback = await get('/_wp/callback?code=fixture&state=' + auth.searchParams.get('state'), { cookie: login.headers['set-cookie'][0].split(';')[0] });
  assert.equal(callback.status, 302);
  const cookie = callback.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get('/_wp/me', { cookie })).status, 200);
  const first = await get('/assets/app.js', { cookie });
  assert.equal(first.body, 'workspace response', output);
  assert.equal(first.headers['set-cookie'], undefined);
  assert.equal(hits[0].cookie, 'aionui-session=fixture');
  assert.equal((await get('/assets/app.js', { cookie, 'if-none-match': first.headers.etag })).status, 304);
  const logout = await get('/_wp/logout', { cookie });
  assert.match(logout.body, /已退出登录/);
  assert.equal((await get('/_wp/me', { cookie: logout.headers['set-cookie'][0].split(';')[0] })).status, 401);
});
