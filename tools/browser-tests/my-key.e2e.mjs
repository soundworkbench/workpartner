// Group "my-key": tests for the shared API and DOM contract; all identities and keys are fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { ORIGIN, MODEL_KEYS, MODEL_MODELS, MODEL_PRIVATE, modelFixture } from './lib/harness.mjs';
import { K, DESKTOP, PHONE, waitAvatar, closeMenu, openMyKey, menuShape, overflow } from './lib/browser.mjs';

const API = '/_wp/api/my-key';
const ENTRY = '.wp-settings-menu button.wp-pick-item[role="menuitem"][data-wp-my-key]';
const VALUE = K + ' [data-wp-my-key-value]';
const USAGE = K + ' [data-wp-my-key-card="usage"]';
const GUIDE = K + ' [data-wp-my-key-card="guide"]';
const SNIPPET = K + ' pre[data-wp-my-key-snippet]:visible';
const action = name => `${K} [data-wp-my-key-action="${name}"]`;
const masked = who => 'sk-' + '•'.repeat(8) + MODEL_KEYS[who].slice(-4);
const text = (page, selector) => page.locator(selector).textContent();
const NARROW = { width: 360, height: 740 };
const VIEWPORTS = [['1440x900', DESKTOP], ['390x844', PHONE], ['360x740', NARROW]];
const SETTINGS = { allow: ['member'], publicBaseUrl: 'https://models.example.test', revealSeconds: 2, reference: { weekly: 40 } };
const NOTICE = '这把钥匙与你本人实名绑定，每次使用都会按人记录，用于额度管理和安全审计，请只用于本人工作。';
const NOTES = [
  '这把钥匙只限你本人工作使用，不要给别人用。',
  '不要外传，不要发到群里或贴到网页上。',
  '不要写进代码或脚本，也不要提交到代码仓库；放在配置文件或环境变量里。',
  '在公司外（家里、出差）也可以用，地址就是上面配置里的地址。',
  '怀疑泄露，马上联系管理员更换。',
  '有问题：在工作伙伴的「反馈」里留言。',
];

const suite = createSuite('my-key', async s => {
  s.main = await s.harness.startGateway('both', { allow: ['member'], myKey: SETTINGS });
  s.only = await s.harness.startGateway('my-key-only', { feedback: false, myKey: SETTINGS });
});

function clipboard() {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: async text => { window.__copied.push(String(text)); } } });
}

function menuProbe() {
  window.__menuProbe = { samples: 0, menus: 0, feedback: 0, myKey: 0, separators: 0, adjacent: false };
  document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
    const seen = window.__menuProbe, menus = document.querySelectorAll('.wp-settings-menu');
    seen.menus = Math.max(seen.menus, menus.length);
    for (const menu of menus) {
      const children = [...menu.children], separator = node => node.classList.contains('wp-pick-sep');
      seen.samples++;
      seen.feedback = Math.max(seen.feedback, menu.querySelectorAll('[data-wp-feedback]').length);
      seen.myKey = Math.max(seen.myKey, menu.querySelectorAll('[data-wp-my-key]').length);
      seen.separators = Math.max(seen.separators, children.filter(separator).length);
      seen.adjacent ||= children.some((node, index) => index > 0 && separator(node) && separator(children[index - 1]));
    }
  }).observe(document.body, { subtree: true, childList: true }), { once: true });
}

// Register response capture before navigation, including any initial policy/profile request.
async function session(label, options, body) {
  const { route = '/', init = [], ...rest } = options;
  return suite.session(label, { ...rest, route: null, init: [[clipboard], ...init] }, async current => {
    const { page, log } = current, pending = [], replies = [];
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname !== API && url.pathname !== API + '/reveal' && url.pathname !== API + '/reset') return;
      const record = { method: response.request().method(), path: url.pathname, status: response.status() };
      replies.push(record);
      // Attach the rejection handler immediately so a failed read cannot escape the test runner.
      pending.push(response.text().then(body => { record.body = body; }, error => {
        if (response.headers()['content-length'] === '0' || [204, 304].includes(record.status)) record.body = '';
        else record.error = String(error);
      }));
    });
    const responses = async () => {
      await Promise.all(pending);
      assert.deepEqual(replies.filter(reply => reply.error), [], 'all API response bodies were captured');
      for (const reply of replies.filter(reply => reply.path === API && reply.method === 'GET')) {
        assert.ok(!reply.body.includes('$'));
        if (reply.body) noAmounts(JSON.parse(reply.body));
      }
      return replies;
    };
    try {
      await page.goto(ORIGIN + route);
      await waitAvatar(page);
      return await body({ ...current, responses });
    } finally {
      // Remove routes and drain handlers before the suite closes this page, including on failure.
      await page.unrouteAll({ behavior: 'wait' });
      await responses();
      if (await page.locator(K).count()) {
        const content = await page.locator(K).evaluate(dialog => {
          const copy = dialog.cloneNode(true); copy.querySelector('[data-wp-my-key-value]').textContent = '••••••••';
          return copy.textContent;
        });
        assert.ok(!content.includes('$'));
        assert.doesNotMatch(await text(page, USAGE), /[$¥￥]|USD|金额|估算|amount|estimate/i);
      }
      assert.deepEqual(log.pageErrors, []);
    }
  });
}

function noAmounts(value, context = '') {
  if (!value || typeof value !== 'object') return;
  const forbidden = ['cost', 'costLimit', 'costLeft', 'limit', 'limits', 'used', 'left', 'reference', 'weekly', 'accounts'];
  for (const [key, child] of Object.entries(value)) {
    if (context === 'reset' && ['left', 'limit'].includes(key)) { assert.ok(Number.isInteger(child) && child >= 0 && child <= 3); continue; }
    assert.ok(!forbidden.includes(key), key); noAmounts(child, key);
  }
}

