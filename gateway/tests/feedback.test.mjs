import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { feedbackPage } from '../feedback-page.mjs';
import { createFeedback } from '../feedback.mjs';
import { issueToken, tokenUser } from '../market-auth.mjs';

const alice = { slug: 'alice', name: '甲', unionId: 'union-a' };
const bob = { slug: 'bob', name: '乙', unionId: 'union-b' };
const handler = { slug: 'handler', name: '处理人', unionId: 'union-h' };
const base = '/_wp/api/feedback', origin = 'https://work.example.test';
const draft = { type: 'bug', title: '问题标题', body: '问题描述' };
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const organization = { runtime: { stateDirectory: dir }, server: { publicHost: 'work.example.test', publicOrigin: origin },
    feedback: { allow: ['*'], handlers: [handler.unionId], botTokenFile: path.join(dir, 'bot.token'), maxImageBytes: 40, maxImagesPerItem: 3 }, appearance: {} };
  fs.writeFileSync(organization.feedback.botTokenFile, 'service-secret\n');
  let live = organization, time = Date.parse('2026-11-11T12:00:00Z');
  const notices = [];
  const options = { organization, organizationData: () => { if (live instanceof Error) throw live; return live; },
    authenticate: req => req.user, tokenAuthenticate: req => tokenUser(req, 'test-key', [alice, bob, handler]),
    now: () => time, send: async (...args) => notices.push(args), ...extra };
  let handle = createFeedback(options);
  async function request(route = base, { method = 'GET', user = alice, body, headers = {} } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = Readable.from([bytes]);
    Object.assign(req, { method, user, headers: { origin, 'content-type': 'application/json', ...headers } });
    const result = { status: undefined, headers: {}, raw: '' };
    const res = { writeHead(status, headers = {}) { result.status = status; result.headers = headers; }, end(data) { result.raw = data ?? ''; } };
    result.handled = await handle(req, res, new URL(route, origin));
    try { result.data = JSON.parse(String(result.raw)); } catch {}
    return result;
  }
  const create = async (user = alice, body = draft) => { const r = await request(base, { method: 'POST', user, body }); assert.equal(r.status, 201, String(r.raw)); return r.data.item; };
  const bot = (route, body, headers = {}) => request(base + '/bot/' + route, { user: null, method: body === undefined ? 'GET' : 'POST', body, headers: { authorization: 'Bearer service-secret', origin: undefined, ...headers } });
  return { dir, organization, request, create, bot, notices, read: () => JSON.parse(fs.readFileSync(path.join(dir, 'feedback/store.json'))),
    config: value => { live = value; }, advance: ms => { time += ms; }, restart: () => { handle = createFeedback(options); } };
}

test('serial atomic storage, seq, persistence and rollback after failed rename', async t => {
  const f = fixture(t);
  const items = await Promise.all([f.create(), f.create()]);
  assert.deepEqual(items.map(i => i.no), [1, 2]);
  assert.deepEqual(items.map(i => i.seq), [1, 2]);
  const route = `${base}/items/${items[0].id}/comments`;
  const comment = await f.request(route, { method: 'POST', body: { text: '补充' } });
  assert.equal(comment.data.item.seq, 3); assert.equal(comment.data.item.comments[0].seq, 3);
  assert.equal(fs.statSync(path.join(f.dir, 'feedback/store.json')).mode & 0o777, 0o600);
  const before = f.read();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk failure'); });
  assert.equal((await f.request(route, { method: 'POST', body: { text: '失败' } })).status, 503);
  rename.mock.restore();
  assert.deepEqual(f.read(), before);
  assert.equal((await f.request(`${base}/items/${items[0].id}`)).data.item.comments.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'feedback')), ['store.json']);
  f.restart();
  assert.equal((await f.create()).no, 3); assert.equal(f.read().seq, 4);
});

