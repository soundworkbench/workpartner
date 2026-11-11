import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { feedbackClient } from '../feedback-client.mjs';
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
  return { dir, organization, request, create, bot, notices, clientFor: user => handle.clientFor(user), read: () => JSON.parse(fs.readFileSync(path.join(dir, 'feedback/store.json'))),
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
  assert.match(f.notices[0][1], /#1/); assert.match(f.notices[0][1], /处理中/); assert.match(f.notices[0][1], new RegExp('/\\?wp-feedback=' + a.id));
});

test('notification failure does not undo a committed bot update', async t => {
  const f = fixture(t, { send: async () => { throw new Error('offline'); } }), a = await f.create();
  const result = await f.bot('items/' + a.id, { status: 'need_info', reply: { key: 'one', text: '请补截图' } });
  assert.equal(result.status, 200); assert.equal(result.data.item.notice, 'failed');
  f.restart(); const stored = (await f.bot('items/' + a.id)).data.item;
  assert.equal(stored.status, 'need_info'); assert.equal(stored.comments.length, 1); assert.equal(stored.notice, 'failed');
});

test('slow notification does not block user submissions, comments or uploads and returns a seq before concurrent changes', async t => {
  const started = Promise.withResolvers(), delivery = Promise.withResolvers();
  const f = fixture(t, { send: async () => { started.resolve(); await delivery.promise; } });
  const a = await f.create(), route = `${base}/items/${a.id}`;
  const items = captureResponseItems(t);
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
  const returned = items.at(-1);
  assert.equal(completed, true, 'user writes must finish while the notification is still pending');
  assert.equal(waitingForNotice, true, 'bot response must wait for the notice write');
  assert.equal(created.no, 2); assert.equal(comment.status, 200); assert.equal(upload.status, 201); assert.equal(type.status, 200);
  assert.equal(result.status, 200);
  assert.equal(result.data.item.notice, 'sent'); assert.equal(result.data.item.status, 'need_info');
  assert.equal(result.data.item.type, 'bug'); assert.equal(result.data.item.files.length, 0);
  assert.equal(result.data.item.comments.length, 1);
  assert.equal(result.data.item.seq, result.data.item.comments[0].seq);
  assert.ok(result.data.item.seq < comment.data.item.comments.at(-1).seq);
  assert.ok(result.data.item.seq < upload.data.item.seq);
  assert.ok(result.data.item.seq < type.data.item.seq);
  const changes = (await f.bot('changes?since=' + result.data.item.seq)).data;
  const current = changes.items.find(item => item.id === a.id);
  assert.deepEqual(current, f.read().items[a.id]);
  assert.equal(current.notice, 'sent'); assert.equal(current.status, 'open');
  assert.equal(current.type, 'feature'); assert.equal(current.files.length, 1);
  assert.equal(current.comments.at(-1).text, '用户补充'); assert.equal(current.seq, 7);
  returned.author.name = 'changed'; returned.comments[0].text = 'changed';
  assert.deepEqual((await f.bot('items/' + a.id)).data.item, current);
  assert.deepEqual(f.read().items[a.id], current);
});

// Capture objects before JSON serialization so response-copy checks also exercise the live store.
function captureResponseItems(t) {
  const items = [], stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.item) items.push(value.item);
    return stringify(value, ...args);
  });
  return items;
}

test('notification without concurrent changes returns an independent copy with the final notice seq', async t => {
  const f = fixture(t), a = await f.create(), items = captureResponseItems(t);
  const result = await f.bot('items/' + a.id, { status: 'done', reply: { key: 'one', text: '已处理' } });
  assert.equal(result.status, 200);
  const returned = items.at(-1), stored = f.read().items[a.id];
  assert.deepEqual(returned, stored); assert.equal(returned.notice, 'sent');
  assert.equal(returned.seq, returned.comments[0].seq + 1);
  assert.deepEqual((await f.bot('changes?since=' + returned.seq)).data, { items: [], next: returned.seq });
  returned.author.name = 'changed'; returned.comments[0].text = 'changed';
  assert.deepEqual((await f.bot('items/' + a.id)).data.item, stored);
  assert.deepEqual(f.read().items[a.id], stored);
});

