// One skills renderer owns its reads, dialogs and mutations until the market tab is disposed.
(function () {
  'use strict';
  var COPY = {
    'zh-CN': { add: '添加技能', loading: '正在加载技能…', empty: '暂无技能', official: '官方', company: '公司技能', mine: '我的',
      preinstalled: '预装', personal: '仅自己', myShare: '我分享的', remove: '删除', uninstall: '卸载', retry: '刷新列表', busy: '正在处理…', install: '安装', installedBadge: '已安装',
      overwrite: '已有同名技能“{name}”，要覆盖吗？', confirmDelete: '删除技能“{name}”？删除后 Claude 和 ChatGPT 都将无法使用。',
      installed: '已安装，开新对话后生效；飞书个人智能体请发 /new。', removed: '已移除技能。', failed: '操作尚未确认完成，请刷新列表后重试。',
      file: '请选择 .zip 或单个 SKILL.md 文件。', large: '技能文件不能超过 10 MB。', submit: '分享给公司', submitted: '已提交 IT 审批，自己的版本仍可使用。',
      pending: '待审批', approved: '已通过', rejected: '未通过', withdrawn: '已下架', withdrawnRemovable: '已下架，可移除', removeLink: '移除', withdraw: '下架', confirmWithdraw: '下架后所有安装者都将无法使用，要继续吗？',
      tryIt: '试一试', source: '数据来源：', author: '作者：', installs: ' 人已安装', review: '审批', reviewTitle: '待我审批', title: '中文名', description: '一句话说明', example: '例句', cancel: '取消',
      disabled: '管理员尚未开放分享，添加的技能仅自己可用。', noticeFailed: '审批卡片未送达，请审批人从审批页重发。',
      resend: '重发结果通知', history: '审批记录', submitTitle: '分享技能', resultFailed: '作者通知未送达' },
    'en-US': { add: 'Add skill', loading: 'Loading skills…', empty: 'No skills yet', official: 'Official', company: 'Company skills', mine: 'Mine',
      preinstalled: 'Preinstalled', personal: 'Only you', myShare: 'Shared by me', remove: 'Delete', uninstall: 'Uninstall', retry: 'Refresh list', busy: 'Working…', install: 'Install', installedBadge: 'Installed',
      overwrite: 'A skill named “{name}” already exists. Replace it?', confirmDelete: 'Delete “{name}”? Claude and ChatGPT will no longer be able to use it.',
      installed: 'Start a new chat to use the skill. Send /new in your personal messaging agent.', removed: 'Skill removed.', failed: 'The operation is unconfirmed. Refresh the list before retrying.',
      file: 'Choose a .zip file or a single SKILL.md file.', large: 'Skill files must be 10 MB or smaller.', submit: 'Share with company', submitted: 'Submitted for IT review. Your copy remains available.',
      pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn', withdrawnRemovable: 'Withdrawn, can be removed', removeLink: 'Remove', withdraw: 'Withdraw', confirmWithdraw: 'All installers will lose access. Continue?',
      tryIt: 'Try it', source: 'Source: ', author: 'Author: ', installs: ' installs', review: 'Review', reviewTitle: 'Awaiting my review', title: 'Display name', description: 'Short description', example: 'Example', cancel: 'Cancel',
      disabled: 'Sharing is not enabled. Added skills are available only to you.', noticeFailed: 'The review card was not delivered. Reviewers can resend it from the review page.',
      resend: 'Resend result', history: 'Review history', submitTitle: 'Share skill', resultFailed: 'Author notification failed' }
  };
  window.wpMarket.register('skills', function (host, context) {
    var copy = COPY[context.locale] || COPY['zh-CN'], controller = new AbortController(), disposed = false, busy = false, dialogs = [], sharingEnabled = false;
    function element(tag, className, text) { var node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
    var toolbar = element('div', 'wp-skills-toolbar'), add = element('button', 'wp-skills-add', copy.add);
    add.type = 'button'; var input = element('input', 'wp-skills-input'); input.type = 'file'; input.accept = '.zip,.md'; input.hidden = true;
    var status = element('p', 'wp-skills-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    var retry = element('button', 'wp-skills-retry', copy.retry); retry.type = 'button'; retry.hidden = true;
    var list = element('div', 'wp-skills-sections'); toolbar.append(add); host.append(toolbar, input, status, retry, list);
    function pending(value) { busy = value; host.querySelectorAll('button').forEach(function (button) { button.disabled = value; }); add.textContent = value ? copy.busy : copy.add; list.setAttribute('aria-busy', String(value)); }
    function message(text, error) { status.textContent = text; status.classList.toggle('wp-skills-error', !!error); retry.hidden = !error; status.setAttribute('role', error ? 'alert' : 'status'); }
    async function request(url, options) {
      var response = await fetch(url, Object.assign({ signal: controller.signal }, options)), value = await response.json();
      if (!response.ok || value.success === false) { var error = new Error(value.message || copy.failed); error.code = value.error; error.skillName = value.name; throw error; }
      return value;
    }
    function shared(body) { return request('/_wp/market/shared', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    async function action(work, success) {
      if (busy) return; pending(true); message(copy.busy);
      try { await work(); if (!disposed) await load(success); }
      catch (error) { if (!disposed) message(error.message || copy.failed, true); }
      finally { if (!disposed) pending(false); }
    }
    function button(card, label, callback, className) { var node = element('button', className || 'wp-skill-action', label); node.type = 'button'; node.addEventListener('click', callback); card.appendChild(node); return node; }
    function section(title) { var area = element('section', 'wp-skills-section'); area.appendChild(element('h2', 'wp-skills-heading', title)); var cards = element('div', 'wp-skills-list'); area.appendChild(cards); list.appendChild(area); return cards; }
    function card(area, skill, badge) {
      var node = element('article', 'wp-skill-card'); node.dataset.skill = skill.name || skill.id;
      var top = element('div', 'wp-skill-top'); top.append(element('h3', 'wp-skill-name', skill.displayName || skill.name), element('span', 'wp-skill-badge', badge));
      node.append(top, element('p', 'wp-skill-description', skill.displayDescription || skill.description));
      if (skill.source) {
        var source = element('p', 'wp-skill-source', copy.source), link = element('a', '', skill.source.name + (context.locale === 'en-US' ? ' (' : '（') + skill.source.url.replace(/^https:\/\/([^/?#]+).*$/, '$1') + (context.locale === 'en-US' ? ')' : '）'));
        link.href = skill.source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; source.appendChild(link); node.appendChild(source);
      }
      area.appendChild(node); return node;
    }
    function remove(cardNode, skill) {
      button(cardNode, skill.withdrawn ? copy.removeLink : skill.shared ? copy.uninstall : copy.remove, function () {
        if (!skill.withdrawn && !window.confirm(copy.confirmDelete.replace('{name}', skill.name))) return;
        void action(function () { return request('/_wp/market/skills', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: skill.id }) }); }, copy.removed);
      }, 'wp-skill-delete');
    }
    function submit(skill) {
      if (busy) return;
      var dialog = element('dialog', 'wp-skill-dialog'), form = element('form', 'wp-skill-form');
      form.appendChild(element('h2', '', copy.submitTitle));
      [['displayName', copy.title, 80, skill.displayName || skill.name], ['description', copy.description, 300, (skill.displayDescription || skill.description || '').slice(0, 300)], ['example', copy.example, 500, '']].forEach(function (entry) {
        var label = element('label', '', entry[1]), field = element('input', ''); field.name = entry[0]; field.maxLength = entry[2]; field.required = true; field.value = entry[3]; label.appendChild(field); form.appendChild(label);
      });
      var tested = element('label', '', context.locale === 'en-US' ? 'I tested this skill in a new chat.' : '我已开新对话测试过这个技能。'), checkbox = element('input', ''); checkbox.type = 'checkbox'; checkbox.required = true; tested.prepend(checkbox); form.appendChild(tested);
      var save = element('button', '', copy.submit); save.type = 'submit'; form.appendChild(save);
      button(form, copy.cancel, function () { dialog.close(); });
      form.addEventListener('submit', function (event) {
        event.preventDefault(); var fields = new FormData(form); dialog.close();
        void action(async function () {
          var result = await shared({ action: 'submit', name: skill.name, displayName: fields.get('displayName'), description: fields.get('description'), example: fields.get('example') });
          if (result.reviewNotice === 'failed') throw new Error(copy.submitted + ' ' + copy.noticeFailed);
        }, copy.submitted);
      });
      dialog.addEventListener('close', function () { dialog.remove(); }); dialog.appendChild(form); host.appendChild(dialog); dialogs.push(dialog); dialog.showModal();
    }
    function render(personal, market) {
      sharingEnabled = market.submissionsEnabled;
      list.replaceChildren(); var official = section(copy.official), company = section(copy.company), mine = section(copy.mine);
      // Preinstalled display names come from the Chinese translation table; English keeps the skill's own name and description.
      personal.filter(function (s) { return s.preinstalled; }).forEach(function (skill) {
        card(official, context.locale === 'en-US' ? { name: skill.name, description: skill.description, source: skill.source } : skill, copy.preinstalled);
      });
      market.company.forEach(function (skill) {
        var authored = market.mine.some(function (s) { return s.name === skill.name; });
        var installed = personal.some(function (s) { return s.name === skill.name && s.shared; }), node = card(company, skill, authored ? copy.myShare : installed ? copy.installedBadge : copy.company);
        node.appendChild(element('p', 'wp-skill-meta', copy.author + skill.author + ' · ' + skill.installs + copy.installs));
        if (!authored && !installed) button(node, copy.install, function () { void action(function () { return shared({ action: 'install', name: skill.name }); }, copy.installed); });
        if (skill.example) { node.appendChild(element('p', 'wp-skill-example', skill.example)); button(node, copy.tryIt, function () { window.wpMarket.tryExample(skill.example); }); }
        if (skill.canWithdraw) button(node, copy.withdraw, function () { if (window.confirm(copy.confirmWithdraw)) void action(function () { return shared({ action: 'withdraw', name: skill.name }); }, copy.withdrawn); });
      });
      personal.filter(function (s) { return !s.preinstalled; }).forEach(function (skill) {
        var row = market.mine.filter(function (v) { return v.name === skill.name; }).sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); })[0];
        var node = card(mine, skill, skill.withdrawn ? copy.withdrawnRemovable : row ? copy[row.status] : skill.shared ? copy.installedBadge : copy.personal); remove(node, skill);
        if (row?.reason) node.appendChild(element('p', 'wp-skill-reason', row.reason));
        if (row?.reviewNotice === 'failed' && row.status === 'pending') node.appendChild(element('p', 'wp-skills-error', copy.noticeFailed));
        if (!skill.shared && market.submissionsEnabled) button(node, copy.submit, function () { submit(skill); });
      });
      // Keep pending/rejected author versions visible even after the local copy was removed.
      market.mine.filter(function (v) { return !personal.some(function (s) { return s.name === v.name; }); }).forEach(function (skill) { var node = card(mine, skill, copy[skill.status]); if (skill.reason) node.appendChild(element('p', '', skill.reason)); });
      if (!market.submissionsEnabled) mine.appendChild(element('p', 'wp-market-empty', copy.disabled));
      [official, company, mine].forEach(function (area) { if (!area.children.length) area.appendChild(element('p', 'wp-market-empty', copy.empty)); });
      if (market.isApprover) {
        var review = section(copy.reviewTitle);
        market.pending.forEach(function (skill) { var node = card(review, skill, copy.pending); var link = element('a', 'wp-skill-review', copy.review); link.href = '/_wp/market/shared/review?name=' + encodeURIComponent(skill.name) + '&version=' + encodeURIComponent(skill.version); node.appendChild(link); });
        var history = section(copy.history);
        (market.reviewed || []).forEach(function (skill) {
          var node = card(history, skill, copy[skill.status]); if (skill.reason) node.appendChild(element('p', '', skill.reason));
          if (skill.authorNotice === 'failed') { node.appendChild(element('p', 'wp-skills-error', copy.resultFailed)); button(node, copy.resend, function () { void action(function () { return shared({ action: 'notify-author', name: skill.name, version: skill.version }); }, ''); }); }
        });
      }
    }
    async function load(success) { var results = await Promise.all([request('/_wp/market/skills'), request('/_wp/market/shared')]); if (!disposed) { render(results[0].skills, results[1]); message(success || ''); } }
    function install(file, overwrite) { return request('/_wp/market/skills?filename=' + encodeURIComponent(file.name) + (overwrite ? '&overwrite=true' : ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }); }
    add.addEventListener('click', function () { if (!busy) input.click(); }); retry.addEventListener('click', function () { void action(function () {}, ''); });
    input.addEventListener('change', async function () {
      var file = input.files && input.files[0]; input.value = ''; if (!file || busy) return;
      if (!(/\.zip$/i.test(file.name) || file.name === 'SKILL.md')) { message(copy.file, true); return; }
      if (file.size > 10 * 1024 * 1024) { message(copy.large, true); return; }
      var installed;
      await action(async function () {
        try { installed = await install(file, false); }
        catch (error) { if (error.code !== 'exists') throw error; if (!window.confirm(copy.overwrite.replace('{name}', error.skillName))) return; installed = await install(file, true); }
      }, copy.installed);
      // Uploads and conversation sharing both submit an installed, self-testable copy through the same API.
      if (installed && sharingEnabled && !disposed) submit({ name: installed.name });
    });
    message(copy.loading); void action(function () {}, '');
    return function () { disposed = true; controller.abort(); dialogs.forEach(function (dialog) { dialog.remove(); }); };
  });
})();
