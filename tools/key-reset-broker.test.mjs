import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { BOOTSTRAP, createBroker, loadConfig, runHelper, validateConfig } from './key-reset-broker.mjs';

const bootstrap = `python3 -I -c 'import sys,json;d=json.load(sys.stdin);exec(compile(d["source"],"helper","exec"),{"REQUEST":d})'`;
const sources = Object.fromEntries(['gateway-host', 'key-store'].map(name =>
  [name, fs.readFileSync(new URL(`./key-reset/${name}.py`, import.meta.url), 'utf8')]));
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = number => number.toString(16).padStart(32, '0');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });

function execute(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-reset-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const S = path.join(root, 'state'), K = path.join(root, 'secure'), local = path.join(root, 'broker');
  fs.mkdirSync(path.join(S, 'my-key'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(K, { mode: 0o700 });
  const organizationFile = path.join(root, 'organization.json'), usersFile = path.join(root, 'users.json');
  const store = path.join(root, 'store.json'), program = path.join(root, 'rotate.py');
  const modeFile = path.join(root, 'mode'), argvFile = path.join(root, 'argv');
  fs.writeFileSync(modeFile, 'ok');
  const organization = { model: { keyPrefix: 'model-' }, myKey: { allow: ['*'], reset: { enabled: true, blocked: [] } } };
  write(organizationFile, organization);
  write(usersFile, [{ slug: 'alpha', unionId: 'made-up-union-a' }, { slug: 'beta', unionId: 'made-up-union-b' }]);
  const original = [{ id: 'entry-a', secret: 'fixture-old-alpha-key', masked: 'old-mask', name: 'example-a',
    limits: [{ period: 'day', value: 123 }], models: ['example-model'], enabled: true },
  { id: 'entry-b', secret: 'fixture-old-beta-key', masked: 'other-mask', custom: { keep: true } }];
  write(store, original);
  for (const [slug, row] of [['alpha', original[0]], ['beta', original[1]]])
    fs.writeFileSync(path.join(K, `model-${slug}.key`), row.secret + '\n', { mode: 0o600 });
  fs.writeFileSync(program, `import json,sys
filename, identifier, mode_file, argv_file = sys.argv[1:]
with open(argv_file, 'a') as out: out.write(json.dumps(sys.argv) + '\\n')
value = sys.stdin.read().strip()
with open(filename) as stream: rows = json.load(stream)
with open(mode_file) as stream: mode = stream.read()
if mode == 'fail' or value.startswith('reserved-') or any(r['secret'] == value for r in rows): sys.exit(2)
entry = next(r for r in rows if r['id'] == identifier)
entry['secret'], entry['masked'] = value, 'new-mask'
if mode == 'drift':
    entry['enabled'] = False
    rows.append({'id':'extra-entry', 'secret':'fixture-extra-key', 'masked':'extra-mask'})
if mode == 'unknown': entry['secret'] = 'fixture-unexpected-value'
with open(filename, 'w') as stream: json.dump(rows, stream)
print(value)
if mode == 'changed-fail': sys.exit(3)
`);
  const gatewayHost = { command: ['sh', '-c'], organizationFile, usersFile, stateDirectory: S, secureDirectory: K };
  const keyStore = { command: ['sh', '-c'], file: store, rotate: ['python3', program, store, '{id}', modeFile, argvFile] };
  const config = { gatewayHost, keyStore, stateDirectory: local, pollSeconds: 5, dailyLimit: 3,
    windowSeconds: 120, newKeyPrefix: 'sk-wp-' };
  const R = path.join(S, 'my-key/reset');
  const captures = [];
  async function helper(host, op, args = {}) {
    const base = host === 'gateway-host' ? gatewayHost : { file: store };
    const result = await execute(['sh', '-c', bootstrap], JSON.stringify({ source: sources[host], op, args: { ...base, ...args } }));
    captures.push(result);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    return JSON.parse(result.stdout);
  }
  async function request(number = 1, slug = 'alpha', at = new Date().toISOString(), extras = {}) {
    await helper('gateway-host', 'poll');
    const row = { id: identifier(number), slug, at, ...extras };
    write(path.join(R, 'requests', row.id + '.json'), row);
    return row;
  }
  const result = row => read(path.join(R, 'results', row.id + '.json'));
  const next = row => path.join(K, `model-${row.slug}.key.${row.id}.next`);
  const install = row => fs.renameSync(next(row), path.join(K, `model-${row.slug}.key`));
  const logs = [];
  function broker(options = {}) {
    const service = createBroker(config, { log: line => logs.push(line), ...options });
    t.after(() => service.close());
    return service;
  }
  return { root, S, K, R, local, config, helper, request, result, next, install, captures, broker, logs,
    organization, organizationFile, usersFile, store, original, modeFile, argvFile };
}

test('helpers stage, identify, rotate, inspect and finish through the bootstrap without exposing values', async t => {
  const f = fixture(t), row = await f.request(), value = 'fixture-new-alpha-key';
  const poll = await f.helper('gateway-host', 'poll', { heartbeat: true });
  assert.equal(poll.requests[0].allowed, true);
  assert.equal(read(path.join(f.R, 'broker.json')).at, poll.now);
  assert.ok(Math.abs(Date.now() - Date.parse(poll.now)) < 5000);
  assert.deepEqual(await f.helper('key-store', 'ping'), { ok: true });
  const claim = await f.helper('gateway-host', 'claim', { ...row, stage: true, next: value });
  assert.deepEqual(claim, { claimed: true, allowed: true, key: true, current: hash(f.original[0].secret) });
  const keyInfo = fs.statSync(path.join(f.K, 'model-alpha.key')), nextInfo = fs.statSync(f.next(row));
  assert.equal(nextInfo.mode & 0o777, 0o600);
  assert.equal(nextInfo.uid, keyInfo.uid); assert.equal(nextInfo.gid, keyInfo.gid);
  assert.equal(fs.readFileSync(f.next(row), 'utf8'), value + '\n');
  assert.deepEqual(await f.helper('key-store', 'which', { hashes: [claim.current, hash(value)] }), { present: [true, false] });
  assert.deepEqual(await f.helper('key-store', 'rotate', { current: claim.current, next: value, rotate: f.config.keyStore.rotate }),
    { ok: true, drift: [], entries: true });
  assert.deepEqual(read(f.store), [{ ...f.original[0], secret: value, masked: 'new-mask' }, f.original[1]]);
  assert.deepEqual(await f.helper('gateway-host', 'inspect', row), {
    request: false, claimed: true, result: null, current: claim.current, next: hash(value),
  });
  assert.deepEqual(await f.helper('gateway-host', 'finish', { ...row, ok: true, code: 'ok' }), { done: true });
  assert.equal(f.result(row).ok, true);
  assert.equal(fs.existsSync(path.join(f.R, 'claimed', row.id + '.json')), false);
  assert.deepEqual(await f.helper('gateway-host', 'finish', { ...row, ok: false, code: 'interrupted' }), { done: true, already: true });
  assert.equal(f.result(row).ok, true); assert.ok(fs.existsSync(f.next(row)));
  for (const secret of [value, f.original[0].secret]) assert.ok(!JSON.stringify(f.captures).includes(secret));
});

test('helpers leave a missing my-key directory untouched and create protocol directories privately', async t => {
  const f = fixture(t);
  fs.rmdirSync(path.join(f.S, 'my-key'));
  assert.deepEqual(await f.helper('gateway-host', 'poll', { heartbeat: true }), { ready: false });
  assert.deepEqual(await f.helper('gateway-host', 'finish', { id: identifier(1), slug: 'alpha', ok: false, code: 'interrupted' }),
    { done: true, already: true });
  assert.deepEqual(fs.readdirSync(f.S), []);
  fs.mkdirSync(path.join(f.S, 'my-key'), { mode: 0o700 });
  await f.helper('gateway-host', 'poll');
  for (const relative of ['', 'tmp', 'active', 'requests', 'claimed', 'results']) {
    const info = fs.statSync(path.join(f.R, relative));
    assert.equal(info.mode & 0o777, 0o700);
    assert.equal(info.uid, fs.statSync(path.dirname(path.join(f.R, relative))).uid);
  }
});

test('broker rotates two times with independent values, preserves fields and never exposes keys', async t => {
  assert.equal(BOOTSTRAP, bootstrap);
  const f = fixture(t), argvLog = path.join(f.root, 'helper-argv'), wrapper = path.join(f.root, 'wrapper.sh');
  fs.writeFileSync(wrapper, '#!/bin/sh\nlog="$1"\nshift\nprintf "%s\\n" "$@" >> "$log"\nexec sh -c "$@"\n', { mode: 0o700 });
  f.config.gatewayHost.command = [wrapper, argvLog]; f.config.keyStore.command = [wrapper, argvLog];
  const service = f.broker(), values = [];
  for (let number = 1; number <= 2; number++) {
    const row = await f.request(number);
    await service.cycle();
    assert.equal(f.result(row).ok, true);
    const value = fs.readFileSync(f.next(row), 'utf8').trim(); values.push(value);
    assert.match(value, /^sk-wp-[A-Za-z0-9_-]{56}$/); assert.equal(value.length, 62);
    assert.deepEqual(read(f.store), [{ ...f.original[0], secret: value, masked: 'new-mask' }, f.original[1]]);
    assert.deepEqual(fs.readdirSync(path.join(f.R, 'claimed')), []);
    f.install(row);
  }
  assert.notEqual(values[0], values[1]);
  function content(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory()
      ? content(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name), 'utf8')).join('\n');
  }
  const exposed = [content(f.local), content(f.R), JSON.stringify(f.logs), fs.readFileSync(argvLog, 'utf8'),
    fs.readFileSync(f.argvFile, 'utf8')].join('\n');
  for (const value of [...values, ...f.original.map(row => row.secret)]) assert.ok(!exposed.includes(value));
  for (const entry of fs.readdirSync(f.local, { withFileTypes: true }))
    assert.equal(fs.statSync(path.join(f.local, entry.name)).mode & 0o777, entry.isDirectory() ? 0o700 : 0o600);
});