test('dynamic slug/unionId/wildcard lists fail closed and login precedes allow', async t => {
  const f = fixture(t);
  for (const allow of [[alice.slug], [alice.unionId], ['*']]) {
    f.config({ feedback: { allow } }); assert.equal((await f.request()).status, 200);
  }
  for (const config of [{ feedback: { allow: [] } }, {}, new Error('bad JSON'), { feedback: { allow: '*' } }]) {
    f.config(config); const r = await f.request(); assert.equal(r.status, 404); assert.equal(r.raw, '');
  }
  assert.equal((await f.request(base, { user: null })).status, 401);
  const page = await f.request('/_wp/feedback?x=1', { user: null });
  assert.equal(page.status, 302); assert.equal(page.headers.location, '/_wp/login?next=%2F_wp%2Ffeedback%3Fx%3D1');
  assert.equal((await f.request('/unrelated')).handled, false);
  f.config({ feedback: { allow: [], handlers: [handler.unionId] } });
  assert.equal((await f.request(base, { user: handler })).status, 200);
  f.config({ feedback: { allow: [] } });
  assert.equal((await f.request(base, { user: handler })).status, 404);
});

test('owner/handler visibility, redaction, summaries and need_info comments', async t => {
  const f = fixture(t), a = await f.create(), b = await f.create(bob);
  const route = `${base}/items/${a.id}`;
  assert.equal((await f.request(route, { user: bob })).status, 404);
  assert.equal((await f.request(route + '/comments', { user: bob, method: 'POST', body: { text: '偷窥' } })).status, 404);
  const all = await f.request(base + '?scope=all', { user: handler });
  assert.equal(all.data.items.length, 2); assert.equal(all.data.isHandler, true);
  assert.ok(!String(all.raw).includes('union-')); assert.ok(!('body' in all.data.items[0]));
  assert.equal((await f.request(base + '?scope=all', { user: alice })).data.items.length, 1);
  assert.ok(!String((await f.request(`${base}/items/${b.id}`, { user: handler })).raw).includes(bob.unionId));
  await f.bot('items/' + a.id, { status: 'need_info' });
  await f.request(route + '/comments', { method: 'POST', user: handler, body: { text: '处理人评论' } });
  assert.equal((await f.request(route)).data.item.status, 'need_info');
  await f.request(route + '/comments', { method: 'POST', body: { text: '补充信息' } });
  assert.equal((await f.request(route)).data.item.status, 'open');
});

test('same-origin JSON writes and zpd/service token separation', async t => {
  const f = fixture(t);
  for (const headers of [{ origin: undefined }, { origin: 'https://evil.test' }, { 'content-type': 'text/plain' }]) {
    assert.equal((await f.request(base, { method: 'POST', body: draft, headers })).status, 403);
  }
  const token = issueToken('test-key', alice);
  assert.equal((await f.request(base, { method: 'POST', body: draft, user: null, headers: { authorization: `Bearer ${token}`, origin: undefined } })).status, 201);
  assert.equal((await f.request(base, { user: null, headers: { authorization: 'Bearer service-secret' } })).status, 401);
  assert.equal((await f.request(base, { headers: { authorization: 'Bearer service-secret' } })).status, 401);
  assert.equal((await f.bot('changes', undefined, { authorization: `Bearer ${token}` })).status, 401);
});

test('lengths, JSON bounds, validation and per-user UTC daily quota', async t => {
  const f = fixture(t);
  for (const body of [null, [], { ...draft, title: '字'.repeat(121) }, { ...draft, body: '字'.repeat(8001) }, { ...draft, title: '  ' }, { ...draft, type: 'other' }]) {
    const r = await f.request(base, { method: 'POST', body }); assert.equal(r.status, 400); assert.match(r.data.error, /[\u4e00-\u9fff]/);
  }
  assert.equal((await f.request(base, { method: 'POST', body: Buffer.from('{') })).status, 400);
  assert.equal((await f.request(base, { method: 'POST', body: { ...draft, body: 'x'.repeat(65536) } })).status, 413);
  const a = await f.create(alice, { ...draft, title: '字'.repeat(120), body: '字'.repeat(8000) });
  const route = `${base}/items/${a.id}/comments`;
  assert.equal((await f.request(route, { method: 'POST', body: { text: '字'.repeat(4001) } })).status, 400);
  assert.equal((await f.request(route, { method: 'POST', body: { text: '字'.repeat(4000) } })).status, 200);
  for (let n = 1; n < 30; n++) await f.create();
  assert.equal((await f.request(base, { method: 'POST', body: draft })).status, 429);
  await f.create(bob); f.advance(86400000); await f.create();
});