async function usageTile(page, period, percent, calls, english = false) {
  const tile = page.locator(`${USAGE} [data-wp-my-key-usage="${period}"]`);
  assert.equal(await tile.getAttribute('data-state'), 'ready');
  const title = period === 'today' ? (english ? 'Today' : '今天') : (english ? 'This week' : '本周');
  assert.equal(await tile.locator('strong').textContent(), title);
  assert.equal(await tile.locator('[data-wp-my-key-calls]').textContent(), calls + (english ? ' requests' : ' 次'));
  if (percent === null) {
    assert.equal(await tile.locator('[data-wp-my-key-percent], [role="progressbar"], [data-wp-my-key-over]').count(), 0);
    assert.equal(await tile.getAttribute('data-level'), null);
    return;
  }
  const label = percent === 999 ? '999%+' : percent + '%', percentText = english ? label + ' used' : '已用 ' + label;
  assert.equal(await tile.locator('[data-wp-my-key-percent]').textContent(), percentText);
  assert.equal(await tile.getAttribute('data-level'), percent >= 100 ? 'over' : percent >= 80 ? 'warn' : 'normal');
  const bar = tile.locator('.wp-my-key-track[role="progressbar"]');
  for (const [name, value] of Object.entries({ 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': String(Math.min(100, percent)), 'aria-valuetext': percentText })) assert.equal(await bar.getAttribute(name), value);
  assert.equal(await bar.locator('.wp-my-key-fill').evaluate(fill => fill.style.width), Math.min(100, percent) + '%');
  assert.equal(await tile.locator('[data-wp-my-key-over]').count(), percent >= 100 ? 1 : 0);
  if (percent >= 100) assert.equal(await tile.locator('[data-wp-my-key-over]').textContent(), period === 'today'
    ? (english ? "Over today's reference allowance" : '已超过今天参考额度')
    : (english ? "Over this week's reference allowance" : '已超过本周参考额度'));
  return tile.evaluate(tile => ({ fill: getComputedStyle(tile.querySelector('.wp-my-key-fill')).backgroundColor,
    percent: getComputedStyle(tile.querySelector('[data-wp-my-key-percent]')).color,
    over: tile.querySelector('[data-wp-my-key-over]') ? getComputedStyle(tile.querySelector('[data-wp-my-key-over]')).color : null }));
}

// The existing feedback helpers retain their timing. New menu interactions await observable states.
async function menu(page, admitted = true) {
  if (!(await page.$('.wp-settings-menu'))) await page.click('button.wp-user');
  await page.waitForSelector('.wp-settings-menu [role="menuitemradio"]');
  if (admitted) await page.waitForSelector(ENTRY);
}
async function setting(page, name, value) {
  await menu(page);
  const selector = `.wp-settings-menu [data-setting="${name}"][data-value="${value}"]`;
  await page.click(selector);
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-checked') === 'true', selector);
  await page.waitForSelector(ENTRY);
}
async function closed(page) {
  await page.waitForFunction(selector => !document.querySelector(selector)?.open, K);
  await page.waitForFunction(() => document.activeElement?.matches('button.wp-user'));
}
async function keyState(page, state, who = 'member', timeout = 5000) {
  const value = { shown: MODEL_KEYS[who], masked: masked(who), loading: '加载中…',
    unavailable: '暂时取不到', missing: '还没有分配钥匙' }[state];
  assert.notEqual(value, undefined, 'known key state');
  await page.waitForFunction(([selector, state, value]) => {
    const node = document.querySelector(selector);
    return node?.dataset.state === state && node.textContent === value;
  }, [VALUE, state, value], { timeout });
}
async function noPlaintext(page, who = 'member') {
  const seen = await page.evaluate(() => ({ html: document.documentElement.outerHTML,
    storage: JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]) }));
  assert.ok(!seen.html.includes(MODEL_KEYS[who]), 'the whole document contains no plaintext key');
  assert.ok(!seen.storage.includes(MODEL_KEYS[who]), 'web storage contains no plaintext key');
}
async function noStoredKey(page) {
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  for (const key of Object.values(MODEL_KEYS)) assert.ok(!storage.includes(key), 'web storage contains no fixture key');
}
async function tab(page, name) {
  const selector = `${GUIDE} [data-wp-my-key-tab="${name}"]`;
  await page.click(selector);
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-selected') === 'true', selector);
  await page.waitForSelector(SNIPPET);
  const marker = { claude: 'ANTHROPIC_BASE_URL', codex: 'experimental_bearer_token', other: 'Base URL (OpenAI)' }[name];
  await page.waitForFunction(([selector, marker]) => [...document.querySelectorAll(selector)]
    .some(node => node.getClientRects().length && node.textContent.includes(marker)), [K + ' pre[data-wp-my-key-snippet]', marker]);
}
async function tabLabels(page, english = false) {
  // Give the page's DOM-change renamer time to process labels after every guide render.
  await page.waitForTimeout(350);
  const tabs = page.locator(GUIDE + ' [data-wp-my-key-tab]');
  assert.deepEqual(await tabs.allTextContents(), ['Claude Code', 'Codex', english ? 'Other tools' : '其它工具']);
  assert.equal(await tabs.locator('code').count(), 3);
}

async function disabledKeyActions(page) {
  for (const name of ['toggle', 'copy', 'copy-config']) assert.ok(await page.locator(action(name)).isDisabled());
}

async function emptyUsage(page, state) {
  assert.equal(await page.getAttribute(USAGE, 'data-state'), state);
  const message = state === 'loading' ? '加载中…' : '暂时取不到';
  assert.deepEqual(await page.locator(USAGE + ' > *').allTextContents(), ['用量', message]);
  for (const name of ['usage', 'percent', 'window', 'reference-note', 'top-models']) {
    assert.equal(await page.locator(`${USAGE} [data-wp-my-key-${name}]`).count(), 0);
  }
  const content = await text(page, USAGE);
  assert.equal(content.split(message).length - 1, 1);
}
async function copyCount(page, count) {
  await page.waitForFunction(count => window.__copied.length === count, count);
}

// Observe transient DOM insertion too, including text inserted and removed within one mutation batch.
async function watchPlaintext(page, who = 'member') {
  await page.evaluate(key => {
    window.__keyLeak = false;
    const inspect = node => {
      if ((node.textContent || '').includes(key) || (node.outerHTML || '').includes(key)) window.__keyLeak = true;
    };
    window.__keyObserver = new MutationObserver(records => {
      if (document.documentElement.outerHTML.includes(key)) window.__keyLeak = true;
      for (const record of records) {
        if ((record.oldValue || '').includes(key)) window.__keyLeak = true;
        inspect(record.target);
        for (const node of [...record.addedNodes, ...record.removedNodes]) inspect(node);
      }
    });
    window.__keyObserver.observe(document.documentElement, { subtree: true, childList: true,
      characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true });
  }, MODEL_KEYS[who]);
}

test('menu: ordering, access and repeated settings changes', LONG, async () => {
  let baseline;
  for (const who of ['outsider', 'member2']) {
    await session('menu-denied-' + who, { who }, async ({ page }) => {
      await menu(page, false);
      const shape = await menuShape(page);
      assert.equal(await page.locator(ENTRY).count(), 0);
      assert.equal(shape.entries, 0);
      assert.match(shape.kids, /,SEP,LOGOUT$/);
      baseline ||= shape;
    });
  }
  await session('menu-both', { init: [[menuProbe]] }, async ({ page }) => {
    const check = async label => {
      await page.waitForFunction(([selector, label]) => document.querySelector(selector)?.textContent === label, [ENTRY, label]);
      const shape = await menuShape(page);
      assert.match(shape.kids, /,SEP,FEEDBACK,MYKEY,LOGOUT$/);
      assert.equal(shape.entries, 1);
      assert.equal(shape.myKeyEntries, 1);
      assert.equal(shape.separators, baseline.separators);
      assert.equal(shape.kids.split(',').filter(value => value === 'LOGOUT').length, 1);
      assert.equal(shape.menus, 1);
      assert.ok(shape.aboveAvatar && shape.inViewport);
    };
    await menu(page); await check('我的钥匙');
    for (const value of ['dark', 'system', 'light']) { await setting(page, 'theme', value); await check('我的钥匙'); }
    await setting(page, 'language', 'en-US'); await check('My key');
    await suite.shot(page, 'menu-english-desktop');
    await setting(page, 'language', 'zh-CN'); await check('我的钥匙');
    for (let round = 0; round < 5; round++) { await closeMenu(page); await menu(page); await check('我的钥匙'); }
    const seen = await page.evaluate(() => window.__menuProbe);
    assert.ok(seen.samples > 0);
    assert.equal(seen.menus, 1); assert.equal(seen.feedback, 1); assert.equal(seen.myKey, 1);
    assert.equal(seen.separators, baseline.separators); assert.equal(seen.adjacent, false);
  });
  suite.harness.use(suite.only);
  try {
    await session('menu-only-and-bare', {}, async ({ page }) => {
      await menu(page);
      let shape = await menuShape(page);
      assert.match(shape.kids, /,SEP,MYKEY,LOGOUT$/);
      assert.equal(shape.entries, 0); assert.equal(shape.myKeyEntries, 1);
      assert.equal(shape.separators, baseline.separators);
      await closeMenu(page);
      await page.evaluate(() => {
        const menu = document.createElement('div'), title = document.createElement('div'), logout = document.createElement('button');
        menu.className = 'wp-settings-menu'; title.className = 'wp-pick-title'; logout.setAttribute('role', 'menuitem');
        menu.append(title, logout); document.body.append(menu);
      });
      await page.waitForSelector(ENTRY);
      shape = await menuShape(page);
      assert.equal(shape.kids, 'wp-pick-title,OWNSEP,MYKEY,LOGOUT');
      assert.equal(await page.locator('.wp-pick-sep[data-wp-my-key-separator]').count(), 1);
      await page.evaluate(() => document.querySelector('.wp-settings-menu').remove());
    });
  } finally { suite.harness.use(suite.main); }
});

for (const [name, viewport] of VIEWPORTS) {
  test(`menu: above the avatar and inside ${name}`, LONG, async () => {
    await session('menu-' + name, { viewport }, async ({ page }) => {
      await menu(page);
      const shape = await menuShape(page);
      assert.equal(shape.myKeyEntries, 1);
      assert.ok(shape.aboveAvatar, 'menu above the avatar');
      assert.ok(shape.inViewport, 'menu inside the viewport');
      await suite.shot(page, 'menu-light-' + name);
    });
  });
}

test('dialog: modal shell preserves route, input and focus', LONG, async () => {
  await session('shell', { route: '/#/market' }, async ({ page, context, log }) => {
    await page.fill('#fixture-input', 'typed before opening');
    const navigations = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    const facts = () => page.evaluate(() => ({ url: location.href, routes: window.__routes.slice(), input: document.querySelector('#fixture-input').value }));
    const before = await facts();
    for (const how of ['escape', 'button', 'backdrop']) {
      await openMyKey(page);
      assert.equal(await page.getAttribute(K, 'aria-labelledby'), 'wp-my-key-heading');
      assert.equal(await text(page, '#wp-my-key-heading'), '我的钥匙');
      assert.equal(await page.getAttribute(action('close'), 'aria-label'), '关闭');
      assert.ok(await page.locator(K).evaluate(dialog => dialog.matches(':modal') && dialog.contains(document.activeElement)));
      assert.deepEqual(await facts(), before);
      if (how === 'escape') await page.keyboard.press('Escape');
      if (how === 'button') await page.click(action('close'));
      if (how === 'backdrop') {
        await page.click('#wp-my-key-heading');
        assert.ok(await page.locator(K).evaluate(dialog => dialog.open));
        const point = await page.locator(K).evaluate(dialog => {
          const rect = dialog.getBoundingClientRect();
          return [{ x: 1, y: 1 }, { x: innerWidth - 1, y: innerHeight - 1 }]
            .find(p => p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom);
        });
        assert.ok(point, 'there is a visible backdrop');
        await page.mouse.click(point.x, point.y);
      }
      await closed(page);
      assert.deepEqual(await facts(), before);
      assert.deepEqual(navigations, []);
      assert.equal(context.pages().length, 1);
    }
    assert.deepEqual(log.alerts, []);
  });
});

test('key: masks, reveals, hides, copies and audits each action', LONG, async () => {
  const before = suite.main.readAudit().length;
  await session('key-lifecycle', {}, async ({ page, log, responses }) => {
    await openMyKey(page); await keyState(page, 'masked');
    assert.equal(await text(page, K + ' [data-wp-my-key-notice]'), NOTICE);
    assert.equal(await text(page, action('toggle')), '显示');
    assert.equal(await text(page, action('copy')), '复制');
    await noPlaintext(page);
    const initial = await responses();
    assert.ok(initial.some(reply => reply.path === API && reply.method === 'GET' && reply.status === 200));
    for (const reply of initial) assert.ok(!reply.body.includes(MODEL_KEYS.member), 'no plaintext before Show');
    await suite.shot(page, 'key-masked-light-desktop');

    await page.click(action('toggle')); await keyState(page, 'shown');
    assert.equal(await text(page, action('toggle')), '隐藏');
    assert.ok(log.requests.includes('POST ' + API + '/reveal'));
    await noStoredKey(page);
    // Wait for the timer itself; the timeout is revealSeconds plus a scheduling margin.
    await keyState(page, 'masked', 'member', (SETTINGS.revealSeconds + 2) * 1000);
    await noPlaintext(page);
    await page.click(action('toggle')); await keyState(page, 'shown');
    await page.click(action('toggle')); await keyState(page, 'masked', 'member', 1000);
    await noPlaintext(page);
    await page.click(action('toggle')); await keyState(page, 'shown');
    await page.click(action('close')); await closed(page); await noPlaintext(page);
    await openMyKey(page); await keyState(page, 'masked'); await noPlaintext(page);

    await watchPlaintext(page);
    await page.click(action('copy')); await copyCount(page, 1);
    assert.deepEqual(await page.evaluate(() => window.__copied), [MODEL_KEYS.member]);
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '已复制', K + ' [data-wp-my-key-status]');
    assert.equal(await page.getAttribute(K + ' [data-wp-my-key-status]', 'role'), 'status');
    await keyState(page, 'masked'); await noPlaintext(page);
    await tab(page, 'claude');
    const snippet = await text(page, SNIPPET);
    await page.click(action('copy-config')); await copyCount(page, 2);
    assert.deepEqual(await page.evaluate(() => window.__copied), [MODEL_KEYS.member, snippet.replaceAll('<你的钥匙>', MODEL_KEYS.member)]);
    assert.equal(await text(page, SNIPPET), snippet);
    await noPlaintext(page);
    assert.equal(await page.evaluate(() => window.__keyLeak), false, 'copy operations never insert the key into the DOM');

    const reveals = (await responses()).filter(reply => reply.path === API + '/reveal');
    assert.equal(reveals.length, 5);
    assert.ok(reveals.every(reply => reply.method === 'POST' && reply.status === 200));
    const audit = suite.main.readAudit(), added = audit.slice(before);
    assert.deepEqual(added.map(line => line.action), ['show', 'show', 'show', 'copy', 'copy-config']);
    for (const line of audit) {
      assert.deepEqual(Object.keys(line).sort(), ['action', 'at', 'slug']);
      assert.equal(line.slug, 'member');
      assert.ok(Number.isFinite(Date.parse(line.at)));
      assert.ok(['show', 'copy', 'copy-config'].includes(line.action));
    }
    const raw = suite.main.readAuditRaw();
    for (const key of Object.values(MODEL_KEYS)) {
      assert.ok(!raw.includes(key)); assert.ok(!raw.includes(key.slice(-4)));
    }
  });
});

