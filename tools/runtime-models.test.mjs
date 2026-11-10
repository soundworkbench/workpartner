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
const { createDockerRuntime } = await import(pathToFileURL(path.join(gatewayRoot, 'runtime/docker.mjs')));
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
    else if (method === 'DELETE') { state.exists = false; status = 204; }
    else if (url.startsWith('/containers/create?')) { state.exists = true; state.env = body.Env; status = 201; }
    else if (url.endsWith('/start')) { state.running = true; status = 204; }
    else if (url.includes('/stop?')) { state.running = false; status = 204; }
    else throw new Error(`Unexpected request ${method} ${url}`);
    return { status, body: Buffer.from(JSON.stringify(data)) };
  };
  const options = { docker, modelConfig: config, image: 'same-image', self: 'gateway',
    containerPrefix: 'fixture-', port: server.address().port, uid: process.getuid(),
    keyPrefix: 'model-', secureDir: secure, secretDir: secure, hostSecure: secure,
    dataDir: path.join(dir, 'next-data'), hostData: '/fixture-data', modelBaseUrl: base + '/v1',
    busyRecheckMs: 0, log() {},
  };
  const aionui = createAionui({ ...options, runtime: createDockerRuntime(options) });
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

test('runtime selection rejects unknown kinds and defaults to Docker', async () => {
  const { createRuntime } = await import('../gateway/runtime/index.mjs');
  for (const kind of ['unknown', '', null, false]) assert.throws(() => createRuntime({ runtime: { kind } }), /Unsupported runtime kind/);
  assert.equal(typeof createRuntime({ runtime: {}, model: {} }).inspect, 'function');
});

test('Docker runtime preserves personal container and isolation parameters', async t => {
  const { createDockerRuntime } = await import('../gateway/runtime/docker.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'secure'));
  fs.writeFileSync(path.join(dir, 'secure/model-person.key'), 'fixture');
  fs.mkdirSync(path.join(dir, 'users/person/work'), { recursive: true });
  const calls = [];
  let network = false;
  const runtime = createDockerRuntime({
    docker: async (method, route, body) => {
      calls.push({ method, route, body });
      if (route === '/networks/fixture-person-net') return { status: network ? 200 : 404, body: JSON.stringify({ Containers: {} }) };
      if (route === '/networks/create') { network = true; return { status: 201 }; }
      return { status: route.startsWith('/containers/create') ? 201 : 200 };
    },
    image: 'fixture-image', uid: 1001, containerPrefix: 'fixture-', self: 'gateway', modelContainer: 'model',
    keyPrefix: 'model-', secureDir: path.join(dir, 'secure'), hostSecure: '/secure-host',
    dataDir: path.join(dir, 'next'), hostData: '/data-host/next', usersDir: path.join(dir, 'users'), hostUsers: '/data-host/users',
    memory: 4294967296, nanoCpus: 2000000000, pidsLimit: 512, modelBaseUrl: 'http://model/v1',
  });
  await runtime.ensureIsolation('person');
  await runtime.create({ slug: 'person', name: 'Fixture' }, { modelConfig: '{"defaults":{}}' });
  const networkBody = calls.find(c => c.route === '/networks/create').body;
  assert.deepEqual(networkBody, { Name: 'fixture-person-net', Driver: 'bridge', CheckDuplicate: true, EnableIPv6: false,
    Options: { 'com.docker.network.bridge.name': 'wpn-cd288fb1989' }, Labels: { 'workpartner.next-user': 'person' } });
  assert.deepEqual(calls.filter(c => c.route.endsWith('/connect')).map(c => c.body), [{ Container: 'gateway' }, { Container: 'model' }]);
  assert.deepEqual(calls.find(c => c.route.startsWith('/containers/create')).body, {
    Image: 'fixture-image', User: '1001:1001', Hostname: 'fixture-person',
    Env: ['MODEL_BASE_URL=http://model/v1', 'PARTNER_USER_NAME=Fixture', 'WORKPARTNER_MODEL_CONFIG={"defaults":{}}'],
    Labels: { 'workpartner.next-user': 'person' },
    HostConfig: { Binds: ['/data-host/next/person:/data', '/secure-host/model-person.key:/etc/partner/model.key:ro', '/data-host/users/person/work:/data/old-work:ro'],
      NetworkMode: 'fixture-person-net', RestartPolicy: { Name: 'unless-stopped' }, Memory: 4294967296, NanoCpus: 2000000000, PidsLimit: 512 },
  });
  const stat = fs.statSync(path.join(dir, 'next/person'));
  assert.equal(stat.uid, 1001); assert.equal(stat.gid, 1001);
});

test('runtime files preserve owner and modes and refuse symlink directories', async t => {
  const { createDockerRuntime } = await import('../gateway/runtime/docker.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createDockerRuntime({ dataDir: dir, uid: 1001 });
  await runtime.putFiles('person', [{ path: '.identity', content: 'token\n', mode: 0o600 }], { directoryMode: 0o700 });
  assert.equal(await runtime.readFile('person', '.identity'), 'token\n');
  const stat = fs.statSync(path.join(dir, 'person/.identity'));
  assert.equal(stat.uid, 1001); assert.equal(stat.gid, 1001); assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'person')).mode & 0o777, 0o700);
  fs.symlinkSync(dir, path.join(dir, 'person/link'));
  await assert.rejects(runtime.putFiles('person', [{ path: 'link/escape', content: 'bad' }]));
  await assert.rejects(runtime.putFiles('person', [{ path: '../escape', content: 'bad' }]));
  await runtime.removeFiles('person', ['.identity']);
  await assert.rejects(runtime.readFile('person', '.identity'), { code: 'ENOENT' });
});

