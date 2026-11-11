// Group "access": who gets the feedback script at all, what happens when access is withdrawn, isolation between
// people, and isolation of the rest of the page from faults inside the feedback script.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSuite, until, LONG } from './lib/suite.mjs';
import { PREVIEW_HOST, repo, seedItem } from './lib/harness.mjs';
import { D, openMenu, choose, openDialog, menuShape, visibility } from './lib/browser.mjs';
import { png } from './lib/png.mjs';

const CLIENT = '/_wp/preview/client.js';
const ALLOW = ['member', 'member2'];
const ENTRY = '.wp-settings-menu [data-wp-feedback]';
const { feedbackClient } = await import(pathToFileURL(path.join(repo, 'gateway/feedback-client.mjs')).href);
const { installPreviewClient } = await import(pathToFileURL(path.join(repo, 'preview/client.mjs')).href);

const suite = createSuite('access', async s => {
  // The same four combinations a deployment can be in. All share one session key, so one cookie fits all.
  s.gateways = {};
  for (const preview of ['on', 'off']) for (const feedback of ['on', 'off']) {
    s.gateways[`${preview}/${feedback}`] = await s.harness.startGateway(`preview-${preview}-feedback-${feedback}`,
      { preview: preview === 'on', feedback: feedback === 'on', allow: ALLOW });
  }
  s.main = s.gateways['on/on'];
  s.item = await seedItem(s.main, { title: 'Private to the first member', body: 'Only the author and handlers may read this.', images: [png(64, 48, [200, 30, 30])] });
});

const comparable = reply => ({ status: reply.status, headers: Object.fromEntries(Object.entries(reply.headers).filter(([name]) => name !== 'date')) });

test('client.js: byte-identical to a gateway without feedback for everyone who may not use it', LONG, async () => {
  const expectedExtra = feedbackClient({ maxImageBytes: 300000, maxImagesPerItem: 3 });
  for (const preview of ['on', 'off']) {
    const on = suite.gateways[preview + '/on'], off = suite.gateways[preview + '/off'];
    const get = (gateway, who) => gateway.request('GET', CLIENT, { who });
    // Not signed in, signed in without a workspace, and signed in but not on the allow list.
    for (const who of ['none', 'pending', 'outsider']) {
      const withFeature = await get(on, who), without = await get(off, who), step = `preview ${preview}, ${who}: `;
      assert.deepEqual(comparable(withFeature), comparable(without), step + 'same status and headers');
      assert.ok(withFeature.body.equals(without.body), step + 'same bytes');
      assert.ok(!/feedback/i.test(withFeature.body.toString('utf8')), step + 'no trace of feedback');
    }
    // Feature switched off: people on the list and handlers get the plain script as well.
    const plain = {};
    for (const who of ['member', 'handler']) {
      plain[who] = await get(off, who);
      const body = plain[who].body.toString('utf8'), step = `preview ${preview}, feature off, ${who}: `;
      assert.equal(plain[who].status, 200);
      assert.equal(plain[who].headers['cache-control'], 'no-store');
      assert.ok(!/feedback/i.test(body), step + 'no trace of feedback');
      if (preview === 'off') assert.equal(body, '// Workspace preview is disabled.', step + 'exact body');
      else assert.ok(body.startsWith(`(${installPreviewClient.toString()})(`) && body.endsWith(');'), step + 'only the preview client');
    }
    // Feature on: the plain script plus exactly the feedback part; that part carries two numbers and no identities.
    const extras = {};
    for (const who of ['member', 'handler']) {
      const reply = await get(on, who), step = `preview ${preview}, feature on, ${who}: `;
      assert.deepEqual(comparable(reply), comparable(plain[who]), step + 'same status and headers as without feedback');
      assert.equal(reply.headers['cache-control'], 'no-store', step + 'never cached');
      const body = reply.body.toString('utf8'), base = plain[who].body.toString('utf8');
      assert.ok(body.startsWith(base), step + 'the original script is unchanged');
      extras[who] = body.slice(base.length);
      assert.equal(extras[who], expectedExtra, step + 'appended part');
      for (const secret of ['union-', 'Test Member', 'Second Member', 'Test Handler', 'Test Outsider', '"member2"', on.botToken, suite.harness.sessionKey]) {
        assert.ok(!extras[who].includes(secret), step + 'appended part does not contain ' + secret.slice(0, 12));
      }
    }
    assert.equal(extras.member, extras.handler, `preview ${preview}: the same script for members and handlers`);
    // Taken off the list: the very next request is plain again.
    try {
      on.setPolicy([]);
      const revoked = await get(on, 'member');
      assert.ok(revoked.body.equals(plain.member.body), `preview ${preview}: plain script right after removal from the allow list`);
    } finally { on.setPolicy(ALLOW); }
  }
});

