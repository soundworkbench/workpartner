/* Homepage Feishu setup. Dismissal lasts only until this page is reloaded. */
(function () {
  var API = '/_wp/aionui/feishu', state = null, dismissed = false, busy = false, polling = null;
  var banner, dialog, message, image, retry, previousFocus;
  var COPY = {
    'zh-CN': {
      banner: '还没开通飞书入口，开通后在飞书里也能直接找助手', open: '开通', close: '关闭',
      title: '开通飞书入口', hint: '用飞书手机 App 扫码，完成机器人创建和授权。二维码 10 分钟内有效。',
      preparing: '正在准备二维码…', waiting: '请用飞书手机 App 扫码。',
      needs_identity: '请给新机器人发 /whoami，保留返回的本人 ID，再请管理员完成连接。',
      expired: '二维码已过期，请重新获取。', failed: '这次没有开通成功，请重试。',
      restart_failed: '授权已保存，入口启动还未确认，请重试；仍未恢复时请联系管理员。',
      connected: '飞书入口已开通，可以在飞书里找助手了。', retry: '重试',
      unavailable: '暂时无法读取开通状态，请稍后重试。', qr: '飞书开通二维码'
    },
    'en-US': {
      banner: 'Connect Feishu to chat with your assistant there, too.', open: 'Connect', close: 'Close',
      title: 'Connect Feishu', hint: 'Scan with the Feishu mobile app to create and authorize your bot. The QR code is valid for 10 minutes.',
      preparing: 'Preparing QR code…', waiting: 'Scan with the Feishu mobile app.',
      needs_identity: 'Send /whoami to your new bot, keep your returned user ID, and ask the partner assistant to finish connecting.',
      expired: 'This QR code expired. Please try again.', failed: 'Setup did not finish. Please try again.',
      restart_failed: 'Authorization was saved, but startup is unconfirmed. Retry or contact the partner assistant.',
      connected: 'Feishu is connected. You can chat with your assistant there.', retry: 'Retry',
      unavailable: 'Setup status is unavailable. Please try again later.', qr: 'Feishu connection QR code'
    }
  };
  function t(key) {
    var language = window.wpSettings && window.wpSettings.get().language;
    if (!language) language = document.documentElement.lang;
    return COPY[/^en/i.test(language || '') ? 'en-US' : 'zh-CN'][key];
  }
  function button(text, handler) {
    var element = document.createElement('button');
    element.type = 'button'; element.textContent = text; element.addEventListener('click', handler);
    return element;
  }
  async function request(action, method) {
    var response = await fetch(API + '/' + action, { method: method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: method ? { 'content-type': 'application/json' } : {}, ...(method ? { body: '{}' } : {}) });
    if (!response.ok) throw new Error('setup unavailable');
    return response.json();
  }
  function mount() {
    var home = document.querySelector('[data-testid="guid-input"]');
    var host = home && home.closest('main');
    if (!host || !state || ['connected', 'unavailable'].includes(state.status) || dismissed) {
      if (banner) banner.remove();
      return;
    }
    if (banner && banner.isConnected) return;
    banner = document.createElement('div'); banner.className = 'wp-feishu-banner';
    var text = document.createElement('span'); text.textContent = t('banner');
    var open = button(t('open'), show);
    var close = button('×', function () { dismissed = true; mount(); });
    close.className = 'wp-feishu-dismiss'; close.setAttribute('aria-label', t('close'));
    banner.append(text, open, close); host.prepend(banner);
  }
  function render() {
    mount();
    if (!dialog || !dialog.open) return;
    var kind = state ? state.status : 'preparing';
    message.textContent = t(kind) || t('preparing');
    var qr = kind === 'waiting' && state.qr;
    if (qr && image.getAttribute('src') !== qr) image.src = qr;
    if (!qr) image.removeAttribute('src');
    image.hidden = !qr;
    retry.hidden = !['expired', 'failed', 'restart_failed', 'unavailable', 'unconnected'].includes(kind);
    retry.disabled = busy;
  }
  function schedule() {
    clearTimeout(polling);
    if (state && !['connected', 'needs_identity', 'expired', 'failed', 'restart_failed', 'unavailable'].includes(state.status) &&
        (state.status !== 'unconnected' || dialog && dialog.open)) {
      polling = setTimeout(refresh, 2000);
    }
  }
  async function refresh() {
    try { state = await request('status'); }
    catch (error) { state = { status: 'unavailable' }; }
    render(); schedule();
  }
  async function start() {
    if (busy) return;
    busy = true; state = { status: 'preparing' }; render();
    try { state = await request('start', 'POST'); }
    catch (error) { state = { status: 'unavailable' }; }
    busy = false; render(); schedule();
  }
  function show() {
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.className = 'wp-feishu-dialog';
      dialog.setAttribute('aria-labelledby', 'wp-feishu-title');
      var title = document.createElement('h2'); title.id = 'wp-feishu-title'; title.textContent = t('title');
      var close = button('×', function () { dialog.close(); });
      close.className = 'wp-feishu-dismiss'; close.setAttribute('aria-label', t('close'));
      var hint = document.createElement('p'); hint.textContent = t('hint');
      message = document.createElement('p'); message.setAttribute('role', 'status');
      image = document.createElement('img'); image.alt = t('qr'); image.hidden = true;
      retry = button(t('retry'), start); retry.hidden = true;
      dialog.append(title, close, hint, image, message, retry); document.body.append(dialog);
      dialog.addEventListener('close', function () { image.removeAttribute('src'); previousFocus?.focus(); });
    }
    previousFocus = document.activeElement;
    dialog.showModal(); render();
    if (state && ['waiting', 'preparing', 'needs_identity', 'connected'].includes(state.status)) refresh();
    else start();
  }
  function init() {
    refresh();
    new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', function () { mount(); refresh(); });
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
