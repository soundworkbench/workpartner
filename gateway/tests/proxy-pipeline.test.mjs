import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { proxyPipeline } from '../proxy-pipeline.mjs';

const waitForClose = stream => new Promise(resolve => stream.once('close', resolve));

test('client interruption does not invalidate the route', async () => {
  const upstream = new PassThrough();
  const response = new PassThrough();
  let lost = 0;
  proxyPipeline(upstream, response, { lost: () => { lost++; } });
  const closed = waitForClose(response);
  response.destroy();
  await closed;
  upstream.end('discarded');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lost, 0);
});

test('upstream stream errors invalidate the route', async () => {
  const upstream = new PassThrough();
  const response = new PassThrough();
  let lost = 0;
  proxyPipeline(upstream, response, { lost: () => { lost++; } });
  const closed = waitForClose(response);
  upstream.destroy(Object.assign(new Error('upstream failed'), { code: 'ECONNRESET' }));
  await closed;
  assert.equal(lost, 1);
});
