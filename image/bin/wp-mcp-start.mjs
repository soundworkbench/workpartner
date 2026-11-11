import { organizationData } from '../organization/resolve.mjs';
import { hubConfig, listHubTools } from '../organization/mcp-hub.mjs';
import { spawnSync } from 'node:child_process';

let config, enabled = false;
try {
  config = hubConfig(organizationData().mcpHub);
  enabled = (await listHubTools(config, config && process.env[config.keyEnvironment])).length > 0;
} catch { console.warn('MCP hub discovery unavailable; managed tools disabled for this start.'); }
const result = spawnSync('python3', ['-I', new URL('./wp-mcp-config.py', import.meta.url).pathname], {
  input: JSON.stringify({ config, enabled, home: process.env.HOME || '/data' }), encoding: 'utf8', timeout: 5000,
});
if (result.status !== 0) console.warn('MCP configuration was not updated; startup continues.');
