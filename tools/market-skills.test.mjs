import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Minimal DOM surface: execute the actual skills renderer and read the official cards.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.parentNode = null; this.hidden = false; this.classList = { toggle() {} }; }
  append(...nodes) { nodes.forEach(node => { node.parentNode = this; this.children.push(node); }); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  prepend(node) { this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  click() { for (const callback of this.listeners.click || []) callback({}); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  querySelectorAll(selector) {
    const all = node => [node, ...node.children.flatMap(child => all(child))];
    const nodes = all(this);
    return selector === 'button' ? nodes.filter(node => node.tagName === 'button') : selector.startsWith('.') ? nodes.filter(node => node.className === selector.slice(1)) : [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  showModal() {}
  close() { for (const callback of this.listeners.close || []) callback({}); }
}
const find = (node, className) => node.className === className ? [node] : node.children.flatMap(child => find(child, className));

async function officialCards(locale) {
  let render;
  const skills = [{ id: 'data-tools', name: 'data-tools', description: 'Use external data.', preinstalled: true, shared: false,
    displayName: '外部数据', displayDescription: '查询外部数据。', source: { name: 'Example Data', url: 'https://data.example.com/about' } }];
  const context = {
    window: { wpMarket: { register(name, callback) { assert.equal(name, 'skills'); render = callback; } } },
    AbortController, document: { createElement: tag => new Element(tag) },
    fetch: async url => {
      if (url === '/_wp/market/skills') return Response.json({ skills });
      if (url === '/_wp/market/shared') return Response.json({ submissionsEnabled: false, company: [], mine: [], isApprover: false });
      assert.fail(`Unexpected request: ${url}`);
    },
  };
  runInNewContext(readFileSync(new URL('../image/rebrand/overlay/wp-skills.js', import.meta.url), 'utf8'), context);
  const host = new Element('main'), dispose = render(host, { locale });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const official = find(host, 'wp-skills-section')[0];
    return find(official, 'wp-skill-card').map(card => ({
      name: find(card, 'wp-skill-name')[0].textContent, description: find(card, 'wp-skill-description')[0].textContent,
      source: find(card, 'wp-skill-source').map(node => ({ label: node.textContent, text: node.children[0].textContent,
        href: node.children[0].href, target: node.children[0].target, rel: node.children[0].rel }))[0],
    }));
  } finally { dispose(); }
}

test('official skills use translated names in Chinese and their own names in English', async () => {
  const link = { href: 'https://data.example.com/about', target: '_blank', rel: 'noopener noreferrer' };
  assert.deepEqual(await officialCards('zh-CN'), [{ name: '外部数据', description: '查询外部数据。',
    source: { label: '数据来源：', text: 'Example Data（data.example.com）', ...link } }]);
  assert.deepEqual(await officialCards('en-US'), [{ name: 'data-tools', description: 'Use external data.',
    source: { label: 'Source: ', text: 'Example Data (data.example.com)', ...link } }]);
});

async function companyView(locale, personal, company, postResult) {
  let render;
  let currentPersonal = personal.slice(), refreshes = 0, posts = 0;
  const context = {
    window: { wpMarket: { register(name, callback) { assert.equal(name, 'skills'); render = callback; }, tryExample() {} }, confirm: () => true },
    AbortController, document: { createElement: tag => new Element(tag) },
    fetch: async (url, options) => {
      if (url === '/_wp/market/skills' && !options?.method) { refreshes++; return Response.json({ skills: currentPersonal }); }
      if (url === '/_wp/market/shared' && !options?.method) { refreshes++; return Response.json({ submissionsEnabled: false, company, mine: [], isApprover: false }); }
      if (options?.method === 'POST') {
        posts++;
        if (typeof postResult === 'function') return postResult(posts, currentPersonal, value => { currentPersonal = value; });
        currentPersonal = [{ name: company[0].name, id: company[0].name, shared: true, preinstalled: false, description: company[0].description }];
        return Response.json(postResult || { name: company[0].name, installed: true, changed: true });
      }
      if (options?.method === 'DELETE') { currentPersonal = []; return Response.json({ shared: true, installed: false }); }
      assert.fail(`Unexpected request: ${url}`);
    },
  };
  runInNewContext(readFileSync(new URL('../image/rebrand/overlay/wp-skills.js', import.meta.url), 'utf8'), context);
  const host = new Element('main'), dispose = render(host, { locale });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { host, dispose, card: find(host, 'wp-skills-section')[1] && find(find(host, 'wp-skills-section')[1], 'wp-skill-card')[0], refreshes: () => refreshes };
}

async function concurrentCompanyView() {
  let render;
  const company = [{ name: 'meeting-notes', displayName: '会议整理', description: '整理会议', author: '作者', installs: 0 }];
  const installed = [{ name: 'meeting-notes', id: 'meeting-notes', shared: true, preinstalled: false, description: 'Mine' }];
  const batches = { old: [], latest: [] };
  let reads = 0;
  const response = (url, personal) => url === '/_wp/market/skills'
    ? Response.json({ skills: personal })
    : Response.json({ submissionsEnabled: false, company, mine: [], isApprover: false });
  const context = {
    window: { wpMarket: { register(name, callback) { assert.equal(name, 'skills'); render = callback; }, tryExample() {} }, confirm: () => true },
    AbortController, document: { createElement: tag => new Element(tag) },
    fetch: async (url, options) => {
      if (!options?.method) {
        reads++;
        if (reads <= 2) return response(url, []);
        const batch = reads <= 4 ? batches.old : batches.latest;
        return new Promise((resolve, reject) => batch.push({ url, resolve, reject }));
      }
      if (options.method === 'POST') return Response.json({ name: company[0].name, installed: true, changed: true });
      assert.fail(`Unexpected request: ${url}`);
    },
  };
  runInNewContext(readFileSync(new URL('../image/rebrand/overlay/wp-skills.js', import.meta.url), 'utf8'), context);
  const host = new Element('main'), dispose = render(host, { locale: 'zh-CN' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const card = find(host, 'wp-skills-section')[1] && find(find(host, 'wp-skills-section')[1], 'wp-skill-card')[0];
  return { host, dispose, card, batches, installed, response };
}

async function waitForBatch(batch) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (batch.length === 2) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('load batch was not started');
}

function settleBatch(batch, view, personal, error) {
  batch.forEach(request => error ? request.reject(new Error('旧请求失败')) : request.resolve(view.response(request.url, personal)));
}

test('company install changes the card immediately and same-name personal skills suppress install', async () => {
  const company = [{ name: 'meeting-notes', displayName: '会议整理', description: '整理会议', author: '作者', installs: 0 }];
  const view = await companyView('zh-CN', [], company);
  try {
    const install = find(view.card, 'wp-skill-action')[0];
    install.click();
    assert.equal(install.textContent, '正在处理…');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(find(view.card, 'wp-skill-action').length, 0);
    assert.equal(find(view.card, 'wp-skill-badge')[0].textContent, '已安装');
  } finally { view.dispose(); }

  const conflict = await companyView('en-US', [{ name: 'meeting-notes', shared: false, preinstalled: false, description: 'Mine' }], company);
  try {
    assert.equal(find(conflict.card, 'wp-skill-action').length, 0);
    assert.match(find(conflict.card, 'wp-skills-error')[0].textContent, /personal skill/);
  } finally { conflict.dispose(); }
});

test('successful card actions refresh the whole market and uninstall removes the company badge', async () => {
  const company = [{ name: 'meeting-notes', displayName: '会议整理', description: '整理会议', author: '作者', installs: 0 }];
  const installed = await companyView('zh-CN', [{ name: 'meeting-notes', id: 'meeting-notes', shared: true, preinstalled: false, description: 'Mine' }], company);
  try {
    const mine = find(installed.host, 'wp-skills-section')[2];
    const remove = find(mine, 'wp-skill-delete')[0];
    remove.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(find(installed.host, 'wp-skills-section')[1] && find(find(installed.host, 'wp-skills-section')[1], 'wp-skill-badge')[0].textContent, '公司技能');
    assert.ok(installed.refreshes() >= 4, `expected initial and post-action table loads, got ${installed.refreshes()}`);
  } finally { installed.dispose(); }
});

test('a late older load cannot replace the newer market result', async () => {
  const view = await concurrentCompanyView();
  try {
    find(view.card, 'wp-skill-action')[0].click();
    await waitForBatch(view.batches.old);
    find(view.host, 'wp-skills-retry')[0].click();
    await waitForBatch(view.batches.latest);
    settleBatch(view.batches.latest, view, view.installed);
    await new Promise(resolve => setImmediate(resolve));
    const current = () => find(find(view.host, 'wp-skills-section')[1], 'wp-skill-card')[0];
    assert.equal(find(current(), 'wp-skill-badge')[0].textContent, '已安装');
    settleBatch(view.batches.old, view, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(find(current(), 'wp-skill-badge')[0].textContent, '已安装');
    assert.equal(find(current(), 'wp-skill-action').length, 0);
  } finally { view.dispose(); }
});

test('a late older load failure does not show an error or replace the newer result', async () => {
  const view = await concurrentCompanyView();
  try {
    find(view.card, 'wp-skill-action')[0].click();
    await waitForBatch(view.batches.old);
    find(view.host, 'wp-skills-retry')[0].click();
    await waitForBatch(view.batches.latest);
    settleBatch(view.batches.latest, view, view.installed);
    await new Promise(resolve => setImmediate(resolve));
    settleBatch(view.batches.old, view, [], true);
    await new Promise(resolve => setImmediate(resolve));
    const current = () => find(find(view.host, 'wp-skills-section')[1], 'wp-skill-card')[0];
    assert.equal(find(current(), 'wp-skill-badge')[0].textContent, '已安装');
    assert.equal(find(view.host, 'wp-skills-status')[0].textContent, '');
  } finally { view.dispose(); }
});

test('deleting a same-name personal skill removes the company conflict after refresh', async () => {
  const company = [{ name: 'meeting-notes', displayName: '会议整理', description: '整理会议', author: '作者', installs: 0 }];
  const conflict = await companyView('zh-CN', [{ name: 'meeting-notes', id: 'meeting-notes', shared: false, preinstalled: false, description: 'Mine' }], company);
  try {
    const mine = find(conflict.host, 'wp-skills-section')[2];
    find(mine, 'wp-skill-delete')[0].click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const companyCard = find(conflict.host, 'wp-skills-section')[1];
    assert.equal(find(companyCard, 'wp-skills-error').length, 0);
    assert.equal(find(companyCard, 'wp-skill-action').length, 1);
  } finally { conflict.dispose(); }
});

test('a failed card action shows its error and the next attempt clears it', async () => {
  const company = [{ name: 'meeting-notes', displayName: '会议整理', description: '整理会议', author: '作者', installs: 0 }];
  const view = await companyView('zh-CN', [], company, (attempt, current, setPersonal) => {
    if (attempt === 1) return Response.json({ message: '安装失败', error: 'exists' }, { status: 409 });
    setPersonal([{ name: 'meeting-notes', id: 'meeting-notes', shared: true, preinstalled: false, description: 'Mine' }]);
    return Response.json({ name: 'meeting-notes', installed: true, changed: true });
  });
  try {
    let card = view.card, install = find(card, 'wp-skill-action')[0];
    install.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(find(card, 'wp-skills-error')[0].textContent, /安装失败/);
    install = find(card, 'wp-skill-action')[0]; install.click();
    assert.equal(find(card, 'wp-skills-error').length, 0);
  } finally { view.dispose(); }
});
