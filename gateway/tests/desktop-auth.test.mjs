import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createDesktopAuth } from '../desktop-auth.mjs';

const redirect = 'http://127.0.0.1:12345/cb';
const person = { slug: 'tang', unionId: 'union-tang', name: 'Tang', avatar: 'avatar' };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-auth-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const organization = { server: { publicOrigin: 'https://workspace.example.test' }, runtime: { stateDirectory: directory, secureDirectory: directory }, model: { keyPrefix: 'model-' }, features: { myKey: true } };
  const config = { desktop: { enabled: true, allow: ['tang'], tokenDays: 30, keyRateLimitPerMinute: 30 }, myKey: { allow: ['tang'], publicBaseUrl: 'https://models.example.test' } };
  const keyFile = path.join(directory, 'model-tang.key'); fs.writeFileSync(keyFile, 'fixture-desktop-key');
  let clock = Date.parse('2026-11-25T00:00:00Z');
  const users = options.users || [person];
  const handler = createDesktopAuth({ organization, organizationData: () => config, users: () => users,
    onRevoke: options.onRevoke, sessionAuthenticate: req => options.sessionFor?.(req, users) || (req.headers.cookie === 'wp_sid=ok' ? person : null),
    keyFor: () => fs.readFileSync(keyFile, 'utf8'), keyFile: () => keyFile, sessionKey: 'fixture-session-key', now: () => clock });
  async function request(route, { method = 'GET', headers = {}, body } = {}) {
    const req = new EventEmitter(); req.method = method; req.headers = headers;
    const response = { headers: {}, writeHead(status, values) { this.statusCode = status; Object.assign(this.headers, values); }, end(value = '') { this.body = value; } };
    const pending = handler(req, response, new URL(route, 'https://workspace.example.test'));
    if (body !== undefined) { req.emit('data', Buffer.from(body)); req.emit('end'); }
    response.handleResult = await pending;
    return response;
  }
  function authorize(slug = 'ok') {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const route = '/_wp/desktop/authorize?' + new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'state-1' });
    return { verifier, request: request(route, { headers: { cookie: `wp_sid=${slug}` } }) };
  }
  return { request, authorize, config, users, keyFile, handle: handler, setClock(value) { clock = value; }, organization, directory };
}

test('desktop authorize, token, key and fingerprint flow is one-time and audited', async t => {
  const f = fixture(t); const flow = f.authorize(); const auth = await flow.request;
  assert.equal(auth.statusCode, 302); assert.strictEqual(auth.handleResult, true); const callback = new URL(auth.headers.location); const code = callback.searchParams.get('code');
  const tokenResponse = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect, device_name: 'CRY AI' }) });
  assert.equal(tokenResponse.statusCode, 200); assert.strictEqual(tokenResponse.handleResult, true); const token = JSON.parse(tokenResponse.body); assert.match(token.access_token, /^wpd\./);
  assert.equal(JSON.parse(tokenResponse.body).user.union_id, person.unionId);
  const key = await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token.access_token}` } });
  assert.equal(key.statusCode, 200); assert.strictEqual(key.handleResult, true); const value = JSON.parse(key.body); assert.equal(value.key, 'fixture-desktop-key'); assert.equal(value.base_url, 'https://models.example.test');
  assert.ok(!fs.readFileSync(path.join(f.directory, 'desktop-auth/audit.log'), 'utf8').includes(value.key));
  const emptyFingerprint = await f.request('/_wp/api/desktop/key?fp=', { headers: { authorization: `Bearer ${token.access_token}` } });
  assert.equal(emptyFingerprint.statusCode, 200); assert.strictEqual(emptyFingerprint.handleResult, true); assert.equal(JSON.parse(emptyFingerprint.body).key, 'fixture-desktop-key');
  const omittedFingerprint = await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token.access_token}` } });
  assert.equal(omittedFingerprint.statusCode, 200); assert.strictEqual(omittedFingerprint.handleResult, true); assert.equal(JSON.parse(omittedFingerprint.body).key, 'fixture-desktop-key');
  const invalidFingerprint = await f.request('/_wp/api/desktop/key?fp=xyz', { headers: { authorization: `Bearer ${token.access_token}` } });
  assert.equal(invalidFingerprint.statusCode, 400); assert.deepEqual(JSON.parse(invalidFingerprint.body), { error: 'invalid_fingerprint' }); assert.strictEqual(invalidFingerprint.handleResult, true);
  const same = await f.request('/_wp/api/desktop/key?fp=' + value.fingerprint, { headers: { authorization: `Bearer ${token.access_token}` } }); assert.equal(same.statusCode, 204); assert.equal(same.body, '');
  assert.strictEqual(same.handleResult, true);
  const replay = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) }); assert.equal(replay.statusCode, 400); assert.deepEqual(JSON.parse(replay.body), { error: 'invalid_grant' }); assert.strictEqual(replay.handleResult, true);
});

