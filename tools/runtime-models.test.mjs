/** Change organization defaults while keeping the prepared image inputs unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = process.env.WORKPARTNER_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
const organizationRoot = path.join(root, 'gateway/organization');
const imageRoot = path.join(root, 'image');
const gatewayRoot = path.join(root, 'gateway');
const { organizationData, nextModelConfig, nextEnvironment } = await import(pathToFileURL(path.join(organizationRoot, 'resolve.mjs')));
const { materializeNext } = await import(pathToFileURL(path.join(organizationRoot, 'materialize-next.mjs')));
const { createAionui } = await import(pathToFileURL(path.join(gatewayRoot, 'aionui.mjs')));

test('editing only JSON replaces an idle container on the same image and supplies new runtime defaults', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const orgDir = path.join(dir, 'org');
  fs.mkdirSync(orgDir);
  const file = path.join(orgDir, 'organization.json');
  fs.writeFileSync(file, '{}');
  const selection = { WORKPARTNER_ORG_DIR: orgDir };
  const config = () => nextModelConfig(organizationData(selection));
  const initial = config();
  const context = path.join(dir, 'context');
  const image = 'image';
  fs.mkdirSync(path.join(context, image, 'bin'), { recursive: true });
  fs.cpSync(path.join(imageRoot, 'home'), path.join(context, image, 'home'), { recursive: true });
  materializeNext(context, {});
  fs.cpSync(path.join(imageRoot, 'bin'), path.join(context, image, 'bin'), { recursive: true });
  fs.cpSync(path.join(imageRoot, 'agent-baseline'), path.join(context, image, 'agent-baseline'), { recursive: true });
  fs.mkdirSync(path.join(context, image, 'skills'));
  const template = path.join(context, image, 'home/codex-config.toml');
  const originalTemplate = fs.readFileSync(template, 'utf8');
  assert.match(originalTemplate, /gpt-6.1-sol/);

  let busy = false;
  const clients = new Map();
  const assistants = [
    { id: 'bare:codex', agent_id: 'codex', source: 'generated', enabled: true },
    { id: 'bare:claude', agent_id: 'claude', source: 'generated', enabled: true },
  ];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    let result = {};
    if (req.url === '/api/conversations?limit=10000') result = { items: [{ id: 'active', status: 'running' }] };
    if (req.url === '/api/conversations/active') result = { runtime: { is_processing: busy } };
    if (req.url === '/api/agents/management') result = ['codex', 'claude'].map(backend => ({ id: backend, backend, installed: true }));
    if (req.url === '/api/assistants') result = assistants;
    if (req.url === '/v1/models') result = { data: [{ id: 'custom-codex' }, { id: 'claude-custom' }] };
    if (req.url === '/api/settings/client') {
      if (req.method === 'PUT') Object.entries(data).forEach(([key, value]) => clients.set(key, value));
      result = Object.fromEntries(clients);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const secure = path.join(dir, 'secure');
  fs.mkdirSync(secure);
  fs.writeFileSync(path.join(secure, 'model-person.key'), 'fixture');
  fs.writeFileSync(path.join(secure, 'aionui-person.pass'), 'fixture');
  const calls = [];
  const state = { exists: true, running: true, env: ['WORKPARTNER_MODEL_CONFIG=' + JSON.stringify(initial)] };
  const docker = async (method, url, body) => {
    calls.push({ method, url, body });
    let data = {}, status = 200;
    if (url.startsWith('/images/')) data = { Id: 'unchanged-image-id' };
    else if (url.startsWith('/networks/')) data = { Containers: { gateway: { Name: 'gateway' } } };
    else if (method === 'GET' && url.endsWith('/json')) data = {
      Config: { Image: 'same-image', Env: state.env }, Image: 'unchanged-image-id', State: { Running: state.running },
      NetworkSettings: { Networks: { 'fixture-person-net': { IPAddress: '127.0.0.1' } } },
    };
    else if (url.includes('/top?')) data = { Titles: ['PID', 'PPID', 'COMMAND'], Processes: [] };
    else if (method === 'DELETE') state.exists = false;
    else if (url.startsWith('/containers/create?')) { state.exists = true; state.env = body.Env; status = 201; }
    else if (url.endsWith('/start')) { state.running = true; status = 204; }
    else if (url.includes('/stop?')) { state.running = false; status = 204; }
    else throw new Error(`Unexpected request ${method} ${url}`);
    return { status, body: Buffer.from(JSON.stringify(data)) };
  };
  const aionui = createAionui({ docker, modelConfig: config, image: 'same-image', self: 'gateway',
    containerPrefix: 'fixture-', port: server.address().port, uid: process.getuid(),
    keyPrefix: 'model-', secureDir: secure, secretDir: secure, hostSecure: secure,
    dataDir: path.join(dir, 'next-data'), hostData: '/fixture-data', modelBaseUrl: base + '/v1',
    busyRecheckMs: 0, log() {},
  });
  const user = { slug: 'person', name: 'Fixture' };
  assert.ok(await aionui.upstream(user));
  assert.equal(calls.some(call => call.method === 'DELETE'), false);

  const updated = { codex: 'custom-codex', claude: 'claude-custom', opus: 'claude-opus-custom',
    sonnet: 'claude-sonnet-custom', haiku: 'claude-haiku-custom', effort: 'high' };
  fs.writeFileSync(file, JSON.stringify({ model: { defaults: updated } }));
  busy = true;
  assert.ok(await aionui.upstream(user));
  assert.equal(calls.some(call => call.method === 'DELETE'), false, 'busy conversations keep their container');
  busy = false;
  assert.equal(await aionui.upstream(user), null);
  await aionui.pending('person');
  const created = calls.find(call => call.url.startsWith('/containers/create?')).body;
  assert.equal(created.Image, 'same-image');
  const injected = Object.fromEntries(created.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  assert.equal(JSON.parse(injected.WORKPARTNER_MODEL_CONFIG).defaults.codex, updated.codex);
  assert.ok(await aionui.upstream(user));
  assert.equal(calls.filter(call => call.url.startsWith('/containers/create?')).length, 1, 'matching config is idempotent');

  const embedded = organizationData({ WORKPARTNER_ORG_DIR: path.join(context, 'organization/selected') });
  const environment = nextEnvironment(embedded, { ...injected, MODEL_BASE_URL: base + '/v1' });
  assert.equal(environment.ANTHROPIC_MODEL, updated.claude);
  assert.equal(environment.ANTHROPIC_DEFAULT_OPUS_MODEL, updated.opus);
  assert.equal(environment.ANTHROPIC_DEFAULT_SONNET_MODEL, updated.sonnet);
  assert.equal(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, updated.haiku);
  const runtimeConfig = JSON.parse(environment.WORKPARTNER_MODEL_CONFIG);
  assert.equal(runtimeConfig.catalog.codex[0].id, updated.codex);
  assert.equal(runtimeConfig.catalog.claude[0].id, updated.claude);
  assert.equal(nextEnvironment(embedded, { MODEL_BASE_URL: base + '/v1' }).ANTHROPIC_MODEL, initial.defaults.claude, 'image organization is the fallback');
  assert.throws(() => nextEnvironment(embedded, { MODEL_BASE_URL: base + '/v1', WORKPARTNER_MODEL_CONFIG: '{broken' }), SyntaxError);

  function initialize(data, variables) {
    fs.mkdirSync(path.join(data, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(data, '.codex/skills'), { recursive: true });
    let shell = fs.readFileSync(path.join(imageRoot, 'bin/start.sh'), 'utf8');
    shell = shell.slice(shell.indexOf('# Follow organization defaults'), shell.indexOf('# 首次写整份说明；'));
    shell = shell.replaceAll('/opt/workpartner', path.join(context, image)).replaceAll('/opt/workpartner', path.join(context, image)).replaceAll('/data', data);
    const result = spawnSync('bash', ['-euc', shell], { encoding: 'utf8', env: { ...process.env, ...variables, CODEX_HOME: path.join(data, '.codex') } });
    assert.equal(result.status, 0, result.stderr);
    return { codex: fs.readFileSync(path.join(data, '.codex/config.toml'), 'utf8'), claude: fs.readFileSync(path.join(data, '.claude/settings.json'), 'utf8') };
  }
  const fresh = path.join(dir, 'fresh');
  const first = initialize(fresh, environment);
  assert.match(first.codex, /^model = "custom-codex"$/m);
  assert.match(first.codex, /^model_reasoning_effort = "high"$/m);
  assert.equal(JSON.parse(first.claude).model, updated.claude);
  assert.deepEqual(initialize(fresh, environment), first, 'restart keeps the same defaults');
  const changed = initialize(fresh, nextEnvironment(embedded, { MODEL_BASE_URL: base + '/v1' }));
  assert.equal(JSON.parse(changed.claude).model, initial.defaults.claude);
  assert.match(changed.codex, new RegExp('^model = "' + initial.defaults.codex + '"$', 'm'));
  initialize(fresh, environment);
  assert.equal(fs.readFileSync(template, 'utf8'), originalTemplate, 'no template rebuild');

  const seed = fs.readFileSync(path.join(imageRoot, 'bin/wp-seed.py'), 'utf8').replaceAll('/data', fresh);
  const child = spawn('python3', ['-I', '-c', seed, base], { env: {
    ...process.env, ...environment, CODEX_HOME: path.join(fresh, '.codex'), ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'fixture',
  } });
  const errors = [];
  child.stderr.on('data', chunk => errors.push(chunk));
  const timeout = setTimeout(() => child.kill(), 10000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill(); });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timeout);
  assert.equal(status, 0, Buffer.concat(errors).toString());
  assert.deepEqual(clients.get('wp.modelConfig'), runtimeConfig);
  assert.deepEqual(clients.get('wp.engineModels'), { codex: updated.codex, claude: updated.claude });
  assert.ok(fs.existsSync(path.join(fresh, '.wp-seed-v2')));
});
