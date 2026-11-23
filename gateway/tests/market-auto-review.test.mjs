import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createSharedSkillStore, createSharedSkillsHandler, inspectSkill } from '../market-shared.mjs';
import { marketNotifications } from '../market-notifications.mjs';

const author = { unionId: 'author', slug: 'author', name: '作者', backend: 'aionui' };
const reviewer = { unionId: 'reviewer', slug: 'reviewer', name: '审批人', backend: 'aionui' };
const meta = semver => ({ displayName: '测试技能', description: '测试', example: '测试', ...(semver === undefined ? {} : { semver }) });
const bundle = (text = '# skill') => ({ name: 'test-skill', description: '测试', files: [{ path: 'SKILL.md', content: Buffer.from(text).toString('base64') }] });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-auto-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSharedSkillStore({ stateDir: path.join(root, 'state'), sharedDir: path.join(root, 'shared'), approvers: ['reviewer'], ...options });
  return store;
}

test('first submission remains pending and reports manual reason', async t => {
  const store = fixture(t); const result = await store.submit(author, bundle(), meta('1.0.0'));
  assert.equal(result.status, 'pending');
  assert.match(result.version, /^[0-9a-f-]{36}$/);
  assert.equal(result.manualReasons[0].rule, 'first-submission');
  assert.equal(result.autoPublished, false);
});

test('clean increasing update auto publishes and includes semver summary', async t => {
  const store = fixture(t); const first = await store.submit(author, bundle(), meta('1.0.0')); await store.review(reviewer, first.name, first.version, 'approve');
  const next = await store.submit(author, bundle('# next'), meta('1.0.1'));
  assert.equal(next.status, 'approved'); assert.equal(next.autoPublished, true); assert.equal(store.list(author).company[0].semver, '1.0.1');
});

test('hard blocks expose only structured locations', () => {
  assert.throws(() => inspectSkill(bundle('rm -rf /')), error => error.status === 400 && error.findings[0].line === 1 && !error.message.includes('rm -rf /'));
});

test('trusted domains suppress links and superseded versions leave pending', async t => {
  const store = fixture(t, { trustedDomains: ['example.org'] }); const first = await store.submit(author, bundle(), meta('1.0.0')); await store.review(reviewer, first.name, first.version, 'approve');
  const pending = await store.submit(author, bundle('https://evil.example'), meta('1.1.0')); assert.equal(pending.status, 'pending');
  const next = await store.submit(author, bundle('# clean'), meta('1.2.0')); assert.equal(next.status, 'approved');
  assert.equal(store.list(reviewer).pending.length, 0); assert.equal(store.list(reviewer).reviewed.some(v => v.semver === '1.1.0' && v.status === 'superseded'), true);
});

test('updates without semver stay pending, while documentation-only updates auto publish', async t => {
  const store = fixture(t);
  const first = await store.submit(author, bundle('# first'), meta('1.0.0'));
  await store.review(reviewer, first.name, first.version, 'approve');
  const legacy = await store.submit(author, bundle('# legacy update'), meta());
  assert.equal(legacy.status, 'pending');
  assert.ok(legacy.manualReasons.some(reason => reason.rule === 'no-semver'));
  const clean = await store.submit(author, bundle('# documentation update'), meta('1.0.1'));
  assert.equal(clean.status, 'approved');
  assert.equal(clean.autoPublished, true);
});

test('script additions and changes require manual review', async t => {
  const store = fixture(t);
  const scriptBundle = (skill, script) => ({
    name: 'test-skill',
    description: '测试',
    files: [
      { path: 'SKILL.md', content: Buffer.from(skill).toString('base64') },
      { path: 'scripts/check.sh', content: Buffer.from(script).toString('base64') },
    ],
  });
  const first = await store.submit(author, scriptBundle('# first', 'echo 1'), meta('1.0.0'));
  await store.review(reviewer, first.name, first.version, 'approve');
  const changed = await store.submit(author, scriptBundle('# first', 'echo 2'), meta('1.0.1'));
  assert.equal(changed.status, 'pending');
  assert.deepEqual(changed.manualReasons.find(reason => reason.rule === 'scripts-changed'), {
    rule: 'scripts-changed', label: '脚本有改动，需要人工审核',
  });
});

