import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createVoice } from '../voice.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requests = [];
  t.mock.method(http, 'request', (url, options, receive) => {
    const request = new PassThrough(), chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => requests.push({ url, options, body: Buffer.concat(chunks), request,
      reply(status, data) { const response = new PassThrough(); response.statusCode = status; receive(response); response.end(JSON.stringify(data)); } }));
    return request;
  });
  const origin = 'https://voice.example.test';
  const handle = createVoice({ organization: { server: { publicOrigin: origin } },
    organizationData: () => ({ features: { voice: true }, voice: { allow: ['tang'] } }),
    authenticate: () => ({ slug: 'tang', unionId: 'union-tang' }), asrUrl: 'http://asr.test', timeoutMs: 1000 });
  return { requests,
    advance(ms) { now += ms; t.mock.timers.tick(ms); },
    send(body = '', complete = true) {
      const req = new PassThrough(), res = new EventEmitter();
      req.method = 'POST'; req.headers = { origin, 'content-type': 'audio/wav' };
      res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
      res.end = raw => { res.data = JSON.parse(raw); res.emit('finish'); };
      const done = handle(req, res, new URL('/_wp/api/voice/recognize', origin));
      if (body) req.write(body);
      if (complete) req.end();
      t.after(() => req.destroy());
      return { req, res, done };
    },
  };
}

test('trickling upload expires at the total deadline, skips ASR and releases its user slot', { timeout: 2000 }, async t => {
  const f = fixture(t), upload = f.send('first', false);
  await tick(); f.advance(400); upload.req.write('next'); await tick();
  const busy = f.send('other'); await busy.done;
  assert.equal(busy.res.status, 429); assert.deepEqual(busy.res.data, { error: 'busy' });
  assert.equal(f.requests.length, 0);
  f.advance(599); assert.equal(upload.res.status, undefined);
  f.advance(1); await upload.done;
  assert.equal(upload.res.status, 408); assert.deepEqual(upload.res.data, { error: 'unavailable' });
  assert.equal(upload.res.headers.connection, 'close'); assert.equal(upload.req.destroyed, true);
  for (const event of ['data', 'end', 'error', 'aborted']) assert.equal(upload.req.listenerCount(event), 0);
  assert.equal(f.requests.length, 0);
  const retry = f.send('retry'); await tick();
  assert.equal(f.requests.length, 1); f.requests[0].reply(200, { text: 'done' }); await retry.done;
  assert.equal(retry.res.status, 200); assert.deepEqual(retry.res.data, { text: 'done' });
});

test('ASR gets a complete buffered body and only the deadline remaining after upload', { timeout: 2000 }, async t => {
  const f = fixture(t), upload = f.send('first-', false);
  await tick(); f.advance(700);
  assert.equal(f.requests.length, 0);
  upload.req.end('last'); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.toString(), 'first-last');
  assert.equal(f.requests[0].url.pathname, '/v1/recognize');
  assert.equal(f.requests[0].options.headers['content-length'], 10);
  f.advance(299); assert.equal(upload.res.status, undefined);
  f.advance(1); await upload.done;
  assert.equal(upload.res.status, 503); assert.deepEqual(upload.res.data, { error: 'unavailable' });
  assert.equal(f.requests[0].request.destroyed, true);
  const retry = f.send('retry'); await tick(); f.requests[1].reply(200, { text: 'done' }); await retry.done;
  assert.equal(retry.res.status, 200);
});

test('oversized and aborted uploads never reach ASR and release admission', { timeout: 2000 }, async t => {
  const f = fixture(t), large = f.send('', false);
  large.req.write(Buffer.alloc(2 * 1024 * 1024 + 1)); await large.done;
  assert.equal(large.res.status, 413); assert.deepEqual(large.res.data, { error: 'too_large' });
  assert.equal(large.req.destroyed, true); assert.equal(f.requests.length, 0);
  const aborted = f.send('partial', false); aborted.req.emit('aborted'); await aborted.done;
  assert.equal(aborted.res.status, 400); assert.equal(f.requests.length, 0);
  const retry = f.send('retry'); await tick(); f.requests[0].reply(200, { text: 'done' }); await retry.done;
  assert.equal(retry.res.status, 200);
  f.advance(1000); assert.equal(retry.res.status, 200, 'completed requests have no remaining deadline timer');
});
