import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { createVoiceInput, voicePolicy, audioExtension, transcriptionForm } from '../voice-input.mjs';
import { voiceInputClient } from '../voice-input-client.mjs';

const API = '/_wp/api/voice-input', ORIGIN = 'https://workspace.example.test';
const people = [{ slug: 'member', unionId: 'union-member' }, { slug: 'second-member', unionId: 'union-second-member' }];
const keys = { member: 'sk-fixture-member-3f9a', 'second-member': 'sk-fixture-other-7b2c' };

async function fixture(t, { voiceInput = {}, upstream = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-input-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hits = [], state = { status: 200, reply: { text: '  hello world  ' }, hold: null, ...upstream };
  const model = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      hits.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
      if (state.hold) { const hold = state.hold; state.hold = null; await hold; }
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(typeof state.reply === 'string' ? state.reply : JSON.stringify(state.reply));
    });
  });
  await listen(model);
  const organization = { features: { voiceInput: true }, server: { publicOrigin: ORIGIN },
    model: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, defaults: { language: 'zh-CN' } },
    voiceInput: { allow: ['*'], model: 'speech-model', ...voiceInput } };
  const file = path.join(directory, 'organization.json');
  const save = () => fs.writeFileSync(file, JSON.stringify(organization)); save();
  const user = req => people.find(p => req.headers.cookie === `session=${p.slug}`) || (req.headers.cookie === 'session=pending' ? { unionId: 'union-pending' } : null);
  const handler = createVoiceInput({ organization, organizationData: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    authenticate: user, sessionAuthenticate: req => req.headers.cookie === 'session=pending' ? {} : null, keyFor: u => keys[u.slug], timeoutMs: 2000 });
  const logs = [], error = console.error; console.error = (...args) => logs.push(args.join(' ')); t.after(() => { console.error = error; });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(418); res.end(); } });
  await listen(server);
  for (const s of [model, server]) t.after(() => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); });
  function request({ method = 'POST', member = 'member', headers = {}, body = Buffer.from('fixture-audio') } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: API, method,
        headers: { ...(member ? { cookie: 'session=' + member } : {}), origin: ORIGIN, 'content-type': 'audio/webm;codecs=opus', ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          assert.equal(res.headers['cache-control'], 'no-store');
          resolve({ status: res.statusCode, body: text, data: text ? JSON.parse(text) : null });
        });
      }); req.on('error', reject); req.end(method === 'GET' ? undefined : body);
    });
  }
  return { request, organization, save, state, hits, logs };
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }

test('policy clamps limits, derives language and rejects unsafe model names', () => {
  assert.deepEqual(voicePolicy(undefined, 'zh-CN'), { allow: [], model: '', language: 'zh', maxSeconds: 60, maxBytes: 5242880 });
  assert.deepEqual(voicePolicy({ allow: ['a'], model: 'group/whisper-1', language: 'en', maxSeconds: 1, maxBytes: 1 }, 'zh-CN'),
    { allow: ['a'], model: 'group/whisper-1', language: 'en', maxSeconds: 5, maxBytes: 65536 });
  assert.equal(voicePolicy({ maxSeconds: 9999, maxBytes: 1e12 }).maxSeconds, 300);
  assert.equal(voicePolicy({ maxBytes: 1e9 }).maxBytes, 25 * 1024 * 1024);
  assert.equal(voicePolicy({ model: 'a"\r\nb' }).model, '');
  assert.equal(voicePolicy({ allow: [1] }).allow.length, 0);
  assert.equal(voicePolicy({ language: 'EN-us' }, '').language, '');
});

test('only known recorder containers are accepted', () => {
  assert.deepEqual(audioExtension('audio/webm;codecs=opus'), { type: 'audio/webm', extension: 'webm' });
  assert.deepEqual(audioExtension('Audio/MP4'), { type: 'audio/mp4', extension: 'm4a' });
  for (const value of ['', 'text/plain', 'audio/x-unknown', 'multipart/form-data', 'toString', undefined]) assert.equal(audioExtension(value), null);
});

test('transcription form carries model, language and the untouched audio', () => {
  const audio = Buffer.from([0, 1, 2, 255]);
  const form = transcriptionForm({ audio, type: 'audio/ogg', extension: 'ogg', model: 'speech-model', language: 'zh' });
  const boundary = /boundary=(.+)$/.exec(form.contentType)[1];
  const text = form.body.toString('latin1');
  assert.match(text, new RegExp(`name="model"\\r\\n\\r\\nspeech-model\\r\\n`));
  assert.match(text, /name="language"\r\n\r\nzh\r\n/);
  assert.match(text, /filename="speech\.ogg"\r\nContent-Type: audio\/ogg\r\n\r\n/);
  assert.ok(form.body.includes(Buffer.concat([Buffer.from('\r\n\r\n'), audio, Buffer.from(`\r\n--${boundary}--\r\n`)])));
  assert.ok(!transcriptionForm({ audio, type: 'audio/ogg', extension: 'ogg', model: 'm', language: '' }).body.toString().includes('name="language"'));
});