test('key: delayed data loads before masking and failed requests stay unavailable', LONG, async () => {
  await session('key-loading', {}, async ({ page }) => {
    await page.route(ORIGIN + API, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.evaluate(selector => {
      window.__missingKeySeen = false;
      const inspect = node => {
        if ((node.textContent || '').includes('还没有分配钥匙')) window.__missingKeySeen = true;
      };
      window.__keyStateObserver = new MutationObserver(records => {
        const value = document.querySelector(selector);
        if (value) inspect(value);
        for (const record of records) {
          if ((record.oldValue || '').includes('还没有分配钥匙')) window.__missingKeySeen = true;
          for (const node of [...record.addedNodes, ...record.removedNodes]) inspect(node);
        }
      });
      window.__keyStateObserver.observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    }, VALUE);
    await menu(page); await page.click(ENTRY);
    await page.waitForSelector(K + '[open]');
    await keyState(page, 'loading'); await disabledKeyActions(page); await emptyUsage(page, 'loading');
    await keyState(page, 'masked');
    assert.equal(await page.evaluate(() => window.__missingKeySeen), false);
    await page.click(action('close')); await closed(page);
    await page.unroute(ORIGIN + API);
    await page.route(ORIGIN + API, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await openMyKey(page); await keyState(page, 'unavailable'); await disabledKeyActions(page);
    await emptyUsage(page, 'unavailable');
    assert.equal(await page.evaluate(() => window.__missingKeySeen), false);
  });
  await session('key-missing', {}, async ({ page }) => {
    await page.route(ORIGIN + API, route => route.fulfill({ json: {
      key: null, revealSeconds: SETTINGS.revealSeconds, baseUrl: SETTINGS.publicBaseUrl, defaults: {}, usage: null, models: [], reset: null,
    } }));
    await openMyKey(page); await keyState(page, 'missing'); await disabledKeyActions(page);
  });
});

test('usage: reference bars, UTC windows, model shares and private-field isolation', LONG, async () => {
  suite.harness.model.setMode('ok');
  suite.harness.model.requests.length = 0;
  await session('usage-ok', {}, async ({ page, responses }) => {
    await openMyKey(page);
    assert.equal(await page.getAttribute(USAGE, 'data-state'), 'ready');
    const fixture = modelFixture();
    for (const period of ['today', 'week']) {
      const percent = Math.round(fixture.totals[period].cost / (period === 'today' ? 8 : 40) * 100);
      await usageTile(page, period, percent, fixture.totals[period].calls);
    }
    assert.equal(await text(page, USAGE + ' [data-wp-my-key-window]'), '今天从北京时间 08:00 起算；本周从周一 08:00（北京时间）起算。');
    assert.match(await text(page, USAGE + ' [data-wp-my-key-reference-note]'), /目前超过不会停用，只作提醒/);
    const shares = await text(page, USAGE + ' [data-wp-my-key-top-models]');
    for (const [index, model] of MODEL_MODELS.entries()) {
      assert.ok(shares.includes(model.id)); assert.ok(shares.includes([62, 27, 11][index] + '%'));
    }
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const gets = (await responses()).filter(reply => reply.path === API && reply.method === 'GET');
    assert.ok(gets.length > 0);
    for (const value of [html, ...gets.map(reply => reply.body)]) {
      for (const privateValue of MODEL_PRIVATE) assert.ok(!value.includes(privateValue), 'private fixture data must not reach the browser');
      for (const key of Object.values(MODEL_KEYS)) assert.ok(!value.includes(key), 'GET and document contain no plaintext keys');
    }
    const forbidden = new Set(['rows', 'host', 'session', 'accounts', 'callerKeys', 'callerKey']);
    const publicOnly = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), 'private upstream field: ' + key); publicOnly(child); }
    };
    for (const reply of gets) publicOnly(JSON.parse(reply.body));
    const received = suite.harness.model.requests;
    assert.deepEqual([...new Set(received.map(request => request.owner))], ['member']);
    assert.ok(received.some(request => request.path === '/v1/magpie/me'));
    assert.ok(received.some(request => request.path.startsWith('/v1/magpie/usage/requests?')));
    for (const request of received) {
      assert.equal(request.method, 'GET');
      if (request.path === '/v1/magpie/me') continue;
      const url = new URL(request.path, 'http://127.0.0.1');
      assert.equal(url.pathname, '/v1/magpie/usage/requests');
      assert.equal(url.searchParams.get('period'), fixture.usage.series[0].time.slice(0, 10) + '..' + fixture.usage.series.at(-1).time.slice(0, 10));
      assert.equal(url.searchParams.get('limit'), '1'); assert.equal(url.searchParams.get('offset'), '0');
    }
    await suite.shot(page, 'usage-bars-light-desktop');
    await page.click(action('close')); await closed(page);
    await setting(page, 'language', 'en-US'); await openMyKey(page);
    for (const period of ['today', 'week']) {
      await usageTile(page, period, Math.round(fixture.totals[period].cost / (period === 'today' ? 8 : 40) * 100), fixture.totals[period].calls, true);
    }
    assert.match(await text(page, USAGE + ' [data-wp-my-key-reference-note]'), /Going over does not stop the key/);
    assert.equal(await text(page, USAGE + ' [data-wp-my-key-window]'), 'Today starts at 08:00 Beijing time; the week starts on Monday at 08:00 Beijing time.');
  });
});

