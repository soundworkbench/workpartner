import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { hubConfig, listHubTools } from '../gateway/organization/mcp-hub.mjs';
import { createMarketTools } from '../gateway/market-tools.mjs';

async function server(t, handler) {
  const service = http.createServer(handler);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(() => { service.closeAllConnections(); service.close(); });
  return `http://127.0.0.1:${service.address().port}/mcp`;
}
function temporary(t) { const dir = mkdtempSync(join(tmpdir(), 'mcp-check-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const key = 'test-person-secret';

test('All keeps platform order across recommended examples, pagination and platform filtering', async () => {
  // Minimal DOM surface: execute the actual host and data source and inspect rendered cards.
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.events = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get lastChild() { return this.children.at(-1); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, action) { this.events[name] = action; }
    click() { this.events.click?.(); }
  }
  const label = en => ({ en, zh: en });
  const platforms = ['first', 'second'].map(id => ({ id, name: label(id) }));
  const rows = Object.fromEntries(platforms.map(({ id }) => [id, Array.from({ length: 7 }, (_, index) => ({
    name: `${id}-${index}`, title: label(`${id}-${index}`), description: label('Description'),
    recommended: id === 'second' && index === 0, price: { kind: 'call', usd: 0.01 },
    ...(id === 'second' && index === 0 ? { example: label('Organization example') } : {}),
  }))]));
  let render, usedToday = 0; const tried = [], documentEvents = {};
  const window = { wpMarket: { register(name, callback) { assert.equal(name, 'tools'); render = callback; }, tryExample: (text, skill) => tried.push([text, skill]) } };
  const document = { hidden: false, createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    addEventListener: (name, action) => { documentEvents[name] = action; }, removeEventListener: (name, action) => { if (documentEvents[name] === action) delete documentEvents[name]; } };
  const context = { window, AbortController, document,
    fetch: async url => {
      const path = new URL(url, 'http://fixture');
      if (path.pathname === '/_wp/data/tools') return Response.json({ groups: [{ name: label('Research'), platforms }] });
      if (path.pathname === '/_wp/data/catalog') return Response.json({ tools: rows[path.searchParams.get('platform')] });
      if (path.pathname === '/_wp/data/usage') return Response.json({ daily: { limitUsd: 1, usedUsd: usedToday }, monthly: { limitUsd: 5, usedUsd: .39 } });
      assert.fail(`Unexpected request: ${url}`);
    } };
  for (const file of ['wp-tools.js', 'wp-data-tools.js']) {
    runInNewContext(readFileSync(new URL(`../image/rebrand/overlay/${file}`, import.meta.url), 'utf8'), context);
  }
  const host = new Element('main'), dispose = render(host, { locale: 'en-US' });
  try {
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await settle();
    const cards = host.children.find(node => node.className.includes('wp-data-cards'));
    const filters = host.children.find(node => node.className === 'wp-data-platforms');
    const more = host.children.find(node => node.className.includes('wp-data-more'));
    const names = () => Array.from(cards.children, node => node.dataset.tool);
    // The allowance shows what was spent; sub-cent amounts stay visible and refresh when the browser tab is visible again.
    const usage = host.children[0].children.find(node => node.className === 'wp-data-usage');
    const text = node => node.textContent ?? node.children.map(text).join('');
    const quota = () => usage.children.map(block => text(block.children[0]));
    assert.deepEqual(quota(), ['Today used $0.00 · $1.00 left of $1.00', 'This month used $0.39 · $4.61 left of $5.00']);
    usedToday = .0012; document.hidden = true; documentEvents.visibilitychange(); await settle();
    assert.equal(quota()[0], 'Today used $0.00 · $1.00 left of $1.00');
    document.hidden = false; documentEvents.visibilitychange(); await settle();
    assert.deepEqual(quota(), ['Today used $0.0012 · $0.9988 left of $1.00', 'This month used $0.39 · $4.61 left of $5.00']);
    const expected = [...Object.keys(rows).flatMap(id => rows[id].map(row => row.name))];
    assert.deepEqual(names(), expected.slice(0, 12));
    // Every card offers Try it on its price row; organization examples win over the card-built draft.
    for (const card of cards.children) {
      const [price, action] = card.children[2].children;
      assert.equal(price.className, 'wp-data-price'); assert.equal(action.textContent, 'Try it'); action.click();
    }
    // Data cards draft with the generated data skill selected, before the example text.
    assert.deepEqual(tried[0], ['Use “first-0” to description', 'data-tools']); assert.deepEqual(tried[7], ['Organization example', 'data-tools']);
    assert.equal(more.hidden, false);
    more.click();
    assert.deepEqual(names(), expected);
    assert.equal(more.hidden, true);
    filters.children.find(button => button.textContent === 'second').click(); await settle();
    assert.deepEqual(names(), rows.second.map(row => row.name));
    filters.children.find(button => button.textContent === 'All').click(); await settle();
    assert.deepEqual(names(), expected.slice(0, 12));
  } finally { dispose(); }
  assert.equal(documentEvents.visibilitychange, undefined);
});

test('hub cards draft without a skill unless the organization configures one', async () => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.events = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get lastChild() { return this.children.at(-1); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, action) { this.events[name] = action; }
    click() { this.events.click?.(); }
  }
  const label = en => ({ en, zh: en }), platform = { id: 'library', name: label('Library') };
  async function tryHubCard(market) {
    let render; const tried = [];
    const window = { wpMarket: { register(name, callback) { render = callback; }, tryExample: (text, skill) => tried.push([text, skill]) } };
    const context = { window, AbortController, document: { createElement: tag => new Element(tag) },
      fetch: async url => { assert.equal(url, '/_wp/market/tools'); return Response.json(market); } };
    for (const file of ['wp-tools.js', 'wp-mcp-tools.js']) {
      runInNewContext(readFileSync(new URL(`../image/rebrand/overlay/${file}`, import.meta.url), 'utf8'), context);
    }
    const host = new Element('main'), dispose = render(host, { locale: 'en-US' });
    try {
      await new Promise(resolve => setImmediate(resolve));
      const cards = host.children.find(node => node.className.includes('wp-data-cards'));
      cards.children[0].children[2].children[1].click();
      return tried;
    } finally { dispose(); }
  }
  const market = { groups: [{ name: label('Research'), platforms: [platform] }],
    tools: [{ name: 'library__find', category: 'Research', platform, included: true, title: label('Find'), description: label('Find references'), example: label('Find a reference') }] };
  // Without a configured skill the draft keeps only the example text.
  assert.deepEqual(await tryHubCard(market), [['Find a reference', '']]);
  assert.deepEqual(await tryHubCard({ ...market, skill: 'library-guide' }), [['Find a reference', 'library-guide']]);
});

