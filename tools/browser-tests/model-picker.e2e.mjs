import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { DESKTOP, PHONE } from './lib/browser.mjs';
import { ORIGIN } from './lib/harness.mjs';

const MODEL_CONFIG = {
  catalog: {
    codex: [
      { id: 'gpt-6.2-sol', key: 'codex/gpt-6.2-sol', name: 'GPT-6.2 Sol', also: [] },
      { id: 'gpt-6.1-sol', key: 'codex/gpt-6.1-sol', name: 'GPT-6.1 Sol', also: [] },
      { id: 'gpt-6.2-astra', key: 'codex/gpt-6.2-astra', name: 'GPT-6.2 Astra', also: [] },
    ],
    claude: [
      { id: 'claude-opus-5-5', key: 'claude/claude-opus-5-5', name: 'Opus 5.5', also: ['opus'] },
      { id: 'sonnet', key: 'claude/claude-sonnet-5-5', name: 'Sonnet 5.5', also: ['claude-sonnet-5-5'] },
      { id: 'haiku', key: 'claude/claude-haiku-5-5', name: 'Haiku 5.5', also: ['claude-haiku-5-5'] },
    ],
  },
  defaults: { codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5' },
};

const suite = createSuite('model-picker', async s => {
  s.main = await s.harness.startGateway('model-picker', { feedback: false });
});

async function setupPicker(page, { hasClaude = true, convBackend = 'codex', mobile = false, dark = false } = {}) {
  const puts = [];
  const models = hasClaude
    ? ['codex/gpt-6.2-sol', 'codex/gpt-6.1-sol', 'codex/gpt-6.2-astra', 'claude/claude-opus-5-5', 'claude/claude-sonnet-5-5', 'claude/claude-haiku-5-5']
    : ['codex/gpt-6.2-sol', 'codex/gpt-6.1-sol', 'codex/gpt-6.2-astra'];
  let convModel = convBackend === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol';
  let convEffort = 'medium';
  const convOptions = () => [
    { id: 'model', category: 'model', current_value: convModel,
      options: MODEL_CONFIG.catalog[convBackend].map(m => ({ value: m.id, name: m.name })) },
    { id: 'thought_level', category: 'thought_level', current_value: convEffort,
      options: ['low', 'medium', 'high', 'xhigh', ...(convBackend === 'claude' ? ['max'] : [])].map(v => ({ value: v })) },
  ];
  await page.route('**/api/agents/management', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: [
      { id: '8e1acf31', backend: 'codex', yolo_id: 'agent-full-access' },
      { id: '2d23ff1c', backend: 'claude', yolo_id: 'bypassPermissions' },
    ] }),
  }));
  await page.route('**/api/settings/client', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: {
      'wp.modelConfig': MODEL_CONFIG, 'wp.models': models,
      'wp.engineModels': { codex: 'gpt-6.1-sol', claude: 'claude-opus-5-5' },
      'wp.effort': { codex: 'medium', claude: 'medium' },
      'assistants.enabledOrder': hasClaude ? ['bare:8e1acf31', 'bare:2d23ff1c'] : ['bare:8e1acf31'],
    } }),
  }));
  await page.route('**/api/conversations/c1/runtime/ensure', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { config_options: convOptions() } }),
  }));
  await page.route('**/api/conversations/c1', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { id: 'c1', extra: { backend: convBackend, model: convModel } } }),
  }));
  await page.route('**/api/conversations/c1/config-options/*', async route => {
    const id = route.request().url().split('/').pop();
    const body = route.request().postDataJSON();
    puts.push({ id, value: body.value });
    if (id === 'model') convModel = body.value;
    if (id === 'thought_level') convEffort = body.value;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { config_options: convOptions() } }) });
  });
  await page.addInitScript(({ hasClaude, mobile, dark }) => {
    window.__mountPickerDom = function () {
      if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      if (mobile) {
        const aside = document.querySelector('#root > aside');
        if (aside) aside.style.display = 'none';
        const m = document.querySelector('#root > main');
        if (m) m.style.padding = '16px';
      }
      const main = document.querySelector('main.layout-content');
      if (!main) return;
      main.querySelector('#mp-stage')?.remove();
      const stage = document.createElement('div');
      stage.id = 'mp-stage';
      stage.style.cssText = 'width:100%;max-width:768px;margin:16px auto 0;box-sizing:border-box;';
      if (location.hash.startsWith('#/conversation/')) {
        stage.innerHTML = mobile
          ? '<div class="sendbox-panel" style="display:flex;flex-direction:column;padding:10px;border:1px solid #ccc;border-radius:16px;background:var(--wp-card,#fff)"><div style="display:flex;align-items:center;gap:6px"><div class="sendbox-tools sendbox-tools-mobile-compact"><button type="button">+</button></div><textarea data-testid="sendbox-input" style="flex:1;min-width:0;height:36px"></textarea><button type="button" data-testid="sendbox-send-btn" style="width:32px;height:32px;flex:none">↑</button></div></div>'
          : '<div class="sendbox-panel" style="padding:12px;border:1px solid #ccc;border-radius:16px;background:var(--wp-card,#fff)"><textarea data-testid="sendbox-input" style="width:100%;height:48px"></textarea><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><button type="button">+</button><div class="sendbox-actions" style="display:flex;align-items:center;gap:6px;margin-left:auto"><button type="button" data-testid="sendbox-send-btn" style="width:32px;height:32px;flex:none">↑</button></div></div></div>';
      } else {
        const claudeBtn = hasClaude ? '<button type="button" data-assistant-backend="claude" data-assistant-selected="false">Claude</button>' : '';
        stage.innerHTML = '<div class="_guidContainer_1"><div class="_guidLayout_1"><div class="_heroHeader_1"><span>AionUi</span></div><div class="mt-18px mb-16px w-full"><div class="flex"><button type="button" data-assistant-backend="codex" data-assistant-selected="true">ChatGPT</button>' + claudeBtn + '</div></div><div class="_guidInputCardWrap_1"><div class="_guidInputInner_1" style="padding:12px;border:1px solid #ccc;border-radius:16px;background:var(--wp-card,#fff)"><textarea data-testid="guid-input" style="width:100%;height:48px;box-sizing:border-box"></textarea><div class="_actionRow_1" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px"><div class="_actionTools_1"><button type="button" style="width:32px;height:32px">+</button></div><div class="_actionSubmit_1" style="display:flex;align-items:center;gap:6px;margin-left:auto"><button type="button" data-testid="guid-send-btn" style="width:32px;height:32px;flex:none">↑</button></div></div></div></div></div></div>';
        stage.querySelectorAll('[data-assistant-backend]').forEach(btn => {
          btn.addEventListener('click', () => {
            stage.querySelectorAll('[data-assistant-backend]').forEach(b => { b.dataset.assistantSelected = b === btn ? 'true' : 'false'; });
          });
        });
      }
      main.appendChild(stage);
    };
    window.addEventListener('hashchange', () => window.__mountPickerDom());
  }, { hasClaude, mobile, dark });
  return { puts };
}

