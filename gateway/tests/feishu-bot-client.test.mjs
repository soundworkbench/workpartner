import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { feishuBotClient } from '../feishu-bot-client.mjs';

function page() {
  const timers = new Map(), frames = new Map(), listeners = {}, requests = [], tags = [];
  let mutation, disconnected = false;
  let nextTimer = 0, status = 200;
  const document = { hidden: false, readyState: 'complete', head: { append() {} }, body: {},
    createElement: tag => { tags.push(tag); return { remove() {} }; }, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (name, callback) => { listeners[name] = callback; },
    removeEventListener: name => { delete listeners[name]; } };
  const context = vm.createContext({ document, window: { addEventListener() {}, removeEventListener() {} },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() { disconnected = true; } },
    requestAnimationFrame: callback => { const id = ++nextTimer; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { requests.push({ url, options }); return { status, ok: status === 200, json: async () => ({ bots: [] }) }; },
  });
  vm.runInContext(feishuBotClient(), context);
  return { timers, frames, requests, tags, document, listeners, mutate: () => mutation(), disconnected: () => disconnected, status: value => { status = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function tick(p) {
  const [id, timer] = p.timers.entries().next().value; p.timers.delete(id); await timer.callback(); await settle();
}

test('serialized client loads once, polls every 60 seconds and pauses while hidden', async () => {
  const p = page(); await settle();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url, '/_wp/feishu-bot/bots');
  assert.equal(p.requests[0].options.credentials, 'same-origin');
  assert.equal(p.requests[0].options.cache, 'no-store');
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
  await tick(p); assert.equal(p.requests.length, 2);
  p.document.hidden = true; p.listeners.visibilitychange();
  assert.equal(p.timers.size, 0); assert.equal(p.requests.length, 2);
  p.document.hidden = false; p.listeners.visibilitychange(); await settle();
  assert.equal(p.requests.length, 3);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
});

for (const status of [401, 404]) test(`serialized client stops polling after admission is revoked (${status})`, async () => {
  const p = page(); await settle(); p.status(status); await tick(p);
  assert.equal(p.timers.size, 0); assert.equal(p.requests.length, 2);
  p.listeners.visibilitychange?.(); await settle(); assert.equal(p.requests.length, 2);
  assert.equal(p.disconnected(), true);
});

test('transient failure retries on the next visible 60-second cycle', async () => {
  const p = page(); await settle(); p.status(503); await tick(p);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
  p.status(200); await tick(p); assert.equal(p.requests.length, 3);
});

test('an in-flight initial request finishing while hidden does not start polling', async () => {
  const p = page(); p.document.hidden = true; p.listeners.visibilitychange(); await settle();
  assert.equal(p.requests.length, 1); assert.equal(p.timers.size, 0);
});

test('mutation bursts coalesce to one frame and revocation cancels queued mounts', async () => {
  const p = page(); await settle();
  for (let i = 0; i < 20; i++) await p.mutate();
  assert.equal(p.frames.size, 1);
  const [id, callback] = [...p.frames][0]; p.frames.delete(id); await callback();
  await p.mutate(); assert.equal(p.frames.size, 1);
  p.status(404); await tick(p);
  assert.equal(p.frames.size, 0); assert.equal(p.disconnected(), true);
  assert.equal(p.tags.includes('dialog'), false);
});

test('safe mount callbacks contain DOM errors without stopping refresh', async () => {
  const p = page(); await settle();
  p.document.querySelectorAll = () => { throw new Error('DOM unavailable'); };
  await p.mutate(); const callback = [...p.frames.values()][0];
  await assert.doesNotReject(async () => { await callback(); });
  await tick(p); assert.equal(p.requests.length, 2);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
});
