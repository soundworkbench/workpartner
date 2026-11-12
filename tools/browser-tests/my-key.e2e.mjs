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
const SETTINGS = { allow: ['member'], publicBaseUrl: 'https://models.example.test', revealSeconds: 2 };
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
      if (url.pathname !== API && url.pathname !== API + '/reveal') return;
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
      return replies;
    };
    try {
      await page.goto(ORIGIN + route);
      await waitAvatar(page);
      return await body({ ...current, responses });
    } finally {
      await responses();
      assert.deepEqual(log.pageErrors, []);
    }
  });
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
  for (const name of ['usage', 'limits', 'window', 'estimate', 'top-models']) {
    assert.equal(await page.locator(`${USAGE} [data-wp-my-key-${name}]`).count(), 0);
  }
  const content = await text(page, USAGE);
  assert.equal(content.split(message).length - 1, 1);
  assert.ok(!content.includes('暂不限额'));
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
      key: null, revealSeconds: SETTINGS.revealSeconds, baseUrl: SETTINGS.publicBaseUrl, defaults: {}, usage: null, models: [],
    } }));
    await openMyKey(page); await keyState(page, 'missing'); await disabledKeyActions(page);
  });
});

test('usage: totals, UTC windows, model shares and private-field isolation', LONG, async () => {
  suite.harness.model.setMode('ok');
  suite.harness.model.requests.length = 0;
  await session('usage-ok', {}, async ({ page, responses }) => {
    await openMyKey(page);
    assert.equal(await page.getAttribute(USAGE, 'data-state'), 'ready');
    const fixture = modelFixture();
    for (const period of ['today', 'week']) {
      const tile = `${USAGE} [data-wp-my-key-usage="${period}"]`;
      assert.equal(await text(page, tile + ' [data-wp-my-key-cost]'), '$' + fixture.totals[period].cost.toFixed(2));
      assert.equal(await text(page, tile + ' [data-wp-my-key-calls]'), fixture.totals[period].calls + ' 次');
    }
    const windowNote = await text(page, USAGE + ' [data-wp-my-key-window]');
    assert.match(windowNote, /08:00/); assert.match(windowNote, /北京时间/);
    assert.match(await text(page, USAGE + ' [data-wp-my-key-estimate]'), /估算/);
    assert.equal(await page.getAttribute(USAGE + ' [data-wp-my-key-limits]', 'data-state'), 'none');
    assert.match(await text(page, USAGE + ' [data-wp-my-key-limits]'), /暂不限额/);
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
    await suite.shot(page, 'usage-ok-light-desktop');
  });
});

test('usage: daily and weekly cost limits expose amounts and accessible bars', LONG, async () => {
  suite.harness.model.setMode('limited');
  try {
    await session('usage-limited', {}, async ({ page }) => {
      await openMyKey(page);
      const limits = USAGE + ' [data-wp-my-key-limits]';
      assert.equal(await page.getAttribute(limits, 'data-state'), 'limited');
      assert.equal(await page.locator(limits + ' [role="progressbar"]').count(), 2);
      for (const limit of modelFixture('member', 'limited').profile.limits) {
        const bar = `${limits} [data-wp-my-key-limit="${limit.period}"]`;
        assert.equal(await page.locator(bar).count(), 1);
        const progress = bar + ' [role="progressbar"]';
        assert.equal(Number(await page.getAttribute(progress, 'aria-valuemin')), 0);
        assert.equal(Number(await page.getAttribute(progress, 'aria-valuemax')), limit.costLimit);
        assert.equal(Number(await page.getAttribute(progress, 'aria-valuenow')), limit.cost);
        const label = await text(page, bar);
        const reset = new Date(limit.reset);
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })
          .formatToParts(reset).map(part => [part.type, part.value]));
        assert.ok(label.includes(`${parts.month}月${parts.day}日 08:00（北京时间）恢复`));
        assert.doesNotMatch(label, /\d{2}:\d{2}:\d{2}/);
        assert.ok(!label.includes(String(reset.getUTCFullYear())));
        const amounts = (label.match(/\d+(?:\.\d+)?/g) || []).map(Number);
        for (const amount of [limit.costLimit, limit.cost, limit.costLeft]) assert.ok(amounts.includes(amount), 'limit, used and left amounts are shown');
      }
      await suite.shot(page, 'usage-limited-light-desktop');
      await page.click(action('close')); await closed(page);
      await setting(page, 'language', 'en-US'); await openMyKey(page);
      for (const limit of modelFixture('member', 'limited').profile.limits) {
        const date = new Date(limit.reset).toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', month: 'short', day: 'numeric' });
        const label = await text(page, `${limits} [data-wp-my-key-limit="${limit.period}"]`);
        assert.ok(label.includes(`Resets ${date}, 08:00 Beijing time`));
        assert.doesNotMatch(label, /\d{2}:\d{2}:\d{2}/);
      }
    });
  } finally { suite.harness.model.setMode('ok'); }
});

for (const mode of ['down', 'foreign']) {
  test(`usage: ${mode} preserves key actions and the guide`, LONG, async () => {
    suite.harness.model.setMode(mode);
    try {
      await session('usage-' + mode, {}, async ({ page, log }) => {
        await openMyKey(page);
        if (mode === 'down') {
          await emptyUsage(page, 'unavailable');
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
          assert.equal(await page.getAttribute(USAGE + ' [data-wp-my-key-limits]', 'data-state'), 'none');
          assert.equal(await text(page, USAGE + ' [data-wp-my-key-limits]'), '暂不限额');
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
