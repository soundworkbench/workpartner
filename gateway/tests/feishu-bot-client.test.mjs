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
        const parent = this.parentElement;
        // Chromium blurs a focused descendant BEFORE detaching it. Reentrant removal
        // from focusout can change the parent and make the original removal throw.
        if (this.contains(document.activeElement)) {
          const focused = document.activeElement; document.activeElement = document.body;
          for (let element = focused; element; element = element.parentElement) {
            for (const callback of element.listeners.focusout || []) callback({ relatedTarget: null });
          }
        }
        if (this.parentElement !== parent) throw new Error('NotFoundError: node was removed during focusout');
        parent.children = parent.children.filter(child => child !== this); this.parentElement = null;
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
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
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

function page({ home = false, clipboardFails = false, reconnectResponse, responseData, handleRequest } = {}) {
  const timers = new Map(), frames = new Map(), listeners = {}, requests = [], tags = [], copied = [];
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
    queueMicrotask, navigator: { clipboard: { writeText: async value => {
      if (clipboardFails) throw new Error('clipboard denied');
      copied.push(value);
    } } },
    fetch: async (url, options) => { requests.push({ url, options });
      if (handleRequest) { const response = await handleRequest(url, options); if (response) return response; }
      if (url.endsWith('/reconnect') && reconnectResponse) return reconnectResponse;
      return { status, ok: status === 200,
      json: async () => responseData || ({ bots: home ? [{ appId: 'cli_Test', name: '助手', online: 'online', openUrl: '#' }] : [] }) }; },
  });
  vm.runInContext(feishuBotClient(), context);
  return { timers, frames, requests, tags, copied, document, listeners, mutate: () => mutation(), disconnected: () => disconnected, status: value => { status = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function tick(p, delay) {
  const [id, timer] = [...p.timers].find(([, timer]) => delay === undefined || timer.delay === delay);
  p.timers.delete(id); await timer.callback(); await settle();
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
  assert.deepEqual(p.copied, ['cli_Test'], 'removing the focused menu must not abort the copy handler');
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '已复制 App ID');
  assert.equal(p.listeners.pointerdown, undefined);
  await p.listeners.visibilitychange(); await settle();
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '已复制 App ID', 'render does not clear the toast');
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
  const openMenu = p.document.querySelector('.wp-feishu-bot-menu');
  let prevented = false;
  await openMenu.fire('mousedown', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'mouse down preserves menu focus on Safari');
  await openMenu.fire('focusout', { relatedTarget: null });
  assert.equal(openMenu.isConnected, true, 'unknown focus destination must not remove the menu');
  await p.listeners.pointerdown({ target: find('复制 App ID') });
  assert.equal(openMenu.isConnected, true, 'pointer down inside the card keeps the menu');
  await p.listeners.pointerdown({ target: p.document.body });
  assert.equal(openMenu.isConnected, false, 'pointer down outside the card dismisses the menu');
  assert.equal(p.listeners.pointerdown, undefined);
  await click('…');
  await p.document.querySelector('.wp-feishu-bot-menu').fire('focusout', { relatedTarget: p.document.body });
  assert.equal(p.document.querySelector('.wp-feishu-bot-menu'), null, 'Tab leaving the card dismisses the menu');
  assert.equal(p.listeners.pointerdown, undefined);
  await tick(p, 3000);
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '');
});

test('closing with the trigger or revoking admission removes the outside pointer listener', async () => {
  const p = page({ home: true }); await settle();
  const more = p.document.querySelector('.wp-feishu-bot-more');
  await more.fire('click'); assert.equal(typeof p.listeners.pointerdown, 'function');
  await more.fire('click'); assert.equal(p.listeners.pointerdown, undefined);
  await more.fire('click'); p.status(404); await tick(p, 60000);
  assert.equal(p.listeners.pointerdown, undefined);
  assert.equal(p.document.querySelector('.wp-feishu-bot-section'), null);
  assert.equal(p.timers.size, 0);
});

test('clipboard rejection shows the failure toast and expires after three seconds', async () => {
  const p = page({ home: true, clipboardFails: true }); await settle();
  await p.document.querySelector('.wp-feishu-bot-more').fire('click');
  await p.document.querySelector('.wp-feishu-bot-menu').querySelector('button').fire('click');
  assert.deepEqual(p.copied, []);
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '复制失败，请手动复制 App ID。');
  await tick(p, 3000);
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '');
});

