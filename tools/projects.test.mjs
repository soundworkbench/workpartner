/** Project grouping at the overlay and patched sidebar filter boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const archiveSource = fs.readFileSync(new URL('../image/rebrand/overlay/wp-archive.js', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../image/rebrand/overlay/wp-projects.js', import.meta.url), 'utf8');
const extracted = spawnSync('python3', ['-I', '-c', `
import ast, json, sys
from pathlib import Path
tree = ast.parse(Path(sys.argv[1]).read_text())
patches = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'UI_PATCHES' for t in n.targets))
print(json.dumps([b for a, b in patches if a.startswith(('UPo=', 'onClickMenuItem:b=>{if(b==="pin")', 'e.createElement(J.Item,{key:"pin"}'))]))
`, new URL('../image/rebrand/rebrand.py', import.meta.url).pathname], { encoding: 'utf8' });
assert.equal(extracted.status, 0, extracted.stderr);
const [filter, menuClick, menuItems] = JSON.parse(extracted.stdout);
const tick = () => new Promise(resolve => setImmediate(resolve));
const chat = (id, project) => ({ id, name: id, extra: project === undefined ? {} : { wp_project: project } });

function app({ settings = {}, fail = () => false, storage = {} } = {}) {
  const calls = [], alerts = [], body = { children: [], appendChild(n) { this.children.push(n); } };
  const window = new EventTarget();
  window.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body && JSON.parse(init.body) });
    if (fail(url, init)) return { ok: false, json: async () => ({ success: false }) };
    if (url === '/api/settings/client' && !init.method) return { ok: true, json: async () => ({ success: true, data: settings }) };
    if (url === '/api/settings/client') { Object.assign(settings, JSON.parse(init.body)); return { ok: true, json: async () => ({ success: true }) }; }
    const id = decodeURIComponent(url.split('/').pop());
    return { ok: true, json: async () => ({ success: true, data: { id, extra: JSON.parse(init.body).extra } }) };
  };
  const element = () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, appendChild() {},
    replaceChildren(...children) { alerts.push(children[0]); }, querySelector: () => null, remove() {}, focus() {} });
  const context = vm.createContext({ window, console, Promise, Map, Set, JSON, Date, Math, String, Array,
    localStorage: { getItem: k => storage[k] ?? null, setItem: (k, v) => { storage[k] = v; }, removeItem: k => { delete storage[k]; } },
    document: { querySelector: () => null, querySelectorAll: () => [], createElement: element, getElementById: () => null,
      createTextNode: text => text, body, activeElement: null },
    location: { hash: '' }, requestAnimationFrame() {},
  });
  vm.runInContext(archiveSource, context);
  vm.runInContext(source, context);
  vm.runInContext(`var FPo=()=>false, list=[]; var project=${filter}; return n}; window.visible=()=>project(list).map(c=>c.id);`, context);
  return { window, calls, alerts, storage, settings, show(items) { context.list = items; return Array.from(window.visible()); } };
}

test('the patched sidebar filter shows every chat until a project is selected', async () => {
  const a = app({ settings: { 'wp.projects': [{ id: 'p1', name: 'Reports' }] } }); await tick();
  const items = [chat('one', 'p1'), chat('two'), chat('three', 'p1')];
  assert.deepEqual(a.show(items), ['one', 'two', 'three']);
  a.window.wpProjects.select('p1');
  assert.deepEqual(a.show(items), ['one', 'three']);
  assert.equal(a.storage['wp-project-filter'], 'p1', 'selection survives reload');
  a.window.wpProjects.select('');
  assert.deepEqual(a.show(items), ['one', 'two', 'three']);
});

test('creating a project writes only the project list to client settings', async () => {
  const a = app(); await tick();
  const project = await a.window.wpProjects.create('  Q3   analysis ');
  assert.equal(project.name, 'Q3 analysis');
  const put = a.calls.find(c => c.method === 'PUT');
  assert.deepEqual(Object.keys(put.body), ['wp.projects']);
  assert.deepEqual(put.body['wp.projects'].map(p => p.name), ['Q3 analysis']);
  assert.equal(await a.window.wpProjects.create('q3 ANALYSIS'), null, 'duplicate names are refused');
  assert.equal(a.calls.filter(c => c.method === 'PUT').length, 1);
});

test('moving a chat patches only its project flag and filters immediately', async () => {
  const a = app({ settings: { 'wp.projects': [{ id: 'p1', name: 'Reports' }] } }); await tick();
  const items = [chat('one'), chat('two')];
  a.window.wpProjects.select('p1');
  assert.deepEqual(a.show(items), []);
  assert.equal(await a.window.wpProjects.assign('one', 'p1'), true);
  assert.deepEqual(a.show(items), ['one']);
  const patch = a.calls.find(c => c.method === 'PATCH');
  assert.equal(patch.url, '/api/conversations/one');
  assert.deepEqual(patch.body, { extra: { wp_project: 'p1' }, merge_extra: true });
});

test('a failed move rolls back and shows an error', async () => {
  const a = app({ settings: { 'wp.projects': [{ id: 'p1', name: 'Reports' }] }, fail: (url, init) => init.method === 'PATCH' }); await tick();
  a.window.wpProjects.select('p1');
  assert.equal(await a.window.wpProjects.assign('one', 'p1'), false);
  assert.deepEqual(a.show([chat('one')]), []);
  assert.equal(a.alerts.length, 1);
});

test('deleting a project keeps its chats, which return to All chats', async () => {
  const a = app({ settings: { 'wp.projects': [{ id: 'p1', name: 'Reports' }, { id: 'p2', name: 'Other' }] } }); await tick();
  const items = [chat('one', 'p1'), chat('two', 'p2')];
  a.window.wpProjects.select('p1');
  assert.equal(await a.window.wpProjects.remove('p1'), true);
  assert.equal(a.window.wpProjects.current(), '');
  assert.deepEqual(a.show(items), ['one', 'two']);
  assert.equal(a.window.wpProjects.projectOf(items[0]), '', 'stale flag means no project');
  assert.equal(a.calls.filter(c => c.method === 'PATCH' || c.method === 'DELETE').length, 0, 'no chat is touched');
});

test('rename keeps membership; a failed settings write restores the previous list', async () => {
  const a = app({ settings: { 'wp.projects': [{ id: 'p1', name: 'Reports' }] }, fail: (url, init) => init.method === 'PUT' && JSON.parse(init.body)['wp.projects'][0].name === 'Broken' }); await tick();
  assert.equal(await a.window.wpProjects.rename('p1', 'Monthly'), true);
  assert.equal(a.window.wpProjects.projectOf(chat('one', 'p1')), 'p1');
  assert.equal(await a.window.wpProjects.rename('p1', 'Broken'), false);
  assert.deepEqual(a.window.wpProjects.list().map(p => p.name), ['Monthly']);
  assert.equal(a.alerts.length, 1);
});

test('an unreadable project list falls back to showing every chat', async () => {
  const a = app({ storage: { 'wp-project-filter': 'p1' }, fail: url => url === '/api/settings/client' }); await tick();
  assert.deepEqual(a.show([chat('one', 'p1'), chat('two')]), ['one', 'two']);
});

test('the chat menu offers the project move next to archive', () => {
  assert.match(menuClick, /if\(b==="wpProject"\)\{window\.wpProjects\.move\(t\);return\}/);
  assert.match(menuItems, /key:"wpProject"/);
  assert.ok(menuItems.indexOf('key:"wpArchive"') < menuItems.indexOf('key:"wpProject"'));
});