test('image magic, size/count limits, author-only uploads and protected downloads', async t => {
  const f = fixture(t), a = await f.create(), route = `${base}/items/${a.id}/files`;
  const upload = (body, user = alice, headers = {}) => f.request(route + '?filename=screen.html', { method: 'POST', user, body, headers: { 'content-type': 'application/octet-stream', ...headers } });
  assert.equal((await upload(png, handler)).status, 404);
  assert.equal((await upload(png, alice, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await upload(png, alice, { 'content-type': 'image/png' })).status, 403);
  assert.equal((await upload(Buffer.from('<svg/>'))).status, 400);
  assert.equal((await upload(Buffer.alloc(41))).status, 413);
  const types = [[png, 'image/png', 'png'], [Buffer.from('ffd8ffe00000', 'hex'), 'image/jpeg', 'jpg'], [Buffer.from('5249464610000000574542505650382000000000', 'hex'), 'image/webp', 'webp']];
  for (const [bytes, mime, ext] of types) {
    const r = await upload(bytes); assert.equal(r.status, 201, String(r.raw));
    const file = r.data.item.files.at(-1);
    const stored = path.join(f.dir, 'feedback/files', a.id, file.id + '.' + ext);
    assert.equal(fs.statSync(stored).mode & 0o777, 0o600); assert.deepEqual(fs.readFileSync(stored), bytes);
    const download = await f.request(route + '/' + file.id, { user: handler });
    assert.deepEqual(download.raw, bytes);
    assert.equal(download.headers['content-type'], mime);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.equal(download.headers['content-security-policy'], 'sandbox');
    assert.equal(download.headers['cache-control'], 'private, no-store');
    assert.equal((await f.request(route + '/' + file.id, { user: bob })).status, 404);
    assert.deepEqual((await f.bot(`items/${a.id}/files/${file.id}`)).raw, bytes);
  }
  assert.equal((await upload(png)).status, 400);
});

test('bot token is read on every request; cookie, absent, empty and wrong tokens fail', async t => {
  const f = fixture(t);
  assert.equal((await f.request(base + '/bot/changes')).status, 401);
  assert.equal((await f.bot('changes', undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.bot('changes')).status, 200);
  fs.writeFileSync(f.organization.feedback.botTokenFile, 'new-secret');
  assert.equal((await f.bot('changes')).status, 401);
  assert.equal((await f.bot('changes', undefined, { authorization: 'Bearer new-secret' })).status, 200);
  fs.writeFileSync(f.organization.feedback.botTokenFile, ' \n');
  assert.equal((await f.bot('changes', undefined, { authorization: 'Bearer ' })).status, 401);
  fs.unlinkSync(f.organization.feedback.botTokenFile);
  assert.equal((await f.bot('changes')).status, 401);
});

test('changes cursor orders current items, pages, exposes unionId only to bot', async t => {
  const f = fixture(t), a = await f.create(), b = await f.create(bob);
  await f.request(`${base}/items/${a.id}/comments`, { method: 'POST', body: { text: '更新' } });
  const first = (await f.bot('changes?since=0&limit=1')).data;
  assert.equal(first.items[0].id, b.id); assert.equal(first.next, 2);
  const second = (await f.bot('changes?since=2')).data;
  assert.equal(second.items[0].id, a.id); assert.equal(second.next, 3);
  assert.equal(second.items[0].author.unionId, alice.unionId); assert.equal(second.items[0].comments[0].seq, 3);
  assert.deepEqual((await f.bot('changes?since=3')).data, { items: [], next: 3 });
  assert.equal((await f.bot('items/' + a.id)).data.item.author.unionId, alice.unionId);
  for (const query of ['since=-1', 'since=nan', 'limit=0', 'limit=1.5']) assert.equal((await f.bot('changes?' + query)).status, 400);
});

test('bot writes validate atomically, reply keys are per-item idempotent, type only tightens', async t => {
  const f = fixture(t), a = await f.create(), b = await f.create();
  const patch = { status: 'in_progress', type: 'feature', approval: { state: 'approved', note: '批准' }, pr: 'https://github.com/org/repo/pull/1', reply: { key: 'run-1', text: '正在处理' } };
  const first = (await f.bot('items/' + a.id, patch)).data.item;
  assert.equal(first.typeChangedFrom, 'bug'); assert.equal(first.comments.length, 1); assert.equal(first.notice, 'sent');
  assert.equal(first.comments[0].seq + 1, first.seq); assert.equal(f.notices.length, 1);
  const again = (await f.bot('items/' + a.id, patch)).data.item;
  assert.deepEqual(again, first); assert.equal(f.notices.length, 1);
  const changed = (await f.bot('items/' + a.id, { status: 'done', reply: patch.reply })).data.item;
  assert.equal(changed.status, 'done'); assert.equal(changed.comments.length, 1); assert.equal(f.notices.length, 2);
  assert.equal((await f.bot('items/' + b.id, { reply: patch.reply })).data.item.comments.length, 1);
  for (const body of [{ type: 'bug' }, { status: 'invalid' }, { status: ['done'] }, { approval: { state: 'oops' } }, { pr: 'javascript:alert(1)' }, { reply: { key: '', text: 'hi' } }, { status: 'open', reply: { key: 'new', text: 'x'.repeat(4001) } }]) {
    const before = f.read(); assert.equal((await f.bot('items/' + a.id, body)).status, 400); assert.deepEqual(f.read(), before);
  }
  assert.match(f.notices[0][1], /#1/); assert.match(f.notices[0][1], /处理中/); assert.match(f.notices[0][1], new RegExp('/_wp/feedback#' + a.id));
});

test('notification failure does not undo a committed bot update', async t => {
  const f = fixture(t, { send: async () => { throw new Error('offline'); } }), a = await f.create();
  const result = await f.bot('items/' + a.id, { status: 'need_info', reply: { key: 'one', text: '请补截图' } });
  assert.equal(result.status, 200); assert.equal(result.data.item.notice, 'failed');
  f.restart(); const stored = (await f.bot('items/' + a.id)).data.item;
  assert.equal(stored.status, 'need_info'); assert.equal(stored.comments.length, 1); assert.equal(stored.notice, 'failed');
});

test('slow notification does not block user submissions, comments or uploads and returns the latest notice seq', async t => {
  const started = Promise.withResolvers(), delivery = Promise.withResolvers();
  const f = fixture(t, { send: async () => { started.resolve(); await delivery.promise; } });
  const a = await f.create(), route = `${base}/items/${a.id}`;
  const update = f.bot('items/' + a.id, { status: 'need_info', reply: { key: 'slow', text: '请补充' } });
  await started.promise;
  let finished = false;
  update.then(() => { finished = true; });
  const writes = Promise.all([
    f.create(bob),
    f.request(route + '/comments', { method: 'POST', body: { text: '用户补充' } }),
    f.request(route + '/files', { method: 'POST', body: png, headers: { 'content-type': 'application/octet-stream' } }),
    f.bot('items/' + a.id, { type: 'feature' }),
  ]);
  let timer;
  const completed = await Promise.race([
    writes.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); }),
  ]);
  clearTimeout(timer);
  const waitingForNotice = !finished;
  delivery.resolve();
  const [created, comment, upload, type] = await writes;
  const result = await update;
  assert.equal(completed, true, 'user writes must finish while the notification is still pending');
  assert.equal(waitingForNotice, true, 'bot response must wait for the notice write');
  assert.equal(created.no, 2); assert.equal(comment.status, 200); assert.equal(upload.status, 201); assert.equal(type.status, 200);
  assert.equal(result.status, 200);
  assert.equal(result.data.item.notice, 'sent'); assert.equal(result.data.item.status, 'open');
  assert.equal(result.data.item.type, 'feature'); assert.equal(result.data.item.files.length, 1);
  assert.equal(result.data.item.comments.length, 2);
  assert.deepEqual(result.data.item, f.read().items[a.id]);
  assert.equal(result.data.item.seq, 7);
  assert.deepEqual((await f.bot('changes?since=7')).data, { items: [], next: 7 });
});

