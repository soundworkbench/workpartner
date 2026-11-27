'use strict';

const api = window.localAccess;
const byId = id => document.getElementById(id);
let state, reading = 0, busy = false;

function showRoots(roots) {
  const list = byId('roots');
  if (state && state.allowedRoots.length === roots.length &&
      roots.every((root, index) => state.allowedRoots[index] === root)) return;
  list.replaceChildren();
  for (const root of roots) {
    const item = document.createElement('li');
    item.className = 'split';
    const info = document.createElement('div');
    info.className = 'directory';
    const title = document.createElement('strong');
    const path = document.createElement('small');
    // A backslash is a valid filename character on POSIX.
    title.textContent = root.slice(root.lastIndexOf(root.startsWith('/') ? '/' : '\\') + 1);
    path.textContent = root;
    info.append(title, path);
    const remove = document.createElement('button');
    remove.textContent = '移除';
    remove.setAttribute('aria-label', '移除 ' + root);
    remove.addEventListener('click', async () => {
      if (await run(() => api.removeDirectory(root), '未能移除目录，请重试。')) byId('add').focus();
    });
    item.append(info, remove);
    list.append(item);
  }
}

function updateControls() {
  for (const control of document.querySelectorAll('button, input')) control.disabled = busy || !state;
  if (!state || busy) return;
  byId('add').disabled = !state.canRevoke || state.allowedRoots.length >= 32;
  byId('addFirst').disabled = byId('add').disabled;
  byId('preferred').disabled = !state.canRevoke;
  byId('logoutAll').disabled = !state.canRevoke;
  byId('pause').disabled = state.connection === 'revoked';
}

async function refresh() {
  const request = ++reading;
  const next = await api.read();
  if (request !== reading) return;
  showRoots(next.allowedRoots);
  state = next;
  byId('deviceName').textContent = state.deviceName;
  byId('preferredBadge').hidden = !state.preferred;
  byId('preferred').checked = state.preferred;
  byId('pause').textContent = state.paused ? '恢复本机助手' : '暂停本机助手';
  byId('connection').dataset.state = state.connection;
  byId('connection').textContent = state.connectionLabel;
  byId('platform').textContent = state.platform + ' · 只读访问 · v' + state.version;
  byId('detail').textContent = state.detail;
  byId('detail').hidden = state.connection !== 'offline' && state.connection !== 'revoked';
  byId('count').textContent = state.allowedRoots.length + ' / 32';
  byId('empty').hidden = state.allowedRoots.length > 0;
  byId('notice').textContent = state.notice;
  updateControls();
}

async function run(action, failure) {
  if (busy || !state) return false;
  const focus = document.activeElement;
  busy = true;
  updateControls();
  byId('feedback').textContent = '';
  try {
    await action();
    await refresh();
    return true;
  } catch {
    byId('feedback').textContent = failure;
    if (state) byId('preferred').checked = state.preferred;
    return false;
  } finally {
    busy = false;
    updateControls();
    if (focus?.isConnected && document.activeElement === document.body) focus.focus();
  }
}

function editName(editing) {
  byId('feedback').textContent = '';
  byId('nameForm').hidden = !editing;
  byId('nameView').hidden = editing;
  if (editing) {
    const input = byId('nameInput');
    input.value = state.deviceName;
    input.focus();
    input.select();
  } else byId('edit').focus();
}

byId('edit').onclick = () => editName(true);
byId('cancel').onclick = () => editName(false);
byId('nameInput').onkeydown = event => {
  if (event.key === 'Escape' && !event.isComposing) editName(false);
};
byId('nameForm').onsubmit = async event => {
  event.preventDefault();
  const name = byId('nameInput').value.trim();
  if (!name) {
    byId('feedback').textContent = '请输入设备名称。';
    byId('nameInput').focus();
    return;
  }
  if (await run(() => api.setDeviceName(name), '保存失败，请检查设备名称后重试。')) editName(false);
};
byId('add').onclick = byId('addFirst').onclick = () =>
  run(() => api.addDirectory(), '未能授权该目录。请选择可访问的工作文件夹，系统目录、敏感目录和磁盘根目录无法添加。');
byId('preferred').onchange = event => {
  const checked = event.target.checked;
  void run(() => api.setPreferred(checked), '首选设备保存失败，请重试。');
};
byId('pause').onclick = () => run(() => api.setPaused(!state.paused), '暂停设置保存失败，请重试。');
byId('logout').onclick = () => run(() => api.logout(), '退出登录失败，请重试。');
byId('logoutAll').onclick = () => run(() => api.logoutAll(), '退出所有桌面设备失败，请重试。');

function load() {
  void refresh().catch(() => { byId('feedback').textContent = '无法读取本机设置，请重新打开设置窗。'; });
}
updateControls();
api.onChanged(load);
load();
