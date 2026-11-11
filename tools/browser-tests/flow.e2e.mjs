// Group "flow": submitting, opening items from links, going back to the list, limits, failures and untrusted text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { ORIGIN, seedItem } from './lib/harness.mjs';
import { D, DESKTOP, PHONE, waitAvatar, openDialog, openEntry, visibility, scrollProbe, paste, requests } from './lib/browser.mjs';
import { png, pngLargerThan, gif, file } from './lib/png.mjs';

const VIEWPORTS = [['1440x900', DESKTOP], ['390x844', PHONE]];
// "natural": the page cannot scroll. "spacer": the page itself is scrollable and already scrolled to 400.
const MODES = [['natural', 0], ['spacer', 400]];
const FORM = D + ' form';
const FILE_INPUT = FORM + ' input[type=file]';
const SUBMIT = FORM + ' button[type=submit]';
const FORM_MESSAGE = FORM + ' .wp-feedback-message';
const DETAIL = '#wp-feedback-detail';
const CREATE = /^POST \/_wp\/api\/feedback$/;
const UPLOAD = /^POST \/_wp\/api\/feedback\/items\/[\w-]+\/files\?filename=/;
const thumbs = (page, scope) => page.locator(scope + ' .wp-feedback-thumb').count();
const text = (page, selector) => page.locator(selector).first().textContent();
const settle = page => page.waitForTimeout(500);
const detailTitle = (page, title) => page.waitForFunction(([selector, title]) =>
  (document.querySelector(selector + ':not([hidden]) h3')?.textContent || '').includes(title), [DETAIL, title]);
/** Scroll only the dialog until the stored screenshots are on screen, then wait for them to load. */
async function imagesLoaded(page) {
  await page.evaluate(([dialogSelector, detailSelector]) => {
    const dialog = document.querySelector(dialogSelector), images = document.querySelector(detailSelector + ' .wp-feedback-images');
    dialog.scrollTop += images.getBoundingClientRect().top - dialog.getBoundingClientRect().top - 40;
  }, [D, DETAIL]);
  await page.waitForFunction(selector => [...document.querySelectorAll(selector + ' .wp-feedback-images img')].every(img => img.complete && img.naturalWidth > 0), DETAIL);
  return page.locator(DETAIL + ' .wp-feedback-images img').count();
}

const suite = createSuite('flow', async s => {
  s.main = await s.harness.startGateway('main');
  s.first = await seedItem(s.main, {
    title: 'First seeded item', body: 'Seeded description.',
    images: [png(320, 200, [200, 60, 60]), png(200, 320, [60, 140, 200])],
    comments: ['A comment from the author.'], bot: { status: 'need_info', reply: { key: 'seed-reply', text: 'A reply from the handler side.' } },
  });
  // Enough items to push the detail section below the fold of the dialog.
  for (let number = 2; number <= 6; number++) await seedItem(s.main, { type: number % 2 ? 'bug' : 'feature', title: `Seeded item ${number}` });
});

