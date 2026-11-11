/** Per-user model catalog additions: resolution, validation and idle-container replacement. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { organizationData, nextModelConfig, nextEnvironment } from '../gateway/organization/resolve.mjs';
import { createDockerRuntime } from '../gateway/runtime/docker.mjs';
import { createAionui } from '../gateway/aionui.mjs';

const extra = { id: 'claude-extra', key: 'claude-extra', name: 'Extra' };

function organization(t, model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-user-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = value => fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify({ model: value }));
  write(model);
  return { dir, write, data: () => organizationData({ WORKPARTNER_ORG_DIR: dir }) };
}

test('a listed user gets appended entries and other users keep the organization config byte for byte', t => {
  const plain = organization(t, {});
  const org = organization(t, { userCatalog: { listed: { claude: [extra], codex: [{ default: 'codex', id: 'codex-again' }] } } });
  const organizationConfig = JSON.stringify(nextModelConfig(plain.data()));
  for (const slug of [undefined, 'other']) assert.equal(JSON.stringify(nextModelConfig(org.data(), {}, slug)), organizationConfig);

  const listed = nextModelConfig(org.data(), {}, 'listed');
  const base = JSON.parse(organizationConfig);
  assert.deepEqual(listed.catalog.claude, [...base.catalog.claude, { ...extra, also: [] }]);
  assert.deepEqual(listed.catalog.codex.at(-1), { id: 'codex-again', key: base.defaults.codex, name: base.defaults.codex, also: [] });
  assert.deepEqual(listed.defaults, base.defaults);

  // The image resolves the injected per-user config without knowing the slug.
  const injected = nextEnvironment(org.data(), { MODEL_BASE_URL: 'https://models.example.test/v1', WORKPARTNER_MODEL_CONFIG: JSON.stringify(listed) });
  assert.equal(injected.WORKPARTNER_MODEL_CONFIG, JSON.stringify(listed));
});

test('userCatalog is validated like model.catalog', t => {
  for (const userCatalog of [[], null, 'x', { '': { claude: [extra] } }, { person: [] }, { person: { claude: [] } },
    { person: { gemini: [extra] } }, { person: { claude: extra } }]) {
    assert.throws(() => organization(t, { userCatalog }).data(), /model\.userCatalog/, JSON.stringify(userCatalog));
  }
  for (const entry of [{}, { id: 'only-id' }, { default: 'missing' }, { key: 'k', also: 'opus' }]) {
    assert.throws(() => organization(t, { userCatalog: { person: { claude: [entry] } } }).data(), /Invalid model catalog entry/, JSON.stringify(entry));
  }
});

test('removing a user entry replaces only that user idle container', async t => {
  const org = organization(t, { userCatalog: { listed: { claude: [extra] } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-user-catalog-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = slug => nextModelConfig(org.data(), {}, slug);
  const containers = new Map(['listed', 'other'].map(slug => [slug, { env: ['WORKPARTNER_MODEL_CONFIG=' + JSON.stringify(config(slug))] }]));
  for (const slug of containers.keys()) {
    fs.writeFileSync(path.join(dir, `model-${slug}.key`), 'fixture');
    fs.writeFileSync(path.join(dir, `aionui-${slug}.pass`), 'fixture');
  }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: req.url.startsWith('/api/conversations') ? { items: [] } : {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const created = [];
  const slugOf = url => decodeURIComponent(url).match(/fixture-([a-z]+)/)?.[1];
  const docker = async (method, url, body) => {
    let data = {}, status = 200;
    const slug = slugOf(url);
    if (url.startsWith('/images/')) data = { Id: 'image-id' };
    else if (url.startsWith('/networks/')) data = { Containers: { gateway: { Name: 'gateway' } } };
    else if (method === 'GET' && url.endsWith('/json')) data = containers.has(slug) ? {
      Config: { Image: 'image', Env: containers.get(slug).env }, Image: 'image-id', State: { Running: true },
      NetworkSettings: { Networks: { [`fixture-${slug}-net`]: { IPAddress: '127.0.0.1' } } },
    } : (status = 404, {});
    else if (url.includes('/top?')) data = { Titles: ['PID', 'PPID', 'COMMAND'], Processes: [] };
    else if (method === 'DELETE') { containers.delete(slug); status = 204; }
    else if (url.startsWith('/containers/create?')) { created.push(slug); containers.set(slug, { env: body.Env }); status = 201; }
    else if (url.endsWith('/start') || url.includes('/stop?')) status = 204;
    else throw new Error(`Unexpected request ${method} ${url}`);
    return { status, body: Buffer.from(JSON.stringify(data)) };
  };
  const options = { docker, modelConfig: config, image: 'image', self: 'gateway', containerPrefix: 'fixture-', port: server.address().port,
    uid: process.getuid(), keyPrefix: 'model-', secureDir: dir, secretDir: dir, hostSecure: dir,
    dataDir: path.join(dir, 'data'), hostData: '/fixture-data', modelBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, busyRecheckMs: 0, log() {} };
  const aionui = createAionui({ ...options, runtime: createDockerRuntime(options) });
  const users = ['listed', 'other'].map(slug => ({ slug, name: slug }));
  for (const user of users) assert.ok(await aionui.upstream(user));
  assert.deepEqual(created, [], 'matching per-user configs are current');

  org.write({});
  for (const user of users) await aionui.upstream(user);
  await aionui.pending('listed');
  assert.deepEqual(created, ['listed']);
  const env = containers.get('listed').env.find(value => value.startsWith('WORKPARTNER_MODEL_CONFIG='));
  assert.equal(JSON.parse(env.slice(env.indexOf('=') + 1)).catalog.claude.some(entry => entry.id === extra.id), false);
});