test('policy denies invalid settings and uses the same admission requirement as the gateway', async t => {
  for (const change of [
    f => { f.organization.myKey.reset.enabled = false; },
    f => { delete f.organization.myKey.reset; },
    f => { f.organization.myKey.reset.enabled = 'true'; },
    f => { f.organization.myKey.allow = ['someone-else']; },
    f => { f.organization.myKey.allow = [42, '*']; },
    f => { f.organization.myKey.reset.blocked = ['alpha']; },
    f => { f.organization.myKey.reset.blocked = ['made-up-union-a']; },
    f => { f.organization.myKey.reset.blocked = ['*']; },
    f => { f.organization.myKey.reset.blocked = '*'; },
    f => { delete f.organization.myKey.reset.blocked; },
    f => { write(f.usersFile, [{ slug: 'alpha' }]); },
    f => { fs.unlinkSync(f.usersFile); },
    f => { write(f.usersFile, {}); },
  ]) {
    const f = fixture(t); change(f); write(f.organizationFile, f.organization);
    const row = await f.request(), service = f.broker();
    await service.cycle(); service.close();
    assert.equal(f.result(row).code, 'denied'); assert.deepEqual(read(f.store), f.original);
    assert.equal(fs.existsSync(f.next(row)), false);
  }
  for (const malformed of [true, false]) {
    const f = fixture(t), row = await f.request();
    if (malformed) fs.writeFileSync(f.organizationFile, '{'); else fs.unlinkSync(f.organizationFile);
    const service = f.broker(); await service.cycle();
    assert.equal(fs.existsSync(path.join(f.R, 'results', row.id + '.json')), false);
    assert.deepEqual(read(f.store), f.original);
    write(f.organizationFile, f.organization); await service.cycle(); service.close();
    assert.equal(f.result(row).code, 'denied'); assert.deepEqual(read(f.store), f.original);
  }
});

