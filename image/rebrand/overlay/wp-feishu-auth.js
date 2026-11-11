/* Personal Feishu authorization shares the existing gateway OAuth and confirmation policy. */
(function () {
  'use strict';
  var state, pending, banner, dialog, popup, poll, projectPoll, previousFocus;
  var COPY = {
    'zh-CN': {
      title: '飞书授权', connected: '已连接', disconnected: '未连接', unknown: '暂时无法核实', checking: '正在检查授权…',
      disabled: '管理员已停用飞书授权', revoking: '已停止使用，远端撤销待完成，请在授权页重试断开',
      banner: '还没连接飞书，助理无法替你查消息、日程、文档。', connect: '连接飞书',
      reminderTitle: '连接飞书，让助理帮你办事',
      intro: '连接后，助理可以用你本人的飞书身份查消息、日程和文档。发消息、审批等操作会先问你。',
      later: '稍后', close: '关闭', retry: '重新检查', project: '飞书项目', projectConnect: '连接飞书项目',
      waiting: '完成授权后回到这里，连接状态会自动更新。', projectExpired: '飞书项目授权已过期，请重新连接。', manage: '管理授权'
    },
    'en-US': {
      title: 'Feishu authorization', connected: 'Connected', disconnected: 'Not connected', unknown: 'Could not check connection', checking: 'Checking authorization…',
      disabled: 'Feishu authorization is disabled', revoking: 'Authorization stopped; finish disconnecting on the authorization page.',
      banner: 'Connect Feishu so your assistant can read your messages, calendar and documents.', connect: 'Connect Feishu',
      reminderTitle: 'Connect Feishu to let your assistant help',
      intro: 'Your assistant can use your Feishu identity to read messages, calendars and documents. It will ask before sending messages or submitting approvals.',
      later: 'Later', close: 'Close', retry: 'Check again', project: 'Feishu Project', projectConnect: 'Connect Feishu Project',
      waiting: 'Return here after authorization. Your connection status will update automatically.', projectExpired: 'Feishu Project authorization expired. Connect again.', manage: 'Manage authorization'
    }
  };
  function t(key) {
    var language = window.wpSettings?.get().language || document.documentElement.lang;
    return COPY[/^en/i.test(language || '') ? 'en-US' : 'zh-CN'][key];
  }
  function el(tag, className, text) {
    var node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, action) {
    var node = el('button', 'wp-auth-button', label); node.type = 'button'; node.addEventListener('click', action); return node;
  }
  async function api(route, method) {
    var response = await fetch('/_wp/feishu/' + route, { method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(method ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    var value = await response.json();
    if (!response.ok) throw new Error('Authorization unavailable');
    return value;
  }
  function description(value) {
    return !value ? t('checking') : value.error ? t('unknown') : value.enabled === false ? t('disabled') : value.revoking ? t('revoking') : t(value.connected ? 'connected' : 'disconnected');
  }
  function close() {
    clearTimeout(poll); clearTimeout(projectPoll); poll = null; projectPoll = null;
    if (dialog) { dialog.close(); dialog.remove(); dialog = null; }
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  function watch() {
    clearTimeout(poll);
    if (!dialog) return;
    poll = setTimeout(async function () {
      await refresh();
      if (dialog && !state?.connected) watch();
    }, 3000);
  }
  function connect() {
    var target = '/_wp/feishu/connect?return=settings&display=popup';
    popup = window.open(target, 'wp-feishu-personal', 'popup,width=640,height=760');
    if (!popup) { location.assign('/_wp/feishu/connect?return=settings&display=redirect'); return; }
    watch();
  }
  function show(reminder) {
    if (dialog) { dialog.focus(); return; }
    previousFocus = document.activeElement;
    dialog = el('dialog', 'wp-auth-dialog'); dialog.setAttribute('aria-labelledby', 'wp-auth-title');
    var heading = el('h2', '', t(reminder ? 'reminderTitle' : 'title')); heading.id = 'wp-auth-title';
    dialog.append(heading, el('p', '', t('intro')));
    var main = el('div', 'wp-auth-row');
    var status = el('p', 'wp-auth-state', description(state)); status.setAttribute('role', 'status');
    main.append(status, button(t(state?.connected ? 'manage' : 'connect'), function () {
      if (state?.connected || state?.revoking) location.assign('/_wp/feishu/'); else connect();
    }));
    main.lastChild.classList.add('wp-auth-main-action');
    main.lastChild.disabled = !state || !!state.error || state.enabled === false;
    dialog.append(main);
    if (!reminder) {
      var project = el('div', 'wp-auth-row'); project.append(el('span', '', t('project')));
      var projectStatus = el('p', 'wp-auth-project-status', t('checking')); projectStatus.setAttribute('role', 'status');
      var projectAction = button(t('projectConnect'), async function () {
        projectAction.disabled = true;
        try {
          var value = await api('project/connect', 'POST');
          var target = new URL(value.authorization_url);
          if (target.protocol !== 'https:') throw new Error('Invalid authorization link');
          var link = el('a', '', t('projectConnect')); link.href = target.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          projectStatus.replaceChildren(link, document.createTextNode(value.user_code ? ' ' + value.user_code : ''));
          async function check() {
            if (!dialog || !project.isConnected) return;
            try {
              var result = await api('project/poll', 'POST');
              if (result.state !== 'pending') { projectStatus.textContent = t(result.state === 'connected' ? 'connected' : 'projectExpired'); projectAction.disabled = false; return; }
              projectPoll = setTimeout(check, Math.max(5, value.interval || 5) * 1000);
            } catch (error) { projectStatus.textContent = t('unknown'); projectAction.disabled = false; }
          }
          projectPoll = setTimeout(check, Math.max(5, value.interval || 5) * 1000);
        } catch (error) { projectStatus.textContent = t('unknown'); projectAction.disabled = false; }
      });
      project.append(projectStatus, projectAction); dialog.append(project);
      api('project/status').then(function (value) {
        if (!project.isConnected) return;
        projectStatus.textContent = description(value); projectAction.hidden = value.connected;
      }).catch(function () { projectStatus.textContent = t('unknown'); });
    }
    dialog.append(el('p', 'wp-auth-hint', t('waiting')));
    var actions = el('div', 'wp-auth-actions'); actions.append(button(t('retry'), refresh), button(t(reminder ? 'later' : 'close'), close)); dialog.append(actions);
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    document.body.append(dialog); dialog.showModal();
  }
  function eligible() { return state?.enabled && !state.connected && !state.revoking && !state.error; }
  function mount() {
    var home = document.querySelector('[data-testid="guid-input"]')?.closest('main');
    if (!home || !eligible()) { if (banner) { banner.remove(); banner = null; } return; }
    if (!banner || !banner.isConnected) {
      banner = el('aside', 'wp-auth-banner'); banner.setAttribute('aria-label', t('title'));
      banner.append(el('span', '', t('banner')), button(t('connect'), function () { show(false); })); home.prepend(banner);
    }
    if (dialog || document.querySelector('dialog[open],[role="dialog"],[role="menu"]')) return;
    var day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    try {
      if (localStorage.getItem('zp-feishu-reminder-day') === day) return;
      localStorage.setItem('zp-feishu-reminder-day', day);
    } catch (error) { return; } // A disabled browser store must not produce repeated modal reminders.
    show(true);
  }
  async function refresh() {
    if (pending) return pending;
    pending = api('status').then(function (value) { state = value; }).catch(function () { state = { error: true }; }).finally(function () {
      pending = null; mount();
      var status = dialog?.querySelector('.wp-auth-state'); if (status) status.textContent = description(state);
      var action = dialog?.querySelector('.wp-auth-main-action');
      if (action) { action.textContent = t(state?.connected || state?.revoking ? 'manage' : 'connect'); action.disabled = !state || !!state.error || state.enabled === false; }
      if (state?.connected) clearTimeout(poll);
    });
    return pending;
  }
  window.addEventListener('message', function (event) {
    if (event.origin === location.origin && event.source === popup && event.data?.type === 'workpartner.identity.connected') void refresh();
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('hashchange', function () { mount(); void refresh(); });
  var queued = false;
  new MutationObserver(function () {
    if (queued) return; queued = true;
    requestAnimationFrame(function () { queued = false; mount(); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  function start() {
    void refresh();
    if (new URLSearchParams(location.search).get('zp-settings') === 'feishu') {
      history.replaceState(null, '', location.pathname + location.hash);
      refresh().then(function () { show(false); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
