import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hubConfig, listHubTools } from './organization/mcp-hub.mjs';

export function createMarketTools({ organization, authenticate, keyFor, discover = listHubTools }) {
  const config = hubConfig(organization.mcpHub);
  const hidden = new Set(config?.hidden);
  const display = config?.displayNames ? JSON.parse(readFileSync(resolve(organization.directory, config.displayNames), 'utf8')) : {};
  const line = value => typeof value === 'string' ? value.split(/[\r\n]/)[0].slice(0, 1000) : '';
  return async (req, res, url) => {
    if (url.pathname !== '/_wp/market/tools') return false;
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body)); return true;
    };
    const user = authenticate(req);
    if (!user) return reply(401, { error: 'login_required' });
    if (req.method !== 'GET') return reply(405, { error: 'read_only' });
    if (!config) return reply(200, { tools: [] });
    try {
      const key = await keyFor(user);
      const tools = await discover(config, key);
      const safe = value => key ? line(value).replaceAll(key, '[redacted]') : line(value);
      // Whitelist metadata only: schemas, URLs, annotations and headers never reach the page.
      return reply(200, { tools: tools.filter(tool => !hidden.has(tool.name)).map(tool => ({ name: safe(tool.name),
        title: Object.fromEntries(['zh', 'en'].map(lang => [lang, safe(display[tool.name]?.[lang]?.name) || safe(tool.title) || safe(tool.name)])),
        description: Object.fromEntries(['zh', 'en'].map(lang => [lang, safe(display[tool.name]?.[lang]?.description) || safe(tool.description)])) })) });
    } catch (error) {
      if (error.message === 'MCP hub denied') return reply(200, { tools: [] });
      return reply(503, { error: 'temporarily_unavailable' });
    }
  };
}