test('missing item during notice persistence does not fail a committed bot response', async t => {
  t.mock.method(console, 'error', () => {});
  let f;
  f = fixture(t, { send: async () => {
    fs.writeFileSync(path.join(f.dir, 'feedback/store.json'), JSON.stringify({ version: 1, seq: 2, nextNo: 2, items: {} }));
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); });
  } });
  const a = await f.create();
  const result = await f.bot('items/' + a.id, { status: 'done' });
  assert.equal(result.status, 200); assert.equal(result.data.item.status, 'done');
  assert.deepEqual(f.read().items, {});
});

test('corrupt or unsupported store disables only feedback and preserves the original bytes', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  for (const content of ['{"private-submission":"secret-token",oops}', JSON.stringify({ version: 2, items: {}, seq: 0, nextNo: 1 }), 'null']) {
    const f = fixture(t), file = path.join(f.dir, 'feedback/store.json');
    fs.writeFileSync(file, content);
    const before = errors.mock.callCount();
    assert.doesNotThrow(() => f.restart());
    assert.equal(errors.mock.callCount(), before + 1);
    const log = errors.mock.calls.at(-1).arguments.join(' ');
    assert.doesNotMatch(log, /private-submission|secret-token|oops|\n/);
    for (const route of ['/_wp/feedback', base, base + '/items/missing', base + '/bot/changes']) {
      for (const method of ['GET', 'POST']) {
        const result = await f.request(route, { user: null, method, body: draft });
        assert.equal(result.status, 503); assert.match(String(result.raw), /反馈功能暂时不可用/);
      }
    }
    assert.equal((await f.request('/unrelated')).handled, false);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['store.json']);
    assert.equal(errors.mock.callCount(), before + 1, 'initialization logs once, not once per request');
  }
});

