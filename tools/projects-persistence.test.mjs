import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const logic = fs.readFileSync(new URL('../image/rebrand/overlay/wp-projects-logic.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../image/rebrand/overlay/wp-projects.js', import.meta.url), 'utf8').replaceAll('__WP_WORKDIR__', '/data/work');
const FILE = '/data/work/.workpartner-projects.json';
function setup({ expose = true } = {}) {
  const listeners = {}, notices = [], requests = [], files = new Map(), dirs = new Set(['/data/work']);
  const c = { id: 'chat', project_id: 'native-root', updated_at: 1000, extra: { workspace: '/data/work', backend: 'codex' } };
  const db = { c, files, dirs, requests, empty: false, temporaryDeleted: false, failMkdir: false, failWrite: '', messageAt: 500, notices };
  const context = {
    Math, Date, Map, Set, TextEncoder, FormData, Blob, Promise, Response,
    location: { hash: '#/guid', protocol: 'https:', host: 'fixture.test' },
    localStorage: { getItem: () => '{"projects":[{"id":"ghost","name":"stale"}]}', setItem() {} },
    requestAnimationFrame() {}, setInterval() {}, clearInterval() {}, setTimeout, clearTimeout,
    document: { body: null, addEventListener(name, callback) { listeners[name] = callback; } },
    addEventListener() {}, wpUI: { isChinese: () => true },
    MutationObserver: class { observe(body) { assert.ok(body, 'observer must not see null body'); } disconnect() {} },
    WebSocket: class {
      constructor() { queueMicrotask(() => this.onopen()); }
      send(raw) {
        const { name, data } = JSON.parse(raw); assert.equal(name, 'fs'); assert.equal(data.method, 'fs/mkdir'); assert.equal(data.params.dir.pe_id, 'root-entry');
        if (db.failMkdir) { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ name: 'fs', data: { id: data.id, error: { message: 'permission denied' } } }) })); return; }
        dirs.add('/data/work/' + data.params.dir.relative_path); requests.push({ url: 'fs/mkdir' });
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ name: 'fs', data: { id: data.id, result: {} } }) }));
      }
      close() {}
    },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {}; requests.push({ url, body, method: init.method });
      let data, status = 200;
      if (url === '/api/fs/dir') {
        assert.equal(init.method, 'POST'); assert.equal(body.root, '/data/work');
        if (!dirs.has(body.dir)) status = 404;
        data = [...dirs, ...files.keys()].filter(p => p.slice(0, p.lastIndexOf('/')) === body.dir).map(p => ({ name: p.slice(p.lastIndexOf('/') + 1), is_dir: dirs.has(p), full_path: p }));
      } else if (url === '/api/fs/read') { data = files.get(body.path) ?? null; }
      else if (url === '/api/fs/write') {
        assert.deepEqual(Object.keys(body).sort(), ['data', 'path']); assert.equal(typeof body.data, 'string');
        if (!dirs.has(body.path.slice(0, body.path.lastIndexOf('/'))) || db.failWrite && body.path.endsWith(db.failWrite)) status = 500;
        else files.set(body.path, body.data);
        data = true;
      } else if (url === '/api/conversations?limit=10000') data = { items: db.empty ? [] : [c] };
      else if (url === '/api/conversations' && init.method === 'POST') { assert.equal(body.extra.workspace, '/data/work'); assert.equal(body.extra.is_health_check, true); data = { ...body, id: 'setup', project_id: 'native-root' }; }
      else if (url === '/api/conversations/setup' && init.method === 'DELETE') { db.temporaryDeleted = true; data = true; }
      else if (url === '/api/projects/native-root') data = { explorer: { workspace_pe_id: 'root-entry' } };
      else if (url === '/api/conversations/chat/messages?limit=1&content_mode=compact') data = { items: [{ created_at: db.messageAt }] };
      else if (url === '/api/conversations/chat' && init.method === 'PATCH') {
        assert.equal(body.merge_extra, true); c.extra = context.WpProjectsLogic.mergeExtra(c.extra, body.extra); c.updated_at += 10000; data = c;
      } else throw new Error('Unexpected API: ' + url);
      return new Response(JSON.stringify(status === 200 ? { success: true, data } : { success: false }), { status });
    },
  };
  context.window = context;
  vm.createContext(context); vm.runInContext(logic, context);
  const hooks = `window.__test = {state, loadProjects, persistProject, moveConversation, deleteProject, loadConversations, pinConversation, fileWrite};
    renderSoon = function () {}; toast = function (message, undo) { window.__notices.push({message, undo}); }; confirmProject = async function () { return true; };`;
  context.__notices = notices;
  vm.runInContext(expose ? script.replace('  function start() {', hooks + '\n  function start() {') : script, context);
  return { ...db, db, context, listeners, api: context.__test };
}

