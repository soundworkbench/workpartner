import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { createMyKey, maskKey, usageWindows, mapLimits, mapUsage, mapUpstream, publicBaseUrl, USAGE_ZONE } from '../my-key.mjs';
import { myKeyClient } from '../my-key-client.mjs';

const API = '/_wp/api/my-key', NOW = Date.parse('2026-11-12T05:30:00Z');
const people = [{ slug: 'member', unionId: 'union-member' }, { slug: 'second-member', unionId: 'union-second-member' }];
const keys = ['sk-fixture-member-3f9a', 'sk-fixture-other-7b2c'];
const defaults = { codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
const profile = () => ({ name: 'private-caller-name', limits: [], models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] });
const usage = () => ({ calls: 512, cost: 18.4,
  series: [{ time: '2026-11-09T00:00:00Z', calls: 426, cost: 15.2 }, { time: '2026-11-12T00:00:00Z', calls: 80, cost: 3 }, { time: '2026-11-12T03:00:00Z', calls: 6, cost: 0.2 }],
  by: { model: [{ id: 'group/claude-opus-5-5', calls: 400, cost: 12 }, { id: 'group/claude-sonnet-5-5', calls: 112, cost: 6.4 }], callerKey: [{ name: 'private-caller-name' }] },
  callerKeys: [{ name: 'private-caller-name' }], rows: [{ account: 'private-account', host: 'private.example.test', session: 'private-session' }] });

async function fixture(t, { timeoutMs = 150, clock = NOW } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'my-key-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hits = [], reads = [], state = { profile: profile(), usage: usage(), mode: '' };
  const upstream = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers, method: req.method });
    const isProfile = req.url === '/v1/magpie/me';
    if (state.mode === 'hang') return;
    if (state.mode === 'usage-fail' && !isProfile) { res.writeHead(500); return res.end('{}'); }
    if ([403, 500, 302].includes(state.mode)) { res.writeHead(state.mode, { location: '/elsewhere' }); return res.end('{}'); }
    if (state.mode === 'json') return res.end('{');
    if (state.mode === 'oversize') return res.end(' '.repeat(4 * 1024 * 1024 + 1));
    res.end(JSON.stringify(isProfile ? state.profile : state.usage));
  });
  await listen(upstream);
  const organization = { features: { myKey: true }, server: { publicOrigin: 'https://workspace.example.test' },
    runtime: { stateDirectory: path.join(directory, 'state'), secureDirectory: path.join(directory, 'secure') },
    model: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, defaults },
    myKey: { allow: ['*'], publicBaseUrl: 'https://models.example.test', revealSeconds: 30 } };
  const file = path.join(directory, 'organization.json');
  const save = () => fs.writeFileSync(file, JSON.stringify(organization)); save();
  fs.mkdirSync(organization.runtime.secureDirectory);
  const keyFile = user => path.join(organization.runtime.secureDirectory, `model-${user.slug}.key`);
  people.forEach((user, index) => fs.writeFileSync(keyFile(user), keys[index]));
  const user = req => people.find(p => req.headers.cookie === `session=${p.slug}`) || (req.headers.cookie === 'session=pending' ? { unionId: 'union-pending' } : null);
  const handler = createMyKey({ organization, organizationData: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    authenticate: user, keyFor: user => { reads.push(user.slug); return fs.readFileSync(keyFile(user), 'utf8'); }, now: () => clock, timeoutMs });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(418); res.end(); } });
  await listen(server);
  for (const s of [upstream, server]) t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
  function request(route = API, { method = 'GET', member = 'member', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
        headers: { ...(member ? { cookie: 'session=' + member } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          assert.equal(res.headers['cache-control'], 'no-store');
          assert.equal(res.headers['content-type'], 'application/json; charset=utf-8'); assert.equal(res.headers['x-content-type-options'], 'nosniff');
          resolve({ status: res.statusCode, body, headers: res.headers, data: body ? JSON.parse(body) : null });
        });
      }); req.on('error', reject); req.end(body);
    });
  }
  const reveal = (action = 'show', options = {}) => request(API + '/reveal', { method: 'POST',
    body: JSON.stringify({ action }), ...options, headers: { origin: organization.server.publicOrigin, 'content-type': 'application/json', ...options.headers } });
  return { request, reveal, handler, organization, save, file, state, hits, reads, keyFile, upstream, directory,
    audit: path.join(organization.runtime.stateDirectory, 'my-key/audit.log') };
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }

test('session identity owns masked and revealed keys regardless of selectors', async t => {
  const f = await fixture(t);
  for (const [index, person] of people.entries()) {
    const other = people[1 - index];
    const get = await f.request(API + `?slug=${other.slug}&user=${other.unionId}`, { member: person.slug, headers: { 'x-user': other.slug, 'x-union-id': other.unionId } });
    assert.equal(get.status, 200); assert.deepEqual(get.data.key, { masked: maskKey(keys[index]) });
    assert.ok(!get.body.includes(keys[index])); assert.ok(!get.body.includes(keys[1 - index]));
    const reveal = await f.reveal('copy', { member: person.slug, body: JSON.stringify({ action: 'copy', slug: other.slug, user: other.unionId }), headers: { 'x-user': other.slug } });
    assert.deepEqual(reveal.data, { key: keys[index] });
    for (const hit of f.hits.slice(index * 2, index * 2 + 2)) {
      assert.equal(hit.method, 'GET'); assert.equal(hit.headers.authorization, 'Bearer ' + keys[index]);
      assert.equal(hit.headers['user-agent'], 'workpartner-gateway');
      assert.deepEqual(Object.keys(hit.headers).sort(), ['authorization', 'connection', 'host', 'user-agent']);
      assert.ok(!hit.url.includes(person.slug)); assert.ok(!hit.url.includes(person.unionId));
    }
  }
  fs.writeFileSync(f.keyFile(people[0]), 'sk-fixture-rotated-9d4e');
  assert.equal((await f.reveal()).data.key, 'sk-fixture-rotated-9d4e');
});

test('masking handles prefixed, unprefixed and short keys without exposing GET plaintext', async t => {
  const f = await fixture(t);
  for (const [key, masked] of [[keys[0], 'sk-••••••••3f9a'], ['fixture-key-1234', '••••••••1234'], ['short', '••••••••'], ['sk-12345678', '••••••••']]) {
    assert.equal(maskKey(key), masked); fs.writeFileSync(f.keyFile(people[0]), key);
    const response = await f.request(); assert.equal(response.data.key.masked, masked); assert.ok(!response.body.includes(key));
  }
});

test('reveal validates actions, origin, content type, body size and methods before reading keys', async t => {
  const f = await fixture(t);
  for (const action of ['show', 'copy', 'copy-config']) assert.deepEqual((await f.reveal(action)).data, { key: keys[0] });
  const before = f.reads.length;
  for (const body of ['{', 'null', '[]', '{}', '{"action":"unknown"}', ' '.repeat(1025)]) assert.equal((await f.reveal('show', { body })).status, 400);
  for (const headers of [{ origin: '' }, { origin: 'https://other.example.test' }, { 'content-type': 'text/plain' }, { 'content-type': '' }]) assert.equal((await f.reveal('show', { headers })).status, 403);
  assert.equal((await f.request(API + '/reveal', { method: 'POST', body: '{}' })).status, 403);
  for (const [route, methods] of [[API, ['POST', 'PUT', 'DELETE']], [API + '/reveal', ['GET', 'PUT', 'DELETE']]]) {
    for (const method of methods) assert.equal((await f.request(route, { method })).status, 405);
  }
  assert.equal(f.reads.length, before);
  fs.rmSync(f.keyFile(people[0])); assert.equal((await f.reveal()).status, 404);
  assert.equal(fs.readFileSync(f.audit, 'utf8').trim().split('\n').length, 3);
});

test('missing and empty key files skip all upstream calls', async t => {
  const f = await fixture(t);
  for (const missing of [true, false]) {
    if (missing) fs.rmSync(f.keyFile(people[0])); else fs.writeFileSync(f.keyFile(people[0]), ' \n');
    const response = await f.request(); assert.equal(response.status, 200);
    assert.equal(response.data.key, null); assert.equal(response.data.usage, null); assert.deepEqual(response.data.models, []);
    assert.equal((await f.reveal()).status, 404);
  }
  assert.equal(f.hits.length, 0); assert.ok(!fs.existsSync(f.audit));
});