test('policy changes between polls and between poll and claim take effect', async t => {
  const f = fixture(t), service = f.broker();
  let row = await f.request(1); await service.cycle(); f.install(row);
  f.organization.myKey.reset.enabled = false; write(f.organizationFile, f.organization);
  row = await f.request(2); await service.cycle(); assert.equal(f.result(row).code, 'denied');
  service.close();
  f.organization.myKey.reset.enabled = true; write(f.organizationFile, f.organization);
  const changed = f.broker({ run: async request => {
    if (request.op === 'claim' && request.args.stage) {
      f.organization.myKey.reset.blocked = ['alpha']; write(f.organizationFile, f.organization);
    }
    return runHelper(request);
  } });
  row = await f.request(3); await changed.cycle(); assert.equal(f.result(row).code, 'denied');
  assert.equal(fs.existsSync(f.next(row)), false);
});

test('daily limit is independent, durable, resets at UTC midnight and caps started attempts', async t => {
  const f = fixture(t); let time = Date.now();
  let service = f.broker({ now: () => time });
  for (let number = 1; number <= 3; number++) {
    const row = await f.request(number, 'alpha', undefined, { done: [], started: 0, dailyLimit: 999 });
    await service.cycle(); assert.equal(f.result(row).ok, true); f.install(row);
  }
  service.close(); service = f.broker({ now: () => time });
  let row = await f.request(4); await service.cycle(); assert.equal(f.result(row).code, 'limit');
  time += 86400000;
  row = await f.request(5); await service.cycle(); assert.equal(f.result(row).ok, true); f.install(row);
  const date = new Date(time).toISOString().slice(0, 10);
  write(path.join(f.local, 'days', date + '.json'), { alpha: { started: 6, done: [] } });
  row = await f.request(6); await service.cycle(); assert.equal(f.result(row).code, 'limit');
});

test('age uses the gateway clock in both directions and processed ids are replayed', async t => {
  const f = fixture(t), service = f.broker({ now: () => Date.parse('2035-02-03T12:00:00Z') });
  for (const [number, offset] of [[1, -121000], [2, 121000]]) {
    const row = await f.request(number, 'alpha', new Date(Date.now() + offset).toISOString());
    await service.cycle(); assert.equal(f.result(row).code, 'stale');
  }
  const row = await f.request(3); await service.cycle(); const store = read(f.store); f.install(row);
  // The gateway expires an earlier result before accepting another attempt with this id.
  fs.unlinkSync(path.join(f.R, 'results', row.id + '.json'));
  await f.request(3); await service.cycle();
  assert.equal(f.result(row).code, 'replay'); assert.deepEqual(read(f.store), store);
});

test('hostile request names, bodies, large files and directories are ignored', async t => {
  const f = fixture(t); await f.helper('gateway-host', 'poll');
  for (const [name, body] of [
    ['ABCDEFABCDEFABCDEFABCDEFABCDEFABCD.json', { id: 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCD', slug: 'alpha' }],
    [identifier(2) + '.json', { id: identifier(2), slug: '../x' }],
    [identifier(3) + '.json', { id: identifier(3), slug: 'A' }],
    [identifier(4) + '.json', { id: identifier(4), slug: 'a'.repeat(64) }],
    [identifier(5) + '.json', { id: '../x', slug: 'alpha' }],
    [identifier(6) + '.json', { id: identifier(7), slug: 'alpha' }],
    ['abcdef.json', { id: 'abcdef', slug: 'alpha' }],
    [identifier(8) + '.json', { id: identifier(8), slug: 'alpha', padding: 'x'.repeat(1024 * 1024) }],
  ]) write(path.join(f.R, 'requests', name), body);
  fs.mkdirSync(path.join(f.R, 'requests', identifier(9) + '.json'));
  const target = path.join(f.root, 'untouched'); fs.writeFileSync(target, 'fixture target');
  fs.symlinkSync(target, path.join(f.R, 'requests', identifier(10) + '.json'));
  const row = await f.request(20), service = f.broker(); await service.cycle();
  assert.equal(f.result(row).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(f.R, 'results')), [row.id + '.json']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'fixture target');
  assert.equal(fs.existsSync(path.join(f.root, 'x')), false);
});

test('missing, unknown, duplicate and symlinked keys refuse without changing the store', async t => {
  for (const mode of ['missing', 'unknown', 'duplicate', 'key-link', 'next-link']) {
    const f = fixture(t), row = await f.request(), key = path.join(f.K, 'model-alpha.key');
    const target = path.join(f.root, 'target'); fs.writeFileSync(target, 'fixture-target-key');
    if (mode === 'missing') fs.unlinkSync(key);
    if (mode === 'unknown') fs.writeFileSync(key, 'fixture-unknown-key');
    if (mode === 'duplicate') write(f.store, [...f.original, { ...f.original[0], id: 'entry-duplicate' }]);
    if (mode === 'key-link') { fs.unlinkSync(key); fs.symlinkSync(target, key); }
    if (mode === 'next-link') fs.symlinkSync(target, f.next(row));
    const before = read(f.store), service = f.broker(); await service.cycle(); service.close();
    assert.equal(f.result(row).code, 'no-key', mode); assert.deepEqual(read(f.store), before);
    assert.equal(fs.existsSync(f.next(row)), false); assert.equal(fs.readFileSync(target, 'utf8'), 'fixture-target-key');
  }
});

test('a failed rotate removes staged data, preserves the old key and does not count a success', async t => {
  const f = fixture(t); fs.writeFileSync(f.modeFile, 'fail');
  const row = await f.request(), service = f.broker(); await service.cycle();
  assert.equal(f.result(row).code, 'rotate-failed'); assert.equal(fs.existsSync(f.next(row)), false);
  assert.deepEqual(read(f.store), f.original);
  assert.deepEqual(read(path.join(f.local, 'days', new Date().toISOString().slice(0, 10) + '.json')).alpha, { started: 1, done: [] });
});

test('withdrawal before claim does not rotate or count', async t => {
  const f = fixture(t), row = await f.request();
  const service = f.broker({ run: async request => {
    if (request.op === 'claim') fs.unlinkSync(path.join(f.R, 'requests', row.id + '.json'));
    return runHelper(request);
  } });
  await service.cycle();
  assert.deepEqual(read(f.store), f.original); assert.deepEqual(fs.readdirSync(path.join(f.local, 'days')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.R, 'results')), []);
});

