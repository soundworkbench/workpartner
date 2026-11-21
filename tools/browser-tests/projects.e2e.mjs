// Real overlay in <head>, strict native 2.1.47 filesystem contracts, and a native
// composer stand-in. No engine or image is needed for these regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG, until } from './lib/suite.mjs';
import { DESKTOP, PHONE } from './lib/browser.mjs';
import { ORIGIN } from './lib/harness.mjs';

const FILE = '/data/work/.workpartner-projects.json';
const project = { id: 'p_alpha', name: '客户资料', icon: 'folder', color: '#879b9b', order: 0, description: '项目说明', directory: 'project-p_alpha' };
const suite = createSuite('projects', async s => { s.main = await s.harness.startGateway('projects', { feedback: false }); });
function backend() {
  const old = Date.now() - 3 * 86400000;
  return {
    files: new Map([[FILE, JSON.stringify({ version: 1, projects: [project] })]]),
    dirs: new Set(['/data/work', '/data/work/project-p_alpha']), requests: [], failWrite: '', failCreate: false,
    conversations: [
      { id: 'old', name: '三天前的研究', updated_at: old, created_at: old, project_id: 'native-root', extra: { workspace: '/data/work', backend: 'codex' } },
      { id: 'native-pin', name: '原生置顶', updated_at: old, extra: { pinned: true, pinned_at: old } },
      { id: 'legacy-pin', name: '兼容旧置顶', updated_at: old, extra: { wp_pinned: true } },
      { id: 'member', name: '项目中的完整标题', preview_text: '很长的摘要 '.repeat(40), updated_at: old, extra: { wp_project_id: project.id } },
    ], messages: new Map([['old', old]]),
  };
}
async function fixture(page, db) {
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    if (!/^\/api\/(fs|projects|conversations)(\/|$)/.test(url.pathname)) return route.continue();
    const body = req.postData() && req.headers()['content-type']?.includes('application/json') ? req.postDataJSON() : {};
    db.requests.push({ path: url.pathname, method, body });
    const reply = (data, status = 200) => route.fulfill({ status, json: status < 400 ? { success: true, data } : { success: false, error: 'fixture failure' } });
    const base = path => path.slice(0, path.lastIndexOf('/'));
    if (url.pathname === '/api/fs/dir') {
      assert.equal(method, 'POST'); assert.equal(body.root, '/data/work');
      if (!db.dirs.has(body.dir)) return reply(null, 404);
      return reply([...db.dirs, ...db.files.keys()].filter(p => base(p) === body.dir).map(p => ({ name: p.slice(p.lastIndexOf('/') + 1), full_path: p, is_dir: db.dirs.has(p) })));
    }
    if (url.pathname === '/api/fs/read') { assert.equal(method, 'POST'); return reply(db.files.get(body.path) ?? null); }
    if (url.pathname === '/api/fs/write') {
      assert.equal(method, 'POST'); assert.equal(typeof body.data, 'string'); assert.deepEqual(Object.keys(body).sort(), ['data', 'path']);
      if (!db.dirs.has(base(body.path)) || db.failWrite && body.path.endsWith(db.failWrite)) return reply(null, 500);
      db.files.set(body.path, body.data); return reply(true);
    }
    if (url.pathname === '/api/fs/upload') {
      assert.equal(method, 'POST'); assert.match(req.headers()['content-type'], /multipart\/form-data/);
      return reply('/tmp/upload/图片_1234567890.png');
    }
    if (url.pathname === '/api/fs/copy') {
      assert.equal(body.target.pe_id, 'pe-root');
      db.files.set('/data/work/' + body.target.relative_path + '/图片_1234567890.png', 'binary');
      return reply({ copied_files: ['图片_1234567890.png'], failed_files: [] });
    }
    if (url.pathname.startsWith('/api/fs/')) return reply(null, 404);
    if (url.pathname.startsWith('/api/projects/')) return reply({ project_id: 'native-root', explorer: { workspace_pe_id: 'pe-root', entries: [] } });
    if (url.pathname === '/api/conversations') {
      if (method === 'GET') return reply({ items: db.conversations });
      if (db.failCreate || !db.dirs.has(body.extra.workspace)) return reply(null, 400);
      const c = { ...body, id: 'new-' + db.conversations.length, project_id: 'native-root', created_at: Date.now(), updated_at: Date.now() };
      db.conversations.push(c); return reply(c);
    }
    const id = url.pathname.split('/')[3], c = db.conversations.find(c => c.id === id);
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.get('limit'), '1');
      return reply({ items: db.messages.has(id) ? [{ created_at: db.messages.get(id) }] : [], has_more_before: false });
    }
    if (!c) return reply(null, 404);
    if (method === 'PATCH') {
      assert.equal(body.merge_extra, true);
      for (const [key, value] of Object.entries(body.extra)) { if (value === null) delete c.extra[key]; else c.extra[key] = value; }
      c.updated_at = Date.now(); return reply(c);
    }
    if (method === 'DELETE') { db.conversations = db.conversations.filter(x => x.id !== id); return reply(true); }
    return reply(c);
  });
  await page.routeWebSocket('**/ws', socket => socket.onMessage(raw => {
    const frame = JSON.parse(raw); assert.equal(frame.name, 'fs');
    if (frame.data.method === 'fs/rename') {
      const { from, to } = frame.data.params; assert.equal(from.pe_id, 'pe-root'); assert.equal(to.pe_id, 'pe-root');
      db.files.set('/data/work/' + to.relative_path, db.files.get('/data/work/' + from.relative_path)); db.files.delete('/data/work/' + from.relative_path);
      socket.send(JSON.stringify({ name: 'fs', data: { id: frame.data.id, result: {} } })); return;
    }
    assert.equal(frame.data.method, 'fs/mkdir');
    assert.equal(frame.data.params.dir.pe_id, 'pe-root');
    const relative = frame.data.params.dir.relative_path; assert.match(relative, /^project-[\w-]+$/);
    db.dirs.add('/data/work/' + relative); db.requests.push({ path: 'fs/mkdir' });
    socket.send(JSON.stringify({ name: 'fs', data: { id: frame.data.id, result: {} } }));
  }));
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.__cron = [];
      window.wpProjectCreateCronTask = c => window.__cron.push(c.id);
      const header = document.createElement('header'); header.className = 'app-titlebar--mobile';
      header.innerHTML = '<div class="app-titlebar__menu"><button class="app-titlebar__button">drawer</button></div>';
      document.body.prepend(header);
      window.__drawerClosed = 0;
      const style = document.createElement('style');
      style.textContent = '@media(max-width:767px){aside.layout-sider{position:fixed;top:44px;bottom:0;left:0;z-index:100;transform:translateX(-100%)} html.fixture-project-drawer aside.layout-sider{transform:none}}';
      document.head.append(style); document.documentElement.classList.add('fixture-project-drawer');
      header.querySelector('button').onclick = () => { if (document.documentElement.classList.contains('fixture-project-drawer')) window.__drawerClosed++; document.documentElement.classList.toggle('fixture-project-drawer'); };
      const form = document.createElement('form'); form.id = 'project-native-composer';
      form.innerHTML = '<textarea data-testid="guid-input"></textarea><button data-testid="guid-send-btn">发送</button>';
      form.onsubmit = async e => {
        e.preventDefault(); const input = form.querySelector('textarea'); const name = input.value;
        const r = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type: 'acp', extra: {} }) });
        input.value = ''; // Model the native composer clearing even after an error.
        if (r.ok) { const c = (await r.json()).data; location.hash = '#/conversation/' + c.id; }
      };
      document.querySelector('main.layout-content').append(form);
    });
  });
  await page.goto(ORIGIN + '/#/guid');
  await page.waitForSelector('.wp-projects-root');
}
const menu = page => page.locator('.wp-project-menu');
async function chatMenu(page, id) {
  const row = page.locator(`.wp-projects-root [data-conversation="${id}"]`); await row.hover(); await row.locator('.wp-project-more').click();
}
async function projectMenu(page, id = project.id) {
  if (page.viewportSize().width < 768 && !await page.evaluate(() => document.documentElement.classList.contains('fixture-project-drawer'))) await page.locator('.app-titlebar__button').click();
  const row = page.locator(`[data-project="${id}"]`); await row.hover(); await row.locator(':scope > .wp-project-more').click();
}
async function home(page) { await projectMenu(page); await menu(page).getByText('打开项目主页', { exact: true }).click(); await page.waitForSelector('.wp-project-home'); }
async function create(page, name) { await page.locator('.wp-project-dialog input[name=name]').fill(name); await page.locator('.wp-project-dialog textarea').fill('遵守项目说明'); await page.locator('.wp-project-dialog button[type=submit]').click(); }

