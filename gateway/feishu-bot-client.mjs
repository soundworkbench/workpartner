/** Gateway-only UI, serialized without user or deployment data. */
export function feishuBotClient() {
  return `\n;(${installFeishuBot.toString()})();`;
}

function installFeishuBot() {
  const API = '/_wp/feishu-bot';
  let bots = [], dialog, content, message, refreshButton, bar, observer, previousFocus;
  let pending, timer, reconnectTimer, revoked = false, reconnecting = false;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function button(text, action, label = text) {
    const element = node('button', text); element.type = 'button'; element.setAttribute('aria-label', label);
    element.addEventListener('click', action); return element;
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
  function chat(bot) {
    const link = node('a', '对话'); link.href = bot.openUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  }
  function revoke() {
    revoked = true; bots = []; clearTimeout(timer); clearTimeout(reconnectTimer); observer?.disconnect();
    document.querySelectorAll('[data-wp-feishu-bot]').forEach(element => element.remove());
    bar?.remove(); dialog?.close();
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
    if (!document.hidden && !revoked) timer = setTimeout(() => refresh(), 60000);
  }
  function refresh(force = false) {
    if (revoked) return Promise.resolve();
    if (pending) return pending;
    if (refreshButton) refreshButton.disabled = true;
    pending = (async () => {
      try {
        const data = await request('/bots' + (force ? '?refresh=1' : ''));
        if (revoked) return;
        bots = data.bots; bar?.remove(); bar = undefined; mount(); render();
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
    try { await navigator.clipboard.writeText(appId); message.textContent = '已复制 App ID'; }
    catch { message.textContent = '复制失败，请手动复制 App ID。'; }
  }
  function confirmReconnect() {
    if (reconnecting || content.querySelector('[data-wp-feishu-bot-confirm]')) return;
    const box = node('div', undefined, 'wp-feishu-bot-confirm'); box.setAttribute('data-wp-feishu-bot-confirm', '');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', '确认重新连接');
    box.append(node('p', '重新连接飞书机器人？这会短暂中断飞书连接。'));
    const actions = node('div', undefined, 'wp-feishu-bot-actions');
    const cancel = button('取消', () => { box.remove(); content.querySelector('[data-wp-feishu-bot-reconnect]')?.focus(); });
    actions.append(cancel, button('确认重新连接', async () => {
      if (reconnecting) return;
      reconnecting = true; box.remove(); render(); message.textContent = '正在重新连接…';
      try {
        await request('/reconnect', true);
        if (revoked) return;
        message.textContent = '已重新连接，稍后刷新状态。';
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { if (!document.hidden) refresh(); }, 3000);
      } catch { if (!revoked) message.textContent = '重新连接失败，请稍后重试。'; }
      finally { reconnecting = false; render(); }
    }));
    box.append(actions); content.prepend(box); cancel.focus();
  }
  function render() {
    if (!dialog?.open || revoked) return;
    // Keep the confirmation and focused card controls stable during background refreshes.
    if (content.querySelector('[data-wp-feishu-bot-confirm]')) return;
    const focused = document.activeElement;
    const focusIndex = [...content.querySelectorAll('button, a')].indexOf(focused);
    content.replaceChildren();
    if (!bots.length) { content.append(node('p', '还没连接飞书机器人，在首页点「开通」扫码即可')); return; }
    const cards = node('div', undefined, 'wp-feishu-bot-cards');
    for (const bot of bots) {
      const card = node('section', undefined, 'wp-feishu-bot-card');
      const heading = node('div', undefined, 'wp-feishu-bot-heading'); heading.append(avatar(bot), node('h3', name(bot)));
      const id = node('div', undefined, 'wp-feishu-bot-id'); id.append(node('span', 'App ID'), node('code', bot.appId), button('复制', () => copy(bot.appId), '复制 App ID'));
      const actions = node('div', undefined, 'wp-feishu-bot-actions');
      const reconnect = button('重新连接', confirmReconnect); reconnect.setAttribute('data-wp-feishu-bot-reconnect', ''); reconnect.disabled = reconnecting;
      actions.append(chat(bot), reconnect); card.append(heading, state(bot), id, actions);
      if (bot.error) card.append(node('p', '暂时拿不到机器人信息', 'wp-feishu-bot-muted'));
      cards.append(card);
    }
    content.append(cards);
    if (focusIndex >= 0) content.querySelectorAll('button, a')[focusIndex]?.focus();
  }
  function show() {
    previousFocus = document.activeElement;
    document.querySelectorAll('.wp-pick-menu').forEach(element => element.remove());
    document.querySelectorAll('button.wp-user').forEach(element => element.setAttribute('aria-expanded', 'false'));
    if (!dialog) {
      dialog = node('dialog', undefined, 'wp-feishu-bot-dialog'); dialog.setAttribute('aria-labelledby', 'wp-feishu-bot-title');
      const header = node('div', undefined, 'wp-feishu-bot-header');
      const title = node('h2', '我的飞书机器人'); title.id = 'wp-feishu-bot-title';
      refreshButton = button('刷新', () => refresh(true));
      header.append(title, refreshButton, button('×', () => dialog.close(), '关闭'));
      message = node('p', '', 'wp-feishu-bot-message'); message.setAttribute('role', 'status');
      content = node('div', undefined, 'wp-feishu-bot-body');
      dialog.append(header, message, content); document.body.append(dialog);
      dialog.addEventListener('close', () => {
        content.querySelector('[data-wp-feishu-bot-confirm]')?.remove();
        (previousFocus?.isConnected ? previousFocus : document.querySelector('button.wp-user'))?.focus();
      });
    }
    if (!dialog.open) dialog.showModal();
    render(); refresh();
  }
  function mount() {
    if (revoked) return;
    for (const menu of document.querySelectorAll('.wp-settings-menu')) {
      if (!menu.querySelector('[data-wp-feishu-bot]')) {
        const entry = button('我的飞书机器人', event => { event.stopPropagation(); show(); });
        entry.className = 'wp-pick-item'; entry.setAttribute('role', 'menuitem'); entry.setAttribute('data-wp-feishu-bot', '');
        const anchor = menu.querySelector('[data-wp-feedback], [data-wp-my-key]') || [...menu.querySelectorAll('[role="menuitem"]')].at(-1);
        menu.insertBefore(entry, anchor || null);
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
    if (!home || !bots.length) { bar?.remove(); return; }
    if (bar?.isConnected) return;
    const bot = bots[0]; bar = node('div', undefined, 'wp-feishu-bot-bar');
    bar.append(avatar(bot), node('span', '飞书机器人：' + name(bot), 'wp-feishu-bot-name'), state(bot), chat(bot), button('管理', show));
    home.before(bar);
  }
  function init() {
    const style = node('style'); style.textContent = `
.wp-feishu-bot-dialog, .wp-feishu-bot-bar { color:var(--wp-ink, #222); background:var(--wp-card, #FDFDF8); font:14px/1.6 var(--wp-font, system-ui); overflow-wrap:anywhere; }
.wp-feishu-bot-dialog { position:fixed; inset:0; margin:auto; padding:0; width:min(760px, calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); border:1px solid var(--wp-line, #ddd); border-radius:16px; overflow:hidden; color-scheme:light; }
.wp-feishu-bot-dialog[open] { display:flex; flex-direction:column; }
html[data-theme=dark] .wp-feishu-bot-dialog { color-scheme:dark; }
.wp-feishu-bot-dialog::backdrop { background:rgba(0,0,0,.35); }
.wp-feishu-bot-dialog *, .wp-feishu-bot-bar, .wp-feishu-bot-bar * { box-sizing:border-box; min-width:0; }
.wp-feishu-bot-header { display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid var(--wp-line, #ddd); flex:none; }
.wp-feishu-bot-header h2 { flex:1; margin:0; font-size:18px; }
.wp-feishu-bot-header button { flex:none; }
.wp-feishu-bot-body { padding:16px; overflow:auto; min-height:0; }
.wp-feishu-bot-message { flex:none; margin:0; padding:8px 16px; }
.wp-feishu-bot-message:empty { display:none; }
.wp-feishu-bot-cards { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
.wp-feishu-bot-card, .wp-feishu-bot-confirm { border:1px solid var(--wp-line, #ddd); border-radius:12px; padding:16px; }
.wp-feishu-bot-confirm { margin-bottom:12px; }
.wp-feishu-bot-heading, .wp-feishu-bot-actions, .wp-feishu-bot-id, .wp-feishu-bot-bar { display:flex; align-items:center; gap:8px; }
.wp-feishu-bot-actions, .wp-feishu-bot-id, .wp-feishu-bot-bar { flex-wrap:wrap; }
.wp-feishu-bot-id { margin:12px 0; }
.wp-feishu-bot-id code { font-family:ui-monospace, monospace; overflow-wrap:anywhere; }
.wp-feishu-bot-heading h3 { font-size:16px; margin:0; white-space:normal; }
.wp-feishu-bot-avatar { width:36px; height:36px; flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; overflow:hidden; background:var(--wp-hover, #eee); }
.wp-feishu-bot-avatar img { width:100%; height:100%; object-fit:cover; }
.wp-feishu-bot-state { display:inline-flex; align-items:center; gap:6px; }
.wp-feishu-bot-dot { width:8px; height:8px; flex:none; border-radius:50%; background:var(--wp-ink-3, #888); }
.wp-feishu-bot-dot[data-state=online] { background:#27834d; }
.wp-feishu-bot-dot[data-state=offline] { background:#b45309; }
html[data-theme=dark] .wp-feishu-bot-dot[data-state=online] { background:#72d49a; }
html[data-theme=dark] .wp-feishu-bot-dot[data-state=offline] { background:#ffc17a; }
.wp-feishu-bot-dialog button, .wp-feishu-bot-dialog a, .wp-feishu-bot-bar button, .wp-feishu-bot-bar a { display:inline-block; cursor:pointer; border:1px solid var(--wp-line, #ddd); border-radius:8px; padding:6px 10px; font:inherit; color:var(--wp-send-ink, #fff); background:var(--wp-send, #3C3F43); text-decoration:none; white-space:normal; max-width:100%; }
.wp-feishu-bot-dialog button:hover, .wp-feishu-bot-dialog a:hover, .wp-feishu-bot-bar button:hover, .wp-feishu-bot-bar a:hover { background:var(--wp-send-hover, #2E3237); }
.wp-feishu-bot-dialog button:disabled { opacity:.5; cursor:wait; }
.wp-feishu-bot-dialog :focus-visible, .wp-feishu-bot-bar :focus-visible { outline:2px solid var(--wp-focus-line, #888); outline-offset:2px; }
.wp-feishu-bot-muted { font-size:12px; color:var(--wp-ink-2, #666); margin-bottom:0; }
.wp-feishu-bot-bar { box-sizing:border-box; width:100%; padding:8px 12px; margin-bottom:12px; border:1px solid var(--wp-line, #ddd); border-radius:10px; font-size:13px; }
.wp-feishu-bot-bar .wp-feishu-bot-avatar { width:24px; height:24px; }
.wp-feishu-bot-name { flex:1 1 160px; }
.wp-feishu-bot-bar a, .wp-feishu-bot-bar button { padding:2px 8px; }
@media(max-width:767px) { .wp-feishu-bot-cards { grid-template-columns:minmax(0, 1fr); } }
`;
    document.head.append(style); mount(); refresh();
    observer = new MutationObserver(mount); observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', mount);
    document.addEventListener('visibilitychange', () => {
      clearTimeout(timer); clearTimeout(reconnectTimer);
      if (!document.hidden) refresh();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}