test('runtime exec returns the exit code and separate output streams', async () => {
  const { createDockerRuntime } = await import('../gateway/runtime/docker.mjs');
  const frame = (type, value) => { const b = Buffer.alloc(8); b[0] = type; b.writeUInt32BE(Buffer.byteLength(value), 4); return Buffer.concat([b, Buffer.from(value)]); };
  const calls = [];
  const runtime = createDockerRuntime({ containerPrefix: 'fixture-', docker: async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.endsWith('/exec')) return { status: 201, body: '{"Id":"job"}' };
    if (route.endsWith('/start')) return { status: 200, body: Buffer.concat([frame(1, 'out'), frame(2, 'err')]) };
    return { status: 200, body: '{"ExitCode":7}' };
  } });
  assert.deepEqual(await runtime.exec('person', ['false'], { env: ['HOME=/data'], user: '1001' }), { exitCode: 7, stdout: 'out', stderr: 'err', logs: 'outerr' });
  assert.equal(calls[0].route, '/containers/fixture-person/exec');
  assert.deepEqual(calls[0].body, { User: '1001', Env: ['HOME=/data'], AttachStdout: true, AttachStderr: true, Cmd: ['false'] });
  await runtime.execNamed('provisioner', ['list']);
  assert.equal(calls[3].route, '/containers/provisioner/exec');
  assert.deepEqual(await runtime.exec('person', ['worker'], { detached: true }), { exitCode: null, stdout: '', stderr: '', logs: '' });
});

test('runtime inspect and address distinguish missing, stopped and running containers', async () => {
  let missing = true, running = false, address = '';
  const runtime = createDockerRuntime({ containerPrefix: 'fixture-', port: 25808, docker: async (method, route) => {
    if (route.startsWith('/images/')) return { status: 404, body: '{}' };
    return { status: missing ? 404 : 200, body: JSON.stringify({ Config: { Image: 'image', Env: ['A=B'] }, Image: 'sha256:old',
      State: { Running: running }, NetworkSettings: { Networks: { 'fixture-person-net': { IPAddress: address } } } }) };
  } });
  assert.deepEqual(await runtime.inspect('person'), { exists: false, running: false, image: null, imageId: null, address: null });
  missing = false;
  assert.deepEqual(await runtime.inspect('person'), { exists: true, running: false, image: 'image', imageId: 'sha256:old', env: ['A=B'], name: 'fixture-person', address: null });
  running = true; address = 'personal-endpoint';
  assert.deepEqual((await runtime.inspect('person')).address, { host: 'personal-endpoint', port: 25808 });
  assert.deepEqual(await runtime.address('person', 9000), { host: 'personal-endpoint', port: 9000 });
  assert.equal(await runtime.imageId('missing-image'), null);
});

test('AionUi replaces changed image names and IDs but retains containers when target lookup fails', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-stale-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'aionui-person.pass'), 'fixture');
  for (const [image, imageId, target, replace] of [
    ['old', 'old-id', 'new-id', true], ['same', 'old-id', 'new-id', true],
    ['same', 'same-id', 'same-id', false], ['same', 'old-id', null, false], ['same', 'old-id', new Error('unavailable'), false],
  ]) {
    const calls = [];
    const runtime = {
      inspect: async () => ({ exists: true, running: false, image, imageId, address: null, env: [] }),
      imageId: async () => { if (target instanceof Error) throw target; return target; },
      ensureIsolation: async slug => calls.push(['isolation', slug]),
      remove: async slug => calls.push(['remove', slug]),
      create: async user => calls.push(['create', user.slug]),
      start: async slug => calls.push(['start', slug]), address: async () => null,
    };
    const aionui = createAionui({ runtime, image: 'same', secretDir: dir, log() {} });
    assert.equal(await aionui.upstream({ slug: 'person' }), null);
    await aionui.pending('person');
    assert.deepEqual(calls, [['isolation', 'person'], ...(replace ? [['remove', 'person'], ['create', 'person']] : []), ['start', 'person']]);
  }
});

