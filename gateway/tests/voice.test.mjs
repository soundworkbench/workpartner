import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { createVoice } from '../voice.mjs';
import { voiceClient } from '../voice-client.mjs';
import { createHarness } from '../../tools/browser-tests/lib/harness.mjs';

const API = '/_wp/api/voice/recognize', ORIGIN = 'https://voice.example.test';
const people = [{ slug: 'tang', unionId: 'union-tang' }, { slug: 'other', unionId: 'union-other' }];
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); };
async function fixture(t, { timeoutMs = 1500 } = {}) {
  const state = { status: 200, body: { text: '识别结果', private: 'upstream-private' }, hang: false, invalid: false };
  const hits = [], reads = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    hits.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks), res });
    if (state.hang) return;
    res.writeHead(state.status); res.end(state.invalid ? 'upstream-private' : JSON.stringify(state.body));
  });
  await listen(upstream);
  let policy = { features: { voice: true }, voice: { allow: ['tang'] } }, broken = false;
  const handler = createVoice({ organization: { server: { publicOrigin: ORIGIN } },
    organizationData: () => { if (broken) throw new Error('private-policy'); return structuredClone(policy); },
    authenticate: req => people.find(p => p.slug === req.headers['x-user']),
    asrUrl: `http://127.0.0.1:${upstream.address().port}`, timeoutMs });
  const server = http.createServer(async (req, res) => {
    const seen = { bytes: 0, ended: false }; reads.push(seen);
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...args) { seen.status = status; return writeHead.call(this, status, ...args); };
    req.on('data', chunk => { seen.bytes += chunk.length; }); req.on('end', () => { seen.ended = true; });
    if (!await handler(req, res, new URL(req.url, ORIGIN))) { res.writeHead(418); res.end(); }
  });
  await listen(server);
  for (const s of [upstream, server]) t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
  function request({ method = 'POST', user = 'tang', headers = {}, body = Buffer.from('audio-private'), path = API, send, allowDisconnect = () => false } = {}) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        // Early rejection can close the socket before the client finishes writing or receives the response.
        if (['ECONNRESET', 'EPIPE'].includes(error.code) && allowDisconnect()) resolve(null);
        else reject(error);
      };
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method,
        headers: { 'x-user': user, origin: ORIGIN, 'content-type': 'audio/wav', ...headers } }, res => {
        res.on('error', onError);
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, raw, data: raw ? JSON.parse(raw) : null, headers: res.headers });
        });
      });
      req.on('error', onError); if (send) send(req); else req.end(body);
    });
  }
  return { state, hits, reads, handler, upstream, request, set: value => { policy = value; }, break: () => { broken = true; } };
}

test('voice policy admits slug, union ID and wildcard and reloads feature/list for API and client', async t => {
  const f = await fixture(t);
  for (const allow of [['tang'], ['union-tang'], ['*']]) {
    f.set({ features: { voice: true }, voice: { allow } });
    assert.equal((await f.request()).status, 200); assert.equal(f.handler.clientFor(people[0]), voiceClient());
    assert.equal((await f.request({ user: 'other' })).status, allow[0] === '*' ? 200 : 404);
    assert.equal(Boolean(f.handler.clientFor(people[1])), allow[0] === '*');
  }
  for (const policy of [{ features: { voice: false }, voice: { allow: ['*'] } }, { voice: { allow: ['*'] } },
    { features: { voice: true }, voice: { allow: [] } }, { features: { voice: true }, voice: { allow: ['*', 7] } }]) {
    f.set(policy); assert.equal((await f.request()).status, 404); assert.equal(f.handler.clientFor(people[0]), '');
  }
  f.set({ features: { voice: true }, voice: { allow: ['*'] } });
  assert.equal((await f.request({ user: '' })).status, 404);
  for (const user of [null, {}, { unionId: 'union-tang' }, { slug: '../tang', unionId: 'union-tang' }]) assert.equal(f.handler.clientFor(user), '');
  f.break(); assert.equal((await f.request()).status, 404); assert.equal(f.handler.clientFor(people[0]), '');
});