test('authorize validates loopback redirect and PKCE parameters', async t => {
  const f = fixture(t); const base = new URL('/_wp/desktop/authorize', 'https://workspace.example.test');
  const challenge = 'A'.repeat(43); const bad = ['https://127.0.0.1:12345/cb', 'http://localhost:12345/cb', 'http://10.0.0.1:12345/cb', 'http://127.0.0.1:12345/', 'http://127.0.0.1:12345/cb?x=1', 'http://127.0.0.1:999/cb', 'http://127.0.0.1:65536/cb'];
  base.search = new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's' }); const login = await f.request(base.pathname + base.search); assert.equal(login.statusCode, 302); assert.strictEqual(login.handleResult, true);
  for (const value of bad) { base.search = new URLSearchParams({ redirect_uri: value, code_challenge: challenge, code_challenge_method: 'S256', state: 's' }); const response = await f.request(base.pathname + base.search); assert.equal(response.statusCode, 400); assert.strictEqual(response.handleResult, true); }
  base.search = new URLSearchParams({ redirect_uri: redirect, code_challenge: 'short', code_challenge_method: 'S256', state: 's' }); { const response = await f.request(base.pathname + base.search); assert.equal(response.statusCode, 400); assert.strictEqual(response.handleResult, true); }
  base.search = new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'plain', state: 's' }); { const response = await f.request(base.pathname + base.search); assert.equal(response.statusCode, 400); assert.strictEqual(response.handleResult, true); }
  base.search = new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: ' ' }); { const response = await f.request(base.pathname + base.search); assert.equal(response.statusCode, 400); assert.strictEqual(response.handleResult, true); }
});

test('refresh, generation revocation, live admission and bearer separation', async t => {
  const f = fixture(t); const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) }); const token = JSON.parse(issued.body).access_token;
  const refresh = await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } }); assert.equal(refresh.statusCode, 200); assert.strictEqual(refresh.handleResult, true);
  const invalidKey = await f.request('/_wp/api/desktop/key', { headers: { authorization: 'Bearer zpd.fake.token' } }); assert.equal(invalidKey.statusCode, 401); assert.strictEqual(invalidKey.handleResult, true);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: 'Bearer ' + token.slice(0, -1) + 'x' } })).statusCode, 401);
  const revoked = await f.request('/_wp/api/desktop/revoke-all', { method: 'POST', headers: { authorization: `Bearer ${token}` } }); assert.equal(revoked.statusCode, 200); assert.strictEqual(revoked.handleResult, true);
  const revokedRefresh = await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } }); assert.equal(revokedRefresh.statusCode, 401); assert.strictEqual(revokedRefresh.handleResult, true);
  f.config.desktop.allow = []; const deniedAuthorize = await f.request('/_wp/desktop/authorize?redirect_uri=' + encodeURIComponent(redirect) + '&code_challenge=' + 'A'.repeat(43) + '&code_challenge_method=S256&state=s', { headers: { cookie: 'wp_sid=ok' } }); assert.equal(deniedAuthorize.statusCode, 403); assert.strictEqual(deniedAuthorize.handleResult, true);
});

test('web revoke requires same origin and rate limiting is per person', async t => {
  const f = fixture(t); f.config.desktop.keyRateLimitPerMinute = 1; const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) }); const token = JSON.parse(issued.body).access_token;
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
  const limited = await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } }); assert.equal(limited.statusCode, 429); assert.equal(limited.headers['retry-after'], '60');
  assert.equal((await f.request('/_wp/api/desktop/revoke-all', { method: 'POST', headers: { cookie: 'wp_sid=ok', origin: 'https://other.example.test' } })).statusCode, 403);
  assert.equal((await f.request('/_wp/api/desktop/revoke-all', { method: 'POST', headers: { cookie: 'wp_sid=ok', origin: 'https://workspace.example.test' } })).statusCode, 200);
});