test('runtime file operations preserve atomic replacement, nested modes and cleanup with the current owner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createDockerRuntime({ dataDir: dir, uid: process.getuid() });
  await runtime.putFiles('person', [{ path: 'token', content: 'first', mode: 0o600 }]);
  const outside = path.join(dir, 'outside');
  fs.writeFileSync(outside, 'unchanged');
  fs.unlinkSync(path.join(dir, 'person/token'));
  fs.symlinkSync(outside, path.join(dir, 'person/token'));
  await runtime.putFiles('person', [{ path: 'token', content: 'second', mode: 0o600 }]);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  assert.equal(await runtime.readFile('person', 'token'), 'second');
  assert.equal(fs.lstatSync(path.join(dir, 'person/token')).isSymbolicLink(), false);
  await runtime.putFiles('person', [{ path: '.wp-skill-uploads/install-fixture/SKILL.md', content: 'skill', mode: 0o600 }], {
    create: false, chown: false, directories: [{ path: '.wp-skill-uploads', mode: 0o711, owner: false }],
  });
  assert.equal(fs.statSync(path.join(dir, 'person/.wp-skill-uploads')).mode & 0o777, 0o711);
  assert.equal(fs.statSync(path.join(dir, 'person/.wp-skill-uploads/install-fixture')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'person/.wp-skill-uploads/install-fixture/SKILL.md')).mode & 0o777, 0o600);
  await runtime.removeFiles('person', ['.wp-skill-uploads/install-fixture']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'person/.wp-skill-uploads')), []);
  fs.symlinkSync(dir, path.join(dir, 'person/link'));
  for (const filename of ['../outside', '/outside', 'link/outside']) {
    await assert.rejects(runtime.putFiles('person', [{ path: filename, content: 'bad' }]));
    await assert.rejects(runtime.readFile('person', filename));
    await assert.rejects(runtime.removeFiles('person', [filename]));
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
});

test('runtime one-shot jobs retain reset parameters and remove the helper on success and timeout', async () => {
  for (const timeout of [false, true]) {
    const calls = [];
    const runtime = createDockerRuntime({ containerPrefix: 'fixture-', uid: 1001, image: 'image', hostData: '/data-host', docker: async (method, route, body) => {
      calls.push({ method, route, body });
      if (route.includes('/create?')) return { status: 201 };
      if (route.endsWith('/start')) return { status: 204 };
      if (route.endsWith('/wait')) return timeout ? new Promise(() => {}) : { status: 200, body: '{"StatusCode":3}' };
      if (route.includes('/logs?')) { const text = Buffer.from('new password: fixture'); const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(text.length, 4); return { status: 200, body: Buffer.concat([header, text]) }; }
      return { status: 204 };
    } });
    const job = runtime.runOnce('person', { entrypoint: ['/opt/aionui/aionui-web'], cmd: ['resetpass', '--data-dir', '/data/aionui-data'], timeoutMs: 5 });
    if (timeout) await assert.rejects(job, /timed out/);
    else assert.deepEqual(await job, { exitCode: 3, logs: 'new password: fixture' });
    assert.deepEqual(calls[1], { method: 'POST', route: '/containers/create?name=fixture-person-resetpass', body: {
      Image: 'image', User: '1001:1001', Entrypoint: ['/opt/aionui/aionui-web'], Cmd: ['resetpass', '--data-dir', '/data/aionui-data'],
      HostConfig: { Binds: ['/data-host/person:/data'], NetworkMode: 'none' },
    } });
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.equal(calls.at(-1).route, '/containers/fixture-person-resetpass?force=1');
  }
});

test('personal workers use runtime exec and staged skill files are removed on worker failure', async t => {
  const { skillExecutor } = await import('../gateway/market-skills.mjs');
  const { feishuExecutor } = await import('../gateway/feishu-onboarding.mjs');
  const { createContainerProject } = await import('../feishu/container-project.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-workers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'person'));
  let command, failed = false;
  const runtime = createDockerRuntime({ dataDir: dir, uid: process.getuid(), containerPrefix: 'fixture-', docker: async (method, route, body) => {
    if (route.endsWith('/exec')) {
      assert.equal(route, '/containers/fixture-person/exec');
      command = body;
      if (body.Cmd[0] === '/opt/workpartner/bin/wp-skill') {
        const source = body.Cmd.at(-1);
        assert.match(source, /^\/data\/\.wp-skill-uploads\/install-[a-f0-9]+\/SKILL\.md$/);
        assert.equal(fs.readFileSync(path.join(dir, 'person', source.slice(6)), 'utf8'), 'fixture skill');
        assert.equal(body.User, String(process.getuid()));
        assert.deepEqual(body.Cmd.slice(0, 4), ['/opt/workpartner/bin/wp-skill', '--overwrite', 'install', '--']);
      }
      return { status: 201, body: '{"Id":"worker"}' };
    }
    if (route.endsWith('/json')) return { status: 200, body: JSON.stringify({ ExitCode: failed ? 1 : 0 }) };
    const data = command.Cmd[0] === 'python3' ? { status: 'connected' } : { authenticated: true, expires_in_minutes: 15 };
    const bytes = Buffer.from(JSON.stringify(data)), header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.length, 4);
    return { status: 200, body: Buffer.concat([header, bytes]) };
  } });
  const user = { slug: 'person', backend: 'aionui', unionId: 'fixture' };
  failed = true;
  await assert.rejects(skillExecutor(runtime, process.getuid())(user, 'install', { filename: 'SKILL.md', content: Buffer.from('fixture skill'), overwrite: true }), /worker failed/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'person/.wp-skill-uploads')), []);
  failed = false;
  assert.deepEqual(await feishuExecutor(runtime, 1001)(user, 'status'), { status: 'connected' });
  assert.equal(command.User, '1001');
  await feishuExecutor(runtime, 1001)(user, 'start', true);
  assert.equal(command.AttachStdout, false);
  assert.deepEqual(command.Cmd, ['python3', '/opt/workpartner/bin/feishu-onboard.py', 'start', 'partner-person']);
  const project = createContainerProject({ runtime });
  assert.deepEqual(await project.status(user), { connected: true, expiresInMinutes: 15 });
  assert.equal(command.User, '1001:1001');
  assert.deepEqual(command.Env, ['HOME=/data']);
  assert.deepEqual(command.Cmd, ['/usr/local/bin/meegle', 'auth', 'status', '--format', 'json']);
});

