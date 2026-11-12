/** Gateway-only UI. The serialized installer carries recording limits only, no deployment or identity data. */
export function voiceInputClient({ maxSeconds = 60, maxBytes = 5 * 1024 * 1024 } = {}) {
  return `\n;(${installVoiceInput.toString()})(${JSON.stringify({ maxSeconds, maxBytes })});`;
}

function installVoiceInput(options) {
  try {
    if (window.wpVoiceInput || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function' || !window.isSecureContext) return;
    const API = '/_wp/api/voice-input';
    const COMPOSER = 'textarea[data-testid="guid-input"],textarea[data-testid="sendbox-input"]';
    const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    let state = 'idle', target = null, recorder = null, stream = null, chunks = [], timer = 0, tipTimer = 0, revoked = false;
    const buttons = new Map();
    function locale() {
      let value = window.wpSettings ? window.wpSettings.get().language : null;
      if (!value) try { value = localStorage.getItem('i18nextLng'); } catch { /* Default to Chinese. */ }
      return value && /^en/i.test(value) ? 'en-US' : 'zh-CN';
    }
    const t = (zh, en) => locale() === 'en-US' ? en : zh;
    const copy = {
      start: () => t('语音输入', 'Voice input'), stop: () => t('停止并识别', 'Stop and transcribe'),
      busy: () => t('正在识别…', 'Transcribing…'), denied: () => t('无法使用麦克风，请在浏览器中允许麦克风权限', 'Microphone unavailable. Allow microphone access in your browser.'),
      empty: () => t('没有识别出文字', 'No speech recognized'), failed: () => t('识别失败，请重试', 'Transcription failed. Please try again.'),
    };
    const style = document.createElement('style');
    style.setAttribute('data-wp-voice-style', '');
    style.textContent = '[data-wp-voice]{position:absolute;z-index:2;width:28px;height:28px;padding:0;border:0;border-radius:50%;display:grid;place-items:center;'
      + 'background:transparent;color:inherit;opacity:.6;cursor:pointer}[data-wp-voice]:hover,[data-wp-voice]:focus-visible{opacity:1}'
      + '[data-wp-voice][data-state="recording"]{opacity:1;color:#fff;background:#d93025;animation:wp-voice-pulse 1.2s ease-in-out infinite}'
      + '[data-wp-voice][data-state="busy"]{opacity:1;cursor:progress}[data-wp-voice] svg{width:16px;height:16px}'
      + '@keyframes wp-voice-pulse{50%{box-shadow:0 0 0 6px rgba(217,48,37,.2)}}@media (prefers-reduced-motion:reduce){[data-wp-voice]{animation:none!important}}'
      + '[data-wp-voice-tip]{position:fixed;z-index:1000;max-width:280px;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.8);color:#fff;font-size:13px;line-height:1.5;pointer-events:none}';
    document.head.appendChild(style);
    const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
      + '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
    function tip(input, text) {
      document.querySelectorAll('[data-wp-voice-tip]').forEach(n => n.remove());
      clearTimeout(tipTimer);
      if (!text || !input?.isConnected) return;
      const n = document.createElement('div'); n.setAttribute('data-wp-voice-tip', ''); n.setAttribute('role', 'status'); n.textContent = text;
      document.body.appendChild(n);
      const rect = input.getBoundingClientRect();
      n.style.left = Math.max(8, Math.min(rect.right - n.offsetWidth, innerWidth - n.offsetWidth - 8)) + 'px';
      n.style.top = Math.max(8, rect.top - n.offsetHeight - 8) + 'px';
      tipTimer = setTimeout(() => n.remove(), 4000);
    }
    function render() {
      for (const [input, b] of buttons) {
        const mine = input === target ? state : 'idle';
        b.dataset.state = mine;
        b.disabled = state !== 'idle' && input !== target;
        const label = mine === 'recording' ? copy.stop() : mine === 'busy' ? copy.busy() : copy.start();
        b.title = label; b.setAttribute('aria-label', label); b.setAttribute('aria-pressed', String(mine === 'recording'));
      }
    }
    // React owns the textarea value: use the native setter, then report the edit.
    function insert(input, text) {
      if (!input.isConnected || input.disabled || input.readOnly) return false;
      const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? input.value.length;
      const before = input.value.slice(0, start), after = input.value.slice(end);
      const pad = before && !/\s$/.test(before) && /^[\x21-\x7e]/.test(text) ? ' ' : '';
      const value = before + pad + text + after;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      const caret = (before + pad + text).length; input.setSelectionRange(caret, caret);
      return true;
    }
    function release() {
      clearTimeout(timer); timer = 0;
      stream?.getTracks().forEach(track => track.stop()); stream = null;
    }
    async function transcribe(input, blob) {
      state = 'busy'; render();
      try {
        if (!blob.size) throw new Error('empty');
        if (blob.size > options.maxBytes) throw new Error('size');
        const response = await fetch(API, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
        if (response.status === 404 || response.status === 401) { revoke(); return; }
        if (!response.ok) throw new Error('failed');
        const text = String((await response.json()).text || '').trim();
        if (!text) tip(input, copy.empty());
        else if (!insert(input, text)) tip(input, copy.failed());
      } catch { tip(input, copy.failed()); }
      finally { if (!revoked) { state = 'idle'; target = null; render(); } }
    }
    async function start(input) {
      target = input; state = 'starting'; render(); tip(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        state = 'idle'; target = null; render(); tip(input, copy.denied()); return;
      }
      const mimeType = TYPES.find(type => MediaRecorder.isTypeSupported?.(type));
      try { recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); }
      catch { release(); state = 'idle'; target = null; render(); tip(input, copy.failed()); return; }
      chunks = [];
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      recorder.onstop = () => {
        release();
        const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || 'audio/webm').split(';')[0] });
        recorder = null; chunks = [];
        if (state === 'cancel') { state = 'idle'; target = null; render(); return; }
        transcribe(input, blob);
      };
      recorder.start();
      state = 'recording'; render();
      timer = setTimeout(stop, options.maxSeconds * 1000);
    }
    function stop() { if (recorder && recorder.state !== 'inactive') { state = 'stopping'; render(); recorder.stop(); } }
    function cancel() { if (recorder && recorder.state !== 'inactive') { state = 'cancel'; recorder.stop(); } else release(); }
    function toggle(input) {
      if (state === 'idle') start(input);
      else if (state === 'recording' && input === target) stop();
    }
    function revoke() {
      revoked = true; observer.disconnect(); cancel();
      buttons.forEach(b => b.remove()); buttons.clear(); style.remove(); tip(null);
    }
    function place(input, b) {
      const parent = input.parentElement;
      if (!parent) return;
      if (b.parentElement !== parent || b.previousElementSibling !== input) input.after(b);
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      b.style.top = input.offsetTop + 4 + 'px';
      b.style.left = input.offsetLeft + input.offsetWidth - 32 + 'px';
      if (!input.dataset.wpVoicePadded) {
        input.dataset.wpVoicePadded = '';
        input.style.paddingRight = `calc(${getComputedStyle(input).paddingRight} + 28px)`;
      }
    }
    function scan() {
      if (revoked) return;
      for (const [input, b] of buttons) if (!input.isConnected) {
        b.remove(); buttons.delete(input);
        if (input === target) cancel();
      }
      document.querySelectorAll(COMPOSER).forEach(input => {
        if (input.closest('[inert],[aria-hidden="true"]')) return;
        let b = buttons.get(input);
        if (!b) {
          b = document.createElement('button'); b.type = 'button'; b.setAttribute('data-wp-voice', ''); b.innerHTML = ICON;
          b.addEventListener('mousedown', event => event.preventDefault());
          b.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggle(input); });
          buttons.set(input, b); render();
        }
        place(input, b);
      });
    }
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('resize', scan);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && state === 'recording') cancel(); }, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'recording') stop(); });
    window.wpVoiceInput = { revoke };
    scan();
  } catch { /* Voice input must never break the workspace. */ }
}
