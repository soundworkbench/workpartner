/** Gateway-only UI. The serialized installer contains no deployment or identity data. */
export function myKeyClient(_options = {}) {
  return `\n;(${installMyKey.toString()})({});`;
}

function installMyKey() {
  try {
    const API = '/_wp/api/my-key', ui = {};
    let dialog, observer, data, hideTimer, statusTimer, settings, language, revoked = false;
    let tab = 'claude', loading = false, busy = false, version = 0, status = '';
    let confirming = false, resetBusy = false, resetResult = '', pollTimer, pollStarted = 0;
    function locale() {
      let value = window.wpSettings ? window.wpSettings.get().language : null;
      if (!value) try { value = localStorage.getItem('i18nextLng'); } catch { /* Default to Chinese. */ }
      return value && /^en/i.test(value) ? 'en-US' : 'zh-CN';
    }
    const t = (zh, en) => locale() === 'en-US' ? en : zh;
    const node = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    const mark = (n, name, value = '') => { n.setAttribute('data-wp-my-key-' + name, value); return n; };
    const failure = () => { status = 'error'; renderStatus(); };
    const safe = fn => (...args) => { try { return Promise.resolve(fn(...args)).catch(failure); } catch { failure(); } };
    function button(action, handler) {
      const b = mark(node('button'), 'action', action); b.type = 'button'; b.addEventListener('click', safe(handler)); return b;
    }
    function closeMenus() {
      document.querySelectorAll('.wp-pick-menu').forEach(n => n.remove());
      document.querySelectorAll('button.wp-user').forEach(n => n.setAttribute('aria-expanded', 'false'));
    }
    function revoke() {
      revoked = true; stopPolling(); observer?.disconnect();
      document.querySelectorAll('[data-wp-my-key], [data-wp-my-key-separator]').forEach(n => n.remove());
      hide(); dialog?.close();
    }
    async function api(action) {
      const response = await fetch(API + (action ? '/reveal' : ''), { method: action ? 'POST' : 'GET',
        credentials: 'same-origin', cache: 'no-store', ...(action ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) } : {}) });
      if (!response.ok) {
        if (!action && (response.status === 401 || response.status === 404)) revoke();
        throw new Error('My key request failed');
      }
      return response.json();
    }
    function menus() {
      if (revoked) return;
      if (window.wpSettings && settings !== window.wpSettings) {
        settings = window.wpSettings; settings.subscribe?.(safe(menus));
      }
      const nextLanguage = locale();
      if (language !== nextLanguage) { language = nextLanguage; if (dialog) render(); }
      document.querySelectorAll('.wp-settings-menu').forEach(menu => {
        const logout = [...menu.querySelectorAll('[role="menuitem"]')].filter(n => !n.matches('[data-wp-feedback], [data-wp-my-key]')).at(-1);
        if (!logout) return;
        let entry = menu.querySelector('[data-wp-my-key]');
        if (!entry) {
          entry = button('open', show); entry.className = 'wp-pick-item'; entry.setAttribute('role', 'menuitem'); entry.setAttribute('data-wp-my-key', '');
          entry.addEventListener('click', event => event.stopPropagation()); menu.insertBefore(entry, logout);
        }
        if (entry.nextElementSibling !== logout) menu.insertBefore(entry, logout);
        const feedback = menu.querySelector('[data-wp-feedback]');
        if (feedback && feedback.nextElementSibling !== entry) menu.insertBefore(feedback, entry);
        let sep = menu.querySelector('[data-wp-my-key-separator]');
        // Feedback may reuse our separator when its installer arrives later.
        if (sep && ((sep.nextElementSibling !== entry && sep.nextElementSibling !== feedback)
          || sep.previousElementSibling?.matches('.wp-pick-sep, [data-wp-feedback]') || sep.nextElementSibling?.matches('.wp-pick-sep'))) { sep.remove(); sep = null; }
        if (!entry.previousElementSibling?.matches('.wp-pick-sep, [data-wp-feedback]')) {
          sep = node('div', undefined, 'wp-pick-sep'); sep.setAttribute('data-wp-my-key-separator', ''); menu.insertBefore(sep, entry);
        }
        const label = t('我的钥匙', 'My key'); if (entry.textContent !== label) entry.textContent = label;
        const avatar = document.querySelector('button.wp-user[aria-expanded="true"]') || document.querySelector('button.wp-user');
        if (!avatar) return;
        const rect = avatar.getBoundingClientRect(); if (!rect.width || !rect.height) return;
        menu.style.maxHeight = Math.max(0, Math.min(rect.top - 14, window.innerHeight - 16)) + 'px'; menu.style.overflowY = 'auto';
        const height = menu.offsetHeight, width = menu.offsetWidth;
        menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(rect.top - height - 6, window.innerHeight - height - 8)) + 'px';
      });
    }
    function styles() {
      const style = node('style'); style.textContent = `
.wp-my-key-dialog { --wp-my-key-warn:#9a3412; --wp-my-key-over:#b42318; position:fixed; inset:0; margin:auto; box-sizing:border-box; width:min(720px, calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:hidden; padding:0; border:1px solid var(--wp-line, #ddd); border-radius:18px; background:var(--wp-card, #FDFDF8); color:var(--wp-ink, #222); font:14px/1.65 var(--wp-font, system-ui); overflow-wrap:anywhere; color-scheme:light; }
html[data-theme="dark"] .wp-my-key-dialog { --wp-my-key-warn:#ffcf85; --wp-my-key-over:#ffb4a9; color-scheme:dark; }
.wp-my-key-dialog::backdrop { background:rgba(0,0,0,.35); }
.wp-my-key-content { --wp-my-key-padding:24px; max-height:calc(100dvh - 26px); overflow:auto; overflow-x:hidden; padding:0 var(--wp-my-key-padding) var(--wp-my-key-padding); }
.wp-my-key-header { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 calc(-1 * var(--wp-my-key-padding)); padding:12px var(--wp-my-key-padding); background:var(--wp-card, #FDFDF8); border-bottom:1px solid var(--wp-line, #ddd); }
.wp-my-key-dialog * { box-sizing:border-box; min-width:0; }
.wp-my-key-dialog [hidden] { display:none!important; }
.wp-my-key-dialog h2 { margin:0; font-size:18px; }
.wp-my-key-dialog h3 { margin:8px 0; font-size:16px; }
.wp-my-key-dialog h4 { margin:16px 0 8px; font-size:14px; }
.wp-my-key-dialog section { border-top:1px solid var(--wp-line, #ddd); padding-top:16px; margin-top:16px; }
.wp-my-key-dialog section[data-wp-my-key-card="key"] { border-top:0; margin-top:0; }
.wp-my-key-dialog section[data-wp-my-key-card="key"] > h3 { margin-top:0; }
.wp-my-key-dialog button { cursor:pointer; max-width:100%; border:1px solid var(--wp-line, #ddd); border-radius:8px; padding:6px 12px; background:var(--wp-send, #3C3F43); color:var(--wp-send-ink, #FCFCFC); font:inherit; font-size:13px; overflow-wrap:anywhere; }
.wp-my-key-dialog button:hover { background:var(--wp-send-hover, #2E3237); }
.wp-my-key-dialog button[data-wp-my-key-action=reset] { background:transparent; border-color:var(--wp-my-key-over); color:var(--wp-my-key-over); }
.wp-my-key-dialog button[data-wp-my-key-action=reset-confirm] { background:var(--wp-my-key-over); border-color:var(--wp-my-key-over); color:var(--wp-card, #FDFDF8); }
.wp-my-key-dialog [data-wp-my-key-confirm] { padding:12px; border:1px solid var(--wp-my-key-over); border-radius:8px; }
.wp-my-key-dialog button:disabled { opacity:.5; cursor:not-allowed; }
.wp-my-key-dialog [role=tab][aria-selected=false] { background:var(--wp-hover, #eee); color:var(--wp-ink, #222); }
.wp-my-key-dialog [role=tab] code, .wp-my-key-models code { font:inherit; color:inherit; background:none; padding:0; }
.wp-my-key-dialog :focus-visible { outline:2px solid var(--wp-focus-line, #888); outline-offset:2px; }
.wp-my-key-dialog .wp-my-key-close { flex:none; padding:4px 8px; font-size:22px; background:transparent; border:0; color:var(--wp-ink-2, #666); }
.wp-my-key-dialog .wp-my-key-close:hover { background:var(--wp-hover, #eee); }
.wp-my-key-row { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.wp-my-key-muted { color:var(--wp-ink-2, #666); }
.wp-my-key-value { display:block; overflow-wrap:anywhere; margin:12px 0; }
.wp-my-key-tiles { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.wp-my-key-tile { padding:12px; border:1px solid var(--wp-line, #ddd); border-radius:8px; }
.wp-my-key-tile[data-state=ready] [data-wp-my-key-percent] { font-size:20px; font-weight:600; }
.wp-my-key-dialog pre { max-width:100%; overflow:auto; padding:12px; background:var(--wp-main, #F2F2ED); border:1px solid var(--wp-line, #ddd); border-radius:8px; font-size:12px; }
.wp-my-key-models { max-height:160px; overflow:auto; overflow-wrap:anywhere; }
.wp-my-key-dialog input { width:100%; max-width:100%; display:block; border:1px solid var(--wp-line, #ddd); border-radius:8px; padding:8px 10px; background:var(--wp-main, #F2F2ED); color:var(--wp-ink, #222); font:inherit; margin:12px 0; }
.wp-my-key-track { height:8px; background:var(--wp-hover, #eee); border-radius:8px; overflow:hidden; }
.wp-my-key-fill { height:100%; background:var(--wp-send, #3C3F43); }
.wp-my-key-tile[data-level=warn] { --wp-my-key-level:var(--wp-my-key-warn); }
.wp-my-key-tile[data-level=over] { --wp-my-key-level:var(--wp-my-key-over); }
.wp-my-key-tile[data-level=warn] .wp-my-key-fill, .wp-my-key-tile[data-level=over] .wp-my-key-fill { background:var(--wp-my-key-level); }
.wp-my-key-tile[data-level=warn] [data-wp-my-key-percent], .wp-my-key-tile[data-level=over] [data-wp-my-key-percent], [data-wp-my-key-over] { color:var(--wp-my-key-level); }
[data-wp-my-key-calls], [data-wp-my-key-over] { font-size:12px; margin-top:6px; }
@media(max-width:400px) { .wp-my-key-content { --wp-my-key-padding:16px; } }
`; document.head.append(style);
    }
    function mount() {
      if (dialog) return;
      styles(); dialog = node('dialog', undefined, 'wp-my-key-dialog'); dialog.setAttribute('aria-labelledby', 'wp-my-key-heading');
      ui.close = button('close', () => { hide(); dialog.close(); }); ui.close.textContent = '×'; ui.close.className = 'wp-my-key-close';
      const content = node('div', undefined, 'wp-my-key-content'); ui.heading = node('h2'); ui.heading.id = 'wp-my-key-heading';
      const header = node('div', undefined, 'wp-my-key-header'); header.append(ui.heading, ui.close); content.append(header);
      for (const name of ['key', 'usage', 'guide']) { ui[name] = mark(node('section'), 'card', name); content.append(ui[name]); }
      ui.keyTitle = node('h3'); ui.value = mark(node('code', '', 'wp-my-key-value'), 'value');
      ui.toggle = button('toggle', () => ui.value.dataset.state === 'shown' ? hide() : reveal('show'));
      ui.copy = button('copy', () => reveal('copy')); ui.actions = node('div', undefined, 'wp-my-key-row'); ui.actions.append(ui.toggle, ui.copy);
      ui.reset = button('reset', () => { if (!data?.reset?.allowed || resetBusy) return; confirming = true; renderReset(); ui.resetCancel.focus(); });
      ui.resetNote = mark(node('p', '', 'wp-my-key-muted'), 'reset-note');
      ui.confirm = mark(node('div'), 'confirm'); ui.confirm.setAttribute('role', 'alertdialog'); ui.confirm.setAttribute('aria-labelledby', 'wp-my-key-confirm-title');
      ui.resetResult = node('p', '', 'wp-my-key-muted'); ui.resetResult.setAttribute('role', 'status');
      ui.notice = mark(node('p', '', 'wp-my-key-muted'), 'notice'); ui.status = mark(node('p', '', 'wp-my-key-muted'), 'status'); ui.status.setAttribute('role', 'status');
      ui.key.append(ui.keyTitle, ui.value, ui.actions, ui.confirm, ui.resetNote, ui.notice, ui.status, ui.resetResult);
      ui.guideTitle = node('h3'); const tabs = node('div', undefined, 'wp-my-key-row'); tabs.setAttribute('role', 'tablist'); ui.tabs = {};
      for (const name of ['claude', 'codex', 'other']) {
        const b = node('button'); b.type = 'button'; mark(b, 'tab', name); b.setAttribute('role', 'tab');
        b.append(node('code'));
        b.addEventListener('click', safe(() => { tab = name; renderGuide(); })); ui.tabs[name] = b; tabs.append(b);
      }
      ui.caption = node('p', '', 'wp-my-key-muted'); ui.snippet = mark(node('pre'), 'snippet'); ui.copyConfig = button('copy-config', () => reveal('copy-config'));
      ui.filter = mark(node('input'), 'model-filter'); ui.filter.type = 'text'; ui.filter.addEventListener('input', safe(renderModels));
      ui.models = mark(node('div', undefined, 'wp-my-key-models'), 'models'); ui.notes = mark(node('ul'), 'notes');
      ui.modelsTitle = node('h4'); ui.notesTitle = node('h4');
      ui.guide.append(ui.guideTitle, tabs, ui.caption, ui.snippet, ui.copyConfig, ui.modelsTitle, ui.filter, ui.models, ui.notesTitle, ui.notes);
      dialog.append(content); document.body.append(dialog);
      dialog.addEventListener('cancel', safe(event => {
        if (confirming) { event.preventDefault(); cancelReset(); } else hide();
      }));
      dialog.addEventListener('close', safe(() => { ++version; stopPolling(); confirming = false; resetBusy = false; busy = false; hide(); document.querySelector('button.wp-user')?.focus(); }));
      dialog.addEventListener('click', safe(event => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) { hide(); dialog.close(); }
      }));
    }
    function renderStatus() {
      if (!ui.status) return;
      ui.status.textContent = status === 'reset-progress' ? t('正在重置钥匙，工作伙伴会重启约 1 分钟…', 'Resetting the key; your workspace restarts for about a minute…')
        : status === 'reset-wait' ? t('还在处理中，请稍后重新打开「我的钥匙」查看。', 'Still working. Reopen My key later to check.')
        : status === 'error' ? t('操作失败，请稍后再试。', 'Something went wrong. Please try again.')
        : status === 'copied' ? t('已复制', 'Copied') : status === 'shown' ? t(`${data.revealSeconds} 秒后自动隐藏`, `Hides automatically in ${data.revealSeconds} seconds`) : '';
    }
    function renderKey() {
      const shown = ui.value.dataset.state === 'shown';
      if (!shown) {
        ui.value.dataset.state = loading ? 'loading' : !data ? 'unavailable' : data.key === null ? 'missing' : data.key ? 'masked' : 'unavailable';
        ui.value.textContent = loading ? t('加载中…', 'Loading…') : ui.value.dataset.state === 'missing' ? t('还没有分配钥匙', 'No key assigned yet')
          : data?.key?.masked || t('暂时取不到', 'Unavailable right now');
      }
      ui.toggle.textContent = shown ? t('隐藏', 'Hide') : t('显示', 'Show'); ui.copy.textContent = t('复制', 'Copy');
      ui.copyConfig.textContent = t('复制整段', 'Copy all');
      for (const control of [ui.toggle, ui.copy, ui.copyConfig]) control.disabled = !data?.key || busy || resetBusy || loading;
      ui.notice.textContent = t('这把钥匙与你本人实名绑定，每次使用都会按人记录，用于额度管理和安全审计，请只用于本人工作。',
        'This key is bound to your real identity. Every use is recorded per person for quota management and security audits; use it only for your own work.');
      renderReset(); renderStatus();
    }
    function hide() {
      clearTimeout(hideTimer); clearTimeout(statusTimer); status = '';
      if (ui.value) { ui.value.dataset.state = 'masked'; ui.value.textContent = ''; renderKey(); }
    }
    function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined; }
    function cancelReset() { confirming = false; renderReset(); ui.reset.focus(); }
    function renderReset() {
      const reset = data?.reset;
      if (reset) { if (!ui.reset.isConnected) ui.actions.append(ui.reset); }
      else { ui.reset.remove(); confirming = false; }
      ui.reset.textContent = t('重置钥匙', 'Reset key');
      ui.reset.disabled = !reset?.allowed || resetBusy || busy || loading;
      ui.actions.hidden = confirming; ui.confirm.hidden = !confirming;
      let note = '';
      if (reset?.status === 'pending') note = t('正在重置钥匙…', 'Resetting the key…');
      else if (reset?.reason === 'blocked') note = reset.note || t('这把钥匙暂不支持自助重置；需要更换请联系管理员。', 'This key cannot be reset here. Ask an administrator to replace it.');
      else if (reset?.reason === 'limit') note = t('今天的重置次数已用完（每天 3 次），明天再试。', 'No resets left today (3 per day). Try again tomorrow.');
      else if (reset?.reason === 'unavailable') note = t('暂时无法重置，请稍后再试。', 'Resetting is unavailable right now. Please try again later.');
      ui.resetNote.textContent = note; ui.resetNote.hidden = !note || confirming;
      ui.resetResult.hidden = !resetResult;
      if (resetResult) mark(ui.resetResult, 'reset-result', resetResult); else ui.resetResult.removeAttribute('data-wp-my-key-reset-result');
      ui.resetResult.textContent = resetResult === 'done'
        ? t('钥匙已重置，旧钥匙已作废。在自己电脑的工具里填过旧钥匙的，请点「显示」查看新钥匙并自己换上。', 'The key has been reset and the old one no longer works. If tools on your own computer used the old key, press Show and give them the new one.')
        : resetResult === 'failed' ? t('暂时无法重置，请稍后再试。你现在的钥匙没有变，可以照常使用。', 'Resetting is unavailable right now. Please try again later. Your current key is unchanged and still works.') : '';
      if (!confirming) ui.confirm.replaceChildren();
      if (confirming) {
        const title = node('h3', t('确认重置钥匙？', 'Reset this key?')); title.id = 'wp-my-key-confirm-title';
        ui.resetCancel = button('reset-cancel', cancelReset); ui.resetCancel.textContent = t('取消', 'Cancel');
        const confirm = button('reset-confirm', confirmReset); confirm.textContent = t('确认重置', 'Reset');
        const actions = node('div', undefined, 'wp-my-key-row'); actions.append(ui.resetCancel, confirm);
        ui.confirm.replaceChildren(title,
          node('p', t('旧钥匙会立刻作废，无法恢复。', 'The old key stops working immediately and cannot be restored.')),
          node('p', t('你的工作伙伴会重启约 1 分钟，进行中的对话会中断。', 'Your workspace restarts for about a minute; a conversation in progress is interrupted.')),
          node('p', t('在自己电脑的工具里填过旧钥匙的，需要自己换成新钥匙。', 'Tools on your own computer that use the old key must be given the new one by you.')),
          node('p', t(`今天还可以重置 ${reset.left} 次。`, `${reset.left} resets left today.`), 'wp-my-key-muted'), actions);
      }
    }
    const currentReset = current => current === version && dialog.open && !revoked;
    async function resetApi(post = false) {
      const response = await fetch(API + '/reset', { method: post ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(post ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'reset' }) } : {}) });
      if (response.status === 401 || response.status === 404) { revoke(); return null; }
      const body = await response.json();
      return { status: response.status, ok: response.ok, body };
    }
    async function reloadReset(current, result = '') {
      const fresh = await api();
      if (!currentReset(current)) return;
      data = fresh; resetBusy = false; status = ''; resetResult = result; render();
    }
    async function confirmReset() {
      if (resetBusy || !confirming) return;
      confirming = false; resetBusy = true; resetResult = ''; hide(); status = 'reset-progress'; renderKey();
      const current = version;
      try {
        const response = await resetApi(true);
        if (!response || !currentReset(current)) return;
        if (response.status === 202 || (response.status === 409 && response.body.reason === 'busy')) startPolling();
        else if (response.status === 429) {
          resetBusy = false; status = ''; data.reset = { ...data.reset, allowed: false, reason: 'limit' }; renderKey();
        } else if (response.status === 403 && response.body.reason === 'blocked') await reloadReset(current);
        else await reloadReset(current, 'failed');
      } catch {
        if (currentReset(current)) { resetBusy = false; status = ''; resetResult = 'failed'; renderKey(); }
      }
    }
    function startPolling() {
      stopPolling(); resetBusy = true; hide(); status = 'reset-progress'; pollStarted = Date.now();
      if (data?.reset) data.reset = { ...data.reset, status: 'pending', allowed: false };
      renderKey(); const current = version;
      async function poll() {
        if (!currentReset(current)) return;
        if (Date.now() - pollStarted >= 300000) { status = 'reset-wait'; renderStatus(); return; }
        try {
          const response = await resetApi();
          if (!response || !currentReset(current)) return;
          if (response.ok && ['done', 'failed'].includes(response.body.status)) {
            await reloadReset(current, response.body.status); return;
          }
        } catch { /* A claimed rotation must be allowed to finish despite a lost poll. */ }
        if (currentReset(current)) pollTimer = setTimeout(safe(poll), 2000);
      }
      pollTimer = setTimeout(safe(poll), 2000);
    }
    async function clipboard(value) {
      try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return; } } catch { /* Use the dialog-local fallback. */ }
      const area = node('textarea'); area.value = value; area.style.cssText = 'position:fixed;left:-10000px;top:0'; dialog.append(area);
      try { area.select(); if (!document.execCommand('copy')) throw new Error('Copy failed'); }
      finally { area.value = ''; area.remove(); }
    }
    async function reveal(action) {
      if (busy || resetBusy || !data?.key) return;
      hide(); busy = true; renderKey(); const current = version;
      // Snapshot the visible configuration before the asynchronous reveal.
      let configuration = action === 'copy-config' ? ui.snippet.textContent : '', placeholder = keyPlaceholder(), result;
      try {
        result = await api(action);
        if (current !== version || !dialog.open || revoked) return;
        if (typeof result.key !== 'string') throw new Error('Missing key');
        if (action === 'show') {
          ui.value.textContent = result.key; ui.value.dataset.state = 'shown'; status = 'shown';
          hideTimer = setTimeout(safe(hide), data.revealSeconds * 1000);
        } else {
          await clipboard(action === 'copy-config' ? configuration.split(placeholder).join(result.key) : result.key);
          if (current === version && dialog.open) { status = 'copied'; statusTimer = setTimeout(safe(() => { status = ''; renderStatus(); }), 3000); }
        }
      } catch { if (current === version && dialog.open) failure(); }
      finally { if (result) result.key = ''; result = null; configuration = ''; if (current === version) { busy = false; renderKey(); } }
    }
    const beijingTime = value => new Date(value).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    function renderUsage() {
      const usage = data?.usage; ui.usage.replaceChildren(); ui.usage.dataset.state = loading ? 'loading' : usage ? 'ready' : 'unavailable';
      ui.usage.append(node('h3', t('用量', 'Usage')));
      if (loading || !usage) {
        ui.usage.append(node('p', loading ? t('加载中…', 'Loading…') : t('暂时取不到', 'Unavailable right now')));
        return;
      }
      const tiles = node('div', undefined, 'wp-my-key-tiles');
      for (const name of ['today', 'week']) {
        const item = usage?.[name], tile = mark(node('div', undefined, 'wp-my-key-tile'), 'usage', name);
        const title = name === 'today' ? t('今天', 'Today') : t('本周', 'This week');
        tile.dataset.state = item ? 'ready' : 'unavailable'; tile.append(node('strong', title));
        if (!item) tile.append(node('div', t('暂时取不到', 'Unavailable right now')));
        else {
          if (typeof item.percent === 'number') {
            const percent = item.percent, label = percent === 999 ? '999%+' : percent + '%';
            const percentText = t(`已用 ${label}`, `${label} used`);
            tile.dataset.level = percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'normal';
            tile.append(mark(node('div', percentText), 'percent'));
            const track = node('div', undefined, 'wp-my-key-track'); track.setAttribute('role', 'progressbar');
            track.setAttribute('aria-label', title); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
            track.setAttribute('aria-valuenow', String(Math.min(100, percent))); track.setAttribute('aria-valuetext', percentText);
            const fill = node('div', undefined, 'wp-my-key-fill'); fill.style.width = Math.min(100, percent) + '%';
            track.append(fill); tile.append(track);
            if (percent >= 100) tile.append(mark(node('div', name === 'today'
              ? t('已超过今天参考额度', "Over today's reference allowance")
              : t('已超过本周参考额度', "Over this week's reference allowance")), 'over'));
          }
          tile.append(mark(node('div', t(`${item.calls} 次`, `${item.calls} requests`), 'wp-my-key-muted'), 'calls'));
        }
        tiles.append(tile);
      }
      ui.usage.append(tiles);
      const window = mark(node('p', '', 'wp-my-key-muted'), 'window');
      if (usage?.today && usage?.week) {
        const day = beijingTime(usage.today.start), week = beijingTime(usage.week.start);
        const weekday = new Date(usage.week.start).toLocaleDateString(locale(), { timeZone: 'Asia/Shanghai', weekday: 'long' });
        const zhWeekday = weekday.replace('星期', '周');
        window.textContent = t(`今天从北京时间 ${day} 起算；本周从${zhWeekday} ${week}（北京时间）起算。`,
          `Today starts at ${day} Beijing time; the week starts on ${weekday} at ${week} Beijing time.`);
        ui.usage.append(window);
      }
      if (['today', 'week'].some(name => typeof usage[name]?.percent === 'number')) {
        const note = usage.enforced
          ? t('进度条按每周参考额度计算，今天按它的五分之一。这把钥匙另设有用量上限，达到后会暂停，详情请问管理员。',
            'The bars are measured against a weekly reference allowance (one fifth of it per day). This key also has a usage limit; it pauses when the limit is reached. Ask an administrator for details.')
          : t('进度条按每周参考额度计算，今天按它的五分之一；目前超过不会停用，只作提醒。',
            'The bars are measured against a weekly reference allowance (one fifth of it per day). Going over does not stop the key for now; it is only a reminder.');
        ui.usage.append(mark(node('p', note, 'wp-my-key-muted'), 'reference-note'));
      }
      const models = mark(node('p'), 'top-models'); models.hidden = !usage?.week?.models?.length;
      if (!models.hidden) models.textContent = t('本周常用：', 'Top models this week: ') + usage.week.models.map(m => `${m.name} ${Number((m.share * 100).toFixed(2))}%`).join(' · ');
      ui.usage.append(models);
    }
    const keyPlaceholder = () => t('<你的钥匙>', '<YOUR_KEY>');
    function renderGuide() {
      const base = data?.baseUrl || t('<入口地址>', '<GATEWAY_URL>'), key = keyPlaceholder(), defaults = data?.defaults || {};
      for (const [name, b] of Object.entries(ui.tabs)) { b.setAttribute('aria-selected', String(tab === name)); b.firstElementChild.textContent = name === 'claude' ? 'Claude Code' : name === 'codex' ? 'Codex' : t('其它工具', 'Other tools'); }
      if (tab === 'claude') {
        ui.caption.textContent = '~/.claude/settings.json';
        const env = { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key };
        for (const [name, field] of Object.entries({ claude: 'ANTHROPIC_MODEL', opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL', sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' })) if (defaults[name]) env[field] = defaults[name];
        ui.snippet.textContent = JSON.stringify({ env }, null, 2);
      } else if (tab === 'codex') {
        ui.caption.textContent = '~/.codex/config.toml';
        ui.snippet.textContent = (defaults.codex ? 'model = ' + JSON.stringify(defaults.codex) + '\n' : '') + 'model_provider = "gateway"\n\n[model_providers.gateway]\nname = "gateway"\nbase_url = ' + JSON.stringify(base + '/v1') + '\nwire_api = "responses"\nexperimental_bearer_token = ' + JSON.stringify(key);
      } else {
        ui.caption.textContent = t('OpenAI 兼容工具', 'OpenAI-compatible tools');
        const payload = JSON.stringify({ ...(defaults.codex ? { model: defaults.codex } : {}), messages: [{ role: 'user', content: 'hello' }] });
        ui.snippet.textContent = `Base URL (OpenAI): ${base}/v1\nBase URL (Anthropic): ${base}\nAPI Key: ${key}\n` + (defaults.codex ? `Model: ${defaults.codex}\n` : '')
          + `\ncurl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '${payload.replaceAll("'", "'\\''")}'`;
      }
      ui.filter.placeholder = t('筛选模型', 'Filter models'); ui.filter.setAttribute('aria-label', ui.filter.placeholder); renderModels();
      const count = data?.models?.length || 0;
      ui.modelsTitle.textContent = count ? t(`可用模型（${count}）`, `Available models (${count})`) : t('可用模型', 'Available models'); ui.filter.hidden = !count;
      ui.notesTitle.textContent = t('注意事项', 'Notes');
      ui.notes.replaceChildren(...[
        ['这把钥匙只限你本人工作使用，不要给别人用。', 'This key is for your own work only. Do not let anyone else use it.'],
        ['不要外传，不要发到群里或贴到网页上。', 'Do not share it, post it in chats or paste it into web pages.'],
        ['不要写进代码或脚本，也不要提交到代码仓库；放在配置文件或环境变量里。', 'Do not put it in code or scripts or commit it to a repository; keep it in a config file or an environment variable.'],
        ['在公司外（家里、出差）也可以用，地址就是上面配置里的地址。', 'It also works outside the office (at home, travelling); use the address shown in the configuration above.'],
        data?.reset && data.reset.reason !== 'blocked'
          ? ['怀疑泄露，马上点上面的「重置钥匙」换一把新的。', 'If you suspect it has leaked, press "Reset key" above right away to get a new one.']
          : ['怀疑泄露，马上联系管理员更换。', 'If you suspect it has leaked, contact an administrator right away to have it replaced.'],
        ['有问题：在工作伙伴的「反馈」里留言。', 'Questions: leave a message in Feedback.'],
      ].map(([zh, en]) => node('li', t(zh, en))));
    }
    function renderModels() {
      const filter = ui.filter.value.toLowerCase();
      if (!data?.models?.length) { ui.models.textContent = t('模型清单暂时取不到', 'The model list is unavailable right now'); return; }
      // Model IDs can also equal a tool name; protect their exact advertised spelling.
      ui.models.replaceChildren(...data.models.filter(m => m.id.toLowerCase().includes(filter)).map(m => {
        const row = mark(node('div'), 'model'); row.append(node('code', m.id)); return row;
      }));
    }
    function render() {
      ui.heading.textContent = t('我的钥匙', 'My key'); ui.close.setAttribute('aria-label', t('关闭', 'Close'));
      ui.keyTitle.textContent = t('钥匙', 'Key'); ui.guideTitle.textContent = t('使用说明', 'Setup guide'); renderKey(); renderUsage(); renderGuide();
    }
    async function show() {
      if (revoked) return;
      closeMenus(); mount(); stopPolling(); confirming = false; resetBusy = false; resetResult = ''; data = null; loading = true; hide(); tab = 'claude'; busy = false; ui.filter.value = ''; const current = ++version;
      render(); if (!dialog.open) dialog.showModal();
      try { const result = await api(); if (current === version && dialog.open && !revoked) data = result; }
      catch { if (current === version && !revoked) failure(); }
      finally { if (current === version && !revoked) { loading = false; render(); if (data?.reset?.status === 'pending') startPolling(); } }
    }
    const init = safe(() => { observer = new MutationObserver(safe(menus)); observer.observe(document.body, { childList: true, subtree: true }); menus(); });
    window.addEventListener('storage', safe(menus)); window.addEventListener('resize', safe(menus));
    window.addEventListener('pagehide', safe(() => { ++version; stopPolling(); hide(); }));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  } catch { /* Optional UI must not break the preview client or the workspace. */ }
}
