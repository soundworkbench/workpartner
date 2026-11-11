import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { marketNotifications } from '../market-notifications.mjs';
import { createSharedSkillStore, createSharedSkillsHandler, inspectSkill } from '../market-shared.mjs';
const alice = { slug: 'alice', unionId: 'author-a', name: '作者甲', backend: 'aionui' };
const bob = { slug: 'bob', unionId: 'reader-b', name: '读者乙', backend: 'aionui' };
const it = { slug: 'it', unionId: 'reviewer-c', name: 'IT', backend: 'aionui' };
const meta = { displayName: '会议整理', description: '整理会议里的行动项', example: '请整理这次会议的行动项' };
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-market-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'builtin')); fs.mkdirSync(path.join(root, 'uploads'));
  fs.writeFileSync(path.join(root, 'translations.json'), '{}');
  const options = { stateDir: path.join(root, 'state'), sharedDir: path.join(root, 'shared'), approvers: [it.unionId], protectedNames: ['share-skill'], ...extra };
  const store = createSharedSkillStore(options);
  const execute = async (user, action, data = {}) => {
    const result = spawnSync('python3', [new URL('./market-worker.py', import.meta.url).pathname, root, user.slug, action, JSON.stringify(data)], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  async function local(user = alice, description = '整理会议方法', attachment) {
    const source = path.join(root, 'uploads', 'SKILL.md');
    fs.writeFileSync(source, `---\nname: meeting-notes\ndescription: ${description}\n---\n\n${description}\n`);
    const installed = await execute(user, 'install', { source, overwrite: true }); assert.ok(!installed.error, JSON.stringify(installed));
    if (attachment) { fs.mkdirSync(path.join(root, user.slug, '.claude/skills/meeting-notes/scripts')); fs.writeFileSync(path.join(root, user.slug, '.claude/skills/meeting-notes/scripts/check.py'), attachment); }
    return execute(user, 'export', { name: 'meeting-notes' });
  }
  return { root, store, execute, local, options };
}

test('real worker lifecycle: private draft, review, both engine paths, approved update, withdrawal and idempotent installs', async t => {
  const f = fixture(t);
  const first = await f.store.submit(alice, await f.local(), meta);
  assert.equal(first.status, 'pending'); assert.equal(f.store.list(bob).company.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'shared/live/meeting-notes')), false);
  await assert.rejects(f.store.review(bob, first.name, first.version, 'approve'), /审批人/);
  const duplicate = await f.store.submit(alice, await f.execute(alice, 'export', { name: first.name }), meta);
  assert.equal(duplicate.version, first.version);
  await f.store.review(it, first.name, first.version, 'approve');
  await Promise.all([f.store.install(bob, first.name, f.execute), f.store.install(bob, first.name, f.execute)]);
  assert.equal(f.store.list(bob).company[0].installs, 1);
  const files = ['.claude/skills', '.codex/skills'].map(directory => path.join(f.root, 'bob', directory, first.name, 'SKILL.md'));
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /整理会议方法/);
  assert.equal((await f.execute(bob, 'list')).skills[0].shared, true);
  const next = await f.store.submit(alice, await f.local(alice, '新版方法'), { ...meta, description: '新版' });
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /整理会议方法/);
  await f.store.review(it, next.name, next.version, 'approve');
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /新版方法/);
  await assert.rejects(f.store.withdraw(bob, first.name), /作者或审批人/);
  await f.store.uninstall(bob, first.name, f.execute);
  assert.equal(f.store.list(bob).company[0].installs, 0);
  await f.store.install(bob, first.name, f.execute);
  assert.equal(f.store.list(bob).company[0].installs, 1);
  await f.store.withdraw(alice, first.name);
  for (const file of files) assert.equal(fs.existsSync(file), false);
  const withdrawn = (await f.execute(bob, 'list')).skills[0];
  assert.equal(withdrawn.name, first.name);
  assert.equal(withdrawn.shared, true);
  assert.equal(withdrawn.withdrawn, true);
  await assert.rejects(f.store.review(it, first.name, first.version, 'approve'), error => error.status === 409 && /已下架/.test(error.message));
  await f.store.uninstall(bob, first.name, f.execute);
  assert.equal((await f.execute(bob, 'list')).skills.length, 0);
  await f.local(bob);
  assert.equal((await f.execute(bob, 'list')).skills[0].shared, false);
  assert.equal(fs.lstatSync(path.join(f.root, 'bob/.claude/skills')).isDirectory(), true);
  assert.equal(f.store.list(bob).company.length, 0);
});

