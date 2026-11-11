// Organization hub metadata contributes to the shared Tools page.
(function () {
  'use strict';
  window.wpMarketTools.registerSource(async function (context) {
    var response = await fetch('/_wp/market/tools', { signal: context.signal });
    var data = await response.json();
    if (!response.ok && !data.groups) throw new Error('Tools unavailable');
    return { skill: data.skill || '', categories: data.groups.map(function (group) {
      return { id: group.name.en, name: group.name, platforms: group.platforms, loadTools: async function (platformId) {
        if (platformId && !group.platforms.some(function (platform) { return platform.id === platformId; })) return [];
        if (!response.ok) throw new Error('Tools unavailable');
        return data.tools.filter(function (tool) { return tool.category === group.name.en && (!platformId || tool.platform.id === platformId); });
      } };
    }) };
  });
})();