test('transcribes with the session owner key and returns trimmed text', async t => {
  const f = await fixture(t);
  for (const person of people) {
    const reply = await f.request({ member: person.slug, headers: { 'x-user': 'member', authorization: 'Bearer forged' } });
    assert.equal(reply.status, 200); assert.deepEqual(reply.data, { text: 'hello world' });
    const hit = f.hits.at(-1);
    assert.equal(hit.url, '/v1/audio/transcriptions'); assert.equal(hit.method, 'POST');
    assert.equal(hit.headers.authorization, 'Bearer ' + keys[person.slug]);
    assert.match(hit.headers['content-type'], /^multipart\/form-data; boundary=wp-voice-[0-9a-f]{24}$/);
    assert.ok(hit.body.includes(Buffer.from('fixture-audio')));
    assert.ok(hit.body.toString().includes('speech-model')); assert.ok(!hit.body.toString().includes(person.unionId));
  }
  assert.equal(f.logs.length, 0);
});

test('live admission, model and authentication gate the route', async t => {
  const f = await fixture(t, { voiceInput: { allow: [] } });
  assert.equal((await f.request()).status, 404);
  assert.equal((await f.request({ member: '' })).status, 401);
  assert.equal((await f.request({ member: 'pending' })).status, 404);
  f.organization.voiceInput.allow = ['union-member']; f.save();
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request({ member: 'second-member' })).status, 404);
  f.organization.voiceInput.model = ''; f.save();
  assert.equal((await f.request()).status, 404);
  assert.equal(f.hits.length, 1);
});

test('rejects wrong method, origin, type, empty and oversized audio before calling upstream', async t => {
  const f = await fixture(t, { voiceInput: { maxBytes: 65536 } });
  assert.equal((await f.request({ method: 'GET' })).status, 405);
  assert.equal((await f.request({ headers: { origin: 'https://evil.example.test' } })).status, 403);
  assert.equal((await f.request({ headers: { origin: '' } })).status, 403);
  assert.equal((await f.request({ headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await f.request({ body: Buffer.alloc(0) })).status, 400);
  assert.equal((await f.request({ body: Buffer.alloc(65537) })).status, 413);
  assert.equal(f.hits.length, 0);
  assert.equal((await f.request({ body: Buffer.alloc(65536) })).status, 200);
});

test('upstream failures become a generic 502 without leaking bodies, keys or text', async t => {
  const f = await fixture(t, { upstream: { status: 500, reply: { error: 'secret upstream detail sk-fixture-member-3f9a' } } });
  for (const [status, reply] of [[500, { error: 'secret upstream detail' }], [200, '{'], [200, { text: 7 }], [302, {}]]) {
    f.state.status = status; f.state.reply = reply;
    const result = await f.request();
    assert.equal(result.status, 502); assert.deepEqual(result.data, { error: 'Voice input request failed' });
  }
  assert.ok(f.logs.every(line => line === '[voice-input] 502'));
  assert.ok(!f.logs.join('').includes('secret') && !f.logs.join('').includes('sk-'));
});

test('allows one transcription per person at a time', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { upstream: { hold } });
  const first = f.request();
  while (!f.hits.length) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.request()).status, 429);
  assert.equal((await f.request({ member: 'second-member' })).status, 200);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await f.request()).status, 200);
});

test('client serializes only limits and is syntactically valid script', () => {
  const client = voiceInputClient({ maxSeconds: 42, maxBytes: 70000 });
  assert.ok(client.startsWith('\n;(function installVoiceInput'));
  assert.ok(client.endsWith('({"maxSeconds":42,"maxBytes":70000});'));
  new Script(client);
});

test('client-for follows live admission', async t => {
  const f = await fixture(t, { voiceInput: { allow: ['member'], maxSeconds: 30 } });
  const handler = createVoiceInput({ organization: f.organization, organizationData: () => f.organization, authenticate: () => null, keyFor: () => '' });
  assert.ok(handler.clientFor(people[0]).includes('"maxSeconds":30'));
  assert.equal(handler.clientFor(people[1]), '');
  assert.equal(handler.clientFor(null), '');
  f.organization.voiceInput.model = '';
  assert.equal(handler.clientFor(people[0]), '');
});
