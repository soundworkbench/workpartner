import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createK8sExec } from '../gateway/runtime/k8s-exec.mjs';
import { createK8sFiles } from '../gateway/runtime/k8s-files.mjs';
import { createNextFeishuPreparation } from '../feishu/next.mjs';
import { writeRelayKey, relayKey } from '../preview/gateway.mjs';
import { skillExecutor } from '../gateway/market-skills.mjs';
import { createAionui } from '../gateway/aionui.mjs';

const result = (stdout = '', exitCode = 0, stderr = '') => ({ exitCode, stdout, stderr, logs: stdout + stderr });
const options = { namespace: 'users', systemNamespace: 'system', containerPrefix: 'fixture-', container: 'main', uid: 1001 };
const collection = '/api/v1/namespaces/users/secrets';
const secretPath = `${collection}/fixture-person-published`;
const encode = value => Buffer.from(value).toString('base64');

function fakeClient() {
  const calls = [], objects = new Map();
  return {
    calls, objects, namespace: 'default-system',
    async get(route) { calls.push(['get', route]); return structuredClone(objects.get(route) || null); },
    async create(route, body) {
      calls.push(['create', route, structuredClone(body)]);
      const key = `${route}/${body.metadata.name}`;
      if (objects.has(key)) throw Object.assign(new Error('Already exists'), { status: 409, reason: 'AlreadyExists' });
      objects.set(key, structuredClone(body));
      return structuredClone(body);
    },
    async patch(route, body, type) {
      calls.push(['patch', route, structuredClone(body), type]);
      assert.equal(type, 'merge');
      const object = objects.get(route);
      assert.ok(object);
      for (const [key, value] of Object.entries(body.data)) {
        if (value === null) delete object.data[key];
        else object.data[key] = value;
      }
      return structuredClone(object);
    },
    async exec(...args) { calls.push(['exec', ...args]); return result(); },
  };
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-k8s-files-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Regular descriptors also work in offline sandboxes that prohibit socketpair-backed child pipes.
function runLocal(command, args, input = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-k8s-script-'));
  const handles = [];
  try {
    fs.writeFileSync(path.join(directory, 'input'), input);
    for (const [filename, flags] of [['input', 'r'], ['output', 'w'], ['error', 'w']]) {
      handles.push(fs.openSync(path.join(directory, filename), flags));
    }
    const child = spawnSync(command, args, { stdio: handles, timeout: 15000 });
    return { ...child, stdout: fs.readFileSync(path.join(directory, 'output'), 'utf8'), stderr: fs.readFileSync(path.join(directory, 'error'), 'utf8') };
  } finally {
    handles.forEach(fd => fs.closeSync(fd));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function localRuntime(t, extra = {}) {
  const root = temporary(t), data = path.join(root, 'data'), client = fakeClient();
  fs.mkdirSync(data, { mode: 0o755 });
  const pending = new Map();
  client.exec = async (...args) => {
    client.calls.push(['exec', ...args]);
    const [, , , command, spec] = args;
    assert.equal(command[0], 'node');
    assert.equal(command[1], '-e');
    assert.equal(command[3], '/data');
    const child = runLocal(process.execPath, [command[1], command[2], data], spec.stdin);
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout);
    if (response.lease) pending.set(response.lease, command[2]);
    if (Buffer.byteLength(child.stdout) > (spec.maxOutputBytes ?? Infinity)) throw new Error('Runtime output too large');
    return result(child.stdout);
  };
  t.after(() => {
    for (const [lease, script] of pending) {
      if (fs.existsSync(lease)) runLocal(process.execPath, ['-e', script, data], JSON.stringify({ operation: 'release', lease }));
      assert.equal(fs.existsSync(lease), false, 'lease control directory is removed');
    }
  });
  const execution = createK8sExec({ ...options, client });
  return { root, data, client, pending, runtime: { ...execution, ...createK8sFiles({ ...options, client, exec: execution.exec, ...extra }) } };
}

test('exec maps names, users, stdin, timeout and output limits to the K1 interface', async () => {
  const client = fakeClient();
  const expected = { exitCode: 7, stdout: 'out', stderr: 'err', logs: 'eroutr' };
  client.exec = async (...args) => { client.calls.push(args); return expected; };
  const runtime = createK8sExec({ ...options, client, systemContainer: 'service' });
  const command = ['printf', '%s', '$(literal); value'];
  assert.deepEqual(await runtime.exec('person', command, {
    user: '1001:1001', env: ['A=space ; $value', 'B='], stdin: Buffer.from('input'), timeout: 123,
    createTimeout: 45, maxOutputBytes: 678, strictOutput: true,
  }), expected);
  assert.deepEqual(client.calls[0], ['users', 'fixture-person-0', 'main', ['env', '--', 'A=space ; $value', 'B=', ...command], {
    stdin: Buffer.from('input'), timeoutMs: 123, connectTimeoutMs: 45, maxOutputBytes: 678,
  }]);
  await runtime.execNamed('provisioner', ['list'], { user: 1001 });
  assert.deepEqual(client.calls[1], ['system', 'provisioner', 'service', ['list'], {
    stdin: undefined, timeoutMs: 30000, connectTimeoutMs: 10000, maxOutputBytes: undefined,
  }]);
  await createK8sExec({ client, namespace: 'users' }).execNamed('provisioner', ['list']);
  assert.equal(client.calls[2][0], 'default-system');
  assert.equal(client.calls[2][2], undefined);
});

test('exec rejects other users and invalid commands before contacting Kubernetes', async () => {
  const client = fakeClient(), runtime = createK8sExec({ ...options, client });
  for (const user of [0, 'root', '1002', '1001:0', null]) await assert.rejects(runtime.exec('person', ['true'], { user }), /container user/);
  for (const cmd of [[], ['a\0b'], [12]]) await assert.rejects(runtime.exec('person', cmd), /command/);
  for (const env of [['-i=value'], ['missing'], ['A=\0'], {}]) await assert.rejects(runtime.exec('person', ['true'], { env }), /environment/);
  await assert.rejects(runtime.exec('person', ['cat'], { detached: true, stdin: '' }), /Detached/);
  for (const slug of ['a', 'Person', 'bad_name', '../person', 'a'.repeat(32)]) {
    await assert.rejects(runtime.exec(slug, ['true']), /slug/);
  }
  assert.deepEqual(client.calls, []);
});

test('zero exec and connection timeouts become bounded positive K1 durations', async () => {
  const client = fakeClient();
  client.exec = async (...args) => {
    const spec = args[4];
    for (const duration of [spec.timeoutMs, spec.connectTimeoutMs]) {
      assert.ok(Number.isInteger(duration) && duration > 0, 'K1 rejects zero durations');
    }
    client.calls.push(args);
    return result();
  };
  const runtime = createK8sExec({ ...options, client });
  for (const method of ['exec', 'execNamed']) {
    for (const spec of [{ timeout: 0 }, { createTimeout: 0 }, { timeout: 0, createTimeout: 0 }]) {
      await runtime[method]('person', ['true'], spec);
      assert.equal(client.calls.at(-1)[4].timeoutMs, spec.timeout === 0 ? 86400000 : 30000);
      assert.equal(client.calls.at(-1)[4].connectTimeoutMs, spec.createTimeout === 0 ? 86400000 : 10000);
    }
  }
});

test('the default user exec container matches the K2a workspace container', async () => {
  const client = fakeClient();
  await createK8sExec({ client, namespace: 'users' }).exec('person', ['true']);
  assert.deepEqual(client.calls[0].slice(1, 5), ['users', 'workpartner-next-person-0', 'workspace', ['true']]);
});

test('exec preserves K1 timeout and output-limit failures', async () => {
  for (const message of ['Runtime exec timed out', 'Runtime output too large']) {
    const failure = new Error(message);
    const runtime = createK8sExec({ ...options, client: { exec: async () => { throw failure; } } });
    await assert.rejects(runtime.exec('person', ['cat']), error => error === failure);
  }
});

test('detached exec uses positional arguments and returns a null exit code', async t => {
  const root = temporary(t), destination = path.join(root, 'result');
  const literal = '$(touch should-not-exist); "quoted"';
  const command = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], process.env.VALUE + process.argv[2])', destination, literal];
  const client = fakeClient();
  client.exec = async (...args) => {
    client.calls.push(args);
    const cmd = args[3];
    const child = runLocal(cmd[0], cmd.slice(1));
    assert.ifError(child.error);
    assert.equal(child.status, 0);
    return result(child.stdout);
  };
  const runtime = createK8sExec({ ...options, client });
  assert.deepEqual(await runtime.exec('person', command, { detached: true, env: ['VALUE=prefix:'] }), result('', null));
  assert.deepEqual(client.calls[0][3], ['/bin/sh', '-c', 'setsid "$@" </dev/null >/dev/null 2>&1 &', 'sh', 'env', '--', 'VALUE=prefix:', ...command]);
  for (let attempt = 0; attempt < 100 && !fs.existsSync(destination); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'prefix:' + literal);
});