test('out-of-order bot notifications preserve the newer notice and return independent business snapshots', async t => {
  const started = [Promise.withResolvers(), Promise.withResolvers()];
  const delivery = [Promise.withResolvers(), Promise.withResolvers()];
  let calls = 0;
  const f = fixture(t, { send: async () => {
    const index = calls++;
    started[index].resolve(); await delivery[index].promise;
    if (index === 1) throw new Error('second delivery failed');
  } });
  const a = await f.create(), items = captureResponseItems(t);
  const first = f.bot('items/' + a.id, { status: 'need_info', reply: { key: 'first', text: '请补充' } });
  await started[0].promise;
  const firstBusiness = f.read().items[a.id];
  const second = f.bot('items/' + a.id, { status: 'done', reply: { key: 'second', text: '已处理' } });
  await started[1].promise;
  delivery[1].resolve();
  const secondResult = await second, secondReturned = items.at(-1), stored = f.read();
  assert.equal(secondResult.status, 200); assert.equal(secondReturned.notice, 'failed');
  assert.deepEqual(secondReturned, stored.items[a.id]);
  delivery[0].resolve();
  const firstResult = await first, firstReturned = items.at(-1);
  assert.equal(firstResult.status, 200); assert.deepEqual(firstReturned, firstBusiness);
  assert.deepEqual(f.read(), stored, 'stale delivery must neither overwrite notice nor touch seq');
  assert.ok(firstReturned.seq < secondReturned.comments.at(-1).seq);
  assert.notStrictEqual(firstReturned, secondReturned);
  firstReturned.author.name = 'first changed'; firstReturned.comments[0].text = 'first changed';
  assert.deepEqual(secondReturned, stored.items[a.id]);
  secondReturned.author.name = 'second changed'; secondReturned.comments[0].by.name = 'second changed';
  assert.equal(firstReturned.comments[0].by.name, firstBusiness.comments[0].by.name);
  assert.deepEqual((await f.bot('items/' + a.id)).data.item, stored.items[a.id]);
  assert.deepEqual(f.read(), stored);
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

test('notice save failure after concurrent changes returns an independent snapshot with the committed seq', async t => {
  t.mock.method(console, 'error', () => {});
  const started = Promise.withResolvers(), delivery = Promise.withResolvers();
  const f = fixture(t, { send: async () => { started.resolve(); await delivery.promise; } });
  const a = await f.create(), items = captureResponseItems(t);
  const update = f.bot('items/' + a.id, { status: 'need_info', reply: { key: 'one', text: '请补充' } });
  await started.promise;
  const business = f.read().items[a.id];
  const comment = await f.request(`${base}/items/${a.id}/comments`, { method: 'POST', body: { text: '用户补充' } });
  assert.equal(comment.status, 200);
  const stored = f.read();
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('notice disk failure'); });
  delivery.resolve();
  const result = await update, returned = items.at(-1);
  rename.mock.restore();
  assert.equal(result.status, 200); assert.deepEqual(returned, business);
  assert.ok(returned.seq < comment.data.item.seq);
  assert.deepEqual((await f.bot('changes?since=' + returned.seq)).data.items, [stored.items[a.id]]);
  returned.author.name = 'changed'; returned.comments[0].text = 'changed';
  assert.deepEqual((await f.bot('items/' + a.id)).data.item, stored.items[a.id]);
  assert.deepEqual(f.read(), stored);
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

test('legacy page redirects to the main UI after admission', async t => {
  const f = fixture(t), r = await f.request('/_wp/feedback');
  assert.equal(r.status, 302); assert.equal(r.headers.location, '/?wp-feedback=1');
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.raw, '');
  assert.equal(r.headers['content-security-policy'], undefined);
  f.config({ feedback: { allow: [] } });
  assert.equal((await f.request('/_wp/feedback')).status, 404);
});

test('clientFor shares live admission policy and never embeds identities or credentials', t => {
  const f = fixture(t);
  for (const allow of [[alice.slug], [alice.unionId], ['*']]) {
    f.config({ feedback: { allow } });
    const script = f.clientFor(alice);
    assert.ok(script.startsWith('\n;')); assert.match(script, /wp-feedback-dialog/);
    assert.doesNotMatch(script, /union-a|alice|service-secret|bot.token/);
  }
  for (const config of [{ feedback: { allow: [] } }, {}, new Error('bad JSON'), { feedback: { allow: '*' } }]) {
    f.config(config); assert.equal(f.clientFor(alice), '');
  }
  f.config({ feedback: { allow: [], handlers: [handler.unionId] } });
  assert.ok(f.clientFor(handler)); assert.equal(f.clientFor(alice), '');
  f.config({ feedback: { allow: ['*'], handlers: [handler.unionId] } });
  assert.equal(f.clientFor(null), ''); assert.equal(f.clientFor({ unionId: handler.unionId }), '');
  f.organization.features = { feedback: false };
  assert.equal(f.clientFor(alice), ''); assert.equal(f.clientFor(handler), '');
});

test('generated client is isolated, numeric-only configured and uses safe DOM rendering', () => {
  for (const options of [undefined, { maxImageBytes: 40, maxImagesPerItem: 3 }, { maxImageBytes: 'secret-user-data' }]) {
    const script = feedbackClient(options);
    assert.doesNotThrow(() => new vm.Script(script));
    assert.doesNotMatch(script, /innerHTML\s*=|insertAdjacentHTML|document\.write|secret-user-data/);
    assert.match(script, /textContent/);
    assert.doesNotThrow(() => vm.runInNewContext(script, {}), 'startup errors cannot escape');
  }
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

// Only the DOM operations used by this client; observer delivery is explicit and bounded.
function browser({ href = origin + '/', language, storedLanguage, maxImageBytes = 40, request = async () => ({ items: [], isHandler: false }) } = {}) {
  const observers = [], callbacks = new Map(), reads = [], alerts = [], replacements = [], scrolls = [];
  let deliveries = 0;
  const notify = target => {
    for (const o of observers) if (o.target && (o.target === target || (o.options.subtree && o.target.contains(target)))) o.pending = true;
  };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.files = []; this.listeners = {}; this.className = ''; this._text = ''; }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    append(...children) { children.forEach(c => this.insertBefore(c, null)); }
    appendChild(child) { this.append(child); return child; }
    insertBefore(child, before) {
      if (child.parentNode) child.remove();
      const index = before ? this.children.indexOf(before) : this.children.length;
      assert.notEqual(index, -1); this.children.splice(index, 0, child); child.parentNode = this; notify(this); return child;
    }
    replaceChildren(...children) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this.append(...children); notify(this); }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; notify(p); } }
    contains(target) { return this === target || this.children.some(c => c.contains(target)); }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = value; }
    getAttribute(key) { return key === 'id' ? this.id : key === 'type' ? this.type : this.attributes[key]; }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      const attr = selector.match(/\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]/);
      if (attr && (attr[2] === undefined ? this.getAttribute(attr[1]) === undefined : this.getAttribute(attr[1]) !== attr[2])) return false;
      const cls = selector.match(/\.([\w-]+)/); if (cls && !this.className.split(' ').includes(cls[1])) return false;
      const tag = selector.match(/^[\w-]+/); return !tag || this.tag === tag[0];
    }
    querySelectorAll(selector) { return this.children.flatMap(c => [c, ...c.querySelectorAll('*')]).filter(c => selector.split(',').some(s => c.matches(s.trim()))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    async fire(type, values = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...values }; for (const fn of this.listeners[type] || []) await fn(event); if (this['on' + type]) await this['on' + type](event); }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    focus() { document.activeElement = this; }
    scrollIntoView() { scrolls.push({ element: this, kind: 'intoView' }); }
    get scrollTop() { return this._scrollTop || 0; }
    set scrollTop(top) { this._scrollTop = top; scrolls.push({ element: this, top }); }
    get clientTop() { return 1; }
    get previousElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; }
    get lastElementChild() { return this.children.at(-1) || null; }
    click() { this.clicks = (this.clicks || 0) + 1; }
    reset() { this.querySelectorAll('input, textarea').forEach(e => { e.value = ''; }); }
    get isConnected() { return document.body?.contains(this) || document.head.contains(this); }
    get offsetHeight() { return Math.min(this.children.length * 34, Number.parseFloat(this.style.maxHeight) || 500); }
    get offsetWidth() { return 220; }
    getBoundingClientRect() {
      if (this.rect) return this.rect;
      if (this.tag === 'dialog') return { top: 12, bottom: 628, left: 12, right: 348, width: 336, height: 616 };
      let parent = this.parentNode;
      while (parent && parent.tag !== 'dialog') parent = parent.parentNode;
      const top = parent ? (this.id === 'wp-feedback-detail' ? 1400 : this.className === 'wp-feedback-message' ? 1200 : 800) - parent.scrollTop : 550;
      return { top, bottom: top + 40, left: 10, right: 230, width: 220, height: 40 };
    }
  }
  const document = {
    readyState: 'loading', body: null, head: new Element('head'), documentElement: { lang: 'zh-CN' },
    createElement: tag => new Element(tag),
    querySelectorAll: s => document.body?.querySelectorAll(s) || [],
    querySelector: s => document.body?.querySelector(s) || null,
    addEventListener: (type, fn) => callbacks.set(type, fn),
  };
  const location = new URL(href), history = { state: { retained: true }, replaceState(state, title, value) { replacements.push(value); assert.equal(state, this.state); location.href = new URL(value, location).href; } };
  const window = { innerWidth: 360, innerHeight: 640, addEventListener() {}, alert: text => alerts.push(text) };
  if (language) window.wpSettings = { get: () => ({ language }) };
  class BrowserURL extends URL { static createObjectURL(file) { return 'blob:' + file.name; } static revokeObjectURL() {} }
  const context = vm.createContext({ document, window, location, history, URL: BrowserURL,
    localStorage: { getItem: key => key === 'i18nextLng' ? storedLanguage : null },
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe(target, options) { assert.ok(target); this.target = target; this.options = options; } disconnect() { this.target = null; this.pending = false; } },
    fetch: async (url, options) => { reads.push({ url, options }); const result = await request(url, options); return { ok: !result.status || result.status < 400, status: result.status || 200, json: async () => result }; },
  });
  vm.runInContext(feedbackClient({ maxImageBytes, maxImagesPerItem: 3 }), context);
  function flush() { for (let n = 0; observers.some(o => o.pending); n++) { assert.ok(n < 20, 'observer must settle'); for (const o of observers) if (o.pending) { o.pending = false; deliveries++; o.fn([]); } } }
  async function tick() { await new Promise(resolve => setImmediate(resolve)); flush(); }
  async function ready() { document.body = new Element('body'); document.readyState = 'interactive'; callbacks.get('DOMContentLoaded')?.(); await tick(); }
  function menu(logout = true, separator = true) { const m = new Element('div'); m.className = 'wp-pick-menu wp-settings-menu'; document.body.append(m); redraw(m, logout, separator); return m; }
  function redraw(m, logout = true, separator = true) { m.replaceChildren(); if (separator) { const sep = new Element('div'); sep.className = 'wp-pick-sep'; m.append(sep); } if (logout) { const b = new Element('button'); b.className = 'wp-pick-item'; b.setAttribute('role', 'menuitem'); b.textContent = 'Logout'; m.append(b); } flush(); }
  async function open() { const m = menu(); const b = m.querySelector('[data-wp-feedback]'); assert.ok(b); await b.fire('click'); await tick(); return document.querySelector('dialog'); }
  return { document, window, location, replacements, reads, alerts, scrolls, ready, menu, redraw, open, tick, flush, Element, get deliveries() { return deliveries; } };
}

