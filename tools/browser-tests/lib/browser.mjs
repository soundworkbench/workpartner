// Browser helpers. No browser is downloaded: an existing Chrome or Chromium is driven through playwright-core.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HOST, ORIGIN, outputRoot } from './harness.mjs';

export const D = 'dialog.wp-feedback-dialog';
export const K = 'dialog.wp-my-key-dialog';
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };

/** CHROME_PATH (or CHROME_BIN) wins; otherwise the first Chrome/Chromium found on PATH. */
export function findChrome() {
  for (const name of ['CHROME_PATH', 'CHROME_BIN']) {
    const value = process.env[name];
    if (!value) continue;
    if (!fs.existsSync(value)) throw new Error(`${name} points to a missing file: ${value}`);
    return value;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      if (!directory) continue;
      const candidate = path.join(directory, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* Keep looking. */ }
    }
  }
  throw new Error('No Chrome or Chromium found. Install one or set CHROME_PATH to its executable.');
}

export async function launch(harness) {
  return chromium.launch({
    executablePath: findChrome(), headless: true,
    args: ['--no-sandbox', '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${harness.frontPort}`],
  });
}

/** Record everything a test may want to assert on; native alerts are dismissed so the page keeps running. */
export function monitor(page) {
  const log = { pageErrors: [], consoleErrors: [], alerts: [], requests: [] };
  page.on('pageerror', error => log.pageErrors.push(String(error?.stack || error)));
  page.on('console', message => { if (message.type() === 'error') log.consoleErrors.push(message.text()); });
  page.on('dialog', async dialog => { log.alerts.push({ type: dialog.type(), message: dialog.message() }); await dialog.dismiss().catch(() => {}); });
  page.on('request', request => { const url = new URL(request.url()); log.requests.push(request.method() + ' ' + url.pathname + url.search); });
  return log;
}

/**
 * Open the main page as one of the fixture people. `storage` seeds localStorage once (language:
 * i18nextLng, appearance: fixture-theme); `init` is a list of [function, argument] scripts run before the page's own.
 */
export async function open(browser, harness, { who = 'member', viewport = DESKTOP, storage = {}, route = '/', init = [], permissions = [], avatar = true } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, colorScheme: 'light', locale: 'zh-CN' });
  context.setDefaultTimeout(15000);
  if (who !== 'none') await context.addCookies([{ name: 'wp_sid', value: harness.cookie(who), domain: HOST, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  if (permissions.length) await context.grantPermissions(permissions, { origin: ORIGIN });
  if (Object.keys(storage).length) await context.addInitScript(seed => {
    for (const [key, value] of Object.entries(seed)) {
      if (localStorage.getItem('fixture-seeded-' + key) !== null) continue;
      localStorage.setItem(key, value); localStorage.setItem('fixture-seeded-' + key, '1');
    }
  }, storage);
  for (const [script, argument] of init) await context.addInitScript(script, argument);
  const page = await context.newPage();
  const log = monitor(page);
  if (route !== null) {
    await page.goto(ORIGIN + route);
    if (avatar) await waitAvatar(page);
  }
  return { context, page, log, close: () => context.close() };
}

export const waitAvatar = page => page.waitForSelector('button.wp-user');

export async function openMenu(page) {
  if (!(await page.$('.wp-settings-menu'))) await page.click('button.wp-user');
  await page.waitForSelector('.wp-settings-menu [role=menuitemradio]');
  await page.waitForTimeout(150);
}

export async function closeMenu(page) {
  if (await page.$('.wp-settings-menu')) await page.click('button.wp-user');
  await page.waitForFunction(() => !document.querySelector('.wp-settings-menu'));
}

/** Choose an appearance or language in the real settings menu; the menu re-renders and stays open. */
export async function choose(page, setting, value) {
  await openMenu(page);
  await page.click(`.wp-settings-menu [data-setting="${setting}"][data-value="${value}"]`);
  await page.waitForFunction(([setting, value]) => document.querySelector(`.wp-settings-menu [data-setting="${setting}"][data-value="${value}"]`)?.getAttribute('aria-checked') === 'true',
    [setting, value], { timeout: 5000 });
  await page.waitForTimeout(300);
}

/** Open the dialog from the avatar menu and wait until the list request has been rendered. */
export async function openDialog(page) {
  await openMenu(page);
  await page.click('.wp-settings-menu [data-wp-feedback]');
  await page.waitForSelector(D + '[open]');
  await page.waitForFunction(selector => document.querySelector(selector + ' .wp-feedback-list')?.children.length > 0, D);
  await page.waitForTimeout(200);
}

/** Open My key and wait for a terminal usage state, including an unavailable upstream. */
export async function openMyKey(page) {
  if (!(await page.$('.wp-settings-menu'))) await page.click('button.wp-user');
  await page.click('.wp-settings-menu [data-wp-my-key]');
  await page.waitForSelector(K + '[open]');
  await page.waitForFunction(selector => {
    const state = document.querySelector(selector + ' [data-wp-my-key-card="usage"]')?.dataset.state;
    return state === 'ready' || state === 'unavailable';
  }, K);
}

export async function openEntry(page, text) {
  await page.click(`${D} .wp-feedback-entry:has-text(${JSON.stringify(text)})`);
  await page.waitForFunction(text => (document.querySelector('#wp-feedback-detail:not([hidden]) h3')?.textContent || '').includes(text), text);
  await page.waitForTimeout(200);
}

/** The settings menu as a comma separated list of its children. OWNSEP belongs to an optional entry. */
export function menuShape(page) {
  return page.evaluate(() => {
    const menu = document.querySelector('.wp-settings-menu');
    if (!menu) return null;
    const kids = [...menu.children].map(kid => kid.hasAttribute('data-wp-feedback') ? 'FEEDBACK'
      : kid.hasAttribute('data-wp-my-key') ? 'MYKEY'
      : kid.classList.contains('wp-pick-sep') ? (kid.hasAttribute('data-wp-feedback-separator') || kid.hasAttribute('data-wp-my-key-separator') ? 'OWNSEP' : 'SEP')
        : kid.getAttribute('role') === 'menuitem' ? 'LOGOUT' : kid.className.split(' ')[0]);
    const box = menu.getBoundingClientRect(), avatar = document.querySelector('button.wp-user').getBoundingClientRect();
    return {
      kids: kids.join(','), entries: kids.filter(kid => kid === 'FEEDBACK').length, separators: kids.filter(kid => kid.endsWith('SEP')).length,
      ...(kids.includes('MYKEY') ? { myKeyEntries: kids.filter(kid => kid === 'MYKEY').length } : {}),
      label: menu.querySelector('[data-wp-feedback]')?.textContent ?? null, menus: document.querySelectorAll('.wp-settings-menu').length,
      aboveAvatar: box.bottom <= avatar.top + 0.5, inViewport: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
    };
  });
}

/** Horizontal overflow facts for the open dialog and the page behind it. */
export function overflow(page, selector = D) {
  return page.evaluate(selector => {
    const dialog = document.querySelector(selector), box = dialog.getBoundingClientRect();
    const outside = [...dialog.querySelectorAll('*')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5);
    }).slice(0, 5).map(node => node.tagName.toLowerCase() + '.' + node.className);
    return {
      pageScrollWidth: document.documentElement.scrollWidth, pageClientWidth: document.documentElement.clientWidth,
      dialogScrollWidth: dialog.scrollWidth, dialogClientWidth: dialog.clientWidth, outside,
      dialogInViewport: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
    };
  }, selector);
}