test('semver boundaries and rejected version reuse are enforced', async t => {
  const store = fixture(t);
  const invalid = ['1.0', 'v1.0.1', '01.0.0', '1.0.0-beta'];
  for (const value of invalid) {
    await assert.rejects(store.submit(author, bundle(value), meta(value)), error => error.status === 400 && /版本号格式/.test(error.message));
  }
  const first = await store.submit(author, bundle('# one'), meta('1.0.0'));
  await assert.rejects(store.submit(author, bundle('# equal'), meta('1.0.0')), /版本号需大于/);
  await store.review(reviewer, first.name, first.version, 'reject', '请修改');
  const reused = await store.submit(author, bundle('# retry'), meta('1.0.0'));
  assert.equal(reused.status, 'pending');
  await assert.rejects(store.submit(author, bundle('# lower'), meta('0.9.0')), /版本号需大于/);
});

test('long lines and huge repeated commands finish scanning quickly', () => {
  const started = performance.now();
  for (const command of ['rm '.repeat(2500000), 'dd '.repeat(2500000), 'curl '.repeat(1500000)]) {
    const content = Buffer.from(command).toString('base64');
    const result = inspectSkill({
      name: 'large-scan',
      description: '扫描',
      files: [{ path: 'SKILL.md', content }],
    });
    assert.ok(result.findings.some(finding => finding.rule === 'long-line'));
  }
  assert.ok(performance.now() - started < 1000, 'large single-line scans should be bounded');
});

test('version ids are own properties and prototype names cannot be used', async t => {
  const store = fixture(t);
  const draft = await store.submit(author, bundle(), meta('1.0.0'));
  assert.equal({}.polluted, undefined);
  for (const id of ['__proto__', 'constructor']) {
    await assert.rejects(store.review(reviewer, draft.name, id, 'approve'), error => [400, 404].includes(error.status));
    assert.equal({}.polluted, undefined);
    assert.equal({}.constructor, Object);
  }
  assert.throws(() => store.source(reviewer, draft.name, '__proto__'), error => error.status === 404);
});

function fakeRequest(method, headers, body, requestUrl = '/_wp/market/shared') {
  const request = Readable.from([Buffer.from(body || '')]);
  request.method = method;
  request.headers = headers;
  return { request, url: new URL(`https://partner.example${requestUrl}`) };
}

async function invoke(handler, method, headers, body, requestUrl) {
  const { request, url } = fakeRequest(method, headers, body, requestUrl);
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(value = '') { this.body = value; },
  };
  await handler(request, response, url);
  return response;
}