const browserItem = () => ({ id: 'item1', no: 1, type: 'bug', title: '<img onerror=bad>', body: '描述', author: { name: '甲' }, status: 'open',
  createdAt: '2026-11-11T12:00:00Z', updatedAt: '2026-11-11T12:00:00Z', approval: { state: 'none' }, files: [], comments: [] });

test('menu insertion survives complete redraws, follows overlay language and settles', async () => {
  const b = browser({ storedLanguage: 'en-US' }); await b.ready();
  const avatar = new b.Element('button'); avatar.className = 'wp-user'; b.document.body.append(avatar);
  const menu = b.menu();
  for (let n = 0; n < 4; n++) {
    const buttons = menu.querySelectorAll('[data-wp-feedback]'); assert.equal(buttons.length, 1);
    assert.equal(buttons[0].textContent, n ? '反馈' : 'Feedback');
    assert.equal(menu.children.at(-1).textContent, 'Logout'); assert.equal(menu.children.at(-2), buttons[0]);
    assert.equal(menu.children.at(-3).className, 'wp-pick-sep');
    assert.ok(Number.parseFloat(menu.style.top) >= 8); assert.ok(Number.parseFloat(menu.style.top) + menu.offsetHeight <= 632);
    b.window.wpSettings = { get: () => ({ language: 'zh-CN' }) }; b.redraw(menu);
  }
  assert.ok(b.deliveries < 20);
  b.redraw(menu, false); assert.equal(menu.children.at(-1).textContent, '反馈');
  await menu.querySelector('[data-wp-feedback]').fire('click'); await b.tick();
  assert.equal(b.document.querySelector('.wp-pick-menu'), null); assert.equal(avatar.getAttribute('aria-expanded'), 'false');
  assert.equal(b.document.querySelector('dialog').open, true); assert.equal(b.location.href, origin + '/');
});

