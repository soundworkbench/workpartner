// Live organization categories, platforms and endpoint cards share the skills example action.
(function () {
  'use strict';
  var COPY = {
    'zh-CN': { loading: '正在加载工具…', empty: '暂无可用接口', failed: '工具暂时无法加载，请重试。', retry: '刷新列表', all: '全部', tryIt: '试一试', more: '查看更多', price: '价格暂不可用，请先查看接口报价', usageFailed: '本人额度暂时无法读取。', usageRetry: '刷新本人额度', daily: '今天剩余', monthly: '本月剩余', usd: '美元', cap: '单次最多', dayReset: '今天额度已用完，北京时间 08:00 恢复', monthReset: '本月额度已用完，北京时间下月 1 日 08:00 恢复', paused: '单次额度为零，请联系管理员' },
    'en-US': { loading: 'Loading tools…', empty: 'No endpoints available', failed: 'Tools could not be loaded. Please retry.', retry: 'Refresh list', all: 'All', tryIt: 'Try it', more: 'Show more', price: 'Price unavailable; check the endpoint quote first', usageFailed: 'Your data usage could not be loaded.', usageRetry: 'Refresh my usage', daily: 'Remaining today', monthly: 'Remaining this month', usd: 'USD', cap: 'Per-call limit', dayReset: 'Daily budget used up; resets at 08:00 Beijing time', monthReset: 'Monthly budget used up; resets at 08:00 Beijing time on the first of next month', paused: 'Per-call budget is zero; contact the administrator' }
  };
  window.wpMarket.register('tools', function (host, context) {
    var copy = COPY[context.locale] || COPY['zh-CN'], language = context.locale === 'zh-CN' ? 'zh' : 'en';
    var controller = new AbortController(), disposed = false;
    function element(tag, className, text) { var node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
    function money(value) { return value > 0 && value < 0.01 ? '<0.01' : Number(value).toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function priceText(price) {
      if (!price) return copy.price;
      var zh = language === 'zh', amount = price.usd === 0 ? '0' : money(price.usd), unit = ({ keyword: '词', word: '词', result: '条', record: '条', row: '条', item: '条', page: '页', call: '次', post: '帖', user: '人', domain: '域名', ad: '广告', target: '目标', index_item_unit: '索引项', employee: '员工', character: '字符' })[price.unit] || price.unit;
      var label;
      if (price.kind === 'unit') label = zh ? '每' + unit + ' ' + amount + ' 美元' : 'USD ' + amount + ' per ' + price.unit;
      else if (price.kind === 'hit' || price.kind === 'range') {
        var minimum = Math.min(price.usd, price.callMaxUsd), maximum = Math.min(price.maxUsd, price.callMaxUsd);
        amount = minimum === 0 ? '0' : money(minimum);
        var upper = maximum === 0 ? '0' : money(maximum);
        label = (amount === upper ? amount : amount + '–' + upper) + (zh ? ' 美元/次' : ' USD/call');
        if (maximum === price.callMaxUsd) return label;
      }
      else return amount + (price.variable ? '+' : '') + (zh ? ' 美元/次' : ' USD/call');
      return label + ' · ' + copy.cap + ' ' + money(price.callMaxUsd) + ' ' + copy.usd;
    }
    var usage = element('div', 'wp-data-usage'), usageRetry = element('button', 'wp-skills-retry', copy.usageRetry);
    usage.setAttribute('role', 'status'); usageRetry.type = 'button'; usageRetry.hidden = true; usage.hidden = true; host.append(usage, usageRetry);
    var status = element('p', 'wp-skills-status', copy.loading), retry = element('button', 'wp-skills-retry', copy.retry);
    retry.type = 'button'; retry.hidden = true; status.setAttribute('role', 'status');
    var categories = element('nav', 'wp-data-categories'), platforms = element('div', 'wp-data-platforms'), cards = element('div', 'wp-skills-list wp-data-cards');
    categories.setAttribute('aria-label', language === 'zh' ? '工具分类' : 'Tool categories');
    var more = element('button', 'wp-skills-retry wp-data-more', copy.more); more.type = 'button'; more.hidden = true;
    host.append(categories, platforms, status, retry, cards, more);
    var groups = [], selected = 0, platformId = '', visible = 0, tools = [], revision = 0, cache = new Map();
    async function request(url) {
      var response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('Data tools unavailable');
      return response.json();
    }
    async function loadUsage() {
      usageRetry.hidden = true; usage.hidden = false; usage.textContent = copy.loading;
      try {
        var value = await request('/_wp/data/usage');
        if (disposed) return;
        usage.replaceChildren();
        ['daily', 'monthly'].forEach(function (period) {
          var limit = value[period].limitUsd, remaining = Math.max(0, limit - value[period].usedUsd);
          var block = element('div', 'wp-data-quota'), line = element('div', 'wp-data-quota-line');
          if (remaining === 0) line.textContent = period === 'daily' ? copy.dayReset : copy.monthReset;
          else { line.append(document.createTextNode(copy[period] + ' '), element('b', '', money(remaining)), document.createTextNode(' / ' + money(limit) + ' ' + copy.usd)); }
          var bar = element('div', 'wp-data-bar'), fill = element('i', '');
          bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', copy[period]); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(limit)); bar.setAttribute('aria-valuenow', String(remaining));
          fill.style.width = (limit > 0 ? Math.min(100, remaining / limit * 100) : 0) + '%'; bar.append(fill); block.append(line, bar); usage.append(block);
        });
      } catch (error) { if (!disposed) { usage.textContent = copy.usageFailed; usageRetry.hidden = false; } }
    }
    usageRetry.addEventListener('click', function () { void loadUsage(); });
    function choice(host, label, active, action) {
      var button = element('button', '', label); button.type = 'button'; button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', action); host.append(button); return button;
    }
    function renderFilters() {
      categories.replaceChildren(); platforms.replaceChildren();
      groups.forEach(function (group, index) {
        choice(categories, group.name[language], index === selected, function () { selected = index; platformId = ''; renderFilters(); void loadCards(); });
      });
      if (!groups.length) return;
      choice(platforms, copy.all, !platformId, function () { platformId = ''; renderFilters(); void loadCards(); });
      groups[selected].platforms.forEach(function (platform) {
        choice(platforms, platform.name[language], platformId === platform.id, function () { platformId = platform.id; renderFilters(); void loadCards(); });
      });
    }
    function appendCards() {
      tools.slice(visible, visible + 12).forEach(function (tool) {
        var card = element('article', 'wp-skill-card wp-data-card'); card.dataset.tool = tool.name;
        var top = element('div', 'wp-data-top'); top.append(element('h3', 'wp-skill-name', tool.title[language]), element('span', 'wp-data-chip', tool.platform.name[language]));
        top.lastChild.title = tool.platform.name[language];
        var footer = element('div', 'wp-data-foot'); footer.append(element('span', 'wp-data-price', priceText(tool.price)));
        if (tool.example) {
          var button = element('button', 'wp-skill-action', copy.tryIt); button.type = 'button';
          button.addEventListener('click', function () { window.wpMarket.tryExample(tool.example[language]); }); footer.append(button);
        }
        var description = element('p', 'wp-skill-description', tool.description[language]); description.title = tool.description[language];
        card.append(top, description, footer); cards.append(card);
      });
      visible += 12; more.hidden = visible >= tools.length;
    }
    async function loadCards() {
      var current = ++revision; retry.hidden = true; status.textContent = copy.loading; cards.replaceChildren(); more.hidden = true;
      var selectedPlatforms = groups[selected].platforms.filter(function (platform) { return !platformId || platform.id === platformId; });
      try {
        var results = await Promise.all(selectedPlatforms.map(async function (platform) {
          var rows = cache.get(platform.id);
          if (!rows) { rows = (await request('/_wp/data/catalog?platform=' + encodeURIComponent(platform.id))).tools; cache.set(platform.id, rows); }
          return rows.map(function (tool) { return Object.assign({}, tool, { platform: platform }); });
        }));
        if (disposed || current !== revision) return;
        tools = results.flat();
        visible = 0; status.textContent = tools.length ? '' : copy.empty; appendCards();
      } catch (error) { if (!disposed && current === revision) { status.textContent = copy.failed; retry.hidden = false; } }
    }
    more.addEventListener('click', appendCards);
    async function load() {
      retry.hidden = true; status.textContent = copy.loading;
      try {
        var data = await request('/_wp/data/tools');
        if (disposed) return;
        groups = data.groups; selected = 0; platformId = ''; renderFilters();
        if (!groups.length) { usage.hidden = true; status.textContent = copy.empty; return; }
        void loadUsage(); await loadCards();
      } catch (error) { if (!disposed) { status.textContent = copy.failed; retry.hidden = false; } }
    }
    retry.addEventListener('click', function () { if (groups.length) void loadCards(); else void load(); }); void load();
    return function () { disposed = true; controller.abort(); };
  });
})();