test('review page retains approve, reject and resend controls; body cap and cookie Origin remain enforced', async t => {
  const notices = [];
  const store = fixture(t, { notify: async payload => notices.push(payload) });
  const draft = await store.submit(author, bundle(), meta('1.0.0'));
  const handler = createSharedSkillsHandler({
    store,
    origin: 'https://partner.example',
    authenticate: req => req.headers.cookie === 'reviewer' ? reviewer : author,
    tokenAuthenticate: () => null,
    execute: async () => ({}),
  });
  const page = await invoke(handler, 'GET', { cookie: 'reviewer' }, '', `/_wp/market/shared/review?name=${draft.name}&version=${draft.version}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /批准/);
  assert.match(page.body, /重发审批卡片/);
  assert.match(page.body, /onsubmit/);
  const foreign = await invoke(handler, 'POST', { cookie: 'author', origin: 'https://evil.example', 'content-type': 'application/json' }, JSON.stringify({ action: 'approve', name: draft.name, version: draft.version }));
  assert.equal(foreign.status, 403);
  const oversized = await invoke(handler, 'POST', { cookie: 'author', origin: 'https://partner.example', 'content-type': 'application/json' }, 'x'.repeat(16385));
  assert.equal(oversized.status, 413);
  assert.equal(notices.length, 1);
});

test('signed review links approve once and invalid extra segments fall back to manual page', async t => {
  let issued;
  const store = fixture(t, {
    notify: async payload => { issued = payload.reviewToken; },
    createReviewToken: (_name, _id, _action, noticeId) => `good.${noticeId}`,
    verifyReviewToken: (token, name, id, action, noticeId) => token === issued
      ? { name, id, action, noticeId } : null,
  });
  const draft = await store.submit(author, bundle(), meta('1.0.0'));
  const handler = createSharedSkillsHandler({
    store,
    origin: 'https://partner.example',
    authenticate: req => req.headers.cookie === 'reviewer' ? reviewer : null,
    tokenAuthenticate: () => null,
    execute: async () => ({}),
  });
  const invalid = await invoke(handler, 'GET', { cookie: 'reviewer' }, '', `/_wp/market/shared/review?name=${draft.name}&version=${draft.version}&action=approve&t=${issued}.xxx`);
  assert.equal(invalid.status, 200);
  assert.match(invalid.body, /链接已失效/);
  assert.equal(store.list(reviewer).pending.length, 1);
  const approved = await invoke(handler, 'GET', { cookie: 'reviewer' }, '', `/_wp/market/shared/review?name=${draft.name}&version=${draft.version}&action=approve&t=${issued}`);
  assert.equal(approved.status, 200);
  assert.match(approved.body, /已批准并发布/);
  const repeated = await invoke(handler, 'GET', { cookie: 'reviewer' }, '', `/_wp/market/shared/review?name=${draft.name}&version=${draft.version}&action=approve&t=${issued}`);
  assert.match(repeated.body, /已处理/);
});


test('author notifications cover automatic, manual, approved and rejected outcomes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = path.join(root, 'secret');
  fs.writeFileSync(secret, 'secret');
  const sent = [];
  const notifier = marketNotifications({
    identity: { appId: 'app', appSecretFile: secret },
    server: { publicOrigin: 'https://partner.example' },
  }, async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes('/auth/')) return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'token' }) };
    sent.push(body);
    return { ok: true, json: async () => ({ code: 0 }) };
  });
  const rows = [
    { autoPublished: true, status: 'approved', semver: '1.0.1' },
    { status: 'pending', semver: '1.0.2', manualReasons: [{ rule: 'no-semver', label: '未填写版本号' }, { file: 'SKILL.md', line: 3, label: '外部链接 example.com' }] },
    { status: 'approved', semver: '1.0.3' },
    { status: 'rejected', semver: undefined, reason: '需要补充说明' },
  ];
  for (const row of rows) await notifier.notifyAuthor({ ...row, displayName: '测试技能', unionId: 'author' });
  const messages = sent.map(item => JSON.parse(item.content).text);
  assert.match(messages[0], /自动审核通过并发布/);
  assert.match(messages[1], /未通过自动审核/);
  assert.match(messages[1], /未填写版本号/);
  assert.match(messages[1], /SKILL\.md 第 3 行/);
  assert.match(messages[2], /已批准上架/);
  assert.match(messages[3], /未标注/);
  assert.match(messages[3], /需要补充说明/);
});


test('startup supersedes stale pending versions once and leaves newer pending versions alone', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { stateDir: path.join(root, 'state'), sharedDir: path.join(root, 'shared'), approvers: ['reviewer'] };
  const store = createSharedSkillStore(options);
  const first = await store.submit(author, bundle('# first'), meta('1.0.0'));
  await store.review(reviewer, first.name, first.version, 'approve');
  const stale = await store.submit(author, bundle('https://old.example/stale'), meta('1.1.0'));
  const newer = await store.submit(author, bundle('https://new.example/pending'), meta('1.2.0'));
  const catalogFile = path.join(root, 'state', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogFile));
  const live = catalog.skills['test-skill'].versions[first.version];
  catalog.skills['test-skill'].versions[stale.version].createdAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const restarted = createSharedSkillStore(options);
  const reviewed = restarted.list(reviewer).reviewed;
  assert.equal(reviewed.find(version => version.version === stale.version).status, 'superseded');
  assert.equal(reviewed.find(version => version.version === stale.version).supersededBy, live.id);
  assert.equal(restarted.list(reviewer).pending.some(version => version.version === newer.version), true);
  const before = fs.readFileSync(catalogFile, 'utf8');
  createSharedSkillStore(options);
  assert.equal(fs.readFileSync(catalogFile, 'utf8'), before);
});
