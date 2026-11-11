// One Tools host: data sources can contribute categories and a quota header without replacing MCP.
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
    var zh = context.locale === 'zh-CN', disposed = false, revision = 0, cleanups = [], selected = null;
    var controller = new AbortController();
    var top = element('div', 'wp-tools-headers'), tabs = element('div', 'wp-tools-categories'), content = element('div', 'wp-tools-body');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', zh ? '工具分类' : 'Tool categories');
    content.id = 'wp-tools-category-content'; content.setAttribute('role', 'tabpanel');
    host.append(top, tabs, content);
    function clear() { cleanups.splice(0).forEach(function (cleanup) { cleanup(); }); }
    function display(groups) {
      tabs.replaceChildren(); content.replaceChildren();
      if (!groups.length) { content.append(element('p', 'wp-market-empty', zh ? '尚未启用工具' : 'Tools are not enabled')); return; }
      if (!groups.some(function (group) { return group.id === selected; })) selected = groups[0].id;
      groups.forEach(function (group, index) {
        var button = element('button', '', group.label); button.type = 'button'; button.id = 'wp-tools-category-' + index;
        button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', content.id);
        button.setAttribute('aria-selected', String(group.id === selected)); button.tabIndex = group.id === selected ? 0 : -1;
        function activate() {
          selected = group.id;
          var old = content._dispose; if (old) old(); content._dispose = null;
          display(groups); tabs.children[index].focus();
        }
        button.addEventListener('click', activate);
        button.addEventListener('keydown', function (event) {
          var next = event.key === 'ArrowRight' ? (index + 1) % groups.length : event.key === 'ArrowLeft' ? (index + groups.length - 1) % groups.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : -1;
          if (next < 0) return; event.preventDefault(); tabs.children[next].click();
        });
        tabs.append(button);
        if (group.id === selected) {
          content.setAttribute('aria-labelledby', button.id);
          content._dispose = group.render(content) || null;
        }
      });
    }
    async function load() {
      var current = ++revision; clear();
      if (content._dispose) content._dispose(); content._dispose = null;
      top.replaceChildren(); tabs.replaceChildren(); content.replaceChildren(element('p', 'wp-skills-status', zh ? '正在加载工具…' : 'Loading tools…'));
      var results = await Promise.allSettled(sources.map(function (source) { return source({ locale: context.locale, signal: controller.signal }); }));
      if (disposed || current !== revision) return;
      var groups = [];
      results.forEach(function (result) {
        if (result.status === 'fulfilled') {
          groups = groups.concat(result.value.categories || []);
          if (result.value.renderHeader) { var cleanup = result.value.renderHeader(top); if (cleanup) cleanups.push(cleanup); }
        } else {
          groups.push({ id: 'unavailable-' + groups.length, label: zh ? '工具' : 'Tools', render: function (panel) {
            panel.append(element('p', 'wp-skills-status', zh ? '工具暂时无法加载。' : 'Tools could not be loaded.'));
            var retry = element('button', 'wp-skills-retry', zh ? '重试' : 'Retry'); retry.type = 'button'; retry.addEventListener('click', load); panel.append(retry);
          } });
        }
      });
      display(groups);
    }
    refresh = load; void load();
    return function () { disposed = true; revision++; controller.abort(); clear(); if (content._dispose) content._dispose(); if (refresh === load) refresh = null; };
  });
  window.wpMarketTools.registerSource(async function (context) {
    var response = await fetch('/_wp/market/tools', { signal: context.signal });
    if (!response.ok) throw new Error('Tools unavailable');
    var data = await response.json(), language = context.locale === 'zh-CN' ? 'zh' : 'en';
    return { categories: data.tools.length ? [{ id: 'mcp', label: 'MCP', render: function (host) {
      var cards = element('div', 'wp-skills-list');
      data.tools.forEach(function (tool) {
        var card = element('article', 'wp-skill-card'); card.dataset.tool = tool.name;
        card.append(element('h3', 'wp-skill-name', tool.title[language]), element('p', 'wp-skill-description wp-mcp-description', tool.description[language])); cards.append(card);
      });
      host.append(cards);
    } }] : [] };
  });
})();