test('usage: upstream enforcement only changes the reference note', LONG, async () => {
  suite.harness.model.setMode('limited');
  try {
    await session('usage-limited', {}, async ({ page }) => {
      await openMyKey(page);
      assert.equal(await page.locator(USAGE + ' [role="progressbar"]').count(), 2);
      assert.match(await text(page, USAGE + ' [data-wp-my-key-reference-note]'), /另设有用量上限，达到后会暂停/);
      const fixture = modelFixture('member', 'limited');
      for (const period of ['today', 'week']) {
        await usageTile(page, period, Math.round(fixture.totals[period].cost / (period === 'today' ? 8 : 40) * 100), fixture.totals[period].calls);
      }
      await page.click(action('close')); await closed(page);
      await setting(page, 'language', 'en-US'); await openMyKey(page);
      assert.match(await text(page, USAGE + ' [data-wp-my-key-reference-note]'), /This key also has a usage limit; it pauses when the limit is reached/);
    });
  } finally { suite.harness.model.setMode('ok'); }
});

test('usage: no reference keeps calls without bars or a reference note', LONG, async () => {
  suite.main.setMyKey({ reference: { weekly: 0 } });
  try {
    await session('usage-no-reference', {}, async ({ page }) => {
      await openMyKey(page);
      for (const period of ['today', 'week']) await usageTile(page, period, null, modelFixture().totals[period].calls);
      assert.equal(await page.locator(USAGE + ' [role="progressbar"], ' + USAGE + ' [data-wp-my-key-percent]').count(), 0);
      assert.equal(await page.locator(USAGE + ' [data-wp-my-key-reference-note]').count(), 0);
    });
  } finally { suite.main.setMyKey(SETTINGS); }
});

test('usage: warning and over states have distinct theme colours and capped accessible bars', LONG, async () => {
  const response = await suite.main.request('GET', API, { who: 'member' });
  assert.equal(response.status, 200);
  const base = JSON.parse(response.body);
  for (const theme of ['light', 'dark']) {
    await session('usage-levels-' + theme, { viewport: PHONE, storage: { 'fixture-theme': theme } }, async ({ page }) => {
      const json = structuredClone(base), colours = [];
      await page.route(ORIGIN + API, route => route.fulfill({ json }));
      for (const [today, week] of [[40, 46], [80, 99], [100, 184], [999, 999]]) {
        for (const [period, percent] of [['today', today], ['week', week]]) Object.assign(json.usage[period], { percent, over: percent >= 100 });
        await openMyKey(page); await keyState(page, 'masked');
        if (theme === 'dark') await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).colorScheme === 'dark', K);
        const colour = await usageTile(page, 'today', today, json.usage.today.calls);
        const weekColour = await usageTile(page, 'week', week, json.usage.week.calls);
        assert.equal(colour.fill, weekColour.fill);
        if (today >= 80) {
          const expected = today < 100 ? (theme === 'light' ? 'rgb(154, 52, 18)' : 'rgb(255, 207, 133)')
            : (theme === 'light' ? 'rgb(180, 35, 24)' : 'rgb(255, 180, 169)');
          assert.equal(colour.fill, expected); assert.equal(colour.percent, expected);
          assert.equal(weekColour.percent, expected);
          if (today >= 100) { assert.equal(colour.over, expected); assert.equal(weekColour.over, expected); }
        }
        colours.push(colour.fill);
        if (today === 40) await suite.shot(page, `usage-bars-${theme}-390x844`);
        if (today === 100 && theme === 'light') await suite.shot(page, 'usage-over-light-390x844');
        await page.click(action('close')); await closed(page);
      }
      assert.equal(new Set(colours.slice(0, 3)).size, 3);
      await setting(page, 'language', 'en-US'); await openMyKey(page);
      await usageTile(page, 'today', 999, json.usage.today.calls, true);
      await usageTile(page, 'week', 999, json.usage.week.calls, true);
    });
  }
});

for (const [name, viewport] of VIEWPORTS.slice(1)) {
  test(`usage: over-reference text and tiles fit ${name}`, LONG, async () => {
    const response = await suite.main.request('GET', API, { who: 'member' });
    assert.equal(response.status, 200);
    const json = JSON.parse(response.body);
    for (const period of ['today', 'week']) Object.assign(json.usage[period], { percent: 999, over: true });
    await session('usage-over-layout-' + name, { viewport }, async ({ page }) => {
      await page.route(ORIGIN + API, route => route.fulfill({ json }));
      for (const english of [false, true]) {
        if (english) await setting(page, 'language', 'en-US');
        await openMyKey(page); await keyState(page, 'masked');
        for (const period of ['today', 'week']) await usageTile(page, period, 999, json.usage[period].calls, english);
        const facts = await overflow(page, K);
        assert.ok(facts.pageScrollWidth <= facts.pageClientWidth && facts.dialogScrollWidth <= facts.dialogClientWidth);
        assert.deepEqual(facts.outside, []); assert.ok(facts.dialogInViewport);
        const tilesFit = await page.locator(USAGE + ' [data-wp-my-key-usage]').evaluateAll(tiles => tiles.every(tile => {
          const box = tile.getBoundingClientRect(), dialog = tile.closest('dialog').getBoundingClientRect();
          const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const range = document.createRange(); range.selectNodeContents(text);
            for (const rect of range.getClientRects()) if (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom) return false;
          }
          return box.left >= dialog.left && box.right <= dialog.right && box.top >= dialog.top && box.bottom <= dialog.bottom
            && tile.scrollWidth <= tile.clientWidth;
        }));
        assert.ok(tilesFit, 'both tiles and their text fit inside the dialog');
        await page.click(action('close')); await closed(page);
      }
    });
  });
}