test('next identity preparation batches both published files into one merge patch', async () => {
  const client = fakeClient();
  const runtime = createK8sFiles({ ...options, client });
  const prepare = createNextFeishuPreparation({ runtime, tokenFor: () => 'fixture-token', organization: {
    runtime: { internalOrigin: 'http://gateway.test' }, server: { publicOrigin: 'https://workspace.test', projectHost: '' },
  } });
  const user = { slug: 'person', backend: 'aionui', unionId: 'fixture' };
  await prepare(user);
  const mutations = client.calls.filter(call => call[0] !== 'get');
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0], ['create', collection, { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: {
    name: 'fixture-person-published', namespace: 'users', labels: {
      'app.kubernetes.io/part-of': 'workpartner', 'workpartner/role': 'user', 'workpartner.next-user': 'person',
    },
  }, data: {} }]);
  assert.equal(mutations[1][0], 'patch');
  assert.equal(mutations[1][1], secretPath);
  assert.deepEqual(Object.keys(mutations[1][2].data).sort(), ['.wp-feishu-cli.json', '.zp-market-token']);
  assert.equal(mutations[1][3], 'merge');
  assert.equal(await runtime.readFile('person', '.zp-market-token'), 'fixture-token\n');
  assert.deepEqual(JSON.parse(await runtime.readFile('person', '.wp-feishu-cli.json')), {
    kind: 'container', bin: '/usr/local/bin', realBin: '/opt/partner-clis/bin', execPath: '/usr/local/bin/node',
    identityFile: '/data/.zp-market-token', tokenUrl: 'http://gateway.test/token',
    authorizationUrl: 'https://workspace.test/_wp/feishu/', meegleHost: '',
  });
  await prepare(user);
  assert.equal(client.calls.filter(call => call[0] === 'patch').length, 1);
});

