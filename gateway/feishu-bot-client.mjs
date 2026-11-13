/** Gateway-only UI, serialized without user or deployment data. */
export function feishuBotClient() {
  return `\n;(${installFeishuBot.toString()})();`;
}

function installFeishuBot() {
  const API = '/_wp/feishu-bot';
  let bots = [], agents = [], subAgents = { enabled: false, limit: 5, count: 0 }, modal, setupTimer, pollSetup, section, content, message, staleHint, refreshButton, addButton, observer, style, mountFrame, closeMenu;
  let stale = false, modalFocus;
  let highlightTimer, messageTimer, revealHome = false, loaded = false;
  let pending, timer, reconnectTimer, revoked = false, reconnecting = false;
  const safe = fn => (...args) => { try { return Promise.resolve(fn(...args)).catch(() => {}); } catch {} };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function button(text, action, label = text) {
    const element = node('button', text); element.type = 'button'; element.setAttribute('aria-label', label);
    element.addEventListener('click', safe(action)); return element;
  }
  const name = bot => bot.name || '飞书机器人';
  function avatar(bot) {
    const element = node('span', undefined, 'wp-feishu-bot-avatar'); element.setAttribute('aria-hidden', 'true');
    if (bot.avatar) {
      const image = node('img'); image.alt = '';
      image.onerror = safe(() => { element.textContent = Array.from(name(bot))[0]; });
      image.src = bot.avatar; element.append(image);
    }
    else element.textContent = Array.from(name(bot))[0];
    return element;
  }
  function state(bot) {
    const element = node('span', undefined, 'wp-feishu-bot-state');
    const dot = node('span', undefined, 'wp-feishu-bot-dot'); dot.dataset.state = bot.online; dot.setAttribute('aria-hidden', 'true');
    element.append(dot, node('span', { online: '在线', offline: '离线', unknown: '状态未知' }[bot.online] || '状态未知'));
    return element;
  }
  function icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', kind === 'chat' ? 'M3 5l10 8 7-7-4 12-6 2-7-4V5zm0 0l7 1 3 4 7-4M3 12l7 8M13 13l3 5'
      : 'M3 7h7m6 0h5M3 17h3m6 0h9M16 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M12 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('stroke-linecap', 'round'); svg.append(path); return svg;
  }
  function link(text, url, kind) {
    const element = node('a'); element.append(icon(kind), node('span', text));
    element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element;
  }
  function revoke() {
    revoked = true; bots = []; clearTimeout(timer); clearTimeout(reconnectTimer); clearTimeout(highlightTimer); clearTimeout(messageTimer);
    closeMenu?.(); closeDialog();
    if (mountFrame != null) cancelAnimationFrame(mountFrame);
    mountFrame = null; observer?.disconnect();
    window.removeEventListener('resize', scheduleMount); window.removeEventListener('hashchange', onHashChange);
    document.removeEventListener('visibilitychange', onVisibility);
    document.querySelectorAll('[data-wp-feishu-bot], [data-wp-feishu-bot-separator]').forEach(element => element.remove());
    section?.remove(); style?.remove();
  }
  async function request(route, post = false, body = {}) {
    const response = await fetch(API + route, { method: post ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(post ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      if (response.status === 401 || response.status === 404 && route.startsWith('/bots')) revoke();
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'unavailable');
    }
    return response.json();
  }
  function schedule() {
    clearTimeout(timer);
    if (!document.hidden && !revoked) timer = setTimeout(safe(() => refresh()), 60000);
  }
  function refresh(force = false, fresh = false) {
    if (revoked) return Promise.resolve();
    if (pending) return fresh ? pending.then(() => refresh(force, true)) : pending;
    if (refreshButton) refreshButton.disabled = true;
    pending = (async () => {
      try {
        const data = await request('/bots' + (force ? '?refresh=1' : ''));
        if (revoked) return;
        bots = data.bots; agents = data.agents || []; subAgents = data.subAgents || { enabled: false, limit: 5, count: 0 }; loaded = true; stale = false; mount(); render();
      } catch {
        if (revoked) return;
        stale = true;
        if (force) notify('暂时无法读取机器人信息，请稍后刷新。');
      } finally {
        pending = undefined;
        if (staleHint) staleHint.hidden = !stale;
        if (refreshButton) refreshButton.disabled = false;
        schedule();
      }
    })();
    return pending;
  }
  function notify(text, sticky = false) {
    if (!message || revoked) return;
    clearTimeout(messageTimer); message.textContent = text;
    messageTimer = sticky ? undefined : setTimeout(safe(() => { message.textContent = ''; }), 3000);
  }
  async function copy(appId) {
    try { await navigator.clipboard.writeText(appId); notify('已复制 App ID'); }
    catch { notify('复制失败，请手动复制 App ID。'); }
  }
  function confirmReconnect(card, trigger, id = 'main') {
    if (reconnecting || content.querySelector('[data-wp-feishu-bot-confirm]')) return;
    const box = node('div', undefined, 'wp-feishu-bot-confirm'); box.setAttribute('data-wp-feishu-bot-confirm', '');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', '确认重新连接');
    box.append(node('p', '重新连接飞书机器人？这会短暂中断飞书连接。'));
    const actions = node('div', undefined, 'wp-feishu-bot-actions');
    const cancel = button('取消', () => { box.remove(); trigger.focus(); render(); });
    actions.append(cancel, button('确认重新连接', async () => {
      if (reconnecting) return;
      reconnecting = true; box.remove(); trigger.focus(); render(); notify('正在重新连接…', true);
      try {
        await request(id === 'main' ? '/reconnect' : '/agents/' + id + '/restart', true);
        if (revoked) return;
        notify('已重新连接，稍后刷新状态。');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(safe(() => { if (!document.hidden) refresh(false, true); }), 3000);
      } catch { notify('重新连接失败，请稍后重试。'); }
      finally { reconnecting = false; render(); }
    }));
    box.append(actions); card.append(box); cancel.focus();
  }
  function connectionEntry() {
    return document.querySelector('.wp-feishu-banner button:not(.wp-feishu-dismiss)');
  }
  const invalidName = '名字只能用汉字、字母、数字、空格和 _ - ·，最多 16 个字';
  function normalizedName(value) {
    const name = value.normalize('NFC').trim();
    return name && Array.from(name).length <= 16 && !/^(主助手|main|s[0-9a-f]{8})$/i.test(name)
      && /^[㐀-䶿一-鿿豈-﫿A-Za-z0-9_·-]+(?: [㐀-䶿一-鿿豈-﫿A-Za-z0-9_·-]+)*$/.test(name) ? name : null;
  }
  const errorText = error => ({ invalid_name: invalidName, name_taken: '这个名字已经有了',
    limit_reached: '子助手最多 5 个（主助手另算）' }[error.message] || '操作没有成功，请稍后重试');
  function closeDialog() {
    clearTimeout(setupTimer); pollSetup = undefined;
    const previous = modal, focus = modalFocus; modal = undefined; modalFocus = undefined;
    previous?.close(); previous?.remove();
    if (focus && !revoked) {
      const card = [...(content?.querySelectorAll('.wp-feishu-bot-card') || [])].find(card => card.dataset.agentId === focus.agentId);
      (focus.trigger?.isConnected ? focus.trigger : card?.querySelector('.wp-feishu-bot-more') || addButton)?.focus();
    }
  }
  function dialog(title, trigger, agentId) {
    closeDialog();
    const element = node('dialog', undefined, 'wp-feishu-bot-dialog');
    const header = node('div', undefined, 'wp-feishu-bot-dialog-header');
    const heading = node('h2', title); heading.id = 'wp-feishu-bot-dialog-title';
    element.setAttribute('aria-labelledby', heading.id);
    header.append(heading, button('×', closeDialog, '关闭弹层'));
    const body = node('div', undefined, 'wp-feishu-bot-dialog-body');
    element.append(header, body);
    element.addEventListener('close', () => { if (modal === element) closeDialog(); });
    element.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    document.body.append(element); modal = element; modalFocus = { trigger, agentId }; element.showModal();
    return { element, body, heading };
  }
  function nameDialog(agent, trigger) {
    const view = dialog(agent ? '改名' : '新建子助手', trigger, agent?.id);
    const form = node('form'), label = node('label', '名字'), input = node('input');
    input.type = 'text'; input.value = agent?.name || ''; input.id = 'wp-feishu-agent-name';
    input.autocomplete = 'off'; label.setAttribute('for', input.id);
    const hint = node('p', '', 'wp-feishu-bot-input-error'); hint.id = 'wp-feishu-agent-error'; hint.setAttribute('role', 'status');
    input.setAttribute('aria-describedby', hint.id);
    const submit = button(agent ? '保存' : '下一步：扫码创建机器人', () => {}); submit.type = 'submit';
    let busy = false;
    const validate = () => {
      const valid = Boolean(normalizedName(input.value));
      submit.disabled = busy || !valid; input.setAttribute('aria-invalid', String(!valid));
      hint.textContent = valid ? '' : invalidName;
    };
    input.addEventListener('input', validate);
    form.append(label, input, hint, node('p', agent ? '只改工作伙伴里的名字，飞书里机器人的名字不变。'
      : '子助手有自己的工作目录、记忆和飞书机器人，可以互相调用。'), submit);
    form.addEventListener('submit', safe(async event => {
      event.preventDefault();
      validate();
      const name = normalizedName(input.value);
      if (busy || !name) return;
      busy = true; validate();
      try {
        const data = await request(agent ? '/agents/' + agent.id + '/rename' : '/agents', true, { name });
        if (modal === view.element) {
          if (agent) { closeDialog(); notify('已改名'); }
          else setupDialog(data.agent, view, false);
        }
        await refresh(false, true);
      } catch (error) { if (modal === view.element) hint.textContent = errorText(error); }
      finally { busy = false; submit.disabled = !normalizedName(input.value); }
    }));
    view.body.append(form); submit.disabled = !normalizedName(input.value); input.focus();
  }
  function setupDialog(agent, view, start = true, trigger) {
    view ||= dialog('', trigger, agent.id);
    modalFocus.agentId = agent.id;
    view.heading.textContent = '给「' + agent.name + '」创建飞书机器人';
    view.body.replaceChildren(node('p', '用飞书手机 App 扫码，完成机器人创建和授权。二维码 10 分钟内有效。飞书里给机器人起名时建议也用「' + agent.name + '」。'));
    const status = node('p', '正在准备二维码…'); status.setAttribute('role', 'status');
    const qr = node('img'); qr.alt = '创建飞书机器人的二维码'; qr.hidden = true;
    const retry = button('重试', () => poll(true)); retry.hidden = true;
    view.body.append(status, qr, retry);
    let busy = false, finished = false, stopped = false, interval = 2000, shouldStart = start;
    function showStatus(data) {
      qr.hidden = data.status !== 'waiting' || !data.qr;
      if (!qr.hidden) qr.src = data.qr;
      status.textContent = { none: '二维码没有准备好，请重试', preparing: '正在准备二维码…', waiting: '等待扫码',
        connected: '已连接，可以在飞书里找「' + agent.name + '」了', expired: '二维码已过期，请重试',
        failed: '创建没有成功，请重试', needs_identity: '请给新机器人发 /whoami，保留返回的本人 ID，再请管理员完成连接。' }[data.status] || '操作没有成功，请稍后重试';
      stopped = ['none', 'expired', 'failed'].includes(data.status);
      retry.hidden = !stopped;
      interval = data.status === 'needs_identity' ? 10000 : 2000;
    }
    async function poll(restart = false) {
      clearTimeout(setupTimer);
      if (modal !== view.element || document.hidden || busy || finished || stopped && !restart) return;
      stopped = false;
      busy = true; retry.disabled = true;
      try {
        const data = await request('/agents/' + agent.id + '/setup', restart || shouldStart);
        shouldStart = false;
        if (modal !== view.element) return;
        showStatus(data);
        if (data.status === 'connected') { finished = true; await refresh(false, true); }
      } catch (error) {
        if (modal === view.element) {
          stopped = error.message === 'not_found';
          if (stopped) qr.hidden = true;
          status.textContent = errorText(error); retry.hidden = false;
        }
      } finally {
        busy = false; retry.disabled = false;
        if (modal === view.element && !document.hidden && !finished && !stopped) setupTimer = setTimeout(safe(() => poll()), interval);
      }
    }
    if (!start && agent.setup === 'none') showStatus({ status: 'none' });
    pollSetup = () => poll(); poll();
  }
  function confirmDelete(card, trigger, agent) {
    if (content.querySelector('[data-wp-feishu-bot-confirm]')) return;
    const box = node('div', undefined, 'wp-feishu-bot-confirm'); box.setAttribute('data-wp-feishu-bot-confirm', '');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', '确认删除子助手');
    box.append(node('p', '删除子助手「' + agent.name + '」？它的消息桥会停止，工作目录移到回收目录。飞书里的机器人不会被删除，如不再需要请点「管理」到飞书开放平台删除。'));
    const actions = node('div', undefined, 'wp-feishu-bot-actions');
    const cancel = button('取消', () => { box.remove(); trigger.focus(); render(); });
    const confirm = button('确认删除', async () => {
      if (confirm.disabled) return;
      confirm.disabled = true; cancel.disabled = true;
      try {
        await request('/agents/' + agent.id + '/delete', true);
        box.remove(); notify('已删除'); await refresh(false, true);
      } catch (error) { notify(errorText(error)); }
      finally { confirm.disabled = false; cancel.disabled = false; }
    });
    actions.append(cancel, confirm); box.append(actions); card.append(box); cancel.focus();
  }
  function updateAdd() {
    if (!addButton) return;
    const full = bots.length && subAgents.enabled && subAgents.count >= subAgents.limit;
    addButton.disabled = Boolean(!loaded || (!bots.length && !connectionEntry()) || full);
    const text = full ? '子助手最多 5 个（主助手另算），删掉不用的再建' : '请刷新页面后重试';
    addButton.title = addButton.disabled ? text : '';
    const hint = addButton.querySelector('.wp-feishu-bot-add-hint');
    if (hint.textContent !== text) hint.textContent = text;
    hint.hidden = !addButton.disabled;
    if (addButton.disabled) addButton.setAttribute('aria-describedby', 'wp-feishu-bot-add-hint');
    else addButton.removeAttribute('aria-describedby');
  }
  function description(bot) {
    if (bot.error) return '暂时拿不到机器人信息';
    const time = Date.parse(bot.lastEventAt);
    return 'App ID ' + bot.appId + (Number.isFinite(time)
      ? ' · 最近消息 ' + Math.max(0, Math.floor((Date.now() - time) / 60000)) + ' 分钟前' : '');
  }
  function render() {
    if (!content || revoked) return;
    // Preserve in-progress confirmation and menu interactions during background refreshes.
    if (content.querySelector('[data-wp-feishu-bot-confirm], .wp-feishu-bot-menu')) return;
    const focused = document.activeElement;
    const focusIndex = [...content.querySelectorAll('button, a')].indexOf(focused);
    content.replaceChildren();
    addButton = button('', () => {
      if (bots.length && subAgents.enabled) { nameDialog(undefined, addButton); return; }
      if (bots.length) {
        notify('一个工作伙伴暂时只能连一个飞书机器人，多个子助手的功能做好后开放'); return;
      }
      connectionEntry()?.click();
    }, bots.length && subAgents.enabled ? '新建子助手' : '连接飞书机器人');
    addButton.className = 'wp-feishu-bot-add';
    const plus = node('span', '＋', 'wp-feishu-bot-plus'); plus.setAttribute('aria-hidden', 'true');
    const hint = node('small', '请刷新页面后重试', 'wp-feishu-bot-add-hint'); hint.id = 'wp-feishu-bot-add-hint';
    addButton.append(plus, node('span', bots.length && subAgents.enabled ? '新建子助手' : '连接飞书机器人'), hint); content.append(addButton); updateAdd();
    const entries = bots.filter(bot => !bot.agentId || bot.agentId === 'main').map(bot => ({ bot }));
    for (const agent of agents.filter(agent => agent.kind === 'sub')) entries.push({ agent, bot: bots.find(bot => bot.agentId === agent.id) });
    for (const { bot, agent } of entries) {
      const id = agent?.id || 'main', titleText = agent ? agent.name : name(bot);
      const card = node('section', undefined, 'wp-feishu-bot-card');
      card.dataset.agentId = id; if (bot) card.dataset.appId = bot.appId;
      const heading = node('div', undefined, 'wp-feishu-bot-heading');
      const title = node('h3', titleText); title.title = titleText;
      const setupText = bot ? '' : { waiting: '等待扫码', needs_identity: '待管理员完成连接' }[agent.setup] || '还没连接飞书';
      const identity = node('div', undefined, 'wp-feishu-bot-identity'); identity.append(title);
      if (subAgents.enabled) identity.append(node('small', agent ? '子助手' : '主助手', 'wp-feishu-bot-tag'));
      const cardState = bot ? state(bot) : node('span', setupText, 'wp-feishu-bot-state');
      if (!bot) cardState.setAttribute('aria-hidden', 'true');
      identity.append(cardState);
      heading.append(avatar(bot || agent), identity);
      const footer = node('div', undefined, 'wp-feishu-bot-footer');
      if (!bot) footer.className += ' wp-feishu-bot-unconnected';
      const summary = node('p', bot ? (agent && bot.name && bot.name !== agent.name ? '飞书机器人：' + bot.name + ' · ' : '') + description(bot) : setupText, 'wp-feishu-bot-summary'); summary.title = summary.textContent;
      const actions = node('div', undefined, 'wp-feishu-bot-actions');
      if (bot) {
        const chat = link('去对话', bot.openUrl, 'chat'); chat.className = 'wp-feishu-bot-chat';
        actions.append(chat, link('管理', 'https://open.feishu.cn/app/' + encodeURIComponent(bot.appId), 'manage'));
      } else if (agent.setup !== 'needs_identity') {
        const connect = button('扫码连接', () => setupDialog(agent, undefined, true, connect));
        connect.className = 'wp-feishu-bot-chat'; actions.append(connect);
      }
      const more = button('…', () => {
        const existing = card.querySelector('.wp-feishu-bot-menu');
        if (existing) { closeMenu?.(); return; }
        closeMenu?.();
        const menu = node('div', undefined, 'wp-feishu-bot-menu'); menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', '机器人操作');
        let closed = false;
        const close = (restoreFocus = false) => {
          if (closed) return;
          // Removing a focused menu synchronously fires focusout before detachment.
          // Mark it closed first so that event cannot recursively remove it.
          closed = true; document.removeEventListener('pointerdown', outside, true);
          closeMenu = undefined; menu.remove(); more.setAttribute('aria-expanded', 'false');
          if (restoreFocus) more.focus();
        };
        const outside = safe(event => { if (!card.contains(event.target)) close(); });
        closeMenu = close; document.addEventListener('pointerdown', outside, true);
        if (bot) {
          const copyButton = button('复制 App ID', () => { close(true); return copy(bot.appId); });
          const reconnect = button('重新连接', () => { close(true); confirmReconnect(card, more, id); }); reconnect.disabled = reconnecting;
          menu.append(copyButton, reconnect);
        }
        if (agent) menu.append(button('改名', () => { close(true); nameDialog(agent, more); }),
          button('删除', () => { close(true); confirmDelete(card, more, agent); }));
        card.append(menu); more.setAttribute('aria-expanded', 'true'); menu.querySelector('button')?.focus();
        menu.addEventListener('keydown', safe(event => { if (event.key === 'Escape') { event.preventDefault(); close(true); render(); } }));
        // Safari may focus the containing section on mouse down instead of the button.
        menu.addEventListener('mousedown', safe(event => event.preventDefault()));
        menu.addEventListener('focusout', safe(event => {
          if (event.relatedTarget && !card.contains(event.relatedTarget)) close();
        }));
      }, '更多操作');
      more.className = 'wp-feishu-bot-more'; more.setAttribute('aria-expanded', 'false');
      actions.append(more); footer.append(summary, actions); card.append(heading, footer); content.append(card);
    }
    if (focusIndex >= 0) content.querySelectorAll('button, a')[focusIndex]?.focus();
  }
  function reveal() {
    if (!revealHome || !section?.isConnected) return;
    revealHome = false; section.focus({ preventScroll: true }); section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section.classList.add('wp-feishu-bot-highlight'); clearTimeout(highlightTimer);
    highlightTimer = setTimeout(safe(() => section?.classList.remove('wp-feishu-bot-highlight')), 1800);
  }
  function show() {
    document.querySelectorAll('.wp-pick-menu').forEach(element => element.remove());
    document.querySelectorAll('button.wp-user').forEach(element => element.setAttribute('aria-expanded', 'false'));
    revealHome = true;
    if (!document.querySelector('[data-testid="guid-input"]')) location.hash = '#/guid';
    mount(); reveal(); refresh();
  }
  function mount() {
    if (revoked) return;
    for (const menu of document.querySelectorAll('.wp-settings-menu')) {
      const anchor = menu.querySelector('[data-wp-feedback], [data-wp-my-key]')
        || [...menu.querySelectorAll('[role="menuitem"]')].filter(element => !element.matches('[data-wp-feishu-bot]')).at(-1);
      if (!anchor) continue;
      let entry = menu.querySelector('[data-wp-feishu-bot]');
      if (!entry) {
        entry = button('我的飞书机器人', event => { event.stopPropagation(); show(); });
        entry.className = 'wp-pick-item'; entry.setAttribute('role', 'menuitem'); entry.setAttribute('data-wp-feishu-bot', '');
      }
      if (entry.nextElementSibling !== anchor) menu.insertBefore(entry, anchor);
      const sep = menu.querySelector('[data-wp-feishu-bot-separator]');
      if (sep && (sep.nextElementSibling !== entry || sep.previousElementSibling?.matches('.wp-pick-sep'))) sep.remove();
      if (!entry.previousElementSibling?.matches('.wp-pick-sep')) {
        const separator = node('div', undefined, 'wp-pick-sep'); separator.setAttribute('data-wp-feishu-bot-separator', '');
        menu.insertBefore(separator, entry);
      }
      const user = document.querySelector('button.wp-user');
      if (user) {
        const rect = user.getBoundingClientRect();
        menu.style.maxHeight = Math.max(0, Math.min(rect.top - 14, innerHeight - 16)) + 'px'; menu.style.overflowY = 'auto';
        menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(rect.top - menu.offsetHeight - 6, innerHeight - menu.offsetHeight - 8)) + 'px';
      }
    }
    const home = document.querySelector('[data-testid="guid-input"]');
    if (!home) { closeMenu?.(); section?.remove(); return; }
    if (!section) {
      section = node('section', undefined, 'wp-feishu-bot-section'); section.tabIndex = -1;
      section.setAttribute('aria-labelledby', 'wp-feishu-bot-title');
      const header = node('div', undefined, 'wp-feishu-bot-header');
      const title = node('h2', '我的飞书机器人'); title.id = 'wp-feishu-bot-title';
      refreshButton = button('刷新', () => refresh(true)); refreshButton.disabled = Boolean(pending);
      staleHint = node('small', '数据可能已过期', 'wp-feishu-bot-stale'); staleHint.hidden = !stale;
      header.append(title, staleHint, refreshButton);
      message = node('p', '', 'wp-feishu-bot-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
      content = node('div', undefined, 'wp-feishu-bot-cards');
      section.append(header, message, content); render();
    }
    // Place outside the composer so its flex layout and send controls keep their own width.
    const composer = home.closest('[class*="_guidInputCardWrap"]') || home.closest('form') || home.parentElement;
    const anchor = composer && composer !== document.body && composer.tagName !== 'MAIN' ? composer : home;
    if (anchor.nextElementSibling !== section) anchor.after(section);
    updateAdd(); reveal();
  }
  function scheduleMount() {
    if (revoked || mountFrame != null) return;
    mountFrame = requestAnimationFrame(safe(() => { mountFrame = null; mount(); }));
  }
  function onHashChange() {
    if (location.hash && location.hash !== '#/guid') revealHome = false;
    scheduleMount();
  }
  const onVisibility = safe(() => {
    clearTimeout(timer); clearTimeout(reconnectTimer); clearTimeout(setupTimer);
    if (!document.hidden) { refresh(); pollSetup?.(); }
  });
  function init() {
    style = node('style'); style.textContent = `
.wp-feishu-bot-tag { display:inline-block; margin-right:8px; padding:0 5px; border-radius:4px; background:var(--wp-hover, #eee); color:var(--wp-ink-2, #666); }
.wp-feishu-bot-dialog { box-sizing:border-box; width:480px; max-width:calc(100vw - 32px); max-height:calc(100dvh - 32px); padding:0; border:1px solid var(--wp-line, #ddd); border-radius:16px; color:var(--wp-ink, #222); background:var(--wp-card, #fff); font:14px/1.6 var(--wp-font, system-ui); overflow:hidden; }
.wp-feishu-bot-dialog[open] { display:flex; flex-direction:column; }
.wp-feishu-bot-dialog::backdrop { background:rgba(0,0,0,.45); }
.wp-feishu-bot-dialog-header { display:flex; align-items:center; gap:12px; padding:16px 20px; flex:none; border-bottom:1px solid var(--wp-line, #ddd); }
.wp-feishu-bot-dialog h2 { flex:1; margin:0; font-size:18px; overflow-wrap:anywhere; min-width:0; }
.wp-feishu-bot-dialog-body { padding:20px; overflow-y:auto; min-height:0; overflow-wrap:anywhere; }
.wp-feishu-bot-dialog input { box-sizing:border-box; width:100%; padding:8px; border:1px solid var(--wp-line, #ddd); border-radius:8px; background:var(--wp-main, #fff); color:inherit; font:inherit; }
.wp-feishu-bot-dialog button { padding:8px 12px; border:1px solid var(--wp-line, #ddd); border-radius:8px; background:var(--wp-card, #fff); color:inherit; font:inherit; cursor:pointer; }
.wp-feishu-bot-dialog button:disabled { opacity:.5; cursor:not-allowed; }
.wp-feishu-bot-dialog :focus-visible { outline:2px solid var(--wp-accent, #1f5ff0); outline-offset:2px; }
.wp-feishu-bot-dialog img { display:block; max-width:100%; width:240px; margin:16px auto; }
.wp-feishu-bot-dialog [hidden] { display:none; }
.wp-feishu-bot-input-error { color:var(--wp-ink-2, #666); }
main:has(.wp-feishu-bot-section) { overflow-y:auto !important; }
main [class*="_guidContainer_"]:has(.wp-feishu-bot-section) { height:auto; min-height:0; flex:1 0 auto; overflow:visible; justify-content:flex-start; }
.wp-feishu-bot-section { position:relative; flex-shrink:0; box-sizing:border-box; width:100%; max-width:1080px; min-width:0; margin:24px auto; scroll-margin-top:24px; color:var(--wp-ink, #222); font:14px/1.6 var(--wp-font, system-ui); border-radius:16px; transition:box-shadow .2s; }
.wp-feishu-bot-section * { box-sizing:border-box; min-width:0; }
.wp-feishu-bot-highlight { box-shadow:0 0 0 3px var(--wp-accent, #1f5ff0); }
.wp-feishu-bot-header { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.wp-feishu-bot-header h2 { flex:1; margin:0; font-size:18px; }
.wp-feishu-bot-stale { color:var(--wp-ink-2, #666); font-size:12px; }
.wp-feishu-bot-section button, .wp-feishu-bot-section a { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; border:1px solid var(--wp-line, #ddd); border-radius:10px; padding:7px 10px; font:inherit; color:var(--wp-ink, #222); background:var(--wp-card, #fff); text-decoration:none; }
.wp-feishu-bot-header button { font-size:12px; padding:3px 10px; }
.wp-feishu-bot-section button:hover, .wp-feishu-bot-section a:hover { background:var(--wp-hover, #f3f4f6); }
.wp-feishu-bot-section button:disabled { opacity:.5; cursor:not-allowed; }
.wp-feishu-bot-section :focus-visible { outline:2px solid var(--wp-accent, #1f5ff0); outline-offset:3px; }
.wp-feishu-bot-message { position:fixed; z-index:50; left:50%; bottom:24px; transform:translateX(-50%); width:max-content; max-width:calc(100vw - 32px); margin:0; padding:10px 16px; border:1px solid var(--wp-line, #ddd); border-radius:12px; color:var(--wp-ink, #222); background:var(--wp-card, #fff); box-shadow:0 4px 16px var(--wp-shadow, rgba(0,0,0,.12)); overflow-wrap:anywhere; pointer-events:none; }
.wp-feishu-bot-message:empty { display:none; }
.wp-feishu-bot-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px; }
.wp-feishu-bot-card, .wp-feishu-bot-section .wp-feishu-bot-add { position:relative; min-height:200px; border:1px solid var(--wp-line, #ddd); border-radius:16px; padding:20px; background:var(--wp-card, #fff); box-shadow:0 3px 12px var(--wp-shadow, rgba(0,0,0,.04)); }
.wp-feishu-bot-card { display:flex; flex-direction:column; }
.wp-feishu-bot-heading { display:flex; align-items:flex-start; gap:12px; flex:1; }
.wp-feishu-bot-identity { flex:1; }
.wp-feishu-bot-heading h3 { font-size:20px; line-height:1.4; font-weight:650; margin:0 0 4px; overflow-wrap:anywhere; white-space:normal; }
@media(min-width:768px) { .wp-feishu-bot-heading h3 { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; } }
.wp-feishu-bot-avatar { width:48px; height:48px; flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:12px; overflow:hidden; font-size:24px; background:var(--wp-hover, #eee); }
.wp-feishu-bot-avatar img { width:100%; height:100%; object-fit:cover; }
.wp-feishu-bot-state { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--wp-ink-2, #666); }
.wp-feishu-bot-dot { width:8px; height:8px; flex:none; border-radius:50%; background:var(--wp-ink-3, #888); }
.wp-feishu-bot-dot[data-state=online] { background:#27834d; }
.wp-feishu-bot-dot[data-state=offline] { background:#b45309; }
html[data-theme=dark] .wp-feishu-bot-dot[data-state=online] { background:#72d49a; }
html[data-theme=dark] .wp-feishu-bot-dot[data-state=offline] { background:#ffc17a; }
.wp-feishu-bot-footer { display:grid; margin-top:20px; padding-top:16px; border-top:1px solid var(--wp-line, #ddd); }
.wp-feishu-bot-summary, .wp-feishu-bot-footer > .wp-feishu-bot-actions { grid-area:1/1; align-self:center; }
.wp-feishu-bot-summary { margin:0; min-height:44px; color:var(--wp-ink-2, #666); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.wp-feishu-bot-actions { display:flex; align-items:center; gap:8px; }
.wp-feishu-bot-footer > .wp-feishu-bot-actions { opacity:0; pointer-events:none; }
.wp-feishu-bot-actions a { flex:1; white-space:nowrap; }
.wp-feishu-bot-actions svg { width:18px; height:18px; flex:none; }
.wp-feishu-bot-actions .wp-feishu-bot-chat, .wp-feishu-bot-actions .wp-feishu-bot-chat:hover { color:var(--wp-accent-ink, #fff); background:var(--wp-accent, #1f5ff0); border-color:var(--wp-accent, #1f5ff0); }
.wp-feishu-bot-actions .wp-feishu-bot-more { width:38px; height:38px; flex:none; padding:0; font-size:20px; }
.wp-feishu-bot-card:hover .wp-feishu-bot-summary, .wp-feishu-bot-card:focus-within .wp-feishu-bot-summary { visibility:hidden; }
.wp-feishu-bot-card:hover .wp-feishu-bot-footer > .wp-feishu-bot-actions, .wp-feishu-bot-card:focus-within .wp-feishu-bot-footer > .wp-feishu-bot-actions { opacity:1; pointer-events:auto; }
.wp-feishu-bot-unconnected { display:flex; flex-direction:column; gap:12px; }
.wp-feishu-bot-card .wp-feishu-bot-unconnected > .wp-feishu-bot-summary { visibility:visible; width:100%; min-height:0; }
.wp-feishu-bot-card .wp-feishu-bot-unconnected > .wp-feishu-bot-actions { opacity:1; pointer-events:auto; width:100%; }
.wp-feishu-bot-section .wp-feishu-bot-add { display:flex; flex-direction:column; gap:8px; color:var(--wp-ink-2, #666); }
.wp-feishu-bot-plus { font-size:48px; line-height:1; color:var(--wp-ink, #222); }
.wp-feishu-bot-menu { position:absolute; z-index:2; right:20px; bottom:64px; display:flex; flex-direction:column; padding:6px; border:1px solid var(--wp-line, #ddd); border-radius:12px; background:var(--wp-card, #fff); box-shadow:0 4px 16px var(--wp-shadow, rgba(0,0,0,.12)); }
.wp-feishu-bot-menu button { justify-content:flex-start; border:0; }
.wp-feishu-bot-confirm { margin-top:16px; padding-top:12px; border-top:1px solid var(--wp-line, #ddd); }
.wp-feishu-bot-confirm p { margin:0 0 8px; }
.wp-feishu-bot-confirm .wp-feishu-bot-actions { flex-wrap:wrap; }
@media(max-width:767px) { .wp-feishu-bot-cards { grid-template-columns:minmax(0, 1fr); } }
@media(hover:none), (max-width:767px) {
  .wp-feishu-bot-footer { display:flex; flex-direction:column; gap:12px; }
  .wp-feishu-bot-card .wp-feishu-bot-summary, .wp-feishu-bot-card:hover .wp-feishu-bot-summary, .wp-feishu-bot-card:focus-within .wp-feishu-bot-summary { visibility:visible; width:100%; min-height:0; }
  .wp-feishu-bot-card .wp-feishu-bot-footer > .wp-feishu-bot-actions { opacity:1; pointer-events:auto; width:100%; }
}
`;
    document.head.append(style); mount(); refresh();
    observer = new MutationObserver(safe(scheduleMount)); observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleMount); window.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(init), { once: true });
  else safe(init)();
}
