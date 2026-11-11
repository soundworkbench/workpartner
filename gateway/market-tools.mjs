import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hubConfig, listHubTools } from './organization/mcp-hub.mjs';
import { loadDataTools } from './organization/data-tools.mjs';

export function createMarketTools({ organization, authenticate, keyFor, discover = listHubTools }) {
  const config = hubConfig(organization.mcpHub);
  const hidden = new Set(config?.hidden);
  const display = config?.displayNames ? JSON.parse(readFileSync(resolve(organization.directory, config.displayNames), 'utf8')) : {};
  const categories = new Map(loadDataTools(organization).categories.map(category => [category.en, category]));
  for (const category of config?.categories || []) {
    if (categories.has(category.en) && categories.get(category.en).zh !== category.zh) throw new Error('Conflicting MCP market category');
    categories.set(category.en, category);
  }
  const defaultCategory = config?.defaultCategory || 'Tools';
  if (!config?.defaultCategory && !categories.has('Tools')) categories.set('Tools', { en: 'Tools', zh: '工具' });
  const platform = config?.platform || { id: 'tool-service', name: { zh: '工具服务', en: 'Tool service' } };
  const presentation = name => ({ category: defaultCategory, platform, ...config?.tools?.[name] });
  if (config && (!categories.has(defaultCategory) || Object.keys(config.tools || {}).some(name => !categories.has(presentation(name).category)))) {
    throw new Error('Unknown MCP market category');
  }
  const line = value => typeof value === 'string' ? value.split(/[\r\n]/)[0].slice(0, 1000) : '';
  function groups(rows) {
    const result = new Map();
    for (const row of rows.length ? rows : [{ category: defaultCategory }]) {
      if (!result.has(row.category)) result.set(row.category, { name: categories.get(row.category), platforms: [] });
      const group = result.get(row.category);
      if (row.platform && !group.platforms.some(platform => platform.id === row.platform.id)) group.platforms.push(row.platform);
    }
    return [...result.values()];
  }
  return async (req, res, url) => {
    if (url.pathname !== '/_wp/market/tools') return false;
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body)); return true;
    };
    const user = authenticate(req);
    if (!user) return reply(401, { error: 'login_required' });
    if (req.method !== 'GET') return reply(405, { error: 'read_only' });
    if (!config) return reply(200, { groups: [], tools: [] });
    const skill = config.skill ? { skill: config.skill } : {};
    let key;
    const safe = value => key ? line(value).replaceAll(key, '[redacted]') : line(value);
    const localized = value => Object.fromEntries(['zh', 'en'].map(lang => [lang, safe(value[lang])]));
    const metadataGroups = rows => groups(rows).map(group => ({ name: localized(group.name), platforms: group.platforms.map(platform => ({ id: safe(platform.id), name: localized(platform.name) })) }));
    try {
      key = await keyFor(user);
      const tools = await discover(config, key);
      // Whitelist metadata only: schemas, URLs, annotations and headers never reach the page.
      const visible = tools.filter(tool => !hidden.has(tool.name));
      const rows = visible.map(tool => {
        const layout = presentation(tool.name);
        return { name: safe(tool.name), category: safe(layout.category),
          platform: { id: safe(layout.platform.id), name: localized(layout.platform.name) }, included: true,
          ...(layout.example ? { example: localized(layout.example) } : {}),
          title: Object.fromEntries(['zh', 'en'].map(lang => [lang, safe(display[tool.name]?.[lang]?.name) || safe(tool.title) || safe(tool.name)])),
          description: Object.fromEntries(['zh', 'en'].map(lang => [lang, safe(display[tool.name]?.[lang]?.description) || safe(tool.description)])) };
      });
      return reply(200, { ...skill, groups: metadataGroups(visible.map(tool => presentation(tool.name))), tools: rows });
    } catch (error) {
      if (error.message === 'MCP hub denied') return reply(200, { ...skill, groups: metadataGroups([]), tools: [] });
      // Keep a failed discovery in the configured category card areas so data tools remain usable.
      const rows = [presentation(''), ...Object.keys(config.tools || {}).filter(name => !hidden.has(name)).map(presentation)];
      return reply(503, { error: 'temporarily_unavailable', ...skill, groups: metadataGroups(rows) });
    }
  };
}
