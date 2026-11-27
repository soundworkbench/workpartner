import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorCode } from '../dist/main/helper-errors.js';
import { executeTool } from '../dist/main/helper-tools.js';
import { HelperSettings } from '../dist/main/helper-settings.js';
import { createAudit } from '../dist/main/helper-audit.js';

function fixture(t) {
  // macOS os.tmpdir() is under the protected /private/var tree.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'desktop-rpc-')));
  t.after(() => fs.rmSync(base, { force: true, recursive: true }));
  const root = path.join(base, 'doc'), outside = root + 's', store = path.join(base, 'store');
  for (const dir of [root, outside, store]) fs.mkdirSync(dir);
  const state = { choice: root, changes: 0 };
  const settings = () => {
    const settings = new HelperSettings(store, async () => state.choice, () => state.changes++);
    settings.bindAccount('account-a');
    return settings;
  };
  const config = settings();
  function run(name, args, progress, deadline = Date.now() + 10000) {
    return executeTool('desktop_' + name, args, config.grants(), store, deadline, progress);
  }
  return { base, root, outside, store, state, settings, config, run };
}
const code = value => e => errorCode(e) === value;

test('identity and private settings survive restart and directory changes', async t => {
  const { config, root, store, state, settings, run } = fixture(t);
  assert.match(config.deviceId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.throws(() => run('list_dir', { path: root }), code('NO_ALLOWED_ROOTS'));
  for (const [choice, expected] of [[path.parse(root).root, 'PATH_NOT_ALLOWED'], [store, 'SENSITIVE_PATH_BLOCKED']]) {
    state.choice = choice;
    await assert.rejects(config.addDirectory(), code(expected));
  }
  state.choice = undefined;
  await config.addDirectory();
  assert.equal(state.changes, 0);
  state.choice = root;
  await config.addDirectory();
  await config.addDirectory();
  config.setDeviceName('\0  桌面' + 'a'.repeat(150));
  config.setPreferred(true);
  config.setPaused(true);
  const next = settings();
  assert.equal(next.deviceId, config.deviceId);
  assert.deepEqual(next.snapshot(), { deviceName: '桌面' + 'a'.repeat(126), allowedRoots: [root], paused: true, preferred: true });
  next.setDeviceName(' \n ');
  assert.equal(next.snapshot().deviceName, 'WorkPartner Desktop');
  next.removeDirectory(root);
  assert.deepEqual(settings().snapshot().allowedRoots, []);
  if (process.platform !== 'win32') for (const file of ['helper-config.json', 'device-id']) assert.equal(fs.statSync(path.join(store, file)).mode & 0o777, 0o600);
});

test('a picker opened in a previous login cannot grant its selection after an account switch', async t => {
  const { root, store } = fixture(t);
  let choose;
  const config = new HelperSettings(store, () => new Promise(resolve => { choose = resolve; }), () => {});
  config.bindAccount('account-a');
  const pending = config.addDirectory();
  config.bindAccount();
  config.bindAccount('account-b');
  choose(root);
  await pending;
  assert.deepEqual(config.grants(), []);
  config.bindAccount('account-a');
  assert.deepEqual(config.grants(), []);
});

test('lexical and canonical boundaries hide existence and block sensitive paths', async t => {
  const { root, outside, store, config, run } = fixture(t);
  await config.addDirectory();
  const read = input => run('read_file', { path: input });
  for (const p of [outside, path.join(outside, 'missing'), root + '/../docs/absent']) assert.throws(() => read(p), code('PATH_NOT_ALLOWED'));
  for (const p of ['x\0y', 'C:file', '\\\\host\\share', '\\\\?\\C:\\x']) assert.throws(() => read(p), code('INVALID_PARAMS'));
  for (const p of ['.ssh/id', '.aws/x', '.gnupg', '.kube', '.GIT-CREDENTIALS', '.npmrc', '.pypirc', '.netrc', '.docker/config.json',
    '.env', '.env.local', '.ENV.example', 'x.PEM', 'x.key', 'x.p12', 'x.pfx', 'x.jks', 'x.kdbx']) {
    assert.throws(() => read(path.join(root, p)), code('SENSITIVE_PATH_BLOCKED'));
  }
  assert.throws(() => read(path.join(store, 'missing')), code('SENSITIVE_PATH_BLOCKED'));
  const systemPath = process.platform === 'win32' ? 'C:\\Windows\\missing' : '/etc/missing';
  assert.throws(() => read(systemPath), code('SENSITIVE_PATH_BLOCKED'));
  assert.throws(() => read(path.join(root, 'missing')), code('PATH_NOT_FOUND'));
  assert.throws(() => read(root), code('NOT_A_REGULAR_FILE'));
});

test('links are checked at every hop, never traversed by listing or search', async t => {
  const { root, outside, config, run } = fixture(t);
  await config.addDirectory();
  fs.writeFileSync(path.join(root, 'ok'), 'visible');
  fs.writeFileSync(path.join(outside, 'private'), 'outside');
  fs.mkdirSync(path.join(root, '.ssh'));
  if (process.platform === 'win32') {
    const junction = path.join(root, 'junction');
    fs.symlinkSync(outside, junction, 'junction');
    assert.throws(() => run('read_file', { path: path.join(junction, 'private') }), code('PATH_NOT_ALLOWED'));
    assert.ok(!run('list_dir', { path: root }).entries.some(e => e.name === 'junction'));
    assert.deepEqual(run('search_files', { query: 'private' }).matches, []);
    return;
  }
  const symlink = (name, target) => fs.symlinkSync(target, path.join(root, name));
  symlink('good', 'ok');
  symlink('outside', path.join(outside, 'private'));
  symlink('loop', 'loop');
  symlink('.ssh/indirect', '../ok');
  symlink('sensitive', '.ssh/indirect');
  symlink('dangling', path.join(outside, 'missing'));
  assert.equal(run('read_file', { path: path.join(root, 'good') }).content, 'visible');
  for (const name of ['outside', 'loop', 'dangling']) assert.throws(() => run('read_file', { path: path.join(root, name) }), code('PATH_NOT_ALLOWED'));
  assert.throws(() => run('read_file', { path: path.join(root, 'sensitive') }), code('SENSITIVE_PATH_BLOCKED'));
  const listing = run('list_dir', { path: root, include_hidden: true, max_depth: 3 });
  assert.deepEqual(listing.entries.map(e => [e.name, e.kind]), [['good', 'symlink'], ['ok', 'file']]);
  assert.equal(listing.skipped_count, 5);
  assert.deepEqual(run('search_files', { query: '*' }).matches.map(m => path.basename(m.path)), ['ok']);
  fs.renameSync(root, root + '-original');
  fs.symlinkSync(outside, root, 'dir');
  assert.throws(() => run('read_file', { path: path.join(root, 'private') }), code('PATH_NOT_ALLOWED'));
});

test('read respects line ranges, UTF-8, input and source byte limits', async t => {
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  const file = path.join(root, 'text'), read = args => run('read_file', { path: file, ...args });
  fs.writeFileSync(file, 'aa\r\n异🙂\nzz');
  assert.equal(read({ start_line: 2, end_line: 2 }).content, '异🙂\n');
  assert.equal(read({ start_line: 2, max_bytes: 6 }).content, '异');
  assert.equal(read({ start_line: 2, max_bytes: 1 }).returned_bytes, 0);
  assert.equal(read({ start_line: 2, max_bytes: 1 }).truncated, true);
  assert.equal(read({ start_line: 10 }).end_line, 0);
  for (const args of [{ start_line: 2, end_line: 1 }, { max_bytes: 262145 }, { max_bytes: null }, { bad: true }]) assert.throws(() => read(args), code('INVALID_PARAMS'));
  fs.writeFileSync(file, 'a'.repeat(262143) + '🙂!');
  const capped = read({ max_bytes: 262144 });
  assert.equal(capped.returned_bytes, 262143);
  assert.equal(capped.truncated, true);
  for (const data of [Buffer.from([0, 1]), Buffer.from([255])]) {
    fs.writeFileSync(file, data);
    assert.throws(() => read({}), code('BINARY_FILE_UNSUPPORTED'));
  }
  fs.truncateSync(file, 20971521);
  assert.throws(() => read({}), code('FILE_TOO_LARGE'));
});

test('listing and literal searches enforce depth, order, counts and partial deadlines', async t => {
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'deep'), 'x');
  for (let n = 0; n < 210; n++) fs.writeFileSync(path.join(root, 'n' + n + '.txt'), 'one\nLiteral [x]+ line\n');
  fs.writeFileSync(path.join(root, '.env.test'), 'Literal [x]+');
  fs.writeFileSync(path.join(root, 'bin'), Buffer.from([0, 91, 120, 93, 43]));
  const a = run('list_dir', { path: root, limit: 200 });
  assert.equal(a.entries.length, 200);
  assert.equal(a.entries[0].kind, 'dir');
  assert.equal(a.truncated, true);
  assert.deepEqual(run('list_dir', { path: root, max_depth: 2, limit: 2 }).entries.map(e => e.name), ['a', 'b']);
  assert.throws(() => run('list_dir', { path: root, max_depth: 4 }), code('INVALID_PARAMS'));
  assert.equal(run('search_files', { query: 'n??.TXT', max_results: 100 }).matches.length, 90);
  const data = run('search_files', { query: '[X]+', mode: 'content', max_results: 100 });
  assert.equal(data.matches.length, 100);
  assert.equal(data.truncated, true);
  assert.ok(data.matches.every(m => m.line === 2 && m.snippet === 'Literal [x]+ line'));
  assert.equal(run('search_files', { query: '*a'.repeat(99) + 'x' }).matches.length, 0);
  assert.equal(run('search_files', { query: 'deep', max_depth: 1 }).matches.length, 0);
  assert.throws(() => run('search_files', { query: '*' }, undefined, Date.now() - 1), code('TOOL_TIMEOUT'));
  const originalNow = Date.now;
  let now = originalNow();
  try {
    Date.now = () => now;
    const partial = run('search_files', { query: 'n*.txt' }, () => { now += 10001; });
    assert.equal(partial.matches.length, 1);
    assert.ok(partial.timed_out && partial.truncated);
  } finally { Date.now = originalNow; }
});
test('audit rolls by day, retains 30 days and only stores bounded metadata', t => {
  const { store } = fixture(t);
  let now = Date.UTC(2026, 1, 1);
  const audit = createAudit(store, () => now), dir = path.join(store, 'logs');
  const secret = 'wpd.' + randomUUID();
  const event = { reqId: secret, tool: 'desktop_read_file', args: { path: secret, query: secret, start_line: 1 }, durationMs: 4, returnedBytes: 10, truncated: false };
  audit(event);
  const file = path.join(dir, 'audit-2026-02-01.jsonl'), text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(secret));
  assert.deepEqual(JSON.parse(text).argsSummary, { start_line: 1 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  fs.truncateSync(file, 50 * 1024 * 1024);
  audit(event);
  assert.equal(fs.statSync(file).size, 50 * 1024 * 1024);
  now += 30 * 86400000;
  audit(event);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readdirSync(dir).length, 1);
});