test('identity and preview preparation await runtime storage and preserve credential filenames', async t => {
  const { createNextFeishuPreparation } = await import('../feishu/next.mjs');
  const { writeRelayKey, relayKey } = await import('../preview/gateway.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createDockerRuntime({ dataDir: dir, uid: process.getuid() });
  const user = { slug: 'person', backend: 'aionui', unionId: 'fixture' };
  const organization = { runtime: { internalOrigin: 'http://gateway' }, server: { publicOrigin: 'https://workspace.invalid', projectHost: '' } };
  const prepare = createNextFeishuPreparation({ organization, runtime, tokenFor: () => 'signed-token' });
  await prepare(user);
  assert.equal(await runtime.readFile('person', '.zp-market-token'), 'signed-token\n');
  assert.deepEqual(JSON.parse(await runtime.readFile('person', '.wp-feishu-cli.json')), {
    kind: 'container', bin: '/usr/local/bin', realBin: '/opt/partner-clis/bin', execPath: '/usr/local/bin/node',
    identityFile: '/data/.zp-market-token', tokenUrl: 'http://gateway/token', authorizationUrl: 'https://workspace.invalid/_wp/feishu/', meegleHost: '',
  });
  await writeRelayKey('fixture-key', user, runtime);
  const file = path.join(dir, 'person/.zp-preview-relay-key'), inode = fs.statSync(file).ino;
  assert.equal(fs.readFileSync(file, 'utf8'), relayKey('fixture-key', 'person') + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await writeRelayKey('fixture-key', user, runtime);
  assert.equal(fs.statSync(file).ino, inode);
});

test('runtime lifecycle and processes preserve stop timeouts and normalize process columns', async () => {
  const calls = [];
  const runtime = createDockerRuntime({ containerPrefix: 'fixture-', docker: async (method, route) => {
    calls.push([method, route]);
    if (route.includes('/top?')) return { status: 200, body: JSON.stringify({ Titles: ['COMMAND', 'PPID', 'PID'], Processes: [['cc-connect', '1', '5'], ['agent', '5', '6']] }) };
    return { status: 204 };
  } });
  await runtime.start('person'); await runtime.stop('person'); await runtime.restart('person'); await runtime.remove('person');
  assert.deepEqual(calls, [['POST', '/containers/fixture-person/start'], ['POST', '/containers/fixture-person/stop?t=10'],
    ['POST', '/containers/fixture-person/restart?t=10'], ['DELETE', '/containers/fixture-person?force=1']]);
  assert.deepEqual(await runtime.processes('person'), [{ pid: '5', ppid: '1', args: 'cc-connect' }, { pid: '6', ppid: '5', args: 'agent' }]);
});

test('runtime address adapts legacy endpoints without assuming their network name', async () => {
  const runtime = createDockerRuntime({ docker: async () => { throw new Error('Legacy endpoint must not be re-inspected'); } });
  assert.deepEqual(await runtime.address('person', 9000, { ip: 'legacy-endpoint', port: 8000 }), { host: 'legacy-endpoint', port: 9000 });
  assert.deepEqual(await runtime.address('person', undefined, { address: { host: 'legacy-endpoint', port: 8000 } }), { host: 'legacy-endpoint', port: 8000 });
  for (const existing of [{}, { ip: undefined }, { ip: '' }, { address: null }, null]) {
    assert.equal(await runtime.address('person', 9000, existing), null);
  }
});

test('legacy runtime exposes only supported operations and requires an existing endpoint', async t => {
  const { createLegacyRuntime } = await import('../gateway/runtime/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-legacy-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const runtime = createLegacyRuntime({ runtime: {
    containerPrefix: 'old-', usersDirectory: path.join(dir, 'legacy'),
    nextContainerPrefix: 'new-', nextDirectory: path.join(dir, 'next'), uid: process.getuid(),
  } }, { docker: async (method, route) => {
    calls.push({ method, route });
    if (route === '/containers/old-person/exec') return { status: 201, body: '{"Id":"job"}' };
    if (route === '/exec/job/start') return { status: 200, body: Buffer.alloc(0) };
    if (route === '/exec/job/json') return { status: 200, body: '{"ExitCode":0}' };
    if (route === '/containers/old-person/stop?t=10' || route === '/containers/old-person?force=1') return { status: 204 };
    throw new Error('Unexpected legacy request: ' + route);
  } });
  assert.deepEqual(Object.keys(runtime).sort(), ['address', 'exec', 'putFiles', 'readFile', 'remove', 'removeFiles', 'stop']);
  await assert.rejects(runtime.address('person'), /Legacy runtime does not support.*existing/i);
  assert.deepEqual(await runtime.address('person', 9000, { ip: 'old-host', port: 8000 }), { host: 'old-host', port: 9000 });
  assert.deepEqual(await runtime.address('person', undefined, { address: { host: 'old-host', port: 8000 } }), { host: 'old-host', port: 8000 });
  for (const existing of [null, {}, { ip: '' }, { address: null }]) assert.equal(await runtime.address('person', 9000, existing), null);
  assert.deepEqual(calls, [], 'address must not discover a legacy network');
  await runtime.putFiles('person', [{ path: 'config', content: 'legacy data' }]);
  assert.equal(await runtime.readFile('person', 'config'), 'legacy data');
  assert.equal(fs.readFileSync(path.join(dir, 'legacy/person/config'), 'utf8'), 'legacy data');
  assert.equal(fs.existsSync(path.join(dir, 'next')), false);
  await runtime.removeFiles('person', ['config']);
  await assert.rejects(runtime.readFile('person', 'config'), { code: 'ENOENT' });
  assert.deepEqual(await runtime.exec('person', ['true']), { exitCode: 0, stdout: '', stderr: '', logs: '' });
  assert.equal((await runtime.stop('person')).status, 204);
  assert.equal((await runtime.remove('person')).status, 204);
  assert.deepEqual(calls.slice(-2), [
    { method: 'POST', route: '/containers/old-person/stop?t=10' },
    { method: 'DELETE', route: '/containers/old-person?force=1' },
  ]);
});

