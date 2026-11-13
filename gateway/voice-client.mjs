export function resample(samples, sourceRate, targetRate = 16000) {
  const length = Math.floor(samples.length * targetRate / sourceRate), output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < length; i++) {
    const start = i * ratio, end = Math.min(samples.length, (i + 1) * ratio);
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += samples[j] * (Math.min(end, j + 1) - Math.max(start, j));
    output[i] = sum / (end - start);
  }
  return output;
}

export function encodeWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const word = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  word(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); });
  return buffer;
}

export function voiceClient() {
  return `\n;(${installVoice.toString()})(${resample.toString()}, ${encodeWav.toString()});`;
}

function installVoice(resample, encodeWav) {
  if (window.__wpVoice) return;
  window.__wpVoice = true;
  const unsupported = !window.isSecureContext ? '当前页面不是安全上下文，无法使用语音输入'
    : !navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext) ? '当前浏览器不支持语音输入' : '';
  const selector = '[data-testid="sendbox-input"], [data-testid="guid-input"]';
  let current, press, toastTimer, toast, observer, mountFrame;
  const node = (tag, cls) => { const el = document.createElement(tag); el.className = cls; return el; };
  const safe = fn => (...args) => { try { return Promise.resolve(fn(...args)).catch(() => {}); } catch {} };
  const visible = el => el?.isConnected && !el.closest('.wp-transition-composer')
    && el.getClientRects().length && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  function hint(text) {
    if (!toast) { toast = node('div', 'wp-voice-toast'); toast.setAttribute('role', 'status'); document.body.append(toast); }
    toast.textContent = text; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }
  function render() {
    document.querySelectorAll('.wp-voice').forEach(wrap => {
      const button = wrap.querySelector('button'), label = wrap.querySelector('.wp-voice-time');
      const active = current?.area === wrap._area, state = active ? current.state : 'idle';
      button.dataset.state = state; button.disabled = Boolean(current && (!active || state === 'recognizing'));
      button.setAttribute('aria-pressed', String(state === 'recording' || state === 'starting'));
      const seconds = active && current.started ? Math.min(60, Math.floor((Date.now() - current.started) / 1000)) : 0;
      const text = state === 'recording' ? seconds + '秒' + (seconds >= 50 ? ' · 即将结束' : '') : state === 'starting' ? '等待麦克风' : '';
      if (label.textContent !== text) label.textContent = text;
    });
  }
  function release(session) {
    clearInterval(session.timer); session.stream?.getTracks().forEach(track => track.stop());
    if (session.processor) {
      if (session.processor.port) { session.processor.port.onmessage = null; session.processor.port.close(); }
      else session.processor.onaudioprocess = null;
      session.processor.disconnect();
    }
    session.source?.disconnect(); session.gain?.disconnect();
    session.context?.close().catch(() => {});
    if (session.url) URL.revokeObjectURL(session.url);
  }
  function cancel() {
    press = null;
    if (!current || current.state === 'recognizing') return;
    const session = current; current = null; release(session); session.chunks.length = 0; render();
  }
  async function start(area) {
    if (current) return;
    const session = { area, selector: '[data-testid="' + area.dataset.testid + '"]', state: 'starting', chunks: [], count: 0 }; current = session;
    try {
      session.context = new (window.AudioContext || window.webkitAudioContext)();
      const resumed = session.context.resume();
      const media = navigator.mediaDevices.getUserMedia({ audio: true });
      // Attach both handlers immediately, including when permission is denied before resume resolves.
      await Promise.all([resumed, media.then(stream => {
        session.stream = stream;
        if (current !== session) stream.getTracks().forEach(track => track.stop());
      })]);
      if (current !== session) { release(session); return; }
      const context = session.context;
      const collect = samples => {
        if (current !== session || session.state !== 'recording') return;
        const remaining = Math.max(0, Math.floor(context.sampleRate * 60) - session.count);
        const chunk = samples.slice(0, remaining);
        if (chunk.length) { session.chunks.push(chunk); session.count += chunk.length; }
      };
      if (context.audioWorklet && window.AudioWorkletNode) {
        session.url = URL.createObjectURL(new Blob([`class VoicePCM extends AudioWorkletProcessor {
          process(inputs) { const channels = inputs[0]; if (channels?.length) {
            const mono = new Float32Array(channels[0].length);
            for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
            this.port.postMessage(mono, [mono.buffer]);
          } return true; }
        } registerProcessor('wp-voice-pcm', VoicePCM);`], { type: 'text/javascript' }));
        try {
          await context.audioWorklet.addModule(session.url);
          if (current !== session) return;
          session.processor = new AudioWorkletNode(context, 'wp-voice-pcm');
          session.processor.port.onmessage = event => collect(event.data);
        } catch { /* Older browsers and restrictive worklet policies use the PCM fallback. */ }
        finally { URL.revokeObjectURL(session.url); session.url = null; }
      }
      if (current !== session) return;
      if (!session.processor) {
        session.processor = context.createScriptProcessor(2048, 1, 1);
        session.processor.onaudioprocess = event => collect(event.inputBuffer.getChannelData(0));
      }
      session.source = context.createMediaStreamSource(session.stream); session.gain = context.createGain(); session.gain.gain.value = 0;
      session.source.connect(session.processor); session.processor.connect(session.gain); session.gain.connect(context.destination);
      session.started = Date.now(); session.state = 'recording'; render();
      session.timer = setInterval(() => { render(); if (Date.now() - session.started >= 60000) finish(); }, 100);
      if (session.finishRequested) finish();
    } catch (error) {
      release(session);
      if (current !== session) return;
      current = null; render();
      hint(['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)
        ? '没有麦克风权限，请在浏览器设置里允许' : '语音识别暂时不可用');
    }
  }
  function insert(session, text) {
    const area = visible(session.area) ? session.area : [...document.querySelectorAll(session.selector)].find(visible);
    if (!area) { hint('找不到输入框，请返回对话页面后重试'); return; }
    const focused = document.activeElement === area;
    const start = focused ? area.selectionStart : area.value.length, end = focused ? area.selectionEnd : start;
    const prefix = !focused && start && !/\s$/.test(area.value) && !/^\s/.test(text) ? ' ' : '';
    const value = area.value.slice(0, start) + prefix + text + area.value.slice(end);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true })); area.focus();
    area.setSelectionRange(start + prefix.length + text.length, start + prefix.length + text.length);
  }
  async function finish() {
    const session = current;
    if (!session || session.state === 'recognizing') return;
    if (session.state === 'starting') { session.finishRequested = true; return; }
    const rate = session.context.sampleRate;
    release(session);
    if (session.count / rate < 0.5) { current = null; render(); hint('说话时间太短'); return; }
    session.state = 'recognizing'; render();
    try {
      const samples = new Float32Array(session.count); let offset = 0;
      for (const chunk of session.chunks) { samples.set(chunk, offset); offset += chunk.length; }
      session.chunks.length = 0;
      const response = await fetch('/_wp/api/voice/recognize', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'audio/wav' }, body: encodeWav(resample(samples, rate)) });
      const data = await response.json();
      if (!response.ok) { hint(data.error === 'busy' ? '识别忙，请稍后再试' : '语音识别暂时不可用'); return; }
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) hint('没听清，请再说一次'); else insert(session, text);
    } catch { hint('语音识别暂时不可用'); }
    finally { if (current === session) current = null; render(); }
  }
  function mount() {
    document.querySelectorAll('.wp-voice').forEach(el => {
      if (!el._area?.isConnected || el.closest('.wp-transition-composer')) el.remove();
    });
    document.querySelectorAll(selector).forEach(area => {
      if (area.closest('.wp-transition-composer')) return;
      const panel = area.closest('.sendbox-panel, [class*="_guidInputInner"]');
      const send = panel?.querySelector('[data-testid="sendbox-send-btn"], [data-testid="guid-send-btn"], .sendbox-stop-button');
      const slot = send?.parentElement;
      if (!slot) return;
      let wrap = [...document.querySelectorAll('.wp-voice')].find(el => el._area === area);
      if (!wrap) {
        wrap = node('span', 'wp-voice'); wrap._area = area;
        const button = node('button', 'wp-voice-button'); button.type = 'button'; button.setAttribute('aria-label', '语音输入');
        button.title = unsupported || '按住说话，或点按开始和结束'; button.setAttribute('aria-disabled', String(Boolean(unsupported)));
        button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
        const label = node('span', 'wp-voice-time'); label.setAttribute('role', 'status'); wrap.append(button, label);
        button.addEventListener('contextmenu', event => event.preventDefault());
        button.addEventListener('pointerdown', event => {
          if (press && !press.button.isConnected) cancel();
          if (event.button !== 0 || press || button.disabled) return;
          event.preventDefault(); event.stopPropagation();
          if (unsupported) { hint(unsupported); return; }
          press = { id: event.pointerId, button, at: Date.now(), stopping: Boolean(current), outside: false };
          button.setPointerCapture(event.pointerId);
          if (!current) start(area);
          render();
        });
        button.addEventListener('pointermove', event => {
          if (press?.id !== event.pointerId) return;
          const rect = button.getBoundingClientRect();
          press.outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
        });
        button.addEventListener('pointerup', event => {
          if (press?.id !== event.pointerId) return;
          const gesture = press; press = null; event.preventDefault(); event.stopPropagation();
          const rect = button.getBoundingClientRect();
          gesture.outside ||= event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
          if (gesture.outside) cancel(); else if (gesture.stopping || Date.now() - gesture.at >= 300) finish();
        });
        button.addEventListener('pointercancel', cancel);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          if (event.detail !== 0) return;
          if (unsupported) hint(unsupported); else if (current) finish(); else start(area);
        });
      }
      if (wrap.parentElement !== slot || wrap.nextElementSibling !== send) slot.insertBefore(wrap, send);
    });
    if (current && !current.area.isConnected && current.state !== 'recognizing') cancel();
    render();
  }
  function scheduleMount() {
    if (mountFrame) return;
    mountFrame = requestAnimationFrame(safe(() => { mountFrame = null; mount(); }));
  }
  function init() {
    const style = node('style', 'wp-voice-style'); style.textContent = `
.wp-voice { position:relative; display:inline-flex; align-items:center; flex:0 0 auto; margin:0; vertical-align:middle; }
.wp-voice-button { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; padding:0; border:1px solid var(--wp-line); border-radius:50%; background:var(--wp-card); color:var(--wp-ink-2); cursor:pointer; touch-action:none; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
.wp-voice-button:hover { background:var(--wp-hover); }
.wp-voice-button[data-state="recording"] { color:var(--wp-danger, #d92d20); border-color:currentColor; }
.wp-voice-button:disabled,.wp-voice-button[aria-disabled="true"] { opacity:.45; cursor:default; }
.wp-voice-button[data-state="recognizing"] svg { display:none; }
.wp-voice-button[data-state="recognizing"]::after { content:''; width:16px; height:16px; border:2px solid var(--wp-line); border-top-color:var(--wp-ink); border-radius:50%; animation:wp-voice-spin .8s linear infinite; }
.wp-voice-time { position:absolute; right:0; bottom:calc(100% + 6px); white-space:nowrap; font:12px var(--wp-font); color:var(--wp-ink); background:var(--wp-card); border-radius:4px; }
.wp-voice-toast { position:fixed; z-index:2147483647; bottom:100px; left:50%; transform:translateX(-50%); width:max-content; max-width:calc(100vw - 32px); box-sizing:border-box; padding:10px 14px; border:1px solid var(--wp-line); border-radius:8px; background:var(--wp-card); color:var(--wp-ink); font:14px var(--wp-font); overflow-wrap:anywhere; }
@keyframes wp-voice-spin { to { transform:rotate(360deg); } }`;
    document.head.append(style); mount();
    observer = new MutationObserver(safe(scheduleMount)); observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', safe(scheduleMount));
  }
  document.addEventListener('lostpointercapture', event => { if (press?.id === event.pointerId) cancel(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
  window.addEventListener('pagehide', cancel);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(init), { once: true }); else safe(init)();
}
