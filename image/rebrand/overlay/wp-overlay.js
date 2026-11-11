/* 工作伙伴：正文显示节奏。共享算法由 wp-smooth.js 在本脚本前加载，不修改消息数据。 */
(function () {
  const { SmoothText, repairStreamingMarkdown } = window.WpSmoothText;
  const active = new Map(), listeners = new Map(), wrapped = new WeakSet(), components = new WeakMap();
  const titled = new Set();
  // Called when the send API accepts the message; the agent turn is still running.
  window.wpTitleSent = function (id) {
    if (titled.has(id)) return;
    titled.add(id);
    if (titled.size > 1000) titled.delete(titled.values().next().value);
    window.fetch('/_wp/next-title/' + encodeURIComponent(id), { method: 'POST' })
      .then(response => response.ok ? response.json() : null)
      .then(result => { if (result?.changed) window.wpChatEvents?.emit('chat.history.refresh'); })
      .catch(() => {});
  };
  const keyOf = data => data.conversation_id + ':' + data.msg_id;
  const notify = key => listeners.get(key)?.forEach(listener => listener());
  function finish(key) {
    const entry = active.get(key);
    if (entry && !entry.seen) {
      // 正文被 setTimeout(0) 合批，finish 可能早于首次挂载；保留一次排空机会。
      if (entry.streaming) {
        clearTimeout(entry.timer);
        entry.streaming = false;
        entry.timer = setTimeout(() => { active.delete(key); notify(key); }, 5000);
      }
    } else {
      clearTimeout(entry?.timer);
      active.delete(key);
    }
    notify(key);
  }
  function finishConversation(id, except) {
    for (const [key, entry] of active) if (entry.conversation === id && key !== except) finish(key);
  }
  function observe(name, data) {
    if (!data || typeof data !== 'object') return;
    if (name === 'turn.completed') {
      const id = data.conversation_id ?? data.session_id ?? data.sessionId;
      finishConversation(id);
    } else if (name === 'message.stream' && typeof data.conversation_id === 'string') {
      if (data.type === 'finish' || data.type === 'error' ||
          (data.type === 'agent_status' && ['error', 'disconnected'].includes(data.data?.status))) {
        // AionUi 的 finish 表示整轮结束，msg_id 不一定是最后一个正文的编号。
        finishConversation(data.conversation_id);
      } else if (['tool_call', 'acp_tool_call', 'tool_group', 'thinking', 'plan', 'acp_permission'].includes(data.type)) {
        finishConversation(data.conversation_id);
      } else if ((data.type === 'content' || data.type === 'text') && typeof data.msg_id === 'string') {
        const key = keyOf(data), previous = active.get(key);
        finishConversation(data.conversation_id, key);
        const text = typeof data.data === 'string' ? data.data : data.data?.content ?? '';
        const received = (data.replace === true || data.data?.replace === true ? 0 : previous?.received ?? 0) + Array.from(text).length;
        clearTimeout(previous?.timer);
        active.set(key, { conversation: data.conversation_id, received, streaming: true, seen: previous?.seen ?? false,
          route: previous?.route ?? window.location.hash, timer: setTimeout(() => finish(key), 5000) });
        if (!previous?.streaming) notify(key);
      }
    }
  }
  function wrap(emitter) {
    if (!emitter || wrapped.has(emitter)) return emitter;
    const emit = emitter.emit;
    emitter.emit = function (name, data) {
      observe(name, data);
      return emit.apply(this, arguments);
    };
    wrapped.add(emitter);
    return emitter;
  }
  let emitter = wrap(window.__bridgeEmitter);
  Object.defineProperty(window, '__bridgeEmitter', { configurable: true,
    get: () => emitter, set: value => { emitter = wrap(value); } });

  // 复用 AionUi 自己的 React 和 MarkdownView；组件类型在所有正文之间保持稳定。
  window.wpPacedMarkdown = function (React, MarkdownView) {
    if (components.has(MarkdownView)) return components.get(MarkdownView);
    const PacedMarkdown = React.memo(function PacedMarkdown({ wpKey, children, ...props }) {
      const subscribe = React.useCallback(listener => {
        if (!listeners.has(wpKey)) listeners.set(wpKey, new Set());
        const group = listeners.get(wpKey);
        group.add(listener);
        return () => { group.delete(listener); if (!group.size) listeners.delete(wpKey); };
      }, [wpKey]);
      const snapshot = React.useCallback(() => active.get(wpKey)?.streaming === true, [wpKey]);
      const streaming = React.useSyncExternalStore(subscribe, snapshot, snapshot);
      const engine = React.useRef(null), published = React.useRef(null);
      if (engine.current === null) {
        const entry = active.get(wpKey);
        // 切回或刷新时，超出本页已观察增量的正文先全文显示，只有之后的增量继续平滑。
        const fresh = entry && !entry.seen && entry.route === window.location.hash &&
          Array.from(children).length <= entry.received;
        if (entry) entry.seen = true;
        engine.current = new SmoothText(children, !!fresh, performance.now());
      }
      const [view, setView] = React.useState(() => {
        const state = engine.current.tick(performance.now(),
          document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches);
        return { ...state, streaming: streaming || state.streaming };
      });
      published.current = view;
      React.useLayoutEffect(() => {
        const state = engine.current;
        state.update(children, streaming, performance.now());
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        let frame = 0, alive = true;
        const paint = () => {
          if (!alive) return;
          const now = performance.now(), immediate = document.hidden || reduced.matches;
          const next = state.tick(now, immediate);
          const changed = next.text !== published.current.text || next.streaming !== published.current.streaming;
          if (changed) {
            published.current = next;
            setView(next);
          }
          if (!immediate && ((state.shown < state.points.length || (!state.started && state.points.length > 0)) ||
              next.text !== published.current.text || next.streaming !== published.current.streaming)) {
            frame = requestAnimationFrame(paint);
          }
        };
        const refresh = () => { cancelAnimationFrame(frame); paint(); };
        document.addEventListener('visibilitychange', refresh);
        reduced.addEventListener('change', refresh);
        paint();
        return () => {
          alive = false;
          cancelAnimationFrame(frame);
          document.removeEventListener('visibilitychange', refresh);
          reduced.removeEventListener('change', refresh);
        };
      }, [children, streaming, wpKey]);
      return React.createElement(MarkdownView, { ...props, wpStreaming: view.streaming },
        view.streaming ? repairStreamingMarkdown(view.text) : children);
    });
    components.set(MarkdownView, PacedMarkdown);
    return PacedMarkdown;
  };

  // 等待态只是一条临时显示，不写消息流或历史；复用原生思考条及其计时器。
  window.wpWaiting = function (React, Thinking, { conversationId, messages, isProcessing, rowWidthClass }) {
    if (!isProcessing || !conversationId) return null;
    const userIndex = messages.findLastIndex(message => !message.hidden && message.position === 'right');
    if (userIndex < 0) return null;
    const visible = messages.slice(userIndex + 1).some(message => {
      if (message.hidden || message.position === 'right') return false;
      if (message.type === 'text') return !!message.content?.content?.trim();
      if (message.type === 'thinking') {
        return message.content?.status !== 'done' || (message.content.duration ?? message.content.duration_ms ?? 0) >= 1000;
      }
      return ['tool_call', 'tool_group', 'acp_tool_call', 'plan', 'permission', 'acp_permission', 'tips'].includes(message.type);
    });
    if (visible) return null;
    const user = messages[userIndex];
    return React.createElement('div', { className: (rowWidthClass || '') + ' message-item px-8px m-t-10px wp-waiting',
      role: 'status', 'data-testid': 'wp-waiting' },
    React.createElement(Thinking, { key: conversationId + ':' + user.msg_id, waitingLabel: window.wpUI.waitingLabel, message: {
      conversation_id: conversationId, msg_id: user.msg_id + '-waiting', created_at: user.created_at,
      content: { content: '', status: 'pending' }
    } }));
  };
})();

/* 工作伙伴：进入首页或切换对话时聚焦一次；用户操作后不再追着抢焦点。 */
(function () {
  'use strict';
  var route, armed = false, focused = null;
  var composer = '[data-testid="guid-input"],[data-testid="sendbox-input"]';
  var overlays = 'dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],.arco-trigger-popup,.arco-modal-wrapper,.arco-drawer,.wp-pick-menu,.wp-archive-backdrop';
  function routeKey() {
    var match = location.hash.match(/^#\/(guid|conversation\/[^/?#]+)(?:[/?#]|$)/);
    return match ? match[1] : '';
  }
  function visible(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible' &&
      !el.closest('[inert],[aria-hidden="true"]');
  }
  function stop() { armed = false; }
  function enter() { route = routeKey(); armed = !!route; focused = null; }
  function apply() {
    if (route !== routeKey()) enter();
    if (!armed || (focused && focused.isConnected)) return;
    if (innerWidth <= 767 || matchMedia('(hover: none)').matches || document.hidden) { stop(); return; }
    if (Array.from(document.querySelectorAll(overlays)).some(visible)) { stop(); return; }
    var input = document.querySelector(route === 'guid' ? '[data-testid="guid-input"]' : '[data-testid="sendbox-input"]');
    var active = document.activeElement;
    // 切页可沿用旧的消息输入框；其他输入框（包括搜索、文件重命名）属于本人。
    if (active && !active.matches(composer) &&
        (active.matches('input,textarea,select') || active.isContentEditable)) { stop(); return; }
    if (!input || input.disabled || input.readOnly || !visible(input)) return;
    input.focus({ preventScroll: true });
    if (document.activeElement === input) {
      if (route === 'guid') input.setSelectionRange(input.value.length, input.value.length);
      focused = input;
    }
  }
  function request() { enter(); apply(); }
  window.wpComposerFocus = { request: request };
  // hash 已更新但 React 尚未挂载时，等真实输入框出现；不依赖固定延时。
  new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true,
    attributes: true, attributeFilter: ['disabled', 'readonly', 'hidden', 'class', 'style', 'open', 'aria-hidden', 'inert'] });
  window.addEventListener('hashchange', apply);
  document.addEventListener('DOMContentLoaded', apply, { once: true });
  document.addEventListener('visibilitychange', stop);
  // 从开始操作起取消本页后续聚焦，包括异步挂载替换；下一次导航才重新启用。
  ['pointerdown', 'keydown', 'input'].forEach(function (name) {
    document.addEventListener(name, stop, true);
  });
  document.addEventListener('focusin', function (e) {
    if (!e.target.matches(composer)) stop();
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('.wp-sider-new,[class*="_newChatTrigger"]') && routeKey() === 'guid') request();
  });
  apply();
})();

