// Group "menu": the avatar menu entry, the dialog shell, the image picker, paste handling, narrow screens and dark mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { seedItem } from './lib/harness.mjs';
import { D, DESKTOP, PHONE, openMenu, closeMenu, choose, openDialog, openEntry, menuShape, overflow, paste } from './lib/browser.mjs';
import { png, pngLargerThan, file } from './lib/png.mjs';

const NARROW = { width: 360, height: 740 };
const SHORT = { width: 1280, height: 500 };
const LONG_TITLE = 'Long' + 'W'.repeat(116);
const LONG_NAME = 'screenshot-' + 'n'.repeat(150) + '.png';
const FORM = D + ' form';
const PICKER = FORM + ' .wp-feedback-picker button';
const FILE_INPUT = FORM + ' input[type=file]';
const thumbs = (page, scope) => page.locator(scope + ' .wp-feedback-thumb').count();
const text = (page, selector) => page.locator(selector).first().textContent();

const suite = createSuite('menu', async s => {
  s.main = await s.harness.startGateway('main');
  s.kb = await s.harness.startGateway('kb', { maxImageBytes: 50000 });
  s.full = await seedItem(s.main, {
    title: 'Seeded item with screenshots', body: 'First line.\nSecond line.',
    images: [png(320, 200, [200, 60, 60]), png(200, 320, [60, 140, 200]), png(64, 64, [80, 160, 80])],
    comments: ['A comment from the author.'], bot: { status: 'need_info', reply: { key: 'seed-reply', text: 'A reply from the handler side.' } },
  });
  s.plain = await seedItem(s.main, { type: 'feature', title: 'Seeded item without screenshots' });
  s.long = await seedItem(s.main, { title: LONG_TITLE, body: 'https://example.test/' + 'p'.repeat(300) });
  const upload = await s.main.request('POST', `/_wp/api/feedback/items/${s.long.id}/files?filename=${encodeURIComponent(LONG_NAME)}`,
    { who: 'member', body: png(900, 120, [120, 120, 120]), raw: true });
  assert.equal(upload.status, 201, 'seed: long file name upload');
});

async function baselineMenu() {
  return suite.session('menu-baseline', { who: 'outsider' }, async ({ page }) => { await openMenu(page); return menuShape(page); });
}
const withEntry = kids => kids.replace(/,SEP,LOGOUT$/, ',SEP,FEEDBACK,LOGOUT');

