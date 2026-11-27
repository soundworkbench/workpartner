import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { createFeishuBot } from '../feishu-bot.mjs';
import { createFeishuOnboarding } from '../feishu-onboarding.mjs';
import { clientResponse } from '../client-response.mjs';
import { aionuiEtag, aionuiResponseHeaders } from '../aionui.mjs';
import { gatewayFixture } from '../../tools/perf/gateway-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const user = { slug: 'one', unionId: 'one', backend: 'aionui' };
const post = { origin: 'https://test', 'content-type': 'application/json' };
async function call(handler, route, headers = {}, method = 'GET', body = {}) {
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url: route, headers: { cookie: 'one', ...headers } });
  let status, responseHeaders, raw;
  await handler(req, { writeHead: (s, h) => { status = s; responseHeaders = h; }, end: b => { raw = b; } }, new URL(route, 'https://test'));
  return { status, headers: responseHeaders, body: raw, data: raw ? JSON.parse(raw) : undefined };
}
const agent = { id: 's12345678', kind: 'sub', name: '助手', setup: 'connected' };

test('static ETags change with image ID and exclude dynamic routes', () => {
  const req = { method: 'GET', url: '/index.html', headers: {} };
  assert.notEqual(aionuiEtag('sha256:v1', req), aionuiEtag('sha256:v2', req));
  assert.equal(aionuiEtag('sha256:v1', { ...req, url: '/api/data' }), null);
  assert.equal(aionuiEtag('sha256:v1', { ...req, method: 'POST' }), null);
});
function botsFixture() {
  let now = 0, revision = 1, gate, failure, subAllowed = true;
  const calls = [];
  const handler = createFeishuBot({ organization: { server: { publicOrigin: 'https://test' }, runtime: { uid: 1 } },
    organizationData: () => ({ features: { feishuBot: true }, feishuBot: { allow: ['*'], subAgents: { allow: subAllowed ? ['*'] : [] } } }),
    authenticate: req => ({ ...user, slug: req.headers.cookie }), now: () => now, cacheEnabled: true,
    runtime: { exec: async (slug, args) => {
      calls.push({ slug, args });
      if (args.includes('info')) {
        const value = { ok: true, bots: [{ appId: 'cli_main', name: `v${revision}` }], agents: [agent] };
        if (gate) await gate.promise;
        if (failure === 'exec') throw new Error('exec failed');
        return { exitCode: 0, stdout: failure === 'invalid' ? '{"ok":true}' : JSON.stringify(value) };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, agent, status: 'unconnected' }) };
    } } });
  return { handler, calls, get: (route = '/_wp/feishu-bot/bots', headers) => call(handler, route, headers),
    set time(v) { now = v; }, set revision(v) { revision = v; }, set gate(v) { gate = v; }, set failure(v) { failure = v; },
    denySub() { subAllowed = false; } };
}

test('bots cache isolates users, preserves bodies and rechecks current policy', async () => {
  const f = botsFixture(), first = await f.get();
  assert.equal(first.status, 200); assert.equal(first.data.bots[0].name, 'v1');
  assert.equal((await f.get()).body, first.body); assert.equal(f.calls.length, 1);
  f.revision = 2;
  assert.equal((await f.get(undefined, { cookie: 'two' })).data.bots[0].name, 'v2');
  assert.equal((await f.get()).data.bots[0].name, 'v1'); assert.equal(f.calls.length, 2);
  f.denySub(); assert.deepEqual((await f.get()).data.agents, []); assert.equal(f.calls.length, 2);
});

test('bots stale cache responds first, coalesces background refresh, and waits after five minutes', async () => {
  const f = botsFixture(); await f.get(); f.time = 60001; f.revision = 2;
  const gate = deferred(); f.gate = gate;
  assert.equal((await f.get()).data.bots[0].name, 'v1');
  assert.equal((await f.get()).data.bots[0].name, 'v1'); assert.equal(f.calls.length, 2);
  gate.resolve(); await tick(); f.gate = null;
  assert.equal((await f.get()).data.bots[0].name, 'v2');
  f.time = 360002; f.revision = 3; const next = deferred(); f.gate = next;
  let returned = false; const response = f.get().then(r => { returned = true; return r; });
  await tick(); assert.equal(returned, false); assert.equal(f.calls.length, 3);
  next.resolve(); assert.equal((await response).data.bots[0].name, 'v3');
});