/** Where the detail heading and any status message sit relative to the visible part of the dialog. */
export function visibility(page) {
  return page.evaluate(selector => {
    const dialog = document.querySelector(selector), detail = document.querySelector('#wp-feedback-detail'), box = dialog.getBoundingClientRect();
    const inside = rect => rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom && rect.left >= box.left && rect.right <= box.right;
    const heading = detail && !detail.hidden ? detail.querySelector('h3') : null, rect = heading?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.left + Math.min(20, rect.width / 2), rect.top + rect.height / 2) : null;
    return {
      open: dialog.open,
      heading: heading ? { text: heading.textContent, inside: inside(rect), onTop: Boolean(hit) && (hit === heading || heading.contains(hit)), fromDialogTop: Math.round(rect.top - box.top) } : null,
      messages: [...dialog.querySelectorAll('.wp-feedback-message')].filter(node => node.textContent).map(node => ({ text: node.textContent, inside: inside(node.getBoundingClientRect()) })),
      focusInDialog: dialog.contains(document.activeElement),
      scrollY: Math.round(scrollY), pageScrolls: window.__pageScrolls || [], url: location.pathname + location.search + location.hash,
    };
  }, D);
}

/** Init script: remember every page-level scroll; in "spacer" mode make the page itself scrollable and scroll it to 400 first. */
export function scrollProbe(mode) {
  window.__pageScrolls = [];
  document.addEventListener('scroll', event => { if (event.target === document) window.__pageScrolls.push(Math.round(scrollY)); });
  if (mode === 'spacer') document.addEventListener('DOMContentLoaded', () => {
    const spacer = document.createElement('div');
    spacer.id = 'fixture-spacer'; spacer.style.height = '3000px';
    document.body.append(spacer); scrollTo(0, 400);
  }, { once: true });
}

/**
 * Dispatch a paste event that carries one PNG file (or, with `text`, plain text only) on the element.
 * Returns whether a handler called preventDefault(). Works without a system clipboard.
 */
export function paste(page, selector, { bytes, name = 'pasted.png', text } = {}) {
  return page.evaluate(([selector, base64, name, text]) => {
    const data = new DataTransfer();
    if (base64) data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type: 'image/png' }));
    if (text !== null) data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector(selector).dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented };
  }, [selector, bytes ? bytes.toString('base64') : null, name, text ?? null]);
}

/** Requests recorded by monitor() whose "METHOD /path?query" matches. */
export const requests = (log, pattern) => log.requests.filter(line => pattern.test(line));

/** Screenshots land in <output>/shots/<group>/ and are uploaded by the workflow for a human to look at. */
export function shooter(group) {
  const directory = path.join(outputRoot, 'shots', group);
  fs.mkdirSync(directory, { recursive: true });
  return async (page, name, options = {}) => { await page.screenshot({ path: path.join(directory, name + '.png'), ...options }); };
}