for (const tail of ['header', 'payload']) {
  const frame = (type, text) => {
    const header = Buffer.alloc(8); header[0] = type; header.writeUInt32BE(Buffer.byteLength(text), 4);
    return Buffer.concat([header, Buffer.from(text)]);
  };
  const partial = frame(1, 'discard').subarray(0, tail === 'header' ? 5 : 10);
  const runtimeWithOutput = body => createDockerRuntime({ docker: async (method, route) => {
    if (route.endsWith('/exec')) return { status: 201, body: '{"Id":"job"}' };
    if (route.endsWith('/json')) return { status: 200, body: '{"ExitCode":0}' };
    if (route.includes('/create?')) return { status: 201 };
    if (route.endsWith('/wait')) return { status: 200, body: '{"StatusCode":0}' };
    return { status: 200, body };
  } });

  test(`runtime exec and runOnce ignore a truncated ${tail} after complete frames`, async () => {
    const runtime = runtimeWithOutput(Buffer.concat([frame(1, 'out'), frame(2, 'err'), frame(1, 'last'), partial]));
    assert.deepEqual(await runtime.exec('person', ['fixture']), { exitCode: 0, stdout: 'outlast', stderr: 'err', logs: 'outerrlast' });
    assert.deepEqual(await runtime.runOnce('person', { cmd: ['fixture'] }), { exitCode: 0, logs: 'outerrlast' });
  });

  test(`Feishu status ignores a truncated ${tail} after complete JSON`, async () => {
    const { feishuExecutor } = await import('../gateway/feishu-onboarding.mjs');
    const runtime = runtimeWithOutput(Buffer.concat([frame(1, '{"status":'), frame(2, '"connected"'), frame(1, '}'), partial]));
    assert.deepEqual(await feishuExecutor(runtime)({ slug: 'person' }, 'status'), { status: 'connected' });
  });

  test(`market skills and bounded exec reject a truncated ${tail} even after valid JSON`, async () => {
    const { skillExecutor } = await import('../gateway/market-skills.mjs');
    const runtime = runtimeWithOutput(Buffer.concat([frame(1, '{"skills":[]}'), partial]));
    await assert.rejects(skillExecutor(runtime)({ slug: 'person' }, 'list'), /Truncated runtime output/);
    for (const options of [{ maxOutputBytes: 1024 }, { maxOutputBytes: 1024, strictOutput: false }, { strictOutput: true }]) {
      await assert.rejects(runtime.exec('person', ['fixture'], options), /Truncated runtime output/);
    }
  });
}

test('skill upload cleanup survives renaming its parent while the worker runs', async t => {
  const { skillExecutor } = await import('../gateway/market-skills.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-rename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'person'));
  const runtime = createDockerRuntime({ dataDir: dir, uid: process.getuid() });
  runtime.exec = async () => {
    fs.renameSync(path.join(dir, 'person/.wp-skill-uploads'), path.join(dir, 'person/moved'));
    fs.mkdirSync(path.join(dir, 'person/.wp-skill-uploads'));
    return { exitCode: 0, stdout: '{"name":"fixture"}', stderr: '' };
  };
  assert.deepEqual(await skillExecutor(runtime, process.getuid())({ slug: 'person' }, 'install', { filename: 'SKILL.md', content: 'fixture' }), { name: 'fixture' });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'person/moved')), []);
});