test('preview comparison skips unchanged keys; cache expires and mutations invalidate it', async () => {
  const client = fakeClient();
  let time = 0;
  const runtime = createK8sFiles({ ...options, client, now: () => time, cacheMs: 20 });
  await assert.rejects(runtime.readFile('person', '.zp-preview-relay-key'), { code: 'ENOENT' });
  await writeRelayKey('fixture-key', { slug: 'person' }, runtime);
  await writeRelayKey('fixture-key', { slug: 'person' }, runtime);
  assert.equal(client.calls.filter(call => call[0] === 'patch').length, 1);
  assert.equal(await runtime.readFile('person', '.zp-preview-relay-key'), relayKey('fixture-key', 'person') + '\n');
  const reads = client.calls.filter(call => call[0] === 'get').length;
  client.objects.get(secretPath).data['.zp-preview-relay-key'] = encode('external');
  assert.notEqual(await runtime.readFile('person', '.zp-preview-relay-key'), 'external');
  assert.equal(client.calls.filter(call => call[0] === 'get').length, reads);
  time = 20;
  assert.equal(await runtime.readFile('person', '.zp-preview-relay-key'), 'external');
  await runtime.removeFiles('person', ['.zp-preview-relay-key']);
  assert.deepEqual(client.calls.at(-1), ['patch', secretPath, { data: { '.zp-preview-relay-key': null } }, 'merge']);
  await assert.rejects(runtime.readFile('person', '.zp-preview-relay-key'), { code: 'ENOENT' });
  await assert.rejects(runtime.readFile('person', '.zp-market-token'), { code: 'ENOENT' });
});

