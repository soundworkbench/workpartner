import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HelperSettings } from '../dist/main/helper-settings.js';
import { DesktopRelay, retryDelay } from '../dist/main/relay.js';
import { DesktopAuth } from '../dist/main/auth.js';
import { mockGateway } from './mock-gateway.mjs';

async function until(f, ms = 3500) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() >= end) assert.fail('condition timed out');
    await delay(10);
  }
}
function device(t, gateway, options = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'desktop-ws-')));
  const store = path.join(base, 'store'), root = path.join(base, 'shared');
  fs.mkdirSync(store);
  fs.mkdirSync(root);
  let relay, token = gateway.token;
  const state = { revoked: 0, refreshes: 0, status: '' };
  const auth = {
    token: () => token,
    refresh: async () => {
      state.refreshes++;
      return options.renew?.() ?? false;
    },
    markRevoked: () => {
      state.revoked++;
      token = undefined;
    }
  };
  const settings = new HelperSettings(store, async () => root, () => relay.settingsChanged());
  relay = new DesktopRelay({
    origin: gateway.origin, appVersion: '0.3.0', loopbackTest: true, settings,
    auth: options.auth || auth, run: options.run, status: s => { state.status = s; }
  });
  t.after(async () => {
    await relay.stop('app_quit');
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { relay, settings, state, store, root, online: () => until(() => relay.state === '本机助手已连接') };
}

test('handshake, heartbeat, activity, state and routing of all four tools', async t => {
  const gw = await mockGateway(t), a = device(t, gw), b = device(t, gw);
  assert.deepEqual(gw.call('desktop_list_devices').data, { count: 0, devices: [] });
  a.settings.setDeviceName('工作台');
  await a.online();
  b.relay.connect();
  await b.online();
  const entry = gw.devices.get(a.settings.deviceId), req = gw.attempts[0];
  assert.equal(req.url, '/_wp/desktop/ws');
  assert.equal(req.version, '1');
  assert.equal(req.id, entry.deviceId);
  assert.equal(req.platform, process.platform);
  assert.equal(req.app, '0.3.0');
  assert.ok(req.headers.includes('authorization'));
  assert.equal(entry.deviceName, '工作台');
  assert.deepEqual(entry.capabilities, ['fs.read']);
  assert.deepEqual(entry.allowedRoots, []);
  const pong = once(entry.ws, 'pong');
  entry.ws.ping();
  await pong;
  a.relay.active();
  a.relay.active();
  await until(() => entry.activeUpdates === 1);
  assert.equal((await gw.call('desktop_list_dir', { path: a.root, device_id: entry.deviceId })).error.code, 'NO_ALLOWED_ROOTS');
  a.settings.setPreferred(true);
  await a.settings.addDirectory();
  await until(() => entry.preferred && entry.allowedRoots.length === 1);
  assert.equal(gw.call('desktop_list_devices').data.count, 2);
  const content = 'content-' + randomUUID();
  fs.writeFileSync(path.join(a.root, 'notes'), content);
  assert.equal((await gw.call('desktop_list_dir', { path: a.root })).data.entries[0].name, 'notes');
  assert.equal((await gw.call('desktop_read_file', { path: path.join(a.root, 'notes') })).data.content, content);
  assert.equal((await gw.call('desktop_search_files', { query: content, mode: 'content' })).data.matches[0].snippet, content);
  assert.equal((await gw.call('desktop_search_files', { query: 'notes', device_id: b.settings.deviceId })).error.code, 'NO_ALLOWED_ROOTS');
  assert.equal((await gw.call('desktop_unknown', {})).error.code, 'TOOL_NOT_SUPPORTED');
  const audit = fs.readFileSync(path.join(a.store, 'logs', fs.readdirSync(path.join(a.store, 'logs'))[0]), 'utf8');
  assert.ok(!audit.includes(content) && !audit.includes(gw.token));
  assert.ok(audit.trim().split('\n').some(line => JSON.parse(line).decision === 'policy_deny'));
  a.settings.removeDirectory(a.root);
  await until(() => entry.allowedRoots.length === 0);
  const closed = once(entry.ws, 'close');
  a.settings.setPaused(true);
  const [code, reason] = await closed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'helper_paused');
  assert.equal(gw.call('desktop_list_devices').data.count, 1);
  a.settings.setPaused(false);
  await a.online();
});

