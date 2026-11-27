import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { brotliDecompressSync } from 'node:zlib';
import { createFeishuBot } from '../feishu-bot.mjs';
import { clientResponse } from '../client-response.mjs';
import { aionuiResponseHeaders } from '../aionui.mjs';

function call(handler, route, headers = {}, method = 'GET') {
  const req = Readable.from(method === 'POST' ? [Buffer.from('{}')] : []); req.method = method; req.headers = { cookie: 'one', ...headers };
  return new Promise(async resolve => {
    let status, responseHeaders, body;
    await handler(req, { writeHead: (s, h) => { status = s; responseHeaders = h; }, end: b => { body = b; } }, new URL(route, 'https://test'));
    resolve({ status, headers: responseHeaders, body });
  });
}

test('bots cache is per user and refreshes after a write', async () => {
  let calls = 0;
  const users = [{ slug: 'one', unionId: 'one', backend: 'aionui' }, { slug: 'two', unionId: 'two', backend: 'aionui' }];
  const handler = createFeishuBot({ organization: { server: { publicOrigin: 'https://test' }, runtime: { uid: 1 } },
    organizationData: () => ({ features: { feishuBot: true }, feishuBot: { allow: ['*'] } }), authenticate: req => users.find(u => u.slug === req.headers.cookie),
    runtime: { exec: async () => { calls++; return { exitCode: 0, stdout: JSON.stringify({ ok: true, bots: [] }) }; } }, cacheEnabled: true });
  assert.equal((await call(handler, '/_wp/feishu-bot/bots', { cookie: 'one' })).status, 200);
  assert.equal((await call(handler, '/_wp/feishu-bot/bots', { cookie: 'one' })).status, 200);
  assert.equal((await call(handler, '/_wp/feishu-bot/bots', { cookie: 'two' })).status, 200);
  assert.equal(calls, 2);
  await call(handler, '/_wp/feishu-bot/reconnect', { cookie: 'one', origin: 'https://test', 'content-type': 'application/json' }, 'POST');
  await call(handler, '/_wp/feishu-bot/bots', { cookie: 'one' });
  assert.equal(calls, 4);
});

test('client response negotiates br and returns 304 with private cache headers', () => {
  let headers, compressed;
  clientResponse({ method: 'GET', headers: { 'accept-encoding': 'br, gzip' } }, { writeHead: (s, h) => { headers = { s, ...h }; }, end: body => { compressed = body; } }, 'x'.repeat(5000), { 'content-type': 'application/javascript' });
  assert.equal(headers.s, 200); assert.equal(headers['content-encoding'], 'br'); assert.equal(brotliDecompressSync(compressed).toString(), 'x'.repeat(5000));
  let second; clientResponse({ method: 'GET', headers: { 'accept-encoding': 'br', 'if-none-match': headers.etag } }, { writeHead: s => { second = s; }, end: () => {} }, 'x'.repeat(5000), { 'content-type': 'application/javascript' });
  assert.equal(second, 304);
});

test('immutable asset cache policy is limited to .imm. names', () => {
  assert.equal(aionuiResponseHeaders({}, '"x"', 200, '/assets/app-AbCd1234.imm.js')['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(aionuiResponseHeaders({}, '"x"', 200, '/assets/index-AbCd1234.js')['cache-control'], 'no-cache');
});