/* 工作伙伴：消息重发。原生发送器负责附件、排队、错误提示与追加消息。 */
(function () {
  const composers = new Map(), listeners = new Set(), sending = new Set();
  const notify = () => listeners.forEach(listener => listener());
  const available = id => composers.has(id) && !composers.get(id).busy && !sending.has(id);
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  function useComposer(React, api) {
    React.useLayoutEffect(() => {
      const before = available(api.id);
      composers.set(api.id, api);
      if (before !== available(api.id)) notify();
    });
    React.useLayoutEffect(() => () => { composers.delete(api.id); notify(); }, [api.id]);
  }
  function sourceMessage(message, messages) {
    if (message.position === 'right') return message;
    if (message.position !== 'left' || message.content.teammateMessage) return null;
    const index = messages.findIndex(item => item.id === message.id);
    for (let i = index - 1; i >= 0; i--) {
      const item = messages[i];
      if (item.position === 'right' && item.type === 'text' && !item.hidden &&
          item.conversation_id === message.conversation_id) return item;
    }
    return null;
  }
  function useAction(React, { message, source, conversation, parse }) {
    const id = conversation?.conversation_id;
    const ready = React.useSyncExternalStore(subscribe, () => available(id), () => false);
    if (!ready || !source || conversation.hideSendBox || source.content.cronMeta) return null;
    const edit = message.position === 'right';
    const label = window.wpUI.copy(edit ? 'editResend' : 'regenerate');
    const click = async () => {
      if (!available(id)) return;
      const parsed = parse(source.content.content);
      const payload = { input: parsed.text, files: parsed.files };
      const api = composers.get(id);
      if (edit) {
        api.restore(payload);
        document.querySelector('[data-testid="sendbox-input"]')?.focus();
      } else {
        sending.add(id); notify();
        try { await api.send(payload); }
        catch (error) { /* Native send already reports the error in the conversation. */ }
        finally { sending.delete(id); notify(); }
      }
    };
    return React.createElement('button', { type: 'button', className: 'wp-message-action',
      'data-testid': edit ? 'message-edit-resend' : 'message-regenerate', title: label, 'aria-label': label,
      onClick: click }, React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      React.createElement('path', { d: edit ? 'M16 3l5 5-12 12-6 1 1-6L16 3zM13 6l5 5' : 'M20 10a8 8 0 1 0 0 5M20 3v7h-7' })));
  }
  window.wpMessageActions = { useComposer, useAction, sourceMessage };
})();

/* 工作伙伴：精简界面。只做隐藏、跳转和助手改名，不改 AionUi 的业务逻辑。
   调试入口：浏览器控制台执行 localStorage.wp_admin='1' 后刷新，显示全部入口（助手名仍按工作伙伴的叫法）。 */