test('access precedes body, key and upstream reads and live admission fails closed in both directions', async t => {
  const f = await fixture(t);
  for (const route of [API, API + '/reveal']) {
    const options = route.endsWith('reveal') ? { method: 'POST', body: '{' } : {};
    assert.equal((await f.request(route, { ...options, member: null })).status, 401);
    assert.equal((await f.request(route, { ...options, member: null, headers: { authorization: 'Bearer ' + keys[0] } })).status, 401);
    const pending = await f.request(route, { ...options, member: 'pending' }); assert.equal(pending.status, 404); assert.equal(pending.body, '');
  }
  assert.equal(f.reads.length, 0); assert.equal(f.hits.length, 0); assert.equal(f.handler.clientFor({ unionId: 'union-pending' }), '');
  for (const allow of [[], ['member'], [], ['union-member'], [], ['*'], [], undefined, [123]]) {
    f.organization.myKey.allow = allow; f.save();
    const admitted = allow?.some(v => ['member', 'union-member', '*'].includes(v));
    const response = await f.request(); assert.equal(response.status, admitted ? 200 : 404);
    assert.equal(Boolean(f.handler.clientFor(people[0])), Boolean(admitted));
    if (!admitted) { assert.equal(response.headers['content-length'], '0'); assert.equal(response.body, ''); }
  }
  const before = f.reads.length;
  for (const corrupt of [true, false]) {
    if (corrupt) fs.writeFileSync(f.file, '{'); else fs.rmSync(f.file);
    const response = await f.request(); assert.equal(response.status, 404); assert.equal(response.body, ''); assert.equal(f.handler.clientFor(people[0]), '');
  }
  assert.equal(f.reads.length, before);
  f.organization.myKey.allow = ['*']; f.save(); assert.equal((await f.request()).status, 200);
});

test('public settings are sanitized and re-read with admission', async t => {
  const f = await fixture(t);
  for (const [revealSeconds, expected] of [[1, 2], [301, 300], [5, 5], [1.5, 30], ['2', 30], [undefined, 30]]) {
    f.organization.myKey.revealSeconds = revealSeconds; f.save(); assert.equal((await f.request()).data.revealSeconds, expected);
  }
  for (const [value, expected] of [['https://models.example.test/v1/', 'https://models.example.test'], ['http://localhost:1234', 'http://localhost:1234'], ['http://127.0.0.2:1234', 'http://127.0.0.2:1234'], ['http://[::1]:1234', 'http://[::1]:1234'], ['http://models.example.test', ''], ['javascript:alert(1)', ''], ['https://user:pass@example.test', ''], ['https://example.test/?token=fixture', ''], [null, '']]) {
    assert.equal(publicBaseUrl(value), expected); f.organization.myKey.publicBaseUrl = value; f.save(); assert.equal((await f.request()).data.baseUrl, expected);
  }
  assert.deepEqual((await f.request()).data.defaults, defaults);
  delete f.organization.model.defaults; assert.deepEqual((await f.request()).data.defaults, { codex: '', claude: '', opus: '', sonnet: '', haiku: '' });
});

test('UTC windows cover midweek, Monday, Sunday and Beijing Monday without advancing UTC', () => {
  assert.equal(USAGE_ZONE, 'UTC');
  for (const [time, today, monday] of [
    ['2026-11-12T05:30:00Z', '2026-11-12', '2026-11-09'],
    ['2026-11-09T00:00:00Z', '2026-11-09', '2026-11-09'],
    ['2026-11-08T23:59:59Z', '2026-11-08', '2026-11-02'],
    ['2026-11-08T17:00:00Z', '2026-11-08', '2026-11-02'],
  ]) {
    const windows = usageWindows(Date.parse(time)); assert.equal(windows.today.start, today + 'T00:00:00.000Z'); assert.equal(windows.week.start, monday + 'T00:00:00.000Z');
    assert.equal(windows.period, monday + '..' + today); assert.equal(Date.parse(windows.today.reset) - Date.parse(windows.today.start), 86400000);
    assert.equal(Date.parse(windows.week.reset) - Date.parse(windows.week.start), 7 * 86400000);
  }
});

test('upstream period and totals use UTC including hourly points on a single-day Monday', async t => {
  for (const clock of [NOW, Date.parse('2026-11-09T00:00:00Z')]) {
    const f = await fixture(t, { clock });
    if (clock !== NOW) f.state.usage.series = [{ time: '2026-11-09T00:00:00Z', calls: 2, cost: 0.3 }, { time: '2026-11-09T01:00:00Z', calls: 3, cost: 0.4 }];
    const response = await f.request();
    assert.equal(f.hits[1].url, '/v1/magpie/usage/requests?period=' + usageWindows(clock).period + '&limit=1&offset=0');
    assert.equal(response.data.usage.today.calls, clock === NOW ? 86 : 5); assert.equal(response.data.usage.today.cost, clock === NOW ? 3.2 : 0.7);
    assert.equal(response.data.usage.week.calls, 512); assert.equal(response.data.usage.week.cost, 18.4);
  }
});