test('failed verifier and redirect consume code, expiry and live policy deny access', async t => {
  const f = fixture(t); const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: 'wrong', redirect_uri: redirect }) })).statusCode, 400);
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) })).statusCode, 400);
  const expired = f.authorize(); const expiredAuth = await expired.request; const expiredCode = new URL(expiredAuth.headers.location).searchParams.get('code'); f.setClock(Date.parse('2026-11-25T00:01:01Z'));
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: expiredCode, code_verifier: expired.verifier, redirect_uri: redirect }) })).statusCode, 400);
  f.setClock(Date.parse('2026-11-25T00:00:00Z')); const valid = f.authorize(); const validAuth = await valid.request; const validCode = new URL(validAuth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: validCode, code_verifier: valid.verifier, redirect_uri: redirect }) }); const token = JSON.parse(issued.body).access_token;
  f.config.desktop.enabled = false; assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  f.config.desktop.enabled = true; f.config.desktop.allow = ['other']; assert.equal((await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  f.config.desktop.allow = ['tang']; fs.rmSync(f.keyFile); assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } })).statusCode, 404);
});

test('redirect URI is checked as the supplied string', async t => {
  const f = fixture(t); const challenge = 'A'.repeat(43);
  const values = [
    'http://127.0.0.1:12345/x/../cb', 'http://127.1:12345/cb', 'http://127.0.0.1:012345/cb',
    'http://127.0.0.1:12345/cb?x=1', 'http://127.0.0.1:12345/cb#f', 'http://127.0.0.1:12345/CB',
    'http://a@127.0.0.1:12345/cb', 'http://127.0.0.1:12345/%63b',
  ];
  for (const value of values) {
    const route = '/_wp/desktop/authorize?' + new URLSearchParams({ redirect_uri: value, code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    assert.equal((await f.request(route, { headers: { cookie: 'wp_sid=ok' } })).statusCode, 400, value);
  }
  const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: 'http://127.0.0.1:12345/%63b' }) })).statusCode, 400);
});

test('expired bearer token and cookie or zpd values are rejected', async t => {
  const f = fixture(t); const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) });
  const token = JSON.parse(issued.body).access_token;
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { cookie: 'wp_sid=ok' } })).statusCode, 401);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: 'Bearer ok' } })).statusCode, 401);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: 'Bearer zpd.fake.token' } })).statusCode, 401);
  f.setClock(Date.parse('2026-12-26T00:00:01Z'));
  assert.equal((await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
});

test('issued desktop token is rejected after its user leaves users.json', async t => {
  const f = fixture(t); const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) });
  const token = JSON.parse(issued.body).access_token;
  f.users.splice(0, 1);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
});

test('desktop admission is independent of model key access', async t => {
  const revoked = [];
  const f = fixture(t, { onRevoke: id => revoked.push(id) });
  f.organization.features.myKey = false;
  const flow = f.authorize();
  const auth = await flow.request;
  assert.equal(auth.statusCode, 302);
  const code = new URL(auth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST',
    body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) });
  assert.equal(issued.statusCode, 200);
  const token = JSON.parse(issued.body).access_token;
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(f.handle.authenticate({ headers }).user.unionId, person.unionId);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers })).statusCode, 403);
  assert.equal((await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers })).statusCode, 200);
  assert.equal((await f.request('/_wp/api/desktop/revoke-all', { method: 'POST', headers })).statusCode, 200);
  assert.deepEqual(revoked, [person.unionId]);
  assert.equal(f.handle.verify(token), null);
});

test('disabling desktop rejects pending codes and previously issued tokens', async t => {
  const f = fixture(t);
  const valid = f.authorize(); const auth = await valid.request; const code = new URL(auth.headers.location).searchParams.get('code');
  const tokenResponse = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: valid.verifier, redirect_uri: redirect }) });
  const token = JSON.parse(tokenResponse.body).access_token;
  const disabled = f.authorize(); const disabledAuth = await disabled.request; f.config.desktop.enabled = false;
  assert.equal((await f.request('/_wp/desktop/authorize?' + new URLSearchParams({ redirect_uri: redirect, code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', state: 's' }), { headers: { cookie: 'wp_sid=ok' } })).statusCode, 403);
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: new URL(disabledAuth.headers.location).searchParams.get('code'), code_verifier: disabled.verifier, redirect_uri: redirect }) })).statusCode, 400);
  assert.equal((await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
});

