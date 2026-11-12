import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMyKey, maskKey } from '../my-key.mjs';

const API = '/_wp/api/my-key', OLD = 'sk-test-old-1111', NEW = 'sk-test-new-2222';
const person = { slug: 'member', unionId: 'union-fixture' };
const NOW = Date.parse('2026-11-12T05:30:00Z');
async function until(check) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await sleep(5); }
  assert.fail('Condition did not become true');
}
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'my-key-reset-'));
  const calls = [], logs = [], handlers = [], replies = [];
  let clock = NOW, stored = OLD, advisory = true;
  const organization = { server: { publicOrigin: 'https://workspace.example.test' },
    runtime: { stateDirectory: path.join(directory, 'state'), secureDirectory: path.join(directory, 'secure') },
    model: { baseUrl: 'http://models.example.test/v1', keyPrefix: 'model-' },
    myKey: { allow: ['*'], reset: { enabled: true, blocked: [], blockedNote: '' } } };
  fs.mkdirSync(organization.runtime.secureDirectory, { mode: 0o700 });
  const keyFile = user => path.join(organization.runtime.secureDirectory, `model-${user.slug}.key`);
  fs.writeFileSync(keyFile(person), OLD + '\n', { mode: 0o600 });
  const policyFile = path.join(directory, 'organization.json');
  const save = () => fs.writeFileSync(policyFile, JSON.stringify(organization)); save();
  const root = path.join(organization.runtime.stateDirectory, 'my-key/reset');
  const route = (name, id) => path.join(root, name, id + '.json');
  const put = (name, id, value) => {
    fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
    const tmp = path.join(root, 'tmp', 'fixture-' + id);
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, route(name, id));
  };
  // Exercise the real upstream helper without opening sockets in restricted environments.
  t.mock.method(http, 'request', (url, options, callback) => {
    const req = new PassThrough();
    req.on('finish', () => {
      const res = new PassThrough();
      res.statusCode = advisory && options.headers.authorization === 'Bearer ' + stored ? 200 : 401;
      callback(res);
      const profile = { name: 'fixture-caller', limits: [], models: [{ id: 'fixture-model' }] };
      res.end(JSON.stringify(url.pathname.endsWith('/me') ? profile : {}));
    });
    return req;
  });
  t.mock.method(console, 'error', value => logs.push(value));
  const runtime = { rekey: async () => { calls.push('rekey'); }, inspect: async () => { calls.push('inspect'); return { exists: true, running: true }; },
    restart: async () => { calls.push('restart'); } };
  function make(options = {}) {
    const handler = createMyKey({ organization, organizationData: () => JSON.parse(fs.readFileSync(policyFile, 'utf8')),
      authenticate: req => req.headers.cookie === 'session=member' ? person : null,
      keyFor: user => fs.readFileSync(keyFile(user), 'utf8'), keyFile, runtime, restarted: () => { calls.push('restarted'); },
      now: () => clock, timeoutMs: 20, timing: { pollIntervalMs: 2, retryDelayMs: 2, maxRetryDelayMs: 8, verifyDelayMs: 2, ...extra.timing }, ...options });
    handlers.push(handler); return handler;
  }
  const handler = make(extra);
  const heartbeat = () => {
    if (!fs.existsSync(root)) return;
    const tmp = path.join(root, 'tmp/heartbeat');
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date(clock).toISOString() }), { mode: 0o600 }); fs.renameSync(tmp, path.join(root, 'broker.json'));
  }; heartbeat();
  async function request({ method = 'GET', suffix = '/reset', body = '{"confirm":"reset"}', member = true, headers = {}, handler: target = handler } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method; req.headers = { cookie: member ? 'session=member' : '', origin: organization.server.publicOrigin, 'content-type': 'application/json', ...headers };
    let status, responseHeaders, response;
    const res = { writeHead(code, fields) { status = code; responseHeaders = fields; }, end(value = '') { response = value; } };
    assert.equal(await target(req, res, new URL(API + suffix, organization.server.publicOrigin)), true);
    assert.equal(responseHeaders['cache-control'], 'no-store');
    replies.push(response);
    return { status, body: response, data: response ? JSON.parse(response) : null };
  }
  const post = options => request({ method: 'POST', ...options });
  const active = () => JSON.parse(fs.readFileSync(route('active', person.slug), 'utf8'));
  function claim() {
    const { id } = active(); fs.renameSync(route('requests', id), route('claimed', id)); return id;
  }
  function result(id, ok = true, code = ok ? 'ok' : 'rotate-failed', key = NEW) {
    const next = keyFile(person) + '.' + id + '.next';
    if (ok) { fs.writeFileSync(next, key, { mode: 0o600 }); stored = key; }
    else fs.rmSync(next, { force: true });
    put('results', id, { id, slug: person.slug, ok, code, at: new Date(clock).toISOString() });
    fs.rmSync(route('claimed', id), { force: true });
  }
  const audit = () => {
    try { return fs.readFileSync(path.join(root, '../audit.log'), 'utf8').trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const settled = async status => until(async () => (await request()).data?.status === status);
  t.after(async () => { handlers.forEach(h => h.close()); await sleep(10); fs.rmSync(directory, { recursive: true, force: true }); });
  return { organization, save, policyFile, root, route, put, keyFile, runtime, handler, make, heartbeat, request, post, active, claim, result, audit, settled,
    calls, logs, replies, setClock(value) { clock = value; }, advisory(value) { advisory = value; }, store() { return stored; } };
}

test('reset gates validate session, live admission, methods, origin and JSON before accepting', async t => {
  const f = fixture(t);
  for (const method of ['GET', 'POST']) {
    assert.equal((await f.request({ method, member: false })).status, 401);
    f.organization.myKey.allow = []; f.save();
    assert.deepEqual((await f.request({ method })).body, '');
    assert.equal((await f.request({ method })).status, 404);
    f.organization.myKey.allow = ['*']; f.save();
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await f.request({ method })).status, 405);
  assert.equal((await f.request({ suffix: '/reveal' })).status, 405);
  for (const headers of [{ origin: '' }, { origin: 'https://other.example.test' }, { 'content-type': 'text/plain' }]) assert.equal((await f.post({ headers })).status, 403);
  for (const body of ['{}', '{', 'null', '[]', '"reset"', '{"confirm":true}', '{"confirm":"wrong"}', ' '.repeat(1025)]) assert.equal((await f.post({ body })).status, 400);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'requests')), []);
  assert.deepEqual(f.audit(), []);
});