test('deep links are consumed synchronously, preserve other parameters/routes and open after DOM ready', async () => {
  for (const [suffix, clean, detail, opens] of [
    ['?keep=2&wp-feedback=item1', '?keep=2', 'item1', true], ['?wp-feedback=1#item1', '', 'item1', true],
    ['?wp-feedback=1#1', '', '1', true], ['?wp-feedback=1#/market', '#/market', false, true], ['?keep=2&wp-feedback=item1#/market', '?keep=2#/market', 'item1', true],
    ['?wp-feedback=bad%2Fid#bad!', '#bad!', false, false], ['?wp-feedback=1#bad!', '', false, true],
    ['?keep=2#/market', '?keep=2#/market', false, false],
  ]) {
    const b = browser({ href: origin + '/' + suffix, request: async url => url.includes('/items/') ? { item: browserItem(), canUpload: true } : { items: [], isHandler: false } });
    assert.equal(b.location.href, origin + '/' + clean); assert.equal(b.reads.length, 0, 'head execution performs no DOM or API work');
    await b.ready(); assert.equal(Boolean(b.document.querySelector('dialog')?.open), opens);
    assert.equal(b.reads.some(r => r.url === base + '/items/' + detail), Boolean(detail));
  }
});

test('detail screenshot retry retains remaining files and does not re-upload saved files', async () => {
  const item = browserItem(), uploaded = [];
  const b = browser({ href: origin + '/?wp-feedback=item1', request: async (url, options) => {
    if (options.method === 'POST') {
      if (options.body.name === 'bad.png') return { status: 400, error: '无效图片' };
      uploaded.push(options.body.name); item.files.push({ id: 'file' + uploaded.length, name: options.body.name });
      return { item: structuredClone(item) };
    }
    return url.includes('/items/') ? { item: structuredClone(item), canUpload: true } : { items: [], isHandler: false };
  } });
  await b.ready();
  const detail = b.document.querySelector('#wp-feedback-detail'), input = detail.querySelector('input'); assert.ok(input);
  input.files = ['first.png', 'bad.png', 'third.png'].map(name => ({ name, type: 'image/png', size: 12 })); await input.fire('change');
  const upload = detail.querySelectorAll('button').find(e => e.textContent === '上传截图'); assert.ok(upload); await upload.fire('click'); await b.tick();
  assert.deepEqual(uploaded, ['first.png']); assert.equal(detail.querySelectorAll('img').length, 3);
  const bad = detail.querySelectorAll('img').find(img => img.alt === 'bad.png'); await bad.parentNode.querySelector('button').fire('click');
  await upload.fire('click'); await b.tick(); assert.deepEqual(uploaded, ['first.png', 'third.png']);
});

test('list access revoked closes dialog and permanently removes the menu entry', async () => {
  for (const status of [401, 404]) {
    const b = browser({ request: async () => ({ status }) }); await b.ready(); await b.open();
    assert.equal(b.document.querySelector('dialog').open, false); assert.equal(b.alerts.length, 1);
    const menu = b.menu(); assert.equal(menu.querySelector('[data-wp-feedback]'), null);
  }
});

const buttonWith = (root, text) => { const button = root.querySelectorAll('button').find(n => n.textContent === text); assert.ok(button, 'button: ' + text); return button; };
const screenshot = name => ({ name, type: 'image/png', size: 12 });
function pasteFiles(files) { return { clipboardData: { items: files.map(file => ({ kind: 'file', getAsFile: () => file })) } }; }

test('draft controls survive localization/reopen and partial upload retries create only one feedback item', async () => {
  const item = browserItem(), uploads = []; let creates = 0;
  const b = browser({ request: async (url, options) => {
    if (options.method === 'POST') {
      if (url === base) { creates++; assert.deepEqual(JSON.parse(options.body), { type: 'feature', title: 'My title', body: 'My description' }); return { item: structuredClone(item) }; }
      if (options.body.name === 'bad.png') return { status: 400, error: 'bad screenshot' };
      uploads.push(options.body.name); item.files.push({ id: 'file' + uploads.length, name: options.body.name }); return { item: structuredClone(item) };
    }
    return url.includes('/items/') ? { item: structuredClone(item), canUpload: true } : { items: [item], isHandler: false };
  } });
  await b.ready(); const dialog = await b.open(), form = dialog.querySelector('form');
  const type = form.querySelector('select'); assert.ok(type, 'type select remains mounted after translation'); type.value = 'feature';
  form.querySelector('#wp-feedback-title').value = 'My title'; form.querySelector('#wp-feedback-body').value = 'My description';
  await form.fire('paste', pasteFiles([screenshot('first.png'), screenshot('bad.png'), screenshot('third.png')]));
  await form.fire('submit'); await b.tick();
  assert.equal(creates, 1); assert.deepEqual(uploads, ['first.png']);
  assert.equal(form.querySelector('#wp-feedback-body').value, 'My description'); assert.equal(form.querySelector('fieldset').disabled, true);
  const bad = form.querySelectorAll('img').find(img => img.alt === 'bad.png'); assert.ok(bad); await bad.parentNode.querySelector('button').fire('click');
  dialog.close(); b.window.wpSettings = { get: () => ({ language: 'en-US' }) }; await b.open();
  assert.equal(form.querySelector('select').value, 'feature'); assert.match(form.textContent, /Screenshots/); assert.doesNotMatch(form.textContent, /截图（/);
  await form.fire('submit'); await b.tick();
  assert.equal(creates, 1); assert.deepEqual(uploads, ['first.png', 'third.png']);
  assert.equal(form.querySelector('#wp-feedback-body').value, ''); assert.equal(form.querySelector('fieldset').disabled, false);
  assert.equal(b.location.href, origin + '/');
  for (const read of b.reads) assert.equal(read.options.credentials, 'same-origin');
});