test('listing stops at 2,000 nodes and searching stops at 5,000 files', async t => {
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  for (let n = 0; n < 5001; n++) fs.writeFileSync(path.join(root, '.file-' + n), '');
  const listing = run('list_dir', { path: root, limit: 200 });
  assert.ok(listing.truncated);
  assert.equal(listing.entries.length, 0);
  assert.equal(listing.skipped_count, 2000);
  const search = run('search_files', { query: 'absent' });
  assert.equal(search.scanned_files, 5000);
  assert.ok(search.truncated);
});
test('binary files count towards 50 MiB and files over 2 MiB are skipped', async t => {
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  const big = path.join(root, 'big');
  fs.writeFileSync(big, 'needle');
  fs.truncateSync(big, 2 * 1024 * 1024 + 1);
  assert.deepEqual(run('search_files', { query: 'needle', mode: 'content' }).matches, []);
  for (let n = 0; n < 26; n++) {
    const file = path.join(root, 'binary-' + n);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 2 * 1024 * 1024);
  }
  const result = run('search_files', { query: 'needle', mode: 'content' });
  assert.ok(result.truncated);
  assert.ok(result.scanned_files === 25 || result.scanned_files === 26);
  assert.deepEqual(result.matches, []);
});

test('env-prefixed files and directories are filtered from every tool', async t => {
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  fs.mkdirSync(path.join(root, '.EnV_backup'));
  const files = ['.envrc', '.ENV_backup_file', '.EnV_backup/notes'];
  for (const file of files) {
    const target = path.join(root, file);
    fs.writeFileSync(target, 'sample');
    assert.throws(() => run('read_file', { path: target }), code('SENSITIVE_PATH_BLOCKED'));
  }
  const listing = run('list_dir', { path: root, include_hidden: true, max_depth: 3 });
  assert.deepEqual(listing.entries, []);
  assert.equal(listing.skipped_count, 3);
  for (const [mode, query] of [['name', '*'], ['content', 'sample']]) {
    assert.deepEqual(run('search_files', { mode, query }).matches, []);
    assert.throws(() => run('search_files', { path: path.join(root, '.EnV_backup'), mode, query }), code('SENSITIVE_PATH_BLOCKED'));
  }
});