test('each version is approved separately; rejection reasons, ownership and notification failures survive restart', async t => {
  let f, notices = 0;
  f = fixture(t, { notifyAuthor: async row => {
    notices++;
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'state/catalog.json')));
    assert.equal(saved.skills[row.name].versions[row.version].status, row.status);
    throw new Error('Notification transport failed');
  } });
  const bundle = await f.local();
  const first = await f.store.submit(alice, bundle, meta);
  await assert.rejects(f.store.submit(bob, bundle, meta), /其他作者/);
  await assert.rejects(f.store.review(it, first.name, first.version, 'reject'), /原因/);
  const rejected = await f.store.review(it, first.name, first.version, 'reject', '请补充适用范围');
  assert.equal(rejected.authorNotice, 'failed'); assert.equal(notices, 1);
  const restarted = createSharedSkillStore(f.options);
  assert.equal(restarted.list(alice).mine[0].reason, '请补充适用范围');
  assert.equal(restarted.list(it).reviewed[0].authorNotice, 'failed');
  await assert.rejects(restarted.review(it, first.name, first.version, 'approve'), error => error.status === 409 && /未通过/.test(error.message));
  assert.equal(restarted.list(bob).company.length, 0);
});

test('failed cards can be resent; scripts and private-path warnings reach reviewers and all files can be inspected', async t => {
  let send = 0;
  const f = fixture(t, { notify: async row => { send++; assert.equal(row.scripts, 1); if (send === 1) throw new Error('offline'); } });
  const first = await f.store.submit(alice, await f.local(alice, '在 /home/example 中处理', 'print("local")'), meta);
  assert.equal(first.reviewNotice, 'failed'); assert.equal(first.warnings.length, 1);
  assert.match(f.store.source(it, first.name, first.version), /scripts\/check.py/);
  assert.throws(() => f.store.source(bob, first.name, first.version), /审批人/);
  const resent = await f.store.review(it, first.name, first.version, 'resend');
  assert.equal(resent.reviewNotice, 'sent'); assert.equal(send, 2);
});

test('closed submissions, protected names, secrets, personal details and unsafe exports are blocked before publication', async t => {
  const f = fixture(t), bundle = await f.local();
  await assert.rejects(f.store.submit(alice, bundle, { ...meta, description: 'sk-' + 'x'.repeat(25) }), /疑似/);
  const closed = createSharedSkillStore({ ...f.options, approvers: [] });
  await assert.rejects(closed.submit(alice, bundle, meta), /尚未开放/);
  for (const bad of ['sk-' + 'x'.repeat(25), 'ghp_' + 'a'.repeat(36), 'Bearer ' + 'a'.repeat(24), 'password: secret-value', '138' + '12345678', '123456' + '200001011234']) {
    assert.throws(() => inspectSkill({ ...bundle, files: [{ path: 'SKILL.md', content: Buffer.from(bad).toString('base64') }] }), /疑似/);
  }
  for (const invalid of ['../bad', '/absolute', 'a\\b', 'a//b', 'a/./b', 'a:b']) {
    assert.throws(() => inspectSkill({ ...bundle, files: [{ path: invalid, content: '' }] }), /文件路径/);
  }
  assert.throws(() => inspectSkill(bundle, [bundle.name]), /预装/);
  assert.throws(() => inspectSkill(bundle, [], ['Official'], 'Official example'), /官方/);
  assert.equal(fs.existsSync(path.join(f.root, 'state/catalog.json')), false);
});

test('HTTP: cookie CSRF and signed container identity use one submission and approval service', async t => {
  const f = fixture(t); await f.local();
  const handler = createSharedSkillsHandler({ store: f.store, execute: f.execute, origin: 'https://partner.example',
    authenticate: req => req.headers.cookie === 'alice' ? alice : req.headers.cookie === 'it' ? it : null,
    tokenAuthenticate: req => req.headers.authorization === 'Bearer test-identity' ? alice : null });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://local'))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function request(headers, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/_wp/market/shared`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const submit = { ...meta, action: 'submit', name: 'meeting-notes' };
  assert.equal((await request({}, submit)).status, 401);
  assert.equal((await request({ cookie: 'alice', 'content-type': 'application/json', origin: 'https://foreign.example' }, submit)).status, 403);
  const added = await request({ authorization: 'Bearer test-identity', 'content-type': 'application/json' }, submit);
  assert.equal(added.status, 200); assert.equal(added.body.status, 'pending');
  assert.equal((await request({ cookie: 'alice', origin: 'https://partner.example', 'content-type': 'application/json' }, { action: 'approve', name: 'meeting-notes', version: added.body.version })).status, 403);
  const reviewed = await request({ cookie: 'it', origin: 'https://partner.example', 'content-type': 'application/json' }, { action: 'approve', name: 'meeting-notes', version: added.body.version });
  assert.equal(reviewed.status, 200); assert.equal(reviewed.body.status, 'approved');
  assert.equal((await request({ cookie: 'alice' })).body.company.length, 1);
  const reviewHeaders = { cookie: 'it', origin: 'https://partner.example', 'content-type': 'application/json' };
  const approval = { action: 'approve', name: 'meeting-notes', version: added.body.version };
  const repeated = await request(reviewHeaders, approval);
  assert.equal(repeated.status, 409); assert.match(repeated.body.message, /已通过/);
  await f.store.withdraw(alice, 'meeting-notes');
  const stale = await request(reviewHeaders, approval);
  assert.equal(stale.status, 409); assert.match(stale.body.message, /已下架/);
  assert.equal(f.store.list(bob).company.length, 0);
});