test('voice checks method, exact origin and WAV content type before forwarding', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ method: 'GET', send: req => req.end() })).status, 405);
  for (const origin of ['', 'https://evil.test', ORIGIN + '.evil.test']) assert.equal((await f.request({ headers: { origin } })).status, 403);
  for (const type of ['audio/webm', '', 'audio/wav-extra']) assert.equal((await f.request({ headers: { 'content-type': type } })).status, 415);
  assert.equal(f.hits.length, 0);
  const reply = await f.request({ headers: { 'content-type': 'audio/wav; codecs=1' } });
  assert.deepEqual(reply.data, { text: '识别结果' }); assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.equal(f.hits[0].url, '/v1/recognize'); assert.equal(f.hits[0].method, 'POST');
  assert.equal(f.hits[0].headers['content-type'], 'audio/wav'); assert.equal(f.hits[0].body.toString(), 'audio-private');
  assert.equal(f.hits[0].headers['x-user'], undefined); assert.equal(f.hits[0].headers.cookie, undefined);
});

test('oversized declared and chunked uploads stop early, return 413, never reach ASR, and release the user', async t => {
  const f = await fixture(t);
  const max = 2 * 1024 * 1024;
  await f.request({ headers: { 'content-length': max + 1 }, send: req => { req.write(Buffer.alloc(1)); },
    allowDisconnect: () => f.reads[0]?.status === 413 });
  assert.equal(f.reads[0].status, 413);
  assert.equal(f.reads[0].bytes, 0); assert.equal(f.reads[0].ended, false);
  await f.request({ send: req => { req.write(Buffer.alloc(max * 2)); }, allowDisconnect: () => f.reads[1]?.status === 413 });
  assert.equal(f.reads[1].status, 413); assert.ok(f.reads[1].bytes < max * 2); assert.equal(f.reads[1].ended, false);
  assert.equal(f.hits.length, 0);
  assert.equal((await f.request({ body: Buffer.alloc(max) })).status, 200);
  assert.equal(f.hits[0].body.length, max);
});

test('one in-flight recognition per union ID, other users proceed, and completion releases admission', async t => {
  const f = await fixture(t, { timeoutMs: 2000 }); f.state.hang = true;
  f.set({ features: { voice: true }, voice: { allow: ['*'] } });
  const first = f.request();
  while (!f.hits.length) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual((await f.request()).data, { error: 'busy' }); assert.equal((await f.request()).status, 429);
  f.state.hang = false; assert.equal((await f.request({ user: 'other' })).status, 200);
  f.hits[0].res.end('{"text":"done"}'); assert.deepEqual((await first).data, { text: 'done' });
  assert.equal((await f.request()).status, 200);
});

test('slow uploads time out before ASR admission and release the user without reading the full body', async t => {
  const f = await fixture(t, { timeoutMs: 300 });
  let upload;
  const pending = f.request({ send: req => { upload = req; req.write(Buffer.alloc(32)); }, allowDisconnect: () => f.reads[0]?.status === 408 });
  t.after(() => upload.destroy());
  while (!f.reads[0]?.bytes) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.hits.length, 0, 'ASR receives nothing while upload is incomplete');
  assert.equal((await f.request()).status, 429, 'upload holds the gateway user slot');
  const trickle = setInterval(() => upload.write(Buffer.alloc(32)), 20);
  upload.once('close', () => clearInterval(trickle));
  t.after(() => clearInterval(trickle));
  const started = Date.now(), reply = await pending; clearInterval(trickle);
  assert.equal(f.reads[0].status, 408);
  if (reply) {
    assert.equal(reply.status, 408); assert.deepEqual(reply.data, { error: 'unavailable' });
    assert.equal(reply.headers.connection, 'close');
  }
  assert.ok(Date.now() - started < 1500);
  assert.equal(f.reads[0].ended, false); assert.equal(f.hits.length, 0);
  assert.equal((await f.request()).status, 200, 'timed-out upload releases the user slot');
});

test('upload and upstream share one deadline and only complete bodies are forwarded', async t => {
  const f = await fixture(t, { timeoutMs: 800 }); f.state.hang = true;
  let finishUpload;
  const started = Date.now();
  const pending = f.request({ send: req => { req.write('first-'); finishUpload = () => req.end('last'); } });
  while (!f.reads[0]?.bytes) await new Promise(resolve => setTimeout(resolve, 2));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.hits.length, 0); finishUpload();
  const reply = await pending;
  assert.equal(reply.status, 503); assert.deepEqual(reply.data, { error: 'unavailable' });
  assert.equal(f.hits.length, 1); assert.equal(f.hits[0].body.toString(), 'first-last');
  assert.ok(Date.now() - started < 1150, 'upload time is deducted from the upstream budget');
  f.state.hang = false; assert.equal((await f.request()).status, 200);
});

