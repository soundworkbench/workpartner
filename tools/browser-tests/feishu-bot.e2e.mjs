import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { openMenu, closeMenu } from './lib/browser.mjs';

const API = '/_wp/feishu-bot', S = '.wp-feishu-bot-section', CARD = '.wp-feishu-bot-card';
const bot = { appId: 'cli_Test123', name: '唐的飞书智能体', avatar: null, online: 'online', activate: true, lastEventAt: null, error: null };
// Opaque blue RGB PNG, not the previous transparent tracking pixel.
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQj/8AAAIPAW823JCjAAAAAElFTkSuQmCC';
const brokenAvatar = 'data:image/gif;base64,broken';
const openUrl = 'https://applink.feishu.cn/client/bot/open?appId=cli_Test123';
const suite = createSuite('feishu-bot', async s => {
  s.main = await s.harness.startGateway('bots', { feishuBot: { allow: ['member'] }, bots: [bot], myKey: { allow: ['member'] } });
  s.noPreview = await s.harness.startGateway('no-preview', { preview: false, feishuBot: { allow: ['member'] }, bots: [bot] });
  s.menuCases = [];
  for (const feedback of [false, true]) for (const feishuBot of [false, true]) for (const myKey of [false, true]) {
    const label = `menu-${Number(feedback)}-${Number(feishuBot)}-${Number(myKey)}`;
    const gateway = await s.harness.startGateway(label, { feedback,
      feishuBot: feishuBot ? { allow: ['member'] } : null, myKey: myKey ? { allow: ['member'] } : null });
    s.menuCases.push({ label, gateway, feedback, feishuBot, myKey });
  }
});
function init() {
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copied.push(value); } } });
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('fixture-feishu-bot');
    const input = document.querySelector('#fixture-input');
    const composer = input.parentElement;
    composer.classList.add('_guidInputCardWrap_fixture_1');
    const container = document.createElement('div'); container.className = '_guidContainer_fixture_1';
    composer.before(container); container.append(composer);
    function route() {
      if (location.hash.split('?')[0] === '#/guid') input.setAttribute('data-testid', 'guid-input');
      else input.removeAttribute('data-testid');
      // The real SPA replaces its composer subtree when changing pages.
      input.parentElement.append(input);
    }
    route(); addEventListener('hashchange', route);
  }, { once: true });
}
async function sidebar(page) {
  await page.locator('[data-wp-nav="agents"]').waitFor();
  if (page.viewportSize().width < 768) {
    if (await page.locator('aside.layout-sider').evaluate(el => el.getBoundingClientRect().right <= 0)) {
      await page.locator('.app-titlebar__menu button.app-titlebar__button').click();
    }
    await page.waitForFunction(() => document.querySelector('aside.layout-sider').getBoundingClientRect().left >= 0);
  }
  assert.equal(await page.locator('[data-wp-nav="agents"] .wp-nav-text').evaluate(el => el.scrollWidth <= el.clientWidth), true,
    'the sidebar label must not be truncated');
  assert.equal(await page.locator('aside.layout-sider main.layout-sider-content').count(), 1);
  for (const key of ['search', 'auto', 'market', 'agents']) {
    assert.equal(await page.locator(`[data-wp-nav="${key}"]`).isVisible(), true, 'sidebar menus remain visible with the agents panel open');
  }
}
async function enterAgents(page) {
  await sidebar(page);
  await page.locator('[data-wp-nav="agents"]').click();
  await page.locator(S).waitFor();
  if (page.viewportSize().width < 768) {
    await page.waitForFunction(() => document.querySelector('aside.layout-sider').getBoundingClientRect().right <= 0);
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('fixture-drawer-open')), false);
  }
}
async function ready(page) {
  if (!(await page.locator(S).count())) await enterAgents(page);
  await page.locator(S).waitFor();
  await page.waitForFunction(selector => !document.querySelector(selector + ' button[aria-label="刷新"]').disabled, S);
}
async function homeShot(page, label) {
  await page.locator('[data-wp-nav="agents"]').waitFor();
  assert.equal(new URL(page.url()).hash, '#/guid');
  assert.equal(await page.locator(S).count(), 0);
  assert.equal(await page.locator('#fixture-input').isVisible(), true);
  await suite.shot(page, 'homepage-empty-' + label, { fullPage: true });
}
async function sidebarShot(page, label) {
  await sidebar(page);
  await suite.shot(page, 'sidebar-agents-' + label, { fullPage: true });
  if (page.viewportSize().width < 768) await enterAgents(page);
}
async function more(first) {
  await first.getByRole('link', { name: '去对话', exact: true }).focus();
  await first.getByRole('button', { name: '更多操作' }).click();
}
async function fits(page) {
  const result = await page.locator(S).evaluate(section => ({
    page: document.documentElement.scrollWidth <= innerWidth,
    section: section.scrollWidth <= section.clientWidth,
    outside: [...section.querySelectorAll('*')].filter(element => {
      const r = element.getBoundingClientRect(); return r.width && (r.left < 0 || r.right > innerWidth + .5);
    }).map(element => element.className),
  }));
  assert.deepEqual(result, { page: true, section: true, outside: [] });
}
for (const width of [1280, 390, 360]) {
  test(`agents page cards at ${width}px, states, actions and no overflow`, LONG, async () => {
    suite.harness.use(suite.main);
    suite.main.setBots([bot, { ...bot, appId: 'cli_Second', name: '很长的飞书应用名字'.repeat(8), avatar, online: 'offline', lastEventAt: new Date(Date.now() - 5 * 60000).toISOString() },
      { ...bot, appId: 'cli_Third', name: null, avatar: brokenAvatar, online: 'unknown', error: 'feishu_auth_failed' }]);
    await suite.session('width-' + width, { route: '/#/guid', viewport: { width, height: 844 }, avatar: width >= 768, init: [[init]] }, async ({ page, log }) => {
      await homeShot(page, width);
      await ready(page); await page.locator(CARD).first().waitFor();
      assert.equal(await page.locator('#fixture-input').isVisible(), false);
      assert.equal(await page.locator(S + ' h2#wp-feishu-bot-title').count(), 1);
      assert.equal(await page.locator('dialog').count(), 0);
      assert.equal(await page.locator('.wp-feishu-bot-bar').count(), 0);
      assert.equal(new URL(page.url()).hash, '#/guid?wp=agents');
      assert.equal(await page.locator('[data-wp-nav="market"] + [data-wp-nav="agents"]').count(), 1);
      assert.equal(await page.locator('[data-wp-nav="agents"]').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator(S).evaluate(section => section.parentElement === document.querySelector('main.layout-content')), true);
      assert.equal(await page.locator('aside.layout-sider ' + S).count(), 0);
      assert.equal(await page.locator(CARD).count(), 3);
      assert.equal(await page.locator('.wp-feishu-bot-tag').count(), 0);
      assert.equal(await page.locator('.wp-feishu-bot-cards > :first-child').getAttribute('aria-label'), '连接飞书');
      const first = page.locator(CARD).first();
      assert.equal(await first.locator('h3').innerText(), bot.name);
      assert.equal(await first.locator('.wp-feishu-bot-summary').innerText(), 'App ID ' + bot.appId);
      assert.match(await page.locator(CARD).nth(1).locator('.wp-feishu-bot-summary').innerText(), /最近消息 [56] 分钟前/);
      assert.equal(await first.locator('.wp-feishu-bot-avatar').innerText(), '唐');
      assert.equal(await page.locator(CARD).nth(1).locator('.wp-feishu-bot-avatar img').getAttribute('src'), avatar);
      await page.waitForFunction(selector => {
        const image = document.querySelectorAll(selector)[1].querySelector('img');
        return image?.complete && image.naturalWidth > 0;
      }, CARD + ' .wp-feishu-bot-avatar');
      assert.deepEqual(await page.locator(CARD).nth(1).locator('.wp-feishu-bot-avatar img').evaluate(image => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      }), [31, 95, 240, 255], 'fixture avatar has visible opaque pixels');
      await page.waitForFunction(selector => document.querySelectorAll(selector)[2].textContent === '飞', CARD + ' .wp-feishu-bot-avatar');
      assert.equal(await page.locator(CARD).nth(2).locator('.wp-feishu-bot-avatar img').count(), 0);
      assert.equal(await page.locator(S).getByText('暂时拿不到飞书应用信息', { exact: true }).count(), 1);
      assert.equal(await page.locator(S).getByRole('heading', { name: '智能体', exact: true }).count(), 1);
      assert.deepEqual(await page.locator(CARD + ' .wp-feishu-bot-state').allTextContents(), ['在线', '离线', '状态未知']);
      const longName = page.locator(CARD).nth(1).locator('h3');
      const nameLayout = await longName.evaluate(el => ({
        width: el.clientWidth, height: el.clientHeight, fullHeight: el.scrollHeight,
        fullWidth: el.scrollWidth, lineHeight: parseFloat(getComputedStyle(el).lineHeight),
        clamp: getComputedStyle(el).webkitLineClamp, text: el.textContent, title: el.title,
      }));
      assert.ok(nameLayout.width > 150);
      assert.equal(nameLayout.title, nameLayout.text);
      assert.equal(nameLayout.fullWidth, nameLayout.width, 'name never overflows horizontally');
      if (width >= 768) {
        assert.equal(nameLayout.clamp, '2');
        assert.ok(nameLayout.height <= nameLayout.lineHeight * 2 + 1);
        assert.ok(nameLayout.fullHeight > nameLayout.height, 'long desktop name is clamped');
        const row = await page.locator('.wp-feishu-bot-cards > *').evaluateAll(cards => cards.map(el => {
          const r = el.getBoundingClientRect(); return { y: r.y, height: r.height };
        }));
        for (const card of row.filter(card => Math.abs(card.y - row[0].y) < 1)) {
          assert.equal(card.height, row[0].height, 'add and bot cards in the same row have equal height');
          assert.ok(card.height <= 240, 'desktop row stays compact with a long name');
        }
      } else {
        assert.equal(nameLayout.clamp, 'none');
        assert.equal(nameLayout.fullHeight, nameLayout.height, 'mobile name is fully visible');
        assert.ok(nameLayout.height > nameLayout.lineHeight * 2);
      }
      const chat = first.getByRole('link', { name: '去对话', exact: true });
      assert.equal(await chat.getAttribute('href'), openUrl); assert.equal(await chat.getAttribute('target'), '_blank');
      assert.match(await chat.getAttribute('rel'), /noopener/);
      assert.equal(await first.getByRole('link', { name: '管理', exact: true }).getAttribute('href'), 'https://open.feishu.cn/app/' + bot.appId);
      await page.mouse.move(0, 0); await fits(page);
      assert.equal(await first.locator('.wp-feishu-bot-actions').evaluate(el => getComputedStyle(el).opacity), width < 768 ? '1' : '0');
      await suite.shot(page, `agents-${width}`, { fullPage: true });
      await sidebarShot(page, width);
      if (width === 1280) {
        await first.hover();
        assert.equal(await first.locator('.wp-feishu-bot-summary').evaluate(el => getComputedStyle(el).visibility), 'hidden');
        assert.equal(await first.locator('.wp-feishu-bot-actions').evaluate(el => getComputedStyle(el).opacity), '1');
        await suite.shot(page, 'agents-1280-hover', { fullPage: true });
        await page.mouse.move(0, 0); await chat.focus();
        assert.equal(await first.locator('.wp-feishu-bot-actions').evaluate(el => getComputedStyle(el).opacity), '1');
      } else {
        assert.equal(await page.locator('#root > aside').evaluate(el => el.getBoundingClientRect().right <= 0), true);
        await chat.focus();
        assert.equal(await first.locator('.wp-feishu-bot-summary').evaluate(el => getComputedStyle(el).visibility), 'visible');
        const summary = await first.locator('.wp-feishu-bot-summary').boundingBox(), actions = await first.locator('.wp-feishu-bot-actions').boundingBox();
        assert.ok(actions.y >= summary.y + summary.height);
      }
      await more(first);
      const header = page.locator('.wp-feishu-bot-header'); await header.scrollIntoViewIfNeeded();
      const headerBox = await header.boundingBox();
      await page.mouse.click(headerBox.x + 2, headerBox.y + headerBox.height + 7); // Blank gap above the cards.
      assert.equal(await page.locator('.wp-feishu-bot-menu').count(), 0, 'clicking blank space outside the card closes the menu');
      assert.equal(await first.getByRole('button', { name: '更多操作' }).getAttribute('aria-expanded'), 'false');
      // Regress the Actions sequence: copy, add hint, Escape (render), then reconnect.
      await more(first);
      const cardY = await first.evaluate(el => el.getBoundingClientRect().y);
      await first.getByRole('button', { name: '复制 App ID' }).click();
      assert.deepEqual(await page.evaluate(() => window.__copied), [bot.appId], 'copy handler reaches the clipboard before showing the toast');
      await page.getByText('已复制 App ID', { exact: true }).waitFor();
      const toast = await page.locator('.wp-feishu-bot-message').evaluate(el => {
        const r = el.getBoundingClientRect(), css = getComputedStyle(el);
        return { connected: el.isConnected, hidden: el.hidden, display: css.display, position: css.position,
          width: r.width, height: r.height, top: r.top, bottom: r.bottom, viewport: innerHeight };
      });
      assert.equal(toast.connected, true); assert.equal(toast.hidden, false); assert.notEqual(toast.display, 'none');
      assert.equal(toast.position, 'fixed'); assert.ok(toast.width > 0 && toast.height > 0);
      assert.ok(toast.top >= 0 && toast.bottom <= toast.viewport, 'toast has a visible box inside the viewport');
      assert.equal(await first.evaluate(el => el.getBoundingClientRect().y), cardY, 'copy hint does not move cards');
      assert.equal(await page.locator('.wp-feishu-bot-message').getAttribute('aria-live'), 'polite');
      const count = log.requests.filter(url => url.includes(API)).length;
      await page.getByRole('button', { name: '连接飞书', exact: true }).scrollIntoViewIfNeeded();
      const addY = await first.evaluate(el => el.getBoundingClientRect().y);
      await page.getByRole('button', { name: '连接飞书', exact: true }).click();
      await page.getByText('一个工作伙伴暂时只能连接一个飞书应用，更多智能体功能暂未开放', { exact: true }).waitFor();
      assert.equal(await first.evaluate(el => el.getBoundingClientRect().y), addY, 'add hint does not move cards');
      assert.equal(log.requests.filter(url => url.includes(API)).length, count);
      await more(first); await page.keyboard.press('Escape');
      assert.equal(await page.locator('.wp-feishu-bot-menu').count(), 0);
      assert.equal(await first.getByRole('button', { name: '更多操作' }).evaluate(el => el === document.activeElement), true);
      const before = suite.main.botCommands.length;
      await more(first); await first.getByRole('button', { name: '重新连接', exact: true }).click();
      assert.equal(suite.main.botCommands.length, before);
      assert.equal(await first.locator('[data-wp-feishu-bot-confirm]').count(), 1);
      assert.equal(await first.getByRole('button', { name: '取消', exact: true }).evaluate(el => el === document.activeElement), true,
        'copy → Escape → reconnect reaches the live inline confirmation');
      const background = page.waitForResponse(r => r.url().endsWith(API + '/bots'));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await background;
      assert.equal(await first.locator('[data-wp-feishu-bot-confirm]').count(), 1, 'refresh preserves inline confirmation');
      await first.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal(suite.main.botCommands.slice(before).some(cmd => cmd.at(-1) === 'restart'), false);
      await more(first); await first.getByRole('button', { name: '重新连接', exact: true }).click();
      const response = page.waitForResponse(r => r.url().endsWith(API + '/reconnect'));
      const reconnectStarted = Date.now();
      await first.getByRole('button', { name: '确认重新连接', exact: true }).click();
      assert.equal((await response).status(), 200);
      assert.ok(suite.main.botCommands.slice(before).some(cmd => cmd.at(-1) === 'restart'));
      await page.waitForResponse(r => r.url().includes(API + '/bots'), { timeout: 6000 });
      assert.ok(Date.now() - reconnectStarted >= 2500);
      const refresh = page.waitForResponse(r => r.url().endsWith(API + '/bots?refresh=1'));
      await page.locator(S).getByRole('button', { name: '刷新', exact: true }).click(); await refresh;
      assert.deepEqual(suite.main.botCommands.at(-1).slice(-2), ['info', '--refresh']);
      await fits(page); assert.equal(await page.locator('dialog').count(), 0);
      if (width === 390) {
        const last = page.locator(CARD).last(); await last.scrollIntoViewIfNeeded();
        const visible = await last.evaluate(el => {
          const r = el.getBoundingClientRect(), main = el.closest('main.layout-content').getBoundingClientRect();
          return r.top >= Math.max(0, main.top) && r.bottom <= Math.min(innerHeight, main.bottom) + 1;
        });
        assert.equal(visible, true, '390px can scroll to the complete last card including its bottom');
      }
      assert.deepEqual(log.pageErrors, []);
    });
  });
}