for (const failure of ['exec', 'invalid']) test(`bots ${failure} failure never replaces good data or populates empty cache`, async () => {
  const f = botsFixture(); await f.get(); f.time = 60001; f.failure = failure;
  assert.equal((await f.get()).data.bots[0].name, 'v1'); await tick();
  assert.equal((await f.get('/_wp/feishu-bot/bots?refresh=1')).status, 503);
  assert.equal((await f.get()).data.bots[0].name, 'v1'); await tick();
  assert.equal((await f.get(undefined, { cookie: 'two' })).status, 503);
  f.failure = null; f.revision = 2;
  assert.equal((await f.get(undefined, { cookie: 'two' })).data.bots[0].name, 'v2');
  assert.equal((await f.get('/_wp/feishu-bot/bots?refresh=1')).data.bots[0].name, 'v2');
  const count = f.calls.length; assert.equal((await f.get()).data.bots[0].name, 'v2'); assert.equal(f.calls.length, count);
});

for (const route of ['/agents', '/agents/s12345678/rename', '/agents/s12345678/delete', '/agents/s12345678/setup', '/agents/s12345678/restart', '/reconnect']) {
  test(`bots write ${route} invalidates only its user`, async () => {
    const f = botsFixture(); await f.get(); await f.get(undefined, { cookie: 'two' }); f.revision = 2;
    const write = await call(f.handler, '/_wp/feishu-bot' + route, post, 'POST', { name: '新助手' });
    assert.equal(write.status, route === '/agents' ? 201 : 200);
    assert.equal((await f.get()).data.bots[0].name, 'v2');
    assert.equal((await f.get(undefined, { cookie: 'two' })).data.bots[0].name, 'v1');
    assert.equal(f.calls.filter(c => c.args.includes('info')).length, 3);
  });
}

test('bots write discards an in-flight stale cache result', async () => {
  const f = botsFixture(); await f.get(); f.time = 60001; const gate = deferred(); f.gate = gate;
  await f.get(); await call(f.handler, '/_wp/feishu-bot/reconnect', post, 'POST');
  f.revision = 2; f.gate = null; assert.equal((await f.get()).data.bots[0].name, 'v2');
  gate.resolve(); await tick(); assert.equal((await f.get()).data.bots[0].name, 'v2');
});

test('bots cache evicts oldest user at 500 entries', async () => {
  const f = botsFixture(); for (let i = 0; i <= 500; i++) await f.get(undefined, { cookie: `u${i}` });
  f.revision = 2;
  assert.equal((await f.get(undefined, { cookie: 'u1' })).data.bots[0].name, 'v1');
  assert.equal((await f.get(undefined, { cookie: 'u0' })).data.bots[0].name, 'v2');
  assert.equal(f.calls.length, 502);
});