test('page: no entry, style, dialog or request without access, even with the link parameter', LONG, async () => {
  const cases = [['outsider', 'outsider', suite.main], ['feature-off', 'member', suite.gateways['on/off']], ['feature-off-preview-off', 'member', suite.gateways['off/off']]];
  try {
    for (const [name, who, gateway] of cases) {
      suite.harness.use(gateway);
      await suite.session('no-access-' + name, { who, route: '/?wp-feedback=1#/market' }, async ({ page, log }) => {
        await page.waitForTimeout(800);
        await openMenu(page);
        await page.waitForTimeout(300);
        const shape = await menuShape(page);
        const seen = await page.evaluate(() => ({
          entries: document.querySelectorAll('[data-wp-feedback]').length, separators: document.querySelectorAll('[data-wp-feedback-separator]').length,
          style: [...document.querySelectorAll('style')].some(style => style.textContent.includes('wp-feedback')),
          dialog: Boolean(document.querySelector('dialog.wp-feedback-dialog')), url: location.pathname + location.search + location.hash,
        }));
        assert.deepEqual(seen, { entries: 0, separators: 0, style: false, dialog: false, url: '/?wp-feedback=1#/market' }, name);
        assert.match(shape.kids, /,SEP,LOGOUT$/, name + ': the menu is the plain one');
        assert.deepEqual(log.requests.filter(line => line.includes('/_wp/api/feedback')), [], name + ': no feedback request');
        assert.deepEqual(log.pageErrors, [], name);
        await suite.shot(page, `no-access-${name}-light-1440x900`);
      });
    }
  } finally { suite.harness.use(suite.main); }
});

test('withdrawn access: one notice, the dialog closes, the entry disappears and the menu keeps its own separator', LONG, async () => {
  const baseline = await suite.session('revoke-baseline', { who: 'outsider' }, async ({ page }) => { await openMenu(page); return menuShape(page); });
  const revoke = async () => suite.main.setPolicy([]);
  const signOut = async context => context.clearCookies();
  const scenarios = [['404-on-open', revoke, false], ['401-on-open', signOut, false], ['404-on-refresh', revoke, true], ['401-on-refresh', signOut, true]];
  for (const [name, withdraw, whileOpen] of scenarios) {
    try {
      await suite.session('revoke-' + name, {}, async ({ context, page, log }) => {
        if (whileOpen) {
          await openDialog(page);
          await withdraw(context);
          await page.click(D + ' .wp-feedback-row button:has-text("刷新")');
        } else {
          await openMenu(page);
          await page.waitForSelector(ENTRY);
          await withdraw(context);
          await page.click(ENTRY);
        }
        await until(() => log.alerts.length > 0, name + ': a notice');
        await page.waitForFunction(selector => !document.querySelector(selector)?.open, D);
        await page.waitForTimeout(400);
        assert.equal(log.alerts.length, 1, name + ': exactly one notice');
        assert.equal(log.alerts[0].type, 'alert');
        assert.ok(log.alerts[0].message.trim().length > 0, name + ': the notice has text');
        assert.equal(await page.locator('[data-wp-feedback], [data-wp-feedback-separator]').count(), 0, name + ': entry removed');
        await suite.shot(page, `revoked-${name}-light-1440x900`);

        await openMenu(page);
        await page.waitForTimeout(300);
        assert.equal((await menuShape(page)).kids, baseline.kids, name + ': reopened menu equals the menu without feedback, separator before Log out included');
        await choose(page, 'theme', 'dark');
        assert.equal((await menuShape(page)).kids, baseline.kids, name + ': the entry does not come back when the menu re-renders');
        await suite.shot(page, `revoked-${name}-menu-dark-1440x900`);
        assert.equal(log.alerts.length, 1, name + ': still one notice');
        assert.deepEqual(log.pageErrors, [], name);
      });
    } finally { suite.main.setPolicy(ALLOW); }
  }
  // Back on the list: a freshly loaded page has the entry again.
  await suite.session('revoke-restored', {}, async ({ page }) => {
    await openMenu(page);
    await page.waitForSelector(ENTRY);
    assert.equal((await menuShape(page)).entries, 1);
  });
});

