import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { ORIGIN } from './lib/harness.mjs';
import { openMenu, closeMenu, overflow } from './lib/browser.mjs';

const API = '/_wp/feishu-bot', D = '.wp-feishu-bot-dialog', BAR = '.wp-feishu-bot-bar';
const bot = { appId: 'cli_Test123', name: '唐的飞书助手', avatar: null, online: 'online', activate: true, lastEventAt: null, error: null };
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
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
  document.addEventListener('DOMContentLoaded', () => document.querySelector('#fixture-input').setAttribute('data-testid', 'guid-input'), { once: true });
}
async function open(page) {
  await openMenu(page);
  await page.locator('[data-wp-feishu-bot]').click();
  await page.locator(D + '[open]').waitFor();
  await page.locator(D + ' .wp-feishu-bot-card').first().waitFor();
  await page.waitForFunction(selector => !document.querySelector(selector + ' button[aria-label="刷新"]').disabled, D);
}
async function fits(page) {
  const result = await overflow(page, D);
  assert.ok(result.pageScrollWidth <= result.pageClientWidth);
  assert.ok(result.dialogScrollWidth <= result.dialogClientWidth);
  assert.deepEqual(result.outside, []); assert.equal(result.dialogInViewport, true);
}
for (const width of [1280, 390, 360]) {
  test(`homepage and dialog at ${width}px, accessible actions and no overflow`, LONG, async () => {
    suite.harness.use(suite.main);
    suite.main.setBots([bot, { ...bot, appId: 'cli_Second', name: '很长的机器人名字'.repeat(8), online: 'offline', error: 'feishu_unreachable' },
      { ...bot, appId: 'cli_Third', name: null, avatar, online: 'unknown', error: 'feishu_auth_failed' }]);
    await suite.session('width-' + width, { viewport: { width, height: 844 }, init: [[init]] }, async ({ page, log }) => {
      await page.locator(BAR).waitFor();
      assert.match(await page.locator(BAR).innerText(), /飞书机器人：唐的飞书助手/);
      assert.equal(await page.locator(BAR + ' .wp-feishu-bot-state').innerText(), '在线');
      const chat = page.locator(BAR).getByRole('link', { name: '对话', exact: true });
      assert.equal(await chat.getAttribute('href'), openUrl); assert.equal(await chat.getAttribute('target'), '_blank');
      assert.match(await chat.getAttribute('rel'), /noopener/);
      const barFits = await page.locator(BAR).evaluate(bar => ({
        fits: bar.scrollWidth <= bar.clientWidth,
        outside: [...bar.querySelectorAll('button, a')].filter(element => element.getBoundingClientRect().right > innerWidth).map(element => element.textContent),
      }));
      assert.equal(barFits.fits, true, 'status bar content fits its own width');
      assert.deepEqual(barFits.outside, [], 'status bar controls stay inside viewport');
      await suite.shot(page, `home-${width}`);
      await open(page);
      assert.equal(await page.locator(D + ' .wp-feishu-bot-card').count(), 3);
      const first = page.locator(D + ' .wp-feishu-bot-card').first();
      assert.equal(await first.locator('h3').innerText(), bot.name);
      assert.equal(await first.locator('code').innerText(), bot.appId);
      assert.equal(await first.locator('.wp-feishu-bot-avatar').innerText(), '唐');
      assert.equal(await page.locator(D + ' .wp-feishu-bot-avatar img').getAttribute('src'), avatar);
      assert.equal(await first.getByRole('link', { name: '对话', exact: true }).getAttribute('href'), openUrl);
      assert.equal(await page.locator(D).getByText('暂时拿不到机器人信息', { exact: true }).count(), 2);
      assert.equal(await page.locator(D).getByRole('heading', { name: '飞书机器人', exact: true }).count(), 1);
      assert.deepEqual(await page.locator(D + ' .wp-feishu-bot-state').allTextContents(), ['在线', '离线', '状态未知']);
      await first.getByRole('button', { name: '复制 App ID' }).click();
      assert.deepEqual(await page.evaluate(() => window.__copied), [bot.appId]);
      const before = suite.main.botCommands.length;
      await first.getByRole('button', { name: '重新连接', exact: true }).click();
      assert.equal(suite.main.botCommands.length, before, 'first click only asks for confirmation');
      await page.locator(D).getByRole('button', { name: '取消', exact: true }).click();
      await first.getByRole('button', { name: '重新连接', exact: true }).click();
      const response = page.waitForResponse(r => r.url().endsWith(API + '/reconnect'));
      const reconnectStarted = Date.now();
      await page.locator(D).getByRole('button', { name: '确认重新连接', exact: true }).click();
      assert.equal((await response).status(), 200);
      assert.ok(suite.main.botCommands.slice(before).some(cmd => cmd.at(-1) === 'restart'));
      const refreshed = await page.waitForResponse(r => r.url().includes(API + '/bots'), { timeout: 6000 });
      assert.equal(refreshed.status(), 200);
      assert.ok(Date.now() - reconnectStarted >= 2500, 'reconnect refresh waits about three seconds');
      const refresh = page.waitForResponse(r => r.url().endsWith(API + '/bots?refresh=1'));
      await page.locator(D).getByRole('button', { name: '刷新', exact: true }).click(); await refresh;
      assert.deepEqual(suite.main.botCommands.at(-1).slice(-2), ['info', '--refresh']);
      await fits(page); await suite.shot(page, `dialog-${width}`);
      const close = page.locator(D).getByRole('button', { name: '关闭', exact: true });
      const beforeScroll = await close.boundingBox();
      await page.locator(D + ' .wp-feishu-bot-body').evaluate(node => { node.scrollTop = node.scrollHeight; });
      assert.deepEqual(await close.boundingBox(), beforeScroll, 'close button stays outside scrolling content');
      await close.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(selector => !document.querySelector(selector).open, D);
      await page.locator(BAR).getByRole('button', { name: '管理', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(selector => !document.querySelector(selector).open, D);
      assert.deepEqual(log.pageErrors, []);
    });
  });
}

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

test('empty bots hide homepage bar and show setup hint; preview disabled still injects client', LONG, async () => {
  suite.harness.use(suite.noPreview); suite.noPreview.setBots([]);
  await suite.session('empty', { init: [[init]] }, async ({ page, log }) => {
    await openMenu(page); await page.locator('[data-wp-feishu-bot]').click();
    await page.locator(D).getByText('还没连接飞书机器人，在首页点「开通」扫码即可', { exact: true }).waitFor();
    assert.equal(await page.locator(BAR).count(), 0);
    assert.equal(await page.locator(D + ' .wp-feishu-bot-card').count(), 0);
    await suite.shot(page, 'empty'); assert.deepEqual(log.pageErrors, []);
  });
});

test('outside allowlist has no menu, bar or bot requests', LONG, async () => {
  suite.harness.use(suite.main);
  await suite.session('outside', { who: 'outsider', init: [[init]] }, async ({ page, log }) => {
    await openMenu(page);
    assert.equal(await page.locator('[data-wp-feishu-bot]').count(), 0);
    assert.equal(await page.locator(BAR).count(), 0);
    assert.deepEqual(log.requests.filter(value => value.includes(API)), []);
    assert.deepEqual(log.pageErrors, []);
  });
});


test('SPA homepage remount restores bar; live admission failure removes UI', LONG, async () => {
  suite.harness.use(suite.main); suite.main.setBots([bot]);
  await suite.session('remount-revoke', { init: [[init]] }, async ({ page, log }) => {
    await page.locator(BAR).waitFor();
    await page.evaluate(() => { window.__homeInput = document.querySelector('[data-testid="guid-input"]'); window.__homeInput.remove(); });
    await page.locator(BAR).waitFor({ state: 'detached' });
    await page.evaluate(() => document.querySelector('main').append(window.__homeInput));
    await page.locator(BAR).waitFor(); assert.equal(await page.locator(BAR).count(), 1);
    await open(page);
    await page.route('**/_wp/feishu-bot/bots?refresh=1', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.locator(D).getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(selector => !document.querySelector(selector).open, D);
    assert.equal(await page.locator(BAR).count(), 0);
    await openMenu(page); assert.equal(await page.locator('[data-wp-feishu-bot]').count(), 0);
    assert.deepEqual(log.pageErrors, []);
  });
});