test('bot cards address configured reviewers and result notices address only the author', async t => {
  const f = fixture(t), sent = [];
  const secret = path.join(f.root, 'app-secret'); fs.writeFileSync(secret, 'fixture-only');
  const notifier = marketNotifications({ identity: { appId: 'fixture-app', appSecretFile: secret }, server: { publicOrigin: 'https://partner.example' } }, async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes('/auth/')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'fixture-token' }) };
    sent.push(body); return { ok: true, json: async () => ({ code: 0 }) };
  });
  const notice = { name: 'meeting-notes', version: 'version-1', displayName: meta.displayName, description: meta.description, example: meta.example, author: '作者甲', scripts: 2, warnings: ['请检查内部地址'] };
  await notifier.notify({ ...notice, approvers: [it.unionId] });
  const card = JSON.parse(sent[0].content);
  assert.equal(sent[0].receive_id, it.unionId);
  assert.deepEqual(card.elements.at(-1).actions.map(action => action.text.content), ['批准', '拒绝']);
  assert.ok(card.elements.at(-1).actions.every(action => action.url.startsWith('https://partner.example/')));
  await notifier.notifyAuthor({ ...notice, unionId: alice.unionId, status: 'rejected', reason: '需要更清楚的说明' });
  assert.equal(sent[1].receive_id, alice.unionId); assert.match(JSON.parse(sent[1].content).text, /需要更清楚的说明/);
});


test('approved releases are readable by workspace users even under a restrictive gateway umask', async t => {
  const previous = process.umask(0o077);
  try {
    const f = fixture(t);
    const version = await f.store.submit(alice, await f.local(), meta);
    await f.store.review(it, version.name, version.version, 'approve');
    const release = path.join(f.root, 'shared/releases', version.name, version.version);
    for (const directory of [path.join(f.root, 'shared'), path.join(f.root, 'shared/live'), path.dirname(release), release]) assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(release, 'SKILL.md')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(f.root, 'state')).mode & 0o777, 0o700);
  } finally { process.umask(previous); }
});


test('startup restores missing approved releases from submissions and remains repeatable', async t => {
  const f = fixture(t);
  const bundle = await f.local(alice, '恢复技能', '#!/usr/bin/python3\nprint(1)');
  bundle.files.find(file => file.path === 'scripts/check.py').executable = true;
  const version = await f.store.submit(alice, bundle, meta);
  await f.store.review(it, version.name, version.version, 'approve');
  await f.store.install(bob, version.name, f.execute);
  fs.rmSync(path.join(f.root, 'shared/releases'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const restarted = createSharedSkillStore(f.options);
    assert.equal(restarted.list(bob).company[0].version, version.version);
    for (const engine of ['.claude', '.codex']) {
      const file = path.join(f.root, 'bob', engine, 'skills', version.name, 'SKILL.md');
      assert.match(fs.readFileSync(file, 'utf8'), /恢复技能/);
    }
    const release = path.join(f.root, 'shared/releases', version.name, version.version);
    assert.equal(fs.statSync(release).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(release, 'SKILL.md')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(release, 'scripts/check.py')).mode & 0o777, 0o755);
  }
});

test('startup logs and skips an unrecoverable skill while keeping other releases available', async t => {
  const f = fixture(t);
  const bundle = await f.local();
  const missing = await f.store.submit(alice, bundle, meta);
  await f.store.review(it, missing.name, missing.version, 'approve');
  const healthy = await f.store.submit(alice, { ...bundle, name: 'healthy-skill' }, meta);
  await f.store.review(it, healthy.name, healthy.version, 'approve');
  fs.rmSync(path.join(f.root, 'shared/releases', missing.name), { recursive: true });
  fs.rmSync(path.join(f.root, 'state/submissions', missing.name), { recursive: true });
  const logs = []; t.mock.method(console, 'warn', line => logs.push(line));
  const restarted = createSharedSkillStore(f.options);
  assert.deepEqual(restarted.list(bob).company.map(row => row.name), [healthy.name]);
  assert.equal(restarted.list(alice).mine.find(row => row.name === missing.name).status, 'approved');
  assert.equal(logs.length, 1); assert.match(logs[0], /meeting-notes/); assert.match(logs[0], /ENOENT/);
  await restarted.install(bob, healthy.name, f.execute);
  assert.ok(fs.existsSync(path.join(f.root, 'bob/.codex/skills/healthy-skill/SKILL.md')));
});
