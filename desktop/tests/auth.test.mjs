import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DesktopAuth, hash } from '../dist/main/auth.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-login-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'token');
  const key = randomBytes(32);
  const vault = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(16), cipher = createCipheriv('aes-256-ctr', key, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final()]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-ctr', key, value.subarray(0, 16));
      return Buffer.concat([decipher.update(value.subarray(16)), decipher.final()]).toString();
    }
  };
  const state = { cookie: 'session-one', me: 'first-user', tokenUser: 'first-user', warnings: [], calls: [], message: '', denied: false, wrongState: false, revoked: false };
  let query;
  const io = {
    cookie: async () => state.cookie,
    async authorize(url) {
      query = new URL(url).searchParams;
      const cb = new URL(query.get('redirect_uri'));
      cb.searchParams.set('state', state.wrongState ? 'other' : query.get('state'));
      cb.searchParams.set('code', 'once');
      return { status: state.denied ? 403 : 302, location: cb.href };
    },
    async fetch(url, options) {
      state.calls.push(new URL(url).pathname);
      if (url.endsWith('/me')) {
        assert.equal(options.credentials, 'include');
        return state.me ? Response.json({ union_id: state.me }) : new Response(null, { status: 401 });
      }
      if (url.endsWith('/refresh')) {
        assert.equal(options.headers.Authorization, 'Bearer wpd.test');
        if (state.revoked) return new Response(null, { status: 401 });
      } else {
        const body = JSON.parse(options.body);
        assert.equal(body.code, 'once');
        assert.equal(body.redirect_uri, query.get('redirect_uri'));
        assert.equal(hash(body.code_verifier), query.get('code_challenge'));
      }
      return Response.json({ access_token: 'wpd.test', user: { union_id: state.tokenUser }, expires_at: new Date(Date.now() + 30 * 86400000).toISOString() });
    }
  };
  const client = () => new DesktopAuth('https://desk.example.org', file, vault, io, text => { state.message = text; }, text => state.warnings.push(text));
  return { file, io, state, vault, client };
}
test('同一会话并发检查只换证一次，重启验证凭据，撤销后不会立即重新签发', async t => {
  const { file, state, client } = fixture(t), auth = client();
  await Promise.all([auth.sync(), auth.sync()]);
  assert.deepEqual(state.calls, ['/_wp/me', '/_wp/api/desktop/token', '/_wp/me', '/_wp/me']);
  assert.equal(readFileSync(file).includes('wpd.test'), false);
  assert.match(state.message, /已获取/);
  const next = client(); state.revoked = true;
  await next.sync(); await next.sync(); await client().sync();
  assert.deepEqual(state.calls.slice(4), ['/_wp/me', '/_wp/api/desktop/refresh', '/_wp/me', '/_wp/me']);
  assert.equal(existsSync(file), false);
  assert.match(state.message, /已失效/);
});
test('用户切换后不使用旧桌面令牌，登出后移除密文', async t => {
  const { file, state, client } = fixture(t), auth = client();
  await auth.sync(); state.cookie = 'another-session';
  state.denied = true;
  await auth.sync();
  assert.match(state.message, /未开通/);
  assert.equal(existsSync(file), false);
  state.denied = false; await auth.sync(); state.cookie = undefined; await auth.sync();
  assert.equal(existsSync(file), false);
});
test('错误的回调 state 或安全存储不可用时不换取凭据', async t => {
  const { file, state, vault, client } = fixture(t), auth = client();
  state.wrongState = true; await auth.sync();
  assert.equal(existsSync(file), false);
  vault.isEncryptionAvailable = () => false; await auth.sync();
  assert.deepEqual(state.calls, ['/_wp/me']);
});
test('退出登录使进行中的换证操作失效', async t => {
  const { file, io, client } = fixture(t), auth = client();
  const authorize = io.authorize;
  io.authorize = async url => { auth.clear(); return authorize(url); };
  await auth.sync();
  assert.equal(existsSync(file), false);
});

test('换证和刷新只保存当前会话用户的令牌', async t => {
  const { file, state, client, vault } = fixture(t);
  state.tokenUser = 'other';
  await client().sync();
  assert.equal(existsSync(file), false);
  assert.match(state.message, /身份/);
  assert.match(state.warnings.at(-1), /身份/);
  state.tokenUser = state.me;
  await client().sync();
  assert.equal(JSON.parse(vault.decryptString(readFileSync(file))).union_id, state.me);
  state.tokenUser = 'other';
  await client().sync();
  assert.equal(existsSync(file), false);
});
test('Cookie 未变时也会清除切号或失去会话的旧凭据', async t => {
  const { file, state, client } = fixture(t);
  const auth = client();
  await auth.sync();
  state.me = 'second-user';
  state.denied = true;
  await auth.sync();
  assert.equal(existsSync(file), false);
  assert.equal(state.calls.includes('/_wp/api/desktop/refresh'), false);
  state.denied = false;
  state.tokenUser = state.me;
  await auth.sync();
  assert.ok(existsSync(file));
  state.me = null;
  await auth.sync();
  assert.equal(existsSync(file), false);
});

test('both logout actions reach the gateway logout page when cookie cleanup fails', async () => {
  const { logoutDesktop } = await import('../dist/main/logout.js');
  const origin = 'https://example.org', preview = 'preview.example.org';
  for (const all of [false, true]) {
    for (const failingOrigin of [origin, 'https://' + preview]) {
      const calls = [];
      await logoutDesktop(all, {
        revokeAll: async () => { calls.push('revoke'); },
        clear: () => calls.push('clear')
      }, () => calls.push('close'), async url => {
        calls.push(url);
        if (url === failingOrigin) throw new Error();
      }, origin, preview, url => calls.push(url), assert.fail);
      assert.deepEqual(calls, [...(all ? ['revoke'] : []), 'clear', 'close', origin, 'https://' + preview, origin + '/_wp/logout']);
    }
  }
});

test('revocation survives a marker write failure for the lifetime of the active login', async t => {
  const { mkdirSync } = await import('node:fs');
  const { file, state, client } = fixture(t);
  const auth = client();
  await auth.sync();
  mkdirSync(file + '.revoked');
  auth.markRevoked();
  assert.equal(auth.token(), undefined);
  assert.equal(existsSync(file), false);
  const count = state.calls.length;
  await auth.sync();
  assert.deepEqual(state.calls.slice(count), ['/_wp/me']);
  assert.equal(auth.token(), undefined);
  assert.match(state.message, /失效.*保存失败/);
});
