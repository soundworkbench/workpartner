/* Web tools use the persisted completion output; old empty records stay empty. */
(() => {
  function object(value) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (error) { return null; }
    }
    return value && typeof value === 'object' ? value : null;
  }
  function text(value) { return typeof value === 'string' ? value.trim() : ''; }
  function url(value) {
    if (typeof value !== 'string') return '';
    try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''; }
    catch (error) { return ''; }
  }
  function describe(item) {
    const name = String(item.name || '').replace(/[^a-z]/gi, '').toLowerCase();
    if (!['websearch', 'searchweb', 'webfetch', 'openurl'].includes(name)) return null;
    const input = object(item.input) || {};
    const output = object(item.output);
    const completed = object(output?.wpWebSearch) || output || {};
    const action = object(completed.action) || object(input.action) || {};
    const query = [completed.query, action.query, ...(Array.isArray(action.queries) ? action.queries : []),
      input.query, ...(Array.isArray(input.queries) ? input.queries : [])].map(text).filter(Boolean);
    const fetch = ['webfetch', 'openurl'].includes(name) || ['openPage', 'open_page', 'findInPage', 'find_in_page'].includes(action.type);
    const detail = fetch ? text(completed.url || action.url || input.url) : [...new Set(query)].join(' · ');
    const sources = [], seen = new Set();
    function add(title, href) {
      const safe = url(href);
      if (!safe || seen.has(safe) || sources.length >= 5) return;
      seen.add(safe); sources.push({ title: text(title) || new URL(safe).hostname, url: safe });
    }
    // Codex results and Claude structured result blocks share title/url leaves.
    function collect(value) {
      value = object(value);
      if (!value) return;
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (value.url) add(value.title || value.name, value.url);
      for (const key of ['results', 'sources', 'links', 'content']) if (value[key]) collect(value[key]);
      if (typeof value.text === 'string') collectText(value.text);
    }
    function collectText(value) {
      // Claude WebSearch serializes its source list after "Links:".
      const links = value.match(/Links:\s*(\[[^\n]*\])/);
      if (links) collect(links[1]);
      for (const match of value.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) add(match[1], match[2]);
    }
    collect(completed); collect(input.results);
    if (typeof item.output === 'string') collectText(item.output);
    return { kind: fetch ? 'openWeb' : 'searchWeb', detail, sources, status: item.status };
  }
  function render(React, Badge, item, loadFull) {
    const view = describe(item);
    if (!view) return null;
    const copy = window.wpUI.copy;
    const status = { completed: 'success', error: 'error', running: 'processing' }[view.status] || 'default';
    return React.createElement('div', { className: 'wp-web-tool', 'data-status': view.status },
      React.createElement('div', { className: 'wp-web-tool-heading' },
        React.createElement(Badge, { status, className: view.status === 'running' ? 'badge-breathing' : '' }),
        React.createElement('span', null, copy(view.kind) + (view.detail ? (window.wpUI.isChinese() ? '：' : ': ') + view.detail : ''),
          view.status === 'error' && React.createElement('span', { className: 'wp-web-tool-error' }, ' ' + copy('webFailed')),
          view.status === 'canceled' && React.createElement('span', null, ' ' + copy('webCanceled')))),
      view.sources.length > 0 && React.createElement('ul', { className: 'wp-web-sources' },
        ...view.sources.map(source => React.createElement('li', { key: source.url },
          React.createElement('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.title)))),
      item.truncated && React.createElement('button', { type: 'button', onClick: loadFull }, copy('webMore')));
  }
  window.wpWebTools = { describe, render };
})();