test('background failures mark data stale silently; only manual refresh failure notifies', async () => {
  const p = page({ home: true }); await settle();
  const stale = p.document.querySelector('.wp-feishu-bot-stale'), message = p.document.querySelector('.wp-feishu-bot-message');
  assert.equal(stale.hidden, true);
  p.status(503); await tick(p, 60000);
  assert.equal(stale.hidden, false); assert.equal(message.textContent, '');
  await p.listeners.visibilitychange(); await settle();
  assert.equal(stale.hidden, false); assert.equal(message.textContent, '');
  assert.equal([...p.timers.values()].some(timer => timer.delay === 3000), false);
  await p.document.querySelector('.wp-feishu-bot-header').querySelector('button').fire('click');
  assert.equal(message.textContent, '暂时无法读取机器人信息，请稍后刷新。');
  assert.equal(p.requests.at(-1).url, '/_wp/feishu-bot/bots?refresh=1');
  await tick(p, 3000); assert.equal(message.textContent, '');
  p.status(200); await tick(p, 60000); assert.equal(stale.hidden, true);
});

for (const status of [200, 503]) test(`reconnect progress stays until the request ends (${status})`, async () => {
  let finish;
  const reconnectResponse = new Promise(resolve => { finish = resolve; });
  const p = page({ home: true, reconnectResponse }); await settle();
  const click = text => p.document.querySelectorAll('button').find(button => button.textContent === text).fire('click');
  await click('…'); await click('复制 App ID'); // An earlier toast timer must be cancelled.
  await click('…'); await click('重新连接');
  const pendingClick = click('确认重新连接'); await settle();
  const message = p.document.querySelector('.wp-feishu-bot-message');
  assert.equal(message.textContent, '正在重新连接…');
  assert.equal([...p.timers.values()].some(timer => timer.delay === 3000), false, 'no auto-dismiss while reconnect is pending');
  await tick(p, 60000); // Even a background refresh must leave the sticky progress visible.
  assert.equal(message.textContent, '正在重新连接…');
  finish({ status, ok: status === 200, json: async () => ({}) }); await pendingClick;
  assert.equal(message.textContent, status === 200 ? '已重新连接，稍后刷新状态。' : '重新连接失败，请稍后重试。');
  await tick(p, 3000); assert.equal(message.textContent, '');
});

test('safe mount callbacks contain DOM errors without stopping refresh', async () => {
  const p = page(); await settle();
  p.document.querySelectorAll = () => { throw new Error('DOM unavailable'); };
  await p.mutate(); const callback = [...p.frames.values()][0];
  await assert.doesNotReject(async () => { await callback(); });
  await tick(p); assert.equal(p.requests.length, 2);
  assert.deepEqual([...p.timers.values()].map(t => t.delay), [60000]);
});

const main = { agentId: 'main', appId: 'cli_Main', name: '主机器人', online: 'online', openUrl: 'https://example.test/main' };
const agent = (id, setup = 'none') => ({ id: 's0000000' + id, kind: 'sub', name: '助手' + id, setup, appId: null });
const payload = () => ({ bots: [main, { ...main, agentId: 's00000001', appId: 'cli_Sub', name: '子机器人' }],
  agents: [agent(1, 'connected'), agent(2, 'waiting'), agent(3, 'needs_identity'), agent(4)], subAgents: { enabled: true, limit: 5, count: 4 } });
const findButton = (root, text) => root.querySelectorAll('button').find(b => b.textContent === text);
const jsonResponse = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const submit = root => root.querySelector('form').fire('submit', { preventDefault() {} });

test('sub-agent cards follow main, label kinds and expose only appropriate actions', async () => {
  const p = page({ home: true, responseData: payload() }); await settle();
  const cards = p.document.querySelectorAll('.wp-feishu-bot-card');
  assert.deepEqual(cards.map(c => c.querySelector('h3').textContent), ['主机器人', '助手1', '助手2', '助手3', '助手4']);
  assert.deepEqual(cards.map(c => c.querySelector('.wp-feishu-bot-tag').textContent), ['主助手', '子助手', '子助手', '子助手', '子助手']);
  assert.match(cards[1].querySelector('.wp-feishu-bot-summary').textContent, /飞书机器人：子机器人 · App ID cli_Sub/);
  assert.equal(cards[2].querySelector('.wp-feishu-bot-avatar').textContent, '助');
  assert.deepEqual(cards.slice(2).map(c => c.querySelector('.wp-feishu-bot-state').textContent), ['等待扫码', '待管理员完成连接', '还没连接飞书']);
  assert.equal(findButton(cards[3], '扫码连接'), undefined);
  for (let i = 0; i < cards.length; i++) {
    assert.equal(cards[i].querySelectorAll('a').length, i < 2 ? 2 : 0);
    if (i === 2 || i === 4) assert.ok(findButton(cards[i], '扫码连接'));
    await findButton(cards[i], '…').fire('click');
    assert.deepEqual(cards[i].querySelector('.wp-feishu-bot-menu').querySelectorAll('button').map(b => b.textContent),
      i === 0 ? ['复制 App ID', '重新连接'] : i === 1 ? ['复制 App ID', '重新连接', '改名', '删除'] : ['改名', '删除']);
    await findButton(cards[i], '…').fire('click');
  }
  assert.equal(p.document.querySelector('.wp-feishu-bot-cards').children[0].className, 'wp-feishu-bot-add');
});