test('runtime exec supports stdin through an upgraded connection and enforces output limits', async t => {
  const { docker } = await import('../gateway/runtime/docker.mjs');
  const { EventEmitter } = await import('node:events');
  let input;
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(4, 4);
  t.mock.method(http, 'request', options => {
    assert.equal(options.headers.upgrade, 'tcp');
    const req = new EventEmitter();
    req.end = () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = error => socket.emit('error', error);
      socket.end = value => { input = value; queueMicrotask(() => { socket.emit('data', Buffer.from('echo')); socket.emit('end'); }); };
      queueMicrotask(() => req.emit('upgrade', { statusCode: 101 }, socket, header));
    };
    return req;
  });
  const runtime = createDockerRuntime({ docker: async (method, route, body, timeout, maxBytes, options) => {
    if (route.endsWith('/exec')) {
      assert.equal(body.AttachStdin, true);
      return { status: 201, body: '{"Id":"stdin-job"}' };
    }
    if (route.endsWith('/start')) return docker(method, route, body, timeout, maxBytes, options);
    return { status: 200, body: '{"ExitCode":0}' };
  } });
  assert.deepEqual(await runtime.exec('person', ['cat'], { stdin: 'fixture\n' }), { exitCode: 0, stdout: 'echo', stderr: '', logs: 'echo' });
  assert.equal(input, 'fixture\n');
  await assert.rejects(runtime.exec('person', ['cat'], { stdin: '', detached: true }), /Detached/);
  await assert.rejects(runtime.exec('person', ['cat'], { stdin: '', maxOutputBytes: 8 }), /output too large/);
});

test('gateway rejects an unknown runtime kind before accessing credentials or listening', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-kind-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({ publicHost: 'workspace.invalid', runtime: { kind: 'unknown' }, model: { baseUrl: 'http://model/v1' } }));
  const result = spawnSync(process.execPath, [path.join(gatewayRoot, 'gateway.mjs')], { encoding: 'utf8', env: { ...process.env, WORKPARTNER_ORG_DIR: dir } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported runtime kind: unknown/);
  assert.doesNotMatch(result.stderr, /ENOENT|EPERM/);
});

test('legacy container tokens are written through runtime storage with private permissions', async t => {
  const { writeContainerToken, tokenUser } = await import('../gateway/market-auth.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = createDockerRuntime({ dataDir: dir, uid: process.getuid() });
  const user = { slug: 'person', unionId: 'fixture' };
  const writing = writeContainerToken('fixture-key', user, runtime);
  assert.ok(writing instanceof Promise);
  await writing;
  const value = await runtime.readFile('person', '.zp-market-token');
  assert.deepEqual(tokenUser({ headers: { authorization: `Bearer ${value.trim()}` } }, 'fixture-key', [user]), user);
  assert.equal(fs.statSync(path.join(dir, 'person/.zp-market-token')).mode & 0o777, 0o600);
});

test('legacy token calls remain synchronous and preserve custom roots, ownership and atomic replacement', async t => {
  const { writeContainerToken, tokenUser } = await import('../gateway/market-auth.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-legacy-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { slug: 'person', unionId: 'fixture' };
  assert.throws(() => writeContainerToken('key', { slug: '../escape' }, dir, null), /用户代号无效/);
  const failure = new Error('default path reached');
  const mkdir = t.mock.method(fs, 'mkdirSync', directory => { assert.equal(directory, '/users/person'); throw failure; });
  assert.throws(() => writeContainerToken('key', user), error => error === failure);
  mkdir.mock.restore();
  for (const uid of [null, process.getuid(), 1001]) {
    const root = path.join(dir, String(uid));
    assert.equal(writeContainerToken('fixture-key', user, root, uid === 1001 ? undefined : uid), undefined);
    const file = path.join(root, user.slug, '.zp-market-token');
    const value = fs.readFileSync(file, 'utf8');
    assert.ok(value.endsWith('\n'));
    assert.deepEqual(tokenUser({ headers: { authorization: `Bearer ${value.trim()}` } }, 'fixture-key', [user]), user);
    const stat = fs.statSync(file);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, uid ?? process.getuid());
    assert.equal(stat.gid, uid ?? process.getgid());
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o777 & ~process.umask());
    assert.equal(fs.statSync(path.dirname(file)).uid, uid ?? process.getuid());
    assert.equal(fs.statSync(path.dirname(file)).gid, uid ?? process.getgid());
    const open = fs.openSync(file, 'r');
    try {
      assert.equal(writeContainerToken('replacement-key', user, root, uid), undefined);
      assert.equal(fs.readFileSync(open, 'utf8'), value);
      assert.notEqual(fs.statSync(file).ino, stat.ino);
    } finally { fs.closeSync(open); }
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.zp-market-token']);
  }
});

test('runtime stdin stays on the injected transport with its timeout and output limit', async t => {
  t.mock.method(http, 'request', () => { throw new Error('Injected exec must not open a socket'); });
  const calls = [], bytes = Buffer.from('echo'), header = Buffer.alloc(8);
  header[0] = 1; header.writeUInt32BE(bytes.length, 4);
  const runtime = createDockerRuntime({ containerPrefix: 'fixture-', docker: async (...args) => {
    calls.push(args);
    if (args[1].endsWith('/exec')) return { status: 201, body: '{"Id":"stdin-job"}' };
    if (args[1].endsWith('/start')) return { status: 101, body: Buffer.concat([header, bytes]) };
    return { status: 200, body: '{"ExitCode":2}' };
  } });
  assert.deepEqual(await runtime.exec('person', ['cat'], { stdin: 'fixture\n', timeout: 25000, maxOutputBytes: 1024 }),
    { exitCode: 2, stdout: 'echo', stderr: '', logs: 'echo' });
  assert.deepEqual(calls[1], ['POST', '/exec/stdin-job/start', { Detach: false, Tty: false }, 25000, 1024, { stdin: 'fixture\n' }]);
  assert.equal(calls.length, 3);
});

