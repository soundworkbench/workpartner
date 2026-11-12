import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMyKey, maskKey } from '../gateway/my-key.mjs';
import { organizationData } from '../gateway/organization/resolve.mjs';
import { createBroker, runHelper } from './key-reset-broker.mjs';

const hasPython = await new Promise((resolve, reject) => {
  const child = spawn('python3', ['--version'], { stdio: 'ignore' });
  child.on('error', error => error.code === 'ENOENT' ? resolve(false) : reject(error));
  child.on('close', code => code === 0 ? resolve(true) : reject(new Error('python3 must be executable')));
});
const options = { skip: hasPython ? false : 'python3 is not installed' };
const API = '/_wp/api/my-key', OLD = 'sk-fixture-old';
const person = { slug: 'member', unionId: 'fixture-union' };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const hash = value => createHash('sha256').update(value).digest('hex');

function files(directory) {
  if (!fs.existsSync(directory)) return {};
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(directory, file), fs.readFileSync(file, 'utf8')];
    }));
}

function fixture(t, { realOrganization = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-reset-integration-'));
  const S = path.join(root, 'state'), K = path.join(root, 'secure'), local = path.join(root, 'broker');
  const R = path.join(S, 'my-key/reset'), keyFile = path.join(K, 'fixture-member.key');
  const organizationFile = path.join(root, 'organization.json'), usersFile = path.join(root, 'users.json');
  const store = path.join(root, 'store.json'), program = path.join(root, 'rotate.py'), modeFile = path.join(root, 'mode');
  for (const directory of [S, K]) fs.mkdirSync(directory, { mode: 0o700 });
  const organization = { server: { publicOrigin: 'https://workspace.example.test' },
    runtime: { stateDirectory: S, secureDirectory: K },
    model: { baseUrl: 'http://models.example.test/v1', keyPrefix: 'fixture-' },
    myKey: { allow: ['member'], reset: { enabled: true, blocked: [], blockedNote: '' } } };
  const save = () => write(organizationFile, organization); save(); write(usersFile, [person]);
  const original = [{ id: 'fixture-entry', secret: OLD, masked: 'fixture-mask', name: 'fixture-caller',
    enabled: true, models: ['fixture-model'], limits: [{ period: 'day', value: 123 }], custom: { keep: true } }];
  write(store, original); fs.writeFileSync(keyFile, OLD + '\n', { mode: 0o600 }); fs.writeFileSync(modeFile, 'ok');
  fs.writeFileSync(program, `import json,sys
filename, identifier, mode_file = sys.argv[1:]
value = sys.stdin.read().strip()
with open(mode_file) as stream: mode = stream.read()
if mode == 'fail': sys.exit(2)
with open(filename) as stream: rows = json.load(stream)
if any(row['secret'] == value for row in rows): sys.exit(3)
entry = next(row for row in rows if row['id'] == identifier)
entry['secret'] = value
with open(filename, 'w') as stream: json.dump(rows, stream)
print(value)
`);
  const config = { gatewayHost: { command: ['sh', '-c'], organizationFile, usersFile, stateDirectory: S, secureDirectory: K },
    keyStore: { command: ['sh', '-c'], file: store, rotate: ['python3', program, store, '{id}', modeFile] },
    stateDirectory: local, newKeyPrefix: 'sk-test-', dailyLimit: 3 };
  const handlers = [], brokers = [], timers = new Map(), calls = [], replies = [], logs = [], events = [], snapshots = [];
  const accepts = value => read(store).filter(row => row.secret === value).length === 1;
  // Only the upstream HTTP transport is replaced. Authentication reads the actual rotated store.
  t.mock.method(http, 'request', (url, settings, callback) => {
    const req = new PassThrough();
    req.on('finish', () => {
      const res = new PassThrough();
      res.statusCode = accepts(settings.headers.authorization.replace(/^Bearer /, '')) ? 200 : 401;
      callback(res);
      res.end(JSON.stringify(url.pathname.endsWith('/me')
        ? { name: 'fixture-caller', limits: [], models: [{ id: 'fixture-model' }] } : {}));
    });
    return req;
  });
  t.mock.method(console, 'error', value => logs.push(value));
  const runtime = Object.fromEntries(['rekey', 'inspect', 'restart'].map(name => [name, async slug => {
    calls.push([name, slug]); return name === 'inspect' ? { exists: true, running: true } : undefined;
  }]));
  let handler;
  function makeHandler() {
    handler = createMyKey({ organization, organizationData: () => realOrganization
      ? organizationData({ WORKPARTNER_ORG_DIR: root }) : read(organizationFile),
      authenticate: req => req.headers.cookie === 'session=member' ? person : null,
      keyFor: () => fs.readFileSync(keyFile, 'utf8'), runtime,
      restarted: slug => calls.push(['restarted', slug]), timeoutMs: 1000,
      // Hold polling at the file boundary so delivery/restart windows are deterministic.
      timers: { setTimeout(fn, ms) { const token = {}; timers.set(token, { fn, ms }); return token; },
        clearTimeout(token) { timers.delete(token); } },
      timing: { pollIntervalMs: 2, retryDelayMs: 2, verifyDelayMs: 2 } });
    handlers.push(handler); return handler;
  }
  makeHandler();
  const route = (kind, id) => path.join(R, kind, id + '.json');
  const next = id => keyFile + '.' + id + '.next';
  const audit = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const gatewayAudit = () => audit(path.join(S, 'my-key/audit.log'));
  const brokerAudit = () => audit(path.join(local, 'audit.log'));
  const snapshot = () => snapshots.push({ shared: files(R), local: files(local), gateway: gatewayAudit() });
  async function run(request) {
    const response = await runHelper(request); // Real sources, bootstrap and local Python processes.
    events.push({ op: request.op, response }); snapshot();
    return response;
  }
  function broker(overrides = {}) {
    const service = createBroker(config, { run, log: line => logs.push(line), ...overrides });
    brokers.push(service); return service;
  }
  async function startBroker(overrides) {
    // Protocol prerequisite: the broker waits for a directory from an earlier My key audit write.
    fs.mkdirSync(path.dirname(R), { mode: 0o700 });
    const service = broker(overrides); await service.cycle();
    assert.ok(Number.isFinite(Date.parse(read(path.join(R, 'broker.json')).at)));
    return service;
  }
  async function request(method = 'GET', suffix = '/reset') {
    const req = Readable.from(method === 'POST' ? [Buffer.from('{"confirm":"reset"}')] : []);
    req.method = method; req.headers = { cookie: 'session=member', origin: organization.server.publicOrigin, 'content-type': 'application/json' };
    let status, headers, body;
    const res = { writeHead(code, fields) { status = code; headers = fields; }, end(value = '') { body = value; } };
    assert.equal(await handler(req, res, new URL(API + suffix, organization.server.publicOrigin)), true);
    assert.equal(headers['cache-control'], 'no-store'); replies.push(body);
    return { status, data: JSON.parse(body) };
  }
  async function settled(status) {
    for (let i = 0; i < 200; i++) {
      for (const [token, { fn, ms }] of [...timers]) if (ms < 60000) { timers.delete(token); fn(); }
      const response = await request();
      if (response.data.status === status) { snapshot(); return response.data; }
      await sleep(5);
    }
    assert.fail('Gateway did not settle: ' + JSON.stringify({ status, logs, calls }));
  }
  async function accept() {
    assert.equal((await request('POST')).status, 202);
    const row = read(route('active', person.slug));
    assert.deepEqual(read(route('requests', row.id)), { ...row, slug: person.slug });
    assert.equal((await request()).data.status, 'pending'); snapshot(); return row.id;
  }
  function forge() {
    const id = randomBytes(16).toString('hex'), temp = path.join(R, 'tmp', id);
    write(temp, { id, slug: person.slug, at: new Date().toISOString() }); fs.renameSync(temp, route('requests', id)); return id;
  }
  async function replaceHandler() { handler.close(); await sleep(0); return makeHandler(); }
  function secretFree(...values) {
    snapshot();
    const exposed = JSON.stringify({ snapshots, replies, logs, events });
    for (const value of values) assert.equal(exposed.includes(value), false, 'Key leaked outside secure files/store');
  }
  t.after(async () => {
    handlers.forEach(value => value.close()); brokers.forEach(value => value.close());
    await sleep(0); fs.rmSync(root, { recursive: true, force: true });
  });
  return { S, R, K, local, keyFile, store, original, organization, save, config, modeFile, route, next, accepts, events, calls,
    request, settled, accept, forge, broker, startBroker, run, replaceHandler, gatewayAudit, brokerAudit, secretFree };
}

function installed(f, id, before, left) {
  const value = fs.readFileSync(f.keyFile, 'utf8'), after = fs.statSync(f.keyFile);
  assert.ok(value.startsWith(f.config.newKeyPrefix)); assert.notEqual(value, OLD);
  for (const field of ['ino', 'mode', 'uid', 'gid']) assert.equal(after[field], before[field]);
  assert.deepEqual(read(f.store), [{ ...f.original[0], secret: value }]);
  assert.equal(f.accepts(value), true); assert.equal(f.accepts(OLD), false); assert.equal(f.accepts('sk-unrelated'), false);
  assert.equal(fs.existsSync(f.next(id)), false); assert.equal(fs.existsSync(f.route('active', person.slug)), false);
  assert.equal(fs.existsSync(f.route('results', id)), false);
  assert.ok(f.gatewayAudit().some(row => row.id === id && row.result === 'ok' && row.verified === true));
  assert.ok(f.brokerAudit().some(row => row.id === id && row.code === 'ok' && ['ok', 'resumed'].includes(row.result)));
  assert.deepEqual(f.calls.slice(-4), ['rekey', 'inspect', 'restart', 'restarted'].map(name => [name, person.slug]));
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(read(f.route('days', person.slug + '-' + day)).completed.length, 3 - left);
  assert.equal(read(path.join(f.local, 'days', day + '.json'))[person.slug].done.length, 3 - left);
  f.secretFree(OLD, value); return value;
}

test('integration: real gateway and broker rotate, install the same inode and keep records secret', options, async t => {
  const f = fixture(t), before = fs.statSync(f.keyFile), service = await f.startBroker();
  const state = (await f.request('GET', '')).data.reset;
  assert.equal(state.allowed, true); assert.equal(state.left, 3);
  const id = await f.accept(); await service.cycle();
  assert.equal(read(f.route('results', id)).code, 'ok');
  assert.equal(fs.readFileSync(f.keyFile, 'utf8'), OLD + '\n');
  const staged = fs.readFileSync(f.next(id), 'utf8').trim();
  assert.equal(f.accepts(staged), true); assert.equal(f.accepts(OLD), false);
  assert.deepEqual(f.events.filter(event => ['claim', 'rotate', 'finish'].includes(event.op)).map(event => event.op), ['claim', 'rotate', 'finish']);
  f.secretFree(OLD, staged);
  const status = await f.settled('done'); assert.equal(status.code, 'ok'); assert.equal(status.left, 2);
  const value = installed(f, id, before, 2); assert.equal(value, staged); assert.equal(f.calls.length, 4);
  const view = (await f.request('GET', '')).data;
  assert.equal(view.key.masked, maskKey(value)); assert.deepEqual(view.models, [{ id: 'fixture-model', label: 'fixture-model' }]);
  f.secretFree(OLD, value);
});

test('integration: both sides deny blocked people, including forged requests', options, async t => {
  const f = fixture(t), service = await f.startBroker();
  for (const blocked of [[person.slug], [person.unionId], ['*'], undefined, null]) {
    f.organization.myKey.reset.blocked = blocked; f.save();
    const before = files(f.R), response = await f.request('POST');
    assert.equal(response.status, 403); assert.equal(response.data.reason, 'blocked'); assert.deepEqual(files(f.R), before);
    const id = f.forge(); await service.cycle();
    assert.equal(read(f.route('results', id)).code, 'denied'); assert.equal(fs.existsSync(f.next(id)), false);
    assert.equal(fs.readFileSync(f.keyFile, 'utf8'), OLD + '\n'); assert.deepEqual(read(f.store), f.original);
  }
  assert.deepEqual(f.calls, []); assert.equal(f.events.some(event => event.op === 'rotate'), false); f.secretFree(OLD);
});

test('integration: real organization defaults and the broker deny an omitted block list', options, async t => {
  const f = fixture(t, { realOrganization: true }), service = await f.startBroker();
  f.organization.myKey.reset = { enabled: true }; f.save();
  const view = await f.request('GET', '');
  assert.equal(view.status, 200); assert.equal(view.data.reset.reason, 'blocked'); assert.equal(view.data.reset.allowed, false);
  const response = await f.request('POST');
  assert.equal(response.status, 403); assert.equal(response.data.reason, 'blocked');
  assert.deepEqual(fs.readdirSync(path.join(f.R, 'requests')), []);
  const id = f.forge(); await service.cycle();
  assert.equal(read(f.route('results', id)).code, 'denied'); assert.equal(fs.existsSync(f.next(id)), false);
  assert.equal(fs.readFileSync(f.keyFile, 'utf8'), OLD + '\n'); assert.deepEqual(read(f.store), f.original);
  assert.deepEqual(f.calls, []); assert.equal(f.events.some(event => event.op === 'rotate'), false); f.secretFree(OLD);
});

test('integration: no broker heartbeat refuses without creating state or changing the key', options, async t => {
  const f = fixture(t);
  assert.equal((await f.request('GET', '')).data.reset.reason, 'unavailable');
  const response = await f.request('POST');
  assert.equal(response.status, 503); assert.equal(response.data.reason, 'unavailable');
  assert.deepEqual(fs.readdirSync(f.S), []); assert.equal(fs.existsSync(f.local), false);
  assert.equal(fs.readFileSync(f.keyFile, 'utf8'), OLD + '\n'); assert.deepEqual(read(f.store), f.original);
  assert.deepEqual(f.calls, []); f.secretFree(OLD);
});

test('integration: failed rotation cleans staging and allows a successful retry', options, async t => {
  const f = fixture(t), before = fs.statSync(f.keyFile), service = await f.startBroker();
  fs.writeFileSync(f.modeFile, 'fail'); const id = await f.accept(); await service.cycle();
  const result = read(f.route('results', id)); assert.equal(result.ok, false); assert.equal(result.code, 'rotate-failed');
  assert.equal(fs.existsSync(f.next(id)), false);
  const status = await f.settled('failed');
  assert.equal(status.code, 'rotate-failed'); assert.equal(status.left, 3); assert.equal(status.allowed, true);
  assert.equal(fs.readFileSync(f.keyFile, 'utf8'), OLD + '\n'); assert.deepEqual(read(f.store), f.original);
  assert.deepEqual(f.calls, []); f.secretFree(OLD);
  fs.writeFileSync(f.modeFile, 'ok'); const retry = await f.accept(); assert.notEqual(retry, id);
  await service.cycle(); assert.equal((await f.settled('done')).left, 2); installed(f, retry, before, 2);
});

test('integration: a replacement gateway recovers an ok result before installation', options, async t => {
  const f = fixture(t), before = fs.statSync(f.keyFile), service = await f.startBroker();
  const id = await f.accept(); await service.cycle();
  assert.equal(read(f.route('results', id)).ok, true); assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(f.keyFile, 'utf8'), OLD + '\n');
  await f.replaceHandler(); assert.equal((await f.settled('done')).left, 2);
  installed(f, id, before, 2); assert.equal(f.calls.length, 4);
});

