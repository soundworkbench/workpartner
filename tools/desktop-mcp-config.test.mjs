import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { materializeNext } from '../gateway/organization/materialize-next.mjs';
import { nextEnvironment, organizationData } from '../gateway/organization/resolve.mjs';

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mcp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const hub = { name: 'workpartner-hub', url: 'https://example.com/mcp', keyEnvironment: 'PERSON_KEY' };
const desktop = { name: 'workpartner-desktop', url: 'http://gateway.example.test:3091/desktop-mcp', headerScript: 'wp-desktop-mcp-headers.py' };
function update(home, configs) {
  return spawnSync('python3', ['-I', 'image/bin/wp-mcp-config.py'], { input: JSON.stringify({ home, configs }), encoding: 'utf8' });
}
const read = home => fs.readFileSync(path.join(home, '.claude.json'), 'utf8');

test('multiple managed MCPs coexist, preserve personal bytes including CRLF, migrate ownership and remain idempotent', t => {
  const home = temporary(t);
  const personal = '"personal" : { "command" : "my-command", "args": [ "a", "b" ] }';
  fs.writeFileSync(path.join(home, '.claude.json'), '{\r\n "mcpServers": { ' + personal + ' },\r\n "tail": [ 1, 2 ]\r\n}\r\n');
  assert.equal(update(home, [hub, desktop]).status, 0);
  const first = read(home), value = JSON.parse(first);
  assert.deepEqual(value._workpartnerMcp.names, ['workpartner-hub', 'workpartner-desktop']);
  assert.ok(first.includes(personal)); assert.ok(first.includes('\r\n "tail": [ 1, 2 ]'));
  assert.ok(value.mcpServers['workpartner-hub'].headersHelper.endsWith(' PERSON_KEY'));
  assert.ok(value.mcpServers['workpartner-desktop'].headersHelper.endsWith('wp-desktop-mcp-headers.py'));
  assert.ok(!first.includes('zpd.')); assert.equal(value.mcpServers['workpartner-desktop'].alwaysLoad, true);
  assert.equal(update(home, [hub, desktop]).status, 0); assert.equal(read(home), first);
  const codex = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'); assert.match(codex, /workpartner-hub/); assert.doesNotMatch(codex, /workpartner-desktop/);
  assert.equal(update(home, [desktop]).status, 0); assert.ok(!JSON.parse(read(home)).mcpServers['workpartner-hub']);
  assert.equal(update(home, []).status, 0); assert.deepEqual(JSON.parse(read(home)).mcpServers, { personal: { command: 'my-command', args: ['a', 'b'] } });
  assert.ok(read(home).includes(personal)); const cleared = read(home); update(home, []); assert.equal(read(home), cleared);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'workpartner-hub': { url: 'old' } }, _workpartnerMcp: { name: 'workpartner-hub' } }));
  assert.equal(update(home, [hub, desktop]).status, 0); assert.deepEqual(JSON.parse(read(home))._workpartnerMcp.names, [hub.name, desktop.name]);
  assert.equal(fs.statSync(path.join(home, '.claude.json')).mode & 0o777, 0o600);
});

test('each name collision or malformed ownership leaves both engines untouched', t => {
  const home = temporary(t); fs.mkdirSync(path.join(home, '.codex'));
  const codex = '# personal\nmodel = "mine"\n'; fs.writeFileSync(path.join(home, '.codex/config.toml'), codex);
  for (const name of [hub.name, desktop.name]) {
    const before = JSON.stringify({ mcpServers: { [name]: { command: 'personal' } } }); fs.writeFileSync(path.join(home, '.claude.json'), before);
    const result = update(home, [hub, desktop]); assert.equal(result.status, 1); assert.equal(read(home), before); assert.equal(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), codex);
  }
  for (const owner of [null, { names: 'bad' }, { names: [3] }]) {
    const before = JSON.stringify({ _workpartnerMcp: owner }); fs.writeFileSync(path.join(home, '.claude.json'), before);
    assert.equal(update(home, [desktop]).status, 1); assert.equal(read(home), before);
  }
});