test('multi-link files cannot supply contents to reads or search', async t => {
  const { root, outside, config, run } = fixture(t);
  await config.addDirectory();
  const file = path.join(root, 'notes');
  fs.writeFileSync(file, 'sample');
  fs.linkSync(file, path.join(outside, 'other-name'));
  assert.throws(() => run('read_file', { path: file }), code('PATH_NOT_ALLOWED'));
  assert.deepEqual(run('search_files', { mode: 'content', query: 'sample' }).matches, []);
});

test('persisted identities reject a replaced root after restart and path-only grants require selection', async t => {
  const { root, store, config, settings } = fixture(t);
  await config.addDirectory();
  fs.renameSync(root, root + '-previous');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'notes'), 'sample');
  const restored = settings();
  assert.deepEqual(restored.grants(), config.grants());
  for (const [tool, args] of [
    ['list_dir', { path: root }], ['read_file', { path: path.join(root, 'notes') }], ['search_files', { query: '*' }]
  ]) {
    assert.throws(() => executeTool('desktop_' + tool, args, restored.grants(), store, Date.now() + 1000), code('PATH_NOT_ALLOWED'));
  }
  fs.writeFileSync(path.join(store, 'helper-config.json'), JSON.stringify({ preferred: true, grants: config.grants(), allowedRoots: [root] }));
  const legacy = settings();
  assert.deepEqual(legacy.grants(), []);
  assert.equal(legacy.snapshot().preferred, false);
  await legacy.addDirectory();
  assert.notDeepEqual(legacy.grants(), config.grants());
});

