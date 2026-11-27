import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { logoutAction, settingsHandler } from '../dist/main/settings-actions.js';

const page = new URL('../dist/settings/index.html', import.meta.url).href;
function settingsIPC() {
  const owner = { mainFrame: { url: page }, getURL: () => page, isDestroyed: () => false };
  const calls = [];
  const settings = {
    snapshot: () => ({ allowedRoots: ['shared'] }), addDirectory: () => calls.push('pick'),
    removeDirectory: root => calls.push(root), setPreferred: value => calls.push(value),
    setPaused: value => calls.push(value), setDeviceName: value => calls.push(value)
  };
  return { owner, calls, event: { sender: owner, senderFrame: owner.mainFrame },
    handle: settingsHandler(owner, page, settings, () => 'state', all => calls.push(all ? 'all' : 'local')) };
}

test('only the live settings window and its exact local main frame may use settings IPC', () => {
  const { owner, event, calls, handle } = settingsIPC();
  assert.equal(handle(event, 'read'), 'state');
  for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: { url: page } }, { ...event, senderFrame: null }]) {
    assert.throws(() => handle(bad, 'logoutAll'), /来源/);
  }
  owner.mainFrame.url = 'about:blank';
  assert.throws(() => handle(event, 'read'), /来源/);
  owner.mainFrame.url = page;
  owner.getURL = () => page + '?other';
  assert.throws(() => handle(event, 'read'), /来源/);
  owner.getURL = () => page;
  owner.isDestroyed = () => true;
  assert.throws(() => handle(event, 'addDirectory'), /来源/);
  assert.deepEqual(calls, []);
});

test('directory grants use the picker, removals require a current grant and mutations validate inputs', () => {
  const { calls, event, handle } = settingsIPC();
  for (const args of [['addDirectory', 'unselected'], ['removeDirectory', 'unknown'],
    ['setPreferred', 1], ['setPaused', 'false'], ['setDeviceName', '   '], ['setDeviceName', 'a'.repeat(129)],
    ['setDeviceName', '\u0001'], ['logout', true], ['unknown']]) {
    assert.throws(() => handle(event, ...args), /参数/);
  }
  assert.deepEqual(calls, []);
  for (const args of [['addDirectory'], ['removeDirectory', 'shared'], ['setPreferred', true],
    ['setPaused', false], ['setDeviceName', '设备'], ['logout'], ['logoutAll']]) handle(event, ...args);
  assert.deepEqual(calls, ['pick', 'shared', true, false, '设备', 'local', 'all']);
});

test('sandbox preload exposes named actions in the main frame and forwards neither paths to add nor IPC events', async () => {
  const source = readFileSync(new URL('../dist/preload/settings-preload.cjs', import.meta.url), 'utf8');
  let api, subscription;
  const messages = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'localAccess'); api = value; } },
    ipcRenderer: { invoke: (...args) => messages.push(args), on: (_name, fn) => { subscription = fn; } }
  };
  function run(isMainFrame) {
    runInNewContext(source, { exports: {}, process: { isMainFrame },
      require: name => { assert.equal(name, 'electron'); return electron; } });
  }
  run(false);
  assert.equal(api, undefined);
  run(true);
  assert.deepEqual(Object.keys(api).sort(), ['addDirectory', 'logout', 'logoutAll', 'onChanged', 'read',
    'removeDirectory', 'setDeviceName', 'setPaused', 'setPreferred']);
  await api.addDirectory('unselected');
  assert.deepEqual(messages, [['local-access', 'addDirectory']]);
  let received;
  api.onChanged((...args) => { received = args; });
  subscription({ sender: {} }, 'untrusted');
  assert.deepEqual(received, []);
});

test('both logout entry points share one confirmation, cancellation preserves the current login', async () => {
  let answer, prompts = 0, token = 'first';
  const calls = [];
  const logout = logoutAction(() => token, () => { prompts++; return new Promise(resolve => { answer = resolve; }); },
    async all => { calls.push(all ? 'revoke-all' : 'local'); });
  await logout(false);
  assert.equal(prompts, 0);
  let pending = logout(true);
  await logout(true);
  assert.equal(prompts, 1);
  answer(false);
  await pending;
  assert.deepEqual(calls, ['local']);
  pending = logout(true);
  token = 'changed';
  answer(true);
  await pending;
  assert.deepEqual(calls, ['local']);
  pending = logout(true);
  answer(true);
  await pending;
  assert.deepEqual(calls, ['local', 'revoke-all']);
  token = undefined;
  await logout(true);
  assert.equal(prompts, 3);
});