const limit = (period, extra = {}) => ({ period, start: '2026-11-10T00:00:00Z', reset: '2026-11-17T00:00:00Z', calls: 86, costLimit: 15, cost: 3.2, costLeft: 11.8, spent: false, ...extra });
test('limits map cost and tokens, prefer unrestricted windows and ignore unknown periods', () => {
  assert.deepEqual(mapLimits([]), { day: null, week: null });
  const p = profile();
  p.limits = [limit('day', { models: ['model-a'], costLimit: 5 }), limit('day'), limit('week', { costLimit: 0, tokenLimit: 1000, tokens: 900, tokensLeft: 100, spent: true, models: ['model-a'] }), limit('month')];
  const mapped = mapUpstream(p, usage(), usageWindows(NOW)), limits = mapped.usage.limits;
  assert.deepEqual(limits.day, { unit: 'cost', limit: 15, used: 3.2, left: 11.8, start: '2026-11-10T00:00:00.000Z', reset: '2026-11-17T00:00:00.000Z', spent: false, partial: false });
  assert.deepEqual(limits.week, { unit: 'tokens', limit: 1000, used: 900, left: 100, start: limits.day.start, reset: limits.day.reset, spent: true, partial: true });
  assert.equal(mapped.usage.today.start, limits.day.start); assert.equal(mapped.usage.week.reset, limits.week.reset);
  assert.equal(mapLimits([limit('week', { models: ['model-a'] }), limit('week', { models: ['model-b'], costLimit: 25 })]).week.limit, 15);
  for (const extra of [{ cost: -1 }, { cost: Infinity }, { costLeft: NaN }, { costLimit: '15' }, { start: 'bad' }, { spent: 'false' }, { models: [2] }]) assert.equal(mapLimits([limit('day', extra)]).day, null);
});

test('model shares merge final names, select top three, round and fall back to calls', () => {
  const u = usage(); u.cost = 100; u.calls = 100;
  u.by.model = [ ['a/one', 30], ['b/one', 20], ['two', 25], ['three', 24.5], ['four', 0.5] ].map(([id, cost]) => ({ id, cost, calls: cost }));
  const mapped = () => mapUsage(u, profile().name, usageWindows(NOW), mapLimits([]));
  assert.deepEqual(mapped().week.models, [{ name: 'one', share: 0.5 }, { name: 'two', share: 0.25 }, { name: 'three', share: 0.245 }]);
  u.cost = 0; assert.equal(mapped().week.models[0].share, 0.5);
  u.by.model = [{ id: 'model', calls: 1, cost: 0 }]; u.calls = 3; assert.equal(mapped().week.models[0].share, 0.3333);
});

test('upstream transport and malformed replies degrade to 200 while reveal remains available', async t => {
  const f = await fixture(t, { timeoutMs: 50 });
  for (const mode of ['hang', 403, 500, 302, 'json', 'oversize', 'usage-fail']) {
    f.state.mode = mode; const start = Date.now(), response = await f.request();
    assert.equal(response.status, 200); assert.ok(response.data.key.masked); assert.ok(Date.now() - start < 1500);
    if (mode === 'usage-fail') { assert.equal(response.data.usage.today, null); assert.equal(response.data.usage.week, null); assert.deepEqual(response.data.usage.limits, { day: null, week: null }); }
    else { assert.equal(response.data.usage, null); assert.deepEqual(response.data.models, []); }
    assert.equal((await f.reveal()).data.key, keys[0]);
  }
  f.upstream.closeAllConnections(); await new Promise(resolve => f.upstream.close(resolve));
  assert.equal((await f.request()).data.usage, null); assert.equal((await f.reveal()).data.key, keys[0]);
});