test('integration: a replacement broker resolves rotation by hash and delivers to the gateway', options, async t => {
  const f = fixture(t), before = fs.statSync(f.keyFile);
  const service = await f.startBroker({ run: async request => {
    if (request.op === 'which') throw new Error('fixture store lookup unavailable');
    const response = await f.run(request);
    if (request.op === 'rotate') throw new Error('fixture lost rotation reply');
    return response;
  } });
  const id = await f.accept(); await service.cycle();
  const staged = fs.readFileSync(f.next(id), 'utf8').trim();
  assert.equal(f.accepts(staged), true); assert.equal(f.accepts(OLD), false);
  const inflight = read(path.join(f.local, 'inflight', id + '.json'));
  assert.equal(inflight.current, hash(OLD)); assert.equal(inflight.next, hash(staged));
  assert.equal(fs.existsSync(f.route('results', id)), false); assert.ok(fs.existsSync(f.route('claimed', id)));
  assert.equal((await f.request()).data.status, 'pending'); assert.deepEqual(f.calls, []); f.secretFree(OLD, staged);
  service.close(); const replacement = f.broker(); await replacement.cycle();
  assert.deepEqual(f.events.find(event => event.op === 'which').response.present, [false, true]);
  assert.equal(f.events.filter(event => event.op === 'rotate').length, 1);
  assert.equal(read(f.route('results', id)).ok, true);
  assert.equal(fs.existsSync(path.join(f.local, 'inflight', id + '.json')), false);
  assert.equal((await f.settled('done')).left, 2); assert.equal(installed(f, id, before, 2), staged);
  assert.equal(f.calls.length, 4); assert.ok(f.brokerAudit().some(row => row.id === id && row.result === 'resumed'));
});

