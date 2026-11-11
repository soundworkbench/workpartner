/** Verify the exported data mechanism with an unrelated organization and provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createDataTools } from '../gateway/data-tools.mjs';
import { dataToolsSkill } from '../gateway/organization/data-tools.mjs';
import { organizationData } from '../gateway/organization/resolve.mjs';

test('neutral organizations expose no data tools; a selected table controls cards, skill and exact outbound request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ep = { id: 'example.measurements.search', command: 'measurements', method: 'POST', bodyArray: true,
    category: { en: 'Research', zh: '研究' }, platform: { id: 'measurements', en: 'Measurements', zh: '测量' },
    parameters: { q: { in: 'body', type: 'string', required: true }, limit: { in: 'body', type: 'integer', required: false } },
    template: { q: 'acoustics', limit: 5 }, rules: { limit: { max: 5, default: 5 } }, routeMaxUsd: .02 };
  const catalog = { schemaVersion: 1, categories: [{ en: 'Research', zh: '研究' }],
    platforms: [{ id: 'measurements', category: 'Research', name: { en: 'Measurements', zh: '测量' }, summary: 'Find measurement data' }],
    directory: { platformsPath: '/directory/platforms', platformPath: '/directory/platforms/{id}', endpointPath: '/directory/endpoints/{id}', searchPath: '/directory/search',
      platformNames: { measurements: '测量' }, blockedEndpoints: [], blockedProviders: [], blockedCapabilities: [], presentationRedactions: [] }, tools: [{ name: 'measurements', title: { en: 'Find measurements', zh: '查测量' },
    description: { en: 'Find measurement data.', zh: '查询测量数据。' }, example: { en: 'Find acoustic measurements', zh: '查声学测量数据' },
    price: '$0.01', returns: 'Measurement data', endpoints: [ep] }] };
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, 'credential'), 'fixture-only');
  const org = { directory: root, server: { publicOrigin: 'https://example.test' }, dataTools: { catalog: 'catalog.json', blockedPrefixes: ['/_retired/data'], provider: {
    origin: 'https://data.example.test', tokenFile: path.join(root, 'credential'), orgIdEnvironment: 'DATA_ORG', orgSlugEnvironment: 'DATA_TEAM',
    enabledEnvironment: 'DATA_ON', verifiedEnvironment: 'DATA_VERIFIED', limitEnvironment: {}, budgetPath: '/budgets/{orgId}/user', callPath: '/invoke/{id}', usagePath: '/usage/{orgId}',
    headers: { token: 'x-data-key', organization: 'x-data-team', tag: 'x-data-meta', routeMax: 'x-data-max', cost: 'x-data-cost', callId: 'x-data-id' },
  } } };
  const requests = [], user = { slug: 'fixture-user' };
  const authenticate = req => req.headers.authorization === 'Bearer fixture-personal' ? user : null;
  let handler = createDataTools({ organization: organizationData({}), authenticate });
  const server = http.createServer(async (req, res) => { await handler(req, res, new URL(req.url, 'http://local.test')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer fixture-personal', 'content-type': 'application/json' };
  const empty = await fetch(base + '/_wp/data/tools', { headers });
  assert.deepEqual((await empty.json()).tools, []);
  handler = createDataTools({ organization: org, authenticate, env: { DATA_ON: '1', DATA_VERIFIED: '1', DATA_ORG: '5', DATA_TEAM: 'fixture' },
    fetcher: async (url, options) => {
      url = new URL(url);
      const source = { ...ep, platform: 'measurements', kind: 'data', platform_eligible: true,
        name: 'Find measurements', summary: 'Find measurement data', cost: { usd: .01, unit: 'call' },
        input: { body: Object.fromEntries(Object.entries(ep.parameters).map(([key, rule]) => [key, rule])) } };
      if (url.pathname === '/directory/platforms') return Response.json({ platforms: [
        { slug: 'new-platform', label: 'New platform', category: 'Research' },
        { slug: 'measurements', label: 'Measurements', category: 'Research' },
      ] });
      if (url.pathname.startsWith('/directory/platforms/')) return Response.json({ platform: { slug: 'measurements' }, capabilities: [{ id: 'measurements.search', endpoints: [source] }] });
      if (url.pathname.startsWith('/directory/endpoints/')) return Response.json({ endpoint: source, example_response: { value: 42 } });
      if (url.pathname.startsWith('/usage/')) return Response.json({ key: 'user', rows: [
        { value: 'fixture-user', charged_micro: 10000 }, { value: 'someone-else', charged_micro: 90000000 },
      ] });
      requests.push({ url, ...options });
      return new Response('{"rows":[{"value":42}]}', { headers: { 'x-data-cost': '10000', 'x-data-id': 'one' } });
    } });
  assert.equal((await fetch(base + '/_wp/data/tools')).status, 401);
  const groups = await (await fetch(base + '/_wp/data/tools', { headers })).json();
  assert.deepEqual(groups.groups[0].platforms.map(row => row.id), ['measurements', 'new-platform']);
  const cards = await (await fetch(base + '/_wp/data/catalog?platform=measurements', { headers })).json();
  assert.equal(cards.tools[0].title.en, 'Find measurements');
  assert.match(dataToolsSkill(catalog), /wp-data call example.measurements.search --json/);
  const response = await fetch(base + '/_wp/data/call/measurements', { method: 'POST', headers, body: '{"q":"acoustics","limit":999}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).costUsd, .01);
  const call = requests.at(-1);
  assert.equal(call.url.pathname, '/invoke/example.measurements.search');
  assert.deepEqual(JSON.parse(call.body), [{ q: 'acoustics', limit: 5 }]);
  assert.equal(call.headers['x-data-meta'], 'user=fixture-user');
  assert.equal(call.headers['x-data-max'], '0.02');
  assert.equal(call.headers['x-data-key'], 'fixture-only');
  const personal = await (await fetch(base + '/_wp/data/usage', { headers })).json();
  assert.deepEqual(personal.daily, { usedUsd: .01, limitUsd: 1 });
  assert.deepEqual(personal.monthly, { usedUsd: .01, limitUsd: 5 });
  assert.equal(personal.call.limitUsd, 1);
  assert.doesNotMatch(JSON.stringify(personal), /someone-else|90000000/);
  const count = requests.length;
  for (const route of ['/catalog/search', '/call/example.other']) {
    assert.equal((await fetch(base + '/_wp/data' + route, { method: 'POST', headers, body: '{}' })).status, 403);
  }
  assert.equal((await fetch(base + '/_retired/data/catalog/search', { headers })).status, 403);
  assert.equal(requests.length, count);
});