for (const mode of ['down', 'foreign']) {
  test(`usage: ${mode} preserves key actions and the guide`, LONG, async () => {
    suite.harness.model.setMode(mode);
    try {
      await session('usage-' + mode, {}, async ({ page, log }) => {
        await openMyKey(page);
        if (mode === 'down') {
          await emptyUsage(page, 'unavailable');
          assert.equal(await page.getByRole('heading', { name: '可用模型', exact: true }).count(), 1);
          assert.equal(await page.getByRole('heading', { name: /（0）/ }).count(), 0);
          assert.equal(await text(page, GUIDE + ' [data-wp-my-key-models]'), '模型清单暂时取不到');
          assert.equal(await page.locator(GUIDE + ' [data-wp-my-key-model]').count(), 0);
          const filter = page.locator(GUIDE + ' [data-wp-my-key-model-filter]');
          assert.ok(await filter.evaluate(node => node.hidden));
          assert.equal(await filter.isVisible(), false);
        } else {
          for (const period of ['today', 'week']) {
            const tile = `${USAGE} [data-wp-my-key-usage="${period}"]`;
            assert.equal(await page.getAttribute(tile, 'data-state'), 'unavailable');
            assert.match(await text(page, tile), /暂时取不到/);
          }
          assert.equal(await page.locator(USAGE + ' [role="progressbar"]').count(), 0);
          assert.equal(await page.locator(USAGE + ' [data-wp-my-key-reference-note]').count(), 0);
          assert.equal(await page.locator(USAGE + ' [data-wp-my-key-window]').count(), 0);
        }
        await suite.shot(page, `usage-${mode}-light-desktop`);
        await keyState(page, 'masked');
        await page.click(action('toggle')); await keyState(page, 'shown');
        await page.click(action('toggle')); await keyState(page, 'masked');
        await watchPlaintext(page);
        await page.click(action('copy')); await copyCount(page, 1);
        assert.deepEqual(await page.evaluate(() => window.__copied), [MODEL_KEYS.member]);
        await noPlaintext(page);
        assert.equal(await page.evaluate(() => window.__keyLeak), false);
        assert.equal(await page.locator(GUIDE + ' [role="tab"]').count(), 3);
        for (const name of ['claude', 'codex', 'other']) {
          await tab(page, name);
          const snippet = await text(page, SNIPPET);
          assert.ok(snippet.includes(SETTINGS.publicBaseUrl)); assert.ok(snippet.includes('<你的钥匙>'));
        }
        await suite.shot(page, `guide-${mode}-light-desktop`);
        assert.deepEqual(log.alerts, []);
      });
    } finally { suite.harness.model.setMode('ok'); }
  });
}

test('guide: three safe snippets, copy all, model filtering and six notes', LONG, async () => {
  await session('guide', {}, async ({ page }) => {
    await openMyKey(page); await watchPlaintext(page);
    assert.equal(await page.getByRole('heading', { name: '使用说明', exact: true }).count(), 1);
    assert.equal(await page.locator(GUIDE + ' [role="tab"]').count(), 3);
    assert.equal(await page.getByRole('heading', { name: `可用模型（${MODEL_MODELS.length}）`, exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: '注意事项', exact: true }).count(), 1);
    const copies = [];
    for (const name of ['claude', 'codex', 'other']) {
      await tab(page, name);
      await tabLabels(page);
      assert.equal(await page.locator(GUIDE + ' [role="tab"][aria-selected="true"]').count(), 1);
      const snippet = await text(page, SNIPPET);
      assert.ok(snippet.includes(SETTINGS.publicBaseUrl)); assert.ok(snippet.includes('<你的钥匙>'));
      assert.ok(!snippet.includes(MODEL_KEYS.member));
      if (name === 'claude') assert.ok(snippet.includes('ANTHROPIC_BASE_URL'));
      if (name === 'codex') { assert.ok(snippet.includes('experimental_bearer_token')); assert.ok(snippet.includes(SETTINGS.publicBaseUrl + '/v1')); }
      assert.equal(await text(page, action('copy-config')), '复制整段');
      await page.click(action('copy-config')); copies.push(snippet.replaceAll('<你的钥匙>', MODEL_KEYS.member));
      await copyCount(page, copies.length);
      assert.deepEqual(await page.evaluate(() => window.__copied), copies);
      assert.ok(!copies.at(-1).includes('<你的钥匙>'));
      assert.equal(await text(page, SNIPPET), snippet);
      await keyState(page, 'masked'); await noPlaintext(page);
      await suite.shot(page, `guide-${name}-light-desktop`);
    }
    assert.equal(await page.evaluate(() => window.__keyLeak), false);
    const models = GUIDE + ' [data-wp-my-key-models] [data-wp-my-key-model]';
    assert.deepEqual((await page.locator(models).allTextContents()).sort(), MODEL_MODELS.map(model => model.id).sort());
    await page.fill(GUIDE + ' input[data-wp-my-key-model-filter]', 'sonnet');
    await page.waitForFunction(selector => {
      const visible = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      return visible.length === 1 && visible[0].textContent === 'claude-sonnet-5-5';
    }, models);
    assert.deepEqual(await page.locator(models + ':visible').allTextContents(), ['claude-sonnet-5-5']);
    assert.equal(await page.getByRole('heading', { name: `可用模型（${MODEL_MODELS.length}）`, exact: true }).count(), 1);
    await page.fill(GUIDE + ' input[data-wp-my-key-model-filter]', '');
    await page.waitForFunction(([selector, count]) => [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length).length === count, [models, MODEL_MODELS.length]);
    assert.deepEqual(await page.locator(GUIDE + ' [data-wp-my-key-notes] li').allTextContents(), NOTES);
  });
});

