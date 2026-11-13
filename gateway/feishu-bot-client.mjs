/** Gateway-only UI, serialized without user or deployment data. */
export function feishuBotClient() {
  return `\n;(${installFeishuBot.toString()})();`;
}

function installFeishuBot() {
  const API = '/_wp/feishu-bot';
  let bots = [], section, content, message, refreshButton, addButton, observer, style, mountFrame;
  let highlightTimer, revealHome = false, loaded = false;
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
    if (bot.avatar) { const image = node('img'); image.src = bot.avatar; image.alt = ''; element.append(image); }
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
    revoked = true; bots = []; clearTimeout(timer); clearTimeout(reconnectTimer); clearTimeout(highlightTimer);
    if (mountFrame != null) cancelAnimationFrame(mountFrame);
    mountFrame = null; observer?.disconnect();
    window.removeEventListener('resize', scheduleMount); window.removeEventListener('hashchange', scheduleMount);
    document.removeEventListener('visibilitychange', onVisibility);
    document.querySelectorAll('[data-wp-feishu-bot], [data-wp-feishu-bot-separator]').forEach(element => element.remove());
    section?.remove(); style?.remove();
  }
  async function request(route, post = false) {
    const response = await fetch(API + route, { method: post ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(post ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    if (!response.ok) {
      if ([401, 404].includes(response.status)) revoke();
      throw new Error('unavailable');
    }
    return response.json();
  }
  function schedule() {
    clearTimeout(timer);
    if (!document.hidden && !revoked) timer = setTimeout(safe(() => refresh()), 60000);
  }
  function refresh(force = false) {
    if (revoked) return Promise.resolve();
    if (pending) return pending;
    if (refreshButton) refreshButton.disabled = true;
    pending = (async () => {
      try {
        const data = await request('/bots' + (force ? '?refresh=1' : ''));
        if (revoked) return;
        bots = data.bots; loaded = true; mount(); render();
        if (message && !reconnecting) message.textContent = '';
      } catch {
        if (message && !revoked) message.textContent = '暂时无法读取机器人信息，请稍后刷新。';
      } finally {
        pending = undefined;
        if (refreshButton) refreshButton.disabled = false;
        schedule();
      }
    })();
    return pending;
  }
  async function copy(appId) {
    try { await navigator.clipboard.writeText(appId); if (!revoked) message.textContent = '已复制 App ID'; }
    catch { if (!revoked) message.textContent = '复制失败，请手动复制 App ID。'; }
  }
  function confirmReconnect(card, trigger) {
    if (reconnecting || content.querySelector('[data-wp-feishu-bot-confirm]')) return;
    const box = node('div', undefined, 'wp-feishu-bot-confirm'); box.setAttribute('data-wp-feishu-bot-confirm', '');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', '确认重新连接');
    box.append(node('p', '重新连接飞书机器人？这会短暂中断飞书连接。'));
    const actions = node('div', undefined, 'wp-feishu-bot-actions');
    const cancel = button('取消', () => { box.remove(); trigger.focus(); render(); });
    actions.append(cancel, button('确认重新连接', async () => {
      if (reconnecting) return;
      reconnecting = true; box.remove(); trigger.focus(); render(); message.textContent = '正在重新连接…';
      try {
        await request('/reconnect', true);
        if (revoked) return;
        message.textContent = '已重新连接，稍后刷新状态。';
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(safe(() => { if (!document.hidden) refresh(); }), 3000);
      } catch { if (!revoked) message.textContent = '重新连接失败，请稍后重试。'; }
      finally { reconnecting = false; render(); }
    }));
    box.append(actions); card.append(box); cancel.focus();
  }
  function connectionEntry() {
    return document.querySelector('.wp-feishu-banner button:not(.wp-feishu-dismiss)');
  }
  function updateAdd() {
    if (!addButton) return;
    addButton.disabled = !loaded || (!bots.length && !connectionEntry());
    addButton.title = addButton.disabled ? '连接入口暂不可用，请稍后刷新' : '';
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
      if (bots.length) {
        message.textContent = '一个工作伙伴暂时只能连一个飞书机器人，多个子助手的功能做好后开放'; return;
      }
      connectionEntry()?.click();
    }, '连接飞书机器人');
    addButton.className = 'wp-feishu-bot-add';
    const plus = node('span', '＋', 'wp-feishu-bot-plus'); plus.setAttribute('aria-hidden', 'true');
    addButton.append(plus, node('span', '连接飞书机器人')); content.append(addButton); updateAdd();
    for (const bot of bots) {
      const card = node('section', undefined, 'wp-feishu-bot-card'); card.dataset.appId = bot.appId;
      const heading = node('div', undefined, 'wp-feishu-bot-heading');
      const identity = node('div', undefined, 'wp-feishu-bot-identity'); identity.append(node('h3', name(bot)), state(bot));
      heading.append(avatar(bot), identity);
      const footer = node('div', undefined, 'wp-feishu-bot-footer');
      const summary = node('p', description(bot), 'wp-feishu-bot-summary'); summary.title = summary.textContent;
      const actions = node('div', undefined, 'wp-feishu-bot-actions');
      const chat = link('去对话', bot.openUrl, 'chat'); chat.className = 'wp-feishu-bot-chat';
      const manage = link('管理', 'https://open.feishu.cn/app/' + encodeURIComponent(bot.appId), 'manage');
      const more = button('…', () => {
        const existing = card.querySelector('.wp-feishu-bot-menu');
        if (existing) { existing.remove(); more.setAttribute('aria-expanded', 'false'); return; }
        const menu = node('div', undefined, 'wp-feishu-bot-menu'); menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', '机器人操作');
        const close = () => { menu.remove(); more.setAttribute('aria-expanded', 'false'); more.focus(); };
        const copyButton = button('复制 App ID', () => { close(); return copy(bot.appId); });
        const reconnect = button('重新连接', () => { close(); confirmReconnect(card, more); }); reconnect.disabled = reconnecting;
        menu.append(copyButton, reconnect); card.append(menu); more.setAttribute('aria-expanded', 'true'); copyButton.focus();
        menu.addEventListener('keydown', safe(event => { if (event.key === 'Escape') { event.preventDefault(); close(); render(); } }));
        menu.addEventListener('focusout', safe(() => queueMicrotask(safe(() => {
          if (!card.contains(document.activeElement) && menu.isConnected) { menu.remove(); more.setAttribute('aria-expanded', 'false'); }
        }))));
      }, '更多操作');
      more.className = 'wp-feishu-bot-more'; more.setAttribute('aria-expanded', 'false');
      actions.append(chat, manage, more); footer.append(summary, actions); card.append(heading, footer); content.append(card);
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
    if (!home) { section?.remove(); return; }
    if (!section) {
      section = node('section', undefined, 'wp-feishu-bot-section'); section.tabIndex = -1;
      section.setAttribute('aria-labelledby', 'wp-feishu-bot-title');
      const header = node('div', undefined, 'wp-feishu-bot-header');
      const title = node('h2', '我的飞书机器人'); title.id = 'wp-feishu-bot-title';
      refreshButton = button('刷新', () => refresh(true)); refreshButton.disabled = Boolean(pending);
      header.append(title, refreshButton);
      message = node('p', '', 'wp-feishu-bot-message'); message.setAttribute('role', 'status');
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
  const onVisibility = safe(() => {
    clearTimeout(timer); clearTimeout(reconnectTimer);
    if (!document.hidden) refresh();
  });
  function init() {
    style = node('style'); style.textContent = `
.wp-feishu-bot-section { box-sizing:border-box; width:100%; max-width:1080px; min-width:0; margin:24px auto; scroll-margin-top:24px; color:var(--wp-ink, #222); font:14px/1.6 var(--wp-font, system-ui); border-radius:16px; transition:box-shadow .2s; }
.wp-feishu-bot-section * { box-sizing:border-box; min-width:0; }
.wp-feishu-bot-highlight { box-shadow:0 0 0 3px var(--wp-accent, #1f5ff0); }
.wp-feishu-bot-header { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.wp-feishu-bot-header h2 { flex:1; margin:0; font-size:18px; }
.wp-feishu-bot-section button, .wp-feishu-bot-section a { display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; border:1px solid var(--wp-line, #ddd); border-radius:10px; padding:7px 10px; font:inherit; color:var(--wp-ink, #222); background:var(--wp-card, #fff); text-decoration:none; }
.wp-feishu-bot-header button { font-size:12px; padding:3px 10px; }
.wp-feishu-bot-section button:hover, .wp-feishu-bot-section a:hover { background:var(--wp-hover, #f3f4f6); }
.wp-feishu-bot-section button:disabled { opacity:.5; cursor:not-allowed; }
.wp-feishu-bot-section :focus-visible { outline:2px solid var(--wp-accent, #1f5ff0); outline-offset:3px; }
.wp-feishu-bot-message { margin:0 0 12px; overflow-wrap:anywhere; }
.wp-feishu-bot-message:empty { display:none; }
.wp-feishu-bot-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px; }
.wp-feishu-bot-card, .wp-feishu-bot-section .wp-feishu-bot-add { position:relative; border:1px solid var(--wp-line, #ddd); border-radius:16px; padding:20px; background:var(--wp-card, #fff); box-shadow:0 3px 12px var(--wp-shadow, rgba(0,0,0,.04)); }
.wp-feishu-bot-card { display:flex; flex-direction:column; }
.wp-feishu-bot-heading { display:flex; align-items:flex-start; gap:12px; flex:1; }
.wp-feishu-bot-identity { flex:1; }
.wp-feishu-bot-heading h3 { font-size:20px; line-height:1.4; font-weight:650; margin:0 0 4px; overflow-wrap:anywhere; white-space:normal; }
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
.wp-feishu-bot-section .wp-feishu-bot-add { display:flex; flex-direction:column; gap:8px; min-height:192px; color:var(--wp-ink-2, #666); }
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
    window.addEventListener('resize', scheduleMount); window.addEventListener('hashchange', scheduleMount);
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(init), { once: true });
  else safe(init)();
}
