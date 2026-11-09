// Skills use the market registry; disposing a tab cancels its reads and prevents stale DOM updates.
(function () {
  'use strict';
  var COPY = {
    'zh-CN': { add: '添加技能', loading: '正在加载技能…', empty: '暂无技能',
      preinstalled: '预装', personal: '仅自己', remove: '删除', retry: '刷新列表', busy: '正在处理…',
      overwrite: '已有同名技能“{name}”，要覆盖吗？', confirmDelete: '删除技能“{name}”？删除后 Claude 和 ChatGPT 都将无法使用。',
      installed: '已添加技能，新对话里即可使用。', removed: '已删除技能。', failed: '操作尚未确认完成，请刷新列表后重试。',
      file: '请选择 .zip 或单个 SKILL.md 文件。', large: '技能文件不能超过 10 MB。' },
    'en-US': { add: 'Add skill', loading: 'Loading skills…', empty: 'No skills yet',
      preinstalled: 'Preinstalled', personal: 'Only you', remove: 'Delete', retry: 'Refresh list', busy: 'Working…',
      overwrite: 'A skill named “{name}” already exists. Replace it?', confirmDelete: 'Delete “{name}”? Claude and ChatGPT will no longer be able to use it.',
      installed: 'Skill added. Start a new chat to use it.', removed: 'Skill deleted.', failed: 'The operation is unconfirmed. Refresh the list before retrying.',
      file: 'Choose a .zip file or a single SKILL.md file.', large: 'Skill files must be 10 MB or smaller.' }
  };
  window.wpMarket.register('skills', function (host, context) {
    var copy = COPY[context.locale] || COPY['zh-CN'], controller = new AbortController(), disposed = false, busy = false;
    function element(tag, className, text) {
      var node = document.createElement(tag); node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    var toolbar = element('div', 'wp-skills-toolbar'), add = element('button', 'wp-skills-add', copy.add);
    add.type = 'button';
    var input = element('input', 'wp-skills-input'); input.type = 'file'; input.accept = '.zip,.md'; input.hidden = true;
    var status = element('p', 'wp-skills-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    var retry = element('button', 'wp-skills-retry', copy.retry); retry.type = 'button'; retry.hidden = true;
    var list = element('div', 'wp-skills-list');
    toolbar.append(add); host.append(toolbar, input, status, retry, list);
    function pending(value) {
      busy = value;
      host.querySelectorAll('button').forEach(function (button) { button.disabled = value; });
      add.textContent = value ? copy.busy : copy.add;
      list.setAttribute('aria-busy', String(value));
    }
    function message(text, error) {
      status.textContent = text; status.classList.toggle('wp-skills-error', !!error); retry.hidden = !error;
      status.setAttribute('role', error ? 'alert' : 'status');
    }
    async function request(url, options) {
      var response = await fetch(url, Object.assign({ signal: controller.signal }, options)), value = await response.json();
      if (!response.ok || value.success === false) {
        var error = new Error(value.message || copy.failed); error.code = value.error; error.skillName = value.name; throw error;
      }
      return value;
    }
    function mutate(method, body) {
      return request('/_wp/market/skills', { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    function install(file, overwrite) {
      return request('/_wp/market/skills?filename=' + encodeURIComponent(file.name) + (overwrite ? '&overwrite=true' : ''),
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    }
    function render(rows) {
      list.replaceChildren();
      if (!rows.length) { list.appendChild(element('p', 'wp-market-empty', copy.empty)); return; }
      rows.forEach(function (skill) {
        var card = element('article', 'wp-skill-card'); card.dataset.skill = skill.id;
        var top = element('div', 'wp-skill-top'), title = element('h2', 'wp-skill-name', context.locale === 'zh-CN' ? skill.displayName : skill.name);
        top.append(title, element('span', 'wp-skill-badge', skill.preinstalled ? copy.preinstalled : copy.personal));
        card.append(top, element('p', 'wp-skill-description', context.locale === 'zh-CN' ? skill.displayDescription : skill.description));
        if (!skill.preinstalled) {
          var remove = element('button', 'wp-skill-delete', copy.remove); remove.type = 'button';
          remove.setAttribute('aria-label', copy.remove + ' ' + skill.name);
          remove.addEventListener('click', async function () {
            if (busy || !window.confirm(copy.confirmDelete.replace('{name}', skill.name))) return;
            pending(true); message(copy.busy);
            try { await mutate('DELETE', { name: skill.id }); if (!disposed) await load(copy.removed); }
            catch (error) { if (!disposed) message(error.message || copy.failed, true); }
            finally { if (!disposed) pending(false); }
          });
          card.appendChild(remove);
        }
        list.appendChild(card);
      });
    }
    async function load(success) {
      var data = await request('/_wp/market/skills');
      if (!disposed) { render(data.skills); message(success || ''); }
    }
    async function refresh() {
      pending(true); message(copy.loading);
      try { await load(); } catch (error) { if (!disposed) message(error.message || copy.failed, true); }
      finally { if (!disposed) pending(false); }
    }
    add.addEventListener('click', function () { if (!busy) input.click(); });
    retry.addEventListener('click', refresh);
    input.addEventListener('change', async function () {
      var file = input.files && input.files[0]; input.value = '';
      if (!file || busy) return;
      if (!(/\.zip$/i.test(file.name) || file.name === 'SKILL.md')) { message(copy.file, true); return; }
      if (file.size > 10 * 1024 * 1024) { message(copy.large, true); return; }
      pending(true); message(copy.busy);
      try {
        try { await install(file, false); }
        catch (error) {
          if (disposed) return;
          if (error.code !== 'exists') throw error;
          if (!window.confirm(copy.overwrite.replace('{name}', error.skillName))) { message(''); return; }
          await install(file, true);
        }
        if (!disposed) await load(copy.installed);
      } catch (error) { if (!disposed) message(error.message || copy.failed, true); }
      finally { if (!disposed) pending(false); }
    });
    void refresh();
    return function () { disposed = true; controller.abort(); };
  });
})();