test('language: English menu, buttons and placeholder', LONG, async () => {
  await session('english', { storage: { i18nextLng: 'en-US' } }, async ({ page }) => {
    await menu(page);
    assert.equal(await text(page, ENTRY), 'My key');
    await openMyKey(page);
    assert.equal(await text(page, '#wp-my-key-heading'), 'My key');
    assert.equal(await text(page, action('toggle')), 'Show');
    assert.equal(await text(page, action('copy')), 'Copy');
    assert.equal(await page.getByRole('heading', { name: 'Setup guide', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: `Available models (${MODEL_MODELS.length})`, exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Notes', exact: true }).count(), 1);
    for (const name of ['claude', 'codex', 'other']) {
      await tab(page, name);
      await tabLabels(page, true);
      const snippet = await text(page, SNIPPET);
      assert.ok(snippet.includes('<YOUR_KEY>')); assert.ok(!snippet.includes('<你的钥匙>'));
      assert.ok(snippet.includes(SETTINGS.publicBaseUrl));
    }
    await suite.shot(page, 'guide-english-light-desktop');
    await noPlaintext(page);
  });
});

test('access: denied routes, live admission, own key and live revocation', LONG, async () => {
  for (const who of ['member2', 'none']) {
    for (const [method, route] of [['GET', API], ['POST', API + '/reveal']]) {
      const reply = await suite.main.request(method, route, { who, body: method === 'POST' ? { action: 'show' } : undefined });
      assert.equal(reply.status, who === 'none' ? 401 : 404);
      if (who === 'member2') assert.equal(reply.body.length, 0);
    }
  }
  const noOrigin = await suite.main.request('POST', API + '/reveal', { who: 'member', origin: null, body: { action: 'show' } });
  assert.equal(noOrigin.status, 403);
  try {
    suite.main.setMyKey({ allow: ['member', 'member2'] });
    await session('newly-admitted', { who: 'member2' }, async ({ page, responses }) => {
      await menu(page); assert.equal(await text(page, ENTRY), '我的钥匙');
      await openMyKey(page); await keyState(page, 'masked', 'member2');
      assert.notEqual(masked('member2'), masked('member'));
      await page.click(action('toggle')); await keyState(page, 'shown', 'member2');
      const reveals = (await responses()).filter(reply => reply.path === API + '/reveal');
      assert.equal(reveals.length, 1); assert.equal(reveals[0].status, 200);
      assert.deepEqual(JSON.parse(reveals[0].body), { key: MODEL_KEYS.member2 });
      assert.ok(!(await page.evaluate(() => document.documentElement.outerHTML)).includes(MODEL_KEYS.member));
      await noStoredKey(page);
    });
    await session('revoked', {}, async ({ page }) => {
      await openMyKey(page); await keyState(page, 'masked');
      suite.main.setMyKey({ allow: ['member2'] });
      await page.click(action('close')); await closed(page);
      await menu(page, false);
      // Reopening triggers the live policy check; do not await a successful dialog load after a 404.
      if (await page.locator(ENTRY).count()) {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === API && response.request().method() === 'GET');
        await page.click(ENTRY);
        assert.equal((await response).status(), 404);
      }
      await page.waitForFunction(() => !document.querySelector('[data-wp-my-key]'));
      // Close any remaining dialog before checking the next menu, without assuming its error presentation.
      if (await page.evaluate(selector => document.querySelector(selector)?.open, K)) { await page.keyboard.press('Escape'); await closed(page); }
      await menu(page, false);
      assert.equal(await page.locator(ENTRY).count(), 0);
      assert.equal(await page.locator('[data-wp-my-key-separator]').count(), 0);
      assert.match((await menuShape(page)).kids, /,SEP,FEEDBACK,LOGOUT$/);
      await noPlaintext(page);
    });
  } finally { suite.main.setMyKey(SETTINGS); }
});

for (const [name, viewport] of VIEWPORTS.slice(1)) {
  test(`layout: each tab fits ${name} with the key shown`, LONG, async () => {
    // A long reveal window isolates layout from the separately tested two-second hiding timer.
    suite.main.setMyKey({ revealSeconds: 300 });
    try {
      await session('layout-' + name, { viewport }, async ({ page }) => {
        await openMyKey(page);
        assert.equal(await page.locator(K + ' [data-wp-my-key-card="key"]').evaluate(card => getComputedStyle(card).borderTopWidth), '0px');
        assert.notEqual(await page.locator(USAGE).evaluate(card => getComputedStyle(card).borderTopWidth), '0px');
        await page.click(action('toggle')); await keyState(page, 'shown');
        for (const name of ['claude', 'codex', 'other']) {
          await tab(page, name);
          await keyState(page, 'shown');
          const facts = await overflow(page, K);
          assert.ok(facts.pageScrollWidth <= facts.pageClientWidth, 'page has no horizontal overflow');
          assert.ok(facts.dialogScrollWidth <= facts.dialogClientWidth, 'dialog has no horizontal overflow');
          assert.deepEqual(facts.outside, [], 'no element protrudes horizontally');
          assert.ok(facts.dialogInViewport, 'dialog inside viewport');
          await suite.shot(page, `layout-${viewport.width}-${name}-key-shown`);
        }
        await page.locator(K + ' .wp-my-key-content').evaluate(content => { content.scrollTop = content.scrollHeight; });
        const scrolled = await page.locator(K).evaluate(dialog => {
          const content = dialog.querySelector('.wp-my-key-content'), box = dialog.getBoundingClientRect();
          const heading = dialog.querySelector('#wp-my-key-heading'), header = heading.parentElement.getBoundingClientRect();
          const close = dialog.querySelector('[data-wp-my-key-action="close"]'), closeBox = close.getBoundingClientRect();
          const inside = rect => rect.width > 0 && rect.height > 0 && rect.left >= box.left && rect.right <= box.right
            && rect.top >= box.top && rect.bottom <= box.bottom;
          // Sticky headers occlude cards as they pass underneath. Compare only their visible area below the row.
          const overlaps = [...dialog.querySelectorAll('[data-wp-my-key-card]')].some(card => {
            const rect = card.getBoundingClientRect(), visibleTop = Math.max(rect.top, header.bottom), visibleBottom = Math.min(rect.bottom, box.bottom);
            return visibleBottom > visibleTop && closeBox.bottom > visibleTop && closeBox.top < visibleBottom
              && closeBox.right > rect.left && closeBox.left < rect.right;
          });
          const hit = document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2);
          const headingBox = heading.getBoundingClientRect();
          const headingHit = document.elementFromPoint(headingBox.left + headingBox.width / 2, headingBox.top + headingBox.height / 2);
          return { atBottom: content.scrollTop > 0 && Math.abs(content.scrollHeight - content.clientHeight - content.scrollTop) <= 1,
            headingInside: inside(headingBox), closeInside: inside(closeBox), closeInRow: closeBox.top >= header.top && closeBox.bottom <= header.bottom,
            overlaps, closeOnTop: hit === close || close.contains(hit), headingOnTop: headingHit === heading || heading.contains(headingHit) };
        });
        assert.deepEqual(scrolled, { atBottom: true, headingInside: true, closeInside: true, closeInRow: true,
          overlaps: false, closeOnTop: true, headingOnTop: true });
        const facts = await overflow(page, K);
        assert.ok(facts.pageScrollWidth <= facts.pageClientWidth && facts.dialogScrollWidth <= facts.dialogClientWidth);
        assert.deepEqual(facts.outside, []);
        await suite.shot(page, `layout-${viewport.width}-scrolled-bottom`);
        await noStoredKey(page);
      });
    } finally { suite.main.setMyKey({ revealSeconds: SETTINGS.revealSeconds }); }
  });
}

test('appearance: light and dark dialogs on desktop and phone', LONG, async () => {
  const backgrounds = {};
  for (const theme of ['light', 'dark']) {
    for (const [name, viewport] of VIEWPORTS.slice(0, 2)) {
      await session(`appearance-${theme}-${name}`, { viewport, storage: { 'fixture-theme': theme } }, async ({ page }) => {
        await menu(page); await suite.shot(page, `menu-${theme}-${name}`);
        await openMyKey(page);
        if (theme === 'dark') await page.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).colorScheme === 'dark', K);
        const style = await page.locator(K).evaluate(dialog => ({ scheme: getComputedStyle(dialog).colorScheme, background: getComputedStyle(dialog).backgroundColor }));
        if (theme === 'dark') assert.equal(style.scheme, 'dark');
        backgrounds[theme + name] = style.background;
        await suite.shot(page, `dialog-${theme}-${name}`);
        await tab(page, 'codex'); await suite.shot(page, `guide-codex-${theme}-${name}`);
      });
    }
  }
  for (const [name] of VIEWPORTS.slice(0, 2)) assert.notEqual(backgrounds['light' + name], backgrounds['dark' + name]);
});