test('feature disabled or missing runtime hides reset on both routes and the dialog data', async t => {
  const f = fixture(t);
  for (const enabled of [false, undefined, 'true']) {
    f.organization.myKey.reset.enabled = enabled; f.save();
    for (const method of ['GET', 'POST']) { const response = await f.request({ method }); assert.equal(response.status, 404); assert.equal(response.body, ''); }
    assert.equal((await f.request({ suffix: '' })).data.reset, null);
  }
  f.organization.myKey.reset.enabled = true; f.save();
  const handler = f.make({ runtime: undefined });
  assert.equal((await f.post({ handler })).status, 404);
  assert.equal((await f.request({ handler })).status, 404);
  assert.equal((await f.request({ handler, suffix: '' })).data.reset, null);
});

test('blocked policy fails closed, is live, and sanitizes the optional note', async t => {
  const f = fixture(t);
  for (const blocked of [['member'], ['union-fixture'], ['*'], null, [42], 'member', undefined]) {
    f.organization.myKey.reset.blocked = blocked; f.organization.myKey.reset.blockedNote = '  Fixture policy note  '; f.save();
    const response = await f.post(); assert.equal(response.status, 403); assert.equal(response.data.reason, 'blocked');
    const state = (await f.request({ suffix: '' })).data.reset;
    assert.equal(state.reason, 'blocked'); assert.equal(state.note, 'Fixture policy note'); assert.equal(state.allowed, false);
  }
  for (const [note, expected] of [[42, ''], ['x'.repeat(250), 'x'.repeat(200)]]) {
    f.organization.myKey.reset.blockedNote = note; f.save(); assert.equal((await f.request()).data.note, expected);
  }
  f.organization.myKey.reset.blocked = []; f.save(); assert.equal((await f.request()).data.allowed, true);
  fs.writeFileSync(f.policyFile, '{'); assert.equal((await f.post()).status, 404);
});