test('stop, remove and one-shot start, wait and logs retain permissive status handling', async () => {
  for (const status of [200, 404, 409, 500]) {
    const calls = [], header = Buffer.alloc(8), bytes = Buffer.from('new password: fixture');
    header[0] = 1; header.writeUInt32BE(bytes.length, 4);
    const runtime = createDockerRuntime({ containerPrefix: 'fixture-', docker: async (method, route) => {
      calls.push([method, route]);
      if (route.includes('/create?')) return { status: 201 };
      if (route.endsWith('/wait')) return { status, body: status === 500 ? 'unavailable' : '{"StatusCode":3}' };
      if (route.includes('/logs?')) return { status, body: Buffer.concat([header, bytes]) };
      return { status, body: '{}' };
    } });
    assert.equal((await runtime.stop('person')).status, status);
    assert.equal((await runtime.remove('person')).status, status);
    assert.deepEqual(await runtime.runOnce('person', { cmd: ['resetpass'] }),
      { exitCode: status === 500 ? null : 3, logs: 'new password: fixture' });
    assert.deepEqual(calls, [
      ['POST', '/containers/fixture-person/stop?t=10'], ['DELETE', '/containers/fixture-person?force=1'],
      ['DELETE', '/containers/fixture-person-resetpass?force=1'], ['POST', '/containers/create?name=fixture-person-resetpass'],
      ['POST', '/containers/fixture-person-resetpass/start'], ['POST', '/containers/fixture-person-resetpass/wait'],
      ['GET', '/containers/fixture-person-resetpass/logs?stdout=1&stderr=1'], ['DELETE', '/containers/fixture-person-resetpass?force=1'],
    ]);
  }
});

test('AionUi stale rebuild continues after stop and remove return 404', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'aionui-person.pass'), 'fixture');
  fs.writeFileSync(path.join(dir, 'model-person.key'), 'fixture');
  const calls = [];
  let created = false;
  const runtime = createDockerRuntime({ containerPrefix: 'fixture-', dataDir: dir, secureDir: dir, uid: process.getuid(),
    keyPrefix: 'model-', image: 'new', docker: async (method, route) => {
      calls.push([method, route]);
      if (route.startsWith('/networks/')) return { status: 200, body: '{"Containers":{}}' };
      if (route === '/containers/fixture-person/json') return { status: 200, body: JSON.stringify({
        Config: { Image: created ? 'new' : 'old' }, State: { Running: !created },
      }) };
      if (route === '/containers/create?name=fixture-person') { created = true; return { status: 201 }; }
      if (route.endsWith('/start')) return { status: 204 };
      if (route.includes('/stop?') || method === 'DELETE') return { status: 404 };
      throw new Error('Unexpected request ' + route);
    } });
  const aionui = createAionui({ runtime, image: 'new', secretDir: dir, log() {} });
  assert.equal(await aionui.upstream({ slug: 'person' }), null);
  await aionui.pending('person');
  assert.equal(created, true);
  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [
    ['POST', '/containers/fixture-person/stop?t=10'], ['DELETE', '/containers/fixture-person?force=1'],
    ['POST', '/containers/create?name=fixture-person'], ['POST', '/containers/fixture-person/start'],
  ]);
});

test('project creation keeps 25-second timeouts and Feishu status preserves interleaved output', async () => {
  const { createContainerProject } = await import('../feishu/container-project.mjs');
  const { feishuExecutor } = await import('../gateway/feishu-onboarding.mjs');
  const calls = [];
  let project = true;
  const frame = (type, value) => { const header = Buffer.alloc(8); header[0] = type; header.writeUInt32BE(Buffer.byteLength(value), 4); return Buffer.concat([header, Buffer.from(value)]); };
  const runtime = createDockerRuntime({ docker: async (method, route, body, timeout, maxBytes) => {
    calls.push({ method, route, timeout, maxBytes });
    if (route.endsWith('/exec')) return { status: 201, body: '{"Id":"job"}' };
    if (route.endsWith('/json')) return { status: 200, body: '{"ExitCode":0}' };
    return { status: 200, body: project ? frame(1, '{"authenticated":true,"expires_in_minutes":15}')
      : Buffer.concat([frame(1, '{"status":'), frame(2, '"connected"'), frame(1, '}')]) };
  } });
  const user = { slug: 'person', backend: 'aionui' };
  assert.deepEqual(await createContainerProject({ runtime }).status(user), { connected: true, expiresInMinutes: 15 });
  assert.deepEqual(calls.slice(0, 2).map(({ timeout, maxBytes }) => ({ timeout, maxBytes })),
    [{ timeout: 25000, maxBytes: 1048576 }, { timeout: 25000, maxBytes: 1048576 }]);
  assert.equal(calls[2].route, '/exec/job/json');
  project = false;
  assert.deepEqual(await feishuExecutor(runtime, 1001)(user, 'status'), { status: 'connected' });
  assert.deepEqual(calls.slice(3, 5).map(call => call.timeout), [10000, 10000]);
});