test('Secret updates preserve other keys, handle concurrent creation and repeat deletion', async () => {
  const client = fakeClient(), create = client.create;
  client.create = async (route, body) => {
    client.objects.set(secretPath, { data: { preserved: encode('keep') } });
    return create(route, body);
  };
  const runtime = createK8sFiles({ ...options, client, publishedFiles: ['custom'] });
  await runtime.putFiles('person', [{ path: 'custom', content: Buffer.from('value') }]);
  assert.equal(await runtime.readFile('person', 'custom'), 'value');
  assert.equal(client.objects.get(secretPath).data.preserved, encode('keep'));
  await runtime.removeFiles('person', ['custom']);
  await runtime.removeFiles('person', ['custom']);
  client.objects.delete(secretPath);
  await runtime.removeFiles('person', ['custom']);
  assert.equal(client.calls.at(-1)[0], 'get');
});

test('an in-flight Secret read cannot repopulate the cache after a write', async () => {
  const client = fakeClient(), get = client.get;
  client.objects.set(secretPath, { data: { '.zp-market-token': encode('old') } });
  let complete;
  client.get = route => {
    client.get = get;
    return new Promise(resolve => { complete = () => resolve({ data: { '.zp-market-token': encode('old') } }); });
  };
  const runtime = createK8sFiles({ ...options, client });
  const reading = runtime.readFile('person', '.zp-market-token');
  await runtime.putFiles('person', [{ path: '.zp-market-token', content: 'new' }]);
  complete();
  assert.equal(await reading, 'old');
  assert.equal(await runtime.readFile('person', '.zp-market-token'), 'new');
});

test('invalid paths in every input are rejected before any request or partial write', async () => {
  const client = fakeClient(), execution = createK8sExec({ ...options, client });
  const runtime = createK8sFiles({ ...options, client, exec: execution.exec });
  for (const filename of ['', '.', '..', '../escape', '/escape', 'a//b', 'a/./b', 'a/../b', 'a/', 'a\\b', 'a\0b']) {
    await assert.rejects(runtime.putFiles('person', [{ path: '.zp-market-token', content: 'fixture' }, { path: filename, content: 'bad' }]), /Invalid runtime path/);
    await assert.rejects(runtime.putFiles('person', [], { directories: [{ path: filename }] }), /Invalid runtime path/);
    await assert.rejects(runtime.putFiles('person', [], { cleanup: [filename] }), /Invalid runtime path/);
    await assert.rejects(runtime.readFile('person', filename), /Invalid runtime path/);
    await assert.rejects(runtime.removeFiles('person', ['.zp-market-token', filename]), /Invalid runtime path/);
  }
  for (const slug of ['a', 'Person', 'bad_name', '../person']) {
    await assert.rejects(runtime.putFiles(slug, []), /slug/);
    await assert.rejects(runtime.readFile(slug, '.zp-market-token'), /slug/);
    await assert.rejects(runtime.removeFiles(slug, []), /slug/);
  }
  assert.throws(() => createK8sFiles({ ...options, client, publishedFiles: ['nested/key'] }), /published/);
  assert.deepEqual(client.calls, []);
});