test('success replaces the same inode, synchronizes runtime once, masks the new key and keeps protocol records secret', async t => {
  const f = fixture(t), before = fs.statSync(f.keyFile(person));
  assert.equal((await f.post()).status, 202);
  const id = f.active().id;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'requests')), [id + '.json']);
  const request = JSON.parse(fs.readFileSync(f.route('requests', id), 'utf8'));
  assert.deepEqual(Object.keys(request).sort(), ['at', 'id', 'slug']); assert.equal(request.slug, person.slug);
  assert.equal(fs.statSync(f.route('requests', id)).mode & 0o777, 0o600);
  assert.equal((await f.request()).data.status, 'pending');
  f.claim(); f.result(id); await f.settled('done');
  assert.deepEqual(f.calls, ['rekey', 'inspect', 'restart', 'restarted']);
  const after = fs.statSync(f.keyFile(person));
  assert.equal(before.ino, after.ino); assert.equal(before.mode, after.mode); assert.equal(before.uid, after.uid);
  assert.equal(fs.readFileSync(f.keyFile(person), 'utf8'), NEW);
  assert.equal((await f.request()).data.left, 2);
  const view = (await f.request({ suffix: '' })).data;
  assert.equal(view.key.masked, maskKey(NEW)); assert.equal(view.models[0].id, 'fixture-model');
  const oldResponse = await new Promise(resolve => {
    const req = http.request(new URL('http://models.example.test/v1/magpie/me'), { headers: { authorization: 'Bearer ' + OLD } }, res => { resolve(res.statusCode); res.resume(); }); req.end();
  });
  assert.equal(oldResponse, 401); assert.equal(f.store(), NEW);
  for (const target of [f.route('active', 'member'), f.route('results', id), f.keyFile(person) + '.' + id + '.next']) assert.equal(fs.existsSync(target), false);
  assert.equal(f.audit().find(line => line.result === 'ok').verified, true);
  const records = ['last', 'days', 'requests', 'progress'].flatMap(name => fs.readdirSync(path.join(f.root, name)).map(entry => fs.readFileSync(path.join(f.root, name, entry), 'utf8')));
  for (const key of [OLD, NEW]) assert.equal(JSON.stringify([f.audit(), f.logs, f.replies, records]).includes(key), false);
  assert.equal((await f.post({ suffix: '/reveal', body: '{"action":"show"}' })).data.key, NEW);
  assert.deepEqual(Object.keys(f.audit().at(-1)).sort(), ['action', 'at', 'slug']);
});

test('runtime restart is skipped for absent and stopped workspaces and advisory rejection never prevents installation', async t => {
  for (const state of [{ exists: false, running: false }, { exists: true, running: false }]) {
    const f = fixture(t); f.advisory(false);
    f.runtime.inspect = async () => { f.calls.push('inspect'); return state; };
    await f.post(); const id = f.claim(); f.result(id); await f.settled('done');
    assert.deepEqual(f.calls, ['rekey', 'inspect']);
    assert.equal(f.audit().find(line => line.result === 'ok').verified, false);
  }
});

test('every broker failure preserves the old bytes and quota and removes staged leftovers', async t => {
  for (const code of ['denied', 'limit', 'stale', 'replay', 'no-key', 'rotate-failed', 'interrupted']) {
    const f = fixture(t), before = fs.readFileSync(f.keyFile(person));
    await f.post(); const id = f.claim(); f.result(id, false, code);
    fs.writeFileSync(f.keyFile(person) + '.' + id + '.next', 'fixture-leftover');
    await f.settled('failed');
    assert.equal((await f.request()).data.code, code); assert.equal((await f.request()).data.left, 3);
    assert.deepEqual(fs.readFileSync(f.keyFile(person)), before); assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.keyFile(person) + '.' + id + '.next'), false);
  }
});

test('offline brokers do not accept attempts and unclaimed requests expire without changing keys', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, 'broker.json'));
  assert.equal((await f.post()).status, 503); assert.equal((await f.request()).data.reason, 'unavailable');
  f.heartbeat(); f.setClock(NOW + 46000); assert.equal((await f.post()).status, 503);
  assert.deepEqual(f.audit(), []); assert.deepEqual(fs.readdirSync(path.join(f.root, 'active')), []);
  f.setClock(NOW); f.heartbeat(); await f.post(); const { id } = f.active();
  f.setClock(NOW + 31000); await f.settled('failed');
  assert.equal((await f.request()).data.code, 'unavailable'); assert.equal(fs.existsSync(f.route('requests', id)), false);
  assert.equal(fs.readFileSync(f.keyFile(person), 'utf8'), OLD + '\n');
});

test('claimed requests never time out and missing staged values remain pending until delivered', async t => {
  const f = fixture(t); await f.post(); const id = f.claim(); f.setClock(NOW + 601000);
  await until(() => f.audit().some(line => line.step === 'broker'));
  assert.equal((await f.request()).data.status, 'pending');
  f.put('results', id, { id, slug: 'member', ok: true, code: 'ok', at: new Date(NOW).toISOString() });
  await until(() => f.audit().some(line => line.step === 'staged-missing'));
  await sleep(20); assert.equal(f.audit().filter(line => line.step === 'staged-missing').length, 1);
  f.result(id); await f.settled('done');
});

