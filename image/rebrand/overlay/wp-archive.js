/* AionUi 2.1.47: archive is a reversible extra flag, never a runtime status. */
(function () {
  'use strict';
  var request = window.fetch.bind(window), conversations = new Map(), pending = new Set();
  var overrides = new Map(), version = 0, loading = null, trailing = false;
  var modal = null, opener = null, revision = 0, rendered = '', scheduled = false;
  var copy = {
    'zh-CN': { archive: '归档', restore: '取消归档', archived: '已归档', close: '关闭',
      empty: '还没有已归档的对话。', unnamed: '未命名对话',
      failed: '未能确认归档状态。请刷新后核对，再操作。', saving: '正在保存…' },
    'en-US': { archive: 'Archive', restore: 'Unarchive', archived: 'Archived', close: 'Close',
      empty: 'No archived chats.', unnamed: 'Untitled chat',
      failed: 'Could not confirm archive status. Reload and check before trying again.', saving: 'Saving…' }
  };
  function label(key) {
    var language = window.wpSettings && window.wpSettings.get().language;
    return copy[String(language || 'zh-CN').startsWith('zh') ? 'zh-CN' : 'en-US'][key];
  }
  var icon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6v7h11V6M2 2.5h12v3H2zM6 8.5h4"/></svg>';
  function storedArchived(c) { return !!(c && c.extra && c.extra.wp_archived === true); }
  function archived(c) {
    var override = c && overrides.get(c.id);
    return override ? override.value : storedArchived(c);
  }
  function changed() {
    revision++;
    if (window.wpArchive.invalidate) window.wpArchive.invalidate();
    render();
  }
  // Share one list request; any changes during it need just one trailing reload.
  function load(read) {
    if (loading) { trailing = true; return loading; }
    var started = version;
    loading = Promise.resolve().then(function () { return read(started); }).finally(function () {
      loading = null;
      if (trailing) { trailing = false; load(read); }
    });
    return loading;
  }
  function visible(c) { return !(c.extra && (c.extra.team_id || c.extra.teamId || c.extra.is_health_check)); }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; render(); });
  }
  function button(text, action, className) {
    var b = document.createElement('button'); b.type = 'button'; b.className = className || '';
    b.textContent = text; b.addEventListener('click', action); return b;
  }
  function error(message) {
    var el = document.querySelector('.wp-archive-error');
    if (!el) { el = document.createElement('div'); el.className = 'wp-archive-error'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
    el.replaceChildren(document.createTextNode(message), button(label('close'), function () { el.remove(); }));
  }
  async function json(url, init) {
    var response = await request(url, init), value = await response.json();
    if (!response.ok || value.success === false) throw new Error('Archive request failed');
    return value.data || value;
  }
  async function toggle(value) {
    var id = typeof value === 'string' ? value : value.id;
    if (pending.has(id)) return;
    var c = conversations.get(id) || value;
    if (!c || typeof c !== 'object') return;
    var previous = overrides.get(id), next = !archived(c); pending.add(id);
    overrides.set(id, { value: next, version: ++version }); changed();
    try {
      var confirmed = await json('/api/conversations/' + encodeURIComponent(id), { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra: { wp_archived: next }, merge_extra: true }) });
      if (confirmed.id !== id || storedArchived(confirmed) !== next) throw new Error('Archive state not confirmed');
    } catch (failure) {
      if (previous) overrides.set(id, { value: previous.value, version: ++version });
      else overrides.delete(id);
      changed();
      error(label('failed'));
    } finally { pending.delete(id); revision++; render(); }
  }
  function close() {
    if (!modal) return;
    modal.remove(); modal = null; rendered = '';
    if (opener && opener.isConnected) opener.focus();
  }
  function open(event) {
    if (modal) return;
    opener = event.currentTarget;
    modal = document.createElement('div'); modal.className = 'wp-archive-backdrop';
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        var buttons = Array.from(modal.querySelectorAll('button:not(:disabled)'));
        var first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(modal); render(); modal.querySelector('button').focus();
  }
  function render() {
    var list = Array.from(conversations.values()).filter(function (c) { return visible(c) && archived(c); });
    var aside = document.querySelector('aside.layout-sider [class*="_scrollArea"]');
    var entry = document.querySelector('.wp-archive-entry');
    if (aside && list.length) {
      if (!entry) { entry = button('', open, 'wp-archive-entry'); entry.innerHTML = icon + '<span></span>'; aside.appendChild(entry); }
      if (aside.lastElementChild !== entry) aside.appendChild(entry);
      if (entry.querySelector('span').textContent !== label('archived')) entry.querySelector('span').textContent = label('archived');
    } else if (entry) entry.remove();
    var id = (location.hash.match(/^#\/conversation\/([\w-]+)/) || [])[1];
    var restore = document.querySelector('.wp-archive-restore');
    if (archived(conversations.get(id))) {
      if (!restore) { restore = button('', function () { toggle((location.hash.match(/^#\/conversation\/([\w-]+)/) || [])[1]); }, 'wp-archive-restore'); document.body.appendChild(restore); }
      var text = pending.has(id) ? label('saving') : label('archived') + ' · ' + label('restore');
      if (restore.textContent !== text) restore.textContent = text;
      restore.disabled = pending.has(id);
    } else if (restore) restore.remove();
    document.querySelectorAll('.wp-archive-button').forEach(function (b) { b.disabled = pending.has(b.dataset.conversation); });
    if (!modal) return;
    var signature = revision + ':' + label('archived');
    if (rendered === signature) return;
    rendered = signature;
    var hadFocus = modal.contains(document.activeElement);
    var focused = document.activeElement && document.activeElement.dataset.restore;
    var panel = document.createElement('section'); panel.className = 'wp-archive-dialog';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', label('archived'));
    var header = document.createElement('header'), title = document.createElement('h2'); title.textContent = label('archived');
    header.append(title, button(label('close'), close)); panel.appendChild(header);
    if (!list.length) { var empty = document.createElement('p'); empty.textContent = label('empty'); panel.appendChild(empty); }
    list.forEach(function (c) {
      var row = document.createElement('div'); row.className = 'wp-archive-row';
      var name = button(c.name || label('unnamed'), function () { close(); location.hash = '#/conversation/' + c.id; }, 'wp-archive-name');
      var undo = button(pending.has(c.id) ? label('saving') : label('restore'), function () { toggle(c.id); });
      undo.dataset.restore = c.id; undo.disabled = pending.has(c.id); row.append(name, undo); panel.appendChild(row);
    });
    modal.replaceChildren(panel);
    if (hadFocus) (Array.from(modal.querySelectorAll('[data-restore]')).find(function (b) { return b.dataset.restore === focused && !b.disabled; }) || header.querySelector('button')).focus();
  }
  window.wpArchive = {
    label: label, icon: icon, toggle: toggle, render: render, archived: archived, load: load,
    observe: function (items, started) {
      items.forEach(function (c) {
        var override = overrides.get(c.id);
        if (override && override.version <= started && storedArchived(c) === override.value) overrides.delete(c.id);
      });
      conversations = new Map(items.map(function (c) { return [c.id, c]; })); revision++; schedule();
    }
  };
  window.addEventListener('hashchange', function () { close(); schedule(); });
  window.addEventListener('focus', function () { if (window.wpArchive.refresh) window.wpArchive.refresh(); });
})();
