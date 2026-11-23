import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { marketNotifications } from '../market-notifications.mjs';
import { createSharedSkillStore, createSharedSkillsHandler, inspectSkill } from '../market-shared.mjs';
const alice = { slug: 'alice', unionId: 'author-a', name: '作者甲', backend: 'aionui' };
const bob = { slug: 'bob', unionId: 'reader-b', name: '读者乙', backend: 'aionui' };
const it = { slug: 'it', unionId: 'reviewer-c', name: 'IT', backend: 'aionui' };
const meta = { displayName: '会议整理', description: '整理会议里的行动项', example: '请整理这次会议的行动项' };
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-market-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'builtin')); fs.mkdirSync(path.join(root, 'uploads'));
  fs.writeFileSync(path.join(root, 'translations.json'), '{}');
  const options = { stateDir: path.join(root, 'state'), sharedDir: path.join(root, 'shared'), approvers: [it.unionId], protectedNames: ['share-skill'],
    autoPublish: true, modelReview: async () => ({ verdict: 'pass', reasons: [] }), ...extra };
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
  const installs = await Promise.all([f.store.install(bob, first.name, f.execute), f.store.install(bob, first.name, f.execute)]);
  assert.deepEqual(installs.map(result => ({ installed: result.installed, changed: result.changed })), [{ installed: true, changed: true }, { installed: true, changed: false }]);
  assert.equal(f.store.list(bob).company[0].installs, 1);
  const files = ['.claude/skills', '.codex/skills'].map(directory => path.join(f.root, 'bob', directory, first.name, 'SKILL.md'));
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /整理会议方法/);
  assert.equal((await f.execute(bob, 'list')).skills[0].shared, true);
  const next = await f.store.submit(alice, await f.local(alice, '新版方法'), { ...meta, description: '新版' });
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /整理会议方法/);
  await f.store.review(it, next.name, next.version, 'approve');
  for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /新版方法/);
  await assert.rejects(f.store.withdraw(bob, first.name), /作者或审批人/);
  assert.equal((await f.store.uninstall(bob, first.name, f.execute)).installed, false);
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

test('slow container work and notifications do not hold the catalog queue', async t => {
  const carol = { slug: 'carol', name: '读者丙', backend: 'aionui' };
  const f = fixture(t);
  const first = await f.store.submit(alice, await f.local(), meta);
  await f.store.review(it, first.name, first.version, 'approve');
  const slow = async () => { await new Promise(resolve => setTimeout(resolve, 2000)); return { changed: true }; };
  const waiting = f.store.install(bob, first.name, slow);
  await new Promise(resolve => setImmediate(resolve));
  const started = Date.now();
  const listed = f.store.list(carol);
  const submitted = await f.store.submit(carol, { ...await f.local(alice), name: 'queue-check' }, { ...meta, displayName: '队列检查' });
  assert.ok(listed && submitted.status === 'pending');
  assert.ok(Date.now() - started < 500, `catalog operation waited ${Date.now() - started}ms`);
  await waiting;

  let notifyStarted;
  const notified = fixture(t, { notifyAuthor: async () => {
    notifyStarted = Date.now(); await new Promise(resolve => setTimeout(resolve, 2000));
  } });
  const notifyBundle = await notified.local();
  const draft = await notified.store.submit(alice, notifyBundle, meta);
  const review = notified.store.review(it, draft.name, draft.version, 'approve');
  await new Promise(resolve => setImmediate(resolve));
  const duringNotify = Date.now(); notified.store.list(bob);
  await notified.store.submit(bob, { ...notifyBundle, name: 'notify-queue-check' }, { ...meta, displayName: '通知队列检查' });
  assert.ok(Date.now() - duringNotify < 500);
  await review;
  assert.ok(notifyStarted);
});

