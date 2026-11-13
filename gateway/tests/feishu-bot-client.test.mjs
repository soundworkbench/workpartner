import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { feishuBotClient } from '../feishu-bot-client.mjs';

// Small DOM stand-in for the client's card interactions; no layout or browser defaults.
function homeDocument() {
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {};
      this.listeners = {}; this.className = ''; this.style = {};
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get nextElementSibling() { const siblings = this.parentElement?.children || []; return siblings[siblings.indexOf(this) + 1]; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.text = value; this.replaceChildren(); }
    append(...elements) { for (const element of elements) { element.remove(); element.parentElement = this; this.children.push(element); } }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null;
      }
    }
    after(element) {
      const parent = this.parentElement; element.remove(); element.parentElement = parent;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, element);
    }
    replaceChildren(...elements) { for (const child of [...this.children]) child.remove(); this.append(...elements); }
    contains(element) { return this === element || this.children.some(child => child.contains(element)); }
    matches(selectors) {
      return selectors.split(',').some(value => {
        const selector = value.trim();
        if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
        if (selector.startsWith('[')) {
          const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          return match && match[1] in this.attributes && (match[2] === undefined || this.attributes[match[1]] === match[2]);
        }
        return this.tagName === selector.toUpperCase();
      });
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
    focus() { document.activeElement = this; }
    async fire(type, event = {}) { for (const callback of this.listeners[type] || []) await callback(event); }
  }
  document = {
    body: new Element('body'), head: new Element('head'),
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelector: selector => document.body.querySelector(selector), querySelectorAll: selector => document.body.querySelectorAll(selector),
  };
  const composer = new Element('div'), input = new Element('input');
  input.setAttribute('data-testid', 'guid-input'); composer.append(input); document.body.append(composer);
  return document;
}

function page({ home = false } = {}) {
  const timers = new Map(), frames = new Map(), listeners = {}, requests = [], tags = [];
  let mutation, disconnected = false;
  let nextTimer = 0, status = 200;
  const document = home ? homeDocument() : { head: { append() {} }, body: {},
    createElement: tag => { tags.push(tag); return { remove() {} }; }, querySelector: () => null, querySelectorAll: () => [] };
  Object.assign(document, { hidden: false, readyState: 'complete',
    addEventListener: (name, callback) => { listeners[name] = callback; },
    removeEventListener: name => { delete listeners[name]; } });
  const context = vm.createContext({ document, window: { addEventListener() {}, removeEventListener() {} },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() { disconnected = true; } },
    requestAnimationFrame: callback => { const id = ++nextTimer; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    queueMicrotask, navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => { requests.push({ url, options }); return { status, ok: status === 200,
      json: async () => ({ bots: home ? [{ appId: 'cli_Test', name: '助手', online: 'online', openUrl: '#' }] : [] }) }; },
  });
  vm.runInContext(feishuBotClient(), context);
  return { timers, frames, requests, tags, document, listeners, mutate: () => mutation(), disconnected: () => disconnected, status: value => { status = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function tick(p) {
  const [id, timer] = p.timers.entries().next().value; p.timers.delete(id); await timer.callback(); await settle();
}

test('serialized client loads once, polls every 60 seconds and pauses while hidden', async () => {
  const p = page(); await settle();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url, '/_wp/feishu-bot/bots');
  assert.equal(p.requests[0].options.credentials, 'same-origin');
  assert.equal(p.requests[0].options.cache, 'no-store');
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
  await tick(p); assert.equal(p.requests.length, 2);
  p.document.hidden = true; p.listeners.visibilitychange();
  assert.equal(p.timers.size, 0); assert.equal(p.requests.length, 2);
  p.document.hidden = false; p.listeners.visibilitychange(); await settle();
  assert.equal(p.requests.length, 3);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
});

for (const status of [401, 404]) test(`serialized client stops polling after admission is revoked (${status})`, async () => {
  const p = page(); await settle(); p.status(status); await tick(p);
  assert.equal(p.timers.size, 0); assert.equal(p.requests.length, 2);
  p.listeners.visibilitychange?.(); await settle(); assert.equal(p.requests.length, 2);
  assert.equal(p.disconnected(), true);
});

test('transient failure retries on the next visible 60-second cycle', async () => {
  const p = page(); await settle(); p.status(503); await tick(p);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
  p.status(200); await tick(p); assert.equal(p.requests.length, 3);
});

test('an in-flight initial request finishing while hidden does not start polling', async () => {
  const p = page(); p.document.hidden = true; p.listeners.visibilitychange(); await settle();
  assert.equal(p.requests.length, 1); assert.equal(p.timers.size, 0);
});

test('mutation bursts coalesce to one frame and revocation cancels queued mounts', async () => {
  const p = page(); await settle();
  for (let i = 0; i < 20; i++) await p.mutate();
  assert.equal(p.frames.size, 1);
  const [id, callback] = [...p.frames][0]; p.frames.delete(id); await callback();
  await p.mutate(); assert.equal(p.frames.size, 1);
  p.status(404); await tick(p);
  assert.equal(p.frames.size, 0); assert.equal(p.disconnected(), true);
});

test('copy then Escape then reconnect survives native focusout before the next button receives focus', async () => {
  const p = page({ home: true }); await settle();
  const find = text => p.document.querySelectorAll('button').find(button => button.textContent === text);
  const click = text => find(text).fire('click');
  await click('…'); await click('复制 App ID');
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '已复制 App ID');
  await click('…');
  await p.document.querySelector('.wp-feishu-bot-menu').fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(p.document.querySelector('.wp-feishu-bot-menu'), null);
  await click('…');
  const menu = p.document.querySelector('.wp-feishu-bot-menu'), reconnect = find('重新连接');
  // Native focusout can run a microtask checkpoint while activeElement is body.
  // relatedTarget already identifies the button that will receive focus next.
  p.document.activeElement = p.document.body;
  await menu.fire('focusout', { relatedTarget: reconnect });
  assert.equal(menu.isConnected, true, 'moving within the card must not remove the menu before click');
  reconnect.focus(); await reconnect.fire('click');
  const card = p.document.querySelector('.wp-feishu-bot-card');
  const confirmation = card.querySelector('[data-wp-feishu-bot-confirm]');
  assert.ok(confirmation?.isConnected);
  await p.mutate(); const [id, mount] = [...p.frames][0]; p.frames.delete(id); await mount();
  await p.listeners.visibilitychange(); await settle();
  assert.equal(card.querySelector('[data-wp-feishu-bot-confirm]'), confirmation, 'mount and background refresh preserve confirmation');
  await click('取消'); assert.equal(card.querySelector('[data-wp-feishu-bot-confirm]'), null);
  assert.equal(p.requests.some(request => request.options.method === 'POST'), false);
  await click('…');
  await p.document.querySelector('.wp-feishu-bot-menu').fire('focusout', { relatedTarget: p.document.body });
  assert.equal(p.document.querySelector('.wp-feishu-bot-menu'), null, 'leaving the card still dismisses the menu');
});

test('safe mount callbacks contain DOM errors without stopping refresh', async () => {
  const p = page(); await settle();
  p.document.querySelectorAll = () => { throw new Error('DOM unavailable'); };
  await p.mutate(); const callback = [...p.frames.values()][0];
  await assert.doesNotReject(async () => { await callback(); });
  await tick(p); assert.equal(p.requests.length, 2);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
});
