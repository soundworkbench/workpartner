/** Verify the exported data mechanism with an unrelated organization and provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createDataTools } from '../gateway/data-tools.mjs';
import { dataToolsSkill, parseDataTools } from '../gateway/organization/data-tools.mjs';
import { organizationData } from '../gateway/organization/resolve.mjs';

function fixture(t) {
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
  return { root, ep, catalog, org };
}

test('neutral organizations expose no data tools; a selected table controls cards, skill and exact outbound request', async t => {
  const { ep, catalog, org } = fixture(t);
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
      if (url.pathname === '/directory/platforms') return Response.json({ platforms: [{ slug: 'measurements', label: 'Measurements', category: 'Research' }] });
      if (url.pathname.startsWith('/directory/platforms/')) return Response.json({ platform: { slug: 'measurements' }, capabilities: [{ id: 'measurements.search', endpoints: [source] }] });
      if (url.pathname.startsWith('/directory/endpoints/')) return Response.json({ endpoint: source, example_response: { value: 42 } });
      if (url.pathname.startsWith('/usage/')) return Response.json({ key: 'user', rows: [
        { value: 'fixture-user', charged_micro: 10000 }, { value: 'someone-else', charged_micro: 90000000 },
      ] });
      requests.push({ url, ...options });
      return new Response('{"rows":[{"value":42}]}', { headers: { 'x-data-cost': '10000', 'x-data-id': 'one' } });
    } });
  assert.equal((await fetch(base + '/_wp/data/tools')).status, 401);
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

test('image calls wait, apply catalog defaults, save URL/base64 files and retain the successful cost', async t => {
  const { root, ep, catalog, org } = fixture(t);
  ep.id = 'example.images.generate'; ep.command = 'generate-image'; ep.bodyArray = false;
  ep.category = { en: 'Content generation', zh: '内容生成' };
  ep.platform = { id: 'images', en: 'Images', zh: '图片' };
  ep.parameters = Object.fromEntries(['prompt', 'model', 'quality', 'size'].map(key => [key, { in: 'body', type: 'string', required: true }]));
  ep.defaults = { model: 'image-standard', quality: 'medium', size: '1024x1024' };
  ep.template = { prompt: 'A small green tree' }; ep.rules = {}; ep.timeoutMs = 1000;
  ep.fileResult = { path: 'data', urlField: 'url', base64Field: 'b64_json', maxBytes: 1024, maxFiles: 2 };
  catalog.categories = [ep.category];
  catalog.platforms = [{ id: 'images', category: ep.category.en, name: { en: 'Images', zh: '图片' }, summary: 'Generate an image' }];
  const tool = catalog.tools[0]; tool.name = 'images';
  tool.title = { en: 'Generate image', zh: '生成图片' };
  tool.example = { en: 'Generate a small green tree', zh: '生成一棵绿色小树' };
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(root, '.wp-market-token'), 'fixture-personal');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
  const calls = [], budgets = [];
  let charged = 0, rejectCall = false, oversized = false, invalidImage = false, pending = false, timeout = false, downloadAuth;
  let notifyCall, releaseCall;
  const called = new Promise(resolve => { notifyCall = resolve; });
  const release = new Promise(resolve => { releaseCall = resolve; });
  const source = { id: ep.id, method: 'POST', platform: 'images', kind: 'data', platform_eligible: true,
    name: 'Generate image', cost: { usd: .01, unit: 'image' }, input: { body: ep.parameters } };
  let base;
  const handler = createDataTools({ organization: org, authenticate: req => req.headers.authorization === 'Bearer fixture-personal' ? { slug: 'fixture-user' } : null,
    env: { DATA_ON: '1', DATA_VERIFIED: '1', DATA_ORG: '5', DATA_TEAM: 'fixture' }, fetcher: async (url, options) => {
      const { pathname } = new URL(url);
      if (pathname === '/directory/platforms') return Response.json({ platforms: [{ slug: 'images', label: 'Images', category: ep.category.en }] });
      if (pathname.startsWith('/directory/platforms/')) return Response.json({ platform: { slug: 'images' }, capabilities: [{ id: 'images.generate', endpoints: [source] }] });
      if (pathname.startsWith('/directory/endpoints/')) return Response.json({ endpoint: source });
      if (pathname.startsWith('/budgets/')) { budgets.push(JSON.parse(options.body)); return Response.json({}); }
      if (pathname.startsWith('/usage/')) return Response.json({ key: 'user', rows: [{ value: 'fixture-user', charged_micro: charged }] });
      assert.equal(pathname, '/invoke/' + ep.id);
      calls.push(options); notifyCall();
      await release;
      if (timeout) await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      if (rejectCall) return Response.json({ error: 'generation_failed' }, { status: 500 });
      if (pending) return Response.json({ job: 'pending' }, { status: 202 });
      charged += 10000;
      const data = oversized ? [{ url: base + '/large.png' }] : invalidImage ? [{ b64_json: Buffer.from('not an image').toString('base64') }]
        : [{ b64_json: png.toString('base64') }, { url: base + '/image.png' }];
      return Response.json({ data }, { headers: { 'x-data-cost': '10000', 'x-data-id': 'image-' + calls.length } });
    } });
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('.png')) {
      downloadAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(req.url === '/large.png' ? Buffer.alloc(1025) : png); return;
    }
    await handler(req, res, new URL(req.url, 'http://local.test'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  base = `http://127.0.0.1:${server.address().port}`;
  const workspace = path.join(root, 'work'), headers = { authorization: 'Bearer fixture-personal', 'content-type': 'application/json' };
  const run = args => {
    const child = spawn('python3', ['-I', '-B', path.resolve('image/bin/wp-data'), ...args], {
      env: { ...process.env, HOME: root, PARTNER_GATEWAY_ORIGIN: base, WORKPARTNER_WORKSPACE: workspace },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => { try { assert.equal(stderr, ''); resolve({ code, result: JSON.parse(stdout) }); } catch (error) { reject(error); } });
    });
  };
  const cards = await (await fetch(base + '/_wp/data/catalog?platform=images', { headers })).json();
  assert.match(cards.tools[0].example.en, /image-standard/);
  assert.match(cards.tools[0].example.en, /A small green tree/);
  assert.equal(cards.tools[0].price.usd, .01);
  const groups = await (await fetch(base + '/_wp/data/tools', { headers })).json();
  assert.equal(groups.groups[0].name.en, 'Content generation');
  const skill = dataToolsSkill(catalog);
  assert.match(skill, /image-standard/); assert.match(skill, /Show the saved images/);
  let finished = false;
  const command = run(['call', 'generate-image', '--json', '{"prompt":"A small green tree"}']).then(value => { finished = true; return value; });
  await called;
  assert.equal(finished, false);
  assert.equal(charged, 0);
  assert.equal(fs.existsSync(workspace), false);
  releaseCall();
  const saved = await command;
  assert.equal(saved.code, 0);
  assert.deepEqual(JSON.parse(calls[0].body), { ...ep.defaults, prompt: 'A small green tree' });
  assert.equal(calls[0].headers['x-data-max'], '0.02');
  assert.deepEqual(budgets, [{ daily_cap_micro: 1000000, monthly_cap_micro: 5000000 }]);
  assert.equal(saved.result.costUsd, .01); assert.equal(saved.result.callId, 'image-1');
  assert.equal(saved.result.usage.daily.usedUsd, .01);
  assert.equal(saved.result.remainingTodayUsd, .99);
  assert.equal(saved.result.files.length, 2); assert.equal(saved.result.data, undefined);
  assert.equal(downloadAuth, undefined);
  for (const file of saved.result.files) {
    assert.ok(file.startsWith(path.join(workspace, 'outputs/images/')));
    assert.deepEqual(fs.readFileSync(file), png);
  }
  const override = await fetch(base + '/_wp/data/call/' + ep.id, { method: 'POST', headers, body: '{"prompt":"A tree","quality":"high"}' });
  assert.equal(override.status, 200);
  assert.equal(JSON.parse(calls.at(-1).body).quality, 'high');
  const count = calls.length;
  assert.equal((await fetch(base + '/_wp/data/call/' + ep.id, { method: 'POST', headers, body: '{"prompt":"A tree","secret":"no"}' })).status, 403);
  assert.equal(calls.length, count);
  const beforeFailure = charged;
  rejectCall = true;
  const failed = await run(['call', ep.id, 'prompt=Fail']);
  assert.equal(failed.code, 1); assert.equal(failed.result.files, undefined); assert.equal(failed.result.costUsd, undefined);
  assert.equal(charged, beforeFailure);
  rejectCall = false; pending = true;
  const queued = await run(['call', ep.id, 'prompt=Pending']);
  assert.equal(queued.code, 1); assert.match(queued.result.error, /Job pending/); assert.equal(charged, beforeFailure);
  pending = false; timeout = true;
  const timedOut = await run(['call', ep.id, 'prompt=Timeout']);
  assert.equal(timedOut.code, 1); assert.match(timedOut.result.error, /Outcome unknown/); assert.equal(charged, beforeFailure);
  timeout = false; oversized = true;
  const large = await run(['call', ep.id, 'prompt=Large']);
  assert.equal(large.code, 1); assert.match(large.result.fileError, /do not regenerate/);
  assert.equal(large.result.costUsd, .01); assert.equal(large.result.files.length, 0);
  oversized = false; invalidImage = true;
  const invalid = await run(['call', ep.id, 'prompt=Invalid']);
  assert.equal(invalid.code, 1); assert.equal(invalid.result.costUsd, .01);
  assert.deepEqual(invalid.result.files, []);
  assert.equal(fs.readdirSync(path.join(workspace, 'outputs/images')).length, 2);
});

test('catalog rejects defaults outside the parameter policy and unbounded waits or file results', t => {
  const { ep, catalog } = fixture(t);
  for (const policy of [{ defaults: { hidden: true } }, { timeoutMs: 600001 }, { timeoutMs: 0 },
    { fileResult: { path: 'data', urlField: 'url', maxBytes: 0, maxFiles: 1 } },
    { fileResult: { path: '../outside', urlField: 'url', maxBytes: 1024, maxFiles: 1 } }]) {
    const copy = structuredClone(catalog);
    Object.assign(copy.tools[0].endpoints[0], policy);
    assert.throws(() => parseDataTools(copy));
  }
  assert.equal(parseDataTools(catalog).tools[0].endpoints[0].id, ep.id);
});