test('add card supports open, full, unavailable and empty states without changing legacy hint', async () => {
  for (const enabled of [true, false]) for (const count of [1, 5]) {
    const data = payload(); data.subAgents = { enabled, count, limit: 5 };
    const p = page({ home: true, responseData: data }); await settle();
    const add = p.document.querySelector('.wp-feishu-bot-add');
    assert.equal(add.attributes['aria-label'], enabled ? '新建子助手' : '连接飞书机器人');
    assert.equal(add.disabled, enabled && count === 5);
    if (add.disabled) {
      assert.equal(add.attributes['aria-describedby'], 'wp-feishu-bot-add-hint');
      assert.equal(add.querySelector('small').textContent, '子助手最多 5 个（主助手另算），删掉不用的再建');
    } else {
      await add.fire('click');
      if (enabled) assert.equal(p.document.querySelector('dialog').querySelector('h2').textContent, '新建子助手');
      else assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '一个工作伙伴暂时只能连一个飞书机器人，多个子助手的功能做好后开放');
    }
  }
  const p = page({ home: true, responseData: { bots: [], agents: [], subAgents: { enabled: true, count: 0, limit: 5 } } }); await settle();
  assert.equal(p.document.querySelector('.wp-feishu-bot-add').attributes['aria-label'], '连接飞书机器人');
});

test('new name validates instantly and create transitions the same dialog to polling and connected', async () => {
  const data = payload(); let setup = 'waiting';
  const p = page({ home: true, responseData: data, handleRequest: (url, options) => {
    if (url.endsWith('/agents')) return jsonResponse({ agent: agent(5, 'preparing') }, 201);
    if (url.endsWith('/setup')) return jsonResponse({ status: setup, qr: 'data:image/png;base64,YQ==' });
  } }); await settle();
  await p.document.querySelector('.wp-feishu-bot-add').fire('click');
  const dialog = p.document.querySelector('dialog'), input = dialog.querySelector('input');
  assert.equal(p.document.activeElement, input);
  const next = findButton(dialog, '下一步：扫码创建机器人');
  for (const value of ['主助手', 'mAIN', 'a  b', '字'.repeat(17), 'emoji😀', '']) {
    input.value = value; await input.fire('input'); assert.equal(next.disabled, true);
    assert.match(dialog.querySelector('.wp-feishu-bot-input-error').textContent, /最多 16 个字/);
  }
  input.value = '  中文 Agent_·-1  '; await input.fire('input'); assert.equal(next.disabled, false);
  await submit(dialog); await settle();
  assert.equal(p.document.querySelector('dialog'), dialog);
  assert.equal(dialog.querySelector('h2').textContent, '给「助手5」创建飞书机器人');
  assert.equal(dialog.querySelector('img').src, 'data:image/png;base64,YQ==');
  assert.equal(p.requests.find(r => r.url.endsWith('/agents')).options.body, '{"name":"中文 Agent_·-1"}');
  assert.equal(p.requests.find(r => r.url.endsWith('/setup')).options.method, 'GET');
  setup = 'connected'; await tick(p, 2000);
  assert.match(dialog.textContent, /已连接，可以在飞书里找「助手5」了/);
  assert.equal([...p.timers.values()].some(t => t.delay === 2000), false);
  assert.ok(p.requests.filter(r => r.url.endsWith('/bots')).length >= 3);
});