test('integration: both daily counters refuse the fourth success, including a forged request', options, async t => {
  const f = fixture(t), before = fs.statSync(f.keyFile), service = await f.startBroker(), values = [OLD];
  for (let i = 0; i < 3; i++) {
    const id = await f.accept(); await service.cycle();
    assert.equal((await f.settled('done')).left, 2 - i); values.push(installed(f, id, before, 2 - i));
    for (const value of values.slice(0, -1)) assert.equal(f.accepts(value), false);
  }
  assert.equal(new Set(values).size, 4); assert.equal(f.calls.length, 12);
  const beforeRefusal = files(f.R), response = await f.request('POST');
  assert.equal(response.status, 429); assert.equal(response.data.reason, 'limit'); assert.deepEqual(files(f.R), beforeRefusal);
  const store = read(f.store), key = fs.readFileSync(f.keyFile, 'utf8');
  service.close(); const replacement = f.broker(), id = f.forge(); await replacement.cycle();
  const result = read(f.route('results', id)); assert.equal(result.ok, false); assert.equal(result.code, 'limit');
  assert.equal(fs.existsSync(f.next(id)), false); assert.equal(fs.readFileSync(f.keyFile, 'utf8'), key);
  assert.deepEqual(read(f.store), store); assert.equal(f.events.filter(event => event.op === 'rotate').length, 3);
  assert.equal(f.calls.length, 12); f.secretFree(...values);
});