const CONFIRM = K + ' [data-wp-my-key-confirm]';
const RESET_NOTE = K + ' [data-wp-my-key-reset-note]';
const RESET_DONE = K + ' [data-wp-my-key-reset-result="done"]';
const RESET_FAILED = K + ' [data-wp-my-key-reset-result="failed"]';
const RESET_SUCCESS_ZH = '钥匙已重置，旧钥匙已作废。你工作伙伴里的钥匙已自动换好（工作伙伴刚重启过，进行中的对话可能已中断）。只有在自己电脑的工具里填过旧钥匙的，请点「显示」查看新钥匙并自己换上。';
const RESET_SUCCESS_EN = 'The key has been reset and the old one no longer works. The key inside your workspace was replaced automatically (your workspace has just restarted, so a conversation in progress may have been interrupted). Only tools on your own computer that used the old key need it: press Show and give them the new one.';
const RESET_NOTES = [...NOTES.slice(0, 4), '怀疑泄露，马上点上面的「重置钥匙」换一把新的。', NOTES[5]];
const CONFIRM_SENTENCES = [
  '旧钥匙会立刻作废，无法恢复。',
  '你工作伙伴里的钥匙会自动换成新的；工作伙伴会重启约 1 分钟，进行中的对话会中断。',
  '只有在自己电脑的工具里填过旧钥匙的，需要自己换成新钥匙。',
];
let resetSequence = 0;
async function resetSession(label, { mode = 'ok', reset = { enabled: true, blocked: [] }, ...options }, body) {
  const gateway = await suite.harness.startGateway('reset-' + ++resetSequence, { myKey: { ...SETTINGS, reset }, resetBroker: mode });
  suite.harness.use(gateway);
  try { return await session(label, options, current => body({ ...current, gateway })); }
  finally { suite.harness.use(suite.main); await gateway.stop(); }
}
async function resetLayout(page) {
  const facts = await overflow(page, K);
  assert.ok(facts.pageScrollWidth <= facts.pageClientWidth && facts.dialogScrollWidth <= facts.dialogClientWidth);
  assert.deepEqual(facts.outside, []); assert.ok(facts.dialogInViewport);
  assert.equal(await page.locator(CONFIRM).evaluate(panel => {
    const bounds = panel.closest('dialog').getBoundingClientRect();
    return [panel, ...panel.querySelectorAll('button')].every(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  }), true);
}

test('reset: confirmation, cancellation, one POST, replacement and masked success with a real gateway', LONG, async () => {
  await resetSession('reset-success', {}, async ({ page, gateway, log, responses }) => {
    await openMyKey(page); assert.ok(await page.locator(action('reset')).isEnabled());
    assert.deepEqual(await page.locator(GUIDE + ' [data-wp-my-key-notes] li').allTextContents(), RESET_NOTES);
    const colors = await page.locator(K).evaluate(dialog => ['reset', 'toggle'].map(action => {
      const style = getComputedStyle(dialog.querySelector(`[data-wp-my-key-action="${action}"]`));
      return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    }));
    assert.notDeepEqual(colors[0], colors[1]); assert.equal(colors[0].background, 'rgba(0, 0, 0, 0)'); assert.equal(colors[0].color, colors[0].border);
    await suite.shot(page, 'reset-button-light-desktop');
    await page.click(action('reset'));
    assert.equal(await page.getAttribute(CONFIRM, 'role'), 'alertdialog');
    assert.equal(await text(page, CONFIRM + ' h3'), '确认重置钥匙？');
    assert.deepEqual(await page.locator(CONFIRM + ' > p').allTextContents(), [...CONFIRM_SENTENCES, '今天还可以重置 3 次。']);
    assert.equal(await page.locator(action('reset-cancel')).evaluate(button => document.activeElement === button), true);
    assert.equal(await page.locator(action('toggle')).isVisible(), false);
    await page.keyboard.press('Escape'); assert.equal(await page.locator(CONFIRM).isVisible(), false); assert.equal(await page.locator(K).isVisible(), true);
    await page.click(action('reset')); await page.click(action('reset-cancel'));
    assert.equal(gateway.broker.claimed.length, 0); assert.equal(log.requests.filter(r => r === 'POST ' + API + '/reset').length, 0);
    await page.setViewportSize(PHONE); await page.click(action('reset')); await resetLayout(page);
    await suite.shot(page, 'reset-confirm-light-390x844');
    await page.locator(action('reset-confirm')).evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '正在重置钥匙，工作伙伴会重启约 1 分钟…', K + ' [data-wp-my-key-status]');
    await disabledKeyActions(page); assert.ok(await page.locator(action('reset')).isDisabled());
    await page.waitForSelector(RESET_DONE);
    assert.equal(await text(page, RESET_DONE), RESET_SUCCESS_ZH);
    assert.equal(await page.getAttribute(VALUE, 'data-state'), 'masked'); assert.notEqual(await text(page, VALUE), masked('member'));
    assert.equal(log.requests.filter(r => r === 'POST ' + API + '/reset').length, 1);
    assert.equal(gateway.broker.claimed.length, 1);
    assert.deepEqual(gateway.restarts, ['workpartner-next-member']);
    assert.deepEqual(gateway.readAudit().filter(line => line.action === 'reset').map(line => line.result), ['requested', 'ok']);
    await suite.shot(page, 'reset-done-light-390x844');
    await page.click(action('toggle')); await page.waitForFunction(selector => document.querySelector(selector)?.dataset.state === 'shown', VALUE);
    const replacement = await text(page, VALUE); assert.notEqual(replacement, MODEL_KEYS.member);
    assert.ok(!gateway.readAuditRaw().includes(replacement));
    for (const reply of await responses()) if (reply.path === API + '/reset') {
      assert.ok(!reply.body.includes(MODEL_KEYS.member)); assert.ok(!reply.body.includes(replacement));
    }
    await page.click(action('toggle'));
  });
});

test('reset: broker rejection and offline rejection preserve the existing key', LONG, async () => {
  for (const mode of ['rotate-failed', 'offline']) {
    await resetSession('reset-' + mode, { mode: mode === 'offline' ? 'ok' : mode }, async ({ page, gateway }) => {
      await openMyKey(page);
      if (mode === 'offline') gateway.broker.setMode('offline');
      await page.click(action('reset')); await page.click(action('reset-confirm'));
      await page.waitForSelector(RESET_FAILED);
      assert.equal(await text(page, RESET_FAILED), '暂时无法重置，请稍后再试。你现在的钥匙没有变，可以照常使用。');
      await keyState(page, 'masked');
      if (mode === 'offline') {
        assert.ok(await page.locator(action('reset')).isDisabled());
        assert.equal(await text(page, RESET_NOTE), '暂时无法重置，请稍后再试。');
      }
      await page.click(action('toggle')); await keyState(page, 'shown'); await page.click(action('toggle'));
      assert.deepEqual(gateway.restarts, []);
    });
  }
});