test('isolation: people only see their own items; handlers see all', LONG, async () => {
  const { id, title } = suite.item, base = '/_wp/api/feedback/items/' + id;
  const stored = (await suite.main.request('GET', base, { who: 'member' })).json.item.files[0].id;
  for (const who of ['member2', 'outsider', 'pending', 'none']) {
    for (const [method, route, options] of [['GET', base, {}], ['GET', `${base}/files/${stored}`, {}], ['POST', base + '/comments', { body: { text: 'from someone else' } }],
      ['POST', base + '/files?filename=x.png', { body: png(8, 8, [0, 0, 0]), raw: true }]]) {
      const reply = await suite.main.request(method, route, { who, ...options });
      assert.ok([401, 404].includes(reply.status), `${who} ${method} ${route.replace(id, '<id>')}: refused (${reply.status})`);
      assert.ok(!reply.body.toString('utf8').includes(title), `${who}: the reply does not leak the title`);
    }
    for (const route of ['/_wp/api/feedback', '/_wp/api/feedback?scope=all']) {
      const reply = await suite.main.request('GET', route, { who });
      assert.ok(!reply.body.toString('utf8').includes(id) && !reply.body.toString('utf8').includes(title), `${who} ${route}: the list does not contain the item`);
    }
  }
  const all = await suite.main.request('GET', '/_wp/api/feedback?scope=all', { who: 'handler' });
  assert.ok(all.json.isHandler && all.json.items.some(item => item.id === id), 'a handler sees it in "all feedback"');
  assert.equal((await suite.main.request('GET', base, { who: 'handler' })).status, 200);
  assert.equal((await suite.main.request('GET', base, { who: 'member' })).json.item.comments.length, 0, 'nothing was written by the refused requests');

  await suite.session('isolation-list', { who: 'member2' }, async ({ page, log }) => {
    await openDialog(page);
    assert.equal(await page.locator(D + ' .wp-feedback-entry').count(), 0, 'the second member has an empty list');
    assert.equal(await page.locator(D + ' .wp-feedback-row button:has-text("全部反馈")').isVisible(), false, 'no "all feedback" switch');
    assert.deepEqual(log.pageErrors, []);
  });
  await suite.session('isolation-link', { who: 'member2', route: '/?wp-feedback=' + id }, async ({ page, log }) => {
    await page.waitForFunction(selector => [...document.querySelectorAll(selector + ' .wp-feedback-message')].some(node => node.textContent), D);
    await page.waitForTimeout(400);
    const seen = await visibility(page);
    assert.ok(seen.open);
    assert.equal(seen.heading, null, 'no detail for an item of someone else');
    assert.ok(seen.messages.every(message => message.inside), 'the hint is in view');
    assert.ok(!(await page.locator(D).innerText()).includes(title), 'the title is not shown');
    assert.deepEqual(log.alerts, [], 'a missing item is not treated as withdrawn access');
    await suite.shot(page, 'isolation-link-light-1440x900');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('fault isolation: a broken feedback script leaves the preview client, the avatar and the menu working', LONG, async t => {
  const faults = {
    none: () => {},
    'observing the body throws': () => { const observe = MutationObserver.prototype.observe; MutationObserver.prototype.observe = function (target, ...rest) { if (target === document.body) throw new Error('fault: observe(body)'); return observe.call(this, target, ...rest); }; },
    'replaceState throws': () => { History.prototype.replaceState = function () { throw new Error('fault: replaceState'); }; },
    'no showModal': () => { delete HTMLDialogElement.prototype.showModal; },
    'storage throws': () => { Storage.prototype.getItem = function () { throw new Error('fault: getItem'); }; },
    'fetch throws': () => { const fetch = window.fetch; window.fetch = function (url, ...rest) { if (String(url).includes('/_wp/api/feedback')) throw new Error('fault: fetch'); return fetch.call(this, url, ...rest); }; },
    'creating a dialog throws': () => { const create = Document.prototype.createElement; Document.prototype.createElement = function (tag, ...rest) { if (String(tag).toLowerCase() === 'dialog') throw new Error('fault: createElement(dialog)'); return create.call(this, tag, ...rest); }; },
    'no MutationObserver': () => { delete window.MutationObserver; },
  };
  // The same page is loaded by someone who never receives the feedback script; both must behave alike.
  async function probe(who, fault, label) {
    return suite.session(label, { who, route: '/?wp-feedback=1#/market', init: [[fault]], avatar: false }, async ({ page, log }) => {
      const facts = { avatar: true };
      try { await page.waitForSelector('button.wp-user', { timeout: 4000 }); } catch { facts.avatar = false; }
      await page.waitForTimeout(800);
      Object.assign(facts, await page.evaluate(host => {
        const detail = { url: 'http://127.0.0.1:3000/a?b=1' };
        document.dispatchEvent(new CustomEvent('zp-preview-url', { detail }));
        const url = new URL(detail.url);
        return { previewRewrite: url.host === host && url.pathname === '/_wp_preview/start' && url.searchParams.get('port') === '3000',
          openWrapped: !/\[native code\]/.test(Function.prototype.toString.call(window.open)) };
      }, PREVIEW_HOST));
      const opened = await page.evaluate(selector => Boolean(document.querySelector(selector)?.open), D);
      if (opened) await page.keyboard.press('Escape');
      if (facts.avatar) {
        facts.menu = await page.click('button.wp-user', { timeout: 3000 }).then(() => page.waitForSelector('.wp-settings-menu [role=menuitemradio]', { timeout: 3000 })).then(() => true, () => false);
        facts.logout = await page.locator('.wp-settings-menu [role=menuitem]:not([data-wp-feedback])').count();
        if (facts.menu) await page.click('.wp-settings-menu [data-setting="theme"][data-value="dark"]', { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        facts.theme = await page.getAttribute('html', 'data-theme');
      }
      facts.pageErrors = log.pageErrors.length;
      facts.scriptErrors = log.pageErrors.filter(error => error.includes('client.js')).length;
      return { facts, opened, entries: await page.locator('[data-wp-feedback]').count() };
    });
  }
  for (const [name, fault] of Object.entries(faults)) {
    const label = name.replaceAll(' ', '-');
    const without = await probe('outsider', fault, `fault-${label}-outsider`);
    const member = await probe('member', fault, `fault-${label}-member`);
    assert.deepEqual(member.facts, without.facts, `${name}: the page behaves the same with and without the feedback script`);
    assert.equal(without.entries, 0);
    t.diagnostic(`${name}: ${JSON.stringify(member.facts)}; dialog opened for the member: ${member.opened}`);
    if (name === 'none') {
      assert.deepEqual(without.facts, { avatar: true, previewRewrite: true, openWrapped: true, menu: true, logout: 1, theme: 'dark', pageErrors: 0, scriptErrors: 0 }, 'control: the plain page works');
      assert.ok(member.opened && member.entries === 1, 'control: without a fault the member gets the dialog and the entry');
    }
  }
});