(function () {
  var admin = false;
  try { admin = localStorage.getItem('wp_admin') === '1'; } catch (e) {}

  /* __WP_COPY__ */
  function locale() {
    var value = window.wpSettings ? window.wpSettings.get().language : null;
    if (!value) try { value = localStorage.getItem('i18nextLng'); } catch (e) { /* Native startup will provide the language. */ }
    return value && /^en/i.test(value) ? 'en-US' : 'zh-CN';
  }
  function t(key) { return COPY[locale()][key]; }
  // ---------- 显示格式：只处理界面摘要，不改接口、消息正文或持久化数据 ----------
  function uploadEntries(entries) {
    if (!entries.some(function (entry) { return /^attach(?:-|$)/.test(entry.key); })) return entries;
    return entries.filter(function (entry) { return entry.key === 'attach' || entry.key === 'attach-my-device'; });
  }
  function internalFile(name, directory) { return directory === '' && ['.claude', '.codex', 'AGENTS.md', 'CLAUDE.md'].indexOf(name) >= 0; }
  function dateTime(value) {
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    if (locale() !== 'zh-CN') return date.toLocaleString('en-US');
    return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' +
      String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }
  function attachmentSummary(value) {
    // AionUi appends its file list after this marker, separated from the message by a newline.
    return String(value || '').replace(/\[\[AION_FILES\]\][^\n]*(?:\n[ \t]*\/[^\n]*)*/g, t('attachment'));
  }
  function toolLabel(name) {
    var id = String(name || '').replace(/[^a-z]/gi, '').toLowerCase();
    var keys = { filechange: 'changeFile', edit: 'changeFile', editfile: 'changeFile', replace: 'changeFile', multiedit: 'changeFile', applypatch: 'changeFile',
      commandexecution: 'runCommand', execute: 'runCommand', exec: 'runCommand', execcommand: 'runCommand', shell: 'runCommand', shellcommand: 'runCommand', bash: 'runCommand', runcommand: 'runCommand',
      read: 'readFile', readfile: 'readFile', readtextfile: 'readFile', readmanyfiles: 'readFile', write: 'writeFile', writefile: 'writeFile', writetextfile: 'writeFile',
      search: 'searchFiles', grep: 'searchFiles', glob: 'searchFiles', list: 'searchFiles', listdirectory: 'searchFiles', searchfiles: 'searchFiles',
      web: 'searchWeb', websearch: 'searchWeb', searchweb: 'searchWeb', webfetch: 'openWeb', fetch: 'openWeb', openurl: 'openWeb' };
    return keys[id] ? t(keys[id]) : name;
  }
  function toolDetail(data) {
    var input = data.rawInput || data.raw_input || data.input || data.args;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch (error) { input = null; } }
    var detail = input && (input.file_path || input.path || input.file_name || input.command || input.cmd || input.query || input.pattern || input.url);
    if (!detail && Array.isArray(data.locations)) detail = data.locations.map(function (x) { return x.path; }).filter(Boolean).join(', ');
    if (!detail && Array.isArray(data.content)) detail = data.content.map(function (x) { return x.path; }).filter(Boolean).join(', ');
    if (!detail && input && input.changes && !Array.isArray(input.changes) && typeof input.changes === 'object') detail = Object.keys(input.changes).join(', ');
    if (!detail && input && Array.isArray(input.changes)) detail = input.changes.map(function (x) { return x.path || x.file_path; }).filter(Boolean).join(', ');
    if (Array.isArray(detail)) detail = detail.join(' ');
    return typeof detail === 'string' ? detail : '';
  }
  function toolSummary(item) {
    var detail = toolDetail(item) || item.description || '';
    if (detail === item.name || toolLabel(detail) !== detail) return '';
    return String(detail).replace(/\s+/g, ' ').slice(0, 100);
  }
  window.wpUI = { copy: t, isChinese: function () { return locale() === 'zh-CN'; }, internalFile: internalFile, uploadEntries: uploadEntries,
    waitingLabel: function (seconds) {
      if (seconds < 1) return t('working');
      var duration = (seconds >= 3600 ? Math.floor(seconds / 3600) + t('hour') : '') +
        (seconds >= 60 ? Math.floor(seconds / 60) % 60 + t('minute') : '') + seconds % 60 + t('second');
      return t('workingFor').replace('{duration}', duration);
    },
    fileCount: function (count) { return t(count === 1 ? 'fileCountOne' : 'fileCount').replace('{count}', String(count)); },
    dateTime: dateTime, attachmentSummary: attachmentSummary, toolLabel: toolLabel, toolDetail: toolDetail, toolSummary: toolSummary };
  // ---------- 原生设置 ----------
  function text(el, value) { if (el && el.textContent !== value) el.textContent = value; }
  function settingsReady() {
    if (!window.wpSettings || settingsReady.bound) return;
    settingsReady.bound = true;
    window.wpSettings.subscribe(function () { schedule(); });
    window.wpSettings.ready.then(schedule).catch(function () { /* The settings menu reports initialization errors. */ });
  }
  window.addEventListener('wp-settings-ready', settingsReady);
  settingsReady();

  // 固定默认值：新建会话时把工作目录、免确认模式、模型和推理强度写进请求（工作目录、免确认模式由 rebrand.py 在构建时替换占位符）。
  // 工作目录一律是 /data/work（与消息桥同一个目录）；AionUi 自己给的临时目录（/data/aionui-data 下）也换掉。
  // 免确认模式按智能体取 AionUi 自己登记的值（Claude Code 是 bypassPermissions，Codex 是 agent-full-access）。
  var WORKDIR = '__WP_WORKDIR__', PERM = '__WP_PERMISSION__';
  var rawFetch = window.fetch;
  var MODELS = {}, SAME_MODEL = {};
  function sameModel(backend, id) { return (SAME_MODEL[backend] || {})[id] || id; }
  function applyModelConfig(config) {
    MODELS = config.catalog;
    SAME_MODEL = { codex: {}, claude: {} };
    ['codex', 'claude'].forEach(function (backend) {
      (MODELS[backend] || []).forEach(function (m) {
        SAME_MODEL[backend][m.key] = m.id;
        (m.also || []).forEach(function (alias) { SAME_MODEL[backend][alias] = m.id; });
      });
      var model = config.defaults[backend];
      SAME_MODEL[backend]['default'] = SAME_MODEL[backend][model] || model;
    });
  }
  var EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  var keyModels = null, engineEffort = {}, engineModels = {};
  var modelSettingsReady = rawFetch.call(window, '/api/settings/client').then(function (r) { return r.json(); })
    .then(function (j) {
      var d = j.data || j;
      if (d['wp.modelConfig']) applyModelConfig(d['wp.modelConfig']);
      if (Array.isArray(d['wp.models'])) keyModels = d['wp.models'];
      if (d['wp.effort'] && typeof d['wp.effort'] === 'object') engineEffort = d['wp.effort'];
      engineModels = d['wp.engineModels'] || {};
      ['codex', 'claude'].forEach(function (backend) {
        if (engineModels[backend]) SAME_MODEL[backend]['default'] = sameModel(backend, engineModels[backend]);
      });
      schedule();
    }).catch(function () {});
  // 菜单里的模型：[{id: 显示和打勾用的模型, value: 切换时发给对话的值, name}]。当前模型始终在列表里。
  function modelsFor(backend, values, current) {
    var cur = current ? sameModel(backend, current) : null, list = [], available = [], matched = false;
    (MODELS[backend] || []).forEach(function (m) {
      var value = values ? [m.id].concat(m.also || []).filter(function (v) { return values.indexOf(v) >= 0; })[0] : m.id;
      var usable = value && (!keyModels || keyModels.indexOf(m.key) >= 0);
      var item = { id: m.id, value: value || m.id, name: m.name };
      if (value || m.id === cur) available.push(item);
      if (usable) matched = true;
      if (usable || m.id === cur) list.push(item);
    });
    // An unmatched permission list must not erase the engine's available catalog.
    if (!matched) list = available;
    if (cur && !list.some(function (m) { return m.id === cur; })) list.unshift({ id: cur, value: current, name: current });
    return list;
  }
  // 首页的推理强度：对话页学到的档位按助手记在本浏览器（wp_efforts_<助手>）；还没学到时 ChatGPT 不列“最高”（Codex 只到 xhigh）。
  function learnedEfforts(backend) {
    try { var v = JSON.parse(localStorage.getItem('wp_efforts_' + backend) || 'null'); if (Array.isArray(v) && v.length) return v; } catch (e) {}
    return backend === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : null;
  }
  function learnEfforts(backend, vals) { if (vals && vals.length) try { localStorage.setItem('wp_efforts_' + backend, JSON.stringify(vals)); } catch (e) {} }
  function effortsFor(values) { return EFFORTS.filter(function (e) { return !values || values.indexOf(e) >= 0; }).map(function (e) { return [e, t(e)]; }); }
  function modelName(backend, id) {
    var m = (MODELS[backend] || []).filter(function (x) { return x.id === sameModel(backend, id); })[0];
    return m ? m.name : (id || '');
  }
  function effortName(v) { return EFFORTS.indexOf(v) >= 0 ? t(v) : (v || ''); }
  // 首页的选择：{model, effort}。本人选过的项记在 wp_pick2_<助手>，没选过的用默认值。
  function homeChosen(backend) {
    try { return JSON.parse(localStorage.getItem('wp_pick2_' + backend) || '{}') || {}; } catch (e) { return {}; }
  }
  function homePick(backend) {
    var p = homeChosen(backend);
    p.model = sameModel(backend, p.model || engineModels[backend]);
    var ms = modelsFor(backend, null, p.model);
    if (!ms.some(function (m) { return m.id === p.model; })) p.model = ms.length ? ms[0].id : '';
    p.effort = p.effort || engineEffort[backend] || 'medium';
    if (!effortsFor(learnedEfforts(backend)).some(function (e) { return e[0] === p.effort; })) p.effort = 'medium';
    return p;
  }

  // 两个助手对同事的显示名和图标：Codex → ChatGPT，Claude Code → Claude。名字和图标都来自 AionUi 接口
  // （智能体、助手、会话里的助手快照），在接口返回处改；WebSocket 推送后渲染出来的由 apply() 在页面上兜底。
  var AGENT_NAMES = { 'Codex CLI': 'ChatGPT', 'Codex': 'ChatGPT', 'Claude Code': 'Claude' };
  // 页面上其他要换的整段文字（只换完全相同的文字节点）
  var PAGE_TEXT = { '新会话': 'newChat', '新对话': 'newChat', 'New Chat': 'newChat', 'New chat': 'newChat',
    '项目': 'recent', '最近对话': 'recent', 'Projects': 'recent', 'Recent chats': 'recent', '工作伙伴': 'brand', 'WorkPartner': 'brand' };
  var CHATGPT_ICON = '/assets/wp-agents/chatgpt.svg', CLAUDE_ICON = '/assets/wp-agents/claude.svg';
  var RENAMED_API = /\/api\/(agents|assistants|conversations)(\/|\?|$)/;
  function agentIcon(src) {
    if (/\/logos\/[\w\/-]*(codex|openai)[\w-]*\.svg/.test(src)) return CHATGPT_ICON;
    if (/\/logos\/[\w\/-]*claude[\w-]*\.svg/.test(src)) return CLAUDE_ICON;
    return null;
  }
  function renameAgents(v) {
    if (Array.isArray(v)) { v.forEach(renameAgents); return; }
    if (!v || typeof v !== 'object') return;
    Object.keys(v).forEach(function (k) {
      var x = v[k];
      if (typeof x !== 'string') return renameAgents(x);
      if (k === 'name' && AGENT_NAMES[x]) v[k] = AGENT_NAMES[x];
      else if (k === 'avatar' || k === 'icon') v[k] = agentIcon(x) || x;
    });
  }
  var homeProject = null;
  var convs = {};   // 对话号 -> {backend, modified, options}
  function conv(id) { return convs[id] || (convs[id] = {}); }
  function remember(c) {
    if (!c || !c.id) return;
    if (c.project_id && c.extra && c.extra.workspace === WORKDIR) homeProject = c.project_id;
    var x = conv(c.id);
    if (c.modified_at) x.modified = c.modified_at;
    var b = (c.extra && c.extra.backend) || (c.assistant && c.assistant.backend);
    if (b) x.backend = b;
    if (c.extra && c.extra.thought_level) x.effort = c.extra.thought_level;   // 新建时写进去的推理强度
    if (c.extra && c.extra.current_model_id) x.model = c.extra.current_model_id;
  }
  function renamedResponse(r) {
    if (!/json/.test(r.headers.get('content-type') || '')) return r;
    return r.clone().text().then(function (t) {
      var j = JSON.parse(t);
      var d = j && j.data;
      if (d && Array.isArray(d.items)) d.items.forEach(remember); else if (d && d.id) remember(d);
      renameAgents(j);
      return new Response(JSON.stringify(j), { status: r.status, statusText: r.statusText, headers: r.headers });
    }).catch(function () { return r; });
  }
  var agents = null;
  function agentInfo() {   // 智能体编号 -> {yolo: 免确认模式, backend: claude/codex}
    if (!agents) agents = rawFetch.call(window, '/api/agents/management').then(function (r) { return r.json(); }).then(function (j) {
      var m = {};
      (j.data || []).forEach(function (a) { m[a.id] = { yolo: a.yolo_id, backend: a.backend }; });
      return m;
    }).catch(function () { agents = null; return {}; });
    return agents;
  }
  function remembered(id) {   // AionUi 自己唤起对话时返回的当前选项也记下来
    return function (r) {
      r.clone().json().then(function (j) { var d = j.data || j; if (d && d.config_options) { conv(id).options = d.config_options; schedule(); } }).catch(function () {});
      return r;
    };
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method === 'GET' && RENAMED_API.test(url)) return rawFetch.call(this, input, init).then(renamedResponse);
    var sent = method === 'POST' && /\/api\/conversations\/([\w-]+)\/messages(?:\?|$)/.exec(url);
    if (sent) return rawFetch.call(this, input, init).then(function (r) {
      if (r.ok) window.wpTitleSent(sent[1]);
      return r;
    });
    var ens = method === 'POST' && /\/api\/conversations\/([\w-]+)\/runtime\/ensure$/.exec(url);
    if (ens) return rawFetch.call(this, input, init).then(remembered(ens[1]));
    // 定时任务由服务端起对话，不经过下面新建对话的改写：在任务的 agent_config 里写工作目录，免确认模式没有时补上
    if ((method === 'POST' || method === 'PUT') && /\/api\/cron\/jobs(\/[\w-]+)?(\?|$)/.test(url) && init && typeof init.body === 'string') {
      return agentInfo().then(function (ids) {
        try {
          var b = JSON.parse(init.body), c = b.agent_config;
          if (c) {
            if (!c.workspace || c.workspace.indexOf('/data/aionui-data/') === 0) c.workspace = WORKDIR;
            if (!c.mode) c.mode = (ids[String(c.assistant_id || '').replace(/^bare:/, '')] || {}).yolo || PERM;
            init = Object.assign({}, init, { body: JSON.stringify(b) });
          }
        } catch (e) {}
        return rawFetch.call(window, input, init);
      });
    }
    if (!(method === 'POST' && /\/api\/conversations(\?|$)/.test(url) && init && typeof init.body === 'string')) return rawFetch.call(this, input, init);
    ghostPosted = true;
    return modelSettingsReady.then(agentInfo).then(function (ids) {
      try {
        var b = JSON.parse(init.body);
        b.extra = b.extra || {};
        var ws = b.extra.workspace || '';
        if (!ws || ws.indexOf('/data/aionui-data/') === 0) { b.extra.workspace = WORKDIR; b.extra.custom_workspace = true; }
        var o = b.assistant && b.assistant.conversation_overrides;
        if (o) {
          var a = ids[String(b.assistant.id || '').replace(/^bare:/, '')] || {};
          o.permission = a.yolo || PERM;
          var p = homePick(a.backend);
          o.thought_level = p.effort;
          if (p.model) o.model = p.model; else delete o.model;
        }
        init = Object.assign({}, init, { body: JSON.stringify(b) });
      } catch (e) {}
      return rawFetch.call(window, input, init).then(function (r) { if (!r.ok) ghostClear(); return r; }, function (e) { ghostClear(); throw e; });
    });
  };

  // 消息区与输入框分别交接：骨架屏不算真实消息，输入框始终保留一个可见副本。
  var ghost = null, ghostTimer = 0, ghostPosted = false, composer = null, composerAnimation = null, nativeFade = null, bubbleAnimation = null;
  // Keep transient send flags off html: upstream theme/minimap observers remeasure on every html class change.
  function composerClear() {
    if (composerAnimation) composerAnimation.cancel();
    composerAnimation = null;
    if (nativeFade) nativeFade.cancel();
    nativeFade = null;
    if (composer) composer.remove();
    composer = null;
    document.body.classList.remove('wp-composer-pending');
  }
  function ghostClear() {
    clearTimeout(ghostTimer);
    if (bubbleAnimation) bubbleAnimation.cancel();
    bubbleAnimation = null;
    if (ghost) ghost.remove();
    ghost = null;
    composerClear();
    document.body.classList.remove('wp-home-sending');
    sidebarReveal();
  }
  function animateComposer(rect) {
    var el = composer, from = el.getBoundingClientRect();
    Object.assign(el.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    el.style.transformOrigin = 'top left';
    composerAnimation = el.animate([
      { transform: 'translate(' + (from.left - rect.left) + 'px,' + (from.top - rect.top) + 'px) scale(' + (from.width / rect.width) + ',' + (from.height / rect.height) + ')' },
      { transform: 'none' }
    ], { duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, easing: 'ease-out', fill: 'forwards' });
    composerAnimation.onfinish = schedule;
  }
  function visibleMessage(el) {
    if (!el || el.closest('[data-testid="message-list-skeleton"],[aria-hidden="true"]')) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight &&
      el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  }
  function ghostHandoff() {
    if (!ghost) return;
    var native = document.querySelector('.sendbox-panel');
    if (native && composer && !composer.dataset.handoff && (!composerAnimation || composerAnimation.playState === 'finished')) {
      var r = native.getBoundingClientRect();
      if (r.width && r.height) {
        composer.dataset.handoff = 'true';
        var el = composer;
        // The copy already occupies this destination. Only exchange pixels here.
        document.body.classList.remove('wp-composer-pending');
        nativeFade = native.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
        var fade = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' });
        fade.onfinish = function () { if (composer === el) { composerClear(); schedule(); } };
      }
    }
    if (document.querySelector('.wp-missing-chat')) { ghostClear(); return; }
    var list = document.querySelector('[data-testid="message-list-content"]');
    if (!convId() || !visibleMessage(list)) return;
    var user = Array.from(list.querySelectorAll('.message-item.justify-end')).find(visibleMessage);
    var feedback = Array.from(list.querySelectorAll('.wp-waiting,.message-item.justify-start,.message-item[data-message-type="tips"]')).some(visibleMessage);
    var bubble = user && user.querySelector('.bg-aou-2');
    if (bubble) {
      var to = bubble.getBoundingClientRect(), copy = ghost.querySelector('.wp-ghost-bubble');
      var from = copy.getBoundingClientRect();
      var key = [to.left, to.top, to.width, to.height].join(',');
      if (ghost.dataset.bubbleTarget !== key) {
        ghost.dataset.bubbleTarget = key;
        ghost.dataset.bubbleReady = 'false';
        if (bubbleAnimation) bubbleAnimation.cancel();
        Object.assign(copy.style, { position: 'fixed', left: to.left + 'px', top: to.top + 'px',
          width: to.width + 'px', height: to.height + 'px', font: getComputedStyle(bubble).font, maxWidth: 'none', maxHeight: 'none', boxSizing: 'border-box', transformOrigin: 'top left' });
        bubbleAnimation = copy.animate([
          { transform: 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + (from.width / to.width) + ',' + (from.height / to.height) + ')' },
          { transform: 'none' }
        ], { duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200, easing: 'ease-out', fill: 'forwards' });
        var owner = ghost;
        bubbleAnimation.onfinish = function () { if (ghost === owner) { owner.dataset.bubbleReady = 'true'; schedule(); } };
      }
    }
    if (user && feedback && !composer && (!bubble || ghost.dataset.bubbleReady === 'true')) ghostClear();
  }
  function ghostShow(text) {
    ghostClear(); ghostPosted = false;
    sidebarFreeze();
    var r = (document.querySelector('main.layout-content') || document.body).getBoundingClientRect();
    // New chats use WORKDIR's project; reserve its persisted explorer width before it mounts.
    var files = 0;
    if (innerWidth >= 768 && homeProject) {
      try {
        if (localStorage.getItem('project-panel-collapse:' + homeProject) === 'expanded') {
          files = Math.max(220, Math.min(500, Number(localStorage.getItem('wp-workspace-width-v2:' + homeProject)) || 260, r.width - 360)) + 1;
        }
      } catch (e) {}
    }
    var source = document.querySelector('[class*="_guidInputCardWrap"]');
    if (source) {
      var c = source.getBoundingClientRect();
      composer = source.cloneNode(true);
      composer.classList.add('wp-transition-composer');
      composer.setAttribute('aria-hidden', 'true');
      composer.inert = true;
      composer.querySelectorAll('[id],[data-testid]').forEach(function (el) { el.removeAttribute('id'); el.removeAttribute('data-testid'); });
      composer.querySelectorAll('textarea').forEach(function (el) { el.value = ''; el.placeholder = t('messagePlaceholder'); });
      composer.style.cssText = 'position:fixed;z-index:41;margin:0;pointer-events:none;transition:none;left:' + c.left + 'px;top:' + c.top + 'px;width:' + c.width + 'px;height:' + c.height + 'px';
      document.body.appendChild(composer);
      document.body.classList.add('wp-composer-pending');
      var width = Math.min(768, r.width - files - 40), height = innerWidth < 768 ? 80 : 112;
      animateComposer({ left: r.left + (r.width - files - width) / 2, top: r.bottom - height - 16, width: width, height: height });
    }
    document.body.classList.add('wp-home-sending');
    var g = ghost = document.createElement('div');
    g.className = 'wp-ghost';
    g.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + (r.width - files) + 'px;height:' + Math.max(0, r.height - (source ? source.getBoundingClientRect().height : 112) - 16) + 'px;pointer-events:none';
    g.innerHTML = '<div class="wp-ghost-msg"><div class="wp-ghost-bubble"></div></div>';
    g.querySelector('.wp-ghost-bubble').textContent = text;
    document.body.appendChild(g);
    ghostTimer = setTimeout(function () { if (ghost === g && !ghostPosted) ghostClear(); }, 1500);
  }
  var sidebarCopy = null, sidebarAnimation = null;
  function sidebarFreeze() {
    if (sidebarAnimation) sidebarAnimation.cancel();
    if (sidebarCopy) sidebarCopy.remove();
    sidebarAnimation = null; sidebarCopy = null;
    var source = document.querySelector('aside.layout-sider [class*="_scrollArea"]');
    if (!source) return;
    var r = source.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= 0) return;
    var copy = source.cloneNode(true);
    copy.classList.add('wp-sidebar-copy');
    copy.setAttribute('aria-hidden', 'true'); copy.inert = true;
    copy.removeAttribute('id');
    copy.querySelectorAll('[id],[data-testid]').forEach(function (el) { el.removeAttribute('id'); el.removeAttribute('data-testid'); });
    copy.style.cssText = 'position:fixed;z-index:40;pointer-events:none;margin:0;box-sizing:border-box;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;background:var(--wp-sidebar)';
    document.body.appendChild(copy); copy.scrollTop = source.scrollTop;
    sidebarCopy = copy;
    document.body.classList.add('wp-sidebar-pending');
  }
  function sidebarReveal() {
    document.body.classList.remove('wp-sidebar-pending');
    if (!sidebarCopy || sidebarAnimation) return;
    var copy = sidebarCopy;
    var source = document.querySelector('aside.layout-sider [class*="_scrollArea"]');
    var duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150;
    if (source) source.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration });
    sidebarAnimation = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration, fill: 'forwards' });
    sidebarAnimation.onfinish = function () {
      copy.remove();
      if (sidebarCopy === copy) { sidebarCopy = null; sidebarAnimation = null; }
    };
  }
  var homePreloaded = false;
  function preloadHome() {
    if (!document.querySelector('[data-testid="guid-input"]')) return;
    agentInfo();
    if (homePreloaded) return;
    homePreloaded = true;
    var load = function () {
      // 直接 import 只加载 JS；Vite 路由还会等待 CSS，必须一起在首页预热。
      __WP_CHAT_STYLES__.forEach(function (path) {
        var href = new URL(path, document.baseURI).href;
        if (Array.from(document.querySelectorAll('link[rel="stylesheet"]')).some(function (link) { return link.href === href; })) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = href;
        link.onerror = function () { link.remove(); homePreloaded = false; };
        document.head.appendChild(link);
      });
      import('__WP_CHAT_MODULE__').catch(function () { homePreloaded = false; });
    };
    if (window.requestIdleCallback) window.requestIdleCallback(load, { timeout: 1000 }); else setTimeout(load, 0);
  }
  function guidSend() {
    var el = document.querySelector('[data-testid="guid-input"]'), btn = document.querySelector('[data-testid="guid-send-btn"]');
    var t = el ? String(el.value !== undefined ? el.value : el.textContent).trim() : '';
    if (t && t.charAt(0) !== '/' && btn && !btn.disabled && !btn.classList.contains('arco-btn-loading')) ghostShow(t);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && e.target.matches && e.target.matches('[data-testid="guid-input"]')) guidSend();
  }, true);
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('[data-testid="guid-send-btn"]')) guidSend(); }, true);
  window.addEventListener('hashchange', function () { if (!/^#\/(guid|conversation\/)/.test(location.hash)) ghostClear(); });

  // 设置、助手、团队页不对同事开放，进入时回到对话首页；定时任务从侧栏“自动化”进入
  var BLOCKED = /^#\/(settings|assistants|team|test)(\/|$)/;
  function guardRoute() { if (!admin && BLOCKED.test(location.hash)) location.replace('#/guid'); }
  window.addEventListener('hashchange', guardRoute);
  guardRoute();

  var SIDEBAR_ITEMS = ['助手', '定时任务', '设置', '退出登录', '返回设置', 'Assistants', 'Scheduled Tasks', 'Scheduled tasks', '自动化', 'Automation', 'Settings', 'Log out', 'Logout', 'Back to Settings', 'Back to settings'];
  var HOME_ITEMS = ['在项目中工作', 'Chat in Project'];
  var FOOTER_ITEMS = ['反馈问题', '喜欢我们？点个星吧', '远程连接', 'Report Issue', 'Like us? Give us a star!', 'Remote Connection'];

  // 从只含这个文字的叶子节点向上爬，到“整行”为止（行内只剩图标，没有别的文字）
  function rowOf(el) {
    var t = (el.textContent || '').trim();
    var n = el;
    for (var i = 0; i < 4; i++) {
      var p = n.parentElement;
      if (!p || p === document.body) break;
      if ((p.textContent || '').trim() !== t || p.querySelector('textarea,input,[contenteditable]') || p.querySelectorAll('button').length > 1) break;
      n = p;
    }
    return n;
  }
  function leaves(texts, root) {
    var out = [];
    var all = (root || document).querySelectorAll('span,div,p,a,button');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length) continue;
      var t = (el.textContent || '').trim();
      if (texts.indexOf(t) >= 0 || /^(选择模型|权限\s*·.*|(claude|codex)\/[\w.-]+)$/.test(t)) out.push(el);
    }
    return out;
  }
  function hide(el) { if (el && !el.classList.contains('wp-hide')) el.classList.add('wp-hide'); }
  function commonAncestor(a, b) {
    for (var n = a; n; n = n.parentElement) if (n.contains(b)) return n;
    return null;
  }

  function messageTableScroll() {
    // Markdown 使用 Shadow DOM，页面 CSS 无法让其中的超宽表格单独滚动。
    document.querySelectorAll('[data-testid="message-list-content"] .markdown-shadow').forEach(function (host) {
      var root = host.shadowRoot;
      if (!root || root.querySelector('[data-wp-table-scroll]')) return;
      var style = document.createElement('style');
      style.setAttribute('data-wp-table-scroll', '');
      style.textContent = '.markdown-shadow-body table { display: block; width: fit-content; max-width: 100%; overflow-x: auto; }';
      root.appendChild(style);
    });
  }

  function apply() {
    document.documentElement.classList.toggle('wp-automation', /^#\/scheduled(?:\/|$)/.test(location.hash));
    if (document.title !== t('brand')) document.title = t('brand');
    renameOnPage();
    // 标题栏左段配侧栏色，宽度跟侧栏走（收起、手机上侧栏不占位时为 0）
    var sider = document.querySelector('aside.layout-sider');
    var w = sider ? Math.max(0, Math.round(sider.getBoundingClientRect().right)) + 'px' : '0px';
    if (document.documentElement.style.getPropertyValue('--wp-sider-w') !== w) document.documentElement.style.setProperty('--wp-sider-w', w);
    preloadHome();
    if (admin) { ghostHandoff(); return; }
    marketPage();
    messageTableScroll();
    // 侧栏只留一个对话列表（与原来的“最近对话”一致）：“项目”标题改叫“最近对话”，work 项目行和“对话”标题隐藏
    document.querySelectorAll('.sider-section-title').forEach(function (t) {
      if (/^(对话|Conversations)$/.test((t.textContent || '').trim())) hide(t.closest('.sider-section-label') || t.parentElement);
    });
    document.querySelectorAll('.workspace-collapse > .sticky').forEach(hide);
    var aside = document.querySelector('aside.layout-sider');
    // 侧栏入口（只在侧栏里找，定时任务页自己的标题不动）
    if (aside) leaves(SIDEBAR_ITEMS, aside).forEach(function (el) { if (!el.closest('.wp-nav')) hide(rowOf(el)); });
    // 侧栏“团队”分组标题行
    document.querySelectorAll('[data-testid="team-section-toggle"]').forEach(function (el) { hide(el.parentElement); });
    // 首页：智能体选择条保留（只开了 Claude Code 和 Codex）；模型、权限、工作目录隐藏
    leaves(HOME_ITEMS).forEach(function (el) { hide(rowOf(el)); });
    var ws = document.querySelector('[data-testid="workspace-selector-btn"]');
    if (ws) hide(ws.parentElement);
    // 只隐藏原生反馈入口；按坐标隐藏 SVG 会误伤同在右上角的文件栏开关。
    document.querySelectorAll('.app-titlebar__toolbar > button[aria-label="反馈问题"], .app-titlebar__toolbar > button[aria-label="Report Issue"]').forEach(hide);
    simplifyMenus();
    workspacePanel();
    var hint = document.querySelector('[class*="assistantPromptHint"]');
    if (hint && hint.parentElement) hide(hint.parentElement);
    // 首页底部三个小按钮
    var f = leaves(FOOTER_ITEMS);
    if (f.length >= 2) hide(commonAncestor(f[0], f[1]));
    // 定时任务页：“仅在电脑唤醒状态下运行 / 保持唤醒”是桌面版的说明，容器一直在运行，去掉
    leaves(['自动化仅在电脑唤醒状态下运行。', '定时任务仅在电脑唤醒状态下运行。', 'Scheduled tasks only run when your computer is awake.', 'Scheduled tasks only run while your computer is awake.']).forEach(function (el) {
      for (var n = el, i = 0; n && i < 5; n = n.parentElement, i++) if (n.querySelector('[role=switch],.arco-switch')) { hide(n); break; }
    });
    sidebar(aside);
    messageFade(document.querySelector('[data-testid="message-list-scroller"]'));
    window.wpArchive.render();
    modelPicker();
    ghostHandoff();
    pets();
    // 弹窗：更新提示、团队来信
    document.querySelectorAll('.arco-modal-wrapper').forEach(function (m) {
      var t = m.textContent || '';
      if (/团队的一封信|A letter from|检查更新|发现新版本|新版本|Check for updates|New version available/.test(t)) hide(m);
    });
  }

  function simplifyMenus() {
    // Conversation toolbar menus have separate desktop and mobile renderers.
    document.querySelectorAll('.arco-dropdown-menu-item,.arco-dropdown-menu-pop-header,[data-testid^="mobile-action-sheet-"]').forEach(function (row) {
      var label = (row.textContent || '').trim();
      if (/^(添加文件|Add files|技能|Skills)(?:\s*\([\d/]+\)|\s*已选\s*\d+|\s*Selected\s+\d+)?$/.test(label)) hide(row);
    });
    document.querySelectorAll('[data-testid="guid-input"],[data-testid="sendbox-input"]').forEach(function (input) {
      if (input.matches('[data-testid="sendbox-input"],[data-testid="guid-input"]')) {
        var placeholder = t('messagePlaceholder');
        if (input.getAttribute('placeholder') !== placeholder) input.setAttribute('placeholder', placeholder);
      }
    });

  }

  // 页面上的助手名和图标（对话正文在 shadow DOM 或 pre/code 里，不会被改到）
  function renameOnPage() {
    document.querySelectorAll('img[src*="/logos/"]').forEach(function (im) {
      var i = agentIcon(im.getAttribute('src'));
      if (i) im.setAttribute('src', i);
    });
    document.querySelectorAll('img[src="' + CHATGPT_ICON + '"]:not(.wp-chatgpt)').forEach(function (im) { im.classList.add('wp-chatgpt'); });
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      var value = n.nodeValue.trim();
      if (!value || (n.parentElement && n.parentElement.closest('pre,code,textarea,[contenteditable]'))) continue;
      var fixed = n.parentElement && n.parentElement.closest('.sider-section-title,[class*="_newChatTrigger"],aside header.arco-layout-header,.app-titlebar__brand');
      var to = AGENT_NAMES[value] || (!admin && PAGE_TEXT[value] && fixed ? t(PAGE_TEXT[value]) : null);
      if (to && to !== value) n.nodeValue = n.nodeValue.replace(value, to);
    }
    document.querySelectorAll('[placeholder*="Claude Code"],[placeholder*="Codex"],[title*="Claude Code"],[title*="Codex"]').forEach(function (el) {
      ['placeholder', 'title'].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v) el.setAttribute(a, v.replace(/Claude Code/g, 'Claude').replace(/Codex( CLI)?/g, 'ChatGPT'));
      });
    });
  }


  // ---------- 文件栏：状态与切换都由 AionUi 管理 ----------
  function workspaceButton(button, collapsed) {
    button.classList.add('wp-workspace-toggle');
    button.setAttribute('aria-label', t(collapsed ? 'filesOpen' : 'filesClose'));
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    button.title = t(collapsed ? 'files' : 'filesHide');
  }
  // AionUi 在 Mac 上不渲染桌面展开/关闭按钮，补入口并发送原生按钮使用的同一个事件。
  function workspaceFallback(parent, collapsed) {
    var button = parent.querySelector(':scope > .wp-workspace-fallback');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'wp-workspace-fallback';
      button.addEventListener('click', function () {
        window.dispatchEvent(new CustomEvent('aionui-workspace-toggle', { cancelable: true }));
      });
      parent.appendChild(button);
    }
    workspaceButton(button, collapsed);
    return button;
  }
  function workspacePanel() {
    var desktop = document.querySelector('[data-explorer-column]');
    var mobile = document.querySelector('[data-explorer-mobile-overlay]');
    var panel = mobile || desktop;
    var collapsed = !!panel && panel.getAttribute('data-collapsed') === 'true';
    document.documentElement.classList.toggle('wp-workspace-collapsed', !!desktop && collapsed);
    var floating = document.querySelector('.workspace-toggle-floating[aria-label="Expand explorer"], .workspace-toggle-floating[aria-label="Collapse explorer"], .workspace-toggle-floating.wp-workspace-toggle');
    if (floating && panel) workspaceButton(floating, collapsed);
    var fallback = document.querySelector('body > .wp-workspace-fallback');
    if (desktop && collapsed && !floating) workspaceFallback(document.body, true);
    else if (fallback) fallback.remove();
    if (desktop) {
      var close = desktop.querySelector('.workspace-header__toggle');
      var extra = desktop.querySelector(':scope > .wp-workspace-fallback');
      if (close) workspaceButton(close, false);
      if (!collapsed && !close) workspaceFallback(desktop, false);
      else if (extra) extra.remove();
    }
    // 手机复用原生标题栏入口；明确标记避免误选反馈等其他按钮。
    if (mobile) {
      var trigger = document.querySelector('[data-wp-workspace-trigger]');
      if (trigger) {
        workspaceButton(trigger, collapsed);
        trigger.setAttribute('data-wp-label', t('files'));
      }
    }
  }


  // ---------- 左侧栏：与原来的工作伙伴一致 ----------
  // 品牌行（形象 + 工作伙伴 + 收起按钮）→ 新对话 → 搜索 → 自动化 → 最近对话（行尾相对时间）→ 左下角本人头像和姓名。
  // 桌面上不要顶部标题栏：收起按钮放在品牌行右侧，收起后左上角出现展开按钮；搜索调用 AionUi 自己的会话检索。
  var ICONS = {
    newChat: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5M8 10.5l-2.5.5.5-2.5 6-6a1.4 1.4 0 0 1 2 2l-6 6ZM11 3.5l2 2"/></svg>',
    search: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.6 10.6 14 14"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/></svg>',
    market: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 6h12l-1-4H3L2 6zM3 6v8h10V6M6 14v-4h4v4"/></svg>',
    panel: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/></svg>'
  };
  function titlebarButton(i) { return document.querySelectorAll('.app-titlebar__menu button.app-titlebar__button')[i]; }
  function navRow(key, icon, text, onClick) {
    var b = document.createElement('div');
    b.className = 'wp-nav-row'; b.dataset.wpNav = key; b.setAttribute('role', 'button'); b.tabIndex = 0;
    b.innerHTML = '<span class="wp-nav-icon">' + ICONS[icon] + '</span><span class="wp-nav-text"></span>';
    b.lastChild.textContent = text;
    b.addEventListener('click', onClick);
    b.addEventListener('keydown', function (e) { if (e.key === 'Enter') onClick(); });
    return b;
  }
  var me = null;
  fetch('/_wp/me', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.name) { me = j; schedule(); } }).catch(function () {});
  function ago(ms) {
    var m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    if (m < 1) return t('justNow');
    if (m < 60) return m + (locale() === 'en-US' ? 'm' : '分钟');
    if (m < 1440) return Math.floor(m / 60) + (locale() === 'en-US' ? 'h' : '小时');
    if (m < 43200) return Math.floor(m / 1440) + (locale() === 'en-US' ? 'd' : '天');
    return Math.floor(m / 43200) + (locale() === 'en-US' ? 'mo' : '个月');
  }
  function edgeFade(edge) {
    var scroll = null;
    var resize = null;
    function update() {
      if (!scroll) return;
      var distance = edge === 'top' ? scroll.scrollTop : scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
      var size = parseFloat(getComputedStyle(scroll).getPropertyValue('--wp-edge-fade-size'));
      var fade = Math.min(size, Math.max(0, distance)) + 'px';
      if (scroll.style.getPropertyValue('--wp-edge-fade') !== fade) scroll.style.setProperty('--wp-edge-fade', fade);
      if (edge === 'bottom') scroll.querySelectorAll('.sider-section-label,.workspace-collapse > .sticky').forEach(function (label) {
        var list = label.nextElementSibling;
        var header = label.getBoundingClientRect();
        var content = list && list.getBoundingClientRect();
        // 标题未固定时两者相邻；固定后差值是已经滚入标题下方的距离。
        var covered = header.height && content ? Math.min(header.bottom - content.top, content.bottom - header.bottom) : 0;
        var sectionFade = Math.min(size, Math.max(0, covered)) + 'px';
        if (label.style.getPropertyValue('--wp-section-fade') !== sectionFade) label.style.setProperty('--wp-section-fade', sectionFade);
      });
    }
    return function (next) {
      if (next !== scroll) {
        if (scroll) {
          scroll.removeEventListener('scroll', update);
          scroll.style.removeProperty('--wp-edge-fade');
          if (edge === 'bottom') scroll.querySelectorAll('.sider-section-label,.workspace-collapse > .sticky').forEach(function (label) {
            label.style.removeProperty('--wp-section-fade');
          });
        }
        if (resize) resize.disconnect();
        scroll = next;
        if (scroll) {
          if (!resize) resize = new ResizeObserver(update);
          scroll.addEventListener('scroll', update, { passive: true });
          resize.observe(scroll);
        }
      }
      update();
    };
  }
  var sidebarFade = edgeFade('bottom');
  var messageFade = edgeFade('top');
  function sidebar(aside) {
    sidebarFade(aside && aside.querySelector('[class*="_scrollArea"]'));
    document.documentElement.classList.toggle('wp-sider-collapsed', !!(aside && aside.classList.contains('collapsed')));
    if (!document.querySelector('.wp-sider-new')) {
      var create = document.createElement('button');
      create.type = 'button'; create.className = 'wp-sider-new'; create.innerHTML = ICONS.newChat;
      create.addEventListener('click', function () { location.hash = '#/guid'; });
      document.body.appendChild(create);
    }
    var create = document.querySelector('.wp-sider-new');
    create.setAttribute('aria-label', t('newChat')); create.title = t('newChat');
    if (!document.querySelector('.wp-sider-open')) {
      var open = document.createElement('button');
      open.type = 'button'; open.className = 'wp-sider-open'; open.setAttribute('aria-label', t('expand')); open.innerHTML = ICONS.panel;
      open.addEventListener('click', function () { var t = titlebarButton(0); if (t) t.click(); });
      document.body.appendChild(open);
    }
    if (!aside) return;
    var head = aside.querySelector('header.arco-layout-header');
    if (head && !head.querySelector('.wp-sider-toggle')) {
      var tg = document.createElement('button');
      tg.type = 'button'; tg.className = 'wp-sider-toggle'; tg.setAttribute('aria-label', t('collapse')); tg.innerHTML = ICONS.panel;
      tg.addEventListener('click', function () { var t = titlebarButton(0); if (t) t.click(); });
      head.appendChild(tg);
    }
    var trigger = aside.querySelector('[class*="_newChatTrigger"]');
    var newRow = trigger && trigger.parentElement;
    if (newRow && !aside.querySelector('.wp-nav')) {
      var nav = document.createElement('div');
      nav.className = 'wp-nav';
      nav.appendChild(navRow('search', 'search', t('search'), function () { var b = document.querySelector('.app-titlebar__menu button[aria-label="检索会话"],.app-titlebar__menu button[aria-label="Search messages"]') || document.querySelector('button.conversation-search-trigger-full'); if (b) b.click(); }));
      nav.appendChild(navRow('auto', 'clock', t('automation'), function () { location.hash = '#/scheduled'; }));
      nav.appendChild(navRow('market', 'market', t('market'), function () {
        location.hash = '#/market';
        if (document.querySelector('.app-titlebar--mobile') && aside.getBoundingClientRect().right > 0) {
          var toggle = titlebarButton(0); if (toggle) toggle.click();
        }
      }));
      newRow.parentNode.insertBefore(nav, newRow.nextSibling);
    }
    text(aside.querySelector('[data-wp-nav="search"] .wp-nav-text'), t('search'));
    text(aside.querySelector('[data-wp-nav="auto"] .wp-nav-text'), t('automation'));
    document.querySelector('.wp-sider-open').setAttribute('aria-label', t('expand'));
    if (head && head.querySelector('.wp-sider-toggle')) head.querySelector('.wp-sider-toggle').setAttribute('aria-label', t('collapse'));
    text(aside.querySelector('[data-wp-nav="market"] .wp-nav-text'), t('market'));
    var market = aside.querySelector('[data-wp-nav="market"]');
    if (market) {
      var current = location.hash === '#/market';
      market.classList.toggle('wp-active', current);
      if (current) market.setAttribute('aria-current', 'page'); else market.removeAttribute('aria-current');
    }
    var auto = aside.querySelector('[data-wp-nav="auto"]');
    if (auto) auto.classList.toggle('wp-active', /^#\/scheduled/.test(location.hash));
    // The outgoing list stays painted while React inserts/reorders rows; reveal the final list together.
    aside.querySelectorAll('.chat-history__item[id^="c-"]').forEach(function (row) {
      var c = convs[row.id.slice(2)];
      var t = row.querySelector(':scope > .wp-time');
      if (!c || !c.modified) { if (t) t.remove(); return; }
      if (!t) { t = document.createElement('span'); t.className = 'wp-time'; row.appendChild(t); }
      var v = ago(c.modified);
      if (t.textContent !== v) t.textContent = v;
    });
    // 左下角：本人头像和姓名
    var kids = aside.querySelector('.arco-layout-sider-children');
    if (kids && me) {
      var u = kids.querySelector(':scope > .wp-user');
      if (!u) {
        u = document.createElement('button'); u.type = 'button'; u.className = 'wp-user';
        u.setAttribute('aria-haspopup', 'menu'); u.setAttribute('aria-expanded', 'false');
        u.addEventListener('click', function (e) {
          e.stopPropagation();
          if (document.querySelector('.wp-settings-menu')) closeMenu(); else openSettings(u);
        });
        var av = document.createElement(me.avatar ? 'img' : 'span');
        av.className = 'wp-avatar';
        if (me.avatar) { av.src = me.avatar; av.alt = ''; av.referrerPolicy = 'no-referrer'; } else av.textContent = me.name.slice(-2);
        var nm = document.createElement('span'); nm.className = 'wp-user-name'; nm.textContent = me.name;
        u.appendChild(av); u.appendChild(nm); kids.appendChild(u);
      }
      u.setAttribute('aria-label', me.name + ' · ' + t('settings'));
    }
  }

  // ---------- 市场：原生路由只提供宿主，页签和内容由覆盖层维护 ----------
  var marketRenderers = new Map(), marketHost = null, marketTab = 'skills', marketLocale = null, marketDispose = null;
  function clearMarketContent() {
    if (marketDispose) { var dispose = marketDispose; marketDispose = null; dispose(); }
  }
  function renderMarketContent() {
    clearMarketContent();
    var content = marketHost.querySelector('.wp-market-content');
    content.replaceChildren();
    var entry = marketRenderers.get(marketTab);
    if (entry) {
      try { marketDispose = entry.render(content, { locale: locale() }) || null; }
      catch (error) { content.replaceChildren(); var failure = document.createElement('p'); failure.textContent = t('marketFailed'); content.appendChild(failure); console.error('Market content failed', error); }
    } else {
      var empty = document.createElement('p'); empty.className = 'wp-market-empty';
      empty.textContent = t(marketTab + 'Empty'); content.appendChild(empty);
    }
  }
  function updateMarket() {
    marketLocale = locale();
    text(marketHost.querySelector('h1'), t('market'));
    marketHost.querySelector('[role="tablist"]').setAttribute('aria-label', t('market'));
    marketHost.querySelectorAll('[role="tab"]').forEach(function (button) {
      var selected = button.dataset.tab === marketTab;
      text(button, t(button.dataset.tab));
      button.setAttribute('aria-selected', selected ? 'true' : 'false'); button.tabIndex = selected ? 0 : -1;
    });
    marketHost.querySelector('[role="tabpanel"]').setAttribute('aria-labelledby', 'wp-market-' + marketTab);
    renderMarketContent();
  }
  function marketPage() {
    var host = location.hash === '#/market' ? document.querySelector('[data-wp-market-host]') : null;
    if (host === marketHost) { if (host && marketLocale !== locale()) updateMarket(); return; }
    clearMarketContent(); marketHost = host;
    if (!host) return;
    marketTab = 'skills';
    host.className = 'wp-market';
    host.innerHTML = '<div class="wp-market-inner"><h1></h1><div class="wp-market-tabs" role="tablist"></div><div id="wp-market-content" class="wp-market-content" role="tabpanel" tabindex="0"></div></div>';
    var tabs = host.querySelector('[role="tablist"]');
    ['skills', 'tools'].forEach(function (tab, index, values) {
      var button = document.createElement('button'); button.type = 'button'; button.id = 'wp-market-' + tab;
      button.dataset.tab = tab; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'wp-market-content');
      button.addEventListener('click', function () { if (marketTab !== tab) { marketTab = tab; updateMarket(); } });
      button.addEventListener('keydown', function (event) {
        var next = event.key === 'ArrowRight' ? values[(index + 1) % 2] : event.key === 'ArrowLeft' ? values[(index + 1) % 2] : event.key === 'Home' ? 'skills' : event.key === 'End' ? 'tools' : null;
        if (!next) return;
        event.preventDefault(); marketTab = next; updateMarket(); host.querySelector('#wp-market-' + next).focus();
      });
      tabs.appendChild(button);
    });
    updateMarket();
  }
  /** Register a synchronous renderer for skills/tools; it may return cleanup. The returned disposer unregisters this renderer. */
  window.wpMarket = { tryExample: function (example) {
    location.hash = '#/guid';
    var timer, observer = new MutationObserver(fill);
    function fill() {
      var input = document.querySelector('[data-testid="guid-input"]');
      if (!input) return;
      observer.disconnect(); clearTimeout(timer);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, example);
      input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    }
    observer.observe(document.body, { subtree: true, childList: true });
    timer = setTimeout(function () { observer.disconnect(); }, 10000); fill();
  }, register: function (tab, render) {
    if (['skills', 'tools'].indexOf(tab) < 0 || typeof render !== 'function') throw new TypeError('Expected skills/tools and a renderer');
    var entry = { render: render };
    marketRenderers.set(tab, entry);
    if (marketHost && marketTab === tab) renderMarketContent();
    return function () {
      if (marketRenderers.get(tab) !== entry) return;
      marketRenderers.delete(tab);
      if (marketHost && marketTab === tab) renderMarketContent();
    };
  } };
  window.addEventListener('hashchange', function () { marketPage(); schedule(); });

  // ---------- 输入框下面的模型与推理强度 ----------
  // 首页：选择记在本浏览器（每个助手一份），新建对话时写进请求。对话页：读、改的都是这个对话正在用的值（AionUi 的对话配置接口），
  // 下一条消息就按新值发。标题栏右上角原来那个只读标签不再显示。
  function convId() { var m = /^#\/conversation\/([\w-]+)/.exec(location.hash); return m ? m[1] : null; }
  function api(method, url, body) {
    return rawFetch.call(window, url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok || j.success === false) throw new Error(j.error || r.status); return j.data || j; }); });
  }
  function option(list, id) { return (list || []).filter(function (o) { return o.id === id || o.category === id; })[0]; }
  function currentValue(o) { return o ? (o.current_value !== undefined ? o.current_value : o.currentValue) : null; }
  function values(o) { return o && o.options ? o.options.map(function (x) { return x.value; }) : null; }
  var asked = {}, busyPick = false;
  function ensure(id) {
    if (asked[id]) return; asked[id] = true;
    api('POST', '/api/conversations/' + id + '/runtime/ensure', {}).then(function (d) {
      if (d.config_options) { conv(id).options = d.config_options; schedule(); } else { conv(id).waiting = false; setTimeout(function () { asked[id] = false; schedule(); }, 5000); }
    }).catch(function () { conv(id).waiting = false; setTimeout(function () { asked[id] = false; schedule(); }, 5000); });
    if (!conv(id).backend) api('GET', '/api/conversations/' + id).then(function (d) { remember(d); schedule(); }).catch(function () {});
  }
  function pickerState() {
    var id = convId();
    if (id) {
      var c = conv(id);
      if (!c.options || !c.backend) {
        if (!c.waiting) { c.waiting = true; setTimeout(function () { c.waiting = false; if (convId() === id) ensure(id); }, 2500); }
        if (!c.backend) return null;
        // 引擎还在启动（对话久没打开、容器刚换过）、还没给出选项：先按新建对话时的值显示，选项到了再可选
        var cm = c.model || 'default';
        return { conv: id, backend: c.backend, model: cm, effort: c.effort || engineEffort[c.backend] || 'medium', models: modelsFor(c.backend, null, cm), efforts: effortsFor(null), pending: true };
      }
      var mo = option(c.options, 'model'), eo = option(c.options, 'reasoning_effort') || option(c.options, 'thought_level');
      // 对话里没改过的项，配置接口给的值为空：用新建时写进对话的值；再没有就是引擎自己的默认值
      // （Claude 设置文件、Codex config.toml，容器启动时读进 wp.effort）
      var model = currentValue(mo) || c.model || 'default';
      learnEfforts(c.backend, values(eo));
      return { conv: id, backend: c.backend, model: model, effort: currentValue(eo) || c.effort || engineEffort[c.backend] || 'medium', modelOpt: mo, effortOpt: eo,
        models: modelsFor(c.backend, values(mo), model), efforts: effortsFor(values(eo)) };
    }
    var sel = document.querySelector('[data-assistant-selected="true"]');
    var backend = (sel && sel.dataset.assistantBackend) || 'codex';
    var p = homePick(backend);
    return { backend: backend, model: p.model, effort: p.effort, models: modelsFor(backend, null, p.model), efforts: effortsFor(learnedEfforts(backend)) };
  }
  function pickerLabel(st) {
    return modelName(st.backend, st.model) + (st.effort ? '<span class="wp-pick-effort">' + effortName(st.effort) + '</span>' : '');
  }
  var menuOwner = null;
  function closeMenu() {
    var m = document.querySelector('.wp-pick-menu'); if (m) m.remove();
    if (menuOwner) menuOwner.setAttribute('aria-expanded', 'false');
    menuOwner = null;
  }
  function placeMenu(m, btn) {
    menuOwner = btn; btn.setAttribute('aria-expanded', 'true');
    var r = btn.getBoundingClientRect(), h = m.offsetHeight, w = m.offsetWidth;
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    var top = r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6;
    m.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
  }
  var settingsBusy = false, settingsChange = Promise.resolve();
  async function openSettings(btn) {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'wp-pick-menu wp-settings-menu'; m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', t('settings'));
    var status = document.createElement('div'); status.className = 'wp-settings-status'; status.setAttribute('role', 'status');
    function appendLogout() {
      var sep = document.createElement('div'); sep.className = 'wp-pick-sep'; m.appendChild(sep);
      var logout = document.createElement('button'); logout.type = 'button'; logout.className = 'wp-pick-item';
      logout.setAttribute('role', 'menuitem'); text(logout, t('logout'));
      logout.addEventListener('click', function (e) { e.stopPropagation(); location.assign('/_wp/logout'); });
      m.appendChild(logout);
    }
    appendLogout();
    text(status, t('loading')); m.appendChild(status); document.body.appendChild(m); placeMenu(m, btn);
    try {
      if (!window.wpSettings) throw new Error('Native settings adapter is unavailable');
      await window.wpSettings.ready;
    } catch (e) { if (m.isConnected) { text(status, t('loadFailed')); placeMenu(m, btn); } return; }
    var failedSave = false;
    if (settingsBusy) await settingsChange.catch(function () { failedSave = true; });
    if (!m.isConnected) return;
    status.remove();
    function render() {
      m.replaceChildren();
      m.setAttribute('aria-label', t('settings'));
      var current = window.wpSettings.get();
      function group(label, kind, items) {
        var h = document.createElement('div'); h.className = 'wp-pick-title'; text(h, t(label)); m.appendChild(h);
        items.forEach(function (item) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'wp-pick-item';
          b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', current[kind] === item[0] ? 'true' : 'false');
          b.dataset.setting = kind; b.dataset.value = item[0];
          b.innerHTML = '<span class="wp-pick-check" aria-hidden="true"></span><span></span>';
          text(b.firstChild, current[kind] === item[0] ? '✓' : ''); text(b.lastChild, item[1]);
          b.disabled = settingsBusy;
          b.addEventListener('click', async function (e) {
            e.stopPropagation(); if (settingsBusy) return;
            settingsBusy = true; render();
            settingsChange = window.wpSettings.set(kind, item[0]).finally(function () { settingsBusy = false; schedule(); });
            try {
              await settingsChange;
              if (m.isConnected) render();
            } catch (err) {
              if (m.isConnected) { render(); text(status, t('saveFailed')); m.appendChild(status); }
            } finally {
              if (m.isConnected) {
                m.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); placeMenu(m, btn);
                var selected = m.querySelector('[data-setting="' + kind + '"][data-value="' + item[0] + '"]'); if (selected) selected.focus();
              }
            }
          });
          m.appendChild(b);
        });
      }
      group('appearance', 'theme', [['system', t('system')], ['light', t('light')], ['dark', t('dark')]]);
      var sep = document.createElement('div'); sep.className = 'wp-pick-sep'; m.appendChild(sep);
      group('language', 'language', [['zh-CN', '简体中文'], ['en-US', 'English']]);
      appendLogout();
      placeMenu(m, btn);
    }
    render();
    if (failedSave) { text(status, t('saveFailed')); m.appendChild(status); placeMenu(m, btn); }
    var first = m.querySelector('[aria-checked="true"]') || m.querySelector('button'); if (first) first.focus();
  }
  function choose(st, kind, value, btn) {
    closeMenu();
    if (!st.conv) {
      var p = homeChosen(st.backend); p[kind] = value;
      try { localStorage.setItem('wp_pick2_' + st.backend, JSON.stringify(p)); } catch (e) {}
      schedule(); return;
    }
    var opt = kind === 'model' ? st.modelOpt : st.effortOpt;
    if (!opt || busyPick) return;
    busyPick = true; btn.classList.add('wp-busy');
    api('POST', '/api/conversations/' + st.conv + '/runtime/ensure', {})
      .then(function () { return api('PUT', '/api/conversations/' + st.conv + '/config-options/' + encodeURIComponent(opt.id), { value: value }); })
      .then(function (d) { if (d.config_options) conv(st.conv).options = d.config_options; btn.title = ''; })
      .catch(function () { btn.title = t('pickFailed'); btn.classList.add('wp-failed'); setTimeout(function () { btn.classList.remove('wp-failed'); }, 2000); })
      .then(function () { busyPick = false; btn.classList.remove('wp-busy'); schedule(); });
  }
  function openMenu(btn) {
    var st = pickerState(); if (!st) return;
    if (st.pending) { asked[st.conv] = false; ensure(st.conv); return; }
    closeMenu();
    var m = document.createElement('div');
    m.className = 'wp-pick-menu'; m.setAttribute('role', 'menu');
    var group = function (title, items, cur, kind) {
      var h = document.createElement('div'); h.className = 'wp-pick-title'; h.textContent = title; m.appendChild(h);
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.className = 'wp-pick-item';
        var on = it[0] === (kind === 'model' ? sameModel(st.backend, cur) : cur);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.innerHTML = '<span class="wp-pick-check" aria-hidden="true">' + (on ? '✓' : '') + '</span><span></span>';
        b.lastChild.textContent = it[1];
        b.addEventListener('click', function (e) { e.stopPropagation(); if (!on) choose(st, kind, it[2] || it[0], btn); else closeMenu(); });
        m.appendChild(b);
      });
    };
    group(t('model'), st.models.map(function (x) { return [x.id, x.name, x.value]; }), st.model, 'model');
    var sep = document.createElement('div'); sep.className = 'wp-pick-sep'; m.appendChild(sep);
    group(t('effort'), st.efforts, st.effort, 'effort');
    document.body.appendChild(m);
    placeMenu(m, btn);
  }
  document.addEventListener('click', function (e) {
    var m = document.querySelector('.wp-pick-menu');
    if (m && !m.contains(e.target) && !e.target.closest('.wp-pick-btn,.wp-user')) closeMenu();
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var owner = menuOwner; closeMenu(); if (owner && owner.isConnected) owner.focus(); } });
  window.addEventListener('resize', closeMenu);
  window.addEventListener('hashchange', closeMenu);
  function modelPicker() {
    var slot = document.querySelector('.sendbox-panel .sendbox-actions') || document.querySelector('[class*="_guidInputInner"] [class*="_actionSubmit"]');
    var panel = document.querySelector('.sendbox-panel');
    if (slot && panel) panel.querySelectorAll(':scope > .wp-pick-row').forEach(function (row) { row.remove(); });
    if (!slot && panel && panel.querySelector('.sendbox-tools-mobile-compact')) {   // 手机上对话页输入框是单行，选择放在下面一行
      slot = panel.querySelector(':scope > .wp-pick-row');
      if (!slot) { slot = document.createElement('div'); slot.className = 'wp-pick-row'; panel.appendChild(slot); }
    }
    if (!slot || slot.closest('.wp-transition-composer')) return;
    var btn = slot.querySelector(':scope > .wp-pick-btn');
    var st = pickerState();
    if (!st || !st.models.length) { if (btn) btn.style.display = 'none'; return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'wp-pick-btn'; btn.setAttribute('aria-haspopup', 'menu');
      btn.addEventListener('click', function (e) { e.stopPropagation(); if (document.querySelector('.wp-pick-menu')) closeMenu(); else openMenu(btn); });
      slot.insertBefore(btn, slot.firstChild);
    }
    btn.style.display = '';
    btn.classList.toggle('wp-pending', !!st.pending);
    var html = pickerLabel(st) + '<svg class="wp-pick-caret" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';
    if (btn.dataset.html !== html) { btn.dataset.html = html; btn.innerHTML = html; }
  }

  // ---------- 动态形象（原来工作伙伴的 logo 形象）----------
  // 首页“工作伙伴”标题左边 40px：跟随鼠标、点一下有反应（连点会晕）、待机东张西望、眨眼、输入时点头、两分钟不动就睡着。
  // 侧栏品牌行 22px：只眨眼和随对话状态变化（处理中、完成）。
  var petList = [], petState = 'idle', lastActivity = Date.now(), typingUntil = 0, wasBusy = false, doneUntil = 0;
  function mountPet(slot, hero) {
    if (!window.ZpPet || slot.querySelector('.zp-pet')) return;
    var host = document.createElement(hero ? 'button' : 'span');
    if (hero) { host.type = 'button'; host.setAttribute('aria-label', t('poke')); } else host.setAttribute('aria-hidden', 'true');
    var pet = new window.ZpPet(host, { size: hero ? 40 : 22, fx: hero, follow: hero, poke: hero });
    pet.set(petState);
    slot.appendChild(host);
    petList.push(pet);
  }
  function pets() {
    petList = petList.filter(function (p) { if (p.host.isConnected) return true; p.destroy(); return false; });
    var hero = document.querySelector('[class*="_heroHeader"]');
    if (hero && !hero.querySelector('.wp-hero')) {
      var box = document.createElement('div'); box.className = 'wp-hero';
      box.innerHTML = '<span class="wp-hero-mark"></span><span class="wp-hero-name"></span>';
      hero.appendChild(box);
    }
    if (hero) {
      text(hero.querySelector('.wp-hero-name'), t('brand'));
      mountPet(hero.querySelector('.wp-hero-mark'), true);
      var poke = hero.querySelector('.wp-hero-mark button'); if (poke) poke.setAttribute('aria-label', t('poke'));
    }
    var head = document.querySelector('aside.layout-sider header.arco-layout-header');
    var logo = head && (head.querySelector(':scope > .wp-logo') || head.firstElementChild);
    if (logo && !logo.classList.contains('wp-logo')) { logo.className = 'shrink-0 wp-logo'; logo.textContent = ''; }
    if (logo) mountPet(logo, false);
    var busy = !!document.querySelector('.sendbox-stop-button');
    if (wasBusy && !busy) doneUntil = Date.now() + 2000, setTimeout(schedule, 2100);
    wasBusy = busy;
    var input = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-testid="guid-input"],[data-testid="sendbox-input"]');
    var s = busy ? 'working' : Date.now() < doneUntil ? 'done' : Date.now() - lastActivity >= 120000 ? 'sleep'
      : (input && Date.now() < typingUntil) ? 'listening' : 'idle';
    petState = s;
    petList.forEach(function (p) { if (p.state !== s) p.set(s); });
  }
  function activity() {
    var asleep = petState === 'sleep';
    lastActivity = Date.now();
    clearTimeout(activity.t); activity.t = setTimeout(schedule, 120500);
    if (asleep) { petList.forEach(function (p) { p.wake(); }); schedule(); }
  }
  document.addEventListener('pointermove', function (e) { activity(); petList.forEach(function (p) { p.follow(e.clientX, e.clientY); }); }, { passive: true });
  document.addEventListener('pointerdown', activity, { passive: true });
  document.addEventListener('keydown', activity);
  document.addEventListener('input', function (e) {
    if (!e.target.matches || !e.target.matches('[data-testid="guid-input"],[data-testid="sendbox-input"]')) return;
    activity(); typingUntil = Date.now() + 1500;
    petList.forEach(function (p) { p.nod(); });
    setTimeout(schedule, 1600); schedule();
  });
  activity();

  var pending = false;
  function schedule() {
    if (pending) return; pending = true;
    requestAnimationFrame(function () { pending = false; apply(); });
  }
  new MutationObserver(function (records) {
    // 形象自己的动画（气泡、星星）不触发；属性只看首页换助手、左右栏收起
    if (records.some(function (r) {
      if (r.type === 'attributes') return r.attributeName === 'data-assistant-selected' || r.attributeName === 'data-collapsed' || r.target.classList.contains('layout-sider');
      return !(r.target.closest && r.target.closest('.zp-pet'));
    })) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-assistant-selected', 'data-collapsed', 'class'] });
  document.addEventListener('DOMContentLoaded', apply);
  setInterval(schedule, 60000);   // 相对时间每分钟刷新
})();
