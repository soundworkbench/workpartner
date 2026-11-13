import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFeishuBot } from '../../gateway/feishu-bot.mjs';
import { createSuite, LONG } from './lib/suite.mjs';
import { ORIGIN } from './lib/harness.mjs';

const S = '.wp-feishu-bot-section', CARD = '.wp-feishu-bot-card', D = 'dialog.wp-feishu-bot-dialog';
const qr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQj/8AAAIPAW823JCjAAAAAElFTkSuQmCC';
const main = { id: 'main', name: '主助手', kind: 'main', setup: 'connected', appId: 'cli_Main', createdAt: null };
const sub = (i, setup = 'none') => ({ id: 's' + String(i).padStart(8, '0'), name: '助手' + i, kind: 'sub', setup,
  appId: setup === 'connected' ? 'cli_Sub' + i : null, createdAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
const suite = createSuite('feishu-subagents', async s => {
  s.main = await s.harness.startGateway('subagents', { feishuBot: { allow: ['member'], subAgents: { allow: ['member'] } } });
});

// Run the real route handler against a stateful exec stand-in; the shared harness still supplies the real injected page.
function runtimeFixture(enabled = true) {
  let agents = [sub(2, 'waiting'), main, sub(1, 'connected')], next = 3;
  const calls = [], requests = [];
  const reply = (value, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value) });
  const config = { features: { feishuBot: true }, feishuBot: { allow: ['member'], subAgents: { allow: enabled ? ['member'] : [] } } };
  const handler = createFeishuBot({ organization: { server: { publicOrigin: ORIGIN }, runtime: { uid: 1001 } },
    organizationData: () => config, authenticate: () => ({ slug: 'member', unionId: 'union-member', backend: 'aionui' }),
    runtime: { exec: async (slug, cmd, options) => {
      calls.push({ slug, cmd, options });
      assert.equal(options.user, '1001');
      if (options.detached) assert.equal('stdin' in options, false);
      const action = cmd[2], id = cmd.at(-1), current = agents.find(a => a.id === id);
      if (action === 'info') return reply({ ok: true, agents, limit: 5, bots: agents.filter(a => a.setup === 'connected').map(a => ({
        agentId: a.id, appId: a.appId, name: a.id === 'main' ? '主机器人' : '飞书' + a.name, online: 'online', activate: true })) });
      if (action === 'create' || action === 'rename') {
        const name = JSON.parse(options.stdin).name;
        if (agents.some(a => a.name === name && a !== current)) return reply({ ok: false, error: 'name_taken' }, 1);
        if (action === 'create') {
          if (agents.filter(a => a.kind === 'sub').length >= 5) return reply({ ok: false, error: 'limit_reached' }, 1);
          const agent = { ...sub(next++), name }; agents.push(agent); return reply({ ok: true, agent });
        }
        current.name = name; return reply({ ok: true, agent: current });
      }
      if (action === 'start') { current.setup = 'waiting'; return {}; }
      if (action === 'status') return reply({ status: current.setup, ...(current.setup === 'waiting' ? { qr, expiresAt: 1800000000 } : {}) });
      if (action === 'delete') agents = agents.filter(a => a.id !== id);
      return reply({ ok: true });
    } } });
  return { calls, requests, connect(id) { const agent = agents.find(a => a.id === id); agent.setup = 'connected'; agent.appId = 'cli_Created' + id; },
    fill() { while (agents.filter(a => a.kind === 'sub').length < 5) agents.push(sub(next++)); },
    async attach(page) {
      await page.route('**/_wp/feishu-bot/**', async route => {
        const request = route.request(), url = new URL(request.url());
        requests.push({ method: request.method(), path: url.pathname, body: request.postData() });
        const req = Readable.from(request.postData() ? [Buffer.from(request.postData())] : []);
        req.method = request.method(); req.headers = await request.allHeaders();
        let status, headers, body;
        assert.equal(await handler(req, { writeHead(code, values) { status = code; headers = values; }, end(value) { body = value; } }, url), true);
        await route.fulfill({ status, headers, body });
      });
    } };
}
function init() {
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('fixture-feishu-bot');
    document.querySelector('#fixture-input').setAttribute('data-testid', 'guid-input');
  }, { once: true });
}
async function session(label, options, body, enabled = true) {
  suite.harness.use(suite.main);
  const fixture = runtimeFixture(enabled);
  await suite.session(label, { route: null, avatar: false, init: [[init]], ...options }, async context => {
    await fixture.attach(context.page); await context.page.goto(ORIGIN + '/');
    await context.page.locator(CARD).first().waitFor();
    await body({ ...context, fixture });
    assert.deepEqual(context.log.pageErrors, []);
  });
}
const card = (page, id) => page.locator(CARD + `[data-agent-id="${id}"]`);
async function menu(page, id, action) {
  const target = card(page, id); await target.hover();
  await target.getByRole('button', { name: '更多操作' }).focus();
  await target.getByRole('button', { name: '更多操作' }).click();
  await target.getByRole('button', { name: action, exact: true }).click();
}
async function fits(page, dialog = false) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator(S).evaluate(el => el.scrollWidth <= el.clientWidth), true);
  if (dialog) assert.equal(await page.locator(D).evaluate(el => {
    const r = el.getBoundingClientRect(), close = el.querySelector('button[aria-label="关闭弹层"]').getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth
      && close.top >= r.top && close.bottom <= r.bottom;
  }), true);
}
for (const [width, dark] of [[1280, false], [390, false], [360, false], [360, true]]) {
  test(`cards and dialog fit ${width}px ${dark ? 'dark' : 'light'}`, LONG, async () => {
    await session(`layout-${width}-${dark}`, { viewport: { width, height: 844 }, storage: { 'fixture-theme': dark ? 'dark' : 'light' } }, async ({ page }) => {
      assert.deepEqual(await page.locator(CARD + ' h3').allTextContents(), ['主机器人', '助手1', '助手2']);
      assert.deepEqual(await page.locator('.wp-feishu-bot-tag').allTextContents(), ['主助手', '子助手', '子助手']);
      assert.equal(await page.locator('.wp-feishu-bot-cards > :first-child').getAttribute('aria-label'), '新建子助手');
      assert.match(await card(page, 's00000001').locator('.wp-feishu-bot-summary').innerText(), /飞书机器人：飞书助手1/);
      assert.equal(await card(page, 's00000002').locator('.wp-feishu-bot-state').innerText(), '等待扫码');
      assert.equal(await card(page, 's00000002').getByRole('link').count(), 0);
      await fits(page); await suite.shot(page, `cards-${width}-${dark ? 'dark' : 'light'}`, { fullPage: true });
      await page.getByRole('button', { name: '新建子助手', exact: true }).click();
      const input = page.locator(D).getByLabel('名字', { exact: true });
      assert.equal(await input.evaluate(el => document.activeElement === el), true);
      const next = page.locator(D).getByRole('button', { name: '下一步：扫码创建机器人' });
      for (const value of ['a  b', '字'.repeat(17), 'main', '主助手', '😀']) {
        await input.fill(value); assert.equal(await next.isDisabled(), true);
        assert.match(await page.locator('.wp-feishu-bot-input-error').innerText(), /最多 16 个字/);
      }
      await fits(page, true); await suite.shot(page, `name-${width}-${dark ? 'dark' : 'light'}`, { fullPage: true });
      await page.keyboard.press('Escape'); await page.locator(D).waitFor({ state: 'detached' });
      await card(page, 's00000002').hover(); await card(page, 's00000002').getByRole('button', { name: '扫码连接' }).click();
      await page.locator(D + ' img:not([hidden])').waitFor(); await fits(page, true);
      await page.locator(D + ' .wp-feishu-bot-dialog-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal(await page.locator(D).getByRole('button', { name: '关闭弹层' }).isVisible(), true);
      await suite.shot(page, `qr-${width}-${dark ? 'dark' : 'light'}`, { fullPage: true });
      await page.locator(D).getByRole('button', { name: '关闭弹层' }).click();
    });
  });
}

test('create, QR polling, connect, rename, restart and confirmed deletion call the real handler', LONG, async () => {
  await session('lifecycle', {}, async ({ page, fixture }) => {
    await page.getByRole('button', { name: '新建子助手', exact: true }).click();
    await page.locator(D).getByLabel('名字', { exact: true }).fill('研究助手');
    await page.locator(D).getByRole('button', { name: '下一步：扫码创建机器人' }).click();
    await page.locator(D + ' img:not([hidden])').waitFor();
    assert.equal(await page.locator(D + ' h2').innerText(), '给「研究助手」创建飞书机器人');
    assert.ok(fixture.calls.some(c => c.cmd.join(' ') === 'python3 /opt/workpartner/bin/feishu-onboard.py start --agent s00000003' && c.options.detached));
    fixture.connect('s00000003');
    await page.locator(D).getByText('已连接，可以在飞书里找「研究助手」了', { exact: true }).waitFor();
    await page.locator(D).getByRole('button', { name: '关闭弹层' }).click();
    assert.equal(await card(page, 's00000003').getByRole('link', { name: '去对话' }).getAttribute('href'), 'https://applink.feishu.cn/client/bot/open?appId=cli_Createds00000003');
    await menu(page, 's00000003', '改名');
    assert.equal(await page.locator(D).getByLabel('名字', { exact: true }).inputValue(), '研究助手');
    await page.locator(D).getByLabel('名字', { exact: true }).fill('助手1');
    await page.locator(D).getByRole('button', { name: '保存', exact: true }).click();
    await page.locator(D).getByText('这个名字已经有了', { exact: true }).waitFor();
    await page.locator(D).getByLabel('名字', { exact: true }).fill('研究改名');
    await page.locator(D).getByRole('button', { name: '保存', exact: true }).click();
    await card(page, 's00000003').getByRole('heading', { name: '研究改名', exact: true }).waitFor();
    await menu(page, 's00000003', '重新连接');
    await card(page, 's00000003').getByRole('button', { name: '确认重新连接', exact: true }).click();
    await page.getByText('已重新连接，稍后刷新状态。', { exact: true }).waitFor();
    await menu(page, 's00000003', '删除');
    const confirmation = card(page, 's00000003').locator('.wp-feishu-bot-confirm');
    assert.match(await confirmation.innerText(), /工作目录移到回收目录。飞书里的机器人不会被删除/);
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(fixture.requests.some(r => r.path.endsWith('/delete')), false);
    await menu(page, 's00000003', '删除');
    await card(page, 's00000003').getByRole('button', { name: '确认删除', exact: true }).click();
    await card(page, 's00000003').waitFor({ state: 'detached' });
    for (const action of ['rename', 'restart', 'delete']) assert.ok(fixture.requests.some(r => r.method === 'POST' && r.path === '/_wp/feishu-bot/agents/s00000003/' + action));
    assert.ok(fixture.calls.some(c => c.cmd.join(' ') === 'python3 /opt/workpartner/bin/wp-feishu-bot.py restart --agent s00000003'));
    fixture.fill(); await page.locator(S).getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wp-feishu-bot-add').disabled);
    assert.equal(await page.locator('.wp-feishu-bot-add-hint').innerText(), '子助手最多 5 个（主助手另算），删掉不用的再建');
    assert.equal(await page.locator('.wp-feishu-bot-add').getAttribute('aria-describedby'), 'wp-feishu-bot-add-hint');
  });
});

test('setup polling stops when hidden or closed and resumes when visible', LONG, async () => {
  await session('polling', {}, async ({ page, fixture }) => {
    await card(page, 's00000002').hover(); await card(page, 's00000002').getByRole('button', { name: '扫码连接' }).click();
    await page.locator(D + ' img:not([hidden])').waitFor();
    const count = () => fixture.requests.filter(r => r.path.endsWith('/setup')).length;
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const hiddenCount = count(); await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal(count(), hiddenCount);
    const resumed = page.waitForResponse(r => r.url().endsWith('/setup'));
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await resumed;
    await page.keyboard.press('Escape'); await page.locator(D).waitFor({ state: 'detached' });
    const closedCount = count(); await new Promise(resolve => setTimeout(resolve, 2200)); assert.equal(count(), closedCount);
  });
});

test('users outside sub-agent list see only main and legacy plus hint', LONG, async () => {
  await session('not-enabled', {}, async ({ page, fixture }) => {
    assert.equal(await page.locator(CARD).count(), 1);
    assert.equal(await page.locator(CARD + ' h3').innerText(), '主机器人');
    await page.getByRole('button', { name: '连接飞书机器人', exact: true }).click();
    assert.equal(await page.locator(D).count(), 0);
    assert.equal(await page.locator('.wp-feishu-bot-message').innerText(), '一个工作伙伴暂时只能连一个飞书机器人，多个子助手的功能做好后开放');
    assert.equal(fixture.requests.some(r => r.method === 'POST'), false);
  }, false);
});