test('usage ownership, time alignment and malformed numbers fail closed', async t => {
  const f = await fixture(t);
  for (const change of [
    u => { u.series[0].time = '2026-11-08T16:00:00Z'; }, u => { u.callerKeys.push({ name: 'another' }); },
    u => { u.callerKeys[0].name = 'another'; }, u => { u.by.callerKey.push({ name: 'another' }); },
    u => { u.calls = -1; }, u => { u.cost = '3'; }, u => { u.series = []; }, u => { u.series[1].cost = null; },
    u => { u.by.model = null; }, u => { delete u.callerKeys; },
  ]) {
    f.state.usage = usage(); change(f.state.usage); const response = await f.request();
    assert.equal(response.status, 200); assert.equal(response.data.usage.today, null); assert.equal(response.data.usage.week, null);
    assert.ok(response.data.key.masked); assert.equal((await f.reveal()).data.key, keys[0]);
  }
  for (const change of [p => { p.name = 3; }, p => { p.models = null; }, p => { p.limits = null; }]) {
    f.state.profile = profile(); change(f.state.profile); assert.equal((await f.request()).data.usage, null);
  }
  const u = usage(); u.cost = Infinity; assert.equal(mapUsage(u, profile().name, usageWindows(NOW), mapLimits([])).week, null);
  u.cost = 1; u.series[0].calls = NaN; assert.equal(mapUsage(u, profile().name, usageWindows(NOW), mapLimits([])).today, null);
});

test('browser replies exclude private rows and identities and cap advertised strings', async t => {
  const f = await fixture(t), response = await f.request();
  for (const secret of [...keys, 'private-caller-name', 'private-account', 'private.example.test', 'private-session', 'union-member', 'rows', 'callerKeys', 'callerKey']) assert.ok(!response.body.includes(secret), secret);
  const p = profile(); p.models = Array.from({ length: 501 }, () => ({ id: 'x'.repeat(201), label: 'y'.repeat(201), ignored: 'private-account' }));
  const mapped = mapUpstream(p, usage(), usageWindows(NOW)); assert.equal(mapped.models.length, 500); assert.equal(mapped.models[0].id.length, 200); assert.equal(mapped.models[0].label.length, 200);
  assert.deepEqual(Object.keys(mapped.models[0]), ['id', 'label']);
});

test('audit is flushed with only timestamp slug action and fails closed on write failure', async t => {
  const f = await fixture(t);
  for (const action of ['show', 'copy', 'copy-config']) assert.equal((await f.reveal(action)).status, 200);
  const bytes = fs.readFileSync(f.audit, 'utf8'), lines = bytes.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, ['show', 'copy', 'copy-config'].map(action => ({ at: '2026-11-12T05:30:00.000Z', slug: 'member', action })));
  for (const secret of [keys[0], keys[0].slice(-4), people[0].unionId]) assert.ok(!bytes.includes(secret));
  assert.equal(fs.statSync(path.dirname(f.audit)).mode & 0o777, 0o700); assert.equal(fs.statSync(f.audit).mode & 0o777, 0o600);
  await f.reveal('bad'); await f.reveal('show', { headers: { origin: '' } }); fs.rmSync(f.keyFile(people[0])); await f.reveal();
  assert.equal(fs.readFileSync(f.audit, 'utf8'), bytes);
  fs.writeFileSync(f.keyFile(people[0]), keys[0]); fs.rmSync(f.audit); fs.mkdirSync(f.audit);
  const response = await f.reveal(); assert.equal(response.status, 503); assert.ok(!response.body.includes(keys[0]));
});

test('dialog installer is valid JavaScript with the required notice and no serialized private options', () => {
  const script = myKeyClient({ key: keys[0], slug: people[0].slug, unionId: people[0].unionId, publicBaseUrl: 'https://models.example.test' });
  new Script(script); new Function(script);
  assert.ok(script.includes('这把钥匙与你本人实名绑定，每次使用都会按人记录，用于额度管理和安全审计，请只用于本人工作。'));
  assert.ok(script.includes('This key is bound to your real identity. Every use is recorded per person for quota management and security audits; use it only for your own work.'));
  for (const secret of [...keys, ...people.flatMap(p => [p.slug, p.unionId]), 'models.example.test']) assert.ok(!script.includes(secret), secret);
  assert.ok(!script.includes('innerHTML'));
});