test('completed quota survives handler replacement and resets at UTC midnight', async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.post()).status, 202); const id = f.claim(); f.result(id, true, 'ok', NEW + i); await f.settled('done');
    assert.equal((await f.request()).data.left, 2 - i);
  }
  assert.equal((await f.post()).status, 429); assert.equal((await f.request()).data.reason, 'limit');
  f.handler.close(); const handler = f.make();
  assert.equal((await f.post({ handler })).status, 429);
  f.setClock(Date.parse('2026-11-13T00:00:00Z')); f.heartbeat();
  assert.equal((await f.request({ handler })).data.left, 3); assert.equal((await f.request({ handler })).data.status, 'idle');
  assert.equal((await f.post({ handler })).status, 202);
});

test('ten accepted attempts cap repeated failed rotations without consuming completed quota', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await f.post()).status, 202); f.result(f.claim(), false); await f.settled('failed');
  }
  assert.equal((await f.post()).status, 429); assert.equal((await f.request()).data.left, 3);
});

test('concurrent clicks and another handler produce just one request', async t => {
  const f = fixture(t), second = f.make();
  const results = await Promise.all([f.post(), f.post(), f.post({ handler: second })]);
  assert.deepEqual(results.map(r => r.status).sort(), [202, 409, 409]);
  assert.equal(fs.readdirSync(path.join(f.root, 'requests')).length, 1);
  f.result(f.claim()); await f.settled('done'); assert.deepEqual(f.calls, ['rekey', 'inspect', 'restart', 'restarted']);
});

test('startup recovers accepted results, retries runtime failures and ignores already completed installation', async t => {
  const f = fixture(t); f.handler.close(); await sleep(5);
  const id = 'a'.repeat(32), at = new Date(NOW).toISOString();
  f.put('active', 'member', { id, at }); f.result(id);
  let rekeys = 0, restarts = 0;
  f.runtime.rekey = async () => { if (++rekeys <= 2) throw Object.assign(new Error(NEW), { code: OLD }); f.calls.push('rekey'); };
  f.runtime.restart = async () => { if (++restarts <= 2) throw Object.assign(new Error(OLD), { code: 'EIO' }); f.calls.push('restart'); };
  const handler = f.make(); await f.settled('done');
  assert.equal(rekeys, 3); assert.equal(restarts, 3); assert.equal((await f.request()).data.left, 2);
  assert.deepEqual(f.audit().filter(line => line.result === 'retry').map(line => [line.step, line.code]), [['rekey', 'ERROR'], ['restart', 'EIO']]);
  assert.equal(JSON.stringify([f.audit(), f.logs]).includes(NEW), false); assert.equal(JSON.stringify([f.audit(), f.logs]).includes(OLD), false);
  handler.close(); await sleep(5);
  f.put('active', 'member', { id, at }); f.result(id); const before = [...f.calls];
  f.make(); await until(() => !fs.existsSync(f.route('active', 'member')));
  assert.deepEqual(f.calls, before); assert.equal((await f.request()).data.left, 2);
});

test('invalid identities and stale orphan files cannot select paths and are recovered safely', async t => {
  const f = fixture(t); f.handler.close(); await sleep(5);
  fs.writeFileSync(f.route('active', 'member'), '{'); f.make();
  await until(() => !fs.existsSync(f.route('active', 'member')));
  assert.equal(f.audit().at(-1).code, 'invalid');
  const id = 'b'.repeat(32);
  f.put('active', 'member', { id, at: new Date(NOW - 121000).toISOString() });
  const stale = f.route('results', 'c'.repeat(32)), kept = f.route('results', id);
  fs.writeFileSync(stale, '{}'); fs.writeFileSync(kept, '{}');
  for (const file of [stale, kept]) fs.utimesSync(file, new Date(NOW - 7200000), new Date(NOW - 7200000));
  const latest = f.make();
  assert.equal(fs.existsSync(stale), false); assert.equal(fs.existsSync(kept), true);
  latest.close(); await sleep(5); fs.unlinkSync(kept); f.make();
  await until(() => !fs.existsSync(f.route('active', 'member'))); assert.equal(f.audit().at(-1).code, 'invalid');
  const invalid = f.make({ authenticate: () => ({ slug: '../escape', unionId: 'fixture' }) });
  assert.equal((await f.post({ handler: invalid })).status, 404);
});