test('dark desktop cards remain readable', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('dark', { route: '/#/guid', viewport: { width: 1280, height: 844 }, storage: { 'fixture-theme': 'dark' }, init: [[init]] }, async ({ page, log }) => {
    await homeShot(page, 'dark-1280');
    await ready(page); await page.locator(CARD).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    const colors = await page.locator(CARD).evaluate(card => ({
      background: getComputedStyle(card).backgroundColor,
      name: getComputedStyle(card.querySelector('h3')).color,
      summary: getComputedStyle(card.querySelector('.wp-feishu-bot-summary')).color,
    }));
    assert.notEqual(colors.background, colors.name);
    assert.notEqual(colors.background, colors.summary);
    const headingColors = await page.locator('#wp-feishu-bot-title').evaluate(title => {
      let backdrop = title;
      while (backdrop.parentElement && getComputedStyle(backdrop).backgroundColor === 'rgba(0, 0, 0, 0)') backdrop = backdrop.parentElement;
      return { foreground: getComputedStyle(title).color, background: getComputedStyle(backdrop).backgroundColor,
        mainBackground: getComputedStyle(title.closest('main.layout-content')).backgroundColor };
    });
    assert.equal(headingColors.background, headingColors.mainBackground, 'title sits on the themed main background');
    assert.equal(headingColors.background, 'rgb(24, 24, 24)');
    assert.notEqual(headingColors.foreground, headingColors.background);
    await page.locator(CARD).hover(); await fits(page); await suite.shot(page, 'agents-dark-1280');
    await sidebarShot(page, 'dark-1280');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('menu features share one separator in every enablement combination', LONG, async () => {
  let baselineSeparators;
  for (const { label, gateway, feedback, feishuBot, myKey } of suite.menuCases) {
    suite.harness.use(gateway);
    await suite.session(label, {}, async ({ page, log }) => {
      for (let round = 0; round < 2; round++) {
        await openMenu(page);
        const shape = await page.locator('.wp-settings-menu').evaluate(menu => {
          const children = [...menu.children];
          const kinds = children.map(element => element.matches('.wp-pick-sep') ? 'SEP'
            : element.matches('[data-wp-feishu-bot]') ? 'BOT' : element.matches('[data-wp-my-key]') ? 'KEY'
            : element.matches('[data-wp-feedback]') ? 'FEEDBACK' : element.getAttribute('role') === 'menuitem' ? 'LOGOUT' : 'EXISTING');
          return { kinds, separators: kinds.filter(kind => kind === 'SEP').length };
        });
        baselineSeparators ??= shape.separators;
        const group = ['SEP', ...(feishuBot ? ['BOT'] : []), ...(feedback ? ['FEEDBACK'] : []), ...(myKey ? ['KEY'] : []), 'LOGOUT'];
        assert.deepEqual(shape.kinds.slice(-group.length), group, label);
        assert.equal(shape.separators, baselineSeparators, label + ' has no extra separator');
        for (const [kind, enabled] of [['BOT', feishuBot], ['KEY', myKey], ['FEEDBACK', feedback]]) {
          assert.equal(shape.kinds.filter(value => value === kind).length, Number(enabled), label);
        }
        await closeMenu(page);
      }
      assert.deepEqual(log.pageErrors, []);
    });
  }
});

test('empty state reuses the existing connection entry; absent entry disables add', LONG, async () => {
  suite.harness.use(suite.noPreview); suite.noPreview.setBots([]);
  await suite.session('empty', { init: [[init]] }, async ({ page, log }) => {
    await ready(page);
    const add = page.getByRole('button', { name: '连接飞书', exact: true });
    assert.equal(await page.locator(CARD).count(), 0);
    assert.equal(await add.isDisabled(), true);
    // The onboarding module owns this private handler; model its DOM contract only.
    await page.evaluate(() => {
      window.__connect = 0;
      const banner = document.createElement('div'); banner.className = 'wp-feishu-banner';
      const open = document.createElement('button'); open.textContent = '开通';
      open.onclick = () => { window.__connect++; }; banner.append(open); document.querySelector('main.layout-content').prepend(banner);
    });
    await page.waitForFunction(() => !document.querySelector('.wp-feishu-bot-add').disabled);
    await add.click(); assert.equal(await page.evaluate(() => window.__connect), 1);
    await page.locator('.wp-feishu-banner').evaluate(el => el.remove());
    await page.waitForFunction(() => document.querySelector('.wp-feishu-bot-add').disabled);
    assert.equal(await add.getAttribute('title'), '请刷新页面后重试');
    assert.equal(await add.getAttribute('aria-describedby'), 'wp-feishu-bot-add-hint');
    assert.equal(await page.locator('#wp-feishu-bot-add-hint').isVisible(), true);
    assert.equal(await page.locator('dialog').count(), 0); assert.deepEqual(log.pageErrors, []);
  });
});

test('one connected bot keeps add visible and never starts another connection', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('one-bot', { init: [[init]] }, async ({ page, log }) => {
    await ready(page); await page.locator(CARD).waitFor();
    const connectionRequests = () => log.requests.filter(url => url.includes(API) || url.includes('/_wp/aionui/feishu/'));
    const before = connectionRequests();
    await page.getByRole('button', { name: '连接飞书', exact: true }).click();
    await page.getByText('一个工作伙伴暂时只能连接一个飞书应用，更多智能体功能暂未开放', { exact: true }).waitFor();
    assert.deepEqual(connectionRequests(), before);
    await page.waitForFunction(() => document.querySelector('.wp-feishu-bot-message').textContent === '', null, { timeout: 4500 });
  });
});

test('outside allowlist has no menu, cards or bot requests', LONG, async () => {
  suite.harness.use(suite.main);
  await suite.session('outside', { who: 'outsider', init: [[init]] }, async ({ page, log }) => {
    await openMenu(page);
    assert.equal(await page.locator('[data-wp-feishu-bot]').count(), 0);
    assert.equal(await page.locator(S).count(), 0);
    assert.deepEqual(log.requests.filter(value => value.includes(API)), []);
    assert.deepEqual(log.pageErrors, []);
  });
});

test('avatar menu and sidebar open the agents page; leaving it removes the cards', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('navigate', { init: [[init]] }, async ({ page, log }) => {
    await page.locator('[data-wp-nav="agents"]').waitFor();
    await page.locator('[data-wp-nav="agents"]').click(); await ready(page);
    assert.equal(new URL(page.url()).hash, '#/guid?wp=agents');
    await page.evaluate(() => { location.hash = '#/market'; });
    await page.locator(S).waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-wp-nav="agents"]').getAttribute('aria-current'), null);
    await openMenu(page); await page.locator('[data-wp-feishu-bot]').click();
    await ready(page);
    assert.equal(new URL(page.url()).hash, '#/guid?wp=agents');
    assert.equal(await page.locator(S).getByRole('heading', { name: '智能体', exact: true }).count(), 1);
    assert.deepEqual(log.pageErrors, []);
  });
});