test('root hub discovery preserves 12 tool names, session, auth, pagination and SSE', async t => {
  const seen = [];
  const url = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks)); seen.push(message.method);
    assert.equal(req.url, '/mcp'); assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (message.method !== 'initialize') assert.equal(req.headers['mcp-session-id'], 'probe-session');
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
      : { tools: Array.from({ length: 6 }, (_, i) => ({ name: `server__tool_${i + (message.params.cursor ? 6 : 0)}`, description: 'One line' })),
          ...(message.params.cursor ? {} : { nextCursor: 'second' }) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'probe-session' });
    // Keep the SSE response open: discovery must finish on its matching JSON-RPC frame.
    res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\r\n\r\n`);
  });
  const rows = await listHubTools(hubConfig({ url, keyEnvironment: 'PERSON_KEY' }), key);
  assert.equal(rows.length, 12); assert.equal(rows[11].name, 'server__tool_11');
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
});

test('disabled hub does no network work; forbidden and stalled hubs are bounded', async t => {
  const absent = await listHubTools(null, key, { fetch() { assert.fail('no network'); } }); assert.deepEqual(absent, []);
  let forbidden = true;
  const url = await server(t, (req, res) => { if (forbidden) { res.writeHead(403); res.end(key); } });
  await assert.rejects(listHubTools({ url }, key), /^Error: MCP hub denied$/);
  forbidden = false;
  await assert.rejects(listHubTools({ url }, key, { timeoutMs: 50 }), { name: 'TimeoutError' });
  assert.throws(() => hubConfig({ url: 'https://user:secret@example.com/mcp', keyEnvironment: 'PERSON_KEY' }));
  assert.throws(() => hubConfig({ url: 'https://example.com/mcp?key=secret', keyEnvironment: 'PERSON_KEY' }));
});

test('hidden configuration requires exact qualified names', () => {
  const config = { url: 'https://example.com/mcp', keyEnvironment: 'PERSON_KEY' };
  for (const hidden of [[], ['search__web_search', 'search__web_fetch']]) {
    assert.deepEqual(hubConfig({ ...config, hidden }).hidden, hidden);
  }
  for (const hidden of [null, 'search__web_search', {}, [1], [''], ['web_search'], ['search__*'], ['search__web_search\n']]) {
    assert.throws(() => hubConfig({ ...config, hidden }), /^Error: Invalid MCP hub configuration$/);
  }
});

test('market hides exact names only while engine discovery retains every tool', async t => {
  const names = ['search__web_search', 'search__web_fetch', 'image__generate_image', 'other__web_search'];
  const tools = names.map(name => ({ name, description: 'One line' }));
  const url = await server(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks));
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  let route;
  const base = await server(t, async (req, res) => { await route(req, res, new URL(req.url, 'http://local')); });
  for (const [hidden, visible] of [
    [undefined, names],
    [['search__web_search', 'search__web_fetch', 'missing__tool', 'IMAGE__generate_image'], names.slice(2)],
    [names, []],
    [[], names],
  ]) {
    const config = hubConfig({ url, keyEnvironment: 'PERSON_KEY', ...(hidden === undefined ? {} : { hidden }) });
    route = createMarketTools({ organization: { mcpHub: config }, authenticate: () => ({ slug: 'person' }), keyFor: () => key });
    const response = await fetch(base.replace('/mcp', '/_wp/market/tools'));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).tools.map(tool => tool.name), visible);
    assert.deepEqual((await listHubTools(config, key)).map(tool => tool.name), names);
  }
});

test('managed configuration is repeatable, preserves personal bytes, removes stale entries and never stores key', t => {
  const home = temporary(t); mkdirSync(join(home, '.codex'));
  const personalToml = '# personal bytes\nmodel = "my-model"\n[mcp_servers.personal]\ncommand = "mine"\n';
  const personalJson = '{\n "theme" : "dark", "mcpServers" : { "personal" : {"type":"stdio", "command":"mine"} }, "tail" : [1, 2] }\n';
  writeFileSync(join(home, '.codex/config.toml'), personalToml); writeFileSync(join(home, '.claude.json'), personalJson);
  const config = { name: 'workpartner-hub', url: 'https://example.com/mcp', keyEnvironment: 'PERSON_KEY' };
  const run = (enabled, selected = config) => {
    const result = spawnSync('python3', ['-I', 'image/bin/wp-mcp-config.py'], { input: JSON.stringify({ home, config: selected, enabled }), env: { ...process.env, PERSON_KEY: key }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return [readFileSync(join(home, '.codex/config.toml'), 'utf8'), readFileSync(join(home, '.claude.json'), 'utf8')];
  };
  const first = run(true); assert.deepEqual(run(true), first);
  assert.ok(first[0].startsWith(personalToml));
  assert.ok(first[1].includes('"personal" : {"type":"stdio", "command":"mine"}'));
  assert.ok(first[1].includes('"theme" : "dark"')); assert.ok(first[1].includes('"tail" : [1, 2]'));
  assert.ok(!first.join('').includes(key));
  const claude = JSON.parse(first[1]); assert.equal(claude.mcpServers['workpartner-hub'].alwaysLoad, true);
  assert.ok(claude.mcpServers['workpartner-hub'].headersHelper.endsWith(' PERSON_KEY'));
  const renamed = run(true, { ...config, name: 'new-hub' }); assert.ok(!renamed.join('').includes('workpartner-hub'));
  const removed = run(false, null); assert.equal(removed[0], personalToml);
  assert.deepEqual(JSON.parse(removed[1]), JSON.parse(personalJson)); assert.deepEqual(run(false, null), removed);
  // A conflicting personal entry in either engine prevents changes to both.
  writeFileSync(join(home, '.claude.json'), '{"mcpServers":{"workpartner-hub":{"command":"personal"}}}');
  const result = spawnSync('python3', ['-I', 'image/bin/wp-mcp-config.py'], { input: JSON.stringify({ home, config, enabled: true }), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.ok(!result.stderr.includes(key)); assert.equal(readFileSync(join(home, '.codex/config.toml'), 'utf8'), personalToml);
});

test('dynamic header helper supplies only the environment credential to Claude', () => {
  const result = spawnSync('python3', ['-I', 'image/bin/wp-mcp-headers.py', 'PERSON_KEY'], { env: { ...process.env, PERSON_KEY: key }, encoding: 'utf8' });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), { Authorization: `Bearer ${key}` }); assert.equal(result.stderr, '');
});

test('market is authenticated, read-only, personal, localized, sanitized and uncached', async t => {
  const directory = temporary(t);
  writeFileSync(join(directory, 'labels.json'), JSON.stringify({ server__tool: { zh: { name: '工具名称', description: '一句话说明' }, en: { name: 'Tool name', description: 'One line' } } }));
  let keys = [];
  const route = createMarketTools({ organization: { directory, mcpHub: { url: 'https://example.com/mcp', keyEnvironment: 'PERSON_KEY', displayNames: 'labels.json' } },
    authenticate: req => req.headers['x-test-user'] ? { slug: req.headers['x-test-user'] } : null,
    keyFor: user => `secret-${user.slug}`,
    discover: async (config, token) => { keys.push(token); if (token === 'secret-denied') throw new Error('MCP hub denied'); if (token === 'secret-error') throw new Error(token);
      return [{ name: 'server__tool', description: 'raw' }, { name: 'server__fallback', description: `First line ${token}\nSecond line`, inputSchema: { secret: token } }]; } });
  const base = await server(t, async (req, res) => { if (!await route(req, res, new URL(req.url, 'http://local'))) { res.writeHead(404); res.end(); } });
  const request = (user, method = 'GET') => fetch(base.replace('/mcp', '/_wp/market/tools'), { method, headers: user ? { 'x-test-user': user } : {} });
  assert.equal((await request()).status, 401); assert.equal((await request('one', 'POST')).status, 405); assert.deepEqual(keys, []);
  const first = await request('one'); assert.equal(first.headers.get('cache-control'), 'no-store');
  const text = await first.text(), data = JSON.parse(text);
  assert.equal(data.tools[0].title.zh, '工具名称'); assert.equal(data.tools[0].title.en, 'Tool name');
  assert.equal(data.tools[1].title.en, 'server__fallback'); assert.equal(data.tools[1].description.en, 'First line [redacted]');
  assert.ok(!text.includes('secret-one')); assert.ok(!text.includes('inputSchema')); assert.ok(!text.includes('Second line'));
  await request('two'); assert.deepEqual(keys, ['secret-one', 'secret-two']);
  assert.deepEqual((await (await request('denied')).json()).tools, []);
  assert.equal((await (await request('error')).json()).error, 'temporarily_unavailable');
});

test('assembled image starts discovery, then removes entries after denial without storing credentials', async t => {
  const { materializeNext } = await import('../gateway/organization/materialize-next.mjs');
  const { cpSync } = await import('node:fs');
  const directory = temporary(t), context = join(directory, 'context'), home = join(directory, 'home'), org = join(directory, 'org');
  mkdirSync(join(context, 'image'), { recursive: true }); mkdirSync(home); mkdirSync(org);
  cpSync(new URL('../image/bin', import.meta.url), join(context, 'image/bin'), { recursive: true });
  cpSync(new URL('../image/home', import.meta.url), join(context, 'image/home'), { recursive: true });
  let authorized = true;
  const url = await server(t, async (req, res) => {
    if (!authorized) { res.writeHead(403); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { tools: [{ name: 'server__tool' }] };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  // Hiding every market entry must not disable either engine's hub connection.
  writeFileSync(join(org, 'organization.json'), JSON.stringify({ mcpHub: { url, keyEnvironment: 'PERSON_KEY', hidden: ['server__tool'] } }));
  // Neutral assets remain organization-owned inputs, copied here only for this disposable assembly.
  cpSync(new URL('../org/default/appearance', import.meta.url), join(org, 'appearance'), { recursive: true });
  materializeNext(context, { WORKPARTNER_ORG_DIR: org });
  cpSync(join(context, 'organization'), join(context, 'image/organization'), { recursive: true });
  const { spawn } = await import('node:child_process');
  async function start() {
    const child = spawn(process.execPath, [join(context, 'image/bin/wp-mcp-start.mjs')], {
      env: { ...process.env, HOME: home, WORKPARTNER_ORG_DIR: join(context, 'organization/selected'), PERSON_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    assert.equal((await once(child, 'exit'))[0], 0); assert.ok(!output.includes(key)); return output;
  }
  await start(); const first = readFileSync(join(home, '.claude.json'), 'utf8');
  assert.ok(JSON.parse(first).mcpServers['workpartner-hub']);
  assert.ok(readFileSync(join(home, '.codex/config.toml'), 'utf8').includes('[mcp_servers.workpartner-hub]'));
  await start(); assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), first);
  authorized = false; assert.match(await start(), /disabled/);
  assert.ok(!readFileSync(join(home, '.codex/config.toml'), 'utf8').includes('mcp_servers'));
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers, {});
});


test('market uses organization categories, platform labels, defaults and optional examples, including empty and retry groups', async t => {
  const directory = temporary(t);
  writeFileSync(join(directory, 'data.json'), JSON.stringify({ schemaVersion: 1, categories: [{ en: 'Research', zh: '研究' }],
    platforms: [], directory: { platformsPath: '/platforms', platformPath: '/platform/{id}', endpointPath: '/endpoint/{id}', searchPath: '/search', blockedEndpoints: [], blockedProviders: [] }, tools: [] }));
  const shared = { id: 'library', name: { en: 'Library', zh: '资料库' } }, media = { id: 'media', name: { en: 'Media', zh: '媒体' } };
  const config = { url: 'https://example.com/mcp', keyEnvironment: 'PERSON_KEY', defaultCategory: 'Creation',
    categories: [{ en: 'Creation', zh: '内容创作' }], platform: media,
    tools: { library__find: { category: 'Research', platform: shared, example: { en: 'Find a reference', zh: '查找参考资料' } }, hidden__tool: { category: 'Research' } }, hidden: ['hidden__tool'] };
  let mode = 'ok';
  const organization = { directory, dataTools: { catalog: 'data.json' }, mcpHub: config };
  const route = createMarketTools({ organization, authenticate: () => ({ slug: 'person' }), keyFor: () => key,
    discover: async () => { if (mode === 'failed') throw new Error('offline'); if (mode === 'empty') return []; return ['library__find', 'media__render', 'hidden__tool'].map(name => ({ name })); } });
  const base = await server(t, async (req, res) => { await route(req, res, new URL(req.url, 'http://local')); });
  const read = async () => { const response = await fetch(base.replace('/mcp', '/_wp/market/tools')); return { status: response.status, ...await response.json() }; };
  const value = await read();
  assert.deepEqual(value.groups.map(group => group.name.en), ['Research', 'Creation']);
  assert.deepEqual(value.tools.map(tool => tool.category), ['Research', 'Creation']);
  assert.deepEqual(value.tools.map(tool => tool.platform), [shared, media]);
  assert.ok(value.tools.every(tool => tool.included)); assert.equal(value.tools[0].example.zh, '查找参考资料'); assert.equal(value.tools[1].example, undefined);
  assert.equal(value.skill, undefined);
  mode = 'empty'; const empty = await read(); assert.deepEqual(empty.tools, []); assert.equal(empty.groups[0].name.en, 'Creation');
  mode = 'failed'; const failed = await read(); assert.equal(failed.status, 503); assert.deepEqual(failed.groups.map(group => group.name.en), ['Creation', 'Research']);
  assert.throws(() => createMarketTools({ organization: { ...organization, mcpHub: { ...config, defaultCategory: 'Unknown' } } }), /Unknown MCP market category/);
  assert.throws(() => hubConfig({ ...config, tools: { media__render: { platform: { id: 'bad', name: { en: 'Only English' } } } } }), /Invalid MCP market presentation/);
  for (const skill of ['', 'Guide', 'guide skill', '../guide', 1]) assert.throws(() => hubConfig({ ...config, skill }), /Invalid MCP market presentation/);
  const configured = createMarketTools({ organization: { ...organization, mcpHub: { ...config, skill: 'library-guide' } }, authenticate: () => ({ slug: 'person' }), keyFor: () => key,
    discover: async () => [{ name: 'library__find' }] });
  const skilled = await server(t, async (req, res) => { await configured(req, res, new URL(req.url, 'http://local')); });
  assert.equal((await (await fetch(skilled.replace('/mcp', '/_wp/market/tools'))).json()).skill, 'library-guide');
});