test('signed-in unprovisioned sessions get 404 on feedback pages and APIs', async t => {
  const f = fixture(t, { sessionAuthenticate: () => ({ unionId: 'pending-union' }) });
  f.config({ feedback: { allow: ['*'], handlers: ['pending-union'] } });
  for (const route of ['/_wp/feedback', base, base + '/items/unknown']) {
    const result = await f.request(route, { user: null });
    assert.equal(result.status, 404); assert.equal(result.raw, ''); assert.equal(result.headers.location, undefined);
  }
  // Explicit credentials must still not fall back to the pending browser session.
  assert.equal((await f.request(base, { user: null, headers: { authorization: 'Bearer invalid' } })).status, 401);
});

test('unexpected disk errors log only a route name and error code or message', async t => {
  const f = fixture(t), a = await f.create(), errors = t.mock.method(console, 'error', () => {});
  for (const error of [Object.assign(new Error('private path detail'), { code: 'EIO' }), new Error('disk unavailable')]) {
    const before = f.read();
    const rename = t.mock.method(fs, 'renameSync', () => { throw error; });
    const response = await f.request(`${base}/items/${a.id}/comments?token=query-secret`, {
      method: 'POST', body: { text: 'private-submission' }, headers: { authorization: 'Bearer ' + issueToken('test-key', alice) },
    });
    rename.mock.restore();
    assert.equal(response.status, 503); assert.deepEqual(f.read(), before);
    const log = errors.mock.calls.at(-1)?.arguments.join(' ');
    assert.ok(log, 'unexpected failures must be logged'); assert.match(log, /comments/);
    assert.ok(log.includes(error.code || error.message));
    assert.doesNotMatch(log, /private-submission|query-secret|Bearer|zpd\.|private path detail/);
  }
  assert.equal(errors.mock.callCount(), 2);
});

