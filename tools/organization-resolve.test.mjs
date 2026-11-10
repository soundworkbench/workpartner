import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOrganization } from '../gateway/organization/resolve.mjs';

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
