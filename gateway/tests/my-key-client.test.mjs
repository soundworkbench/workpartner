import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { myKeyClient } from '../my-key-client.mjs';

const API = '/_wp/api/my-key';
const fixture = status => ({ key: { masked: 'sk-••••••••1234' }, reset: { status, allowed: status === 'idle', left: 3, limit: 3 } });

// Execute the shipped reset workflow with its browser boundaries supplied in memory.
// No browser or listening socket is required to reproduce a lost POST response.
function client(fetch) {
  const script = myKeyClient();
  const api = script.slice(script.indexOf('    async function api('), script.indexOf('    function menus('));
  const workflow = script.slice(script.indexOf('    const currentReset ='), script.indexOf('    async function clipboard('));
  const timers = [];
  const context = vm.createContext({ fetch, timers, Date, API, data: fixture('idle'), version: 1,
    dialog: { open: true }, revoked: false, resetBusy: false, confirming: true, resetResult: '', status: '',
    pollTimer: undefined, pollStarted: 0, hide() {}, renderKey() {}, renderStatus() {}, render() {},
    safe: fn => fn, stopPolling() { timers.length = 0; },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    revoke() { context.revoked = true; context.dialog.open = false; },
  });
  vm.runInContext(api + workflow + '\nthis.confirmReset = confirmReset;', context);
  return context;
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('lost reset POST checks main status and resumes pending polling through completion', async () => {
  const requests = [];
  const c = client(async (url, options) => {
    requests.push(options.method + ' ' + url);
    if (options.method === 'POST') throw new Error('Response lost after acceptance');
    if (url === API + '/reset') return response({ status: 'done' });
    return response(fixture(requests.length === 2 ? 'pending' : 'idle'));
  });
  await c.confirmReset();
  assert.deepEqual(requests, ['POST ' + API + '/reset', 'GET ' + API]);
  assert.equal(c.resetResult, ''); assert.equal(c.resetBusy, true);
  assert.equal(c.status, 'reset-progress'); assert.equal(c.data.reset.status, 'pending');
  assert.equal(c.timers.length, 1);
  await c.timers.shift()();
  assert.equal(c.resetResult, 'done'); assert.equal(c.resetBusy, false);
  assert.deepEqual(requests, ['POST ' + API + '/reset', 'GET ' + API, 'GET ' + API + '/reset', 'GET ' + API]);
});

test('lost reset POST reports failure only after main status is not pending', async () => {
  const requests = [];
  const c = client(async (url, options) => {
    requests.push(options.method + ' ' + url);
    if (options.method === 'POST') throw new Error('Request lost before acceptance');
    return response(fixture('idle'));
  });
  await c.confirmReset();
  assert.deepEqual(requests, ['POST ' + API + '/reset', 'GET ' + API]);
  assert.equal(c.resetResult, 'failed'); assert.equal(c.resetBusy, false); assert.equal(c.timers.length, 0);
});

test('failed recovery GET settles the reset failure without polling', async () => {
  const requests = [];
  const c = client(async (url, options) => { requests.push(options.method + ' ' + url); throw new Error('Offline'); });
  await c.confirmReset();
  assert.deepEqual(requests, ['POST ' + API + '/reset', 'GET ' + API]);
  assert.equal(c.resetResult, 'failed'); assert.equal(c.resetBusy, false); assert.equal(c.timers.length, 0);
});

test('recovery ignores a pending response after the dialog closes', async () => {
  let resolveGet;
  const c = client(async (url, options) => {
    if (options.method === 'POST') throw new Error('Response lost');
    return new Promise(resolve => { resolveGet = resolve; });
  });
  const pending = c.confirmReset();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveGet, 'function');
  c.dialog.open = false; c.version++;
  resolveGet(response(fixture('pending'))); await pending;
  assert.equal(c.resetResult, ''); assert.equal(c.data.reset.status, 'idle'); assert.equal(c.timers.length, 0);
});

for (const status of [401, 404]) test(`recovery GET ${status} revokes admission without publishing failure`, async () => {
  const c = client(async (url, options) => {
    if (options.method === 'POST') throw new Error('Response lost');
    return response({}, status);
  });
  await c.confirmReset();
  assert.equal(c.revoked, true); assert.equal(c.dialog.open, false);
  assert.equal(c.resetResult, ''); assert.equal(c.timers.length, 0);
});
