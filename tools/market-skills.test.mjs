import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Minimal DOM surface: execute the actual skills renderer and read the official cards.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  prepend(node) { this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener() {}
  querySelectorAll() { return []; }
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