test('only recognized upstream fields escape; bad responses never leak bodies or logs', async t => {
  const f = await fixture(t);
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args)); t.mock.method(console, 'log', (...args) => logs.push(args));
  for (const [status, body, expectedStatus, data] of [
    [200, { text: '正常', private: 'upstream-private' }, 200, { text: '正常' }],
    [400, { error: 'bad_audio', text: 'upstream-private' }, 400, { error: 'bad_audio' }],
    [400, { error: 'too_long', detail: 'upstream-private' }, 400, { error: 'too_long' }],
    [400, { error: 'upstream-private' }, 503, { error: 'unavailable' }],
    [503, { error: 'busy' }, 503, { error: 'busy' }],
    [500, { text: 'upstream-private' }, 503, { error: 'unavailable' }],
    [302, { text: 'upstream-private' }, 503, { error: 'unavailable' }],
    [200, { text: 42 }, 503, { error: 'unavailable' }], [200, null, 503, { error: 'unavailable' }],
  ]) {
    Object.assign(f.state, { status, body }); const reply = await f.request();
    assert.equal(reply.status, expectedStatus); assert.deepEqual(reply.data, data); assert.ok(!reply.raw.includes('upstream-private'));
  }
  f.state.invalid = true;
  for (const status of [200, 400, 503]) {
    f.state.status = status; const reply = await f.request(); assert.equal(reply.status, 503); assert.deepEqual(reply.data, { error: 'unavailable' });
  }
  f.state.invalid = false; f.state.status = 200; f.state.body = { text: 'x'.repeat(1024 * 1024 + 1) };
  assert.deepEqual((await f.request()).data, { error: 'unavailable' });
  assert.deepEqual(logs, []);
});

test('wall-clock timeout covers hanging and trickling responses, failure releases user, connection refusal maps to unavailable', async t => {
  const f = await fixture(t, { timeoutMs: 80 }); f.state.hang = true;
  const started = Date.now(), pending = f.request();
  while (!f.hits.length) await new Promise(resolve => setTimeout(resolve, 2));
  const interval = setInterval(() => f.hits[0].res.write(' '), 10);
  const reply = await pending; clearInterval(interval);
  assert.equal(reply.status, 503); assert.deepEqual(reply.data, { error: 'unavailable' }); assert.ok(Date.now() - started < 1000);
  assert.equal((await f.request()).status, 503);
  f.state.hang = false; assert.equal((await f.request()).status, 200);
  f.upstream.closeAllConnections(); await new Promise(resolve => f.upstream.close(resolve));
  assert.deepEqual((await f.request()).data, { error: 'unavailable' });
});

test('text is limited to 2000 Unicode characters', async t => {
  const f = await fixture(t); f.state.body = { text: '你😀'.repeat(1100) };
  assert.deepEqual((await f.request()).data, { text: '你😀'.repeat(1000) });
});

test('real gateway appends voice at both preview injection points, default/off and denied bytes stay unchanged', async t => {
  const harness = await createHarness('voice-unit'); t.after(() => harness.stop());
  for (const preview of [true, false]) {
    const off = await harness.startGateway('off-' + preview, { preview, feedback: false });
    const on = await harness.startGateway('on-' + preview, { preview, feedback: false, voice: { allow: ['member'] } });
    const get = (gateway, who) => gateway.request('GET', '/_wp/preview/client.js', { who });
    const baseline = await get(off, 'member'), outsiderBaseline = await get(off, 'outsider');
    const denied = await get(on, 'outsider'), admitted = await get(on, 'member');
    assert.equal(baseline.status, 200); assert.deepEqual(denied.body, outsiderBaseline.body);
    assert.equal(admitted.body.toString(), baseline.body.toString() + voiceClient());
    assert.equal(admitted.headers['cache-control'], 'no-store');
    const disabled = await off.request('POST', API, { who: 'member' }); assert.equal(disabled.status, 404);
    const rejected = await on.request('POST', API, { who: 'member' }); assert.equal(rejected.status, 415);
    assert.ok(!admitted.body.includes(Buffer.from('union-member')));
  }
  const defaults = JSON.parse(fs.readFileSync(new URL('../organization/default.json', import.meta.url)));
  assert.equal(defaults.features.voice, false); assert.deepEqual(defaults.voice.allow, []);
});
