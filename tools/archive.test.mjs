/** Archive behavior at the overlay and patched sidebar store boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const overlay = fs.readFileSync(new URL('../image/rebrand/overlay/wp-archive.js', import.meta.url), 'utf8');
const extracted = spawnSync('python3', ['-I', '-c', `
import ast, json, sys
from pathlib import Path
tree = ast.parse(Path(sys.argv[1]).read_text())
patches = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'UI_PATCHES' for t in n.targets))
print(json.dumps([b for a, b in patches if a.startswith(('zn=()=>', 'UPo='))]))
`, new URL('../image/rebrand/rebrand.py', import.meta.url).pathname], { encoding: 'utf8' });
assert.equal(extracted.status, 0, extracted.stderr);
const [refresh, filter] = JSON.parse(extracted.stdout);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function chat(id, value = false) { return { id, name: id, extra: { wp_archived: value } }; }

function app(items = [chat('one')]) {
  const writes = [], reads = [], alerts = [];
  const window = new EventTarget();
  window.fetch = (url, options) => {
    const result = deferred(); writes.push({ url, options, ...result }); return result.promise;
  };
  const element = () => ({ setAttribute() {}, addEventListener() {}, replaceChildren(...children) { alerts.push(children[0]); } });
  const context = vm.createContext({ window, console, Promise, Map, Set,
    document: { querySelector: () => null, querySelectorAll: () => [], createElement: element,
      createTextNode: text => text, body: { appendChild() {} } },
    location: { hash: '' }, requestAnimationFrame() {},
    pd: { getUserConversations: { invoke(options) { assert.equal(options.limit, 10000); const result = deferred(); reads.push(result); return result.promise; } } },
  });
  vm.runInContext(overlay, context);
  vm.runInContext(`var Yn=[], zo=new Set(), FPo=c=>!!(c.extra?.team_id||c.extra?.teamId), visible=[];
    var project=${filter}; return n};
    var Kt=()=>{visible=project(Yn)}, ${refresh};
    window.reload=zn; window.visible=()=>visible.map(c=>c.id);`, context);
  async function seed() {
    const result = window.reload(); await tick(); reads.at(-1).resolve({ items }); await result;
  }
  function respond(index, item, ok = true) {
    writes[index].resolve({ ok, json: async () => ({ success: ok, data: item }) });
  }
  return { window, writes, reads, alerts, seed, respond, visible: () => Array.from(window.visible()) };
}

test('archive hides immediately among 3000 chats; PATCH plus list event performs one list read and no confirmation GET', async () => {
  const items = Array.from({ length: 3000 }, (_, i) => chat(`chat-${i}`));
  const a = app(items); await a.seed();
  const operation = a.window.wpArchive.toggle(items[0]);
  assert.equal(a.visible().length, 2999);
  assert.equal(a.visible().includes(items[0].id), false);
  a.respond(0, chat(items[0].id, true)); await operation;
  assert.equal(a.reads.length, 1, 'success does not manually reload');
  const event = a.window.reload(); await tick();
  a.reads[1].resolve({ items: [chat(items[0].id, true), ...items.slice(1)] }); await event;
  assert.equal(a.reads.length, 2, 'only listChanged reloads');
  assert.equal(a.writes.length, 1);
  assert.equal(a.writes[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(a.writes[0].options.body), { extra: { wp_archived: true }, merge_extra: true });
  assert.equal(a.window.wpArchive.archived(chat(items[0].id)), false, 'matching list releases local override');
});

test('failed PATCH restores the chat and shows an error without a list request', async () => {
  const a = app(); await a.seed();
  const operation = a.window.wpArchive.toggle('one');
  assert.deepEqual(a.visible(), []);
  a.respond(0, null, false); await operation;
  assert.deepEqual(a.visible(), ['one']);
  assert.equal(a.alerts.length, 1);
  assert.equal(a.reads.length, 1);
});

test('unarchive appears immediately and rejection returns it to archived', async () => {
  const a = app([chat('one', true)]); await a.seed();
  const operation = a.window.wpArchive.toggle('one');
  assert.deepEqual(a.visible(), ['one']);
  a.writes[0].reject(new Error('network')); await operation;
  assert.deepEqual(a.visible(), []);
  assert.equal(a.alerts.length, 1);
});

test('stale in-flight lists cannot undo local state; a matching subsequent list releases it', async () => {
  const a = app(); await a.seed();
  const stale = a.window.reload(); await tick();
  const operation = a.window.wpArchive.toggle('one');
  a.reads[1].resolve({ items: [chat('one')] }); await stale;
  assert.deepEqual(a.visible(), []);
  a.respond(0, chat('one', true)); await operation;
  const fresh = a.window.reload(); await tick();
  a.reads[2].resolve({ items: [chat('one', true)] }); await fresh;
  assert.equal(a.window.wpArchive.archived(chat('one')), false);
});

test('a failed inverse toggle preserves the preceding unconfirmed successful archive', async () => {
  const a = app(); await a.seed();
  const first = a.window.wpArchive.toggle('one');
  a.respond(0, chat('one', true)); await first;
  const second = a.window.wpArchive.toggle('one');
  assert.deepEqual(a.visible(), ['one']);
  a.respond(1, null, false); await second;
  assert.deepEqual(a.visible(), []);
});

test('a list started before an inverse toggle cannot acknowledge its coincidentally matching old state', async () => {
  const a = app(); await a.seed();
  const first = a.window.wpArchive.toggle('one');
  a.respond(0, chat('one', true)); await first;
  const stale = a.window.reload(); await tick();
  const second = a.window.wpArchive.toggle('one');
  a.reads[1].resolve({ items: [chat('one')] }); await stale;
  assert.equal(a.window.wpArchive.archived(chat('one', true)), false, 'inverse override survives the old snapshot');
  a.respond(1, chat('one')); await second;
  const fresh = a.window.reload(); await tick();
  a.reads[2].resolve({ items: [chat('one')] }); await fresh;
  assert.equal(a.window.wpArchive.archived(chat('one', true)), true, 'new matching list releases it');
});

test('overlapping refreshes share one request and one trailing reload; later calls can reload again', async () => {
  const a = app(); await a.seed();
  const first = a.window.reload(); await tick();
  for (let i = 0; i < 20; i++) assert.equal(a.window.reload(), first);
  assert.equal(a.reads.length, 2);
  a.reads[1].resolve({ items: [chat('renamed')] }); await first; await tick();
  assert.equal(a.reads.length, 3);
  assert.deepEqual(a.visible(), ['renamed']);
  a.reads[2].resolve({ items: [chat('created')] }); await tick();
  assert.equal(a.reads.length, 3);
  assert.deepEqual(a.visible(), ['created']);
  const later = a.window.reload(); await tick();
  a.reads[3].resolve({ items: [chat('later')] }); await later;
  assert.deepEqual(a.visible(), ['later']);
});

test('a rejected list read releases the coalescer for its trailing refresh', async () => {
  const a = app(); await a.seed();
  const first = a.window.reload(); a.window.reload(); await tick();
  a.reads[1].reject(new Error('offline')); await first; await tick();
  assert.equal(a.reads.length, 3);
  a.reads[2].resolve({ items: [chat('recovered')] }); await tick();
  assert.deepEqual(a.visible(), ['recovered']);
});

test('duplicate clicks during PATCH are ignored; mismatched success data rolls back with an error', async () => {
  const a = app(); await a.seed();
  const first = a.window.wpArchive.toggle('one'); await a.window.wpArchive.toggle('one');
  assert.equal(a.writes.length, 1);
  a.respond(0, chat('wrong', true)); await first;
  assert.deepEqual(a.visible(), ['one']); assert.equal(a.alerts.length, 1);
});