test('file validation reports format, size and count limits; failed create retains editable input', async () => {
  const b = browser({ request: async (url, options) => options.method === 'POST' ? { status: 503, error: 'offline' } : { items: [], isHandler: false } });
  await b.ready(); const dialog = await b.open(), form = dialog.querySelector('form');
  const input = form.querySelector('input[type=file]');
  for (const [files, text] of [
    [[{ name: 'x.gif', type: 'image/gif', size: 12 }], /PNG、JPEG 或 WebP/],
    [[{ ...screenshot('big.png'), size: 41 }], /0\.1 KB/],
    [[1, 2, 3, 4].map(n => screenshot(n + '.png')), /最多上传 3 张/],
  ]) { input.files = files; await input.fire('change'); assert.match(form.textContent, text); }
  assert.equal(form.querySelectorAll('img').length, 3);
  const title = form.querySelector('#wp-feedback-title'), body = form.querySelector('#wp-feedback-body'); title.value = 'untouched'; body.value = 'still here';
  await form.fire('submit'); await b.tick();
  assert.match(form.textContent, /offline/); assert.equal(title.value, 'untouched'); assert.equal(body.value, 'still here');
  assert.equal(form.querySelector('fieldset').disabled, false); assert.equal(form.querySelectorAll('img').length, 3);
});

test('handler scope, literal API text, comment errors and refresh preserve drafts without changing routing', async () => {
  const item = browserItem(); item.approval = { state: 'pending', note: '<script>text</script>' }; item.pr = 'https://example.test/pr/1';
  let failComment = true;
  const b = browser({ href: origin + '/#/market', request: async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, base + '/items/item1/comments');
      if (failComment) return { status: 503, error: 'comment failed' };
      item.comments.push({ text: JSON.parse(options.body).text, by: { name: 'User' }, at: item.createdAt }); item.status = 'in_progress';
      return { item: structuredClone(item) };
    }
    return url.includes('/items/') ? { item: structuredClone(item), canUpload: true } : { items: [item], isHandler: true };
  } });
  await b.ready(); const dialog = await b.open(); await buttonWith(dialog, '全部反馈').fire('click'); await b.tick();
  assert.equal(b.reads.at(-1).url, base + '?scope=all');
  await dialog.querySelector('.wp-feedback-entry').fire('click'); await b.tick();
  const detail = dialog.querySelector('#wp-feedback-detail'); assert.match(detail.textContent, /<img onerror=bad>/); assert.equal(detail.querySelector('img'), null);
  assert.match(detail.textContent, /<script>text<\/script>/); assert.equal(detail.querySelector('script'), null); assert.equal(detail.querySelector('a').href, item.pr);
  let form = detail.querySelector('form'), area = form.querySelector('textarea'); area.value = 'draft comment'; await area.fire('input');
  await form.fire('submit'); assert.match(form.textContent, /comment failed/); assert.equal(area.value, 'draft comment');
  await buttonWith(dialog, '刷新').fire('click'); await b.tick();
  form = detail.querySelector('form'); area = form.querySelector('textarea'); assert.equal(area.value, 'draft comment');
  failComment = false; await form.fire('submit'); await b.tick();
  assert.equal(detail.querySelector('textarea').value, ''); assert.match(detail.textContent, /处理中/); assert.match(detail.textContent, /draft comment/);
  assert.equal(b.location.hash, '#/market');
  await dialog.fire('click', { clientX: 0, clientY: 0 }); assert.equal(dialog.open, false);
});

test('a detail refresh started before a write cannot replace the busy editor or lose its draft', async () => {
  for (const action of ['comment', 'upload']) {
    let releaseGet, releasePost, detailReads = 0;
    const item = browserItem();
    const b = browser({ href: origin + '/?wp-feedback=item1', request: async (url, options) => {
      if (options.method === 'POST') return new Promise(resolve => { releasePost = () => resolve({ status: 503, error: 'write failed' }); });
      if (url.includes('/items/')) { if (++detailReads === 2) await new Promise(resolve => { releaseGet = resolve; }); return { item: structuredClone(item), canUpload: true }; }
      return { items: [item], isHandler: false };
    } });
    await b.ready();
    const dialog = b.document.querySelector('dialog'), detail = dialog.querySelector('#wp-feedback-detail'), form = detail.querySelector('form');
    const area = form.querySelector('textarea'); area.value = 'keep this comment'; await area.fire('input');
    if (action === 'upload') await detail.fire('paste', pasteFiles([screenshot('pending.png')]));
    const refreshing = buttonWith(dialog, '刷新').fire('click'); await b.tick(); assert.ok(releaseGet);
    const writing = action === 'comment' ? form.fire('submit') : buttonWith(detail, '上传截图').fire('click');
    await b.tick(); assert.ok(releasePost);
    // Repeated attempts while the first write is in flight must not send another POST.
    if (action === 'comment') await form.fire('submit'); else await buttonWith(detail, '上传截图').fire('click');
    assert.equal(b.reads.filter(r => r.options.method === 'POST').length, 1);
    releaseGet(); await refreshing; await b.tick();
    assert.equal(detail.querySelector('textarea'), area, 'late read must not replace the busy editor');
    releasePost(); await writing; await b.tick();
    assert.equal(area.value, 'keep this comment'); assert.match(detail.textContent, /write failed/);
    if (action === 'upload') assert.equal(detail.querySelectorAll('img').length, 1);
  }
});

