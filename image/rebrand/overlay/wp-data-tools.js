// Live organization categories, platforms and endpoint cards share the skills example action.
(function () {
  'use strict';
  var COPY = {
    'zh-CN': { loading: '正在加载工具…', empty: '暂无可用接口', failed: '工具暂时无法加载，请重试。', retry: '刷新列表', all: '全部', tryIt: '试一试', more: '查看更多', price: '价格暂不可用，请先查看接口报价', usageFailed: '本人额度暂时无法读取。', usageRetry: '刷新本人额度', daily: '今天已用', monthly: '本月已用', left: function (remaining, limit) { return '剩余 ' + remaining + ' / ' + limit; }, usd: '美元', cap: '单次最多', dayReset: '额度已用完，北京时间 08:00 恢复', monthReset: '额度已用完，北京时间下月 1 日 08:00 恢复', paused: '单次额度为零，请联系管理员' },
    'en-US': { loading: 'Loading tools…', empty: 'No endpoints available', failed: 'Tools could not be loaded. Please retry.', retry: 'Refresh list', all: 'All', tryIt: 'Try it', more: 'Show more', price: 'Price unavailable; check the endpoint quote first', usageFailed: 'Your data usage could not be loaded.', usageRetry: 'Refresh my usage', daily: 'Today used', monthly: 'This month used', left: function (remaining, limit) { return remaining + ' left of ' + limit; }, usd: 'USD', cap: 'Per-call limit', dayReset: 'budget used up; resets at 08:00 Beijing time', monthReset: 'budget used up; resets at 08:00 Beijing time on the first of next month', paused: 'Per-call budget is zero; contact the administrator' }
  };
  window.wpMarketTools.registerSource(async function (context) {
    var copy = COPY[context.locale] || COPY['zh-CN'], language = context.locale === 'zh-CN' ? 'zh' : 'en';
    var disposed = false, cache = new Map();
    function element(tag, className, text) { var node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
    function money(value) { return value > 0 && value < 0.01 ? '<0.01' : Number(value).toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    // Same format as the gateway usage summary that agents quote, so the page and chat agree.
    function usd(value) {
      var amount = Math.round(value * 1e6) / 1e6;
      if (amount > 0 && amount < 0.01) return '$' + String(Number(amount.toPrecision(4)));
      return '$' + amount.toFixed(4).replace(/0{1,2}$/, '');
    }
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
    async function request(url) {
      var response = await fetch(url, { signal: context.signal });
      if (!response.ok) throw new Error('Data tools unavailable');
      return response.json();
    }
    function renderHeader(host) {
      var usage = element('div', 'wp-data-usage'), usageRetry = element('button', 'wp-skills-retry', copy.usageRetry);
      usage.setAttribute('role', 'status'); usageRetry.type = 'button'; usageRetry.hidden = true; host.append(usage, usageRetry);
      var usageRevision = 0;
      // A refresh keeps the current figures on screen until the new ones arrive.
      async function loadUsage(refresh) {
        var current = ++usageRevision;
        if (!refresh) { usageRetry.hidden = true; usage.hidden = false; usage.textContent = copy.loading; }
        try {
          var value = await request('/_wp/data/usage');
          if (disposed || current !== usageRevision) return;
          usageRetry.hidden = true;
          usage.replaceChildren();
          ['daily', 'monthly'].forEach(function (period) {
            var limit = value[period].limitUsd, used = value[period].usedUsd, remaining = Math.max(0, limit - used);
            var block = element('div', 'wp-data-quota'), line = element('div', 'wp-data-quota-line');
            line.append(document.createTextNode(copy[period] + ' '), element('b', '', usd(used)), document.createTextNode(' · '
              + (remaining === 0 ? (period === 'daily' ? copy.dayReset : copy.monthReset) : copy.left(usd(remaining), usd(limit)))));
            var bar = element('div', 'wp-data-bar'), fill = element('i', '');
            bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', copy[period]); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(limit)); bar.setAttribute('aria-valuenow', String(remaining)); bar.setAttribute('aria-valuetext', line.textContent);
            fill.style.width = (limit > 0 ? Math.min(100, remaining / limit * 100) : 0) + '%'; bar.append(fill); block.append(line, bar); usage.append(block);
          });
        } catch (error) { if (!disposed && current === usageRevision) { usage.textContent = copy.usageFailed; usageRetry.hidden = false; } }
      }
      // Calls made from chat while this browser tab was in the background show up when it is visible again.
      function onVisible() { if (!document.hidden) void loadUsage(true); }
      usageRetry.addEventListener('click', function () { void loadUsage(); });
      document.addEventListener('visibilitychange', onVisible);
      void loadUsage();
      return function () { disposed = true; document.removeEventListener('visibilitychange', onVisible); };
    }
    var data = await request('/_wp/data/tools');
    return {
      skill: 'data-tools',
      renderHeader: data.groups.some(function (group) { return group.platforms.length; }) ? renderHeader : null,
      categories: data.groups.map(function (group) {
        return { id: group.name.en, name: group.name, platforms: group.platforms, loadTools: async function (platformId) {
          var results = await Promise.all(group.platforms.filter(function (platform) { return !platformId || platform.id === platformId; }).map(async function (platform) {
            var rows = cache.get(platform.id);
            if (!rows) { rows = (await request('/_wp/data/catalog?platform=' + encodeURIComponent(platform.id))).tools; cache.set(platform.id, rows); }
            return rows.map(function (tool) { return Object.assign({}, tool, { platform: platform, priceLabel: priceText(tool.price) }); });
          }));
          return results.flat();
        } };
      })
    };
  });
})();
