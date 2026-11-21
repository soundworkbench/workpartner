/* Projects sidebar for WorkPartner.  It deliberately uses the native conversation API. */
(function () {
  'use strict';
  var L = window.WpProjectsLogic, request = window.fetch.bind(window);
  var FILE = '__WP_WORKDIR__/.workpartner-projects.json';
  var state = { projects: [], conversations: [], files: {}, expanded: new Set(), collapsed: false, loaded: false,
    drafts: {}, homeSubmission: null, pendingProject: null, modal: null, menu: null, home: null };
  var ICONS = {
    folder: '<path d="M3 6h6l2 2h10v12H3z"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
    book: '<path d="M12 5v16M3 4c4-1 6-1 9 1 3-2 5-2 9-1v15c-4-1-6-1-9 2-3-3-5-3-9-2z"/>',
    chart: '<path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4"/>',
    flag: '<path d="M5 22V3c5-3 9 3 15 0v11c-6 3-10-3-15 0"/>'
  };
  function icon(key) { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[key] || ICONS.folder) + '</svg>'; }
  var COLORS = ['#9b9b87', '#9b8f87', '#879b9b', '#9b8794', '#8f9b87', '#93879b', '#9b9687', '#87919b'];
  var COPY = { 'zh-CN': { project: '项目', pinned: '置顶', newProject: '新建项目', recent: '最近对话', today: '今天', yesterday: '昨天', week: '前 7 天', earlier: '更早', all: '查看全部', chats: '条对话', newChat: '新建对话', newIn: '在此项目新建对话', projectHome: '打开项目主页', settings: '项目设置', remove: '删除项目', rename: '重命名', move: '移到项目', out: '移出项目', pin: '置顶', unpin: '取消置顶', del: '删除', back: '返回', name: '项目名称', icon: '图标', color: '颜色', description: '项目说明', save: '保存', cancel: '取消', files: '项目文件', conversations: '项目内对话', upload: '上传文件', noChats: '还没有对话', noFiles: '还没有文件', noDescription: '还没有项目说明', archive: '归档', cron: '创建定时任务', createFailed: '新建对话失败，请重试。输入内容已保留', loadFailed: '项目清单读取失败，请刷新后重试', noProjects: '还没有项目', undo: '撤销', moved: '已移动', deleted: '已删除', message: '在「{name}」里新建对话', saveFailed: '保存失败，请重试', fileFailed: '文件操作失败' }, 'en-US': { project: 'Projects', pinned: 'Pinned', newProject: 'New project', recent: 'Recent chats', today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', earlier: 'Earlier', all: 'View all', chats: ' chats', newChat: 'New chat', newIn: 'New chat in this project', projectHome: 'Open project home', settings: 'Project settings', remove: 'Delete project', rename: 'Rename', move: 'Move to project', out: 'Remove from project', pin: 'Pin', unpin: 'Unpin', del: 'Delete', back: 'Back', name: 'Project name', icon: 'Icon', color: 'Color', description: 'Project instructions', save: 'Save', cancel: 'Cancel', files: 'Project files', conversations: 'Project chats', upload: 'Upload file', noChats: 'No chats yet', noFiles: 'No files yet', noDescription: 'No instructions yet', archive: 'Archive', cron: 'Create scheduled task', createFailed: 'Could not create chat. Your draft was kept.', loadFailed: 'Could not load projects. Reload to retry.', noProjects: 'No projects yet', undo: 'Undo', moved: 'Moved', deleted: 'Deleted', message: 'New chat in “{name}”', saveFailed: 'Could not save. Try again.', fileFailed: 'File operation failed' } };
  function lang() { return window.wpUI && window.wpUI.isChinese && window.wpUI.isChinese() ? 'zh-CN' : 'en-US'; }
  function t(key) { return COPY[lang()][key] || key; }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function id() { return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
  function projectPath(project) { return '__WP_WORKDIR__/' + project.directory; }
  function jsonValue(value) { return value && value.data !== undefined ? value.data : value; }
  async function json(url, init) {
    var response = await request(url, init), body = null;
    try { body = await response.json(); } catch (e) {}
    if (!response.ok || body && body.success === false) { var error = new Error(body && body.error && body.error.message || 'request failed'); error.status = response.status; throw error; }
    return jsonValue(body);
  }
  function post(url, value) { return json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); }
  function fileRead(path) { return post('/api/fs/read', { path: path }); }
  async function fileWrite(path, value) {
    var data = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (await post('/api/fs/write', { path: path, data: data }) !== true) throw new Error('file write not confirmed');
  }
  async function saveProjects(projects) {
    await fileWrite(FILE, { version: 1, projects: projects });
    state.projects = projects;
    try { localStorage.setItem('wp-projects-cache', JSON.stringify({ version: 1, projects: projects })); } catch (e) {}
    renderSoon();
  }
  async function loadProjects() {
    try {
      var value = await fileRead(FILE);
      if (value === null) value = { version: 1, projects: [] };
      else { value = JSON.parse(value); if (!value || !Array.isArray(value.projects)) throw new Error('invalid manifest'); }
      state.projects = L.normalizeProjects(value); state.loaded = true; renderSoon();
    } catch (e) { toast(t('loadFailed')); }
  }
  // /fs/write validates an existing parent and does not mkdir. The native
  // explorer's fs/mkdir RPC is the directory operation in 2.1.47.
  async function withRootEntry(action) {
    var items = await json('/api/conversations?limit=10000'); items = items.items || [];
    var conversation = items.find(function (c) { return c.project_id && c.extra && c.extra.workspace === '__WP_WORKDIR__'; });
    var temporary;
    try {
      // An empty account has no native workspace project yet. Register it with
      // a metadata-only conversation (no runtime/messages), then clean it up.
      if (!conversation) temporary = conversation = await post('/api/conversations', { type: 'acp', name: 'Project workspace', extra: { backend: 'claude', workspace: '__WP_WORKDIR__', custom_workspace: true, is_health_check: true } });
      var project = await json('/api/projects/' + encodeURIComponent(conversation.project_id));
      if (!project.explorer || !project.explorer.workspace_pe_id) throw new Error('workspace entry unavailable');
      return await action(project.explorer.workspace_pe_id);
    } finally {
      if (temporary) await json('/api/conversations/' + encodeURIComponent(temporary.id), { method: 'DELETE' });
    }
  }
  function fsRpc(method, params) {
    return new Promise(function (resolve, reject) {
      var socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      var settled = false, timer = setTimeout(function () { finish(new Error('filesystem timeout')); }, 10000);
      function finish(error, result) { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(result); }
      socket.onopen = function () { socket.send(JSON.stringify({ name: 'fs', data: { jsonrpc: '2.0', id: 1, method: method, params: params } })); };
      socket.onmessage = function (event) { try { var frame = JSON.parse(event.data); frame = { name: frame.name || frame.event, data: frame.data || frame.payload }; if (frame.name !== 'fs' || !frame.data || frame.data.id !== 1) return; if (frame.data.error) finish(new Error(frame.data.error.message)); else finish(null, frame.data.result); } catch (e) { finish(e); } };
      socket.onerror = socket.onclose = function () { finish(new Error('filesystem disconnected')); };
    });
  }
  async function ensureDirectory(project) {
    var entries = await post('/api/fs/dir', { dir: '__WP_WORKDIR__', root: '__WP_WORKDIR__' });
    if (!Array.isArray(entries)) throw new Error('invalid directory listing');
    if (entries.some(function (e) { return e.name === project.directory && (e.is_dir || e.isDir); })) return;
    await withRootEntry(function (pe) { return fsRpc('fs/mkdir', { dir: { pe_id: pe, relative_path: project.directory } }); });
    await post('/api/fs/dir', { dir: projectPath(project), root: '__WP_WORKDIR__' });
  }
  async function uploadFile(project, file) {
    var name = L.safeFilename(file.name), form = new FormData();
    if (/^(text\/|application\/(json|xml))/.test(file.type) || /\.(md|txt|csv|json|yaml|yml|js|ts|py|html|css)$/i.test(name)) { await fileWrite(projectPath(project) + '/' + name, await file.text()); delete state.files[project.id]; await loadFiles(project); return; }
    form.append('file_name', name); form.append('file', file, name);
    var path = await json('/api/fs/upload', { method: 'POST', body: form });
    if (typeof path !== 'string' || !path) throw new Error('upload not confirmed');
    await withRootEntry(async function (pe) {
      var result = await post('/api/fs/copy', { file_paths: [path], target: { pe_id: pe, relative_path: project.directory } });
      if (!result || !Array.isArray(result.copied_files) || !Array.isArray(result.failed_files) || result.failed_files.length || result.copied_files.length !== 1) throw new Error('copy not confirmed');
      // Native uploads may append an AionUI timestamp. Restore the selected
      // filename via the same explorer action used by its Rename menu.
      var copiedName = result.copied_files[0].split(/[\\/]/).pop();
      if (!copiedName || copiedName === '.' || copiedName === '..') throw new Error('invalid copied filename');
      if (copiedName !== name) await fsRpc('fs/rename', { from: { pe_id: pe, relative_path: project.directory + '/' + copiedName }, to: { pe_id: pe, relative_path: project.directory + '/' + name } });
    });
    delete state.files[project.id]; await loadFiles(project);
  }
  var messageTimes = new Map();
  async function loadConversations() {
    try {
      var value = await json('/api/conversations?limit=10000'), items = value && (value.items || value.data && value.data.items);
      if (!Array.isArray(items)) items = Array.isArray(value) ? value : [];
      state.conversations = items.filter(function (c) { return c && c.id && !(c.extra && (c.extra.team_id || c.extra.teamId || c.extra.is_health_check)); });
      await Promise.all(state.conversations.filter(function (c) { return c.extra && c.extra.wp_activity_at; }).map(async function (c) {
        var revision = c.modified_at || c.updated_at, cached = messageTimes.get(c.id);
        if (!cached || cached.revision !== revision) {
          try { cached = { revision: revision, time: await conversationActivity(c) }; messageTimes.set(c.id, cached); } catch (e) { return; }
        }
        c.wp_last_message_at = cached.time;
      }));
      renderSoon();
    } catch (e) { /* Native history remains usable if this optional projection is unavailable. */ }
  }
  async function loadFiles(project) {
    if (Object.prototype.hasOwnProperty.call(state.files, project.id)) return;
    state.files[project.id] = null;
    try {
      var items = await post('/api/fs/dir', { dir: projectPath(project), root: '__WP_WORKDIR__' });
      if (Array.isArray(items)) state.files[project.id] = items.map(function (item) { return typeof item === 'string' ? item : item.name; }).filter(Boolean);
      renderSoon();
    } catch (e) { state.files[project.id] = []; toast(t('fileFailed')); }
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
    menu.append(menuButton(t('rename'), function () { closeMenu(); renameConversation(conversation); }), menuButton(t('archive'), function () { closeMenu(); archiveConversation(conversation); }), menuButton(t('cron'), function () { closeMenu(); if (window.wpProjectCreateCronTask) { window.wpProjectCreateCronTask(conversation); closeDrawer(); } else toast(t('saveFailed')); }), move, menuButton(L.pinned(conversation) ? t('unpin') : t('pin'), function () { closeMenu(); pinConversation(conversation); }), menuButton(t('del'), function () { closeMenu(); deleteConversation(conversation); }));
    document.body.appendChild(menu); placeMenu(menu, anchor);
  }
  function renderMoveMenu(menu, conversation) {
    menu.replaceChildren(); menu.append(menuButton('‹ ' + t('back'), function () { openConversationMenu(menu, conversation); }));
    state.projects.forEach(function (project) { if (conversation.extra && conversation.extra.wp_project_id === project.id) return; menu.append(menuButton(project.name, function () { closeMenu(); moveConversation(conversation, project); })); });
    menu.append(menuButton(t('out'), function () { closeMenu(); moveConversation(conversation, null); }), menuButton(t('newProject'), function () { closeMenu(); openProjectModal(null, conversation); }));
  }
  function placeMenu(menu, anchor) { var r = anchor.getBoundingClientRect(); menu.style.left = Math.max(6, Math.min(innerWidth - menu.offsetWidth - 6, r.right - menu.offsetWidth)) + 'px'; menu.style.top = Math.max(6, Math.min(innerHeight - menu.offsetHeight - 6, r.bottom + 4)) + 'px'; }
  async function conversationActivity(conversation) {
    var data = await json('/api/conversations/' + encodeURIComponent(conversation.id) + '/messages?limit=1&content_mode=compact');
    var items = data.items || []; return items.length && items[items.length - 1].created_at || L.activityTime(conversation);
  }
  async function patchConversation(conversation, patch) {
    try {
      var activity; try { activity = await conversationActivity(conversation); } catch (e) { activity = L.activityTime(conversation); } patch = Object.assign({ wp_activity_at: activity }, patch);
      var result = await json('/api/conversations/' + encodeURIComponent(conversation.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra: patch, merge_extra: true }) });
      Object.assign(conversation, result); conversation.wp_last_message_at = activity; state.conversations = state.conversations.map(function (c) { return c.id === conversation.id ? conversation : c; });
      if (window.wpChatEvents) window.wpChatEvents.emit('chat.history.refresh'); renderSoon(); return true;
    } catch (e) { toast(t('saveFailed')); await loadConversations(); return false; }
  }
  async function moveConversation(conversation, project) {
    var previous = conversation.extra && conversation.extra.wp_project_id;
    if (await patchConversation(conversation, { wp_project_id: project ? project.id : null })) toast(t('moved'), function () { patchConversation(conversation, { wp_project_id: previous || null }); });
  }
  function pinConversation(conversation) { var pinned = !L.pinned(conversation); return patchConversation(conversation, { pinned: pinned, pinned_at: pinned ? Date.now() : null, wp_pinned: null }); }
  async function archiveConversation(conversation) { if (window.wpArchive) { await window.wpArchive.toggle(conversation); await loadConversations(); } }
  async function renameConversation(conversation) { var value = window.prompt(t('rename'), conversation.name || ''); if (value == null || !value.trim()) return; try { var result = await json('/api/conversations/' + encodeURIComponent(conversation.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value.trim().slice(0, 160) }) }); conversation.name = result.name || value.trim(); renderSoon(); } catch (e) { toast(t('saveFailed')); } }
  async function deleteConversation(conversation) {
    if (!window.confirm(t('del') + '？')) return;
    var index = state.conversations.indexOf(conversation), undone = false;
    state.conversations = state.conversations.filter(function (c) { return c.id !== conversation.id; }); renderSoon();
    toast(t('deleted'), function () { undone = true; state.conversations.splice(index < 0 ? state.conversations.length : index, 0, conversation); renderSoon(); });
    setTimeout(async function () { if (undone) return; try { await json('/api/conversations/' + encodeURIComponent(conversation.id), { method: 'DELETE' }); } catch (e) { state.conversations.splice(index < 0 ? state.conversations.length : index, 0, conversation); renderSoon(); toast(t('saveFailed')); } }, 4100);
  }
  function confirmProject(project) {
    return new Promise(function (resolve) {
      var backdrop = make('div', 'wp-project-backdrop'), dialog = make('section', 'wp-project-dialog');
      dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', t('remove') + '「' + project.name + '」');
      dialog.append(make('h2', '', t('remove') + '「' + project.name + '」？'));
      var actions = make('div', 'wp-project-dialog-actions');
      function done(value) { backdrop.remove(); resolve(value); }
      actions.append(menuButton(t('cancel'), function () { done(false); }), menuButton(t('remove'), function () { done(true); }));
      dialog.append(actions); backdrop.append(dialog); document.body.append(backdrop); actions.firstChild.focus();
      backdrop.addEventListener('keydown', function (e) { if (e.key === 'Escape') done(false); });
    });
  }
  async function deleteProject(project) {
    if (!await confirmProject(project)) return;
    var affected = state.conversations.filter(function (c) { return c.extra && c.extra.wp_project_id === project.id; });
    // Clear memberships even when saving the manifest fails. Keep the project
    // available for retry if any part fails; never leave invisible ownership.
    var results = await Promise.all(affected.map(function (c) { return patchConversation(c, { wp_project_id: null }); }));
    if (results.some(function (ok) { return !ok; })) return;
    try {
      await saveProjects(state.projects.filter(function (p) { return p.id !== project.id; }));
      if (location.hash === '#/wp-project/' + project.id) location.hash = '#/guid';
      state.expanded.delete(project.id);
      toast(t('deleted'), async function () {
        try { await saveProjects(state.projects.concat(project)); await Promise.all(affected.map(function (c) { return patchConversation(c, { wp_project_id: project.id }); })); }
        catch (e) { toast(t('saveFailed')); }
      });
    } catch (e) { toast(t('saveFailed')); }
  }
  function make(tag, cls, content) { var el = document.createElement(tag); if (cls) el.className = cls; if (content != null) el.textContent = content; return el; }
  function relative(value) {
    var at = new Date(value).getTime(); if (!Number.isFinite(at)) return '';
    var minutes = Math.max(0, Math.floor((Date.now() - at) / 60000));
    if (minutes < 1) return lang() === 'zh-CN' ? '刚刚' : 'now';
    if (minutes < 60) return minutes + (lang() === 'zh-CN' ? '分钟' : 'm');
    if (minutes < 1440) return Math.floor(minutes / 60) + (lang() === 'zh-CN' ? '小时' : 'h');
    return Math.floor(minutes / 1440) + (lang() === 'zh-CN' ? '天' : 'd');
  }
  function conversationRow(conversation, nested) {
    var selected = (location.hash.match(/^#\/conversation\/([\w-]+)/) || [])[1] === conversation.id;
    var row = make('div', 'wp-project-conversation' + (nested ? ' wp-project-nested' : '') + (selected ? ' wp-project-active' : '')); row.draggable = true; row.dataset.conversation = conversation.id;
    var link = make('button', 'wp-project-conversation-link', window.wpUI && window.wpUI.attachmentSummary ? window.wpUI.attachmentSummary(conversation.name || t('newChat')) : conversation.name || t('newChat')); link.title = link.textContent;
    link.addEventListener('click', function () { location.hash = '#/conversation/' + conversation.id; closeDrawer(); });
    var more = make('button', 'wp-project-more', '…'); more.setAttribute('aria-label', t('settings')); more.addEventListener('click', function (e) { e.stopPropagation(); openConversationMenu(more, conversation); });
    var stamp = make('span', 'wp-project-time', relative(L.activityTime(conversation)));
    var archive = make('button', 'wp-project-archive'); archive.innerHTML = window.wpArchive ? window.wpArchive.icon : ''; archive.title = t('archive'); archive.setAttribute('aria-label', t('archive')); archive.addEventListener('click', function () { archiveConversation(conversation); });
    row.append(link, stamp, archive, more); row.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', conversation.id); row.classList.add('wp-project-dragging'); }); row.addEventListener('dragend', function () { row.classList.remove('wp-project-dragging'); });
    return row;
  }
  function projectRow(project, conversations) {
    var row = make('div', 'wp-project-row' + (currentProject() && currentProject().id === project.id ? ' wp-project-active' : '')); row.dataset.project = project.id; row.draggable = false;
    var toggle = make('button', 'wp-project-toggle'); toggle.innerHTML = '<span class="wp-project-arrow">' + (state.expanded.has(project.id) ? '⌄' : '›') + '</span><span class="wp-project-icon" style="--project-color:' + esc(project.color) + '">' + icon(project.icon) + '</span><span class="wp-project-name"></span><span class="wp-project-count">' + conversations.length + '</span>';
    toggle.querySelector('.wp-project-name').textContent = project.name; toggle.title = project.name; toggle.addEventListener('click', function () { if (state.expanded.has(project.id)) state.expanded.delete(project.id); else state.expanded.add(project.id); renderSoon(); });
    var newChat = make('button', 'wp-project-new', '+'); newChat.title = t('newIn'); newChat.addEventListener('click', function (e) { e.stopPropagation(); startProjectChat(project); });
    var more = make('button', 'wp-project-more', '…'); more.addEventListener('click', function (e) { e.stopPropagation(); openProjectMenu(more, project); });
    row.append(toggle, newChat, more); row.addEventListener('dragover', function (e) { e.preventDefault(); row.classList.add('wp-project-drop-target'); }); row.addEventListener('dragleave', function () { row.classList.remove('wp-project-drop-target'); }); row.addEventListener('drop', function (e) { e.preventDefault(); row.classList.remove('wp-project-drop-target'); var c = state.conversations.find(function (x) { return x.id === e.dataTransfer.getData('text/plain'); }); if (c) moveConversation(c, project); });
    if (state.expanded.has(project.id)) { var list = make('div', 'wp-project-chat-list'); conversations.slice(0, 5).forEach(function (c) { list.appendChild(conversationRow(c, true)); }); if (conversations.length > 5) { var all = make('button', 'wp-project-view-all', t('all') + '（' + conversations.length + '）'); all.addEventListener('click', function () { openHome(project); }); list.appendChild(all); } row.appendChild(list); }
    return row;
  }
  function section(title, items, key, root) { if (!items.length) return; root.appendChild(make('div', 'wp-project-time-title', t(title))); var list = make('div', 'wp-project-recent-list'); items.forEach(function (c) { list.appendChild(conversationRow(c, false)); }); list.addEventListener('dragover', function (e) { e.preventDefault(); list.classList.add('wp-project-drop-target'); }); list.addEventListener('dragleave', function () { list.classList.remove('wp-project-drop-target'); }); list.addEventListener('drop', function (e) { e.preventDefault(); list.classList.remove('wp-project-drop-target'); var c = state.conversations.find(function (x) { return x.id === e.dataTransfer.getData('text/plain'); }); if (c) moveConversation(c, null); }); root.appendChild(list); }
  function renderSidebar() {
    if (!state.loaded) return;
    var aside = document.querySelector('aside.layout-sider'), scroll = aside && aside.querySelector('[class*="_scrollArea"]'); if (!scroll) return;
    var root = scroll.querySelector('.wp-projects-root'); if (!root) { root = make('div', 'wp-projects-root'); scroll.appendChild(root); }
    scroll.querySelectorAll('.workspace-collapse,.sider-section-label,.chat-history__item').forEach(function (el) { if (!el.closest('.wp-nav') && !el.closest('.wp-projects-root')) el.classList.add('wp-project-native-hidden'); });
    var visible = state.conversations.filter(function (c) { return !window.wpArchive || !window.wpArchive.archived(c); });
    var signature = JSON.stringify([state.projects, visible, Array.from(state.expanded), state.collapsed, lang(), location.hash, Math.floor(Date.now() / 60000)]);
    if (root.wpSignature === signature) return; root.wpSignature = signature;
    var grouped = L.groupConversations(visible, state.projects, new Date()); root.replaceChildren();
    if (grouped.pinned.length) { root.appendChild(make('div', 'wp-project-time-title', t('pinned'))); var pinned = make('div', 'wp-project-recent-list'); grouped.pinned.forEach(function (c) { pinned.appendChild(conversationRow(c, false)); }); root.appendChild(pinned); }
    var head = make('div', 'wp-project-section-head'), sectionTitle = make('button', 'wp-project-section-title', t('project')); sectionTitle.addEventListener('click', function () { state.collapsed = !state.collapsed; renderSoon(); }); head.append(sectionTitle); var add = make('button', 'wp-project-add', '+'); add.title = t('newProject'); add.addEventListener('click', function () { openProjectModal(); }); var collapse = make('button', 'wp-project-collapse', state.collapsed ? '›' : '⌄'); collapse.addEventListener('click', function () { state.collapsed = !state.collapsed; renderSoon(); }); head.append(add, collapse); root.appendChild(head);
    if (!state.collapsed) { var create = make('button', 'wp-project-create'); create.innerHTML = icon('folder') + '<span>' + esc(t('newProject')) + '</span>'; create.addEventListener('click', function () { openProjectModal(); }); root.appendChild(create); if (!state.projects.length) root.appendChild(make('p', 'wp-project-empty', t('noProjects'))); state.projects.forEach(function (p) { root.appendChild(projectRow(p, grouped.projects.get(p.id) || [])); }); }
    var recentHead = make('div', 'wp-project-section-head wp-recent-head'); recentHead.appendChild(make('span', 'wp-project-section-title', t('recent'))); root.appendChild(recentHead);
    section('today', grouped.recent.today, 'today', root); section('yesterday', grouped.recent.yesterday, 'yesterday', root); section('week', grouped.recent.week, 'week', root); section('earlier', grouped.recent.earlier, 'earlier', root);
    if (!state.conversations.length) root.appendChild(make('p', 'wp-project-empty', t('noChats')));
  }
  async function persistProject(project) {
    await ensureDirectory(project);
    await fileWrite(projectPath(project) + '/CLAUDE.md', project.description);
    await fileWrite(projectPath(project) + '/AGENTS.md', project.description);
    var exists = state.projects.some(function (p) { return p.id === project.id; });
    await saveProjects(exists ? state.projects.map(function (p) { return p.id === project.id ? project : p; }) : state.projects.concat(project));
  }
  function openProjectModal(project, moveConversationAfter) {
    closeMenu(); if (state.modal) state.modal.remove(); var backdrop = state.modal = make('div', 'wp-project-backdrop'); var dialog = make('form', 'wp-project-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.innerHTML = '<h2>' + esc(project ? t('settings') : t('newProject')) + '</h2><label>' + esc(t('name')) + '<input name="name" maxlength="120" required></label><label>' + esc(t('icon')) + '<span class="wp-project-options wp-project-icons"></span></label><label>' + esc(t('color')) + '<span class="wp-project-options wp-project-colors"></span></label><label>' + esc(t('description')) + '<textarea name="description" maxlength="4000" rows="4"></textarea></label><div class="wp-project-dialog-actions"><button type="button" data-cancel>' + esc(t('cancel')) + '</button><button type="submit">' + esc(t('save')) + '</button></div>';
    var draftId = project ? project.id : id();
    var name = dialog.elements.name, desc = dialog.elements.description, selectedIcon = project ? project.icon : 'folder', selectedColor = project ? project.color : COLORS[0]; name.value = project ? project.name : ''; desc.value = project ? project.description || '' : '';
    Object.keys(ICONS).forEach(function (key) { var b = make('button', 'wp-project-option'); b.innerHTML = icon(key); b.setAttribute('aria-label', key); b.type = 'button'; b.dataset.value = key; b.classList.toggle('selected', key === selectedIcon); b.addEventListener('click', function () { selectedIcon = key; dialog.querySelectorAll('.wp-project-icons .wp-project-option').forEach(function (x) { x.classList.toggle('selected', x === b); }); }); dialog.querySelector('.wp-project-icons').appendChild(b); });
    COLORS.forEach(function (color) { var b = make('button', 'wp-project-option wp-color-option', ''); b.type = 'button'; b.dataset.value = color; b.style.background = color; b.classList.toggle('selected', color === selectedColor); b.addEventListener('click', function () { selectedColor = color; dialog.querySelectorAll('.wp-project-colors .wp-project-option').forEach(function (x) { x.classList.toggle('selected', x === b); }); }); dialog.querySelector('.wp-project-colors').appendChild(b); });
    dialog.querySelector('[data-cancel]').addEventListener('click', closeModal);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    dialog.addEventListener('submit', async function (e) {
      e.preventDefault(); var value = name.value.trim(), save = dialog.querySelector('[type=submit]'); if (!value || save.disabled) return;
      save.disabled = true;
      var p = Object.assign({}, project || { id: draftId, order: state.projects.length });
      Object.assign(p, { name: value.slice(0, 120), icon: selectedIcon, color: selectedColor, description: desc.value.slice(0, 4000), directory: project ? project.directory : L.safeDirectory(value, p.id), updatedAt: new Date().toISOString() });
      try {
        await persistProject(p);
        delete state.files[p.id]; closeModal(); renderSoon();
        if (moveConversationAfter) await moveConversation(moveConversationAfter, p);
      } catch (error) { toast(t('saveFailed')); }
      finally { save.disabled = false; }
    }); backdrop.appendChild(dialog); document.body.appendChild(backdrop); name.focus();
  }
  function closeModal() { if (state.modal) { state.modal.remove(); state.modal = null; } }
  function closeDrawer() { if (window.wpCloseDrawer) window.wpCloseDrawer(); }
  function openHome(project) { closeDrawer(); state.home = project; location.hash = '#/wp-project/' + project.id; renderHome(); }
  function startProjectChat(project) { state.homeSubmission = null; closeDrawer(); state.pendingProject = project; location.hash = '#/guid'; var timer = setInterval(function () { var input = document.querySelector('[data-testid="guid-input"]'), button = document.querySelector('[data-testid="guid-send-btn"]'); if (!input || !button) return; clearInterval(timer); input.focus(); }, 50); setTimeout(function () { clearInterval(timer); }, 10000); }
  async function submitProjectChat(project, input) {
    state.pendingProject = project; state.homeSubmission = project.id; state.drafts[project.id] = input; closeDrawer();
    var native = document.querySelector('[data-testid="guid-input"]');
    if (!native) {
      location.hash = '#/guid';
      for (var i = 0; i < 100 && !native; i++) { await new Promise(function (done) { setTimeout(done, 50); }); native = document.querySelector('[data-testid="guid-input"]'); }
    }
    var send = document.querySelector('[data-testid="guid-send-btn"]');
    if (!native || !send) { toast(t('createFailed')); return; }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(native, input);
    native.dispatchEvent(new Event('input', { bubbles: true }));
    // Let React enable its submit action after the input event.
    setTimeout(function () { if (send.disabled) toast(t('createFailed')); else send.click(); }, 0);
  }
  function renderHome() {
    var project = currentProject(), main = document.querySelector('main.layout-content') || document.querySelector('.layout-content'); if (!main) return;
    var old = main.querySelector('.wp-project-home'); if (!project) { if (old) old.remove(); return; } if (!old) { old = make('div', 'wp-project-home'); main.appendChild(old); }
    var chats = state.conversations.filter(function (c) { return c.extra && !c.extra.wp_archived && c.extra.wp_project_id === project.id; });
    var signature = JSON.stringify([project, chats, state.files[project.id], state.drafts[project.id], lang(), Math.floor(Date.now() / 60000)]);
    if (old.wpSignature === signature || old.dataset.project === project.id && old.contains(document.activeElement)) return;
    old.dataset.project = project.id; old.wpSignature = signature; old.replaceChildren(); var header = make('header', 'wp-project-home-header'); header.innerHTML = '<span class="wp-project-home-icon" style="--project-color:' + esc(project.color) + '">' + icon(project.icon) + '</span><h1></h1>'; header.querySelector('h1').textContent = project.name; var more = make('button', 'wp-project-more', '…'); more.addEventListener('click', function () { openProjectMenu(more, project); }); header.append(more); old.appendChild(header);
    var form = make('form', 'wp-project-home-input'); var input = make('input'); input.value = state.drafts[project.id] || ''; input.addEventListener('input', function () { state.drafts[project.id] = input.value; }); input.addEventListener('blur', renderSoon); input.placeholder = t('message').replace('{name}', project.name); var send = make('button', '', '↑'); send.type = 'submit'; form.append(input, send); form.addEventListener('submit', function (e) { e.preventDefault(); if (input.value.trim()) submitProjectChat(project, input.value.trim()); }); old.appendChild(form);
    var card = make('section', 'wp-project-card'); card.innerHTML = '<div class="wp-project-card-heading"><h2>' + esc(t('description')) + '</h2></div><p></p>'; card.querySelector('p').textContent = project.description || t('noDescription'); var edit = make('button', 'wp-project-edit', lang() === 'zh-CN' ? '编辑' : 'Edit'); edit.addEventListener('click', function () { openProjectModal(project); }); card.querySelector('.wp-project-card-heading').appendChild(edit); old.appendChild(card);
    var listedFiles = state.files[project.id] || [], files = make('section', 'wp-project-card'); files.innerHTML = '<h2>' + esc(t('files')) + '</h2><p class="wp-project-file-list">' + esc(listedFiles.length ? listedFiles.join('、') : t('noFiles')) + '</p>'; var upload = make('input'); upload.type = 'file'; upload.multiple = true; upload.className = 'wp-project-upload'; upload.addEventListener('blur', renderSoon); upload.addEventListener('change', async function () { upload.disabled = true; try { for (var file of Array.from(upload.files || [])) await uploadFile(project, file); } catch (e) { toast(t('fileFailed')); } finally { upload.disabled = false; } }); files.append(upload); old.appendChild(files);
    var list = make('section', 'wp-project-card'); list.innerHTML = '<h2>' + esc(t('conversations')) + '</h2>'; if (!chats.length) list.appendChild(make('p', 'wp-project-empty', t('noChats'))); chats.forEach(function (c) { var row = conversationRow(c, false); var summary = make('span', 'wp-project-summary', String(c.preview_text || c.summary || '').replace(/\s+/g, ' ').slice(0, 120)); row.insertBefore(summary, row.querySelector('.wp-project-time')); list.appendChild(row); }); old.appendChild(list); loadFiles(project);
  }
  var domObserver = null, renderPending = false, rendering = false;
  function renderSoon() {
    if (!document.body || renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false; if (rendering) return;
      rendering = true; if (domObserver) domObserver.disconnect();
      try { renderSidebar(); renderHome(); hookSearch(); }
      finally { rendering = false; if (domObserver && document.body) domObserver.observe(document.body, { childList: true, subtree: true }); }
    });
  }
  function hookSearch() {
    var results = document.querySelector('.wp-search-results'), input = document.querySelector('[data-wp-nav="search"] input'); if (!results || !input || results.dataset.wpProjects) return; results.dataset.wpProjects = '1'; var observer = new MutationObserver(function () { var q = input.value.trim().toLowerCase(); if (!q) return; state.projects.filter(function (p) { return p.name.toLowerCase().includes(q); }).slice(0, 8).forEach(function (p) { if (results.querySelector('[data-project-result="' + p.id + '"]')) return; var b = make('button', 'wp-search-result'); b.dataset.projectResult = p.id; b.innerHTML = '<span class="wp-search-head"><span class="wp-search-title"></span><span class="wp-search-time">' + esc(t('project')) + '</span></span>'; b.querySelector('.wp-search-title').textContent = p.name; b.addEventListener('click', function () { openHome(p); }); results.insertBefore(b, results.firstChild); }); }); observer.observe(results, { childList: true }); }
  window.wpProjects = { newConversationExtra: function () { var p = state.pendingProject; return p ? { workspace: projectPath(p), custom_workspace: true, wp_project_id: p.id } : null; }, creationResult: function (ok, draft, extra) {
    var project = extra ? state.projects.find(function (p) { return p.id === extra.wp_project_id; }) : state.pendingProject; if (!project) return;
    if (ok) { state.homeSubmission = null; delete state.drafts[project.id]; state.pendingProject = null; closeDrawer(); loadConversations(); }
    else { state.pendingProject = project; state.drafts[project.id] = state.drafts[project.id] || draft; draft = state.drafts[project.id]; if (state.homeSubmission === project.id) { location.hash = '#/wp-project/' + project.id; renderSoon(); } toast(t('createFailed')); var input = document.querySelector('[data-testid="guid-input"]'); if (input && draft) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, draft); input.dispatchEvent(new Event('input', { bubbles: true })); } }
  }, refresh: function () { loadConversations(); }, logic: L };
  document.addEventListener('input', function (e) { if (state.pendingProject && e.target.matches('[data-testid="guid-input"]')) state.drafts[state.pendingProject.id] = e.target.value; }, true);
  document.addEventListener('click', function (e) { if (state.menu && !state.menu.contains(e.target)) closeMenu(); });
  window.addEventListener('hashchange', function () { if (location.hash !== '#/guid' && !currentProject()) state.pendingProject = null; renderHome(); renderSoon(); });
  function start() {
    domObserver = new MutationObserver(function (records) { if (!rendering && records.some(function (r) { return !r.target.closest?.('.wp-projects-root,.wp-project-home,.wp-project-backdrop,.wp-project-menu,.wp-project-toast') && Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(function (n) { return n.nodeType !== 1 || !n.matches('.wp-archive-entry,.wp-project-toast'); }); })) renderSoon(); });
    domObserver.observe(document.body, { childList: true, subtree: true });
    loadProjects(); loadConversations(); setInterval(loadConversations, 5000); renderSoon();
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