test('fixed file program handles binary content, directory modes and atomic replacement without changing root mode', async t => {
  const { data, client, runtime } = localRuntime(t);
  const bytes = Buffer.from([0, 1, 127, 255]);
  await runtime.putFiles('person', [{ path: 'staging/item', content: bytes, mode: 0o640 }], {
    directoryMode: 0o777, chown: false, directories: [{ path: 'staging', mode: 0o711, owner: false }],
  });
  assert.deepEqual(fs.readFileSync(path.join(data, 'staging/item')), bytes);
  assert.equal(fs.statSync(path.join(data, 'staging')).mode & 0o777, 0o711);
  assert.equal(fs.statSync(path.join(data, 'staging/item')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(data, 'staging/item')).uid, process.getuid());
  assert.equal(fs.statSync(data).mode & 0o777, 0o755);
  const fd = fs.openSync(path.join(data, 'staging/item'), 'r');
  try {
    await runtime.putFiles('person', [{ path: 'staging/item', content: 'new value', mode: 0o600 }]);
    assert.deepEqual(fs.readFileSync(fd), bytes, 'already-open reader sees the complete old file');
    assert.equal(await runtime.readFile('person', 'staging/item'), 'new value');
  } finally { fs.closeSync(fd); }
  assert.deepEqual(fs.readdirSync(path.join(data, 'staging')), ['item']);
  const request = JSON.parse(client.calls[0][5].stdin);
  assert.equal(request.files[0].content, bytes.toString('base64'));
  assert.equal(client.calls[0][4].includes('new value'), false);
  await runtime.removeFiles('person', ['staging']);
  await runtime.removeFiles('person', ['staging']);
  await assert.rejects(runtime.readFile('person', 'staging/item'), { code: 'ENOENT' });
});

test('file program refuses symlink parents and reads, replaces leaf symlinks and never deletes their targets', async t => {
  const { root, data, runtime } = localRuntime(t), outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  fs.symlinkSync(outside, path.join(data, 'link'));
  await assert.rejects(runtime.putFiles('person', [{ path: 'link/escape', content: 'bad' }]));
  await assert.rejects(runtime.readFile('person', 'link/sentinel'));
  await assert.rejects(runtime.removeFiles('person', ['link/sentinel']));
  fs.symlinkSync(path.join(outside, 'sentinel'), path.join(data, 'leaf'));
  await assert.rejects(runtime.readFile('person', 'leaf'));
  await runtime.putFiles('person', [{ path: 'leaf', content: 'replacement' }]);
  assert.equal(fs.lstatSync(path.join(data, 'leaf')).isSymbolicLink(), false);
  assert.equal(await runtime.readFile('person', 'leaf'), 'replacement');
  await runtime.removeFiles('person', ['link']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  fs.mkdirSync(path.join(data, 'directory'));
  await assert.rejects(runtime.readFile('person', 'directory'), { code: 'EISDIR' });
  fs.renameSync(data, path.join(root, 'moved'));
  fs.symlinkSync(outside, data);
  await assert.rejects(runtime.putFiles('person', [{ path: 'escape', content: 'bad' }]));
});

test('ordinary reads enforce a 16 MiB encoded output cap and preserve K1 overflow errors', async t => {
  const { data, client, runtime } = localRuntime(t);
  fs.writeFileSync(path.join(data, 'small'), 'fixture');
  assert.equal(await runtime.readFile('person', 'small'), 'fixture');
  assert.equal(client.calls.at(-1)[5].maxOutputBytes, 16 * 1024 * 1024);
  fs.writeFileSync(path.join(data, 'large'), Buffer.alloc(12 * 1024 * 1024, 'x'));
  await assert.rejects(runtime.readFile('person', 'large'), /Runtime output too large/);
  const failure = new Error('K1 output overflow');
  client.exec = async () => { throw failure; };
  await assert.rejects(runtime.readFile('person', 'small'), error => error === failure);
});

function holderPid(control) {
  for (const entry of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      if (fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').at(-2) === control) return Number(entry);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  assert.fail('lease holder is running');
}

function exited(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
  } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), 'condition completes within five seconds');
}

test('lease lifetime defaults to thirty minutes and rejects unbounded or overflowing timers', async t => {
  const { client, runtime } = localRuntime(t);
  const lease = await runtime.putFiles('person', [{ path: 'staging/file', content: 'fixture' }], { cleanup: ['staging'] });
  assert.equal(JSON.parse(client.calls[0][5].stdin).leaseTtlMs, 30 * 60 * 1000);
  await runtime.removeFiles('person', ['staging'], lease);
  for (const leaseTtlMs of [0, -1, NaN, Infinity, 1.5, '1000', 2147483648]) {
    assert.throws(() => createK8sFiles({ ...options, client, leaseTtlMs }), /lease lifetime/);
  }
});