function statusFixture(initial = 'connected') {
  let now = 0, state = initial, gate, fail = false;
  const calls = [];
  const handler = createFeishuOnboarding({ authenticate: req => ({ ...user, slug: req.headers.cookie }), origin: 'https://test',
    now: () => now, log: () => {}, execute: async (_u, action) => {
      calls.push(action); const value = { status: state };
      if (gate && action === 'status') await gate.promise;
      if (fail) throw new Error('failed'); return value;
    }, runtime: { exec: async () => ({ exitCode: 0, stdout: '{"ok":true}' }) } });
  return { handler, calls, get: (query = '', headers) => call(handler, '/_wp/aionui/feishu/status' + query, headers),
    start: () => call(handler, '/_wp/aionui/feishu/start', post, 'POST'),
    set time(v) { now = v; }, set state(v) { state = v; }, set gate(v) { gate = v; }, set fail(v) { fail = v; } };
}
for (const state of ['connected', 'unconnected', 'needs_identity', 'restart_failed', 'expired', 'failed']) test(`status caches ${state} for 60s per user and refresh bypasses it`, async () => {
  const f = statusFixture(state), first = await f.get(); assert.equal(first.status, 200);
  f.time = 60000; assert.equal((await f.get()).body, first.body); assert.equal(f.calls.length, 1);
  await f.get('', { cookie: 'two' }); assert.equal(f.calls.length, 2);
  f.state = 'connected'; await f.get('?refresh=1'); assert.equal(f.calls.filter(c => c === 'status').length, 3);
  f.time = 120001; await f.get(); assert.equal(f.calls.filter(c => c === 'status').length, 4);
});
for (const state of ['waiting', 'preparing', 'starting', 'needs_restart', 'restarting']) test(`status does not cache transitional ${state}`, async () => {
  const f = statusFixture(state); await f.get(); await f.get();
  assert.equal(f.calls.filter(c => c === 'status').length, 2);
});
for (const state of ['connected', 'waiting', 'unconnected']) test(`POST start invalidates status even when initial state is ${state}`, async () => {
  const f = statusFixture(state); await f.get(); assert.equal((await f.start()).status, 200);
  f.state = 'needs_identity'; assert.equal((await f.get()).data.status, 'needs_identity');
  assert.equal(f.calls.filter(c => c === 'status').length, 3);
});

test('status failed explicit refresh retains the old cached value', async () => {
  const f = statusFixture(); await f.get(); f.fail = true;
  assert.equal((await f.get('?refresh=1')).status, 503);
  assert.equal((await f.get()).data.status, 'connected'); assert.equal(f.calls.length, 2);
});

test('POST start failure still invalidates, and late status reads cannot repopulate it', async () => {
  const f = statusFixture(); await f.get(); f.fail = true;
  assert.equal((await f.start()).status, 503); f.fail = false; f.state = 'unconnected';
  assert.equal((await f.get()).data.status, 'unconnected');
  f.time = 60001; const gate = deferred(); f.gate = gate; const old = f.get(); await tick(); f.gate = null;
  f.state = 'connected'; await f.start(); gate.resolve(); await old;
  f.state = 'needs_identity'; assert.equal((await f.get()).data.status, 'needs_identity');
});

for (const [policy, expected] of [[undefined, 'private, max-age=31536000, immutable'], ['public, max-age=60', 'private, max-age=31536000, immutable'], ['immutable', 'private, max-age=31536000, immutable'], ['private', 'private'], ['public, no-store', 'public, no-store'], ['no-cache', 'no-cache'], ['public, no-transform', 'public, no-transform']]) {
  test(`immutable respects upstream policy ${policy}`, () => {
    const headers = policy ? { 'cache-control': policy } : {};
    assert.equal(aionuiResponseHeaders(headers, '"x"', 200, '/assets/app-AbCd1234%2Eimm.js?q=1')['cache-control'], expected);
  });
}
for (const [method, status, pathname] of [['POST', 200, '/assets/app-AbCd1234.imm.js'], ['GET', 206, '/assets/app-AbCd1234.imm.js'], ['GET', 404, '/assets/app-AbCd1234.imm.js'], ['GET', 200, '/assets/index-AbCd1234.js'], ['GET', 200, '/assets/favicon.svg'], ['GET', 200, '/index.html'], ['GET', 200, '/assets/%ZZ.imm.js']]) {
  test(`immutable is excluded for ${method} ${status} ${pathname}`, () => {
    assert.equal(aionuiResponseHeaders({}, '"x"', status, pathname, method)['cache-control'], 'no-cache');
  });
}

