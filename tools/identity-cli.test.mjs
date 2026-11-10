/** Run the exported wrapper against a local CLI fixture; no identity server is contacted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const wrapper = new URL('../image/feishu/cli.mjs', import.meta.url);

test('official CLI help needs no identity and preserves the original confirmation exit status', t => {
  const root = mkdtempSync(join(tmpdir(), 'wp-identity-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'lark-cli'), '#!/bin/sh\necho CLI-help\nexit 10\n', { mode: 0o755 });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ realBin: bin, bin: root, identityFile: join(root, 'absent') }));
  const linked = join(root, 'linked-image');
  symlinkSync(new URL('../image/', import.meta.url), linked, 'dir');
  for (const entry of [wrapper.pathname, join(linked, 'feishu/cli.mjs')]) {
    const result = spawnSync(process.execPath, [entry, 'lark-cli', '/not-used', '--help'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, WORKPARTNER_IDENTITY_CONFIG: config }, timeout: 5000,
    });
    assert.equal(result.status, 10, result.stderr);
    assert.equal(result.stdout, 'CLI-help\n');
  }
});

test('gateway-prepared identity reaches the image CLI through its default settings filename', async t => {
  const { readFileSync } = await import('node:fs');
  const { once } = await import('node:events');
  const http = await import('node:http');
  const { createNextFeishuPreparation } = await import('../feishu/next.mjs');
  const { createRuntime } = await import('../gateway/runtime/index.mjs');
  const { runCli } = await import(wrapper);
  const root = mkdtempSync(join(tmpdir(), 'wp-gateway-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'lark-cli'), `#!/bin/sh
set -eu
test "$LARKSUITE_CLI_STRICT_MODE" = user
test "$LARKSUITE_CLI_DEFAULT_AS" = user
test "$LARKSUITE_CLI_APP_ID" = fixture-app
test "$LARKSUITE_CLI_USER_ACCESS_TOKEN" = fixture-access
`, { mode: 0o755 });
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fixture-signed-identity');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ user_access_token: 'fixture-access', app_id: 'fixture-app', expires_at: Date.now() / 1000 + 600 }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const organization = { runtime: { uid: null, nextDirectory: root, internalOrigin: `http://127.0.0.1:${server.address().port}` },
    server: { publicOrigin: 'https://workspace.example.test', projectHost: 'project.example.test' } };
  await createNextFeishuPreparation({ organization, runtime: createRuntime(organization), tokenFor: () => 'fixture-signed-identity' })({ backend: 'aionui', slug: 'user1', unionId: 'fixture-union' });
  const dockerfile = readFileSync(new URL('../image/Dockerfile', import.meta.url), 'utf8');
  const filename = dockerfile.match(/WORKPARTNER_IDENTITY_CONFIG=\/data\/([^\s]+)/)[1];
  const configFile = join(root, 'user1', filename);
  const settings = JSON.parse(readFileSync(configFile, 'utf8'));
  settings.realBin = bin;
  settings.identityFile = join(root, 'user1', settings.identityFile.slice('/data/'.length));
  writeFileSync(configFile, JSON.stringify(settings));
  assert.equal(await runCli('lark-cli', ['docs', '+get'], configFile), 0);
});