test('comments enforce a per-user 200 quota across items and reset at UTC midnight', async t => {
  const f = fixture(t), a = await f.create(), b = await f.create();
  f.advance(12 * 60 * 60 * 1000 - 1);
  const comment = (item, user = alice) => f.request(`${base}/items/${item.id}/comments`, { method: 'POST', user, body: { text: '补充' } });
  for (let n = 0; n < 199; n++) assert.equal((await comment(n % 2 ? a : b)).status, 200);
  const results = await Promise.all([comment(a), comment(b)]);
  assert.deepEqual(results.map(r => r.status), [200, 429]); assert.match(results[1].data.error, /每天.*200/);
  const before = f.read(); assert.equal((await comment(b)).status, 429); assert.deepEqual(f.read(), before);
  assert.equal((await comment(a, handler)).status, 200);
  f.advance(1);
  assert.equal((await comment(a)).status, 200);
});

test('500 comments per item includes bot replies, preserves atomicity and permits idempotent retries', async t => {
  const f = fixture(t), a = await f.create();
  const comment = () => f.request(`${base}/items/${a.id}/comments`, { method: 'POST', body: { text: '补充' } });
  for (let day = 0; day < 2; day++) {
    for (let n = 0; n < 200; n++) assert.equal((await comment()).status, 200);
    f.advance(86400000);
  }
  for (let n = 0; n < 99; n++) assert.equal((await f.bot('items/' + a.id, { reply: { key: 'bot-' + n, text: '答复' } })).status, 200);
  const last = await comment(); assert.equal(last.status, 200); assert.equal(last.data.item.comments.length, 500);
  const before = f.read();
  const userOverflow = await comment(); assert.equal(userOverflow.status, 409); assert.match(userOverflow.data.error, /500/);
  const botOverflow = await f.bot('items/' + a.id, { status: 'done', reply: { key: 'overflow', text: '多余回复' } });
  assert.equal(botOverflow.status, 409); assert.match(botOverflow.data.error, /500/);
  assert.deepEqual(f.read(), before);
  assert.equal((await f.bot('items/' + a.id, { reply: { key: 'bot-0', text: '答复' } })).status, 200);
  assert.deepEqual(f.read(), before);
  assert.equal((await f.bot('items/' + a.id, { status: 'done' })).status, 200);
});

test('page has restrictive CSP, responsive viewport and safe DOM rendering', async t => {
  const f = fixture(t); f.organization.appearance.authorizationStyle = 'body{color:navy}';
  const r = await f.request('/_wp/feedback'); assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /img-src 'self' blob:/);
  assert.match(String(r.raw), /initial-scale=1/); assert.match(String(r.raw), /body\{color:navy\}/);
  assert.doesNotMatch(String(r.raw), /innerHTML/); assert.match(String(r.raw), /textContent/);
  const script = String(r.raw).match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});


test('upload save failure removes orphan files and concurrent uploads enforce the cap', async t => {
  const f = fixture(t), a = await f.create(), route = `${base}/items/${a.id}/files?filename=test.png`;
  const upload = () => f.request(route, { method: 'POST', body: png, headers: { 'content-type': 'application/octet-stream' } });
  const before = f.read();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('disk failure'); });
  assert.equal((await upload()).status, 503); rename.mock.restore();
  assert.deepEqual(f.read(), before); assert.deepEqual(fs.readdirSync(path.join(f.dir, 'feedback/files', a.id)), []);
  const results = await Promise.all(Array.from({ length: 4 }, upload));
  assert.deepEqual(results.map(r => r.status), [201, 201, 201, 400]);
  assert.equal(f.read().seq, 4); assert.equal(f.read().items[a.id].files.length, 3);
});

