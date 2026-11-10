import http from 'node:http';
import fs from 'node:fs/promises';
import { context } from './context.mjs';
import { pathToFileURL } from 'node:url';

export async function main() {
const config = JSON.parse(await fs.readFile('/e2e/config.json', 'utf8'));
// Use the real K3 ownership and keep-running implementation on gateway startup.
const { createMigration } = await import('../../../gateway/migration.mjs');
const { createAionui } = await import('../../../gateway/aionui.mjs');
const c = await context(config);
await fs.mkdir('/e2e-state', { recursive: true });
await fs.writeFile('/e2e-state/owners.json', JSON.stringify({ version: 1, default: 'k8s', users: {} }));
const migration = createMigration(c.org, () => {});
const manager = createAionui({ runtime: c.runtime, kind: 'k8s', owns: migration.owns, log: () => {} });
// Only S13's stopped user participates; other scenarios deliberately stop their Pods.
await manager.keepRunning(() => [{ slug: 'takeover', backend: 'aionui' }]);
for (const port of [c.org.runtime.gatewayPort, c.org.runtime.internalPort, config.samplePort]) {
  http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ready":true}'); }).listen(port, '0.0.0.0');
}

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
}