test('pure mapping rejects malformed upstream data and maps cost windows independently', () => {
  const windows = usageWindows(NOW), p = profile(), u = usage();
  p.limits = [limit('day'), limit('week', { costLimit: 80, cost: 18.4, costLeft: 61.6 }), limit('month')];
  const mapped = mapUpstream(p, u, windows);
  assert.equal(mapped.usage.limits.day.unit, 'cost'); assert.equal(mapped.usage.limits.week.limit, 80);
  assert.equal(mapped.usage.limits.week.used, 18.4); assert.equal(mapped.usage.limits.week.left, 61.6);
  assert.equal(mapped.usage.today.start, mapped.usage.limits.day.start); assert.equal(mapped.usage.week.reset, mapped.usage.limits.week.reset);
  assert.equal(mapped.usage.today.calls, 86); assert.equal(mapped.usage.today.cost, 3.2);
  assert.deepEqual(mapUpstream(null, u, windows), { usage: null, models: [] });
  assert.deepEqual(mapUpstream(p, null, windows).usage, { today: null, week: null, limits: mapped.usage.limits });
  for (const value of [null, {}, { toString: 'invalid' }, 123, 'invalid', '2026-11-08T16:00:00Z']) {
    u.series[0].time = value; assert.equal(mapUpstream(p, u, windows).usage.today, null);
  }
  for (const extra of [{ cost: -1 }, { cost: Infinity }, { costLeft: NaN }, { costLimit: '15' }, { tokens: -1 }, { start: 'bad' }, { spent: 'false' }, { models: [2] }]) assert.equal(mapLimits([limit('day', extra)]).day, null);
  for (const value of [null, [], {}, { ...profile(), name: 1 }, { ...profile(), models: null }, { ...profile(), limits: null }]) assert.equal(mapUpstream(value, usage(), windows).usage, null);
  const long = profile(); long.models = Array.from({ length: 501 }, () => ({ id: 'x'.repeat(201), label: 'y'.repeat(201), ignored: 'private-account' }));
  const models = mapUpstream(long, usage(), windows).models;
  assert.equal(models.length, 500); assert.deepEqual(models[0], { id: 'x'.repeat(200), label: 'y'.repeat(200) });
});

test('pure mapping skips invalid advertised models and falls back to IDs for labels', () => {
  const windows = usageWindows(NOW), baseline = mapUpstream(profile(), usage(), windows);
  for (const entry of [null, [], 'invalid', 4, {}, { id: 4, label: 'Invalid' }]) {
    const mapped = mapUpstream({ ...profile(), models: [entry, ...profile().models] }, usage(), windows);
    assert.deepEqual(mapped, baseline);
    assert.deepEqual(mapUpstream({ ...profile(), models: [entry] }, usage(), windows), { usage: baseline.usage, models: [] });
  }
  const p = profile(); p.models[0].id = 4;
  assert.deepEqual(mapUpstream(p, usage(), windows), { usage: baseline.usage, models: [] });
  for (const label of [undefined, null, 4, {}, [], false]) {
    const id = 'model-' + 'x'.repeat(210);
    assert.deepEqual(mapUpstream({ ...profile(), models: [{ id, label }] }, usage(), windows).models,
      [{ id: id.slice(0, 200), label: id.slice(0, 200) }]);
  }
  const models = [null, ...Array.from({ length: 501 }, (_, i) => ({ id: 'model-' + i }))];
  assert.equal(mapUpstream({ ...profile(), models }, usage(), windows).models.at(-1).id, 'model-499');
  assert.equal(mapUpstream({ ...profile(), models: [{ id: 'model', label: '' }] }, usage(), windows).models[0].label, '');
});

test('model shares skip malformed entries without discarding valid totals or shares', () => {
  const windows = usageWindows(NOW), limits = mapLimits([]), baseline = mapUsage(usage(), profile().name, windows, limits);
  const valid = { id: 'ignored', calls: 1, cost: 1 };
  for (const invalid of [null, [], 'invalid', {}, { ...valid, id: 4 },
    ...['calls', 'cost'].flatMap(field => [undefined, null, '1', -1, NaN, Infinity, -Infinity].map(value => ({ ...valid, [field]: value })))]) {
    const u = usage(); u.by.model.splice(1, 0, invalid);
    assert.deepEqual(mapUsage(u, profile().name, windows, limits), baseline);
    u.by.model = [invalid];
    assert.deepEqual(mapUsage(u, profile().name, windows, limits), { ...baseline, week: { ...baseline.week, models: [] } });
  }
  const u = usage(); u.by.model[0].calls = -1;
  assert.deepEqual(mapUsage(u, profile().name, windows, limits), { ...baseline, week: { ...baseline.week, models: baseline.week.models.slice(1) } });
  for (const value of [undefined, null, {}, 'invalid']) {
    u.by.model = value;
    assert.deepEqual(mapUsage(u, profile().name, windows, limits), { today: null, week: null });
  }
});