test('English UI localizes server validation/quota/storage errors', async () => {
  for (const [status, error, expected] of [[400, '描述不能为空，且不能超过 8000 字。', /input|text/i],
    [429, '每天最多提交 30 条反馈，请明天再试。', /tomorrow/i], [503, '暂时无法保存反馈，请刷新核实后重试。', /save|saved/i]]) {
    const b = browser({ language: 'en-US', request: async (url, options) => options.method === 'POST' ? { status, error } : { items: [], isHandler: false } });
    await b.ready(); const dialog = await b.open(), form = dialog.querySelector('form');
    await form.fire('submit'); await b.tick();
    assert.match(form.textContent, expected); assert.ok(!form.textContent.includes(error));
  }
});

test('an overlay exception inside observer/event callbacks cannot escape into the main UI', async () => {
  const b = browser(); await b.ready(); await b.open();
  b.window.wpSettings = { get() { throw new Error('settings unavailable'); } };
  assert.doesNotThrow(() => b.menu()); await b.tick();
});

function assertDialogScrolledTo(b, target) {
  const dialog = b.document.querySelector('dialog');
  assert.ok(b.scrolls.length, 'must scroll after rendering the target');
  assert.ok(b.scrolls.every(s => s.element === dialog && s.kind !== 'intoView'), 'only the dialog may scroll');
  const gap = target.getBoundingClientRect().top - dialog.getBoundingClientRect().top;
  assert.ok(gap >= dialog.clientTop && gap <= 32, `target near dialog top: ${gap}`);
}

test('initial detail and successful submission scroll inside the dialog after the list renders', async () => {
  for (const initial of [true, false]) {
    const b = browser({ href: origin + (initial ? '/?wp-feedback=item1' : '/'), request: async url =>
      url.includes('/items/') ? { item: browserItem(), canUpload: true } : { item: browserItem(), items: [browserItem()], isHandler: false } });
    await b.ready(); const dialog = initial ? b.document.querySelector('dialog') : await b.open();
    if (!initial) await dialog.querySelector('form').fire('submit');
    await b.tick();
    assert.deepEqual(b.reads.slice(-2).map(r => r.url), [base, base + '/items/item1'], 'refresh list before positioning detail');
    assertDialogScrolledTo(b, dialog.querySelector('#wp-feedback-detail'));
  }
});

test('unavailable initial detail scrolls its error into the dialog viewport', async () => {
  for (const status of [404, 500]) {
    const b = browser({ href: origin + '/?wp-feedback=missing', request: async url =>
      url.includes('/items/') ? { status, error: 'Cannot open feedback' } : { items: [browserItem()], isHandler: false } });
    await b.ready();
    const msg = b.document.querySelectorAll('.wp-feedback-message').find(n => n.textContent === 'Cannot open feedback');
    assert.ok(msg); assertDialogScrolledTo(b, msg);
  }
});

test('back to list collapses details and list clicks still switch between items', async () => {
  for (const language of ['zh-CN', 'en-US']) {
    const second = { ...browserItem(), id: 'item2', no: 2, title: 'Second' };
    const b = browser({ language, href: origin + '/?wp-feedback=item1', request: async url => url.includes('/items/')
      ? { item: url.endsWith('item2') ? second : browserItem(), canUpload: true } : { items: [browserItem(), second], isHandler: false } });
    await b.ready(); const dialog = b.document.querySelector('dialog'), detail = dialog.querySelector('#wp-feedback-detail');
    await dialog.querySelectorAll('.wp-feedback-entry')[1].fire('click');
    assert.match(detail.textContent, /Second/); assertDialogScrolledTo(b, detail);
    await buttonWith(detail, language === 'en-US' ? 'Back to list' : '返回列表').fire('click');
    assert.equal(detail.hidden, true);
    const title = dialog.querySelectorAll('h3').find(n => n.textContent === (language === 'en-US' ? 'My feedback' : '我的反馈'));
    assertDialogScrolledTo(b, title);
    await dialog.querySelector('.wp-feedback-entry').fire('click');
    assert.equal(detail.hidden, false); assert.match(detail.textContent, /<img onerror=bad>/);
  }
});

test('menu reuses overlay separators across redraws and revocation removes only owned separators', async () => {
  for (const separator of [true, false]) for (const status of [401, 404]) {
    let denied = false;
    const b = browser({ request: async () => denied ? { status } : { items: [], isHandler: false } });
    await b.ready(); const dialog = await b.open(), menu = b.menu(true, separator);
    for (let n = 0; n < 4; n++) {
      assert.equal(menu.querySelectorAll('.wp-pick-sep').length, 1);
      assert.equal(menu.querySelectorAll('[data-wp-feedback-separator]').length, separator ? 0 : 1);
      assert.equal(menu.querySelectorAll('[data-wp-feedback]').length, 1);
      b.redraw(menu, true, separator);
    }
    const original = separator ? menu.querySelector('.wp-pick-sep') : null;
    denied = true; await buttonWith(dialog, '刷新').fire('click');
    assert.equal(menu.querySelector('[data-wp-feedback]'), null);
    assert.equal(menu.querySelectorAll('.wp-pick-sep').length, separator ? 1 : 0);
    if (original) assert.equal(original.parentNode, menu);
    b.redraw(menu, true, separator); assert.equal(menu.querySelector('[data-wp-feedback]'), null);
  }
});