test('an install that races withdrawal returns 404 and other users are not blocked by slow execution', async t => {
  const carol = { slug: 'carol', unionId: 'reader-d', name: '读者丙', backend: 'aionui' };
  const f = fixture(t);
  const first = await f.store.submit(alice, await f.local(), meta);
  await f.store.review(it, first.name, first.version, 'approve');
  let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const raced = f.store.install(bob, first.name, async () => {
    begin(); await waiting; return { error: 'not_found', message: '这个技能已经下架，请刷新市场。' };
  });
  await started;
  await f.store.withdraw(alice, first.name);
  finish();
  await assert.rejects(raced, error => error.status === 404 && error.message === '这个技能已经下架。');

  const second = await f.store.submit(alice, { ...await f.local(), name: 'slow-install' }, { ...meta, displayName: '慢安装' });
  await f.store.review(it, second.name, second.version, 'approve');
  let slowBegin, slowFinish;
  const slowStarted = new Promise(resolve => { slowBegin = resolve; });
  const slowWaiting = new Promise(resolve => { slowFinish = resolve; });
  const slow = f.store.install(bob, second.name, async () => { slowBegin(); await slowWaiting; return { changed: true }; });
  await slowStarted;
  const startedAt = Date.now();
  await f.store.install(carol, second.name, async () => ({ changed: true }));
  assert.ok(Date.now() - startedAt < 500, 'another user install waited for slow execution');
  slowFinish(); await slow;
});

test('an execute failure clears the user queue and uninstall keeps installed counts accurate', async t => {
  const f = fixture(t);
  const first = await f.store.submit(alice, await f.local(), meta);
  await f.store.review(it, first.name, first.version, 'approve');
  await assert.rejects(f.store.install(bob, first.name, async () => { throw new Error('worker failed'); }), /worker failed/);
  const installed = await f.store.install(bob, first.name, async () => ({ changed: true }));
  assert.equal(installed.installed, true); assert.equal(f.store.list(bob).company[0].installs, 1);
  const noOp = await f.store.uninstall(bob, first.name, async () => ({ shared: false }));
  assert.equal(noOp.installed, false); assert.equal(f.store.list(bob).company[0].installs, 1);
  const removed = await f.store.uninstall(bob, first.name, async () => ({ shared: true }));
  assert.equal(removed.installed, false); assert.equal(f.store.list(bob).company[0].installs, 0);
});

test('old review and author notification results cannot overwrite a newer notification batch', async t => {
  const reviewGates = [];
  const f = fixture(t, { notify: async payload => {
    let resolve; const done = new Promise(r => { resolve = r; }); reviewGates.push({ payload, resolve }); await done;
  } });
  const submitting = f.store.submit(alice, await f.local(), meta);
  await waitFor(() => reviewGates.length === 1);
  const state = () => JSON.parse(fs.readFileSync(path.join(f.root, 'state/catalog.json')));
  const version = Object.keys(state().skills['meeting-notes'].versions)[0];
  const writeFile = fs.writeFileSync;
  let failSave = true;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    if (failSave) { failSave = false; throw new Error('simulated save failure'); }
    return writeFile(...args);
  });
  await assert.rejects(f.store.withdraw(alice, 'meeting-notes'), /simulated save failure/);
  const resending = f.store.review(it, 'meeting-notes', version, 'resend');
  await waitFor(() => reviewGates.length === 2);
  reviewGates[0].resolve();
  const first = await submitting;
  assert.equal(first.reviewNotice, undefined); assert.equal('reviewNoticeId' in first, false);
  reviewGates[1].resolve();
  const second = await resending;
  assert.equal(second.reviewNotice, 'sent'); assert.equal('reviewNoticeId' in second, false);
  assert.equal(state().skills['meeting-notes'].versions[version].reviewNotice, 'sent');

  const authorGates = [];
  const authored = fixture(t, { notifyAuthor: async payload => {
    let resolve; const done = new Promise(r => { resolve = r; }); authorGates.push({ payload, resolve }); await done;
  } });
  const draft = await authored.store.submit(alice, await authored.local(), meta);
  const approving = authored.store.review(it, draft.name, draft.version, 'approve');
  await waitFor(() => authorGates.length === 1);
  const notifyingAgain = authored.store.review(it, draft.name, draft.version, 'notify-author');
  await waitFor(() => authorGates.length === 2);
  authorGates[0].resolve(); await approving;
  authorGates[1].resolve();
  const authorResult = await notifyingAgain;
  assert.equal(authorResult.authorNotice, 'sent'); assert.equal('authorNoticeId' in authorResult, false);
});