test('reset: blocked notes, daily limit, unavailable and feature off have the expected controls and help', LONG, async () => {
  for (const state of ['blocked', 'custom', 'limit', 'offline', 'off']) {
    const reset = { enabled: state !== 'off', blocked: ['blocked', 'custom'].includes(state) ? ['member'] : [],
      blockedNote: state === 'custom' ? '此测试钥匙暂不支持自助更换，请联系管理员处理。' : '' };
    await resetSession('reset-policy-' + state, { reset, mode: state === 'offline' ? 'offline' : 'ok', viewport: NARROW }, async ({ page, gateway }) => {
      if (state === 'limit') await page.route('**/_wp/api/my-key', async route => {
        // route.fetch() resolves the fixture host outside the browser and cannot reach it; ask the gateway directly.
        const body = (await gateway.request('GET', API, { who: 'member' })).json;
        body.reset = { status: 'idle', allowed: false, reason: 'limit', note: '', left: 0, limit: 3 };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await openMyKey(page);
      if (state === 'off') assert.equal(await page.locator(action('reset')).count(), 0);
      else assert.ok(await page.locator(action('reset')).isDisabled());
      const expected = state === 'blocked' ? '这把钥匙暂不支持自助重置；需要更换请联系管理员。'
        : state === 'custom' ? reset.blockedNote : state === 'limit' ? '今天的重置次数已用完（每天 3 次），明天再试。'
          : state === 'offline' ? '暂时无法重置，请稍后再试。' : '';
      assert.equal(await text(page, RESET_NOTE), expected);
      const help = ['blocked', 'custom', 'off'].includes(state) ? NOTES : RESET_NOTES;
      assert.deepEqual(await page.locator(GUIDE + ' [data-wp-my-key-notes] li').allTextContents(), help);
      const facts = await overflow(page, K); assert.deepEqual(facts.outside, []);
      assert.ok(facts.pageScrollWidth <= facts.pageClientWidth && facts.dialogScrollWidth <= facts.dialogClientWidth);
      if (state === 'custom') await suite.shot(page, 'reset-blocked-light-360x740');
      await page.click(action('close')); await setting(page, 'language', 'en-US'); await openMyKey(page);
      if (state !== 'off') assert.equal(await text(page, action('reset')), 'Reset key');
      if (state === 'blocked') assert.equal(await text(page, RESET_NOTE), 'This key cannot be reset here. Ask an administrator to replace it.');
      if (state === 'custom') assert.equal(await text(page, RESET_NOTE), reset.blockedNote);
      if (state === 'limit') assert.equal(await text(page, RESET_NOTE), 'No resets left today (3 per day). Try again tomorrow.');
      if (state === 'offline') assert.equal(await text(page, RESET_NOTE), 'Resetting is unavailable right now. Please try again later.');
      assert.equal(gateway.broker.claimed.length, 0);
      assert.deepEqual(gateway.restarts, []);
    });
  }
});

for (const theme of ['light', 'dark']) for (const viewport of [PHONE, NARROW]) {
  test(`reset: ${theme} confirmation stays inside ${viewport.width}px and English copy survives switching`, LONG, async () => {
    await resetSession(`reset-layout-${theme}-${viewport.width}`, { viewport, storage: { 'fixture-theme': theme } }, async ({ page }) => {
      await openMyKey(page); await page.click(action('reset')); await resetLayout(page);
      assert.deepEqual(await page.locator(CONFIRM + ' > p').allTextContents(), [...CONFIRM_SENTENCES, '今天还可以重置 3 次。']);
      await suite.shot(page, `reset-confirm-${theme}-${viewport.width}x${viewport.height}`);
      await page.click(action('reset-cancel')); await page.click(action('close'));
      await setting(page, 'language', 'en-US'); await openMyKey(page); await page.click(action('reset'));
      assert.equal(await text(page, CONFIRM + ' h3'), 'Reset this key?');
      assert.deepEqual(await page.locator(CONFIRM + ' > p').allTextContents(), [
        'The old key stops working immediately and cannot be restored.',
        'The key inside your workspace is replaced automatically; your workspace restarts for about a minute and a conversation in progress is interrupted.',
        'Only tools on your own computer that use the old key must be given the new one by you.', '3 resets left today.',
      ]);
      await resetLayout(page);
      assert.equal(await text(page, action('reset-cancel')), 'Cancel'); assert.equal(await text(page, action('reset-confirm')), 'Reset');
      await page.click(action('reset-confirm')); await page.waitForSelector(RESET_DONE);
      assert.equal(await text(page, RESET_DONE), RESET_SUCCESS_EN);
      const facts = await overflow(page, K); assert.deepEqual(facts.outside, []);
      assert.ok(facts.pageScrollWidth <= facts.pageClientWidth && facts.dialogScrollWidth <= facts.dialogClientWidth);
    });
  });
}

test('reset: pending polling stops on close, resumes on reopen, and stops after five minutes', LONG, async () => {
  await resetSession('reset-pending', { mode: 'never-claims' }, async ({ page, gateway, log }) => {
    await openMyKey(page); await page.click(action('reset')); await page.click(action('reset-confirm'));
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '正在重置钥匙…', RESET_NOTE);
    await page.click(action('close')); await closed(page);
    const polls = log.requests.filter(r => r === 'GET ' + API + '/reset').length;
    await page.waitForTimeout(2200); assert.equal(log.requests.filter(r => r === 'GET ' + API + '/reset').length, polls);
    await openMyKey(page); assert.equal(await text(page, RESET_NOTE), '正在重置钥匙…');
    await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 301000; });
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '还在处理中，请稍后重新打开「我的钥匙」查看。', K + ' [data-wp-my-key-status]');
    assert.equal(gateway.broker.claimed.length, 0);
    await page.click(action('close')); await openMyKey(page); gateway.broker.setMode('ok');
    await page.waitForSelector(RESET_DONE);
  });
});

test('reset: POST conflicts, quota and policy changes update the dialog without duplicate attempts', LONG, async () => {
  for (const reason of ['busy', 'limit', 'blocked']) {
    await resetSession('reset-post-' + reason, {}, async ({ page, gateway, log }) => {
      await openMyKey(page);
      await page.route('**/_wp/api/my-key/reset', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        if (reason === 'busy') {
          const accepted = await gateway.request('POST', API + '/reset', { who: 'member', body: { confirm: 'reset' } });
          assert.equal(accepted.status, 202);
        } else if (reason === 'blocked') gateway.setMyKey({ reset: { blocked: ['member'] } });
        await route.fulfill({ status: reason === 'busy' ? 409 : reason === 'limit' ? 429 : 403,
          contentType: 'application/json', body: JSON.stringify({ error: 'My key request failed', reason }) });
      });
      await page.click(action('reset')); await page.click(action('reset-confirm'));
      if (reason === 'busy') await page.waitForSelector(RESET_DONE);
      else {
        await page.waitForFunction(([selector, message]) => document.querySelector(selector)?.textContent === message,
          [RESET_NOTE, reason === 'limit' ? '今天的重置次数已用完（每天 3 次），明天再试。' : '这把钥匙暂不支持自助重置；需要更换请联系管理员。']);
        assert.ok(await page.locator(action('reset')).isDisabled());
      }
      assert.equal(log.requests.filter(value => value === 'POST ' + API + '/reset').length, 1);
      assert.deepEqual(gateway.restarts, reason === 'busy' ? ['workpartner-next-member'] : []);
    });
  }
});

test('reset: a lost POST response recovers an accepted reset through main status and polling', LONG, async () => {
  await resetSession('reset-lost-response', { mode: 'never-claims' }, async ({ page, gateway, log }) => {
    await openMyKey(page);
    const before = log.requests.length;
    await page.route('**/_wp/api/my-key/reset', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const accepted = await gateway.request('POST', API + '/reset', { who: 'member', body: { confirm: 'reset' } });
      assert.equal(accepted.status, 202);
      await route.abort('failed');
    });
    await page.click(action('reset')); await page.click(action('reset-confirm'));
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '正在重置钥匙…', RESET_NOTE);
    assert.equal(await page.locator(RESET_FAILED).count(), 0);
    await disabledKeyActions(page); assert.ok(await page.locator(action('reset')).isDisabled());
    const recovery = log.requests.slice(before).filter(request => request.includes(API));
    assert.deepEqual(recovery.slice(0, 2), ['POST ' + API + '/reset', 'GET ' + API]);
    gateway.broker.setMode('ok');
    await page.waitForSelector(RESET_DONE);
    assert.equal(await text(page, RESET_DONE), RESET_SUCCESS_ZH);
    assert.equal(await page.getAttribute(VALUE, 'data-state'), 'masked');
    assert.notEqual(await text(page, VALUE), masked('member'));
    assert.equal(log.requests.filter(request => request === 'POST ' + API + '/reset').length, 1);
    assert.equal(gateway.broker.claimed.length, 1);
    assert.deepEqual(gateway.restarts, ['workpartner-next-member']);
  });
});

test('reset: lost requests report failure and session revocation removes admission', LONG, async () => {
  for (const status of ['network', 401, 404]) {
    await resetSession('reset-revoked-' + status, {}, async ({ page, gateway, log }) => {
      await openMyKey(page);
      const before = log.requests.length;
      await page.route('**/_wp/api/my-key/reset', route => status === 'network' ? route.abort('failed')
        : route.fulfill({ status, contentType: 'application/json', body: status === 404 ? '' : '{"error":"My key request failed"}' }));
      await page.click(action('reset')); await page.click(action('reset-confirm'));
      if (status === 'network') {
        await page.waitForSelector(RESET_FAILED); await keyState(page, 'masked');
        assert.deepEqual(log.requests.slice(before).filter(request => request.includes(API)), ['POST ' + API + '/reset', 'GET ' + API]);
        assert.equal(gateway.broker.claimed.length, 0);
      }
      else { await page.waitForSelector(K, { state: 'hidden' }); await menu(page, false); assert.equal(await page.locator(ENTRY).count(), 0); }
      assert.deepEqual(gateway.restarts, []);
    });
  }
});