test('size hints and validation use localized MB or KB while enforcing the byte limit', async () => {
  for (const language of ['zh-CN', 'en-US']) for (const [maxImageBytes, expected] of [
    [5242880, '5 MB'], [300000, '0.3 MB'], [1572864, '1.5 MB'], [102400, '100 KB'], [1536, '1.5 KB'],
  ]) {
    const b = browser({ language, maxImageBytes }); await b.ready(); const form = (await b.open()).querySelector('form');
    assert.ok(form.textContent.includes(expected)); assert.doesNotMatch(form.textContent, /字节|bytes|5\.0 MB/);
    const input = form.querySelector('input[type=file]');
    input.files = [{ ...screenshot('limit.png'), size: maxImageBytes }]; await input.fire('change');
    assert.equal(form.querySelectorAll('img').length, 1);
    input.files = [{ ...screenshot('too-big.png'), size: maxImageBytes + 1 }]; await input.fire('change');
    assert.ok(form.querySelector('.wp-feedback-message').textContent.includes(expected));
    assert.equal(form.querySelectorAll('img').length, 1);
  }
});

test('invalid API list and detail item ids never render actions or produce dependent requests', async () => {
  for (const id of ['..', 'bad/id', '']) {
    const invalid = { ...browserItem(), id, title: 'Invalid item', files: [{ id: 'file1', name: 'bad.png' }] };
    const b = browser({ href: origin + '/?wp-feedback=item1', request: async url => url.includes('/items/')
      ? { item: invalid, canUpload: true } : { items: [invalid, browserItem()], isHandler: false } });
    await b.ready(); const dialog = b.document.querySelector('dialog'), detail = dialog.querySelector('#wp-feedback-detail');
    assert.equal(dialog.querySelectorAll('.wp-feedback-entry').length, 1);
    assert.doesNotMatch(detail.textContent, /Invalid item/);
    assert.equal(detail.querySelectorAll('img, a, form, input').length, 0);
    assert.deepEqual(b.reads.map(r => r.url), [base, base + '/items/item1']);
    assert.equal(b.alerts.length, 0);
  }
});

test('invalid created or uploaded item ids never become upload or detail URLs', async () => {
  for (const id of ['..', 'bad/id', '']) for (const phase of ['create', 'upload']) {
    const b = browser({ request: async (url, options) => options.method === 'POST'
      ? { item: { ...browserItem(), id: phase === 'upload' && url === base ? 'item1' : id } }
      : { items: [], isHandler: false } });
    await b.ready(); const form = (await b.open()).querySelector('form');
    await form.fire('paste', pasteFiles([screenshot('one.png'), screenshot('two.png')]));
    await form.fire('submit'); await b.tick();
    const writes = b.reads.filter(r => r.options.method === 'POST');
    assert.deepEqual(writes.map(r => r.url), phase === 'create' ? [base] : [base, base + '/items/item1/files?filename=one.png']);
    assert.ok(b.reads.every(r => r.url === base || r.url === base + '/items/item1/files?filename=one.png'));
    assert.equal(b.document.querySelector('#wp-feedback-detail').querySelectorAll('img, a').length, 0);
  }
});

test('invalid file ids are omitted from screenshot links on detail load and after upload', async () => {
  const files = ['..', 'bad/id', '', 'safe_-1'].map(id => ({ id, name: id || 'empty' }));
  let uploaded = false;
  const b = browser({ href: origin + '/?wp-feedback=item1', request: async (url, options) => {
    if (options.method === 'POST') uploaded = true;
    return url.includes('/items/') ? { item: { ...browserItem(), files: uploaded ? files : files.slice(0, 2) }, canUpload: true } : { items: [], isHandler: false };
  } });
  await b.ready(); const detail = b.document.querySelector('#wp-feedback-detail');
  assert.equal(detail.querySelectorAll('img, a').length, 0);
  await detail.fire('paste', pasteFiles([screenshot('new.png')])); await buttonWith(detail, '上传截图').fire('click');
  assert.equal(detail.querySelectorAll('img').length, 1); assert.equal(detail.querySelectorAll('a').length, 1);
  assert.equal(detail.querySelector('img').src, base + '/items/item1/files/safe_-1');
  assert.equal(detail.querySelector('a').href, base + '/items/item1/files/safe_-1');
});

test('concrete feedback parameters preserve unrelated hashes', async () => {
  for (const id of ['item1', 'bad%2Fid', '']) {
    const b = browser({ href: origin + '/?wp-feedback=' + id + '#foo' });
    assert.equal(b.location.hash, '#foo'); assert.equal(b.location.search, '');
  }
});

test('consuming feedback parameters preserves the raw bytes of every other query segment', () => {
  for (const [query, expected] of [
    ['?a=%20b&wp-feedback=1&flag', '?a=%20b&flag'],
    ['?wp-feedback=item1&a=one+two&x=%2f&flag=&a=%7e', '?a=one+two&x=%2f&flag=&a=%7e'],
    ['?flag&wp%2Dfeedback=1&wp-feedback=item2&x=%26%3d', '?flag&x=%26%3d'],
    ['?x=1&&wp-feedback=1&', '?x=1&&'],
  ]) {
    const b = browser({ href: origin + '/' + query + '#/market' });
    assert.equal(b.location.search, expected); assert.equal(b.location.hash, '#/market'); assert.equal(b.reads.length, 0);
  }
});

