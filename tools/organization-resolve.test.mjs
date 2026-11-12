import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOrganization, nextEnvironment, nextModelConfig } from '../gateway/organization/resolve.mjs';

function fixture(t, fields = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-organization-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify({
    publicHost: 'workspace.example.com', model: { baseUrl: 'http://models.example.com/v1' }, ...fields,
  }));
  return { WORKPARTNER_ORG_DIR: directory };
}

const hosts = {
  previewHost: 'preview.example.com', legacyHosts: ['old.example.com', 'legacy.example.com:8443'],
  projectHost: 'project.example.com',
};

test('organization validates optional per-user Kubernetes image references', t => {
  for (const userImages of [undefined, {}, { person: 'workspace:pilot', other: 'registry.example.com/workspace@sha256:abc' }]) {
    const org = resolveOrganization(fixture(t, { runtime: { k8s: { userImages } } }));
    assert.deepEqual(org.runtime.k8s.userImages, userImages);
    if (userImages === undefined) assert.equal(Object.hasOwn(org.runtime.k8s, 'userImages'), false);
  }
  for (const userImages of [null, [], ['workspace:pilot'], 'workspace:pilot', 42, true,
    { '': 'workspace:pilot' }, { ' ': 'workspace:pilot' },
    ...['', ' ', 'workspace:pilot extra', 'workspace:pilot\n', 'workspace:\rpilot', 'workspace:\tpilot',
      null, 42, true, [], {}].map(image => ({ person: image }))]) {
    assert.throws(() => resolveOrganization(fixture(t, { runtime: { k8s: { userImages } } })),
      /runtime\.k8s\.userImages/);
  }
});

test('organization validates optional runtime.k8s.dnsNdots as an integer from 1 to 15', t => {
  for (const dnsNdots of [undefined, 1, 4, 15]) {
    const org = resolveOrganization(fixture(t, { runtime: { k8s: { dnsNdots } } }));
    assert.equal(org.runtime.k8s.dnsNdots, dnsNdots);
    if (dnsNdots === undefined) assert.equal(Object.hasOwn(org.runtime.k8s, 'dnsNdots'), false);
  }
  for (const dnsNdots of [null, 0, 16, -1, 1.5, '4', true, [], {}]) {
    assert.throws(() => resolveOrganization(fixture(t, { runtime: { k8s: { dnsNdots } } })),
      /runtime\.k8s\.dnsNdots must be an integer from 1 to 15/);
  }
});

test('organization JSON supplies optional hosts without deployment environment overrides', t => {
  const environment = fixture(t, hosts);
  assert.deepEqual(resolveOrganization(environment).server, {
    publicHost: 'workspace.example.com', publicOrigin: 'https://workspace.example.com', ...hosts,
  });
  assert.deepEqual(resolveOrganization({ ...environment, PREVIEW_HOST: '', OLD_HOSTS: '', MEEGLE_HOST: '' }).server,
    resolveOrganization(environment).server);
});

test('nonempty environment hosts take precedence and OLD_HOSTS retains comma parsing', t => {
  const server = resolveOrganization({ ...fixture(t, hosts), PUBLIC_HOST: 'override.example.com',
    PREVIEW_HOST: 'preview-override.example.com', MEEGLE_HOST: 'project-override.example.com',
    OLD_HOSTS: ' old-override.example.com, , legacy-override.example.com:8443, ',
  }).server;
  assert.deepEqual(server, {
    publicHost: 'override.example.com', publicOrigin: 'https://override.example.com',
    previewHost: 'preview-override.example.com', projectHost: 'project-override.example.com',
    legacyHosts: ['old-override.example.com', 'legacy-override.example.com:8443'],
  });
});

test('omitted optional organization hosts remain empty', t => {
  const server = resolveOrganization(fixture(t)).server;
  assert.equal(server.previewHost, '');
  assert.equal(server.projectHost, '');
  assert.deepEqual(server.legacyHosts, []);
});

test('JSON and environment hosts use the existing hostname validation', t => {
  for (const [field, variable] of [['previewHost', 'PREVIEW_HOST'], ['projectHost', 'MEEGLE_HOST'], ['legacyHosts', 'OLD_HOSTS']]) {
    for (const value of ['https://example.com', 'example.com/path', 'user@example.com', 'example.com:99999', 'example.com\n']) {
      assert.throws(() => resolveOrganization(fixture(t, { [field]: field === 'legacyHosts' ? [value] : value })), /hostname|Invalid URL/);
      // OLD_HOSTS historically trims surrounding whitespace.
      if (variable === 'OLD_HOSTS' && value.endsWith('\n')) continue;
      assert.throws(() => resolveOrganization({ ...fixture(t), [variable]: value }), /hostname|Invalid URL/);
    }
  }
  for (const value of ['old.example.com', {}, [42], ['']]) {
    assert.throws(() => resolveOrganization(fixture(t, { legacyHosts: value })), /hostname/);
  }
});