test('actual local deadline, frame overflow, four in-flight calls, cancellation and disconnect', async t => {
  const gw = await mockGateway(t), real = device(t, gw);
  await real.settings.addDirectory();
  await real.online();
  const d = gw.devices.get(real.settings.deviceId);
  const slow = await gw.request(d, 'desktop_search_files', { query: 'x' }, 1, 1000).result;
  assert.equal(slow.error.code, 'TOOL_TIMEOUT');
  assert.equal(slow.error.retryable, true);
  fs.writeFileSync(path.join(real.root, 'escaped'), '\u0001'.repeat(262144));
  const large = await gw.call('desktop_read_file', { path: path.join(real.root, 'escaped'), max_bytes: 262144, device_id: d.deviceId });
  assert.equal(large.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(large.error.retryable, false);
  const active = new Set();
  const other = device(t, gw, {
    run: (job, signal) => new Promise((resolve, reject) => {
      active.add(signal);
      signal.addEventListener('abort', () => {
        active.delete(signal);
        reject(signal.reason);
      }, { once: true });
    })
  });
  other.relay.connect();
  await other.online();
  const peer = gw.devices.get(other.settings.deviceId);
  const jobs = Array.from({ length: 4 }, () => gw.request(peer, 'desktop_search_files', { query: 'x' }, 15000, 300));
  await until(() => active.size === 4);
  const denied = await gw.request(peer, 'desktop_list_dir', {}).result;
  assert.equal(denied.error.code, 'CONCURRENCY_LIMIT_EXCEEDED');
  await Promise.all(jobs.map(async j => assert.equal((await j.result).error.code, 'TOOL_TIMEOUT')));
  await until(() => active.size === 0);
  assert.ok(jobs.every(j => !gw.replies.includes(j.reqId)));
  const last = gw.request(peer, 'desktop_search_files', { query: 'x' });
  await until(() => active.size === 1);
  peer.ws.terminate();
  assert.equal((await last.result).error.code, 'DEVICE_DISCONNECTED');
  await until(() => active.size === 0);
});

test('network loss backs off, system wake retries promptly and binary frames are rejected', async t => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(n => retryDelay(n, () => 0.5)), [1000, 2000, 4000, 8000, 15000, 30000, 30000]);
  assert.equal(retryDelay(0, () => 0), 800);
  assert.equal(retryDelay(0, () => 1), 1200);
  const gw = await mockGateway(t), a = device(t, gw);
  a.relay.connect();
  await a.online();
  let d = gw.devices.get(a.settings.deviceId);
  const start = Date.now();
  d.ws.terminate();
  await until(() => gw.attempts.length === 2);
  assert.ok(Date.now() - start >= 780);
  await a.online();
  d = gw.devices.get(a.settings.deviceId);
  const closed = once(d.ws, 'close');
  d.ws.send(Buffer.from('x'));
  assert.equal((await closed)[0], 4004);
  await until(() => a.relay.state.includes('等待重连'));
  a.relay.wake();
  await a.online();
  d = gw.devices.get(a.settings.deviceId);
  const over = once(d.ws, 'close');
  d.ws.send('x'.repeat(1048577));
  assert.equal((await over)[0], 1009);
});

