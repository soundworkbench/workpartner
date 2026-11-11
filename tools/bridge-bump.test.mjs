/** Bridge bump planning and pinning against fixture locks and deployment references. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tool = new URL('bridge-bump.py', import.meta.url).pathname;
const base = 'https://github.com/example/bridge/releases';
const legacyTag = 'v1.5.2-beta.1-sw.167-sw.14';

function asset(tag) {
  return `cc-connect-${tag}-linux-amd64`;
}

function pin(tag, sha256 = crypto.createHash('sha256').update(tag).digest('hex')) {
  return { destination: 'cc-connect', version: tag.slice(1), url: `${base}/download/${tag}/${asset(tag)}`,
    format: 'file', release: `${base}/tag/${tag}`, sha256, bytes: 1 };
}

function fixtureLock(tag) {
  return { artifacts: [
    { destination: 'codex', version: '0.1.0', url: 'https://example.com/codex.tar.gz', format: 'tar', sha256: 'c'.repeat(64) },
    pin(tag),
  ] };
}

function fixtureDocs(entry) {
  const tag = entry.release.split('/').pop();
  return `# Deployment\n\nThe lock selects cc-connect \`${tag}\`, SHA-256 \`${entry.sha256}\`. `
    + `The downloader fetches the \`${asset(tag)}\` asset from the public release.\n\n`
    + `When upgrading the bridge, check \`cc-connect --version\` inside the built user image and require \`${tag}\`.\n`;
}

function workspace(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bump-'));
  const lock = fixtureLock(tag);
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'deployment.md'), fixtureDocs(lock.artifacts[1]));
  return dir;
}

function release(tag, { draft = false, at = '2026-01-02T00:00:00Z', names = [asset(tag)] } = {}) {
  return { tag_name: tag, draft, published_at: draft ? null : at, html_url: `${base}/tag/${tag}`,
    assets: names.map(name => ({ name, browser_download_url: `${base}/download/${tag}/${name}` })) };
}

function run(...args) {
  const result = spawnSync('python3', ['-I', '-B', tool, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  return { ...result, outputs: Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map(line => line.split(/=(.*)/s).slice(0, 2))) };
}

function plan(releases, pinnedTag = legacyTag) {
  const dir = workspace(pinnedTag);
  fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify(releases));
  return run('plan', path.join(dir, 'releases.json'), path.join(dir, 'lock.json'));
}

function apply(dir, tag, contents = `bridge build ${tag}\n`) {
  const binary = path.join(dir, 'cc-connect');
  fs.writeFileSync(binary, contents);
  return run('apply', path.join(dir, 'lock.json'), path.join(dir, 'deployment.md'), binary,
    '--tag', tag, '--url', `${base}/download/${tag}/${asset(tag)}`, '--release', `${base}/tag/${tag}`);
}

test('the newest published release with a linux-amd64 asset is planned as a bump', () => {
  const result = plan([
    release('v9.0.0-draft', { draft: true }),
    release('v2.0.0', { at: '2026-01-03T00:00:00Z', names: [asset('v2.0.0'), `${asset('v2.0.0')}.sha256`, 'cc-connect-v2.0.0-darwin-arm64'] }),
    release('v1.9.0', { at: '2026-01-01T00:00:00Z' }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.outputs, { state: 'bump', tag: 'v2.0.0', version: '2.0.0',
    url: `${base}/download/v2.0.0/${asset('v2.0.0')}`, release: `${base}/tag/v2.0.0` });
});

test('a legacy -sw.<n> release tag is planned with its version', () => {
  const tag = 'v1.5.2-beta.1-sw.167-sw.15';
  const result = plan([release(tag)]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.state, 'bump');
  assert.equal(result.outputs.version, '1.5.2-beta.1-sw.167-sw.15');
});

for (const pinnedTag of [legacyTag, 'v2.0.0']) {
  test(`nothing happens when the pin already matches the newest release (${pinnedTag})`, () => {
    const result = plan([release(pinnedTag), release('v0.1.0', { at: '2025-01-01T00:00:00Z' })], pinnedTag);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.outputs, { state: 'current', tag: pinnedTag });
  });
}

test('a release without a linux-amd64 asset is skipped with a reason', () => {
  const result = plan([release('v2.0.0', { names: ['cc-connect-v2.0.0-darwin-arm64'] })]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.state, 'skip');
  assert.match(result.outputs.reason, /v2\.0\.0 has no single -linux-amd64 asset/);
  assert.match(result.stderr, /skipped/);
});

for (const [from, to] of [[legacyTag, 'v2.0.0'], ['v2.0.0', 'v2.1.0'], [legacyTag, 'v1.5.2-beta.1-sw.167-sw.15']]) {
  test(`apply pins the downloaded bytes in the lock and the deployment reference (${from} -> ${to})`, () => {
    const dir = workspace(from);
    const before = fixtureLock(from);
    const contents = `bridge build ${to}\n`;
    const result = apply(dir, to, contents);
    assert.equal(result.status, 0, result.stderr);
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'));
    assert.deepEqual(lock.artifacts[0], before.artifacts[0]);
    assert.deepEqual(lock.artifacts[1], { ...pin(to, digest), bytes: Buffer.byteLength(contents) });
    assert.equal(fs.readFileSync(path.join(dir, 'deployment.md'), 'utf8'), fixtureDocs(lock.artifacts[1]));
  });
}

test('apply refuses when the deployment reference no longer quotes the pin', () => {
  const dir = workspace(legacyTag);
  const lockBefore = fs.readFileSync(path.join(dir, 'lock.json'), 'utf8');
  const docs = path.join(dir, 'deployment.md');
  fs.writeFileSync(docs, fs.readFileSync(docs, 'utf8').replaceAll(pin(legacyTag).sha256, '0'.repeat(64)));
  const result = apply(dir, 'v2.0.0');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not quote the pinned/);
  assert.equal(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8'), lockBefore);
});

test('the deployment reference quotes the version and digest pinned in the lock', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('../image/third-party.lock.json', import.meta.url), 'utf8'));
  const docs = fs.readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8');
  const entry = lock.artifacts.find(item => item.destination === 'cc-connect');
  const tag = entry.release.split('/').pop();
  assert.equal(`v${entry.version}`, tag);
  assert.ok(docs.includes(`\`${tag}\``) && docs.includes(entry.sha256), 'docs/deployment.md must quote the pinned tag and SHA-256');
});
