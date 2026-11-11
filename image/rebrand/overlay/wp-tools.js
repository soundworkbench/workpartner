// A single category/filter/card renderer for all organization tool sources.
(function () {
  'use strict';
  var sources = [], refresh = null;
  window.wpMarketTools = { registerSource: function (load) {
    sources.push(load); if (refresh) refresh();
    return function () { sources = sources.filter(function (source) { return source !== load; }); if (refresh) refresh(); };
  } };
  function element(tag, className, value) {
    var node = document.createElement(tag); node.className = className;
    if (value !== undefined) node.textContent = value; return node;
  }
  window.wpMarket.register('tools', function (host, context) {
    var zh = context.locale === 'zh-CN', language = zh ? 'zh' : 'en';
    var copy = zh ? { loading: '正在加载工具…', empty: '暂无可用工具', failed: '工具暂时无法加载，请重试。', retry: '刷新列表', all: '全部', more: '查看更多', included: '已包含', tryIt: '试一试' }
      : { loading: 'Loading tools…', empty: 'No tools available', failed: 'Tools could not be loaded. Please retry.', retry: 'Refresh list', all: 'All', more: 'Show more', included: 'Included', tryIt: 'Try it' };
    var disposed = false, revision = 0, cardRevision = 0, cleanups = [], selected = '', platformId = '', groups = [], tools = [], visible = 0;
    var controller = new AbortController();
    var top = element('div', 'wp-tools-headers'), categories = element('nav', 'wp-data-categories'), platforms = element('div', 'wp-data-platforms');
    categories.setAttribute('aria-label', zh ? '工具分类' : 'Tool categories');
    var status = element('p', 'wp-skills-status'), retry = element('button', 'wp-skills-retry', copy.retry);
    status.setAttribute('role', 'status'); retry.type = 'button'; retry.hidden = true;
    var cards = element('div', 'wp-skills-list wp-data-cards'), more = element('button', 'wp-skills-retry wp-data-more', copy.more);
    more.type = 'button'; more.hidden = true; host.append(top, categories, platforms, status, retry, cards, more);
    function choice(parent, label, active, action) {
      var button = element('button', '', label); button.type = 'button'; button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', action);
      button.addEventListener('keydown', function (event) {
        var buttons = Array.from(parent.children), index = buttons.indexOf(button);
        var next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next < 0) return; event.preventDefault(); buttons[next].click(); parent.children[next].focus();
      });
      parent.append(button);
    }
    function renderFilters() {
      categories.replaceChildren(); platforms.replaceChildren();
      groups.forEach(function (group) {
        choice(categories, group.name[language], group.id === selected, function () { selected = group.id; platformId = ''; renderFilters(); void loadCards(); });
      });
      var group = groups.find(function (row) { return row.id === selected; });
      if (!group) return;
      choice(platforms, copy.all, !platformId, function () { platformId = ''; renderFilters(); void loadCards(); });
      group.platforms.forEach(function (platform) {
        choice(platforms, platform.name[language], platform.id === platformId, function () { platformId = platform.id; renderFilters(); void loadCards(); });
      });
    }
    // Cards without an organization example get a draft built from their own title and description.
    function starter(tool) {
      var title = tool.title[language], summary = (tool.description[language] || '').trim().replace(/[。.]+$/, '');
      if (zh) return '用「' + title + '」' + (summary ? '帮我' + summary : '');
      if (/^[A-Z][a-z]/.test(summary)) summary = summary[0].toLowerCase() + summary.slice(1);
      return 'Use “' + title + '”' + (summary ? ' to ' + summary : '');
    }
    function appendCards() {
      tools.slice(visible, visible + 12).forEach(function (tool) {
        var card = element('article', 'wp-skill-card wp-data-card'); card.dataset.tool = tool.name;
        var heading = element('div', 'wp-data-top'); heading.append(element('h3', 'wp-skill-name', tool.title[language]), element('span', 'wp-data-chip', tool.platform.name[language]));
        heading.lastChild.title = tool.platform.name[language];
        var description = element('p', 'wp-skill-description', tool.description[language]); description.title = tool.description[language];
        var footer = element('div', 'wp-data-foot'); footer.append(element('span', 'wp-data-price', tool.included ? copy.included : tool.priceLabel));
        var button = element('button', 'wp-skill-action', copy.tryIt), prompt = tool.example ? tool.example[language] : starter(tool); button.type = 'button';
        button.addEventListener('click', function () { window.wpMarket.tryExample(prompt); }); footer.append(button);
        card.append(heading, description, footer); cards.append(card);
      });
      visible += 12; more.hidden = visible >= tools.length;
    }
    async function loadCards() {
      var current = ++cardRevision, group = groups.find(function (row) { return row.id === selected; });
      cards.replaceChildren(); more.hidden = true; retry.hidden = true; status.textContent = copy.loading;
      if (!group) { status.textContent = copy.empty; return; }
      var results = await Promise.allSettled(group.entries.map(function (entry) { return entry.loadTools(platformId); }));
      if (disposed || current !== cardRevision) return;
      tools = results.filter(function (result) { return result.status === 'fulfilled'; }).flatMap(function (result) { return result.value; });
      var failed = results.some(function (result) { return result.status === 'rejected'; });
      status.textContent = failed ? copy.failed : tools.length ? '' : copy.empty; retry.hidden = !failed;
      visible = 0; appendCards();
    }
    async function load() {
      var current = ++revision; ++cardRevision;
      cleanups.splice(0).forEach(function (cleanup) { cleanup(); });
      top.replaceChildren(); categories.replaceChildren(); platforms.replaceChildren(); cards.replaceChildren();
      retry.hidden = true; more.hidden = true; status.textContent = copy.loading;
      var results = await Promise.allSettled(sources.map(function (source) { return source({ locale: context.locale, signal: controller.signal }); }));
      if (disposed || current !== revision) return;
      var combined = new Map(), failed = false;
      results.forEach(function (result) {
        if (result.status === 'rejected') { failed = true; return; }
        result.value.categories.forEach(function (entry) {
          var group = combined.get(entry.id);
          if (!group) { group = { id: entry.id, name: entry.name, platforms: [], entries: [] }; combined.set(entry.id, group); }
          group.entries.push(entry);
          entry.platforms.forEach(function (platform) { if (!group.platforms.some(function (row) { return row.id === platform.id; })) group.platforms.push(platform); });
        });
        if (result.value.renderHeader) { var cleanup = result.value.renderHeader(top); if (cleanup) cleanups.push(cleanup); }
      });
      groups = Array.from(combined.values());
      if (failed) {
        // Unknown source failures stay inside the neutral fallback category's content area.
        var fallback = { id: 'Tools', name: { zh: '工具', en: 'Tools' }, platforms: [], loadTools: function () { return Promise.reject(new Error('Tools unavailable')); } };
        var group = combined.get(fallback.id);
        if (group) group.entries.push(fallback); else groups.push(Object.assign({}, fallback, { entries: [fallback] }));
      }
      if (!groups.some(function (group) { return group.id === selected; })) selected = groups.length ? groups[0].id : '';
      if (!groups.some(function (group) { return group.id === selected && group.platforms.some(function (platform) { return platform.id === platformId; }); })) platformId = '';
      renderFilters(); await loadCards();
    }
    retry.addEventListener('click', function () { void load(); }); more.addEventListener('click', appendCards);
    refresh = load; void load();
    return function () { disposed = true; revision++; cardRevision++; controller.abort(); cleanups.splice(0).forEach(function (cleanup) { cleanup(); }); if (refresh === load) refresh = null; };
  });
})();