test('missing keys and request write failures are safe and leave no active reservation', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.keyFile(person)); assert.equal((await f.post()).status, 409); assert.equal((await f.request()).data.reason, 'no-key');
  fs.writeFileSync(f.keyFile(person), OLD);
  fs.rmdirSync(path.join(f.root, 'requests')); fs.writeFileSync(path.join(f.root, 'requests'), 'fixture');
  assert.equal((await f.post()).status, 503); assert.equal(fs.existsSync(f.route('active', 'member')), false);
});

test('installation and recording errors retry without discarding staging or restarting twice', async t => {
  const f = fixture(t), open = fs.openSync, rename = fs.renameSync;
  let installFailures = 0, recordFailures = 0;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === f.keyFile(person) && flags === 'r+' && installFailures++ < 2) throw Object.assign(new Error(NEW), { code: 'EIO' });
    return open(file, flags, ...args);
  });
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target.includes('/days/') && JSON.parse(fs.readFileSync(source, 'utf8')).completed.length && recordFailures++ < 2) {
      assert.ok(fs.existsSync(f.keyFile(person) + '.' + f.active().id + '.next'));
      throw Object.assign(new Error(OLD), { code: 'ENOSPC' });
    }
    return rename(source, target);
  });
  await f.post(); f.result(f.claim()); await f.settled('done');
  assert.deepEqual(f.calls, ['rekey', 'inspect', 'restart', 'restarted']);
  assert.deepEqual(f.audit().filter(line => line.result === 'retry').map(line => line.step), ['install', 'record']);
  assert.equal((await f.request()).data.left, 2);
});

test('separate gateway processes recover one attempt under an exclusive driver lock', async t => {
  const { spawn } = await import('node:child_process');
  const f = fixture(t); f.handler.close(); await sleep(5);
  const id = 'd'.repeat(32), at = new Date(NOW).toISOString();
  f.put('active', 'member', { id, at }); f.result(id); f.put('progress', id, { verified: true });
  const lock = path.join(f.root, 'locks/member');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, '99999999-unknown-' + 'e'.repeat(32)), '');
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { createMyKey } from ${JSON.stringify(new URL('../my-key.mjs', import.meta.url).href)};
    const organization = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const root = path.join(organization.runtime.stateDirectory, 'my-key/reset');
    const call = name => fs.appendFileSync(path.join(root, 'fixture-calls'), name + '\\n');
    const runtime = { rekey: async () => { call('rekey'); await sleep(20); },
      inspect: async () => { call('inspect'); return { exists: true, running: true }; },
      restart: async () => { call('restart'); await sleep(20); } };
    const handler = createMyKey({ organization, organizationData: () => organization, authenticate: () => null,
      keyFor: () => null, runtime, restarted: () => call('restarted'), timing: { pollIntervalMs: 2 }, now: () => ${NOW} });
    for (let i = 0; i < 200 && fs.existsSync(path.join(root, 'active/member.json')); i++) await sleep(5);
    handler.close();
    if (fs.existsSync(path.join(root, 'active/member.json'))) process.exitCode = 1;
  `;
  const scriptFile = path.join(f.root, 'fixture-process.mjs'); fs.writeFileSync(scriptFile, script);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile, f.policyFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.on('error', reject); child.on('close', code => { try { assert.equal(code, 0, output); assert.equal(output, ''); resolve(); } catch (error) { reject(error); } });
  });
  await Promise.all([run(), run()]);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'fixture-calls'), 'utf8').trim().split('\n'), ['rekey', 'inspect', 'restart', 'restarted']);
  assert.equal((await f.request()).data.left, 2); assert.equal((await f.request()).data.status, 'done');
});

test('optional rekey, malformed heartbeats and unrelated results follow the public contract', async t => {
  const f = fixture(t); delete f.runtime.rekey;
  fs.writeFileSync(path.join(f.root, 'broker.json'), '{');
  assert.equal((await f.post()).data.reason, 'unavailable');
  f.heartbeat(); await f.post(); const id = f.claim();
  assert.equal((await f.request({ suffix: '' })).data.reset.status, 'pending');
  f.put('results', id, { id: [id], slug: 'member', ok: true, code: 'ok', at: new Date(NOW).toISOString() });
  await sleep(10); assert.equal((await f.request()).data.status, 'pending'); assert.deepEqual(f.calls, []);
  f.put('results', id, { id, slug: '../outside', ok: true, code: 'ok', at: new Date(NOW).toISOString() });
  await sleep(10); assert.equal((await f.request()).data.status, 'pending'); assert.deepEqual(f.calls, []);
  f.result(id); await f.settled('done');
  assert.deepEqual(f.calls, ['inspect', 'restart', 'restarted']);
});
