/* Projects sidebar for WorkPartner.  It deliberately uses the native conversation API. */
(function () {
  'use strict';
  var L = window.WpProjectsLogic, request = window.fetch.bind(window);
  var FILE = '__WP_WORKDIR__/.workpartner-projects.json';
  var state = { projects: [], conversations: [], files: {}, expanded: new Set(), collapsed: false, loaded: false,
    pendingProject: null, modal: null, menu: null, home: null, lastSignature: '' };
  var ICONS = { folder: '□', star: '☆', bolt: 'ϟ', book: '▤', chart: '▥', flag: '⚑' };
  var COLORS = ['#9b9b87', '#9b8f87', '#879b9b', '#9b8794', '#8f9b87', '#93879b', '#9b9687', '#87919b'];
  var COPY = { 'zh-CN': { project: '项目', pinned: '置顶', newProject: '新建项目', recent: '最近对话', today: '今天', yesterday: '昨天', week: '前 7 天', earlier: '更早', all: '查看全部', chats: '条对话', newChat: '新建对话', newIn: '在此项目新建对话', projectHome: '打开项目主页', settings: '项目设置', remove: '删除项目', rename: '重命名', move: '移到项目', out: '移出项目', pin: '置顶', unpin: '取消置顶', del: '删除', back: '返回', name: '项目名称', icon: '图标', color: '颜色', description: '项目说明', save: '保存', cancel: '取消', files: '项目文件', conversations: '项目内对话', upload: '上传文件', noChats: '还没有对话', noProjects: '还没有项目', undo: '撤销', moved: '已移动', deleted: '已删除', message: '在「{name}」里新建对话', saveFailed: '保存失败，请重试', fileFailed: '文件操作失败' }, 'en-US': { project: 'Projects', pinned: 'Pinned', newProject: 'New project', recent: 'Recent chats', today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', earlier: 'Earlier', all: 'View all', chats: ' chats', newChat: 'New chat', newIn: 'New chat in this project', projectHome: 'Open project home', settings: 'Project settings', remove: 'Delete project', rename: 'Rename', move: 'Move to project', out: 'Remove from project', pin: 'Pin', unpin: 'Unpin', del: 'Delete', back: 'Back', name: 'Project name', icon: 'Icon', color: 'Color', description: 'Project instructions', save: 'Save', cancel: 'Cancel', files: 'Project files', conversations: 'Project chats', upload: 'Upload file', noChats: 'No chats yet', noProjects: 'No projects yet', undo: 'Undo', moved: 'Moved', deleted: 'Deleted', message: 'New chat in “{name}”', saveFailed: 'Could not save. Try again.', fileFailed: 'File operation failed' } };
  function lang() { return window.wpUI && window.wpUI.isChinese && window.wpUI.isChinese() ? 'zh-CN' : 'en-US'; }
  function t(key) { return COPY[lang()][key] || key; }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function id() { return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
  function projectPath(project) { return '__WP_WORKDIR__/' + project.directory; }
  function jsonValue(value) { return value && value.data !== undefined ? value.data : value; }
  async function json(url, init) {
    var response = await request(url, init), body = null;
    try { body = await response.json(); } catch (e) {}
    if (!response.ok || body && body.success === false) throw new Error('request failed');
    return jsonValue(body || {});
  }
  async function fileRead(path) {
    var urls = ['/api/files?path=' + encodeURIComponent(path), '/api/workspace/files?path=' + encodeURIComponent(path), '/api/workspace/file?path=' + encodeURIComponent(path)];
    for (var i = 0; i < urls.length; i++) { try { var value = await json(urls[i]); if (value && (!Array.isArray(value) || value.length)) return value; } catch (e) {} }
    try { return JSON.parse(localStorage.getItem('wp-projects-cache') || '[]'); } catch (e) { return []; }
  }
  async function fileWrite(path, value) {
    var binary = typeof Blob !== 'undefined' && value instanceof Blob;
    var body = binary ? value : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    var inits = [{ method: 'PUT', headers: { 'Content-Type': binary ? (value.type || 'application/octet-stream') : 'application/json' }, body: body }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path, content: body }) }];
    var urls = ['/api/files?path=' + encodeURIComponent(path), '/api/workspace/files?path=' + encodeURIComponent(path), '/api/workspace/file?path=' + encodeURIComponent(path)];
    for (var i = 0; i < urls.length; i++) for (var j = 0; j < inits.length; j++) { try { var r = await request(urls[i], inits[j]); if (r.ok) { try { localStorage.setItem('wp-projects-cache', JSON.stringify(state.projects)); } catch (e) {} return; } } catch (e) {} }
    try { localStorage.setItem('wp-projects-cache', JSON.stringify(state.projects)); } catch (e) {}
    throw new Error('file write failed');
  }
  async function saveProjects() { await fileWrite(FILE, { version: 1, projects: state.projects }); }
  async function loadProjects() {
    var value = await fileRead(FILE); if (value && typeof value.content === 'string') value = value.content; if (typeof value === 'string') { try { value = JSON.parse(value); } catch (e) {} } state.projects = L.normalizeProjects(value); state.loaded = true; renderSoon();
  }
  async function loadConversations() {
    try {
      var value = await json('/api/conversations?limit=10000'), items = value && (value.items || value.data && value.data.items);
      if (!Array.isArray(items)) items = Array.isArray(value) ? value : [];
      state.conversations = items.filter(function (c) { return c && c.id && !(c.extra && (c.extra.team_id || c.extra.teamId || c.extra.is_health_check)); });
      renderSoon();
    } catch (e) { /* Native history remains usable if this optional projection is unavailable. */ }
  }
  async function loadFiles(project) {
    if (Object.prototype.hasOwnProperty.call(state.files, project.id)) return;
    state.files[project.id] = null;
    try {
      var value = await json('/api/files?path=' + encodeURIComponent(projectPath(project))), items = value && (value.items || value.files || value.entries || value);
      if (Array.isArray(items)) state.files[project.id] = items.map(function (item) { return typeof item === 'string' ? item : item.name; }).filter(Boolean);
      renderSoon();
    } catch (e) {}
  }
  function currentProject() { var m = location.hash.match(/^#\/wp-project\/([A-Za-z0-9_-]+)/); return m && state.projects.find(function (p) { return p.id === m[1]; }); }
  function closeMenu() { if (state.menu) { state.menu.remove(); state.menu = null; } }
  function toast(message, undo) {
    var old = document.querySelector('.wp-project-toast'); if (old) old.remove();
    var el = document.createElement('div'); el.className = 'wp-project-toast'; el.textContent = message;
    if (undo) { var b = document.createElement('button'); b.type = 'button'; b.textContent = t('undo'); b.addEventListener('click', function () { undo(); el.remove(); }); el.appendChild(b); }
    document.body.appendChild(el); setTimeout(function () { if (el.isConnected) el.remove(); }, 4200);
  }
  function menuButton(label, action, disabled) { var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.disabled = !!disabled; b.addEventListener('click', function (e) { e.stopPropagation(); action(); }); return b; }
  function openProjectMenu(anchor, project) {
    closeMenu(); var menu = state.menu = document.createElement('div'); menu.className = 'wp-project-menu'; menu.setAttribute('role', 'menu');
    menu.append(menuButton(t('projectHome'), function () { closeMenu(); openHome(project); }), menuButton(t('settings'), function () { closeMenu(); openProjectModal(project); }), menuButton(t('remove'), function () { closeMenu(); deleteProject(project); }));
    document.body.appendChild(menu); var r = anchor.getBoundingClientRect(); menu.style.left = Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth) + 'px'; menu.style.top = Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 4) + 'px';
  }
  function openConversationMenu(anchor, conversation) {
    closeMenu(); var menu = state.menu = document.createElement('div'); menu.className = 'wp-project-menu'; menu.setAttribute('role', 'menu');
    var move = menuButton(t('move'), function () { renderMoveMenu(menu, conversation); });
    menu.append(menuButton(t('rename'), function () { closeMenu(); renameConversation(conversation); }), move, menuButton(conversation.extra && conversation.extra.wp_pinned ? t('unpin') : t('pin'), function () { closeMenu(); pinConversation(conversation); }), menuButton(t('del'), function () { closeMenu(); deleteConversation(conversation); }));
    document.body.appendChild(menu); placeMenu(menu, anchor);
  }
  function renderMoveMenu(menu, conversation) {
    menu.replaceChildren(); menu.append(menuButton('‹ ' + t('back'), function () { openConversationMenu(menu, conversation); }));
    state.projects.forEach(function (project) { if (conversation.extra && conversation.extra.wp_project_id === project.id) return; menu.append(menuButton(project.name, function () { closeMenu(); moveConversation(conversation, project); })); });
    menu.append(menuButton(t('out'), function () { closeMenu(); moveConversation(conversation, null); }), menuButton(t('newProject'), function () { closeMenu(); openProjectModal(null, conversation); }));
  }
  function placeMenu(menu, anchor) { var r = anchor.getBoundingClientRect(); menu.style.left = Math.max(6, Math.min(innerWidth - menu.offsetWidth - 6, r.right - menu.offsetWidth)) + 'px'; menu.style.top = Math.max(6, Math.min(innerHeight - menu.offsetHeight - 6, r.bottom + 4)) + 'px'; }
  async function patchConversation(conversation, patch) {
    var before = conversation.extra || {}; var next = L.mergeExtra(before, patch); conversation.extra = next; renderSoon();
    try { await json('/api/conversations/' + encodeURIComponent(conversation.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra: patch, merge_extra: true }) }); loadConversations(); }
    catch (e) { conversation.extra = before; renderSoon(); toast(t('saveFailed')); }
  }
  function moveConversation(conversation, project) { var previous = conversation.extra && conversation.extra.wp_project_id; patchConversation(conversation, { wp_project_id: project ? project.id : null }); toast(t('moved'), function () { patchConversation(conversation, { wp_project_id: previous || null }); }); }
  function pinConversation(conversation) { patchConversation(conversation, { wp_pinned: !(conversation.extra && conversation.extra.wp_pinned) }); }
  async function renameConversation(conversation) { var value = window.prompt(t('rename'), conversation.name || ''); if (value == null || !value.trim()) return; try { var result = await json('/api/conversations/' + encodeURIComponent(conversation.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value.trim().slice(0, 160) }) }); conversation.name = result.name || value.trim(); renderSoon(); } catch (e) { toast(t('saveFailed')); } }
  async function deleteConversation(conversation) {
    if (!window.confirm(t('del') + '？')) return;
    var index = state.conversations.indexOf(conversation), undone = false;
    state.conversations = state.conversations.filter(function (c) { return c.id !== conversation.id; }); renderSoon();
    toast(t('deleted'), function () { undone = true; state.conversations.splice(index < 0 ? state.conversations.length : index, 0, conversation); renderSoon(); });
    setTimeout(async function () { if (undone) return; try { await json('/api/conversations/' + encodeURIComponent(conversation.id), { method: 'DELETE' }); } catch (e) { state.conversations.splice(index < 0 ? state.conversations.length : index, 0, conversation); renderSoon(); toast(t('saveFailed')); } }, 4100);
  }
  async function deleteProject(project) {
    if (!window.confirm(t('remove') + '？')) return;
    var projectIndex = state.projects.indexOf(project), affected = state.conversations.filter(function (c) { return c.extra && c.extra.wp_project_id === project.id; }), previous = affected.map(function (c) { return { conversation: c, extra: c.extra }; }), undone = false;
    state.projects = state.projects.filter(function (p) { return p.id !== project.id; }); affected.forEach(function (c) { c.extra = L.mergeExtra(c.extra, { wp_project_id: null }); }); state.expanded.delete(project.id); renderSoon();
    toast(t('deleted'), function () { undone = true; state.projects.splice(projectIndex < 0 ? state.projects.length : projectIndex, 0, project); previous.forEach(function (entry) { entry.conversation.extra = entry.extra; }); renderSoon(); saveProjects().catch(function () {}); });
    setTimeout(async function () { if (undone) return; try { await saveProjects(); await Promise.all(affected.map(function (c) { return patchConversation(c, { wp_project_id: null }); })); } catch (e) { toast(t('saveFailed')); } }, 4100);
  }
  function make(tag, cls, content) { var el = document.createElement(tag); if (cls) el.className = cls; if (content != null) el.textContent = content; return el; }
  function relative(value) {
    var at = new Date(value).getTime(); if (!Number.isFinite(at)) return '';
    var minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
    if (minutes < 1) return lang() === 'zh-CN' ? '刚刚' : 'now';
    if (minutes < 60) return minutes + (lang() === 'zh-CN' ? ' 分钟' : 'm');
    if (minutes < 1440) return Math.floor(minutes / 60) + (lang() === 'zh-CN' ? ' 小时' : 'h');
    return Math.floor(minutes / 1440) + (lang() === 'zh-CN' ? ' 天' : 'd');
  }
  function conversationRow(conversation, nested) {
    var selected = (location.hash.match(/^#\/conversation\/([\w-]+)/) || [])[1] === conversation.id;
    var row = make('div', 'wp-project-conversation' + (nested ? ' wp-project-nested' : '') + (selected ? ' wp-project-active' : '')); row.draggable = true; row.dataset.conversation = conversation.id;
    var link = make('button', 'wp-project-conversation-link', window.wpUI && window.wpUI.attachmentSummary ? window.wpUI.attachmentSummary(conversation.name || t('newChat')) : conversation.name || t('newChat')); link.title = link.textContent;
    link.addEventListener('click', function () { location.hash = '#/conversation/' + conversation.id; });
    var more = make('button', 'wp-project-more', '…'); more.setAttribute('aria-label', t('settings')); more.addEventListener('click', function (e) { e.stopPropagation(); openConversationMenu(more, conversation); });
    var stamp = make('span', 'wp-project-time', relative(conversation.modified_at || conversation.updated_at || conversation.created_at));
    row.append(link, stamp, more); row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', conversation.id); row.classList.add('wp-project-dragging'); }); row.addEventListener('dragend', function () { row.classList.remove('wp-project-dragging'); });
    return row;
  }
  function projectRow(project, conversations) {
    var row = make('div', 'wp-project-row' + (currentProject() && currentProject().id === project.id ? ' wp-project-active' : '')); row.dataset.project = project.id; row.draggable = false;
    var toggle = make('button', 'wp-project-toggle'); toggle.innerHTML = '<span class="wp-project-arrow">' + (state.expanded.has(project.id) ? '⌄' : '›') + '</span><span class="wp-project-icon" style="--project-color:' + esc(project.color) + '">' + esc(ICONS[project.icon] || ICONS.folder) + '</span><span class="wp-project-name"></span><span class="wp-project-count">' + conversations.length + '</span>';
    toggle.querySelector('.wp-project-name').textContent = project.name; toggle.title = project.name; toggle.addEventListener('click', function () { if (state.expanded.has(project.id)) state.expanded.delete(project.id); else state.expanded.add(project.id); renderSoon(); });
    var newChat = make('button', 'wp-project-new', '+'); newChat.title = t('newIn'); newChat.addEventListener('click', function (e) { e.stopPropagation(); startProjectChat(project); });
    var more = make('button', 'wp-project-more', '…'); more.addEventListener('click', function (e) { e.stopPropagation(); openProjectMenu(more, project); });
    row.append(toggle, newChat, more); row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('wp-project-drop-target'); }); row.addEventListener('dragleave', function () { row.classList.remove('wp-project-drop-target'); }); row.addEventListener('drop', function (e) { e.preventDefault(); row.classList.remove('wp-project-drop-target'); var c = state.conversations.find(function (x) { return x.id === e.dataTransfer.getData('text/plain'); }); if (c) moveConversation(c, project); });
    if (state.expanded.has(project.id)) { var list = make('div', 'wp-project-chat-list'); conversations.slice(0, 5).forEach(function (c) { list.appendChild(conversationRow(c, true)); }); if (conversations.length > 5) { var all = make('button', 'wp-project-view-all', t('all') + '（' + conversations.length + '）'); all.addEventListener('click', function () { openHome(project); }); list.appendChild(all); } row.appendChild(list); }
    return row;
  }
  function section(title, items, key, root) { if (!items.length) return; root.appendChild(make('div', 'wp-project-time-title', t(title))); var list = make('div', 'wp-project-recent-list'); items.forEach(function (c) { list.appendChild(conversationRow(c, false)); }); list.addEventListener('dragover', function (e) { e.preventDefault(); list.classList.add('wp-project-drop-target'); }); list.addEventListener('dragleave', function () { list.classList.remove('wp-project-drop-target'); }); list.addEventListener('drop', function (e) { e.preventDefault(); list.classList.remove('wp-project-drop-target'); var c = state.conversations.find(function (x) { return x.id === e.dataTransfer.getData('text/plain'); }); if (c) moveConversation(c, null); }); root.appendChild(list); }
  function renderSidebar() {
    var aside = document.querySelector('aside.layout-sider'), scroll = aside && aside.querySelector('[class*="_scrollArea"]'); if (!scroll) return;
    var root = scroll.querySelector('.wp-projects-root'); if (!root) { root = make('div', 'wp-projects-root'); scroll.appendChild(root); }
    scroll.querySelectorAll('.workspace-collapse,.sider-section-label,.chat-history__item').forEach(function (el) { if (!el.closest('.wp-nav') && !el.closest('.wp-projects-root')) el.classList.add('wp-project-native-hidden'); });
    var grouped = L.groupConversations(state.conversations, state.projects, new Date()); root.replaceChildren();
    if (grouped.pinned.length) { root.appendChild(make('div', 'wp-project-time-title', t('pinned'))); var pinned = make('div', 'wp-project-recent-list'); grouped.pinned.forEach(function (c) { pinned.appendChild(conversationRow(c, false)); }); root.appendChild(pinned); }
    var head = make('div', 'wp-project-section-head'), sectionTitle = make('button', 'wp-project-section-title', t('project')); sectionTitle.addEventListener('click', function () { state.collapsed = !state.collapsed; renderSoon(); }); head.append(sectionTitle); var add = make('button', 'wp-project-add', '+'); add.title = t('newProject'); add.addEventListener('click', function () { openProjectModal(); }); var collapse = make('button', 'wp-project-collapse', state.collapsed ? '›' : '⌄'); collapse.addEventListener('click', function () { state.collapsed = !state.collapsed; renderSoon(); }); head.append(add, collapse); root.appendChild(head);
    if (!state.collapsed) { var create = make('button', 'wp-project-create', '＋ ' + t('newProject')); create.addEventListener('click', function () { openProjectModal(); }); root.appendChild(create); if (!state.projects.length) root.appendChild(make('p', 'wp-project-empty', t('noProjects'))); state.projects.forEach(function (p) { root.appendChild(projectRow(p, grouped.projects.get(p.id) || [])); }); }
    var recentHead = make('div', 'wp-project-section-head wp-recent-head'); recentHead.appendChild(make('span', 'wp-project-section-title', t('recent'))); root.appendChild(recentHead);
    section('today', grouped.recent.today, 'today', root); section('yesterday', grouped.recent.yesterday, 'yesterday', root); section('week', grouped.recent.week, 'week', root); section('earlier', grouped.recent.earlier, 'earlier', root);
    if (!state.conversations.length) root.appendChild(make('p', 'wp-project-empty', t('noChats')));
  }
  function openProjectModal(project, moveConversationAfter) {
    closeMenu(); if (state.modal) state.modal.remove(); var backdrop = state.modal = make('div', 'wp-project-backdrop'); var dialog = make('form', 'wp-project-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.innerHTML = '<h2>' + esc(project ? t('settings') : t('newProject')) + '</h2><label>' + esc(t('name')) + '<input name="name" maxlength="120" required></label><label>' + esc(t('icon')) + '<span class="wp-project-options wp-project-icons"></span></label><label>' + esc(t('color')) + '<span class="wp-project-options wp-project-colors"></span></label><label>' + esc(t('description')) + '<textarea name="description" maxlength="4000" rows="4"></textarea></label><div class="wp-project-dialog-actions"><button type="button" data-cancel>' + esc(t('cancel')) + '</button><button type="submit">' + esc(t('save')) + '</button></div>';
    var name = dialog.elements.name, desc = dialog.elements.description, selectedIcon = project ? project.icon : 'folder', selectedColor = project ? project.color : COLORS[0]; name.value = project ? project.name : ''; desc.value = project ? project.description || '' : '';
    Object.keys(ICONS).forEach(function (key) { var b = make('button', 'wp-project-option', ICONS[key]); b.type = 'button'; b.dataset.value = key; b.classList.toggle('selected', key === selectedIcon); b.addEventListener('click', function () { selectedIcon = key; dialog.querySelectorAll('.wp-project-icons .wp-project-option').forEach(function (x) { x.classList.toggle('selected', x === b); }); }); dialog.querySelector('.wp-project-icons').appendChild(b); });
    COLORS.forEach(function (color) { var b = make('button', 'wp-project-option wp-color-option', ''); b.type = 'button'; b.dataset.value = color; b.style.background = color; b.classList.toggle('selected', color === selectedColor); b.addEventListener('click', function () { selectedColor = color; dialog.querySelectorAll('.wp-project-colors .wp-project-option').forEach(function (x) { x.classList.toggle('selected', x === b); }); }); dialog.querySelector('.wp-project-colors').appendChild(b); });
    dialog.querySelector('[data-cancel]').addEventListener('click', closeModal); backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); }); dialog.addEventListener('submit', async function (e) { e.preventDefault(); var value = name.value.trim(); if (!value) return; var p = project || { id: id(), order: state.projects.length }; Object.assign(p, { name: value.slice(0, 120), icon: selectedIcon, color: selectedColor, description: desc.value.slice(0, 4000), directory: L.safeDirectory(value, p.id), updatedAt: new Date().toISOString() }); if (!project) state.projects.push(p); try { await saveProjects(); try { await fileWrite(projectPath(p) + '/CLAUDE.md', p.description || ''); await fileWrite(projectPath(p) + '/AGENTS.md', p.description || ''); } catch (error) { toast(t('fileFailed')); } closeModal(); renderSoon(); if (moveConversationAfter) moveConversation(moveConversationAfter, p); } catch (error) { toast(t('saveFailed')); } }); backdrop.appendChild(dialog); document.body.appendChild(backdrop); name.focus(); }
  function closeModal() { if (state.modal) { state.modal.remove(); state.modal = null; } }
  function openHome(project) { state.home = project; location.hash = '#/wp-project/' + project.id; renderHome(); }
  function startProjectChat(project) { state.pendingProject = project; location.hash = '#/guid'; var timer = setInterval(function () { var input = document.querySelector('[data-testid="guid-input"]'), button = document.querySelector('[data-testid="guid-send-btn"]'); if (!input || !button) return; clearInterval(timer); input.focus(); }, 50); setTimeout(function () { clearInterval(timer); }, 10000); }
  function submitProjectChat(project, input) { state.pendingProject = project; var native = document.querySelector('[data-testid="guid-input"]'); if (!native) { location.hash = '#/guid'; setTimeout(function () { submitProjectChat(project, input); }, 100); return; } Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(native, input); native.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-testid="guid-send-btn"]')?.click(); }
  function renderHome() {
    var project = currentProject(), main = document.querySelector('main.layout-content') || document.querySelector('.layout-content'); if (!main) return;
    var old = main.querySelector('.wp-project-home'); if (!project) { if (old) old.remove(); return; } if (!old) { old = make('div', 'wp-project-home'); main.appendChild(old); }
    var chats = state.conversations.filter(function (c) { return c.extra && c.extra.wp_project_id === project.id; }); old.replaceChildren(); var header = make('header', 'wp-project-home-header'); header.innerHTML = '<span class="wp-project-home-icon" style="--project-color:' + esc(project.color) + '">' + esc(ICONS[project.icon] || ICONS.folder) + '</span><h1></h1>'; header.querySelector('h1').textContent = project.name; var more = make('button', 'wp-project-more', '…'); more.addEventListener('click', function () { openProjectMenu(more, project); }); header.append(more); old.appendChild(header);
    var form = make('form', 'wp-project-home-input'); var input = make('input'); input.placeholder = t('message').replace('{name}', project.name); var send = make('button', '', '↑'); send.type = 'submit'; form.append(input, send); form.addEventListener('submit', function (e) { e.preventDefault(); if (input.value.trim()) submitProjectChat(project, input.value.trim()); }); old.appendChild(form);
    var card = make('section', 'wp-project-card'); card.innerHTML = '<div class="wp-project-card-heading"><h2>' + esc(t('description')) + '</h2></div><p></p>'; card.querySelector('p').textContent = project.description || t('noChats'); var edit = make('button', 'wp-project-edit', lang() === 'zh-CN' ? '编辑' : 'Edit'); edit.addEventListener('click', function () { openProjectModal(project); }); card.querySelector('.wp-project-card-heading').appendChild(edit); old.appendChild(card);
    var listedFiles = state.files[project.id] || [], files = make('section', 'wp-project-card'); files.innerHTML = '<h2>' + esc(t('files')) + '</h2><p class="wp-project-file-list">' + esc(listedFiles.length ? listedFiles.join('、') : t('noChats')) + '</p>'; var upload = make('input'); upload.type = 'file'; upload.multiple = true; upload.className = 'wp-project-upload'; upload.addEventListener('change', function () { Array.from(upload.files || []).forEach(function (file) { var name = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120); fileWrite(projectPath(project) + '/' + name, file).then(function () { state.files[project.id] = (state.files[project.id] || []).concat(name); renderSoon(); }).catch(function () { toast(t('fileFailed')); }); }); }); files.append(upload); old.appendChild(files);
    var list = make('section', 'wp-project-card'); list.innerHTML = '<h2>' + esc(t('conversations')) + '</h2>'; if (!chats.length) list.appendChild(make('p', 'wp-project-empty', t('noChats'))); chats.forEach(function (c) { var row = conversationRow(c, false); var summary = make('span', 'wp-project-summary', String(c.preview_text || c.summary || '').replace(/\s+/g, ' ').slice(0, 120)); row.appendChild(summary); list.appendChild(row); }); old.appendChild(list); loadFiles(project);
  }
  var domObserver = null, renderPending = false, rendering = false;
  function renderSoon() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false; if (rendering) return;
      rendering = true; if (domObserver) domObserver.disconnect();
      renderSidebar(); renderHome(); hookSearch();
      rendering = false; if (domObserver) domObserver.observe(document.body, { childList: true, subtree: true });
    });
  }
  function hookSearch() {
    var results = document.querySelector('.wp-search-results'), input = document.querySelector('[data-wp-nav="search"] input'); if (!results || !input || results.dataset.wpProjects) return; results.dataset.wpProjects = '1'; var observer = new MutationObserver(function () { var q = input.value.trim().toLowerCase(); if (!q) return; state.projects.filter(function (p) { return p.name.toLowerCase().includes(q); }).slice(0, 8).forEach(function (p) { if (results.querySelector('[data-project-result="' + p.id + '"]')) return; var b = make('button', 'wp-search-result'); b.dataset.projectResult = p.id; b.innerHTML = '<span class="wp-search-head"><span class="wp-search-title"></span><span class="wp-search-time">' + esc(t('project')) + '</span></span>'; b.querySelector('.wp-search-title').textContent = p.name; b.addEventListener('click', function () { openHome(p); }); results.insertBefore(b, results.firstChild); }); }); observer.observe(results, { childList: true }); }
  window.wpProjects = { newConversationExtra: function () { var p = state.pendingProject; state.pendingProject = null; return p ? { workspace: projectPath(p), custom_workspace: true, wp_project_id: p.id } : null; }, refresh: function () { loadConversations(); }, logic: L };
  document.addEventListener('click', function (e) { if (state.menu && !state.menu.contains(e.target)) closeMenu(); });
  window.addEventListener('hashchange', function () { renderHome(); renderSoon(); });
  domObserver = new MutationObserver(function () { if (!rendering) renderSoon(); });
  domObserver.observe(document.body, { childList: true, subtree: true });
  loadProjects(); loadConversations(); setInterval(loadConversations, 5000); renderSoon();
})();
