// Usage: node run.mjs [group ...]   (groups: menu, flow, access, my-key; default: all, one after another)
// Exit code is non-zero when a test fails. Screenshots and gateway logs go to ./output (or BROWSER_TESTS_OUTPUT).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GROUPS = ['menu', 'flow', 'access', 'my-key'];
const wanted = process.argv.slice(2);
const unknown = wanted.filter(name => !GROUPS.includes(name));
if (unknown.length) { console.error(`Unknown group: ${unknown.join(', ')}. Known groups: ${GROUPS.join(', ')}.`); process.exit(2); }
const files = (wanted.length ? wanted : GROUPS).map(name => fileURLToPath(new URL(`./${name}.e2e.mjs`, import.meta.url)));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
