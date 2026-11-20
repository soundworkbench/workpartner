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
  const context = {
    window: { wpMarket: { register(name, callback) { assert.equal(name, 'skills'); render = callback; }, tryExample() {} }, confirm: () => true },
    AbortController, document: { createElement: tag => new Element(tag) },
    fetch: async (url, options) => {
      if (url === '/_wp/market/skills' && !options?.method) return Response.json({ skills: personal });
      if (url === '/_wp/market/shared' && !options?.method) return Response.json({ submissionsEnabled: false, company, mine: [], isApprover: false });
      if (options?.method === 'POST') return Response.json(postResult || { name: company[0].name, installed: true, changed: true });
      assert.fail(`Unexpected request: ${url}`);
    },
  };
  runInNewContext(readFileSync(new URL('../image/rebrand/overlay/wp-skills.js', import.meta.url), 'utf8'), context);
  const host = new Element('main'), dispose = render(host, { locale });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { host, dispose, card: find(host, 'wp-skills-section')[1] && find(find(host, 'wp-skills-section')[1], 'wp-skill-card')[0] };
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