test('handled screenshot paste stops propagation in draft and detail without intercepting keydown', async () => {
  const b = browser({ href: origin + '/?wp-feedback=item1', request: async url => url.includes('/items/')
    ? { item: browserItem(), canUpload: true } : { items: [], isHandler: false } });
  await b.ready(); const dialog = b.document.querySelector('dialog');
  for (const target of [dialog.querySelector('form'), dialog.querySelector('#wp-feedback-detail')]) {
    for (const files of [[], [screenshot('paste.png')]]) {
      let prevented = 0, stopped = 0;
      await target.fire('paste', { ...pasteFiles(files), preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
      assert.equal(prevented, files.length); assert.equal(stopped, files.length);
    }
  }
  assert.ok([dialog, ...dialog.querySelectorAll('*')].every(n => !n.listeners.keydown && !n.onkeydown));
});

test('menu positioning uses the expanded avatar and leaves styles intact for zero-size anchors', async () => {
  for (const size of [[0, 40], [220, 0], [220, 40]]) {
    const b = browser(); await b.ready();
    const first = new b.Element('button'); first.className = 'wp-user'; b.document.body.append(first);
    const active = new b.Element('button'); active.className = 'wp-user'; active.setAttribute('aria-expanded', 'true');
    active.rect = { top: 400, bottom: 440, left: 90, right: 310, width: size[0], height: size[1] }; b.document.body.append(active);
    const menu = b.menu();
    if (!size[0] || !size[1]) {
      assert.deepEqual(menu.style, {});
      Object.assign(menu.style, { top: '37px', left: '21px', maxHeight: '123px', overflowY: 'scroll' });
      b.redraw(menu);
      assert.deepEqual(menu.style, { top: '37px', left: '21px', maxHeight: '123px', overflowY: 'scroll' });
    }
    else { assert.equal(menu.style.left, '90px'); assert.equal(menu.style.top, '292px'); }
  }
});

test('localized image picker triggers the focusable labelled file input and mirrors its disabled state', async () => {
  for (const language of ['zh-CN', 'en-US']) {
    const b = browser({ language, href: origin + '/?wp-feedback=item1', request: async url => url.includes('/items/')
      ? { item: browserItem(), canUpload: true } : { items: [], isHandler: false } });
    await b.ready(); const dialog = b.document.querySelector('dialog');
    for (const root of [dialog.querySelector('form'), dialog.querySelector('#wp-feedback-detail')]) {
      const picker = buttonWith(root, language === 'en-US' ? 'Choose images' : '选择图片'), input = root.querySelector('input[type=file]');
      assert.equal(picker.type, 'button'); assert.equal(Boolean(input.hidden), false); assert.notEqual(input.tabIndex, -1);
      assert.equal(input.parentNode.tag, 'label'); assert.equal(picker.disabled, false);
      await picker.fire('click'); assert.equal(input.clicks, 1);
      input.files = [1, 2, 3].map(n => screenshot(n + '.png')); await input.fire('change');
      assert.equal(input.disabled, true); assert.equal(picker.disabled, true);
      await buttonWith(root, language === 'en-US' ? 'Remove' : '删除').fire('click');
      assert.equal(input.disabled, false); assert.equal(picker.disabled, false);
    }
  }
});

test('back to list invalidates an outstanding detail read without losing drafts', async () => {
  let release, reads = 0;
  const b = browser({ href: origin + '/?wp-feedback=item1', request: async url => {
    if (!url.includes('/items/')) return { items: [browserItem()], isHandler: false };
    if (++reads === 2) await new Promise(resolve => { release = resolve; });
    return { item: browserItem(), canUpload: true };
  } });
  await b.ready(); const dialog = b.document.querySelector('dialog'), detail = dialog.querySelector('#wp-feedback-detail');
  const area = detail.querySelector('textarea'); area.value = 'Keep draft'; await area.fire('input');
  const refreshing = buttonWith(dialog, '刷新').fire('click'); await b.tick(); assert.ok(release);
  await buttonWith(detail, '返回列表').fire('click');
  const scrollCount = b.scrolls.length; release(); await refreshing;
  assert.equal(detail.hidden, true); assert.equal(b.scrolls.length, scrollCount);
  await dialog.querySelector('.wp-feedback-entry').fire('click');
  assert.equal(detail.hidden, false); assert.equal(detail.querySelector('textarea').value, 'Keep draft');
});

test('back to list during post-comment refresh stays collapsed when the response arrives', async () => {
  let releaseList, listReads = 0;
  const b = browser({ href: origin + '/?wp-feedback=item1', request: async (url, options) => {
    if (options.method === 'POST' || url.includes('/items/')) return { item: browserItem(), canUpload: true };
    if (++listReads === 2) await new Promise(resolve => { releaseList = resolve; });
    return { items: [browserItem()], isHandler: false };
  } });
  await b.ready(); const detail = b.document.querySelector('#wp-feedback-detail');
  detail.querySelector('textarea').value = 'Comment';
  const submitting = detail.querySelector('form').fire('submit'); await b.tick(); assert.ok(releaseList);
  await buttonWith(detail, '返回列表').fire('click'); assert.equal(detail.hidden, true);
  const detailReads = b.reads.filter(r => r.url === base + '/items/item1').length;
  releaseList(); await submitting; await b.tick();
  assert.equal(detail.hidden, true);
  assert.equal(b.reads.filter(r => r.url === base + '/items/item1').length, detailReads);
});

test('back to list during dialog reopen wins over its pending list refresh', async () => {
  let releaseList, listReads = 0;
  const b = browser({ href: origin + '/?wp-feedback=item1', request: async url => {
    if (url.includes('/items/')) return { item: browserItem(), canUpload: true };
    if (++listReads === 2) await new Promise(resolve => { releaseList = resolve; });
    return { items: [browserItem()], isHandler: false };
  } });
  await b.ready(); const dialog = b.document.querySelector('dialog'), detail = dialog.querySelector('#wp-feedback-detail');
  dialog.close(); const reopening = b.open(); await b.tick(); assert.ok(releaseList);
  await buttonWith(detail, '返回列表').fire('click');
  releaseList(); await reopening;
  assert.equal(detail.hidden, true);
  assert.equal(b.reads.filter(r => r.url === base + '/items/item1').length, 1);
});