test('head loading completes synchronously; observer starts only after body readiness', async () => {
  const { context, listeners, requests } = setup({ expose: false });
  vm.runInContext('window.afterProjects = true', context);
  assert.equal(context.afterProjects, true); assert.equal(requests.length, 0);
  assert.equal(typeof listeners.DOMContentLoaded, 'function');
  context.document.body = {}; listeners.DOMContentLoaded();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.ok(requests.some(r => r.url === '/api/fs/read'));
});

test('manifest is server authoritative; missing file means empty, failed read does not use cache', async () => {
  const { api, files } = setup(); await api.loadProjects(); assert.equal(api.state.projects.length, 0); assert.equal(api.state.loaded, true);
  files.set(FILE, '{"projects":[{"id":"p1","name":"server project"}]}'); await api.loadProjects(); assert.equal(api.state.projects[0].name, 'server project');
  files.set(FILE, 'broken json'); await api.loadProjects(); assert.equal(api.state.projects[0].name, 'server project');
});

test('project persistence creates directory first; either instruction or manifest failure never publishes', async () => {
  const { api, db, dirs, files, requests } = setup();
  const p = { id: 'p1', directory: 'project-p1', name: '项目', description: '项目说明' };
  for (const fail of ['CLAUDE.md', 'AGENTS.md', '.workpartner-projects.json']) {
    db.failWrite = fail; await assert.rejects(api.persistProject(p)); assert.equal(api.state.projects.length, 0);
  }
  db.failWrite = ''; await api.persistProject(p);
  assert.ok(dirs.has('/data/work/project-p1')); assert.equal(files.get('/data/work/project-p1/CLAUDE.md'), p.description);
  assert.equal(files.get('/data/work/project-p1/AGENTS.md'), p.description);
  assert.equal(JSON.parse(files.get(FILE)).projects[0].id, 'p1'); assert.equal(api.state.projects.length, 1);
  assert.ok(requests.findIndex(r => r.url === 'fs/mkdir') < requests.findIndex(r => r.url === '/api/fs/write'));
  await api.moveConversation(db.c, p); assert.equal(db.c.extra.wp_project_id, 'p1'); assert.equal(db.c.extra.backend, 'codex');
});

test('deletion clears ownership even when the manifest write fails; successful deletion restores on undo', async () => {
  const { api, db, files, notices } = setup();
  const p = { id: 'p1', directory: 'project-p1', name: '项目', description: '' }; await api.persistProject(p);
  api.state.conversations = [db.c]; db.c.extra.wp_project_id = p.id; db.failWrite = '.workpartner-projects.json';
  await api.deleteProject(p); assert.equal(db.c.extra.wp_project_id, undefined); assert.equal(api.state.projects.length, 1);
  db.failWrite = ''; db.c.extra.wp_project_id = p.id;
  await api.deleteProject(p); assert.equal(db.c.extra.wp_project_id, undefined); assert.equal(JSON.parse(files.get(FILE)).projects.length, 0);
  await notices.at(-1).undo(); assert.equal(db.c.extra.wp_project_id, p.id); assert.equal(JSON.parse(files.get(FILE)).projects.length, 1);
});

test('pin and move preserve activity and unrelated flags, then pick up a new message', async () => {
  const { api, db, context } = setup(); db.c.extra.wp_pinned = true;
  await api.pinConversation(db.c); assert.equal(db.c.extra.pinned, false); assert.equal(db.c.extra.wp_pinned, undefined);
  await api.pinConversation(db.c); assert.equal(db.c.extra.pinned, true); assert.equal(typeof db.c.extra.pinned_at, 'number');
  await api.moveConversation(db.c, { id: 'p1' }); assert.equal(context.WpProjectsLogic.activityTime(db.c), 500);
  db.messageAt = Date.now(); db.c.updated_at += 10000; await api.loadConversations();
  assert.equal(context.WpProjectsLogic.activityTime(api.state.conversations[0]), db.messageAt);
});


test('empty account bootstraps a native root only for directory creation, then removes the helper conversation', async () => {
  const { api, db } = setup(); db.empty = true;
  await api.persistProject({ id: 'empty', name: '项目', directory: 'project-empty', description: '' });
  assert.equal(db.temporaryDeleted, true); assert.equal(api.state.projects.length, 1);
  assert.ok(!db.requests.some(r => /runtime|messages/.test(r.url)));
});

test('mkdir rejection leaves the manifest and sidebar untouched', async () => {
  const { api, db } = setup(); db.failMkdir = true;
  await assert.rejects(api.persistProject({ id: 'denied', name: '项目', directory: 'project-denied', description: '' }));
  assert.equal(api.state.projects.length, 0); assert.equal(db.files.size, 0);
});