test('notification result has its own seq, and result-save failure preserves the business write', async t => {
  const f = fixture(t), a = await f.create();
  const result = (await f.bot('items/' + a.id, { reply: { key: 'notice', text: '消息' } })).data.item;
  assert.equal(result.comments[0].seq, 2); assert.equal(result.seq, 3);
  assert.equal((await f.bot('changes?since=2')).data.items[0].notice, 'sent');
  const renameOriginal = fs.renameSync; let calls = 0;
  const rename = t.mock.method(fs, 'renameSync', (...args) => { if (++calls === 2) throw new Error('notice disk failure'); return renameOriginal(...args); });
  const r = await f.bot('items/' + a.id, { status: 'done' }); rename.mock.restore();
  assert.equal(r.status, 200); assert.equal(r.data.item.status, 'done');
  assert.equal(r.data.item.seq, 4); assert.equal(f.read().items[a.id].status, 'done');
});


test('detail screenshot retry retains remaining files and does not re-upload saved files', async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.value = ''; this.files = []; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener() {}
    setAttribute() {}
    scrollIntoView() {}
  }
  const ids = new Map(), element = id => { if (!ids.has(id)) ids.set(id, new Element(id)); return ids.get(id); };
  const item = { id: 'item1', no: 1, type: 'bug', title: '标题', body: '描述', author: { name: '甲' }, status: 'open',
    createdAt: '2026-11-11T12:00:00Z', updatedAt: '2026-11-11T12:00:00Z', approval: { state: 'none' }, files: [], comments: [] };
  const uploaded = [];
  const context = vm.createContext({ document: { getElementById: element, createElement: tag => new Element(tag) },
    window: { addEventListener() {} }, location: { hash: '#item1' }, URL: { createObjectURL: file => 'blob:' + file.name, revokeObjectURL() {} }, Date,
    fetch: async (url, options) => {
      if (options.method === 'POST') {
        if (options.body.name === 'bad.png') return { ok: false, status: 400, json: async () => ({ error: '无效图片' }) };
        uploaded.push(options.body.name); item.files.push({ id: 'file' + uploaded.length, name: options.body.name });
        return { ok: true, json: async () => ({ item: structuredClone(item) }) };
      }
      return { ok: true, json: async () => url.includes('/items/') ? { item: structuredClone(item), canUpload: true } : { items: [], isHandler: false } };
    },
  });
  vm.runInContext(feedbackPage().match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await vm.runInContext('openDetail()', context);
  const flatten = e => [e, ...e.children.flatMap(flatten)], elements = () => flatten(element('detail'));
  const input = elements().find(e => e.tag === 'input');
  input.files = ['first.png', 'bad.png', 'third.png'].map(name => ({ name, type: 'image/png', size: 12 }));
  await input.onchange();
  const upload = elements().find(e => e.tag === 'button' && e.textContent === '上传截图');
  if (upload) await upload.onclick();
  assert.deepEqual(uploaded, ['first.png']);
  assert.equal(elements().filter(e => e.tag === 'img').length, 3, 'saved screenshot and both pending files remain visible');
  const badPreview = elements().find(e => e.children.some(child => child.tag === 'img' && child.alt === 'bad.png'));
  badPreview.children.find(e => e.tag === 'button').onclick();
  await upload.onclick();
  assert.deepEqual(uploaded, ['first.png', 'third.png']);
});

test('changes uses the default page size and caps requested batches at 200', async t => {
  const f = fixture(t);
  for (let n = 0; n < 201; n++) await f.create({ slug: 'batch-' + n, unionId: 'batch-union-' + n, name: '批量作者' });
  const defaultPage = (await f.bot('changes')).data;
  assert.equal(defaultPage.items.length, 50); assert.equal(defaultPage.next, 50);
  const capped = (await f.bot('changes?limit=1000')).data;
  assert.equal(capped.items.length, 200); assert.equal(capped.next, 200);
  const last = (await f.bot('changes?since=200&limit=200')).data;
  assert.equal(last.items.length, 1); assert.equal(last.next, 201);
});