test('client responses isolate final bodies and skip anonymous compression', () => {
  const request = (body, headers = {}, options) => {
    let result;
    clientResponse({ method: 'GET', url: '/_wp/preview/client.js', headers }, { writeHead: (status, headers) => { result = { status, headers }; }, end: body => { result.body = body; } }, body, { 'content-type': 'application/javascript' }, options);
    return result;
  };
  const body = 'x'.repeat(5000), first = request(body, { 'accept-encoding': 'br' });
  assert.equal(first.headers['cache-control'], 'private, no-cache');
  assert.deepEqual(brotliDecompressSync(first.body), Buffer.from(body));
  const headers = { 'accept-encoding': 'br', 'if-none-match': first.headers.etag };
  const second = request(body, headers); assert.equal(second.status, 304); assert.equal(second.body, undefined);
  assert.match(second.headers.vary, /cookie/); assert.match(second.headers.vary, /accept-encoding/);
  assert.equal(request('y'.repeat(5000), headers).status, 200);
  const anonymous = request(body, headers, { compress: false }); assert.equal(anonymous.status, 200); assert.equal(anonymous.headers['content-encoding'], undefined);
});

// Invoke the real server's request handler and stream transport without binding a port.
function memoryRequest(server, route, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const result = {};
    res.writeHead = (status, headers) => { result.status = status; result.headers = headers; res.headersSent = true; return res; };
    res.setHeader = () => {};
    res.on('error', error => { result.error = error.message; });
    res.on('close', () => resolve({ ...result, body: Buffer.concat(chunks), destroyed: res.destroyed }));
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { url: route, method, headers: { host: 'perf.test', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

test('real gateway response chain handles compression, caching and broken upstream streams', async t => {
  const original = http.request;
  const raw = Buffer.alloc(500 * 1024, ' ');
  Buffer.from('export const data = ' + JSON.stringify(Array.from({ length: 18000 }, (_, i) => `asset-item-${i}`)) + ';\n').copy(raw);
  let spec = {}, hits = 0, forwardedHeaders;
  http.request = (options, callback) => {
    forwardedHeaders = options.headers;
    const request = new Writable({ write(_chunk, _enc, done) { done(); }, final(done) {
      queueMicrotask(() => {
        const login = options.path === '/login'; if (!login) hits++;
        const payload = login ? Buffer.from('{}') : (spec.body || raw);
        const response = spec.error && !login ? new Readable({ read() { this.push(payload.subarray(0, 100)); this.destroy(new Error('upstream interrupted')); } }) : Readable.from([payload]);
        response.statusCode = login ? 200 : (spec.status || 200);
        response.headers = login ? { 'set-cookie': ['session=synthetic'] } : { 'content-type': 'application/javascript', 'content-length': String(payload.length), ...spec.headers };
        callback(response);
      }); done();
    } });
    return request;
  };
  t.after(() => { http.request = original; });
  const savedFetch = globalThis.fetch;
  let titleFetch = async () => { throw new Error('Unexpected outbound request'); };
  globalThis.fetch = (...args) => titleFetch(...args);
  t.after(() => { globalThis.fetch = savedFetch; });
  const f = await gatewayFixture({ address: { host: 'fixture', port: 80 }, autoTitle: true }); t.after(() => f.close());
  const request = (route = '/assets/app-AbCd1234.imm.js', headers = {}, method = 'GET') => memoryRequest(f.server, route, { cookie: f.cookie, ...headers }, method);
  for (const [encoding, decode] of [['br', brotliDecompressSync], ['gzip', gunzipSync]]) await t.test(`${encoding} round trip and 304 Vary`, async () => {
    spec = {};
    const first = await request(undefined, { 'accept-encoding': encoding });
    assert.equal(first.status, 200); assert.equal(first.headers['content-encoding'], encoding);
    assert.deepEqual(decode(first.body), raw); assert.equal(first.headers['content-length'], undefined);
    assert.equal(first.headers['cache-control'], 'private, max-age=31536000, immutable');
    const forwarded = hits;
    const second = await request(undefined, { 'accept-encoding': encoding, 'if-none-match': first.headers.etag });
    assert.equal(second.status, 304); assert.equal(second.body.length, 0); assert.match(second.headers.vary, /accept-encoding/);
    assert.equal(second.headers['cache-control'], first.headers['cache-control']);
    assert.equal(hits, forwarded, 'a cached conditional request must not reach the upstream');
    assert.equal(second.headers['content-encoding'], undefined);
    assert.equal(second.headers['content-length'], undefined);
  });
  await t.test('API upstream ETags never trigger gateway 304', async () => {
    spec = { headers: { 'content-type': 'application/json', etag: '"upstream-api"' } };
    const before = hits;
    const response = await request('/api/data', { 'if-none-match': '"upstream-api"' });
    assert.equal(response.status, 200); assert.equal(hits, before + 1);
  });
  const exclusions = [
    ['Range', {}, { range: 'bytes=0-100' }], ['206', { status: 206 }],
    ['already encoded', { body: gzipSync(raw), headers: { 'content-encoding': 'gzip' } }],
    ['no-transform', { headers: { 'cache-control': 'public, No-Transform' } }],
    ['SSE', { headers: { 'content-type': 'text/event-stream' } }],
    ['buffering off', { headers: { 'x-accel-buffering': 'no' } }],
    ['small', { body: Buffer.from('small') }], ['binary', { headers: { 'content-type': 'image/png' } }],
    ['set-cookie', { headers: { 'set-cookie': ['secret=value'] } }],
    ['API JSON', { headers: { 'content-type': 'application/json' } }, {}, '/api/data'],
    ['HEAD', {}, {}, undefined, 'HEAD'], ['POST', {}, {}, undefined, 'POST'], ['204', { status: 204 }], ['304', { status: 304 }],
  ];
  for (const [name, value, headers, route, method] of exclusions) await t.test(`does not compress ${name}`, async () => {
    spec = value;
    const response = await request(route, { 'accept-encoding': 'br, gzip', ...headers }, method);
    assert.equal(response.status, spec.status || 200);
    assert.equal(response.headers['content-encoding'], spec.headers?.['content-encoding']);
    assert.equal(response.headers['set-cookie'], undefined);
    if (response.headers.etag) assert.doesNotMatch(response.headers.etag, /-(br|gzip)"$/);
  });
  for (const [header, expected] of [['br;q=0, gzip', 'gzip'], ['br;q=0,gzip;q=0', undefined], ['*;q=1,br;q=0', 'gzip'], ['br;q=0,*;q=0', undefined], ['gzip;q=0,br', 'br'], ['', undefined]]) await t.test(`encoding negotiation ${header}`, async () => {
    spec = {}; const response = await request(undefined, { 'accept-encoding': header }); assert.equal(response.headers['content-encoding'], expected);
  });
  await t.test('compression can be disabled, and its original ETag matches 304', async () => {
    const old = process.env.WP_GATEWAY_COMPRESS; process.env.WP_GATEWAY_COMPRESS = '0';
    try {
      spec = {}; const first = await request(undefined, { 'accept-encoding': 'br' }); assert.deepEqual(first.body, raw); assert.equal(first.headers['content-encoding'], undefined);
      const forwarded = hits;
      const second = await request(undefined, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
      assert.equal(second.status, 304); assert.equal(hits, forwarded); assert.equal(second.headers['content-encoding'], undefined);
    } finally { if (old === undefined) delete process.env.WP_GATEWAY_COMPRESS; else process.env.WP_GATEWAY_COMPRESS = old; }
  });
  for (const headers of [{ 'content-type': 'image/png' }, { 'content-length': '10' }, { 'cache-control': 'no-transform' }]) await t.test(`incompressible resource 304 ${JSON.stringify(headers)}`, async () => {
    spec = { headers }; const first = await request(undefined, { 'accept-encoding': 'br' });
    const second = await request(undefined, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
    assert.equal(second.status, 304); assert.equal(second.body.length, 0); assert.equal(second.headers.etag, first.headers.etag);
  });
  for (const route of ['/assets/index-AbCd1234.js', '/assets/favicon.svg', '/', '/index.html']) await t.test(`unmarked path remains no-cache: ${route}`, async () => {
    spec = {}; const first = await request(route, { 'accept-encoding': 'br' }); assert.equal(first.headers['cache-control'], 'no-cache');
    assert.equal(first.headers['content-encoding'], 'br');
    const forwarded = hits;
    const second = await request(route, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
    assert.equal(second.status, 304); assert.equal(hits, forwarded);
    assert.equal(second.headers['content-encoding'], undefined); assert.equal(second.headers['content-length'], undefined);
  });
  await t.test('marked asset 304 uses its path cache policy', async () => {
    spec = { headers: { 'cache-control': 'private, no-store' } }; const first = await request();
    assert.equal(first.headers['cache-control'], 'private, no-store');
    const second = await request(undefined, { 'if-none-match': first.headers.etag }); assert.equal(second.headers['cache-control'], 'private, max-age=31536000, immutable');
  });
  await t.test('client.js final content and login state determine ETag', async () => {
    const route = '/_wp/preview/client.js', first = await request(route, { 'accept-encoding': 'br' });
    assert.equal(first.headers['cache-control'], 'private, no-cache'); assert.equal(first.headers['content-encoding'], 'br');
    assert.equal((await request(route, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag })).status, 304);
    const anonymous = await memoryRequest(f.server, route, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
    assert.equal(anonymous.status, 200); assert.equal(anonymous.headers['content-encoding'], undefined);
    assert.notEqual(anonymous.headers.etag, first.headers.etag);
  });
  for (const type of ['application/json', 'text/html']) await t.test(`static ${type} compresses and decodes`, async () => {
    spec = { headers: { 'content-type': type } };
    const response = await request('/page', { 'accept-encoding': 'br' });
    assert.equal(response.headers['content-encoding'], 'br'); assert.deepEqual(brotliDecompressSync(response.body), raw);
  });
  await t.test('titleCreate observes the original JSON and can generate a title', async () => {
    let conversation = { id: 'chat', name: 'Initial', extra: { backend: 'codex' } };
    const fetchOriginal = titleFetch;
    titleFetch = async (url, options = {}) => {
      let value;
      if (String(url).includes('/api/conversations/')) {
        if (options.method === 'PATCH') conversation = { ...conversation, ...JSON.parse(options.body) };
        value = { data: conversation };
      } else if (String(url).endsWith('/models')) value = { data: [{ id: 'gpt-6-luna' }] };
      else if (String(url).endsWith('/chat/completions')) value = { choices: [{ message: { content: '自动标题' } }] };
      else throw new Error('Unexpected outbound request');
      return { ok: true, json: async () => value };
    };
    try {
      spec = { body: Buffer.from(JSON.stringify({ data: conversation, padding: 'x'.repeat(2000) })), headers: { 'content-type': 'application/json' } };
      const created = await request('/api/conversations', { 'accept-encoding': 'br' }, 'POST');
      assert.deepEqual(created.body, spec.body); assert.equal(created.headers['content-encoding'], undefined);
      assert.equal(forwardedHeaders['accept-encoding'], 'identity');
      await memoryRequest(f.server, '/api/conversations/chat/messages', { cookie: f.cookie }, 'POST', '{"content":"整理会议"}');
      const generated = await request('/_wp/next-title/chat', { origin: 'https://perf.test' }, 'POST');
      assert.deepEqual(JSON.parse(generated.body), { changed: true });
      assert.equal(conversation.name, '自动标题'); assert.equal(conversation.name_source, 'auto');
    } finally { titleFetch = fetchOriginal; }
  });
  await t.test('upstream error destroys compressed response instead of hanging', async () => {
    spec = {}; const first = await request(undefined, { 'accept-encoding': 'br' });
    const forwarded = hits;
    spec = { error: true };
    const cached = await request(undefined, { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
    assert.equal(cached.status, 304); assert.equal(hits, forwarded);
    const response = await request(undefined, { 'accept-encoding': 'br' });
    assert.equal(response.destroyed, true); assert.equal(response.error, 'upstream interrupted');
  });
  assert.ok(hits > 0);
});