function headers(value, missing = false) {
  // Patch only the fixed credential file read, never its validation or stdout behavior.
  const script = `import json, runpy, sys\nfrom unittest.mock import patch\nvalue = json.loads(sys.stdin.read())\nwith patch('pathlib.Path.read_text', ${missing ? "side_effect=FileNotFoundError()" : "return_value=value"}):\n    runpy.run_path('image/bin/wp-desktop-mcp-headers.py', run_name='__main__')\n`;
  return spawnSync('python3', ['-I', '-c', script], { input: JSON.stringify(value), encoding: 'utf8' });
}

test('desktop headersHelper emits only a valid header; missing/malformed files exit nonzero silently', () => {
  const token = `zpd.fixture_payload.${'a'.repeat(43)}`;
  const valid = headers(' \n' + token + '\n'); assert.equal(valid.status, 0); assert.equal(valid.stderr, ''); assert.deepEqual(JSON.parse(valid.stdout), { Authorization: `Bearer ${token}` });
  for (const value of ['', 'wpd.invalid', 'PRIVATE-FILE-CONTENT', token + '\nInjected: x', token.replace('.', '.\r'), 'zpd.x.short', '{}']) {
    const result = headers(value); assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
  const missing = headers('', true); assert.notEqual(missing.status, 0); assert.equal(missing.stdout + missing.stderr, '');
});

test('assembled startup registers desktop without token or desktop probe, validates origins and removes disabled entry', t => {
  const dir = temporary(t), context = path.join(dir, 'context'), home = path.join(dir, 'home'), org = path.join(dir, 'org');
  fs.mkdirSync(path.join(context, 'image'), { recursive: true }); fs.mkdirSync(home); fs.mkdirSync(org);
  fs.cpSync('image/bin', path.join(context, 'image/bin'), { recursive: true }); fs.cpSync('image/home', path.join(context, 'image/home'), { recursive: true });
  fs.cpSync('org/default/appearance', path.join(org, 'appearance'), { recursive: true });
  fs.writeFileSync(path.join(org, 'organization.json'), JSON.stringify({ desktop: { enabled: true, allow: ['*'] } }));
  materializeNext(context, { WORKPARTNER_ORG_DIR: org });
  fs.cpSync(path.join(context, 'organization'), path.join(context, 'image/organization'), { recursive: true });
  const selected = path.join(context, 'organization/selected');
  const start = origin => spawnSync(process.execPath, [path.join(context, 'image/bin/wp-mcp-start.mjs')], {
    env: { ...process.env, HOME: home, WORKPARTNER_ORG_DIR: selected, PARTNER_INTERNAL_ORIGIN: origin }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(start('http://gateway.example.test:3091').status, 0);
  const first = read(home); assert.equal(JSON.parse(first).mcpServers[desktop.name].url, desktop.url);
  assert.ok(!fs.existsSync(path.join(home, '.zp-market-token'))); assert.ok(!fs.existsSync(path.join(home, '.codex/config.toml')));
  assert.equal(start('http://gateway.example.test:3091').status, 0); assert.equal(read(home), first);
  for (const origin of ['', 'not-an-origin', 'file:///data', 'https://user:pass@example.com', 'http://example.com?token=private', 'http://example.com#private']) {
    const result = start(origin); assert.equal(result.status, 0); assert.ok(!JSON.parse(read(home)).mcpServers[desktop.name]); assert.ok(!(result.stdout + result.stderr).includes('private'));
  }
  start('http://gateway.example.test:3091');
  fs.writeFileSync(path.join(selected, 'organization.json'), JSON.stringify({ desktop: { enabled: false } }));
  assert.equal(start('http://gateway.example.test:3091').status, 0); assert.ok(!JSON.parse(read(home)).mcpServers[desktop.name]);
});

test('desktop is disabled by default and internal origin reaches container environment without credentials', () => {
  const config = organizationData({}); assert.equal(config.desktop.enabled, false);
  const values = nextEnvironment(config, { MODEL_BASE_URL: 'https://models.example.test/v1' }); assert.equal(values.PARTNER_INTERNAL_ORIGIN, config.runtime.internalOrigin);
  assert.ok(!Object.values(values).some(value => String(value).startsWith('zpd.')));
});