for (const [name, viewport] of VIEWPORTS) for (const [mode, expectedScroll] of MODES) {
  test(`submit: fill in, attach, submit, and the new item opens in view (${name}, ${mode} page)`, LONG, async t => {
    await suite.session(`submit-${name}-${mode}`, { viewport, route: '/#/market', init: [[scrollProbe, mode]] }, async ({ page, log }) => {
      if (mode === 'spacer') await page.evaluate(() => scrollTo(0, 0));
      await openDialog(page);
      if (mode === 'spacer') await page.evaluate(() => { scrollTo(0, 400); });
      await page.waitForTimeout(200);
      await page.evaluate(() => { window.__pageScrolls = []; });

      const title = `Submitted at ${name} on a ${mode} page`;
      await page.selectOption(FORM + ' select', 'feature');
      await page.fill('#wp-feedback-title', title);
      await page.fill('#wp-feedback-body', 'Line one.\nLine two.');
      await page.setInputFiles(FILE_INPUT, [file('chosen.png', png(64, 48, [20, 120, 220]))]);
      await paste(page, '#wp-feedback-body', { bytes: png(48, 64, [220, 120, 20]) });
      await page.waitForFunction(selector => document.querySelectorAll(selector + ' .wp-feedback-thumb').length === 2, FORM);
      if (mode === 'natural') await suite.shot(page, 'submit-filled-light-' + name);

      await page.click(SUBMIT);
      await detailTitle(page, title);
      await settle(page);
      const seen = await visibility(page);
      assert.equal(await text(page, FORM_MESSAGE), '提交成功。');
      assert.equal(requests(log, CREATE).length, 1, 'one create request');
      assert.equal(requests(log, UPLOAD).length, 2, 'one upload request per screenshot');
      assert.equal(await page.inputValue('#wp-feedback-title'), '', 'title cleared');
      assert.equal(await page.inputValue('#wp-feedback-body'), '', 'description cleared');
      assert.equal(await page.inputValue(FORM + ' select'), 'bug', 'type reset');
      assert.equal(await thumbs(page, FORM), 0, 'queued screenshots cleared');
      assert.match(await text(page, D + ' .wp-feedback-list .wp-feedback-entry strong'), new RegExp(`^#\\d+ · 新需求 · ${title}$`), 'the new item is first in the list');

      assert.ok(seen.open, 'dialog still open');
      assert.ok(seen.heading?.text.endsWith(' · 新需求 · ' + title), 'detail of the new item is shown');
      assert.ok(seen.heading.inside, `detail heading inside the visible part of the dialog (${seen.heading.fromDialogTop}px from its top)`);
      assert.ok(seen.heading.onTop, 'detail heading not covered');
      assert.equal(seen.scrollY, expectedScroll, 'window scroll position unchanged');
      assert.deepEqual(seen.pageScrolls, [], 'the page never scrolled');
      assert.equal(seen.url, '/#/market', 'URL unchanged');
      // Observation only, not part of the acceptance list: where the keyboard focus is after a submit.
      t.diagnostic(`${name} ${mode}: focus inside the dialog after submit = ${seen.focusInDialog}`);
      await suite.shot(page, `submit-done-light-${name}-${mode}`);

      assert.equal(await text(page, DETAIL + ' .wp-feedback-text'), 'Line one.\nLine two.');
      assert.equal(await text(page, DETAIL + ' .wp-feedback-badge'), '已提交');
      assert.equal(await imagesLoaded(page), 2, 'both screenshots are stored and load');
      assert.equal(await page.evaluate(() => Math.round(scrollY)), expectedScroll, 'window scroll position unchanged after reading the item');
      assert.deepEqual(log.pageErrors, []);
      assert.deepEqual(log.alerts, []);
    });
  });
}