test('homepage has no bot cards until the agents page is opened', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('homepage-empty', { route: '/#/guid', init: [[init]] }, async ({ page, log }) => {
    await page.locator('[data-wp-nav="agents"]').waitFor();
    assert.equal(new URL(page.url()).hash, '#/guid');
    assert.equal(await page.locator(S).count(), 0);
    assert.equal(await page.locator('[data-wp-nav="agents"]').innerText(), '智能体');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('agents page remounts after the main content is rebuilt', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('no-main', { init: [[init]] }, async ({ page, log }) => {
    await ready(page);
    await page.evaluate(() => {
      document.querySelector('main.layout-content').remove();
      const main = document.createElement('main'); main.className = 'layout-content'; main.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;padding:24px;overflow:hidden';
      document.querySelector('#root').append(main);
    });
    await page.locator('main.layout-content > ' + S).waitFor();
    assert.equal(await page.locator(S).count(), 1); assert.deepEqual(log.pageErrors, []);
  });
});

test('live admission failure removes the bot-owned menu separator', LONG, async () => {
  const { gateway } = suite.menuCases.find(value => value.feishuBot && !value.feedback && !value.myKey);
  suite.harness.use(gateway); gateway.setBots([bot]);
  await suite.session('revoke-separator', { init: [[init]] }, async ({ page, log }) => {
    await ready(page); await openMenu(page);
    await page.locator('[data-wp-feishu-bot]').evaluate(entry => entry.previousElementSibling.remove());
    await page.locator('[data-wp-feishu-bot-separator]').waitFor();
    await page.route('**/_wp/feishu-bot/bots', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('[data-wp-feishu-bot]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-wp-feishu-bot-separator]').count(), 0);
    assert.equal(await page.locator(S).count(), 0); assert.deepEqual(log.pageErrors, []);
  });
});

test('SPA remount restores cards; live admission failure removes UI', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('remount-revoke', { init: [[init]] }, async ({ page, log }) => {
    await ready(page);
    await page.locator(S).evaluate(section => section.remove());
    await page.locator(S).waitFor();
    assert.equal(await page.locator(S).count(), 1);
    await page.locator('.wp-nav').evaluate(nav => nav.remove());
    await page.locator('[data-wp-nav="market"] + [data-wp-nav="agents"]').waitFor();
    assert.equal(await page.locator('[data-wp-nav="agents"]').count(), 1);
    await page.route('**/_wp/feishu-bot/bots?refresh=1', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.locator(S).getByRole('button', { name: '刷新', exact: true }).click();
    await page.locator(S).waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash === '#/guid');
    assert.equal(await page.locator('#fixture-input').isVisible(), true);
    await openMenu(page); assert.equal(await page.locator('[data-wp-feishu-bot]').count(), 0);
    assert.deepEqual(log.pageErrors, []);
  });
});


test('router fallback, query refresh, back/forward and all sidebar destinations', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('route-history', { route: '/#/agents', init: [[init]] }, async ({ page, log }) => {
    await page.waitForFunction(() => location.hash === '#/guid');
    assert.equal(await page.locator(S).count(), 0, 'unknown path must be replaced, just like the upstream bundle');
    await ready(page);
    await page.reload(); await page.locator(S).waitFor();
    assert.equal(new URL(page.url()).hash, '#/guid?wp=agents');
    await page.goBack(); await page.locator(S).waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).hash, '#/guid');
    assert.equal(await page.locator('#fixture-input').isVisible(), true);
    await page.goForward(); await page.locator(S).waitFor();
    for (const [selector, hash] of [
      ['[class*="_newChatTrigger"]', '#/guid'],
      ['[data-wp-nav="search"]', '#/guid'],
      ['[data-wp-nav="auto"]', '#/scheduled'],
      ['[data-wp-nav="market"]', '#/market'],
      ['.chat-history__item', '#/conversation/fixture'],
    ]) {
      const historyLength = await page.evaluate(() => history.length);
      await sidebar(page); await page.locator(selector).click();
      await page.locator(S).waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).hash, hash);
      assert.equal(await page.evaluate(() => history.length), historyLength + (selector.includes('search') ? 0 : 1),
        'closing the panel must not push an extra guid entry');
      assert.equal(await page.locator('[data-wp-nav="agents"]').getAttribute('aria-current'), null);
      if (selector.includes('search')) await page.keyboard.press('Escape');
      await enterAgents(page);
    }
    // Keyboard activation follows the same navigation contract.
    await page.locator('[data-wp-nav="auto"]').focus(); await page.keyboard.press('Enter');
    await page.locator(S).waitFor({ state: 'detached' });
    await page.locator('[data-wp-nav="agents"]').focus(); await page.keyboard.press('Enter');
    await page.locator(S).waitFor();
    assert.equal(new URL(page.url()).hash, '#/guid?wp=agents');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('in-place search replaces the agents entry and Back returns to the preceding page', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('search-history', { route: '/#/conversation/before-agents', init: [[init]] }, async ({ page, log }) => {
    await enterAgents(page);
    await page.locator('[data-wp-nav="search"]').click();
    await page.locator(S).waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/conversation/before-agents');
    assert.equal(await page.locator(S).count(), 0);
    assert.deepEqual(log.pageErrors, []);
  });
});

test('pushState with popstate dismisses the panel and Back restores it', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('popstate-navigation', { route: '/#/guid?wp=agents', init: [[init]] }, async ({ page, log }) => {
    await ready(page);
    await page.evaluate(() => {
      window.__hashChanges = 0;
      addEventListener('hashchange', () => { window.__hashChanges++; });
      history.pushState(null, '', '#/guid');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.locator(S).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__hashChanges), 0);
    assert.equal(await page.locator('#fixture-input').isVisible(), true);
    assert.equal(await page.locator('[data-wp-nav="agents"]').getAttribute('aria-current'), null);
    await page.goBack(); await page.locator(S).waitFor();
    assert.equal(new URL(page.url()).hash, '#/guid?wp=agents');
    await page.goForward(); await page.locator(S).waitFor({ state: 'detached' });
    assert.deepEqual(log.pageErrors, []);
  });
});