test('revocation, replacement, admission and incompatible protocol stop reconnecting', async t => {
  const gw = await mockGateway(t);
  for (const [code, reason, status] of [[4001, 'token_revoked', '失效'], [4002, 'replaced_by_new_connection', '接替'],
  [4003, 'not_admitted', '未开通'], [4004, 'unsupported_protocol', '升级']]) {
    const a = device(t, gw);
    a.relay.connect();
    await a.online();
    const count = gw.attempts.length;
    gw.devices.get(a.settings.deviceId).ws.close(code, reason);
    await until(() => a.relay.state.includes(status));
    a.relay.wake();
    a.relay.connect();
    await delay(25);
    assert.equal(gw.attempts.length, count);
    assert.equal(a.state.revoked, Number(code === 4001));
  }
});
test('upgrade failures, expired token refresh budget and legacy gateway probing', async t => {
  const gw = await mockGateway(t);
  for (const [status, text] of [[403, '未开通'], [426, '升级'], [429, '上限'], [404, '暂不支持'], [405, '暂不支持'], [501, '暂不支持']]) {
    gw.reject = status;
    const a = device(t, gw);
    a.relay.connect();
    await until(() => a.relay.state.includes(text));
    const count = gw.attempts.length;
    a.relay.wake();
    a.relay.connect();
    await delay(20);
    assert.equal(gw.attempts.length, count);
  }
  const a = device(t, gw, {
    renew: () => {
      gw.reject = 0;
      return true;
    }
  });
  gw.reject = 401;
  a.relay.connect();
  await a.online();
  gw.devices.get(a.settings.deviceId).ws.close(4001, 'token_expired');
  await until(() => a.state.revoked === 1);
  assert.equal(a.state.refreshes, 1);
  const b = device(t, gw);
  b.relay.connect();
  await b.online();
  gw.devices.get(b.settings.deviceId).ws.close(4001, 'token_expired');
  await until(() => b.state.revoked === 1);
  assert.equal(b.state.refreshes, 1);
});
test('real auth invalidates the saved credential and binds revocation to the active cookie', async t => {
  const gw = await mockGateway(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-revoked-')), file = path.join(base, 'desktop-token.enc');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const encrypted = new Map(), sid = randomUUID();
  let minted = 0, all = 0;
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString: s => {
      const handle = randomUUID();
      encrypted.set(handle, s);
      return Buffer.from(handle);
    },
    decryptString: b => encrypted.get(b.toString())
  };
  const io = {
    cookie: async () => sid, authorize: async url => {
      const q = new URL(url).searchParams, cb = new URL(q.get('redirect_uri'));
      cb.searchParams.set('state', q.get('state'));
      cb.searchParams.set('code', randomUUID());
      return { status: 302, location: cb.href };
    }, fetch: async (url, opts) => {
      if (url.endsWith('/me')) return Response.json({ union_id: sid });
      if (url.endsWith('/revoke-all')) {
        assert.ok(opts.headers.Authorization === 'Bearer ' + gw.token);
        all++;
        for (const d of gw.devices.values()) d.ws.close(4001, 'token_revoked');
        return Response.json({});
      }
      minted++;
      return Response.json({ access_token: gw.token, user: { union_id: sid }, expires_at: new Date(Date.now() + 86400000).toISOString() });
    }
  };
  const auth = new DesktopAuth('https://example.com', file, vault, io, () => { });
  await auth.sync();
  const a = device(t, gw, { auth });
  a.relay.connect();
  await a.online();
  const closed = once(gw.devices.get(a.settings.deviceId).ws, 'close');
  a.relay.stop('user_logout');
  auth.clear();
  const [code, why] = await closed;
  assert.equal(code, 1000);
  assert.equal(why.toString(), 'user_logout');
  assert.equal(all, 0);
  await auth.sync();
  a.relay.connect();
  await a.online();
  await auth.revokeAll();
  await until(() => fs.existsSync(file + '.revoked'));
  assert.equal(all, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(auth.token(), undefined);
  await new DesktopAuth('https://example.com', file, vault, io, () => { }).sync();
  assert.equal(minted, 2);
});


test('removing a grant aborts in-flight reads and reports the denial', async t => {
  const gw = await mockGateway(t);
  let started = false;
  const d = device(t, gw, {
    run: (_job, signal) => new Promise((resolve, reject) => {
      started = true;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  await d.settings.addDirectory();
  await d.online();
  const req = gw.request(gw.devices.get(d.settings.deviceId), 'desktop_read_file', { path: path.join(d.root, 'notes') });
  await until(() => started);
  d.settings.removeDirectory(d.root);
  assert.equal((await req.result).error.code, 'PATH_NOT_ALLOWED');
});

test('heartbeat control frames reset the 65 second client watchdog', async t => {
  const gw = await mockGateway(t), d = device(t, gw);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstHello = new Promise(resolve => { gw.beforeAck = resolve; });
  d.relay.connect();
  const { ws } = await firstHello;
  async function ping() {
    const pong = once(ws, 'pong');
    ws.ping();
    await pong;
  }
  await ping();
  t.mock.timers.tick(64000);
  await ping();
  t.mock.timers.tick(64999);
  assert.equal(ws.readyState, ws.OPEN);
  const closed = once(ws, 'close');
  t.mock.timers.tick(1);
  await closed;
  d.relay.stop('app_quit');
  t.mock.timers.reset();
});

test('a new connection with the same saved identity replaces the old one', async t => {
  const gw = await mockGateway(t), first = device(t, gw);
  first.relay.connect();
  await first.online();
  const second = new DesktopRelay({
    origin: gw.origin, loopbackTest: true, appVersion: '0.3.0', settings: first.settings,
    status: () => {}, auth: { token: () => gw.token, refresh: async () => false, markRevoked: () => {} }
  });
  t.after(() => second.stop('app_quit'));
  second.connect();
  await until(() => second.state.includes('已连接') && first.relay.state.includes('接替'));
  first.relay.wake();
  first.relay.connect();
  assert.equal(gw.attempts.length, 2);
  assert.equal(gw.call('desktop_list_devices').data.count, 1);
});