for (const [name, viewport] of VIEWPORTS) for (const [mode, expectedScroll] of MODES) {
  test(`links: every way of opening an item shows it inside the dialog (${name}, ${mode} page)`, LONG, async () => {
    const id = suite.first.id;
    const cases = [
      { name: 'id', route: '/?wp-feedback=' + id, url: '/', detail: true },
      { name: 'id-with-route', route: `/?wp-feedback=${id}#/market`, url: '/#/market', detail: true },
      { name: 'id-with-other-query', route: `/?a=1&wp-feedback=${id}&b=%20x#/market`, url: '/?a=1&b=%20x#/market', detail: true },
      { name: 'legacy-flag-hash', route: '/?wp-feedback=1#' + id, url: '/', detail: true },
      { name: 'legacy-page-hash', route: '/_wp/feedback#' + id, url: '/', detail: true },
      { name: 'unknown-id', route: '/?wp-feedback=no-such-item-123', url: '/', detail: false },
      { name: 'unknown-legacy', route: '/_wp/feedback#no-such-item-123', url: '/', detail: false },
    ];
    await suite.session(`links-${name}-${mode}`, { viewport, route: null, init: [[scrollProbe, mode]] }, async ({ page, log }) => {
      for (const item of cases) {
        const step = item.name + ': ';
        await page.goto(ORIGIN + item.route);
        await waitAvatar(page);
        if (item.detail) await page.waitForSelector(DETAIL + ':not([hidden]) h3');
        else await page.waitForFunction(selector => [...document.querySelectorAll(selector + ' .wp-feedback-message')].some(node => node.textContent), D);
        await settle(page);
        const seen = await visibility(page);
        assert.ok(seen.open, step + 'dialog opened by the link');
        if (item.detail) {
          assert.match(seen.heading?.text || '', /^#1 · 问题 · First seeded item$/, step + 'detail of the linked item');
          assert.ok(seen.heading.inside, `${step}detail heading inside the visible part of the dialog (${seen.heading.fromDialogTop}px from its top)`);
          assert.ok(seen.heading.onTop, step + 'detail heading not covered');
        } else {
          assert.equal(seen.heading, null, step + 'no detail for an unknown id');
          assert.ok(seen.messages.length > 0 && seen.messages.every(message => message.inside), step + 'the hint is inside the visible part of the dialog: ' + JSON.stringify(seen.messages));
        }
        assert.ok(seen.focusInDialog, step + 'focus inside the dialog');
        assert.equal(seen.scrollY, expectedScroll, step + 'window scroll position unchanged');
        assert.ok(seen.pageScrolls.every(y => y === expectedScroll), step + 'the page never scrolled: ' + JSON.stringify(seen.pageScrolls));
        assert.equal(seen.url, item.url, step + 'the parameter is removed from the address bar, the rest is kept');
        assert.ok(!(await page.evaluate(() => window.__routes[0])).includes('wp-feedback'), step + 'the router never sees the parameter');
        if (mode === 'natural' && ['id', 'unknown-id'].includes(item.name)) await suite.shot(page, `link-${item.name}-light-${name}`);
        if (mode === 'spacer' && item.name === 'legacy-flag-hash') await suite.shot(page, `link-${item.name}-light-${name}-spacer`);
      }
      assert.deepEqual(log.pageErrors, []);
      assert.deepEqual(log.alerts, []);
    });
  });
}

test('detail: Back to list collapses the item, and a late reply does not reopen it', LONG, async () => {
  const hidden = page => page.locator(DETAIL).evaluate(node => node.hidden);
  await suite.session('back', { route: '/?wp-feedback=' + suite.first.id }, async ({ page, log }) => {
    await page.waitForSelector(DETAIL + ':not([hidden]) h3');
    await settle(page);
    assert.equal(await text(page, DETAIL + ' button'), '返回列表');
    await page.click(DETAIL + ' button:has-text("返回列表")');
    assert.ok(await hidden(page), 'detail collapsed');
    const list = await page.evaluate(selector => {
      const dialog = document.querySelector(selector).getBoundingClientRect(), title = document.querySelector(selector + ' .wp-feedback-row h3').getBoundingClientRect();
      return { inside: title.top >= dialog.top && title.bottom <= dialog.bottom, scrollY: Math.round(scrollY), open: document.querySelector(selector).open };
    }, D);
    assert.ok(list.open, 'dialog stays open');
    assert.ok(list.inside, 'the list heading is in view');
    assert.equal(list.scrollY, 0, 'window scroll position unchanged');
    await suite.shot(page, 'back-to-list-light-1440x900');

    await openEntry(page, 'Seeded item 2');
    await openEntry(page, 'Seeded item 3');
    assert.match(await text(page, DETAIL + ' h3'), /^#3 · /, 'switching straight from one item to another');

    // Hold the next detail reply back, leave the item meanwhile: the reply must not bring it back.
    await page.route('**/_wp/api/feedback/items/*', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue(); });
    await page.click(`${D} .wp-feedback-entry:has-text("Seeded item 4")`);
    await page.click(DETAIL + ' button:has-text("返回列表")');
    assert.ok(await hidden(page));
    await page.waitForTimeout(2500);
    assert.ok(await hidden(page), 'a reply arriving after Back to list is ignored');
    await page.unroute('**/_wp/api/feedback/items/*');
    await openEntry(page, 'Seeded item 4');
    assert.deepEqual(log.pageErrors, []);
  });
  await suite.session('back-en', { storage: { i18nextLng: 'en-US' }, route: '/?wp-feedback=' + suite.first.id }, async ({ page }) => {
    await page.waitForSelector(DETAIL + ':not([hidden]) h3');
    assert.equal(await text(page, DETAIL + ' button'), 'Back to list');
    assert.match(await text(page, DETAIL + ' h3'), /^#1 · Issue · First seeded item$/);
    await page.click(DETAIL + ' button:has-text("Back to list")');
    assert.ok(await hidden(page));
    await suite.shot(page, 'back-to-list-en-light-1440x900');
  });
});

test('limits and failures: rejected files, a failed submit keeps the draft, a double submit creates one item', LONG, async () => {
  await suite.session('limits', {}, async ({ page, log }) => {
    await openDialog(page);
    const reject = async (files, message) => {
      await page.setInputFiles(FILE_INPUT, files);
      await page.waitForFunction(([selector, message]) => document.querySelector(selector).textContent === message, [FORM_MESSAGE, message]);
    };
    await reject([file('too-large.png', pngLargerThan(300000))], '截图过大，每张最多 0.3 MB。');
    await reject([file('animation.gif', gif, 'image/gif')], '截图只支持 PNG、JPEG 或 WebP 图片。');
    await reject([file('notes.txt', Buffer.from('plain text'), 'text/plain')], '截图只支持 PNG、JPEG 或 WebP 图片。');
    assert.equal(await thumbs(page, FORM), 0, 'rejected files are not queued');
    await reject([1, 2, 3, 4].map(number => file(`shot-${number}.png`, png(40, 30, [number * 50, 0, 0]))), '每条反馈最多上传 3 张截图。');
    assert.equal(await thumbs(page, FORM), 3, 'the first three are kept');
    assert.ok(await page.isDisabled(FILE_INPUT));
    await suite.shot(page, 'limit-count-light-1440x900');

    // The server fails once: nothing is lost and the form can be sent again.
    await page.fill('#wp-feedback-title', 'Kept after a failure');
    await page.fill('#wp-feedback-body', 'Draft text.');
    const fail = async route => route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.continue();
    await page.route('**/_wp/api/feedback', fail);
    await page.click(SUBMIT);
    await page.waitForFunction(([selector, message]) => document.querySelector(selector).textContent === message, [FORM_MESSAGE, '暂时无法处理，请稍后重试。']);
    await page.unroute('**/_wp/api/feedback', fail);
    assert.equal(await page.inputValue('#wp-feedback-title'), 'Kept after a failure');
    assert.equal(await page.inputValue('#wp-feedback-body'), 'Draft text.');
    assert.equal(await thumbs(page, FORM), 3);
    assert.ok(await page.isEnabled(SUBMIT), 'the submit button is usable again');
    assert.equal(await text(page, SUBMIT), '提交反馈');
    await suite.shot(page, 'submit-failed-light-1440x900');

    const creates = requests(log, CREATE).length, uploads = requests(log, UPLOAD).length;
    await page.evaluate(selector => { const form = document.querySelector(selector); form.requestSubmit(); form.requestSubmit(); }, FORM);
    await detailTitle(page, 'Kept after a failure');
    await settle(page);
    assert.equal(requests(log, CREATE).length, creates + 1, 'two quick submits create one item');
    assert.equal(requests(log, UPLOAD).length, uploads + 3);
    assert.equal(await text(page, FORM_MESSAGE), '提交成功。');
    assert.equal(await page.locator(`${D} .wp-feedback-entry:has-text("Kept after a failure")`).count(), 1);
    assert.equal(await imagesLoaded(page), 3);
    assert.ok(await page.isDisabled(DETAIL + ' .wp-feedback-picker button'), 'the stored item is full as well');
    assert.deepEqual(log.pageErrors, []);
    assert.deepEqual(log.alerts, []);
  });
});

test('detail: comments, later uploads and replies from the handler side', LONG, async () => {
  const item = await seedItem(suite.main, { title: 'Item for follow-ups' });
  await suite.session('follow-up', { route: '/?wp-feedback=' + item.id }, async ({ page, log }) => {
    await detailTitle(page, 'Item for follow-ups');
    assert.equal(await text(page, DETAIL + ' .wp-feedback-muted'), 'Test Member · ' + await page.evaluate(at => new Date(at).toLocaleString('zh-CN'), item.createdAt));

    await page.fill(DETAIL + ' form textarea', 'More details from the author.');
    await page.click(DETAIL + ' form button[type=submit]');
    await page.waitForSelector(`${DETAIL} .wp-feedback-comment:has-text("More details from the author.")`);
    assert.equal(await page.inputValue(DETAIL + ' form textarea'), '', 'comment box cleared');

    await page.setInputFiles(DETAIL + ' input[type=file]', [file('later.png', png(80, 60, [90, 90, 200]))]);
    await page.waitForSelector(DETAIL + ' .wp-feedback-thumb');
    await page.click(DETAIL + ' button:has-text("上传截图")');
    await page.waitForFunction(selector => [...document.querySelectorAll(selector + ' .wp-feedback-message')].some(node => node.textContent === '截图已上传。'), DETAIL);
    assert.equal(await thumbs(page, DETAIL), 0);
    assert.equal(await imagesLoaded(page), 1);

    const update = await suite.main.request('POST', '/_wp/api/feedback/bot/items/' + item.id, { bot: true,
      body: { status: 'in_progress', reply: { key: 'follow-up-reply', text: 'Work has started.' }, pr: 'https://example.test/changes/1' } });
    assert.equal(update.status, 200);
    assert.equal(await page.locator(`${DETAIL} .wp-feedback-comment:has-text("Work has started.")`).count(), 0, 'not shown before a refresh');
    await page.click(D + ' .wp-feedback-row button:has-text("刷新")');
    await page.waitForSelector(`${DETAIL} .wp-feedback-comment:has-text("Work has started.")`);
    assert.equal(await text(page, DETAIL + ' .wp-feedback-badge'), '处理中');
    const link = await page.locator(DETAIL + ' > a').evaluate(a => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent }));
    assert.deepEqual(link, { href: 'https://example.test/changes/1', target: '_blank', rel: 'noopener noreferrer', text: '查看 PR' });
    assert.equal(await page.locator(D + ' .wp-feedback-row button:has-text("全部反馈")').isVisible(), false, 'no "all feedback" switch for a regular member');
    await suite.shot(page, 'detail-follow-up-light-1440x900', { fullPage: false });
    assert.deepEqual(log.pageErrors, []);
  });

  await suite.session('handler', { who: 'handler' }, async ({ page }) => {
    await openDialog(page);
    assert.equal(await text(page, D + ' .wp-feedback-row h3'), '我的反馈');
    assert.equal(await page.locator(D + ' .wp-feedback-entry').count(), 0, 'the handler has no items of their own');
    await page.click(D + ' .wp-feedback-row button:has-text("全部反馈")');
    await page.waitForSelector(`${D} .wp-feedback-entry:has-text("Item for follow-ups")`);
    assert.equal(await text(page, D + ' .wp-feedback-row h3'), '全部反馈');
    await openEntry(page, 'Item for follow-ups');
    assert.match(await text(page, DETAIL + ' .wp-feedback-muted'), /^Test Member · /);
    await suite.shot(page, 'handler-all-light-1440x900');
  });
});

