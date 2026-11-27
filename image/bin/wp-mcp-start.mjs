import { organizationData } from '../organization/resolve.mjs';
import { hubConfig, listHubTools } from '../organization/mcp-hub.mjs';
import { spawnSync } from 'node:child_process';

let config, enabled = false;
try {
  config = hubConfig(organizationData().mcpHub);
  enabled = (await listHubTools(config, config && process.env[config.keyEnvironment])).length > 0;
} catch { console.warn('MCP hub discovery unavailable; managed tools disabled for this start.'); }
const configs = enabled ? [config] : [];
try {
  if (organizationData().desktop?.enabled === true) {
    const origin = new URL(process.env.PARTNER_INTERNAL_ORIGIN);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) throw new Error('Invalid origin');
    configs.push({ name: 'workpartner-desktop', url: new URL('/desktop-mcp', origin).href, headerScript: 'wp-desktop-mcp-headers.py' });
  }
} catch { console.warn('Desktop MCP configuration unavailable; managed desktop tools disabled for this start.'); }
const result = spawnSync('python3', ['-I', new URL('./wp-mcp-config.py', import.meta.url).pathname], {
  input: JSON.stringify({ configs, home: process.env.HOME || '/data' }), encoding: 'utf8', timeout: 5000,
});
if (result.status !== 0) console.warn('MCP configuration was not updated; startup continues.');