test('authorization codes expire and are bounded per user', async t => {
  const f = fixture(t); const flows = Array.from({ length: 6 }, () => f.authorize());
  const responses = await Promise.all(flows.map(flow => flow.request));
  const codes = responses.map(response => new URL(response.headers.location).searchParams.get('code'));
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: codes[0], code_verifier: flows[0].verifier, redirect_uri: redirect }) })).statusCode, 400);
  f.setClock(Date.parse('2026-11-25T00:02:00Z')); const next = f.authorize(); const nextResponse = await next.request;
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: codes[1], code_verifier: flows[1].verifier, redirect_uri: redirect }) })).statusCode, 400);
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: new URL(nextResponse.headers.location).searchParams.get('code'), code_verifier: next.verifier, redirect_uri: redirect }) })).statusCode, 200);
});

test('authorization code table has a global bound', async t => {
  const users = Array.from({ length: 10001 }, (_, index) => ({ slug: `u${index}`, unionId: `union-${index}`, name: `U${index}` }));
  const f = fixture(t, { users, sessionFor: req => users.find(user => req.headers.cookie === `wp_sid=${user.slug}`) || null });
  f.config.desktop.allow = ['*'];
  const attempts = users.map(user => f.authorize(user.slug));
  const flows = await Promise.all(attempts.map(attempt => attempt.request));
  const first = flows[0];
  assert.equal((await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code: new URL(first.headers.location).searchParams.get('code'), code_verifier: attempts[0].verifier, redirect_uri: redirect }) })).statusCode, 400);
});

test('generation read failures fail closed and revoke does not rewrite state', async t => {
  const f = fixture(t); const flow = f.authorize(); const auth = await flow.request; const code = new URL(auth.headers.location).searchParams.get('code');
  const issued = await f.request('/_wp/api/desktop/token', { method: 'POST', body: JSON.stringify({ code, code_verifier: flow.verifier, redirect_uri: redirect }) }); const token = JSON.parse(issued.body).access_token;
  const file = path.join(f.directory, 'desktop-auth/generations.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
  assert.equal((await f.request('/_wp/api/desktop/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  assert.equal((await f.request('/_wp/api/desktop/key', { headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  const before = fs.readFileSync(file); assert.equal((await f.request('/_wp/api/desktop/revoke-all', { method: 'POST', headers: { cookie: 'wp_sid=ok', origin: 'https://workspace.example.test' } })).statusCode, 500);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('concurrent revocations preserve every user generation bump', async t => {
  const users = Array.from({ length: 20 }, (_, index) => ({ slug: `user-${index}`, unionId: `union-${index}`, name: `User ${index}` }));
  const f = fixture(t, { users, sessionFor: req => users.find(user => req.headers.cookie === `wp_sid=${user.slug}`) || null });
  f.config.desktop.allow = ['*'];
  const responses = await Promise.all(users.map(user => f.request('/_wp/api/desktop/revoke-all', {
    method: 'POST', headers: { cookie: `wp_sid=${user.slug}`, origin: 'https://workspace.example.test' },
  })));
  assert.deepEqual(responses.map(response => response.statusCode), Array(20).fill(200));
  const generations = JSON.parse(fs.readFileSync(path.join(f.directory, 'desktop-auth/generations.json'), 'utf8'));
  for (const user of users) assert.equal(generations[user.unionId], 1, user.unionId);
});

test('legacy desktop and feishu desktop paths are left to their original handlers', async t => {
  const f = fixture(t);
  assert.equal(f.handle.isDesktopRoute(new URL('/_wp/desktop-login', 'https://workspace.example.test')), false);
  assert.equal(f.handle.isDesktopRoute(new URL('/_wp/feishu/desktop-start', 'https://workspace.example.test')), false);
  const legacy = await f.request('/_wp/desktop-login'); assert.equal(legacy.statusCode, undefined); assert.strictEqual(legacy.handleResult, false);
  const feishu = await f.request('/_wp/feishu/desktop-start'); assert.equal(feishu.statusCode, undefined); assert.strictEqual(feishu.handleResult, false);
});