test('a personal same-name conflict returns 409 and logs only the user slug', async t => {
  const f = fixture(t);
  const first = await f.store.submit(alice, await f.local(), meta);
  await f.store.review(it, first.name, first.version, 'approve');
  await f.local(bob);
  const handler = createSharedSkillsHandler({ store: f.store, execute: f.execute, origin: 'https://partner.example',
    authenticate: () => bob, tokenAuthenticate: () => null });
  const logs = []; t.mock.method(console, 'warn', line => logs.push(line));
  const req = Readable.from([Buffer.from(JSON.stringify({ action: 'install', name: first.name }))]);
  req.method = 'POST'; req.headers = { origin: 'https://partner.example', 'content-type': 'application/json' };
  const response = { status: 0, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handler(req, response, new URL('https://partner.example/_wp/market/shared'));
  assert.equal(response.status, 409); assert.match(response.body.message, /同名/);
  assert.equal(logs.length, 1); const entry = JSON.parse(logs[0]);
  assert.equal(entry.event, 'market_shared_error'); assert.equal(entry.action, 'install'); assert.equal(entry.user, 'bob');
  assert.equal(entry.status, 409); assert.doesNotMatch(logs[0], /reader-b|author-a|unionId/);
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

test('hexadecimal digests do not trigger embedded phone or ID digit sequences', () => {
  const bundle = content => ({ name: 'market-scan', description: '扫描测试', files: [{ path: 'SKILL.md', content: Buffer.from(content).toString('base64') }] });
  const phoneDigest = 'a13812345678b' + 'c'.repeat(51);
  const idDigest = 'd123456789012345678e' + 'f'.repeat(44);
  assert.match(phoneDigest, /^[0-9a-f]{64}$/);
  assert.match(idDigest, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => inspectSkill(bundle(phoneDigest)));
  assert.doesNotThrow(() => inspectSkill(bundle(idDigest)));

  for (const phone of [' 13812345678 ', '中文13812345678中文', '"13812345678"', ':13812345678:']) {
    assert.throws(() => inspectSkill(bundle(phone)), /疑似/);
  }
  assert.throws(() => inspectSkill(bundle('身份证：11010519491231002X。')), /疑似/);
});

test('large base64 files are validated without regex backtracking and malformed base64 is still rejected', () => {
  const bundle = files => ({ name: 'market-large', description: '大文件测试', files: [{ path: 'SKILL.md', content: Buffer.from('# ok').toString('base64') }, ...files] });
  const large = Buffer.alloc(6 * 1024 * 1024, 0xa7).toString('base64');
  assert.doesNotThrow(() => inspectSkill(bundle([{ path: 'assets/big.bin', content: large }])));
  for (const content of ['', 'QQ==', 'QUI=', 'QUJD']) assert.doesNotThrow(() => inspectSkill(bundle([{ path: 'a.bin', content }])));
  for (const content of ['Q===', 'QQ=', 'QQ==QQ==', 'Q@==', 'QUJD\n', 'QUJ']) {
    assert.throws(() => inspectSkill(bundle([{ path: 'a.bin', content }])), /无法读取/);
  }
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
  assert.deepEqual(card.elements.at(-1).actions.map(action => action.text.content), ['批准并发布', '拒绝']);
  assert.ok(card.elements.at(-1).actions.every(action => action.url.startsWith('https://partner.example/')));
  await notifier.notifyAuthor({ ...notice, unionId: alice.unionId, status: 'rejected', reason: '需要更清楚的说明' });
  assert.equal(sent[1].receive_id, alice.unionId); assert.match(JSON.parse(sent[1].content).text, /需要更清楚的说明/);
});

test('automatic publication cards notify reviewers with a bounded file list and withdrawal link', async t => {
  const f = fixture(t), sent = [];
  const secret = path.join(f.root, 'auto-app-secret'); fs.writeFileSync(secret, 'fixture-only');
  const notifier = marketNotifications({ identity: { appId: 'fixture-app', appSecretFile: secret }, server: { publicOrigin: 'https://partner.example' } }, async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes('/auth/')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'fixture-token' }) };
    sent.push(body); return { ok: true, json: async () => ({ code: 0 }) };
  });
  const changedFiles = Array.from({ length: 22 }, (_, index) => `file-${index}.md`);
  await notifier.notifyAuto({ name: 'meeting-notes', version: 'version-1', displayName: '会议整理', semver: '1.0.1', author: '作者甲', approvers: [it.unionId], changedFiles });
  const card = JSON.parse(sent[0].content);
  assert.equal(card.header.title.content, '技能已自动发布');
  assert.match(card.elements[0].text.content, /meeting-notes/);
  assert.match(card.elements[0].text.content, /file-19\.md/);
  assert.match(card.elements[0].text.content, /等 2 个/);
  assert.equal(card.elements.at(-1).actions[0].text.content, '查看 / 下架');
  assert.match(card.elements.at(-1).actions[0].url, /version=version-1/);
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