test('quick-line model is optional, validated and overridden by the personal environment', t => {
  const org = resolveOrganization(fixture(t, { model: { baseUrl: 'https://models.example.com/v1', quickLineModel: 'fast-model' } }));
  const configured = nextEnvironment(org);
  assert.equal(configured.QUICK_LINE_MODEL, 'fast-model');
  assert.equal(JSON.parse(configured.WORKPARTNER_MODEL_CONFIG).quickLineModel, 'fast-model');
  assert.equal(nextEnvironment(org, { QUICK_LINE_MODEL: 'override-model' }).QUICK_LINE_MODEL, 'override-model');
  assert.equal(Object.hasOwn(nextEnvironment(org, { QUICK_LINE_MODEL: '' }), 'QUICK_LINE_MODEL'), false);
  const unconfigured = resolveOrganization(fixture(t));
  assert.equal(Object.hasOwn(nextEnvironment(unconfigured), 'QUICK_LINE_MODEL'), false);
  assert.equal(Object.hasOwn(nextEnvironment(unconfigured, { QUICK_LINE_MODEL: 'override-model' }), 'QUICK_LINE_MODEL'), true);
  assert.equal(Object.hasOwn(nextModelConfig(unconfigured), 'quickLineModel'), false);
  // Removing the runtime field must not re-enable an older embedded organization value.
  const runtime = { WORKPARTNER_MODEL_CONFIG: JSON.stringify(nextModelConfig(unconfigured)) };
  assert.equal(Object.hasOwn(nextEnvironment(org, runtime), 'QUICK_LINE_MODEL'), false);
  for (const value of [null, 42, true, [], {}, 'fast\nmodel', 'fast\rmodel']) {
    assert.throws(() => resolveOrganization(fixture(t, { model: { quickLineModel: value } })), /model\.quickLineModel/);
    assert.throws(() => nextEnvironment(org, { QUICK_LINE_MODEL: value }), /model\.quickLineModel/);
    assert.throws(() => nextModelConfig(org, { WORKPARTNER_MODEL_CONFIG: JSON.stringify({ ...nextModelConfig(org), quickLineModel: value }) }), /model\.quickLineModel/);
  }
  const empty = resolveOrganization(fixture(t, { model: { baseUrl: 'https://models.example.com/v1', quickLineModel: '' } }));
  assert.equal(Object.hasOwn(nextEnvironment(empty), 'QUICK_LINE_MODEL'), false);
});

test('startup exports quick-line configuration and preserves a container override for child processes', t => {
  const environment = fixture(t, { model: { baseUrl: 'https://models.example.com/v1', quickLineModel: "fast'model" } });
  const start = fs.readFileSync(new URL('../image/bin/start.sh', import.meta.url), 'utf8');
  const setup = start.slice(start.indexOf('ORG_ENV='), start.indexOf('ANTHROPIC_API_KEY='))
    .replace('/opt/workpartner/organization/resolve.mjs', fileURLToPath(new URL('../gateway/organization/resolve.mjs', import.meta.url)));
  for (const override of [undefined, 'override-model', '']) {
    const child = spawnSync('bash', ['-c', setup + `\nnode -p 'process.env.QUICK_LINE_MODEL ?? "unset"'`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ...environment,
        ...(override === undefined ? {} : { QUICK_LINE_MODEL: override }) },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), override ?? "fast'model");
  }
});

test('bridge upgrade keys name template keys other than the managed agent keys', t => {
  const upgradeKeys = [{ key: 'queue_batch.debounce_ms' }, { key: 'projects.platforms.options.reaction_emoji', from: ['OnIt', 1, true] },
    { key: 'projects.agent.options.stream_partial_text' }];
  assert.deepEqual(resolveOrganization(fixture(t, { bridge: { template: 'bridge.toml', upgradeKeys } })).bridge.upgradeKeys, upgradeKeys);
  for (const value of [null, {}, 'queue_batch.debounce_ms', [null], [{}], [{ key: 'debounce_ms' }], [{ key: 'queue_batch.debounce ms' }],
    [{ key: 'projects.agent.options.model' }], [{ key: 'projects.name' }], [{ key: 'stream_preview.enabled', from: 'OnIt' }],
    [{ key: 'stream_preview.enabled', from: [null] }]]) {
    assert.throws(() => resolveOrganization(fixture(t, { bridge: { template: 'bridge.toml', upgradeKeys: value } })), /bridge\.upgradeKeys/);
  }
});

test('my key defaults are disabled and organization overrides preserve the section', t => {
  const defaults = resolveOrganization(fixture(t));
  assert.equal(defaults.features.myKey, false);
  assert.deepEqual(defaults.myKey, { allow: [], publicBaseUrl: '', revealSeconds: 30, reset: { enabled: false, blockedNote: '' }, reference: { weekly: 0, accounts: {} } });
  const myKey = { allow: ['union-member'], publicBaseUrl: 'https://models.example.test', revealSeconds: 15 };
  const org = resolveOrganization(fixture(t, { features: { myKey: true }, myKey }));
  assert.equal(org.features.myKey, true);
  assert.deepEqual(org.myKey, { ...myKey, reset: { enabled: false, blockedNote: '' }, reference: { weekly: 0, accounts: {} } });
});