test('untrusted text: markup in any field is shown as text and never runs', LONG, async () => {
  const IMG = '<img src=/xss-probe-img onerror="window.__xss=(window.__xss||0)+1;alert(1)">';
  const SCRIPT = '<script>window.__xss=(window.__xss||0)+1;alert(2)</script>';
  const SVG = '<svg onload=alert(3)><iframe src=javascript:alert(4)>';
  const title = 'Markup ' + IMG, body = 'body ' + IMG + '\n' + SCRIPT + '\n' + SVG + '\n&lt;b&gt;entity&lt;/b&gt;';
  const fileName = '<img src=/xss-probe-file onerror=alert(5)>.png';
  const pendingName = '<img src=/xss-probe-pending onerror=alert(7)>.png';
  const gateway = suite.main;
  const created = await gateway.request('POST', '/_wp/api/feedback', { who: 'member', body: { type: 'bug', title, body } });
  assert.equal(created.status, 201);
  const { id } = created.json.item, base = '/_wp/api/feedback/items/' + id;
  assert.equal((await gateway.request('POST', `${base}/files?filename=${encodeURIComponent(fileName)}`, { who: 'member', body: png(20, 20, [200, 30, 30]), raw: true })).status, 201);
  assert.equal((await gateway.request('POST', base + '/comments', { who: 'member', body: { text: 'comment ' + SCRIPT + IMG } })).status, 200);
  const bot = '/_wp/api/feedback/bot/items/' + id;
  assert.equal((await gateway.request('POST', bot, { bot: true, body: { reply: { key: 'markup-reply', text: 'reply ' + IMG + SVG }, approval: { state: 'pending', note: 'note ' + IMG } } })).status, 200);
  assert.equal((await gateway.request('POST', bot, { bot: true, body: { pr: 'javascript:alert(8)' } })).status, 400, 'a non-HTTPS link is refused by the API');
  const pr = await gateway.request('POST', bot, { bot: true, body: { pr: 'https://example.test/pr/1?a="><img src=/xss-probe-pr onerror=alert(6)>' } });
  assert.equal(pr.status, 200);

  await suite.session('markup', { route: '/?wp-feedback=' + id }, async ({ page, log }) => {
    await page.waitForSelector(DETAIL + ':not([hidden]) h3');
    await imagesLoaded(page);
    await page.locator(D).evaluate(dialog => { dialog.scrollTop = 0; });
    await page.setInputFiles(FILE_INPUT, [file(pendingName, png(20, 20, [1, 2, 3]))]);
    await page.waitForSelector(FORM + ' .wp-feedback-thumb img');
    await page.waitForTimeout(800);
    const seen = await page.evaluate(([dialogSelector, detailSelector]) => {
      const dialog = document.querySelector(dialogSelector), detail = document.querySelector(detailSelector);
      const texts = selector => [...detail.querySelectorAll(selector)].map(node => node.textContent);
      const link = detail.querySelector(':scope > a');
      return {
        ran: window.__xss || 0,
        injected: [...dialog.querySelectorAll('script, svg, iframe, object, embed, img')].filter(node => !node.closest('.wp-feedback-images, .wp-feedback-thumb')).map(node => node.outerHTML.slice(0, 80)),
        handlers: [...dialog.querySelectorAll('*')].filter(node => [...node.attributes].some(attribute => attribute.name.startsWith('on'))).length,
        heading: detail.querySelector('h3').textContent, entry: [...dialog.querySelectorAll('.wp-feedback-entry strong')].map(node => node.textContent).find(value => value.includes('Markup')),
        body: detail.querySelector(':scope > .wp-feedback-text').textContent, notes: texts(':scope > .wp-feedback-text').slice(1), comments: texts('.wp-feedback-comment .wp-feedback-text'),
        stored: [...detail.querySelectorAll('.wp-feedback-images img')].map(img => ({ alt: img.alt, src: new URL(img.src).pathname.startsWith('/_wp/api/feedback/items/') })),
        pending: [...dialog.querySelectorAll('form .wp-feedback-thumb img')].map(img => ({ alt: img.alt, blob: img.src.startsWith('blob:') })),
        link: link ? { protocol: new URL(link.href).protocol, host: new URL(link.href).host, children: link.children.length } : null,
      };
    }, [D, DETAIL]);
    assert.equal(seen.ran, 0, 'no payload ran');
    assert.deepEqual(seen.injected, [], 'no element was created from user text');
    assert.equal(seen.handlers, 0, 'no inline event handler anywhere in the dialog');
    assert.equal(seen.heading, '#' + created.json.item.no + ' · 问题 · ' + title);
    assert.equal(seen.entry, seen.heading);
    assert.equal(seen.body, body);
    assert.deepEqual(seen.notes, ['待审批: note ' + IMG]);
    assert.deepEqual(seen.comments, ['comment ' + SCRIPT + IMG, 'reply ' + IMG + SVG]);
    assert.deepEqual(seen.stored, [{ alt: fileName, src: true }]);
    assert.deepEqual(seen.pending, [{ alt: pendingName, blob: true }]);
    assert.deepEqual(seen.link, { protocol: 'https:', host: 'example.test', children: 0 });
    assert.deepEqual(requests(log, /xss-probe/), [], 'no request caused by a payload');
    assert.deepEqual(log.alerts, []);
    assert.deepEqual(log.pageErrors, []);
    await page.locator(DETAIL).evaluate(node => node.scrollIntoView());
    await suite.shot(page, 'markup-as-text-light-1440x900');
  });

  const served = (await gateway.request('GET', '/_wp/preview/client.js', { who: 'member' })).body.toString('utf8');
  const appended = served.slice(served.lastIndexOf('\n;('));
  assert.ok(appended.length > 10000, 'the feedback part of the script was found');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'createContextualFragment', 'DOMParser']) {
    assert.ok(!appended.includes(sink), 'the feedback script does not use ' + sink);
  }
});