test('head bootstrap, native pin fields, real manifest and fresh browser', LONG, async () => {
  const db = backend();
  for (let i = 0; i < 2; i++) await suite.session('head-' + i, { route: null, storage: { 'wp-projects-cache': '{"projects":[{"id":"stale","name":"缓存幽灵"}]}' } }, async ({ page, log }) => {
    await fixture(page, db);
    assert.equal(await page.locator('head script[src*="wp-overlay.js"]').count(), 1);
    assert.equal(await page.evaluate(() => typeof window.wpSlashSkills.commands), 'function');
    assert.ok(!log.requests.some(r => /\/api\/(files|workspace\/files?)/.test(r)));
    assert.equal(await page.locator('.wp-project-name').textContent(), project.name);
    assert.equal(await page.locator('.wp-project-time-title').first().textContent(), '置顶');
    await chatMenu(page, 'native-pin'); await menu(page).getByText('取消置顶', { exact: true }).click();
    await until(() => db.conversations.find(c => c.id === 'native-pin').extra.pinned === false, 'native unpin');
    await chatMenu(page, 'native-pin'); await menu(page).getByText('置顶', { exact: true }).click();
    await until(() => db.conversations.find(c => c.id === 'native-pin').extra.pinned === true, 'native pin');
    assert.equal(typeof db.conversations.find(c => c.id === 'native-pin').extra.pinned_at, 'number');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('create-and-move persists mkdir, both instructions and manifest before showing project', LONG, async () => {
  const db = backend();
  await suite.session('create-move', { route: null }, async ({ page, log }) => {
    await fixture(page, db); await chatMenu(page, 'old'); await menu(page).getByText('移到项目', { exact: true }).click(); await menu(page).getByText('新建项目', { exact: true }).click();
    db.failWrite = 'AGENTS.md'; await create(page, '新研究'); await page.waitForSelector('.wp-project-toast');
    assert.equal(await page.locator('.wp-project-row').count(), 1);
    assert.equal(db.conversations[0].extra.wp_project_id, undefined);
    assert.equal(JSON.parse(db.files.get(FILE)).projects.length, 1);
    db.failWrite = ''; await page.locator('.wp-project-dialog button[type=submit]').click();
    await until(() => Boolean(db.conversations[0].extra.wp_project_id), 'created then moved');
    const p = JSON.parse(db.files.get(FILE)).projects.find(p => p.name === '新研究');
    assert.equal(db.files.get('/data/work/' + p.directory + '/CLAUDE.md'), '遵守项目说明');
    assert.equal(db.files.get('/data/work/' + p.directory + '/AGENTS.md'), '遵守项目说明');
    assert.ok(db.requests.findIndex(r => r.path === 'fs/mkdir') < db.requests.findIndex(r => r.path === '/api/fs/write'));
    await page.locator(`[data-project="${p.id}"] .wp-project-toggle`).click(); await chatMenu(page, 'old'); await menu(page).getByText('移到项目', { exact: true }).click(); await menu(page).getByText('移出项目', { exact: true }).click();
    await until(() => !db.conversations[0].extra.wp_project_id, 'moved out');
    assert.equal(await page.locator('[data-conversation="old"]').evaluate(el => el.parentElement.previousElementSibling.textContent), '前 7 天');
    db.messages.set('old', Date.now()); db.conversations[0].updated_at = Date.now() + 1000;
    await page.evaluate(() => window.wpProjects.refresh());
    await page.waitForFunction(() => document.querySelector('[data-conversation="old"]').parentElement.previousElementSibling.textContent === '今天');
    assert.deepEqual(log.pageErrors, []);
  });
  await suite.session('fresh-after-create', { route: null }, async ({ page }) => {
    await fixture(page, db); assert.equal(await page.locator('.wp-project-row').count(), 2);
    assert.ok((await page.locator('.wp-project-name').allTextContents()).includes('新研究'));
  });
});

test('delete clears ownership even when manifest fails; successful deletion is undoable', LONG, async () => {
  const db = backend();
  await suite.session('delete', { route: null }, async ({ page, log }) => {
    await fixture(page, db); db.failWrite = '.workpartner-projects.json';
    await projectMenu(page); await menu(page).getByText('删除项目', { exact: true }).click(); await page.locator('[role=alertdialog]').getByText('删除项目', { exact: true }).click();
    await until(() => !db.conversations.find(c => c.id === 'member').extra.wp_project_id, 'ownership cleared');
    await page.waitForSelector('.wp-project-toast'); assert.equal(await page.locator('.wp-project-row').count(), 1);
    db.failWrite = ''; await projectMenu(page); await menu(page).getByText('删除项目', { exact: true }).click(); await page.locator('[role=alertdialog]').getByText('删除项目', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.wp-project-row'));
    await page.locator('.wp-project-toast button').click(); await page.waitForSelector('.wp-project-row');
    assert.equal(JSON.parse(db.files.get(FILE)).projects.length, 1);
    assert.deepEqual(log.alerts, []); assert.deepEqual(log.pageErrors, []);
  });
});

test('home titles, files, native archive and scheduled task actions, draft on failure', LONG, async () => {
  const db = backend();
  await suite.session('home', { route: null }, async ({ page, log }) => {
    await fixture(page, db);
    const count = page.locator('.wp-project-count'); await count.hover(); await count.click();
    await page.waitForFunction(() => document.querySelector('.wp-project-arrow')?.textContent === '⌄');
    assert.equal(await page.evaluate(() => window.wpProjects.newConversationExtra()), null);
    await home(page);
    const title = await page.locator('.wp-project-home .wp-project-conversation-link').boundingBox(); assert.ok(title.width > 140);
    assert.equal(await page.locator('.wp-project-file-list').textContent(), '还没有文件');
    await page.locator('.wp-project-upload').setInputFiles({ name: '客户说明.txt', mimeType: 'text/plain', buffer: Buffer.from('中文内容') });
    await until(() => db.files.has('/data/work/project-p_alpha/客户说明.txt'), 'Unicode file saved');
    assert.equal(db.files.get('/data/work/project-p_alpha/客户说明.txt'), '中文内容');
    await page.locator('.wp-project-upload').setInputFiles({ name: '图片.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
    await until(() => db.files.has('/data/work/project-p_alpha/图片.png'), 'binary file copied');
    await page.locator('.wp-project-home-input input').fill('保留这段输入'); db.failCreate = true;
    await page.locator('.wp-project-home-input button').click();
    await page.waitForFunction(() => document.querySelector('.wp-project-toast')?.textContent.includes('新建对话失败'));
    assert.equal(await page.locator('.wp-project-home-input input').inputValue(), '保留这段输入');
    db.failCreate = false; await page.locator('.wp-project-home-input button').click();
    await until(() => db.conversations.some(c => c.name === '保留这段输入' && c.extra.wp_project_id === project.id), 'project chat created');
    await chatMenu(page, 'old'); await menu(page).getByText('创建定时任务', { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__cron), ['old']);
    await chatMenu(page, 'old'); await menu(page).getByText('归档', { exact: true }).click();
    await until(() => db.conversations[0].extra.wp_archived === true, 'native archive');
    await page.waitForFunction(() => !document.querySelector('[data-conversation="old"]'));
    assert.deepEqual(log.pageErrors, []);
  });
});

for (const viewport of [PHONE, { width: 360, height: 800 }]) test(`touch menu and drawer navigation at ${viewport.width}`, LONG, async () => {
  await suite.session('mobile-' + viewport.width, { viewport, route: null }, async ({ page, log }) => {
    const db = backend(); await fixture(page, db);
    assert.equal(await page.locator('[data-conversation="old"] .wp-project-more').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.locator('[data-conversation="old"] .wp-project-conversation-link').click();
    await home(page); await page.locator('.app-titlebar__button').click(); await page.locator('[data-project="p_alpha"] > .wp-project-new').click();
    assert.ok(await page.evaluate(() => window.__drawerClosed >= 3));
    await page.locator('.app-titlebar__button').click(); await page.locator('.wp-project-add').click();
    const box = await page.locator('.wp-project-dialog').boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(log.pageErrors, []);
  });
});
