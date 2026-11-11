/** Gateway-only UI. Serialize code, never identities, policy lists or credentials. */
export function feedbackClient({ maxImageBytes = 5242880, maxImagesPerItem = 6 } = {}) {
  const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return `\n;(${installFeedback.toString()})(${JSON.stringify({ maxImageBytes: positive(maxImageBytes, 5242880), maxImagesPerItem: positive(maxImagesPerItem, 6) })});`;
}

function installFeedback({ maxImageBytes: maxBytes, maxImagesPerItem: maxImages }) {
  try {
    // Runs in <head>, before the main UI router. Match feedback.mjs /items/:id.
    const url = new URL(location.href), parameter = url.searchParams.get('wp-feedback');
    let autoOpen = false, initialId = '';
    if (parameter !== null) {
      const legacyHash = url.hash && !url.hash.startsWith('#/');
      const candidate = parameter === '1' && legacyHash ? url.hash.slice(1) : parameter;
      initialId = (parameter !== '1' || legacyHash) && /^[A-Za-z0-9_-]+$/.test(candidate) ? candidate : '';
      autoOpen = parameter === '1' || Boolean(initialId);
      url.searchParams.delete('wp-feedback');
      if (legacyHash) url.hash = '';
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }

    const API = '/_wp/api/feedback';
    // Same precedence and default as wp-overlay.js locale(), not document.lang.
    function locale() {
      let value = window.wpSettings ? window.wpSettings.get().language : null;
      if (!value) try { value = localStorage.getItem('i18nextLng'); } catch { /* Default to Chinese. */ }
      return value && /^en/i.test(value) ? 'en-US' : 'zh-CN';
    }
    const t = (zh, en) => locale() === 'en-US' ? en : zh;
    const date = value => new Date(value).toLocaleString(locale());
    const statusText = status => ({
      open: t('已提交', 'Submitted'), need_info: t('待补充', 'More information needed'),
      pending_approval: t('需求待审批', 'Awaiting approval'), in_progress: t('处理中', 'In progress'),
      done: t('已完成', 'Done'), rejected: t('不做', 'Declined'), duplicate: t('重复', 'Duplicate'),
    })[status] || status;
    const typeText = type => type === 'bug' ? t('问题', 'Issue') : t('新需求', 'Feature request');
    const node = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    let dialog, observer, previousFocus, revoked = false, all = false, currentId = '', detailVersion = 0, listVersion = 0;
    let draftBusy = false, detailBusy = false, pendingItem = null;
    const ui = {}, translations = [], detailDrafts = new Map();
    const draftFiles = [];
    const unexpected = () => {
      try { if (ui.message) ui.message.textContent = t('暂时无法处理，请稍后重试。', 'Unable to continue. Please try again.'); }
      catch { /* Even an unavailable settings adapter must stay isolated. */ }
    };
    // Event/observer/async failures must not escape into the existing client or overlay.
    const safe = fn => (...args) => { try { return Promise.resolve(fn(...args)).catch(unexpected); } catch { unexpected(); } };
    function translated(tag, zh, en, cls) {
      const n = node(tag, t(zh, en), cls); translations.push(() => { n.textContent = t(zh, en); }); return n;
    }
    function button(text, action, secondary = false) {
      const b = node('button', text, secondary ? 'wp-feedback-secondary' : '');
      b.type = 'button'; b.addEventListener('click', safe(action)); return b;
    }
    const message = () => { const n = node('p', '', 'wp-feedback-message'); n.setAttribute('role', 'status'); return n; };
    function badge(item) { return node('span', statusText(item.status), 'wp-feedback-badge'); }
    async function api(route = '', method = 'GET', body, raw = false) {
      const response = await fetch(API + route, { method, credentials: 'same-origin', cache: 'no-store',
        headers: method === 'POST' ? { 'content-type': raw ? 'application/octet-stream' : 'application/json' } : {},
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      let data; try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) {
        let error = data.error;
        // The unchanged API returns Chinese errors. Use local status guidance in English;
        // user-authored titles, descriptions and comments are always rendered verbatim.
        if (locale() === 'en-US' && (!error || /[\u3400-\u9fff]/.test(error))) error = ({
          400: 'Check your input: text is required, and screenshots must be PNG, JPEG or WebP within the displayed limits.',
          401: 'Please sign in to Workpartner again.', 403: 'Please reopen feedback from Workpartner and try again.',
          404: 'Feedback is unavailable. Please contact an administrator.',
          409: 'This feedback item has reached its comment limit.',
          413: 'The request is too large. Reduce the text or screenshot size.',
          429: 'The daily feedback or comment limit has been reached. Please try again tomorrow.',
          503: 'Unable to save feedback. Refresh to check what was saved before trying again.',
        })[response.status];
        if (!error) error = response.status === 401 || response.status === 404
          ? t('反馈不存在或暂未开放，请重新登录或联系管理员。', 'Feedback is unavailable. Please sign in again or contact an administrator.')
          : t('暂时无法处理，请稍后重试。', 'Unable to process this request. Please try again.');
        throw Object.assign(new Error(error), { status: response.status });
      }
      return data;
    }
    function removeEntry() {
      revoked = true; observer?.disconnect();
      document.querySelectorAll('[data-wp-feedback], [data-wp-feedback-separator]').forEach(n => n.remove());
    }
    function closeMenus() {
      document.querySelectorAll('.wp-pick-menu').forEach(n => n.remove());
      document.querySelectorAll('button.wp-user').forEach(n => n.setAttribute('aria-expanded', 'false'));
    }
    function menus() {
      if (revoked) return;
      document.querySelectorAll('.wp-settings-menu').forEach(menu => {
        let entry = menu.querySelector('[data-wp-feedback]');
        if (!entry) {
          const logout = menu.querySelector('[role="menuitem"]');
          const sep = node('div', undefined, 'wp-pick-sep'); sep.setAttribute('data-wp-feedback-separator', '');
          entry = button(t('反馈', 'Feedback'), () => { closeMenus(); return show(); });
          entry.className = 'wp-pick-item'; entry.setAttribute('role', 'menuitem'); entry.setAttribute('data-wp-feedback', '');
          entry.addEventListener('click', e => e.stopPropagation());
          menu.insertBefore(sep, logout); menu.insertBefore(entry, logout);
        }
        const label = t('反馈', 'Feedback'); if (entry.textContent !== label) entry.textContent = label;
        const avatar = document.querySelector('button.wp-user');
        if (!avatar) return;
        const rect = avatar.getBoundingClientRect();
        // Restrict height first, then measure: even a short viewport keeps the menu above the avatar.
        menu.style.maxHeight = Math.max(0, Math.min(rect.top - 14, window.innerHeight - 16)) + 'px';
        menu.style.overflowY = 'auto';
        const height = menu.offsetHeight, width = menu.offsetWidth;
        menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(rect.top - height - 6, window.innerHeight - height - 8)) + 'px';
      });
    }

    function styles() {
      const style = node('style');
      style.textContent = `
.wp-feedback-dialog { position:fixed; inset:0; margin:auto; box-sizing:border-box; width:min(800px, calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; padding:24px; border:1px solid var(--wp-line, #ddd); border-radius:18px; background:var(--wp-card, #FDFDF8); color:var(--wp-ink, #222); font:14px/1.65 var(--wp-font, system-ui); overflow-wrap:anywhere; }
.wp-feedback-dialog::backdrop { background:var(--wp-feedback-backdrop, rgba(0,0,0,.35)); }
.wp-feedback-dialog * { box-sizing:border-box; min-width:0; }
.wp-feedback-dialog [hidden] { display:none!important; }
.wp-feedback-dialog h2 { margin:0 32px 12px 0; font-size:18px; }
.wp-feedback-dialog h3 { margin:8px 0; font-size:16px; }
.wp-feedback-dialog section { border-top:1px solid var(--wp-line, #ddd); padding-top:16px; margin-top:16px; }
.wp-feedback-dialog label { display:block; margin:10px 0; }
.wp-feedback-dialog fieldset { border:0; padding:0; margin:0; }
.wp-feedback-dialog input, .wp-feedback-dialog textarea, .wp-feedback-dialog select { max-width:100%; color:var(--wp-ink, #222); font:inherit; }
.wp-feedback-dialog input[type=text], .wp-feedback-dialog textarea, .wp-feedback-dialog select { width:100%; display:block; border:1px solid var(--wp-line, #ddd); border-radius:8px; padding:8px 10px; background:var(--wp-main, #F2F2ED); }
.wp-feedback-dialog textarea { min-height:100px; resize:vertical; }
.wp-feedback-dialog input[type=file] { width:100%; }
.wp-feedback-dialog button { cursor:pointer; max-width:100%; border:1px solid var(--wp-line, #ddd); border-radius:8px; padding:6px 12px; background:var(--wp-send, #3C3F43); color:var(--wp-send-ink, #FCFCFC); font:inherit; overflow-wrap:anywhere; }
.wp-feedback-dialog button:hover { background:var(--wp-send-hover, #2E3237); }
.wp-feedback-dialog button:disabled { opacity:.5; cursor:wait; }
.wp-feedback-dialog .wp-feedback-secondary, .wp-feedback-dialog .wp-feedback-entry { background:var(--wp-hover, #eee); color:var(--wp-ink, #222); }
.wp-feedback-dialog .wp-feedback-secondary:hover, .wp-feedback-dialog .wp-feedback-entry:hover { background:var(--wp-active, #ddd); }
.wp-feedback-dialog :focus-visible { outline:2px solid var(--wp-focus-line, #888); outline-offset:2px; }
.wp-feedback-dialog .wp-feedback-close { position:absolute; right:12px; top:10px; padding:4px 8px; font-size:22px; }
.wp-feedback-dialog a { color:var(--wp-ink, #222); }
.wp-feedback-muted { color:var(--wp-ink-2, #666); }
.wp-feedback-message, .wp-feedback-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.wp-feedback-message { color:var(--wp-ink-2, #666); }
.wp-feedback-row { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.wp-feedback-list { display:grid; gap:10px; }
.wp-feedback-entry { width:100%; text-align:left; }
.wp-feedback-entry strong { display:block; }
.wp-feedback-badge { display:inline-block; padding:2px 8px; border-radius:12px; background:var(--wp-active, #eee); color:var(--wp-ink-2, #666); font-size:13px; }
.wp-feedback-thumbs { display:flex; flex-wrap:wrap; gap:12px; margin:12px 0; }
.wp-feedback-thumb { width:120px; overflow-wrap:anywhere; }
.wp-feedback-thumb img { width:120px; height:90px; object-fit:contain; border:1px solid var(--wp-line, #ddd); border-radius:6px; }
.wp-feedback-thumb button { width:100%; }
.wp-feedback-images img { max-width:100%; max-height:220px; object-fit:contain; }
.wp-feedback-images a { display:inline-block; max-width:100%; margin:4px; }
.wp-feedback-comment { border-top:1px solid var(--wp-line, #ddd); padding-top:10px; margin-top:10px; }
@media(max-width:400px) { .wp-feedback-dialog { padding:16px; } }
`;
      document.head.append(style);
    }

    // The queue keeps accepted files on failure and removes each only after a successful upload.
    function fileQueue(files, storedCount, busy, msg) {
      const label = node('label'), caption = node('span'); label.append(caption);
      const input = node('input'), thumbs = node('div', undefined, 'wp-feedback-thumbs');
      input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.multiple = true; label.append(input);
      const hint = node('p', '', 'wp-feedback-muted');
      let urls = [];
      function dispose() { urls.forEach(url => URL.revokeObjectURL(url)); urls = []; }
      function render() {
        caption.textContent = t('截图（PNG / JPEG / WebP）', 'Screenshots (PNG / JPEG / WebP)');
        hint.textContent = t(`可粘贴截图；每张最多 ${maxBytes} 字节，每条最多 ${maxImages} 张。`,
          `Paste screenshots here; up to ${maxBytes} bytes each and ${maxImages} per feedback item.`);
        dispose(); thumbs.replaceChildren(); input.disabled = busy() || storedCount() + files.length >= maxImages;
        files.forEach((file, index) => {
          const box = node('div', undefined, 'wp-feedback-thumb'), img = node('img');
          img.src = URL.createObjectURL(file); urls.push(img.src); img.alt = file.name || t('待上传截图', 'Pending screenshot');
          const remove = button(t('删除', 'Remove'), () => { if (busy()) return; files.splice(index, 1); render(); });
          remove.disabled = busy(); box.append(img, remove); thumbs.append(box);
        });
      }
      function select(selected) {
        if (busy()) return;
        try {
          for (const file of selected) {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(t('截图只支持 PNG、JPEG 或 WebP 图片。', 'Only PNG, JPEG and WebP screenshots are supported.'));
            if (file.size > maxBytes) throw new Error(t(`截图过大，每张最多 ${maxBytes} 字节。`, `Screenshot too large; maximum ${maxBytes} bytes per image.`));
            if (files.length + storedCount() >= maxImages) throw new Error(t(`每条反馈最多上传 ${maxImages} 张截图。`, `Maximum ${maxImages} screenshots per feedback item.`));
            files.push(file);
          }
          msg.textContent = '';
        } catch (error) { msg.textContent = error.message; }
        render();
      }
      input.addEventListener('change', safe(() => { select([...input.files]); input.value = ''; }));
      const paste = safe(event => {
        const selected = [...(event.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
        if (selected.length) { event.preventDefault(); select(selected); }
      });
      render(); return { label, hint, thumbs, render, paste, dispose };
    }
    let draftQueue, detailQueue;
    function mount() {
      if (dialog) return;
      styles(); dialog = node('dialog', undefined, 'wp-feedback-dialog'); dialog.setAttribute('aria-labelledby', 'wp-feedback-heading');
      const title = translated('h2', '反馈', 'Feedback'); title.id = 'wp-feedback-heading';
      const close = button('×', () => dialog.close(), true); close.className += ' wp-feedback-close';
      translations.push(() => close.setAttribute('aria-label', t('关闭', 'Close')));
      const introduction = translated('p', '遇到问题，或有新的需求？告诉我们，也可以在这里查看进展、补充信息。',
        'Report an issue or request a feature, check progress and add information.', 'wp-feedback-muted');
      const draft = node('section'), form = node('form'); ui.form = form;
      draft.append(translated('h3', '提交反馈', 'Submit feedback'), form);
      const fields = node('fieldset'); ui.fields = fields;
      const typeLabel = node('label'), type = node('select'); ui.type = type;
      typeLabel.append(translated('span', '反馈类型', 'Feedback type'));
      for (const [value, zh, en] of [['bug', '问题', 'Issue'], ['feature', '新需求', 'Feature request']]) {
        const option = translated('option', zh, en); option.value = value; type.append(option);
      }
      type.value = 'bug'; typeLabel.append(type);
      function field(key, tag, zh, en, max) {
        const label = node('label'), caption = translated('span', zh, en), input = node(tag);
        input.id = 'wp-feedback-' + key; input.maxLength = max; input.required = true; if (tag === 'input') input.type = 'text';
        label.append(caption, input); ui[key] = input; return label;
      }
      fields.append(typeLabel, field('title', 'input', '标题', 'Title', 120), field('body', 'textarea', '描述', 'Description', 8000));
      ui.submitMessage = message();
      draftQueue = fileQueue(draftFiles, () => pendingItem?.files.length || 0, () => draftBusy, ui.submitMessage);
      ui.submit = node('button', t('提交反馈', 'Submit feedback')); ui.submit.type = 'submit';
      form.append(fields, draftQueue.label, draftQueue.hint, draftQueue.thumbs, ui.submit, ui.submitMessage);
      form.addEventListener('paste', draftQueue.paste); form.addEventListener('submit', safe(submit));
      const listSection = node('section'), row = node('div', undefined, 'wp-feedback-row');
      ui.listTitle = node('h3'); ui.scope = button('', () => { if (detailBusy) return; all = !all; return list(); }, true); ui.scope.hidden = true;
      ui.refresh = button('', async () => { if (detailBusy) return; if (await list()) await openDetail(currentId); }, true);
      translations.push(() => { ui.refresh.textContent = t('刷新', 'Refresh'); });
      row.append(ui.listTitle, ui.scope, ui.refresh); ui.list = node('div', undefined, 'wp-feedback-list'); ui.message = message();
      listSection.append(row, ui.list, ui.message); ui.detail = node('section'); ui.detail.id = 'wp-feedback-detail'; ui.detail.hidden = true;
      dialog.append(title, close, introduction, draft, listSection, ui.detail); document.body.append(dialog);
      dialog.addEventListener('click', safe(event => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
      }));
      // Native dialog handles Escape. Closing never resets drafts or changes the main UI route.
      dialog.addEventListener('close', safe(() => { if (previousFocus?.isConnected) previousFocus.focus(); }));
    }
    function controls() {
      ui.submit.disabled = draftBusy; ui.fields.disabled = draftBusy || Boolean(pendingItem);
      ui.submit.textContent = pendingItem ? t('重试上传截图', 'Retry screenshot upload') : t('提交反馈', 'Submit feedback');
      ui.refresh.disabled = detailBusy; ui.scope.disabled = detailBusy; draftQueue.render();
    }
    async function list() {
      const version = ++listVersion;
      try {
        const data = await api(all ? '?scope=all' : '');
        if (version !== listVersion || revoked) return false;
        ui.scope.hidden = !data.isHandler; ui.listTitle.textContent = all ? t('全部反馈', 'All feedback') : t('我的反馈', 'My feedback');
        ui.scope.textContent = all ? t('我的反馈', 'My feedback') : t('全部反馈', 'All feedback');
        ui.list.replaceChildren();
        if (!data.items.length) ui.list.append(node('p', t('还没有反馈。', 'No feedback yet.'), 'wp-feedback-muted'));
        data.items.forEach(item => {
          const entry = button('', async () => { if (detailBusy) return; await openDetail(item.id); ui.detail.scrollIntoView({ block: 'nearest' }); });
          entry.className = 'wp-feedback-entry';
          entry.append(node('strong', '#' + item.no + ' · ' + typeText(item.type) + ' · ' + item.title), badge(item),
            node('div', t('更新于 ', 'Updated ') + date(item.updatedAt), 'wp-feedback-muted'));
          ui.list.append(entry);
        });
        ui.message.textContent = ''; return true;
      } catch (error) {
        if (version !== listVersion || revoked) return false;
        ui.message.textContent = error.message;
        if (error.status === 401 || error.status === 404) {
          removeEntry(); window.alert(error.message); dialog.close();
        }
        return false;
      }
    }
    async function show(key = currentId) {
      if (revoked) return;
      closeMenus(); mount(); translations.forEach(update => update()); controls();
      if (!dialog.open) { previousFocus = document.querySelector('button.wp-user') || document.activeElement; dialog.showModal(); }
      if (await list()) await openDetail(key);
    }
    async function submit(event) {
      event.preventDefault(); if (draftBusy || revoked) return;
      draftBusy = true; controls(); ui.submitMessage.textContent = t('正在提交…', 'Submitting…');
      try {
        if (!pendingItem) pendingItem = (await api('', 'POST', { type: ui.type.value, title: ui.title.value, body: ui.body.value })).item;
        while (draftFiles.length) {
          const file = draftFiles[0];
          pendingItem = (await api('/items/' + pendingItem.id + '/files?filename=' + encodeURIComponent(file.name), 'POST', file, true)).item;
          draftFiles.shift(); draftQueue.render();
        }
        const key = pendingItem.id; pendingItem = null;
        ui.title.value = ''; ui.body.value = ''; ui.type.value = 'bug';
        ui.submitMessage.textContent = t('提交成功。', 'Feedback submitted.');
        await openDetail(key);
      } catch (error) {
        ui.submitMessage.textContent = (pendingItem ? t(`反馈 #${pendingItem.no} 已保存；截图未全部上传，可删除或重试。`,
          `Feedback #${pendingItem.no} was saved. Some screenshots remain; remove them or retry. `) : '') + error.message;
      } finally { draftBusy = false; controls(); await list(); }
    }
    async function openDetail(key) {
      if (detailBusy || revoked) return;
      currentId = key; const version = ++detailVersion, section = ui.detail;
      if (!key) { section.hidden = true; return; }
      section.hidden = false;
      // Keep the existing editor until a read succeeds; failed refreshes must not erase input.
      try {
        const data = await api('/items/' + encodeURIComponent(key));
        if (version !== detailVersion || revoked) return;
        const item = data.item;
        detailQueue?.dispose(); section.onpaste = null;
        section.replaceChildren(node('h3', '#' + item.no + ' · ' + typeText(item.type) + ' · ' + item.title), badge(item),
          node('p', item.author.name + ' · ' + date(item.createdAt), 'wp-feedback-muted'), node('p', item.body, 'wp-feedback-text'));
        if (item.typeChangedFrom) section.append(node('p', t('此反馈已从问题调整为需求。', 'This issue was changed to a feature request.'), 'wp-feedback-muted'));
        if (item.approval.state !== 'none') {
          const labels = { pending: t('待审批', 'Awaiting approval'), approved: t('已批准', 'Approved'), rejected: t('未批准', 'Not approved') };
          section.append(node('p', (labels[item.approval.state] || item.approval.state) + (item.approval.note ? ': ' + item.approval.note : ''), 'wp-feedback-text'));
        }
        if (item.pr) {
          const link = new URL(item.pr);
          if (link.protocol === 'https:' && !link.username && !link.password) {
            const a = node('a', t('查看 PR', 'View PR')); a.href = link.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; section.append(a);
          }
        }
        const images = node('div', undefined, 'wp-feedback-images');
        function showImages(files) {
          images.replaceChildren(); files.forEach(file => {
            const a = node('a'), img = node('img'); a.href = API + '/items/' + encodeURIComponent(item.id) + '/files/' + encodeURIComponent(file.id);
            a.target = '_blank'; a.rel = 'noopener noreferrer'; img.src = a.href; img.alt = file.name; img.loading = 'lazy'; a.append(img); images.append(a);
          });
        }
        showImages(item.files); section.append(images);
        if (!detailDrafts.has(key)) detailDrafts.set(key, { files: [], comment: '' });
        const draft = detailDrafts.get(key);
        if (data.canUpload) {
          const msg = message(); let stored = item.files;
          const queue = fileQueue(draft.files, () => stored.length, () => detailBusy, msg); detailQueue = queue;
          const upload = button(t('上传截图', 'Upload screenshots'), async () => {
            if (detailBusy || !draft.files.length) return;
            detailBusy = true; ++detailVersion; upload.disabled = true; controls(); queue.render(); msg.textContent = t('正在上传…', 'Uploading…');
            try {
              while (draft.files.length) {
                const file = draft.files[0];
                const result = await api('/items/' + item.id + '/files?filename=' + encodeURIComponent(file.name), 'POST', file, true);
                stored = result.item.files; draft.files.shift(); showImages(stored); queue.render();
              }
              msg.textContent = t('截图已上传。', 'Screenshots uploaded.');
            } catch (error) { msg.textContent = error.message + t(' 已上传的截图已保存；可删除待传截图后重试。', ' Uploaded screenshots were saved. Remove pending files or retry.'); }
            finally { detailBusy = false; upload.disabled = false; controls(); queue.render(); await list(); }
          });
          section.append(queue.label, queue.hint, queue.thumbs, upload, msg); section.onpaste = queue.paste;
        }
        section.append(node('h3', t('评论', 'Comments')));
        if (!item.comments.length) section.append(node('p', t('暂无评论。', 'No comments yet.'), 'wp-feedback-muted'));
        item.comments.forEach(comment => {
          const box = node('div', undefined, 'wp-feedback-comment');
          box.append(node('div', comment.by.name + ' · ' + date(comment.at), 'wp-feedback-muted'), node('p', comment.text, 'wp-feedback-text')); section.append(box);
        });
        const form = node('form'), label = node('label', t('追加评论', 'Add a comment')), area = node('textarea');
        const send = node('button', t('发送评论', 'Send comment')), msg = message(); send.type = 'submit';
        area.maxLength = 4000; area.required = true; area.value = draft.comment;
        area.addEventListener('input', safe(() => { draft.comment = area.value; })); label.append(area); form.append(label, send, msg);
        form.addEventListener('submit', safe(async event => {
          event.preventDefault(); if (detailBusy) return;
          detailBusy = true; ++detailVersion; send.disabled = true; area.disabled = true; controls(); draft.comment = area.value;
          let saved = false;
          try { await api('/items/' + item.id + '/comments', 'POST', { text: area.value }); draft.comment = ''; area.value = ''; saved = true; }
          catch (error) { msg.textContent = error.message; }
          finally { detailBusy = false; send.disabled = false; area.disabled = false; controls(); }
          if (saved) { if (await list()) await openDetail(key); }
        }));
        section.append(form);
      } catch (error) { if (version === detailVersion) ui.message.textContent = error.message; }
    }
    const init = safe(() => {
      observer = new MutationObserver(safe(menus)); observer.observe(document.body, { childList: true, subtree: true }); menus();
      if (autoOpen) return show(initialId);
    });
    window.addEventListener('pagehide', safe(() => { draftQueue?.dispose(); detailQueue?.dispose(); }));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  } catch { /* Feedback is optional: never break the preview client or the main UI. */ }
}