test('model provisioning keeps untimed exec creation and start with original stream order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-runtime-provision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'users.json'), '[]');
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({ publicHost: 'workspace.invalid',
    runtime: { usersFile: path.join(dir, 'users.json'), secureDirectory: dir, uid: process.getuid(), containerPrefix: 'fixture-' },
    model: { baseUrl: 'http://model/v1', keyMode: 'exec', keyPrefix: 'model-',
      provision: { container: 'provisioner', command: ['provision'], keyPattern: 'key-fixture', models: ['fixture-model'] } },
  }));
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { provision, slugFor, readUsers } from ${JSON.stringify(pathToFileURL(path.join(gatewayRoot, 'onboard.mjs')).href)};
import { createDockerRuntime } from ${JSON.stringify(pathToFileURL(path.join(gatewayRoot, 'runtime/docker.mjs')).href)};
const frame = (type, value) => { const header = Buffer.alloc(8); header[0] = type; header.writeUInt32BE(Buffer.byteLength(value), 4); return Buffer.concat([header, Buffer.from(value)]); };
const calls = [], commands = [], slug = slugFor('fixture-union');
let command;
const runtime = createDockerRuntime({ docker: async (method, route, body, timeout) => {
  calls.push({ method, route, timeout });
  if (route.endsWith('/exec')) { command = body.Cmd; commands.push(command); return { status: 201, body: '{"Id":"job"}' }; }
  if (route.endsWith('/json')) return { status: 200, body: '{"ExitCode":0}' };
  const chunks = command[1] === 'add' ? [frame(1, 'key-'), frame(2, 'fix'), frame(1, 'ture')]
    : command[1] === 'list' ? [frame(1, '42 '), frame(2, 'fixture-' + slug), frame(1, ' active\\n')] : [];
  if (process.env.WP_TEST_OUTPUT_TAIL) chunks.push(frame(1, 'discard').subarray(0, Number(process.env.WP_TEST_OUTPUT_TAIL)));
  return { status: 200, body: Buffer.concat(chunks) };
} });
const user = await provision(runtime, { unionId: 'fixture-union', name: 'Fixture' });
assert.equal(user.slug, slug);
assert.equal(fs.readFileSync(${JSON.stringify(dir)} + '/model-' + slug + '.key', 'utf8'), 'key-fixture');
assert.deepEqual(readUsers(), [user]);
assert.deepEqual(commands, [['provision', 'add', 'fixture-' + slug], ['provision', 'list'], ['provision', 'models', '42', 'fixture-model']]);
assert.equal(calls.length, 9);
assert.ok(calls.filter(call => call.method === 'POST').every(call => call.timeout === 0));
assert.ok(calls.filter(call => call.route.endsWith('/exec')).every(call => call.route === '/containers/provisioner/exec'));
assert.equal(calls.filter(call => call.route === '/exec/job/json').length, 3);
`;
  for (const tail of ['', '5', '10']) {
    for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.key'))) fs.rmSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'users.json'), '[]');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8',
      env: { ...process.env, WORKPARTNER_ORG_DIR: dir, WP_TEST_OUTPUT_TAIL: tail } });
    assert.equal(result.status, 0, `output tail=${tail || 'none'}: ${result.stderr}`);
  }
});

test('exported Docker transport preserves callback arguments, Buffer responses and timeout errors', async t => {
  const { EventEmitter } = await import('node:events');
  const { docker } = await import('../gateway/runtime/docker.mjs');
  const calls = [];
  let timedOut = false;
  t.mock.method(http, 'request', (options, receive) => {
    const req = new EventEmitter();
    calls.push({ options });
    req.destroy = error => req.emit('error', error);
    req.end = body => {
      calls.at(-1).body = body;
      queueMicrotask(() => {
        if (timedOut) return req.emit('timeout');
        const res = new EventEmitter(); res.statusCode = 404;
        receive(res);
        res.emit('data', Buffer.from('not ')); res.emit('data', Buffer.from('found')); res.emit('end');
      });
    };
    return req;
  });
  assert.deepEqual(await docker('POST', '/fixture', { value: 1 }, 25000), { status: 404, body: Buffer.from('not found') });
  assert.deepEqual(calls[0], { options: { socketPath: '/var/run/docker.sock', method: 'POST', path: '/fixture', timeout: 25000,
    headers: { 'Content-Type': 'application/json' } }, body: '{"value":1}' });
  assert.deepEqual(await docker('GET', '/fixture'), { status: 404, body: Buffer.from('not found') });
  assert.deepEqual(calls[1], { options: { socketPath: '/var/run/docker.sock', method: 'GET', path: '/fixture', headers: {} }, body: undefined });
  timedOut = true;
  await assert.rejects(docker('GET', '/fixture', undefined, 10), { message: '超时' });
});