test('store unavailability leaves requests and replay state untouched, then heartbeat resumes', async t => {
  const f = fixture(t), row = await f.request(); let reachable = false, time = Date.now();
  const service = f.broker({ now: () => time, run: request => {
    if (!reachable && request.op === 'ping') throw new Error('fixture transport failure');
    return runHelper(request);
  } });
  await service.cycle();
  assert.equal(fs.existsSync(path.join(f.R, 'broker.json')), false);
  assert.equal(fs.existsSync(path.join(f.R, 'requests', row.id + '.json')), true);
  assert.deepEqual(fs.readdirSync(path.join(f.local, 'seen')), []);
  reachable = true; time += 30000; await service.cycle();
  assert.ok(fs.existsSync(path.join(f.R, 'broker.json'))); assert.equal(f.result(row).ok, true);
});

test('two people rotate sequentially and another process refuses the same local state', async t => {
  const f = fixture(t), first = await f.request(1), second = await f.request(2, 'beta');
  const events = []; let active = false;
  const service = f.broker({ run: async request => {
    assert.equal(active, false); active = true; events.push(request.op);
    try { return await runHelper(request); } finally { active = false; }
  } });
  await service.cycle();
  assert.equal(f.result(first).ok, true); assert.equal(f.result(second).ok, true);
  assert.deepEqual(events.filter(op => ['claim', 'rotate', 'finish'].includes(op)), ['claim', 'rotate', 'finish', 'claim', 'rotate', 'finish']);
  assert.throws(() => f.broker().start(), /broker-running/);
  service.close();
  const other = spawn('python3', ['-I', '-c', 'import sys;sys.stdin.read()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => other.kill());
  const lock = path.join(f.local, 'broker.lock'); fs.mkdirSync(lock, { mode: 0o700 });
  const started = fs.readFileSync(`/proc/${other.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
  fs.writeFileSync(path.join(lock, `${other.pid}-${started}-${identifier(99)}`), '', { mode: 0o600 });
  assert.throws(() => f.broker().start(), /broker-running/);
  other.stdin.end();
  await new Promise(resolve => other.on('close', resolve));
  const restarted = f.broker(); restarted.start(); restarted.close();
});

test('configuration errors identify fields without echoing values and private files are required', t => {
  const f = fixture(t);
  for (const [field, value] of [
    ['gatewayHost.command', []], ['keyStore.command', ['']], ['gatewayHost.organizationFile', 'relative'],
    ['gatewayHost.usersFile', '../users'], ['gatewayHost.stateDirectory', null], ['gatewayHost.secureDirectory', '/tmp/../unsafe'],
    ['keyStore.file', 'relative'], ['keyStore.rotate', ['program']], ['keyStore.rotate', ['program', '{id}', '{id}']],
    ['stateDirectory', 'relative'], ['pollSeconds', 0], ['windowSeconds', 0], ['dailyLimit', 4], ['dailyLimit', 1.5],
    ['newKeyPrefix', 'contains spaces'], ['newKeyPrefix', 'prefix-\n'], ['pollSeconds', null],
  ]) {
    const config = structuredClone(f.config), parts = field.split('.'), parent = parts.length === 2 ? config[parts[0]] : config;
    parent[parts.at(-1)] = value;
    assert.throws(() => validateConfig(config), failure => failure.message === `config.${field}`);
  }
  const filename = path.join(f.root, 'config.json'); write(filename, f.config);
  assert.deepEqual(loadConfig(filename), f.config);
  for (const mode of [0o640, 0o604, 0o644]) {
    fs.chmodSync(filename, mode); assert.throws(() => loadConfig(filename), /config.permissions/);
  }
});

test('ambiguous rotate replies resolve against the store, including a change followed by nonzero exit', async t => {
  for (const mode of ['changed-fail', 'lost-reply', 'unknown-reply']) {
    const f = fixture(t), row = await f.request();
    if (mode === 'changed-fail') fs.writeFileSync(f.modeFile, mode);
    const service = f.broker({ run: async request => {
      const response = await runHelper(request);
      if (request.op === 'rotate' && mode === 'lost-reply') throw new Error('fixture timeout');
      if (request.op === 'rotate' && mode === 'unknown-reply') return { ok: false, code: 'unknown' };
      return response;
    } });
    await service.cycle(); service.close();
    assert.equal(f.result(row).ok, true);
    assert.equal(read(f.store)[0].secret, fs.readFileSync(f.next(row), 'utf8').trim());
    assert.deepEqual(fs.readdirSync(path.join(f.local, 'inflight')), []);
  }
});

test('restart after staging but before rotation returns interrupted and removes the staged value', async t => {
  const f = fixture(t), row = await f.request();
  let service = f.broker({ run: async request => {
    const response = await runHelper(request);
    if (request.op === 'claim') throw new Error('fixture lost claim reply');
    return response;
  } });
  await service.cycle(); service.close();
  assert.ok(fs.existsSync(f.next(row))); assert.deepEqual(fs.readdirSync(path.join(f.local, 'inflight')), []);
  service = f.broker(); await service.cycle();
  assert.equal(f.result(row).code, 'interrupted'); assert.equal(fs.existsSync(f.next(row)), false);
  assert.deepEqual(read(f.store), f.original);
  assert.equal(fs.existsSync(path.join(f.local, 'seen', row.id)), true);
  fs.unlinkSync(path.join(f.R, 'results', row.id + '.json'));
  await f.request(); await service.cycle();
  assert.equal(f.result(row).code, 'replay'); assert.deepEqual(read(f.store), f.original);
});

test('restart after rotation finishes forward and counts once even after a lost finish response', async t => {
  for (const delivered of [false, true]) {
    const f = fixture(t), row = await f.request();
    let service = f.broker({ run: async request => {
      if (request.op === 'finish') {
        if (delivered) await runHelper(request);
        throw new Error('fixture finish response lost');
      }
      return runHelper(request);
    } });
    await service.cycle(); service.close();
    const inflight = read(path.join(f.local, 'inflight', row.id + '.json'));
    assert.deepEqual(Object.keys(inflight).sort(), ['at', 'current', 'decision', 'id', 'next', 'rotationStarted', 'slug']);
    assert.equal(inflight.decision.ok, true); assert.equal(inflight.decision.code, 'ok');
    assert.ok(Number.isFinite(Date.parse(inflight.rotationStarted)));
    assert.equal(inflight.current, hash(f.original[0].secret));
    assert.equal(inflight.next, hash(fs.readFileSync(f.next(row), 'utf8').trim()));
    if (delivered) f.install(row);
    service = f.broker(); await service.cycle(); await service.cycle(); service.close();
    assert.equal(f.result(row).ok, true);
    const days = read(path.join(f.local, 'days', inflight.at.slice(0, 10) + '.json'));
    assert.deepEqual(days.alpha, { started: 1, done: [row.id] });
    assert.deepEqual(fs.readdirSync(path.join(f.local, 'inflight')), []);
  }
});

test('success and failure delivery retry twice without changing the decision', async t => {
  for (const succeeds of [true, false]) {
    const f = fixture(t), row = await f.request(); let calls = 0;
    if (!succeeds) fs.writeFileSync(f.modeFile, 'fail');
    const decisions = [], service = f.broker({ run: async request => {
      if (request.op === 'finish') {
        decisions.push({ ok: request.args.ok, code: request.args.code });
        if (++calls <= 2) throw new Error('fixture unavailable');
      }
      return runHelper(request);
    } });
    await service.cycle(); await service.cycle(); await service.cycle(); await service.cycle();
    assert.equal(f.result(row).ok, succeeds);
    assert.deepEqual(decisions, Array(3).fill({ ok: succeeds, code: succeeds ? 'ok' : 'rotate-failed' }));
    assert.deepEqual(fs.readdirSync(path.join(f.R, 'results')), [row.id + '.json']);
  }
});

test('unresolved attempts stay open, audit only state changes and recover without another rotation', async t => {
  const f = fixture(t), row = await f.request(); fs.writeFileSync(f.modeFile, 'unknown');
  let time = Date.now(), rotates = 0;
  const service = f.broker({ now: () => time, run: async request => {
    if (request.op === 'rotate') rotates++;
    return runHelper(request);
  } });
  await service.cycle(); await service.cycle();
  assert.equal(fs.existsSync(path.join(f.R, 'results', row.id + '.json')), false);
  let audit = fs.readFileSync(path.join(f.local, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter(line => line.result === 'stuck').length, 1);
  assert.equal(audit[0].step, 'rotate');
  time += 600000; await service.cycle();
  audit = fs.readFileSync(path.join(f.local, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter(line => line.result === 'stuck').length, 1);
  assert.equal(audit[0].code, 'rotate-unknown');
  const rows = read(f.store); rows[0].secret = fs.readFileSync(f.next(row), 'utf8').trim(); write(f.store, rows);
  await service.cycle(); assert.equal(f.result(row).ok, true); assert.equal(rotates, 1);
});

test('recovery with inflight hashes can fail safely, wait for the store, or finish an unrecorded success', async t => {
  for (const state of ['current', 'neither', 'unreachable', 'unrecorded-success']) {
    const f = fixture(t), row = await f.request(), value = 'fixture-staged-new-key';
    const claim = await f.helper('gateway-host', 'claim', { ...row, stage: true, next: value });
    const setup = f.broker(); setup.start(); setup.close();
    if (state !== 'unrecorded-success') write(path.join(f.local, 'inflight', row.id + '.json'), {
      id: row.id, slug: row.slug, at: new Date().toISOString(), current: claim.current, next: hash(value),
    });
    if (state === 'neither' || state === 'unrecorded-success') {
      const rows = read(f.store); rows[0].secret = state === 'neither' ? 'fixture-third-key' : value; write(f.store, rows);
    }
    let blocked = state === 'unreachable', time = Date.now();
    const service = f.broker({ now: () => time, run: request => {
      if (blocked && request.op === 'which') throw new Error('fixture unavailable');
      return runHelper(request);
    } });
    await service.cycle();
    if (state === 'neither' || state === 'unreachable') {
      assert.equal(fs.existsSync(path.join(f.R, 'results', row.id + '.json')), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.local, 'audit.log'), 'utf8').trim()).step, 'resume');
      blocked = false; write(f.store, f.original); await service.cycle();
    }
    if (state !== 'unrecorded-success') {
      assert.equal(fs.existsSync(path.join(f.R, 'results', row.id + '.json')), false);
      assert.equal(fs.existsSync(f.next(row)), true);
      time += 600000;
      for (let check = 0; check < 3; check++) await service.cycle();
    }
    assert.equal(f.result(row).code, state === 'unrecorded-success' ? 'ok' : 'rotate-failed');
    assert.equal(fs.existsSync(f.next(row)), state === 'unrecorded-success');
  }
});

test('field drift and entry-count changes are audited without reversing a successful rotation', async t => {
  const f = fixture(t), row = await f.request(); fs.writeFileSync(f.modeFile, 'drift');
  const service = f.broker(); await service.cycle();
  assert.equal(f.result(row).ok, true);
  const audit = JSON.parse(fs.readFileSync(path.join(f.local, 'audit.log'), 'utf8').trim());
  assert.deepEqual(audit.drift, ['enabled']); assert.equal(audit.entries, false);
});

test('helper transport rejects nonzero exits, malformed output, extra lines, size overflow and timeout', async () => {
  for (const source of ["raise SystemExit(2)", "pass", "print('not json')", "print('{}');print('{}')",
    "print('x'*262145)", "print('[]')", "print('{}',end='')", "print('{\"error\":\"fixture\"}')"]) {
    await assert.rejects(runHelper({ command: ['sh', '-c'], source, op: 'test', args: {} }), /^Error: transport-/);
  }
  await assert.rejects(runHelper({ command: ['sh', '-c'], source: 'while True: pass', op: 'test', args: {}, timeoutMs: 30 }), /transport-timeout/);
  assert.deepEqual(await runHelper({ command: ['sh', '-c'], source: "import sys;sys.stderr.write('fixture-secret');print('{}')",
    op: 'test', args: {} }), {});
});

test('direct store calls reject collisions and reserved values, and recognize an already completed rotation', async t => {
  const f = fixture(t), current = hash(f.original[0].secret);
  for (const value of ['reserved-fixture-key', f.original[1].secret]) {
    assert.deepEqual(await f.helper('key-store', 'rotate', { current, next: value, rotate: f.config.keyStore.rotate }),
      { ok: false, code: 'rotate-failed' });
    assert.deepEqual(read(f.store), f.original);
  }
  assert.deepEqual(await f.helper('key-store', 'rotate', { current: hash('fixture-missing-key'),
    next: f.original[0].secret, rotate: f.config.keyStore.rotate }), { ok: true, already: true });
});

test('claim and finish are idempotent and wait for the exact prefix after policy-file loss', async t => {
  const f = fixture(t), row = await f.request();
  f.organization.model.keyPrefix = 'custom-'; write(f.organizationFile, f.organization);
  fs.renameSync(path.join(f.K, 'model-alpha.key'), path.join(f.K, 'custom-alpha.key'));
  await f.helper('gateway-host', 'claim', { ...row, stage: true, next: 'fixture-staged-new-key' });
  fs.unlinkSync(f.organizationFile);
  const next = path.join(f.K, `custom-alpha.key.${row.id}.next`);
  assert.equal((await f.helper('gateway-host', 'inspect', row)).next, null);
  assert.deepEqual(await f.helper('gateway-host', 'finish', { ...row, ok: false, code: 'interrupted' }), { error: 'gateway-failed' });
  assert.equal(fs.existsSync(next), true);
  write(f.organizationFile, f.organization);
  assert.equal((await f.helper('gateway-host', 'inspect', row)).next, hash('fixture-staged-new-key'));
  assert.deepEqual(await f.helper('gateway-host', 'claim', { ...row, stage: false }), { claimed: false });
  assert.deepEqual(await f.helper('gateway-host', 'finish', { ...row, ok: false, code: 'interrupted' }), { done: true });
  assert.equal(fs.existsSync(next), false);
  write(path.join(f.R, 'claimed', row.id + '.json'), row);
  write(path.join(f.R, 'results', row.id + '.json'), { ...row, ok: true, code: 'ok' });
  fs.writeFileSync(next, 'fixture-staged-new-key\n', { mode: 0o600 });
  await f.helper('gateway-host', 'finish', { ...row, ok: false, code: 'interrupted' });
  assert.equal(f.result(row).ok, true); assert.equal(fs.existsSync(next), true);
});

test('symlinked protocol and secure directories never lead writes outside the tree', async t => {
  for (const kind of ['reset', 'secure']) {
    const f = fixture(t), target = path.join(f.root, 'unrelated'); fs.mkdirSync(target);
    if (kind === 'reset') {
      fs.symlinkSync(target, f.R);
      assert.deepEqual(await f.helper('gateway-host', 'poll'), { error: 'gateway-failed' });
    } else {
      const row = await f.request(); fs.rmSync(f.K, { recursive: true }); fs.symlinkSync(target, f.K);
      assert.deepEqual(await f.helper('gateway-host', 'claim', { ...row, stage: true, next: 'fixture-next-key' }),
        { claimed: true, allowed: true, key: false });
    }
    assert.deepEqual(fs.readdirSync(target), []);
  }
});

test('check omits heartbeat, allow admits by slug or union id, and old local records are pruned', async t => {
  const f = fixture(t); let time = Date.now();
  const service = f.broker({ now: () => time });
  assert.equal(await service.check(), true); assert.equal(fs.existsSync(path.join(f.R, 'broker.json')), false);
  for (const [number, allow] of [[1, 'alpha'], [2, 'made-up-union-a']]) {
    f.organization.myKey.allow = [allow]; write(f.organizationFile, f.organization);
    const row = await f.request(number); await service.cycle(); assert.equal(f.result(row).ok, true); f.install(row);
  }
  const oldDay = new Date(time - 8 * 86400000).toISOString().slice(0, 10);
  write(path.join(f.local, 'days', oldDay + '.json'), {});
  const active = path.join(f.R, 'active', 'alpha.json'), temp = path.join(f.R, 'tmp', 'fixture-leftover');
  write(active, { id: identifier(1), at: new Date(time).toISOString() }); write(temp, {});
  time += 3 * 86400000; await service.cycle();
  assert.deepEqual(fs.readdirSync(path.join(f.local, 'seen')), []);
  assert.equal(fs.existsSync(path.join(f.local, 'days', oldDay + '.json')), false);
  assert.equal(fs.existsSync(active), true); assert.equal(fs.existsSync(temp), true);
});

test('stopping during a rotation finishes that attempt and leaves the next person unclaimed', async t => {
  const f = fixture(t), first = await f.request(1), second = await f.request(2, 'beta');
  const service = f.broker({ run: async request => {
    const result = await runHelper(request);
    if (request.op === 'rotate') service.stop();
    return result;
  } });
  await service.cycle(); service.close();
  assert.equal(f.result(first).ok, true);
  assert.ok(fs.existsSync(path.join(f.R, 'requests', second.id + '.json')));
  assert.equal(fs.existsSync(path.join(f.local, 'broker.lock')), false);
});

test('uncertain rotations wait through the quiet period, resume after restart and finish forward when they land', async t => {
  for (const lands of [true, false]) {
    const f = fixture(t), row = await f.request();
    let time = Date.now(), rotations = 0;
    const run = request => {
      if (request.op === 'rotate') { rotations++; throw new Error('fixture timeout'); }
      return runHelper(request);
    };
    let service = f.broker({ now: () => time, run });
    await service.cycle();
    const waiting = () => {
      assert.equal(fs.existsSync(path.join(f.R, 'results', row.id + '.json')), false);
      assert.equal(fs.existsSync(f.next(row)), true);
      assert.equal(fs.existsSync(path.join(f.R, 'claimed', row.id + '.json')), true);
    };
    waiting();
    const second = await f.request(2);
    await service.cycle(); waiting();
    assert.equal(fs.existsSync(path.join(f.R, 'requests', second.id + '.json')), true);
    fs.unlinkSync(path.join(f.R, 'requests', second.id + '.json'));
    time += 599999; await service.cycle(); waiting();
    service.close(); service = f.broker({ now: () => time, run });
    await service.cycle(); waiting();
    if (lands) {
      const rows = read(f.store); rows[0].secret = fs.readFileSync(f.next(row), 'utf8').trim(); write(f.store, rows);
      await service.cycle(); assert.equal(f.result(row).ok, true);
    } else {
      time++; await service.cycle(); waiting();
      service.close(); service = f.broker({ now: () => time, run });
      await service.cycle(); waiting();
      await service.cycle(); assert.equal(f.result(row).code, 'rotate-failed');
      assert.equal(fs.existsSync(f.next(row)), false);
    }
    assert.equal(rotations, 1);
    const audit = fs.readFileSync(path.join(f.local, 'audit.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(audit.filter(line => line.code === 'rotate-unknown').length, 1);
  }
});

test('store helper returns unknown on timeout, OS error or zero exit without a change, and rejects option identifiers', async t => {
  const f = fixture(t), current = hash(f.original[0].secret);
  for (const behavior of ['timeout', 'os-error', 'zero']) {
    const patch = `import subprocess\ndef fixture_run(*args, **kwargs):\n    ${behavior === 'timeout' ? 'raise subprocess.TimeoutExpired("fixture", 60)' : behavior === 'os-error' ? 'raise OSError("fixture")' : 'return subprocess.CompletedProcess([], 0)'}\nsubprocess.run = fixture_run\n`;
    assert.deepEqual(await runHelper({ command: ['sh', '-c'], source: patch + sources['key-store'], op: 'rotate',
      args: { file: f.store, current, next: 'fixture-next-key', rotate: f.config.keyStore.rotate } }), { ok: false, code: 'unknown' });
  }
  write(f.store, [{ ...f.original[0], id: '--fixture-option' }]);
  assert.deepEqual(await f.helper('key-store', 'rotate', { current, next: 'fixture-next-key', rotate: f.config.keyStore.rotate }),
    { ok: false, code: 'rotate-failed' });
  assert.equal(fs.existsSync(f.argvFile), false);
});

test('malformed inflight records are audited once and do not block other requests', async t => {
  const f = fixture(t), service = f.broker(); service.start();
  const bad = identifier(9);
  const claimed = await f.request(9);
  await f.helper('gateway-host', 'claim', { ...claimed, stage: false });
  fs.writeFileSync(path.join(f.local, 'inflight', bad + '.json'), '{"secret":"fixture-sensitive"');
  const row = await f.request(1, 'beta'); await service.cycle(); await service.cycle();
  assert.equal(f.result(row).ok, true);
  const audit = fs.readFileSync(path.join(f.local, 'audit.log'), 'utf8');
  assert.equal(audit.includes('fixture-sensitive'), false);
  const entries = audit.trim().split('\n').map(JSON.parse).filter(line => line.id === bad);
  assert.equal(entries.length, 1); assert.equal(entries[0].result, 'stuck');
});

test('a claim transport failure before rename leaves no replay marker and can retry', async t => {
  const f = fixture(t), row = await f.request(); let fail = true;
  const service = f.broker({ run: request => {
    if (request.op === 'claim' && fail) { fail = false; throw new Error('fixture transport'); }
    return runHelper(request);
  } });
  await service.cycle();
  assert.equal(fs.existsSync(path.join(f.local, 'seen', row.id)), false);
  assert.equal(fs.existsSync(path.join(f.R, 'requests', row.id + '.json')), true);
  await service.cycle(); assert.equal(f.result(row).ok, true);
  assert.equal(fs.existsSync(path.join(f.local, 'seen', row.id)), true);
});

test('successful delivery precedes local counting and a failed count keeps the slug busy until retried', async t => {
  const f = fixture(t), row = await f.request(); let denyCount = true, delivered = false;
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination.startsWith(path.join(f.local, 'days') + path.sep) && delivered && denyCount)
      throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return originalRename(source, destination);
  });
  const service = f.broker({ run: async request => {
    if (request.op === 'finish' && request.args.ok) {
      const days = read(path.join(f.local, 'days', new Date().toISOString().slice(0, 10) + '.json'));
      if (!delivered) assert.deepEqual(days.alpha.done, []);
      delivered = true;
    }
    return runHelper(request);
  } });
  await service.cycle(); assert.equal(f.result(row).ok, true); f.install(row);
  const second = await f.request(2); await service.cycle();
  assert.equal(fs.existsSync(path.join(f.R, 'requests', second.id + '.json')), true);
  assert.equal(fs.existsSync(path.join(f.local, 'inflight', row.id + '.json')), true);
  // A restart also preserves the obligation to count, even though delivery removed the claim.
  service.close(); const replacement = f.broker();
  await replacement.cycle();
  assert.equal(fs.existsSync(path.join(f.R, 'requests', second.id + '.json')), true);
  denyCount = false; await replacement.cycle();
  assert.equal(f.result(second).ok, true);
  const days = read(path.join(f.local, 'days', new Date().toISOString().slice(0, 10) + '.json'));
  assert.deepEqual(days.alpha.done, [row.id, second.id]);
});

test('staged lookup uses the exact configured prefix and slug even when one slug ends with another', async t => {
  const f = fixture(t), row = await f.request(1, 'bob');
  const other = path.join(f.K, `model-a-bob.key.${row.id}.next`);
  fs.writeFileSync(other, 'fixture-other-key');
  assert.equal((await f.helper('gateway-host', 'inspect', row)).next, null);
  await f.helper('gateway-host', 'claim', { ...row, stage: false });
  await f.helper('gateway-host', 'finish', { ...row, ok: false, code: 'no-key' });
  assert.equal(fs.readFileSync(other, 'utf8'), 'fixture-other-key');
});

test('broker lock reclaims a reused PID with a different start time and a stale self PID', async t => {
  const f = fixture(t), service = f.broker(); service.start(); service.close();
  const other = spawn('python3', ['-I', '-c', 'import sys;sys.stdin.read()'], { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => other.kill());
  const started = fs.readFileSync(`/proc/${other.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19];
  for (const [pid, start] of [[other.pid, BigInt(started) + 1n], [process.pid, fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19]]]) {
    const lock = path.join(f.local, 'broker.lock'); fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, `${pid}-${start}-${identifier(99)}`), '', { mode: 0o600 });
    const replacement = f.broker(); replacement.start();
    assert.equal(fs.readdirSync(lock).length, 1);
    assert.ok(fs.readdirSync(lock)[0].startsWith(process.pid + '-'));
    assert.throws(() => f.broker().start(), /broker-running/);
    replacement.close(); assert.equal(fs.existsSync(lock), false);
  }
  const exited = new Promise(resolve => other.on('close', resolve)); other.stdin.end(); await exited;
});

