/** Bridge bump planning and pinning against copies of the real lock and deployment reference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tool = new URL('bridge-bump.py', import.meta.url).pathname;
const lockText = fs.readFileSync(new URL('../image/third-party.lock.json', import.meta.url), 'utf8');
const docsText = fs.readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8');
const pinned = JSON.parse(lockText).artifacts.find(entry => entry.destination === 'cc-connect');
const pinnedTag = pinned.release.split('/').pop();
const base = 'https://github.com/example/bridge/releases';

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bump-'));
  fs.writeFileSync(path.join(dir, 'lock.json'), lockText);
  fs.writeFileSync(path.join(dir, 'deployment.md'), docsText);
  return dir;
}

function release(tag, { draft = false, at = '2026-01-02T00:00:00Z', names = [`cc-connect-${tag}-linux-amd64`] } = {}) {
  return { tag_name: tag, draft, published_at: draft ? null : at, html_url: `${base}/tag/${tag}`,
    assets: names.map(name => ({ name, browser_download_url: `${base}/download/${tag}/${name}` })) };
}

function run(...args) {
  const result = spawnSync('python3', ['-I', '-B', tool, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  return { ...result, outputs: Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2))) };
}

function plan(releases) {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify(releases));
  return run('plan', path.join(dir, 'releases.json'), path.join(dir, 'lock.json'));
}

test('the newest published release with a linux-amd64 asset is planned as a bump', () => {
  const result = plan([
    release('v9.0.0-draft', { draft: true }),
    release('v2.0.0', { at: '2026-01-03T00:00:00Z', names: ['cc-connect-v2.0.0-linux-amd64', 'cc-connect-v2.0.0-linux-amd64.sha256', 'cc-connect-v2.0.0-darwin-arm64'] }),
    release('v1.9.0', { at: '2026-01-01T00:00:00Z' }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.outputs, { state: 'bump', tag: 'v2.0.0', version: '2.0.0',
    url: `${base}/download/v2.0.0/cc-connect-v2.0.0-linux-amd64`, release: `${base}/tag/v2.0.0` });
});

test('nothing happens when the pin already matches the newest release', () => {
  const current = { tag_name: pinnedTag, draft: false, published_at: '2026-01-02T00:00:00Z', html_url: pinned.release,
    assets: [{ name: pinned.url.split('/').pop(), browser_download_url: pinned.url }] };
  const result = plan([current, release('v0.1.0', { at: '2025-01-01T00:00:00Z' })]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.outputs, { state: 'current', tag: pinnedTag });
});

test('a release without a linux-amd64 asset is skipped with a reason', () => {
  const result = plan([release('v2.0.0', { names: ['cc-connect-v2.0.0-darwin-arm64'] })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.state, 'skip');
  assert.match(result.outputs.reason, /v2\.0\.0 has no single -linux-amd64 asset/);
  assert.match(result.stderr, /skipped/);
});

test('apply pins the downloaded bytes in the lock and the deployment reference', () => {
  const dir = workspace();
  const binary = path.join(dir, 'cc-connect');
  fs.writeFileSync(binary, 'bridge build v2.0.0\n');
  const digest = crypto.createHash('sha256').update('bridge build v2.0.0\n').digest('hex');
  const url = `${base}/download/v2.0.0/cc-connect-v2.0.0-linux-amd64`;
  const result = run('apply', path.join(dir, 'lock.json'), path.join(dir, 'deployment.md'), binary,
    '--tag', 'v2.0.0', '--url', url, '--release', `${base}/tag/v2.0.0`);
  assert.equal(result.status, 0, result.stderr);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'));
  const entry = lock.artifacts.find(item => item.destination === 'cc-connect');
  assert.deepEqual(entry, { ...pinned, version: '2.0.0', url, release: `${base}/tag/v2.0.0`, sha256: digest, bytes: 20 });
  assert.deepEqual(lock.artifacts.filter(item => item !== entry && item.destination !== 'cc-connect'),
    JSON.parse(lockText).artifacts.filter(item => item.destination !== 'cc-connect'));
  const docs = fs.readFileSync(path.join(dir, 'deployment.md'), 'utf8');
  assert.ok(!docs.includes(pinned.sha256) && !docs.includes(pinnedTag));
  assert.match(docs, new RegExp(`cc-connect \`v2\\.0\\.0\`, SHA-256 \`${digest}\``));
  assert.match(docs, /`cc-connect-v2\.0\.0-linux-amd64` asset/);
  assert.match(docs, /require `v2\.0\.0`/);
});

test('apply refuses when the deployment reference no longer quotes the pin', () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'deployment.md'), docsText.replaceAll(pinned.sha256, '0'.repeat(64)));
  fs.writeFileSync(path.join(dir, 'cc-connect'), 'x');
  const result = run('apply', path.join(dir, 'lock.json'), path.join(dir, 'deployment.md'), path.join(dir, 'cc-connect'),
    '--tag', 'v2.0.0', '--url', `${base}/download/v2.0.0/x`, '--release', `${base}/tag/v2.0.0`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not quote the pinned/);
  assert.equal(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'), lockText);
});
