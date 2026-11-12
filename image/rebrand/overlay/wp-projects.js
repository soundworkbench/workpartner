/* AionUi 2.1.47: projects group chats. The project list lives in client settings; membership is a chat extra flag. */
(function () {
  'use strict';
  var request = window.fetch.bind(window), SETTING = 'wp.projects', FILTER = 'wp-project-filter';
  var projects = [], memberships = new Map(), pending = new Set(), modal = null, opener = null, rendered = '';
  var current = '';
  try { current = localStorage.getItem(FILTER) || ''; } catch (e) { current = ''; }
  var copy = {
    'zh-CN': { all: '全部对话', create: '新建项目', name: '项目名称', save: '保存', cancel: '取消', close: '关闭',
      move: '移到项目', none: '不放进项目', rename: '改名', remove: '删除项目',
      removeHint: '删除后项目里的对话会回到全部对话，不会删除对话。', confirm: '确认删除',
      failed: '未能保存项目设置。请刷新后核对，再操作。', duplicate: '已有同名项目。' },
    'en-US': { all: 'All chats', create: 'New project', name: 'Project name', save: 'Save', cancel: 'Cancel', close: 'Close',
      move: 'Move to project', none: 'No project', rename: 'Rename', remove: 'Delete project',
      removeHint: 'Chats in this project return to All chats; no chat is deleted.', confirm: 'Delete',
      failed: 'Could not save project settings. Reload and check before trying again.', duplicate: 'A project with this name already exists.' }
  };
  function label(key) {
    var language = window.wpSettings && window.wpSettings.get().language;
    return copy[String(language || 'zh-CN').startsWith('zh') ? 'zh-CN' : 'en-US'][key];
  }
  var icon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5h4.5l1.5 1.5h6v7H2z"/></svg>';
  function valid(list) {
    return Array.isArray(list) ? list.filter(function (p) { return p && typeof p.id === 'string' && p.id && typeof p.name === 'string'; }) : [];
  }
  function known(id) { return projects.some(function (p) { return p.id === id; }); }
  // A chat whose project was deleted (or never existed) belongs to no project.
  function projectOf(c) {
    if (!c) return '';
    var id = memberships.has(c.id) ? memberships.get(c.id) : (c.extra && c.extra.wp_project) || '';
    return known(id) ? id : '';
  }
  function shows(c) { return !current || !known(current) || projectOf(c) === current; }
  function refreshList() { if (window.wpArchive && window.wpArchive.invalidate) window.wpArchive.invalidate(); }
  function select(id) {
    current = id || '';
    try { if (current) localStorage.setItem(FILTER, current); else localStorage.removeItem(FILTER); } catch (e) { /* private mode */ }
    rendered = ''; refreshList(); render();
  }
  function error(message) {
    var el = document.querySelector('.wp-archive-error');
    if (!el) { el = document.createElement('div'); el.className = 'wp-archive-error'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
    el.replaceChildren(document.createTextNode(message), button(label('close'), function () { el.remove(); }));
  }
  function button(text, action, className) {
    var b = document.createElement('button'); b.type = 'button'; b.className = className || '';
    b.textContent = text; b.addEventListener('click', action); return b;
  }
  async function json(url, init) {
    var response = await request(url, init), value = await response.json();
    if (!response.ok || (value && value.success === false)) throw new Error('Project request failed');
    return (value && value.data) || value;
  }
  async function load() {
    try {
      var data = await json('/api/settings/client');
      projects = valid(data && data[SETTING]);
    } catch (e) { projects = []; }
    rendered = ''; refreshList(); render();
  }
  // Writes the whole list; on failure the previous list is restored and the user is told.
  async function store(next) {
    var previous = projects; projects = next; rendered = ''; refreshList(); render();
    try {
      var body = {}; body[SETTING] = next;
      await json('/api/settings/client', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return true;
    } catch (e) {
      projects = previous; rendered = ''; refreshList(); render(); error(label('failed')); return false;
    }
  }
  function clean(name) { return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40); }
  function taken(name, except) {
    return projects.some(function (p) { return p.id !== except && p.name.toLowerCase() === name.toLowerCase(); });
  }
  function newId() {
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  async function create(name) {
    name = clean(name);
    if (!name) return null;
    if (taken(name)) { error(label('duplicate')); return null; }
    var project = { id: newId(), name: name };
    return (await store(projects.concat([project]))) ? project : null;
  }
  async function rename(id, name) {
    name = clean(name);
    if (!name || !known(id)) return false;
    if (taken(name, id)) { error(label('duplicate')); return false; }
    return store(projects.map(function (p) { return p.id === id ? { id: p.id, name: name } : p; }));
  }
  // Deleting only forgets the project; chat flags pointing at it are treated as no project.
  async function remove(id) {
    if (!known(id)) return false;
    var ok = await store(projects.filter(function (p) { return p.id !== id; }));
    if (ok && current === id) select('');
    return ok;
  }
  async function assign(c, id) {
    var chatId = typeof c === 'string' ? c : c && c.id;
    if (!chatId || pending.has(chatId)) return false;
    id = id && known(id) ? id : '';
    var had = memberships.has(chatId), previous = memberships.get(chatId);
    pending.add(chatId); memberships.set(chatId, id); refreshList();
    try {
      var confirmed = await json('/api/conversations/' + encodeURIComponent(chatId), { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra: { wp_project: id }, merge_extra: true }) });
      if (!confirmed || confirmed.id !== chatId || ((confirmed.extra && confirmed.extra.wp_project) || '') !== id) throw new Error('Project not confirmed');
      return true;
    } catch (e) {
      if (had) memberships.set(chatId, previous); else memberships.delete(chatId);
      refreshList(); error(label('failed')); return false;
    } finally { pending.delete(chatId); }
  }
  function close() {
    if (!modal) return;
    modal.remove(); modal = null;
    if (opener && opener.isConnected) opener.focus();
  }
  function dialog(title, build) {
    close();
    opener = document.activeElement;
    modal = document.createElement('div'); modal.className = 'wp-archive-backdrop wp-project-backdrop';
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    var panel = document.createElement('section'); panel.className = 'wp-archive-dialog';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title);
    var header = document.createElement('header'), h = document.createElement('h2'); h.textContent = title;
    header.append(h, button(label('close'), close)); panel.appendChild(header);
    build(panel);
    modal.appendChild(panel); document.body.appendChild(modal);
    (panel.querySelector('input') || panel.querySelector('button')).focus();
  }
  function nameForm(panel, initial, done) {
    var form = document.createElement('form'); form.className = 'wp-project-form';
    var input = document.createElement('input'); input.type = 'text'; input.maxLength = 40; input.value = initial || '';
    input.placeholder = label('name'); input.setAttribute('aria-label', label('name'));
    var save = document.createElement('button'); save.type = 'submit'; save.textContent = label('save');
    form.append(input, save, button(label('cancel'), close));
    form.addEventListener('submit', async function (e) {
      e.preventDefault(); save.disabled = true;
      var ok = await done(input.value);
      save.disabled = false;
      if (ok) close();
    });
    panel.appendChild(form);
  }
  function openCreate(then) {
    dialog(label('create'), function (panel) {
      nameForm(panel, '', async function (value) {
        var project = await create(value);
        if (project && then) await then(project);
        return !!project;
      });
    });
  }
  function openMove(c) {
    var chatId = typeof c === 'string' ? c : c && c.id;
    if (!chatId) return;
    var chat = typeof c === 'object' ? c : { id: chatId };
    dialog(label('move'), function (panel) {
      var here = projectOf(chat);
      [{ id: '', name: label('none') }].concat(projects).forEach(function (p) {
        var row = document.createElement('div'); row.className = 'wp-archive-row';
        var choice = button(p.name, async function () { close(); await assign(chat, p.id); }, 'wp-archive-name');
        if (p.id === here) choice.setAttribute('aria-current', 'true');
        row.appendChild(choice); panel.appendChild(row);
      });
      panel.appendChild(button(label('create'), function () { openCreate(function (project) { return assign(chat, project.id); }); }, 'wp-project-create'));
    });
  }
  function openRename(id) {
    var project = projects.find(function (p) { return p.id === id; });
    if (!project) return;
    dialog(label('rename'), function (panel) { nameForm(panel, project.name, function (value) { return rename(id, value); }); });
  }
  function openRemove(id) {
    var project = projects.find(function (p) { return p.id === id; });
    if (!project) return;
    dialog(label('remove') + ': ' + project.name, function (panel) {
      var hint = document.createElement('p'); hint.textContent = label('removeHint'); panel.appendChild(hint);
      var row = document.createElement('div'); row.className = 'wp-archive-row';
      row.append(button(label('confirm'), async function () { if (await remove(id)) close(); }), button(label('cancel'), close));
      panel.appendChild(row);
    });
  }
  // Project bar at the top of the chat list: All, each project, new project; actions for the selected one.
  function render() {
    var aside = document.querySelector('aside.layout-sider [class*="_scrollArea"]');
    var bar = document.querySelector('.wp-project-bar');
    if (!aside) { if (bar) bar.remove(); return; }
    if (current && !known(current) && projects.length) current = '';
    var signature = JSON.stringify([projects, current, label('all')]);
    if (bar && aside.firstElementChild === bar && rendered === signature) return;
    rendered = signature;
    if (!bar) { bar = document.createElement('nav'); bar.className = 'wp-project-bar'; bar.setAttribute('aria-label', label('create')); }
    var chips = [{ id: '', name: label('all') }].concat(projects).map(function (p) {
      var chip = button(p.name, function () { select(p.id); }, 'wp-project-chip');
      chip.setAttribute('aria-pressed', String(p.id === current));
      return chip;
    });
    var add = button('', function () { openCreate(function (project) { select(project.id); }); }, 'wp-project-chip wp-project-add');
    add.innerHTML = icon + '<span></span>'; add.querySelector('span').textContent = label('create');
    chips.push(add);
    if (current) {
      chips.push(button(label('rename'), function () { openRename(current); }, 'wp-project-action'));
      chips.push(button(label('remove'), function () { openRemove(current); }, 'wp-project-action'));
    }
    bar.replaceChildren.apply(bar, chips);
    if (aside.firstElementChild !== bar) aside.insertBefore(bar, aside.firstElementChild);
  }
  window.wpProjects = {
    label: label, icon: icon, shows: shows, projectOf: projectOf, render: render, load: load,
    create: create, rename: rename, remove: remove, assign: assign, select: select, move: openMove,
    list: function () { return projects.slice(); }, current: function () { return current; }
  };
  window.addEventListener('hashchange', close);
  load();
})();