test('broker prunes day files older than seven days while retaining recent counters', async t => {
  const f = fixture(t), time = Date.parse('2030-01-10T12:00:00Z');
  const service = f.broker({ now: () => time }); service.start();
  for (const date of ['2030-01-02', '2030-01-03', '2030-01-04', '2030-01-10'])
    write(path.join(f.local, 'days', date + '.json'), { alpha: { started: 1, done: [identifier(1)] } });
  await service.cycle();
  assert.deepEqual(fs.readdirSync(path.join(f.local, 'days')).sort(), ['2030-01-03.json', '2030-01-04.json', '2030-01-10.json']);
});

test('recovered success without local inflight state retains a failed count across restart', async t => {
  const f = fixture(t), row = await f.request(), value = 'fixture-next-key';
  await f.helper('gateway-host', 'claim', { ...row, stage: true, next: value });
  write(f.store, [{ ...f.original[0], secret: value }, f.original[1]]);
  let fail = true;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (fail && target.startsWith(path.join(f.local, 'days') + path.sep)) throw new Error('fixture count failed');
    return rename(source, target);
  });
  let service = f.broker(); await service.cycle();
  assert.equal(f.result(row).ok, true);
  assert.equal(fs.existsSync(path.join(f.local, 'inflight', row.id + '.json')), true);
  f.install(row); service.close(); fail = false;
  service = f.broker(); await service.cycle();
  const date = new Date().toISOString().slice(0, 10);
  assert.deepEqual(read(path.join(f.local, 'days', date + '.json')).alpha.done, [row.id]);
});