test('open file and directory operations recheck ancestor identities before consuming data', async t => {
  const { syncBuiltinESMExports } = await import('node:module');
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  const parent = path.join(root, 'parent'), dir = path.join(parent, 'inner'), file = path.join(dir, 'notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, 'sample');
  const lstat = fs.lstatSync, openFile = fs.openSync, openDir = fs.opendirSync;
  for (const [tool, args] of [['read_file', { path: file }], ['list_dir', { path: dir }], ['search_files', { path: dir, query: '*' }]]) {
    let opened = false;
    const method = tool === 'read_file' ? 'openSync' : 'opendirSync';
    t.mock.method(fs, method, (...args) => {
      const handle = (method === 'openSync' ? openFile : openDir)(...args);
      if (method === 'opendirSync' || path.basename(args[0]) === 'notes') opened = true;
      return handle;
    });
    t.mock.method(fs, 'lstatSync', (name, options) => {
      const stat = lstat(name, options);
      if (opened && path.basename(name) === 'parent') stat.ino += 1n;
      return stat;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => run(tool, args), code('PATH_NOT_ALLOWED'));
      assert.ok(opened);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test('POSIX file reads and enumeration stay on the held directory during replacement', { skip: process.platform === 'win32' }, async t => {
  const { syncBuiltinESMExports } = await import('node:module');
  const { root, outside, config, run } = fixture(t);
  await config.addDirectory();
  const parent = path.join(root, 'parent'), held = path.join(root, 'held');
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, 'notes'), 'inside');
  fs.writeFileSync(path.join(outside, 'notes'), 'outside');
  for (const [tool, method, args] of [
    ['read_file', 'openSync', { path: path.join(parent, 'notes') }],
    ['list_dir', 'opendirSync', { path: parent }]
  ]) {
    const original = fs[method];
    const expected = fs.statSync(args.path, { bigint: true });
    let replaced = false;
    t.mock.method(fs, method, (name, ...rest) => {
      if (method === 'openSync' && path.basename(name) !== 'notes') return original(name, ...rest);
      // Interleave a directory replacement precisely between verification and I/O.
      fs.renameSync(parent, held);
      fs.symlinkSync(outside, parent, 'dir');
      replaced = true;
      const actual = fs.statSync(name, { bigint: true });
      assert.deepEqual([actual.dev, actual.ino], [expected.dev, expected.ino]);
      return original(name, ...rest);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => run(tool, args), code('PATH_NOT_ALLOWED'));
      assert.ok(replaced);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (replaced) { fs.unlinkSync(parent); fs.renameSync(held, parent); }
    }
  }
});

test('a mismatched open file identity fails verification', async t => {
  const { syncBuiltinESMExports } = await import('node:module');
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  const file = path.join(root, 'notes');
  fs.writeFileSync(file, 'sample');
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args) => {
    const stat = fstat(...args);
    stat.ino += 1n;
    return stat;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => run('read_file', { path: file }), code('PATH_NOT_ALLOWED')); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('Windows rejects reparse attributes on pinned handles and releases the entire chain', async () => {
  const { pinWindowsPath } = await import('../dist/main/helper-windows.js');
  for (const attributes of [0x10, 0x410, 0x400, 0xffffffff]) {
    const paths = [], closed = [];
    const kernel = {
      open(name, _access, share, _security, _disposition, flags) {
        paths.push(name);
        assert.equal(share, 1);
        assert.ok(flags & 0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
        return paths.length;
      },
      info(handle, kind, buffer) {
        assert.equal(kind, 9);
        buffer.writeUInt32LE(handle === 3 ? attributes : 0x10);
        return 1;
      },
      close: handle => closed.push(handle)
    };
    const acquire = () => pinWindowsPath('D:\\shared\\notes', kernel);
    if (attributes === 0x10) acquire()();
    else assert.throws(acquire, code('PATH_NOT_ALLOWED'));
    assert.equal(paths.length, 3);
    assert.deepEqual(closed, [3, 2, 1]);
  }
});

test('four simultaneous depth-eight searches share a bounded set of handles', async t => {
  const { Worker } = await import('node:worker_threads');
  const { handleLimit } = await import('../dist/main/helper-handles.js');
  const { root, store, config } = fixture(t);
  await config.addDirectory();
  const deepest = path.join(root, ...Array(7).fill('child'));
  fs.mkdirSync(deepest, { recursive: true });
  const file = path.join(deepest, 'match');
  fs.writeFileSync(file, 'needle');
  const handleSlots = new Int32Array(new SharedArrayBuffer(4 * handleLimit));
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  // Hold all four reads at their deepest point to measure overlapping live
  // pins, directory streams and file handles independently of worker timing.
  const source = `
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const { root, store, roots, url, handleSlots, barrier } = workerData;
    const read = fs.readSync;
    fs.readSync = (...args) => {
      if (Atomics.add(barrier, 0, 1) === 3) {
        Atomics.store(barrier, 1, handleSlots.filter(Boolean).length);
        Atomics.notify(barrier, 0);
      }
      for (let n; (n = Atomics.load(barrier, 0)) < 4;) {
        if (Atomics.wait(barrier, 0, n, 5000) === 'timed-out') throw Error('workers did not overlap');
      }
      return read(...args);
    };
    require('node:module').syncBuiltinESMExports();
    import(url).then(({ executeTool }) => parentPort.postMessage(executeTool('desktop_search_files',
      { path: root, query: 'needle', mode: 'content', max_depth: 8 }, roots, store, Date.now() + 10000)));
  `;
  const url = new URL('../dist/main/helper-tools.js', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { root, store, roots: config.grants(), url, handleSlots, barrier } });
    let data;
    worker.on('message', result => { data = result; });
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(data) : reject(Error('worker exited ' + code)));
  })));
  for (const result of results) assert.deepEqual(result.matches.map(match => match.path), [file]);
  const peak = Atomics.load(barrier, 1);
  assert.ok(peak >= 4 * 17 && peak <= handleLimit, 'peak ' + peak);
  t.diagnostic('peak ' + peak + ' of ' + handleLimit + ' helper handles');
  assert.ok(handleSlots.every(owner => owner === 0));
});

test('running out of handle slots returns a limit error and releases partial acquisitions', async t => {
  const { handleSlots } = await import('../dist/main/helper-handles.js');
  const { root, config, run } = fixture(t);
  await config.addDirectory();
  fs.mkdirSync(path.join(root, 'child'));
  handleSlots.fill(-1, 2);
  try {
    assert.throws(() => run('search_files', { query: '*' }), code('LIMIT_EXCEEDED'));
    assert.deepEqual([...handleSlots.slice(0, 2)], [0, 0]);
  } finally { handleSlots.fill(0); }
});