async function mountAndWait(page, route) {
  await page.goto(ORIGIN + '/' + route);
  await page.evaluate(() => window.__mountPickerDom());
  await page.waitForSelector('.wp-pick-btn img.wp-pick-icon');
  await page.waitForTimeout(150);
}

test('home hides top backend bar, shows grouped menu, and switches backend and effort', LONG, async () => {
  suite.harness.use(suite.main);
  await suite.session('home-desktop', { viewport: DESKTOP, route: null }, async ({ page, log }) => {
    await setupPicker(page, { hasClaude: true });
    await mountAndWait(page, '#/guid');
    const hiddenCheck = await page.evaluate(() => {
      const bar = document.querySelector('[data-assistant-backend="codex"]');
      const input = document.querySelector('[data-testid="guid-input"]');
      const img = document.querySelector('.wp-pick-btn img.wp-pick-icon');
      return {
        barVisible: bar ? getComputedStyle(bar).display !== 'none' && bar.getBoundingClientRect().height > 0 : false,
        inputVisible: input ? input.getBoundingClientRect().height > 0 : false,
        iconSrc: img?.getAttribute('src'), iconLoaded: Boolean(img?.complete && img.naturalWidth > 0),
        btnText: document.querySelector('.wp-pick-btn')?.textContent?.trim(),
      };
    });
    assert.equal(hiddenCheck.barVisible, false, 'top ChatGPT/Claude buttons must be hidden');
    assert.equal(hiddenCheck.inputVisible, true, 'guid composer must remain visible');
    assert.equal(hiddenCheck.iconSrc, '/assets/wp-agents/chatgpt.svg');
    assert.equal(hiddenCheck.iconLoaded, true);
    assert.match(hiddenCheck.btnText, /GPT-6\.1 Sol/);

    await page.click('.wp-pick-btn');
    await page.waitForSelector('.wp-pick-model-menu');
    const titles = await page.locator('.wp-pick-group-title').allTextContents();
    assert.deepEqual(titles.map(s => s.trim()), ['ChatGPT', 'Claude']);
    await suite.shot(page, 'home-desktop-menu');

    await page.click('.wp-pick-group[data-backend="claude"] .wp-pick-item:has-text("Sonnet 5.5")');
    await page.waitForFunction(() => document.querySelector('.wp-pick-btn img.wp-pick-icon')?.getAttribute('src') === '/assets/wp-agents/claude.svg');
    const afterSwitch = await page.evaluate(() => ({
      selected: document.querySelector('[data-assistant-selected="true"]')?.dataset.assistantBackend,
      text: document.querySelector('.wp-pick-btn')?.textContent?.trim(),
    }));
    assert.equal(afterSwitch.selected, 'claude');
    assert.match(afterSwitch.text, /Sonnet 5\.5/);

    await page.click('.wp-pick-btn');
    await page.click('.wp-pick-eff-opt:has-text("高")');
    await page.waitForFunction(() => (document.querySelector('.wp-pick-btn .wp-pick-effort')?.textContent || '') === '高');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('conversation locks other backend with new-chat hint and updates current model via API', LONG, async () => {
  suite.harness.use(suite.main);
  await suite.session('conv-desktop', { viewport: DESKTOP, route: null }, async ({ page, log }) => {
    const { puts } = await setupPicker(page, { hasClaude: true, convBackend: 'codex' });
    await mountAndWait(page, '#/conversation/c1');
    await page.click('.wp-pick-btn');
    await page.waitForSelector('.wp-pick-model-menu');
    const locked = await page.evaluate(() => {
      const grp = document.querySelector('.wp-pick-group[data-backend="claude"]');
      const items = [...grp.querySelectorAll('.wp-pick-item')];
      return {
        isLocked: grp.classList.contains('is-locked'),
        allDisabled: items.length > 0 && items.every(b => b.disabled),
        hint: grp.querySelector('.wp-pick-lock-hint')?.textContent?.trim(),
      };
    });
    assert.equal(locked.isLocked, true);
    assert.equal(locked.allDisabled, true);
    assert.equal(locked.hint, '换 Claude 请新建对话');
    await suite.shot(page, 'conv-desktop-menu');

    await page.click('.wp-pick-group[data-backend="codex"] .wp-pick-item:has-text("GPT-6.2 Sol")');
    await page.waitForFunction(() => (document.querySelector('.wp-pick-btn .wp-pick-name')?.textContent || '') === 'GPT-6.2 Sol');
    assert.ok(puts.some(p => p.id === 'model' && p.value === 'gpt-6.2-sol'));

    await page.click('.wp-pick-btn');
    await page.click('.wp-pick-group[data-backend="claude"] .wp-pick-lock-hint');
    await page.waitForFunction(() => location.hash === '#/guid' && document.querySelector('[data-assistant-selected="true"]')?.dataset.assistantBackend === 'claude');
    assert.equal(await page.locator('.wp-pick-btn img.wp-pick-icon').getAttribute('src'), '/assets/wp-agents/claude.svg');
    assert.deepEqual(log.pageErrors, []);
  });
});

test('without Claude access shows single unnamed group on home and conversation', LONG, async () => {
  suite.harness.use(suite.main);
  await suite.session('no-claude', { viewport: DESKTOP, route: null }, async ({ page, log }) => {
    await setupPicker(page, { hasClaude: false, convBackend: 'codex' });
    for (const [route, shot] of [['#/guid', 'nocl-home-menu'], ['#/conversation/c1', 'nocl-conv-menu']]) {
      await mountAndWait(page, route);
      await page.click('.wp-pick-btn');
      await page.waitForSelector('.wp-pick-model-menu');
      const info = await page.evaluate(() => ({
        groups: document.querySelectorAll('.wp-pick-group').length,
        titles: [...document.querySelectorAll('.wp-pick-group-title')].map(el => el.textContent.trim()),
        locks: document.querySelectorAll('.wp-pick-lock-hint').length,
      }));
      assert.equal(info.groups, 1);
      assert.deepEqual(info.titles, ['模型']);
      assert.equal(info.locks, 0);
      await suite.shot(page, shot);
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(log.pageErrors, []);
  });
});

for (const width of [390, 360]) {
  test(`mobile ${width}px home and conversation menus stay inside viewport and dark mode inverts chatgpt icon`, LONG, async () => {
    suite.harness.use(suite.main);
    await suite.session(`mobile-${width}`, { viewport: { width, height: 844 }, route: null }, async ({ page, log }) => {
      await setupPicker(page, { hasClaude: true, convBackend: 'codex', mobile: true, dark: width === 390 });
      for (const route of ['#/guid', '#/conversation/c1']) {
        await mountAndWait(page, route);
        await page.click('.wp-pick-btn');
        await page.waitForSelector('.wp-pick-model-menu');
        await page.waitForTimeout(180);
        const box = await page.evaluate(() => {
          const menu = document.querySelector('.wp-pick-model-menu').getBoundingClientRect();
          const btn = document.querySelector('.wp-pick-btn').getBoundingClientRect();
          const name = document.querySelector('.wp-pick-btn .wp-pick-name');
          const icon = document.querySelector('.wp-pick-btn img.wp-chatgpt');
          return { vw: innerWidth, vh: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
            nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : true,
            btn, menu, filter: icon ? getComputedStyle(icon).filter : '' };
        });
        assert.equal(box.overflowX, false, 'no horizontal page overflow');
        assert.equal(box.nameClipped, false, 'model name is not truncated on mobile');
        assert.ok(box.btn.left >= 0 && box.btn.right <= box.vw + 1, 'picker button fits viewport');
        assert.ok(box.menu.left >= 0 && box.menu.right <= box.vw + 1, 'picker menu fits width');
        assert.ok(box.menu.top >= 0 && box.menu.bottom <= box.vh + 1, 'picker menu fits height');
        if (width === 390) assert.match(box.filter, /invert/);
        await suite.shot(page, `mobile-${width}-${route.includes('guid') ? 'home' : 'conv'}-menu`);
        await page.keyboard.press('Escape');
      }
      assert.deepEqual(log.pageErrors, []);
    });
  });
}