test('menu: exactly one Feedback item, placed before Log out behind the existing separator', LONG, async () => {
  const baseline = await baselineMenu();
  assert.equal(baseline.entries, 0, 'a person outside the allow list has no Feedback item');
  assert.match(baseline.kids, /,SEP,LOGOUT$/, 'fixture menu ends with a separator and Log out');
  await suite.session('menu-entry', {}, async ({ page, log }) => {
    await openMenu(page);
    await page.waitForSelector('.wp-settings-menu [data-wp-feedback]');
    const shape = await menuShape(page);
    assert.equal(shape.menus, 1);
    assert.equal(shape.entries, 1, 'one Feedback item');
    assert.equal(shape.label, '反馈');
    assert.equal(shape.kids, withEntry(baseline.kids), 'only difference to the baseline menu is the Feedback item before Log out');
    assert.equal(shape.separators, baseline.separators, 'no extra separator');
    assert.ok(shape.aboveAvatar && shape.inViewport, 'menu stays above the avatar and inside the viewport');
    await suite.shot(page, 'menu-light-desktop');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('menu: re-rendering and reopening never duplicates the item or the separator', LONG, async () => {
  const baseline = await baselineMenu();
  // Samples the menu after every DOM change, so short-lived duplicates are caught too.
  const probe = () => {
    window.__menu = { samples: 0, maxMenus: 0, maxEntries: 0, maxSeparators: 0, adjacentSeparators: 0 };
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
      const seen = window.__menu, menus = document.querySelectorAll('.wp-settings-menu');
      seen.maxMenus = Math.max(seen.maxMenus, menus.length);
      for (const menu of menus) {
        const kids = [...menu.children], separator = kid => kid.classList.contains('wp-pick-sep');
        seen.samples++;
        seen.maxEntries = Math.max(seen.maxEntries, kids.filter(kid => kid.hasAttribute('data-wp-feedback')).length);
        seen.maxSeparators = Math.max(seen.maxSeparators, kids.filter(separator).length);
        if (kids.some((kid, index) => index > 0 && separator(kid) && separator(kids[index - 1]))) seen.adjacentSeparators++;
      }
    }).observe(document.body, { childList: true, subtree: true }), { once: true });
  };
  await suite.session('menu-rerender', { init: [[probe]] }, async ({ page, log }) => {
    const expected = withEntry(baseline.kids);
    const check = async (step, label = '反馈') => {
      await page.waitForFunction(label => document.querySelector('.wp-settings-menu [data-wp-feedback]')?.textContent === label, label);
      const shape = await menuShape(page);
      assert.equal(shape.kids, expected, step);
      assert.equal(shape.label, label, step);
    };
    await openMenu(page); await check('first open');
    for (const value of ['dark', 'system', 'light']) { await choose(page, 'theme', value); await check('appearance ' + value); }
    await choose(page, 'language', 'en-US'); await check('language en-US', 'Feedback');
    await choose(page, 'language', 'zh-CN'); await check('language zh-CN');
    for (let round = 1; round <= 10; round++) { await closeMenu(page); await openMenu(page); await check('reopen ' + round); }
    const seen = await page.evaluate(() => window.__menu);
    assert.ok(seen.samples > 20, 'the probe saw the menu changing');
    assert.equal(seen.maxMenus, 1);
    assert.equal(seen.maxEntries, 1, 'never more than one Feedback item');
    assert.equal(seen.maxSeparators, baseline.separators, 'never more separators than the menu has without feedback');
    assert.equal(seen.adjacentSeparators, 0, 'never two separators in a row');
    await closeMenu(page);
    assert.equal(await page.locator('[data-wp-feedback], [data-wp-feedback-separator]').count(), 0, 'nothing left behind after the menu closes');

    // A menu without a separator before Log out gets exactly one, marked as owned by the feedback script.
    const bare = await page.evaluate(async () => {
      const menu = document.createElement('div'), title = document.createElement('div'), logout = document.createElement('button');
      menu.className = 'wp-settings-menu'; title.className = 'wp-pick-title'; logout.setAttribute('role', 'menuitem');
      menu.append(title, logout); document.body.append(menu);
      await new Promise(resolve => setTimeout(resolve, 200));
      const kids = [...menu.children].map(kid => kid.hasAttribute('data-wp-feedback') ? 'FEEDBACK'
        : kid.hasAttribute('data-wp-feedback-separator') ? 'OWNSEP' : kid.getAttribute('role') === 'menuitem' ? 'LOGOUT' : kid.className);
      menu.remove();
      return kids.join(',');
    });
    assert.equal(bare, 'wp-pick-title,OWNSEP,FEEDBACK,LOGOUT');
    assert.deepEqual(log.pageErrors, []);
  });
});

for (const [name, viewport] of [['390x844', PHONE], ['360x740', NARROW], ['1280x500', SHORT]]) {
  test(`menu: fits the viewport and stays above the avatar at ${name}`, LONG, async () => {
    await suite.session('menu-' + name, { viewport }, async ({ page }) => {
      await openMenu(page);
      await page.waitForSelector('.wp-settings-menu [data-wp-feedback]');
      const shape = await menuShape(page);
      assert.equal(shape.entries, 1);
      assert.ok(shape.inViewport, 'menu inside the viewport');
      assert.ok(shape.aboveAvatar, 'menu above the avatar');
      await suite.shot(page, 'menu-light-' + name);
    });
  });
}

test('dialog: opens in place without navigating; Esc, the close button and the backdrop close it', LONG, async () => {
  await suite.session('dialog-shell', { route: '/#/market' }, async ({ context, page, log }) => {
    await page.fill('#fixture-input', 'typed before opening');
    const navigations = [];
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    const facts = () => page.evaluate(selector => {
      const dialog = document.querySelector(selector);
      return { open: Boolean(dialog?.open), modal: Boolean(dialog?.matches(':modal')), url: location.href, routes: window.__routes.length,
        input: document.querySelector('#fixture-input').value, menus: document.querySelectorAll('.wp-settings-menu').length,
        focusInDialog: Boolean(dialog?.contains(document.activeElement)) };
    }, D);
    const before = await facts();
    const closed = () => page.waitForFunction(selector => !document.querySelector(selector).open, D);
    const unchanged = async step => {
      const now = await facts();
      assert.equal(now.url, before.url, step + ': URL unchanged');
      assert.equal(now.routes, before.routes, step + ': the router was not triggered');
      assert.equal(now.input, 'typed before opening', step + ': page state kept');
      assert.deepEqual(navigations, [], step + ': no navigation');
      assert.equal(context.pages().length, 1, step + ': no new tab');
      return now;
    };

    await openDialog(page);
    let now = await unchanged('open');
    assert.ok(now.open && now.modal, 'a modal dialog is open');
    assert.equal(now.menus, 0, 'the menu closed');
    assert.ok(now.focusInDialog, 'focus moved into the dialog');
    assert.equal(await text(page, D + ' #wp-feedback-heading'), '反馈');
    assert.equal(await page.getAttribute(D, 'aria-labelledby'), 'wp-feedback-heading');
    assert.equal(await page.getAttribute(D + ' .wp-feedback-close', 'aria-label'), '关闭');

    await page.fill('#wp-feedback-title', 'Draft title');
    await page.fill('#wp-feedback-body', 'Draft description');
    await page.keyboard.press('Escape'); await closed();
    await unchanged('Esc');
    // Focus is handed back in the dialog's close event, which fires just after the dialog reports closed.
    const focusBack = await page.waitForFunction(() => document.activeElement?.matches('button.wp-user'), null, { timeout: 3000 }).then(() => true, () => false);
    assert.ok(focusBack, 'focus returns to the avatar button');

    await openDialog(page);
    assert.equal(await page.inputValue('#wp-feedback-title'), 'Draft title', 'draft survives closing');
    assert.equal(await page.inputValue('#wp-feedback-body'), 'Draft description');
    await page.click(D + ' .wp-feedback-close'); await closed();
    await unchanged('close button');

    await openDialog(page);
    await page.click(D + ' #wp-feedback-heading');
    assert.ok((await facts()).open, 'a click inside keeps the dialog open');
    await page.mouse.click(5, 5); await closed();
    await unchanged('backdrop');
    assert.deepEqual(log.pageErrors, []);
    assert.deepEqual(log.alerts, []);
  });
});

test('limits: the size limit is shown in MB or KB, never in bytes', LONG, async () => {
  const served = (await suite.main.request('GET', '/_wp/preview/client.js', { who: 'member' })).body.toString('utf8');
  assert.ok(served.endsWith(')({"maxImageBytes":300000,"maxImagesPerItem":3});'), 'the script receives the two numeric limits and nothing else');
  const cases = [
    ['zh-CN', suite.main, 300000, '可粘贴截图；每张最多 0.3 MB，每条最多 3 张。', '截图过大，每张最多 0.3 MB。'],
    ['en-US', suite.main, 300000, 'Paste screenshots here; up to 0.3 MB each and 3 per feedback item.', 'Screenshot too large; maximum 0.3 MB per image.'],
    ['zh-CN', suite.kb, 50000, '可粘贴截图；每张最多 48.8 KB，每条最多 3 张。', '截图过大，每张最多 48.8 KB。'],
    ['en-US', suite.kb, 50000, 'Paste screenshots here; up to 48.8 KB each and 3 per feedback item.', 'Screenshot too large; maximum 48.8 KB per image.'],
  ];
  try {
    for (const [language, gateway, limit, hint, tooLarge] of cases) {
      suite.harness.use(gateway);
      await suite.session(`limits-${language}-${limit}`, { storage: { i18nextLng: language } }, async ({ page }) => {
        await openDialog(page);
        assert.equal(await text(page, FORM + ' .wp-feedback-muted'), hint);
        await page.setInputFiles(FILE_INPUT, [file('too-large.png', pngLargerThan(limit))]);
        await page.waitForFunction(selector => document.querySelector(selector).textContent, FORM + ' .wp-feedback-message');
        assert.equal(await text(page, FORM + ' .wp-feedback-message'), tooLarge);
        assert.equal(await thumbs(page, FORM), 0, 'the oversized file is not queued');
        await page.setInputFiles(FILE_INPUT, [file('fits.png', png(100, 100, [0, 0, 0], { noise: true }))]);
        await page.waitForSelector(FORM + ' .wp-feedback-thumb');
        assert.equal(await text(page, FORM + ' .wp-feedback-message'), '', 'a file under the limit is accepted');
        assert.doesNotMatch(await page.locator(D).innerText(), /字节|bytes/i);
        if (gateway === suite.kb && language === 'zh-CN') await suite.shot(page, 'limit-kb-light-desktop');
      });
    }
  } finally { suite.harness.use(suite.main); }
});

test('picker: the button follows the language and is disabled once the item is full', LONG, async () => {
  await suite.session('picker-en', { storage: { i18nextLng: 'en-US' } }, async ({ page }) => {
    await openDialog(page);
    assert.equal(await text(page, PICKER), 'Choose images');
    assert.equal(await text(page, FORM + ' button[type=submit]'), 'Submit feedback');
    await suite.shot(page, 'dialog-en-light-desktop');
  });
  await suite.session('picker-zh', {}, async ({ page, log }) => {
    let choosers = 0;
    page.on('filechooser', () => { choosers++; });
    await openDialog(page);
    assert.equal(await text(page, PICKER), '选择图片');
    const native = await page.locator(FILE_INPUT).evaluate(input => { const box = input.getBoundingClientRect(); return { width: box.width, height: box.height, accept: input.accept, multiple: input.multiple }; });
    assert.ok(native.width <= 1 && native.height <= 1, 'the native control (whose label the browser localizes) is visually hidden');
    assert.equal(native.accept, 'image/png,image/jpeg,image/webp');
    assert.ok(native.multiple);

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(PICKER)]);
    await chooser.setFiles([file('one.png', png(40, 30, [200, 0, 0])), file('two.png', png(40, 30, [0, 200, 0])), file('three.png', png(40, 30, [0, 0, 200]))]);
    await page.waitForFunction(selector => document.querySelectorAll(selector + ' .wp-feedback-thumb').length === 3, FORM);
    assert.ok(await page.isDisabled(PICKER), 'button disabled with 3 of 3 queued');
    assert.ok(await page.isDisabled(FILE_INPUT), 'native input disabled with 3 of 3 queued');
    await suite.shot(page, 'picker-full-light-desktop');
    const opened = choosers;
    await page.evaluate(selector => document.querySelector(selector).click(), PICKER);
    await page.waitForTimeout(500);
    assert.equal(choosers, opened, 'a disabled button opens no file chooser');

    await page.click(FORM + ' .wp-feedback-thumb button');
    await page.waitForFunction(selector => document.querySelectorAll(selector + ' .wp-feedback-thumb').length === 2, FORM);
    assert.ok(await page.isEnabled(PICKER), 'removing one enables the button again');

    const detailPicker = '#wp-feedback-detail .wp-feedback-picker button';
    await openEntry(page, suite.full.title);
    assert.equal(await text(page, detailPicker), '选择图片');
    assert.ok(await page.isDisabled(detailPicker), 'an item that already stores 3 screenshots accepts no more');
    await openEntry(page, suite.plain.title);
    assert.ok(await page.isEnabled(detailPicker), 'an item without screenshots accepts more');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('paste: a screenshot pasted inside the dialog does not reach listeners behind it', LONG, async t => {
  // Stand-in for the main UI: a chat box plus page-level paste listeners that collect pasted files.
  const stub = () => {
    window.__paste = { window: 0, document: 0, attachments: 0 };
    const files = event => [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').length;
    window.addEventListener('paste', () => { window.__paste.window++; });
    document.addEventListener('paste', event => { window.__paste.document++; if (files(event)) window.__paste.attachments++; });
    document.addEventListener('DOMContentLoaded', () => {
      const chat = document.createElement('textarea');
      chat.id = 'fixture-chat'; chat.style.cssText = 'position:fixed;right:8px;bottom:8px;width:200px;height:40px';
      document.body.append(chat);
    }, { once: true });
  };
  const seen = page => page.evaluate(() => ({ ...window.__paste }));
  const image = png(48, 32, [220, 120, 0]);

  await suite.session('paste', { init: [[stub]] }, async ({ page, log }) => {
    await paste(page, '#fixture-chat', { bytes: image });
    assert.deepEqual(await seen(page), { window: 1, document: 1, attachments: 1 }, 'control: with the dialog closed the stand-in receives the paste');

    await openDialog(page);
    let before = await seen(page);
    for (const [selector, expected] of [['#wp-feedback-body', 1], ['#wp-feedback-title', 2]]) {
      const result = await paste(page, selector, { bytes: image });
      assert.ok(result.defaultPrevented, selector + ': default action prevented');
      assert.equal(await thumbs(page, FORM), expected, selector + ': the screenshot is queued in the form');
      assert.deepEqual(await seen(page), before, selector + ': nothing reached the page-level listeners');
    }
    assert.equal(await page.inputValue('#wp-feedback-body'), '');

    const plain = await paste(page, '#wp-feedback-body', { text: 'plain text' });
    assert.equal(plain.defaultPrevented, false, 'plain text is left to the browser');
    assert.equal(await thumbs(page, FORM), 2);
    assert.equal((await seen(page)).attachments, before.attachments);

    await openEntry(page, suite.plain.title);
    before = await seen(page);
    const detail = await paste(page, '#wp-feedback-detail textarea', { bytes: image });
    assert.ok(detail.defaultPrevented, 'comment box: default action prevented');
    assert.equal(await thumbs(page, '#wp-feedback-detail'), 1, 'comment box: the screenshot is queued on the item');
    assert.deepEqual(await seen(page), before, 'comment box: nothing reached the page-level listeners');
    await suite.shot(page, 'paste-light-desktop');

    await page.keyboard.press('Escape');
    await page.waitForFunction(selector => !document.querySelector(selector).open, D);
    before = await seen(page);
    await paste(page, '#fixture-chat', { bytes: image });
    assert.equal((await seen(page)).attachments, before.attachments + 1, 'after closing, the page receives pastes again');
    assert.deepEqual(log.pageErrors, []);
  });

  // The same through the real clipboard and Ctrl+V, where the browser provides one.
  await suite.session('paste-clipboard', { init: [[stub]], permissions: ['clipboard-read', 'clipboard-write'] }, async ({ page }) => {
    const copy = () => page.evaluate(async base64 => {
      try {
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
        return true;
      } catch { return false; }
    }, image.toString('base64'));
    const copied = await copy();
    await page.focus('#fixture-chat'); await page.keyboard.press('Control+V'); await page.waitForTimeout(400);
    if (!copied || (await seen(page)).attachments !== 1) {
      t.diagnostic('system clipboard unavailable in this browser: Ctrl+V variant skipped, the dispatched-event variant above still ran');
      return;
    }
    await openDialog(page);
    const before = await seen(page);
    await copy();
    await page.focus('#wp-feedback-body'); await page.keyboard.press('Control+V');
    await page.waitForSelector(FORM + ' .wp-feedback-thumb');
    await page.waitForTimeout(300);
    assert.equal(await thumbs(page, FORM), 1, 'Ctrl+V queues the screenshot');
    assert.deepEqual(await seen(page), before, 'Ctrl+V: nothing reached the page-level listeners');
    t.diagnostic('system clipboard available: Ctrl+V variant ran');
  });
});

for (const [name, viewport] of [['360x740', NARROW], ['390x844', PHONE]]) {
  test(`layout: no horizontal overflow at ${name}`, LONG, async () => {
    await suite.session('overflow-' + name, { viewport }, async ({ page, log }) => {
      const pageWidth = () => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      const fits = async step => {
        const facts = await overflow(page);
        assert.ok(facts.pageScrollWidth <= facts.pageClientWidth, `${step}: page scrolls sideways (${facts.pageScrollWidth} > ${facts.pageClientWidth})`);
        assert.ok(facts.dialogScrollWidth <= facts.dialogClientWidth, `${step}: dialog scrolls sideways (${facts.dialogScrollWidth} > ${facts.dialogClientWidth})`);
        assert.deepEqual(facts.outside, [], step + ': elements stick out of the dialog');
        assert.ok(facts.dialogInViewport, step + ': dialog inside the viewport');
      };
      let width = await pageWidth();
      assert.ok(width.scroll <= width.client, 'page before opening anything');
      await openMenu(page);
      width = await pageWidth();
      assert.ok(width.scroll <= width.client, 'page with the menu open');
      assert.ok((await menuShape(page)).inViewport, 'menu inside the viewport');

      await openDialog(page);
      await fits('list');
      await suite.shot(page, 'dialog-light-' + name);
      await page.setInputFiles(FILE_INPUT, [file(LONG_NAME, png(40, 30, [10, 10, 10]))]);
      await page.waitForSelector(FORM + ' .wp-feedback-thumb');
      await page.fill('#wp-feedback-title', LONG_TITLE);
      await fits('form with a long title and a long file name');
      await openEntry(page, suite.full.title);
      await fits('detail with screenshots');
      await suite.shot(page, 'detail-light-' + name);
      await openEntry(page, LONG_TITLE.slice(0, 40));
      await fits('detail with a 120 character title and a long link');
      await suite.shot(page, 'detail-long-light-' + name);
      assert.deepEqual(log.pageErrors, []);
    });
  });
}

test('appearance: the dialog follows light and dark mode', LONG, async () => {
  const seen = {};
  for (const theme of ['light', 'dark']) {
    for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
      await suite.session(`appearance-${theme}-${name}`, { viewport, storage: { 'fixture-theme': theme } }, async ({ page, log }) => {
        assert.equal(await page.getAttribute('html', 'data-theme'), theme);
        if (theme === 'dark' && name === 'desktop') { await openMenu(page); await suite.shot(page, 'menu-dark-desktop'); }
        await openDialog(page);
        const style = await page.evaluate(selector => {
          const dialog = document.querySelector(selector), of = node => getComputedStyle(node);
          return { dialog: of(dialog).colorScheme, select: of(dialog.querySelector('select')).colorScheme, textarea: of(dialog.querySelector('textarea')).colorScheme,
            background: of(dialog).backgroundColor, ink: of(dialog).color };
        }, D);
        assert.equal(style.dialog, theme, 'color-scheme of the dialog');
        assert.equal(style.select, theme, 'color-scheme reaches the native select');
        assert.equal(style.textarea, theme, 'color-scheme reaches the text area');
        seen[theme] = style;
        await suite.shot(page, `dialog-${theme}-${name}`);
        await openEntry(page, suite.full.title);
        await suite.shot(page, `detail-${theme}-${name}`);
        await page.locator('#wp-feedback-detail .wp-feedback-images').evaluate(node => node.scrollIntoView({ block: 'center' }));
        await page.waitForFunction(() => [...document.querySelectorAll('#wp-feedback-detail .wp-feedback-images img')].every(img => img.complete && img.naturalWidth > 0));
        await suite.shot(page, `detail-images-${theme}-${name}`);
        assert.deepEqual(log.pageErrors, []);
      });
    }
  }
  assert.notEqual(seen.dark.background, seen.light.background, 'dark mode uses its own background');
  assert.notEqual(seen.dark.ink, seen.light.ink, 'dark mode uses its own text colour');

  // Switching from the menu while the page is open flips the dialog too.
  await suite.session('appearance-switch', {}, async ({ page }) => {
    await choose(page, 'theme', 'dark');
    await openDialog(page);
    assert.equal(await page.evaluate(selector => getComputedStyle(document.querySelector(selector)).colorScheme, D), 'dark');
  });
});