test('an abandoned holder expires, cleans retained paths and control, and exits without gateway release', async t => {
  const { data, runtime, pending } = localRuntime(t, { leaseTtlMs: 1000 });
  const paths = ['staging/job'];
  const lease = await runtime.putFiles('person', [{ path: 'staging/job/file', content: 'fixture' }], { cleanup: paths });
  const [control] = pending.keys(), pid = holderPid(control);
  fs.renameSync(path.join(data, 'staging'), path.join(data, 'moved'));
  await waitUntil(() => !fs.existsSync(control) && !fs.existsSync(path.join(data, 'moved/job')) && exited(pid));
  await runtime.removeFiles('person', paths, lease);
  assert.equal(fs.existsSync(path.join(data, 'staging')), false);
});

test('SIGKILL of a holder does not turn a successful skill installation into failure', async t => {
  const { data, client, runtime, pending } = localRuntime(t);
  let lease, paths;
  const putFiles = runtime.putFiles;
  runtime.putFiles = async (slug, files, spec) => {
    paths = spec.cleanup;
    return lease = await putFiles(slug, files, spec);
  };
  runtime.exec = async () => {
    const [control] = pending.keys();
    const pid = holderPid(control);
    process.kill(pid, 'SIGKILL');
    await waitUntil(() => exited(pid));
    return result('{"name":"fixture"}');
  };
  assert.deepEqual(await skillExecutor(runtime)({ slug: 'person' }, 'install', { filename: 'SKILL.md', content: 'fixture' }), { name: 'fixture' });
  assert.deepEqual(fs.readdirSync(path.join(data, '.wp-skill-uploads')), []);
  assert.equal(fs.existsSync([...pending.keys()][0]), false);
  const count = client.calls.length;
  await runtime.removeFiles('person', paths, lease);
  assert.equal(client.calls.length, count, 'fallback marks the lease released');
});

test('fallback cleanup refuses symlink parents, removes control and remains best effort', async t => {
  const { root, data, client, runtime, pending } = localRuntime(t, { leaseTtlMs: 1000 });
  const paths = ['staging/job'];
  const lease = await runtime.putFiles('person', [{ path: 'staging/job/file', content: 'fixture' }], { cleanup: paths });
  const [control] = pending.keys(), pid = holderPid(control);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'job'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'job/sentinel'), 'keep');
  fs.renameSync(path.join(data, 'staging'), path.join(data, 'moved'));
  fs.symlinkSync(outside, path.join(data, 'staging'));
  const exec = client.exec;
  client.exec = (...args) => {
    if (JSON.parse(args[4].stdin).operation === 'release') throw new Error('Release transport failed');
    return exec(...args);
  };
  await runtime.removeFiles('person', paths, lease);
  assert.equal(fs.readFileSync(path.join(outside, 'job/sentinel'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(control), false);
  await waitUntil(() => exited(pid));
  assert.equal(fs.existsSync(path.join(data, 'moved/job')), false, 'holder expiry still cleans retained paths');
  const count = client.calls.length;
  await runtime.removeFiles('person', paths, lease);
  assert.equal(client.calls.length, count);
});