test('setup pauses hidden, resumes visible, retries and stops on close including inflight response', async () => {
  let setup = 'expired', finish;
  const p = page({ home: true, responseData: payload(), handleRequest: url => {
    if (!url.endsWith('/setup')) return;
    if (finish === 'pending') return new Promise(resolve => { finish = resolve; });
    return jsonResponse({ status: setup });
  } }); await settle();
  await findButton(p.document, '扫码连接').fire('click'); await settle();
  assert.equal(p.requests.at(-1).options.method, 'POST');
  assert.match(p.document.querySelector('dialog').textContent, /二维码已过期/);
  const count = p.requests.length;
  p.document.hidden = true; await p.listeners.visibilitychange();
  assert.equal([...p.timers.values()].some(t => t.delay === 2000), false); assert.equal(p.requests.length, count);
  p.document.hidden = false; await p.listeners.visibilitychange(); await settle();
  assert.equal(p.requests.filter(r => r.url.endsWith('/setup')).length, 2);
  setup = 'needs_identity'; await findButton(p.document.querySelector('dialog'), '重试').fire('click');
  assert.equal(p.requests.at(-1).options.method, 'POST'); assert.match(p.document.querySelector('dialog').textContent, /发 \/whoami/);
  setup = 'failed'; await tick(p, 2000); assert.match(p.document.querySelector('dialog').textContent, /创建没有成功/);
  finish = 'pending'; const ticking = tick(p, 2000); await settle();
  await p.document.querySelector('dialog').fire('cancel', { preventDefault() {} });
  finish(jsonResponse({ status: 'waiting' })); await ticking;
  assert.equal(p.document.querySelector('dialog'), null);
  assert.equal([...p.timers.values()].some(t => t.delay === 2000), false);
});

test('rename validates, reports conflict and success; delete confirms; sub restart targets its own id', async () => {
  let error = true;
  const p = page({ home: true, responseData: payload(), handleRequest: (url, options) => {
    if (options.method === 'POST') return jsonResponse(url.endsWith('/rename') && error ? { error: 'name_taken' } : { ok: true }, url.endsWith('/rename') && error ? 409 : 200);
  } }); await settle();
  const card = () => p.document.querySelectorAll('.wp-feishu-bot-card')[1];
  const menuAction = async text => { await findButton(card(), '…').fire('click'); await findButton(card(), text).fire('click'); };
  await menuAction('改名');
  const dialog = p.document.querySelector('dialog'), input = dialog.querySelector('input');
  assert.equal(input.value, '助手1'); assert.match(dialog.textContent, /只改工作伙伴里的名字/);
  await submit(dialog); assert.equal(dialog.querySelector('.wp-feishu-bot-input-error').textContent, '这个名字已经有了');
  error = false; input.value = '新名字'; await input.fire('input'); await submit(dialog);
  assert.equal(p.document.querySelector('dialog'), null); assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '已改名');
  assert.equal(p.requests.find(r => r.url.endsWith('/rename')).url, '/_wp/feishu-bot/agents/s00000001/rename');
  await menuAction('删除'); assert.match(card().querySelector('.wp-feishu-bot-confirm').textContent, /工作目录移到回收目录。飞书里的机器人不会被删除/);
  await findButton(card(), '取消').fire('click'); assert.equal(p.requests.some(r => r.url.endsWith('/delete')), false);
  await menuAction('删除'); await findButton(card(), '确认删除').fire('click');
  assert.equal(p.requests.find(r => r.url.endsWith('/delete')).url, '/_wp/feishu-bot/agents/s00000001/delete');
  assert.equal(p.document.querySelector('.wp-feishu-bot-message').textContent, '已删除');
  await menuAction('重新连接'); await findButton(card(), '确认重新连接').fire('click');
  assert.equal(p.requests.find(r => r.url.endsWith('/restart')).url, '/_wp/feishu-bot/agents/s00000001/restart');
});


test('create shows fixed server error copy and a missing agent does not revoke the whole feature', async () => {
  for (const [error, status, text] of [
    ['invalid_name', 400, '名字只能用汉字、字母、数字、空格和 _ - ·，最多 16 个字'],
    ['limit_reached', 409, '子助手最多 5 个（主助手另算）'],
    ['name_taken', 409, '这个名字已经有了'],
    ['unavailable', 503, '操作没有成功，请稍后重试'],
    ['not_found', 404, '操作没有成功，请稍后重试'],
  ]) {
    const p = page({ home: true, responseData: payload(), handleRequest: url => url.endsWith('/agents') ? jsonResponse({ error }, status) : undefined });
    await settle(); await p.document.querySelector('.wp-feishu-bot-add').fire('click');
    const dialog = p.document.querySelector('dialog'), input = dialog.querySelector('input');
    input.value = '助手'; await input.fire('input'); await submit(dialog);
    assert.equal(dialog.querySelector('.wp-feishu-bot-input-error').textContent, text);
    assert.equal(dialog.querySelector('img'), null); assert.ok(p.document.querySelector('.wp-feishu-bot-section'));
  }
});