test('skill upload leases retain staging parents after rename and replacement with a symlink', async t => {
  const { root, data, runtime } = localRuntime(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  let temporaryName;
  runtime.exec = async (slug, cmd) => {
    assert.equal(slug, 'person');
    const filename = path.join(data, cmd.at(-1).slice('/data/'.length));
    assert.equal(fs.readFileSync(filename, 'utf8'), 'fixture skill');
    temporaryName = path.basename(path.dirname(filename));
    fs.renameSync(path.join(data, '.wp-skill-uploads'), path.join(data, 'moved'));
    fs.mkdirSync(path.join(outside, temporaryName));
    fs.writeFileSync(path.join(outside, temporaryName, 'sentinel'), 'keep');
    fs.symlinkSync(outside, path.join(data, '.wp-skill-uploads'));
    return result('{"name":"fixture"}');
  };
  assert.deepEqual(await skillExecutor(runtime)({ slug: 'person' }, 'install', { filename: 'SKILL.md', content: 'fixture skill' }), { name: 'fixture' });
  assert.deepEqual(fs.readdirSync(path.join(data, 'moved')), []);
  assert.equal(fs.readFileSync(path.join(outside, temporaryName, 'sentinel'), 'utf8'), 'keep');
});

test('skill worker failure still releases the lease; leases reject mismatches and repeated release is harmless', async t => {
  const { data, client, runtime } = localRuntime(t);
  runtime.exec = async () => result('', 1);
  await assert.rejects(skillExecutor(runtime)({ slug: 'person' }, 'install', { filename: 'SKILL.md', content: 'fixture' }), /worker failed/);
  assert.deepEqual(fs.readdirSync(path.join(data, '.wp-skill-uploads')), []);
  const paths = ['staging/job'];
  const lease = await runtime.putFiles('person', [{ path: 'staging/job/file', content: 'value' }], { cleanup: paths });
  const count = client.calls.length;
  await assert.rejects(runtime.removeFiles('other', paths, lease), /lease/);
  await assert.rejects(runtime.removeFiles('person', ['staging'], lease), /lease/);
  await assert.rejects(runtime.removeFiles('person', paths, { ...lease }), /lease/);
  assert.equal(client.calls.length, count);
  await runtime.removeFiles('person', paths, lease);
  await runtime.removeFiles('person', paths, lease);
  assert.deepEqual(fs.readdirSync(path.join(data, 'staging')), []);
});

test('failed staging cleans partial files and helper errors do not expose content', async t => {
  const { data, runtime } = localRuntime(t);
  fs.mkdirSync(path.join(data, 'staging'));
  fs.symlinkSync(data, path.join(data, 'staging/link'));
  await assert.rejects(runtime.putFiles('person', [
    { path: 'staging/job/file', content: 'fixture-sensitive-value' },
    { path: 'staging/link/escape', content: 'fixture-sensitive-value' },
  ], { cleanup: ['staging/job'] }), error => !error.message.includes('fixture-sensitive-value'));
  assert.deepEqual(fs.readdirSync(path.join(data, 'staging')), ['link']);
});

test('mixed Secret and ordinary files use their respective storage and support cleanup', async t => {
  const { data, client, runtime } = localRuntime(t);
  const paths = ['staging', '.zp-market-token'];
  const lease = await runtime.putFiles('person', [
    { path: '.zp-market-token', content: 'fixture' }, { path: 'staging/file', content: 'ordinary' },
  ], { cleanup: paths });
  assert.equal(await runtime.readFile('person', '.zp-market-token'), 'fixture');
  assert.equal(await runtime.readFile('person', 'staging/file'), 'ordinary');
  assert.equal(fs.existsSync(path.join(data, '.zp-market-token')), false);
  assert.deepEqual(Object.keys(client.objects.get(secretPath).data), ['.zp-market-token']);
  await runtime.removeFiles('person', paths, lease);
  assert.equal(fs.existsSync(path.join(data, 'staging')), false);
  await assert.rejects(runtime.readFile('person', '.zp-market-token'), { code: 'ENOENT' });
});

test('a failed Secret publication releases an already-created staging lease', async t => {
  const { data, client, runtime } = localRuntime(t);
  const failure = Object.assign(new Error('Secret write forbidden'), { status: 403, reason: 'Forbidden' });
  client.patch = async () => { throw failure; };
  await assert.rejects(runtime.putFiles('person', [
    { path: 'staging/file', content: 'ordinary' }, { path: '.zp-market-token', content: 'fixture' },
  ], { cleanup: ['staging'] }), error => error === failure);
  assert.equal(fs.existsSync(path.join(data, 'staging')), false);
});

test('Secret deletion failure still releases staging and marks the lease released', async t => {
  const { data, client, runtime, pending } = localRuntime(t);
  const paths = ['staging', '.zp-market-token'];
  const lease = await runtime.putFiles('person', [
    { path: 'staging/file', content: 'ordinary' }, { path: '.zp-market-token', content: 'fixture' },
  ], { cleanup: paths });
  const failure = new Error('Secret deletion forbidden');
  client.patch = async () => { throw failure; };
  await assert.rejects(runtime.removeFiles('person', paths, lease), error => error === failure);
  assert.equal(fs.existsSync(path.join(data, 'staging')), false);
  assert.equal(fs.existsSync([...pending.keys()][0]), false);
  const count = client.calls.length;
  await runtime.removeFiles('person', paths, lease);
  assert.equal(client.calls.length, count);
});

test('failed publication preserves its original error when release and fallback both fail', async () => {
  const client = fakeClient(), operations = [];
  const failure = new Error('Secret publication forbidden');
  client.patch = async () => { throw failure; };
  const runtime = createK8sFiles({ ...options, client, exec: async (slug, cmd, spec) => {
    const request = JSON.parse(spec.stdin);
    operations.push(request.operation);
    if (request.operation === 'put') return result(JSON.stringify({ lease: `/tmp/wp-runtime-${'a'.repeat(32)}` }));
    if (request.operation === 'remove') assert.deepEqual(request.paths, ['staging']);
    throw new Error('Cleanup transport failed');
  } });
  await assert.rejects(runtime.putFiles('person', [
    { path: 'staging/file', content: 'ordinary' }, { path: '.zp-market-token', content: 'fixture' },
  ], { cleanup: ['staging', '.zp-market-token'] }), error => error === failure);
  assert.deepEqual(operations, ['put', 'release', 'remove']);
});

function processFixture(t) {
  const root = temporary(t), client = fakeClient();
  for (const [pid, ppid, comm, args] of [
    ['12', '1', 'cc (connect)', '/opt/bin/cc-connect\0--config\0/data/config\0'],
    ['13', '12', 'worker ) (name)', 'node\0agent\0'],
    ['14', '1', 'idle', ''],
  ]) {
    fs.mkdirSync(path.join(root, pid));
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0`);
    fs.writeFileSync(path.join(root, pid, 'cmdline'), args);
  }
  fs.mkdirSync(path.join(root, '15'));
  fs.mkdirSync(path.join(root, 'self'));
  client.exec = async (...args) => {
    client.calls.push(args);
    const cmd = args[3];
    assert.deepEqual(cmd.slice(0, 2), ['node', '-e']);
    assert.equal(cmd[3], '/proc');
    const child = runLocal(process.execPath, ['-e', cmd[2], root]);
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return result(child.stdout);
  };
  return { client, runtime: createK8sExec({ ...options, client }) };
}

test('processes reads proc stat and cmdline, tolerates exiting processes and returns string IDs', async t => {
  const { client, runtime } = processFixture(t);
  assert.deepEqual(await runtime.processes('person', 321), [
    { pid: '12', ppid: '1', args: '/opt/bin/cc-connect --config /data/config' },
    { pid: '13', ppid: '12', args: 'node agent' },
  ]);
  assert.equal(client.calls[0][4].timeoutMs, 321);
  for (const response of [result('[]', 1), result('invalid'), result('[{"pid":12,"ppid":"1","args":"bad"}]')]) {
    client.exec = async () => response;
    await assert.rejects(runtime.processes('person'), /process/);
  }
});

test('aionui busy detection sees the cc-connect child and defers rebuilding a stale workspace', async t => {
  const { runtime } = processFixture(t), root = temporary(t), writes = [];
  fs.writeFileSync(path.join(root, 'aionui-person.pass'), 'fixture');
  t.mock.method(http, 'request', (options, callback) => {
    assert.equal(options.path, '/api/conversations?limit=10000');
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([Buffer.from('{"data":{"items":[]}}')]);
      response.statusCode = 200;
      callback(response);
    };
    return request;
  });
  const address = { host: '192.0.2.1', port: 25808 };
  Object.assign(runtime, {
    inspect: async () => ({ exists: true, running: true, image: 'old-image', imageId: 'old-id', name: 'fixture-person', address }),
    ensureIsolation: async () => {},
    stop: async () => writes.push('stop'), remove: async () => writes.push('remove'), create: async () => writes.push('create'),
  });
  const aionui = createAionui({ runtime, secretDir: root, image: 'new-image', log() {} });
  assert.deepEqual(await aionui.upstream({ slug: 'person' }), { name: 'fixture-person', address, imageId: 'old-id' });
  assert.deepEqual(writes, []);
});
