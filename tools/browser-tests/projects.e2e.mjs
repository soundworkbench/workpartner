// Project interactions that do not require a live AionUi engine. The fixture supplies
// the real overlay and a fake file/conversation API, so layout and touch-width regressions
// are caught before a container screenshot pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite, LONG } from './lib/suite.mjs';
import { DESKTOP, PHONE } from './lib/browser.mjs';

const PROJECTS = JSON.stringify({ version: 1, projects: [{ id: 'p_alpha', name: '客户资料', icon: 'folder', color: '#879b9b', order: 0, description: '项目说明' }] });
const suite = createSuite('projects', async s => { s.main = await s.harness.startGateway('projects', { feedback: false }); });

for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  test(`projects: sidebar and modal fit ${name}`, LONG, async () => {
    await suite.session('projects-' + name, { viewport, storage: { 'wp-projects-cache': PROJECTS } }, async ({ page, log }) => {
      await page.waitForSelector('.wp-projects-root');
      assert.equal(await page.locator('.wp-project-row').count(), 1);
      assert.equal(await page.locator('.wp-project-name').textContent(), '客户资料');
      await page.locator('.wp-project-toggle').click();
      assert.equal(await page.locator('.wp-project-arrow').textContent(), '⌄');
      await page.locator('.wp-project-add').click();
      await page.waitForSelector('.wp-project-dialog');
      const box = await page.locator('.wp-project-dialog').boundingBox();
      assert.ok(box.width <= viewport.width && box.x >= 0, 'project dialog stays in viewport');
      await page.locator('[data-cancel]').click();
      await page.locator('.wp-project-toggle').click();
      await page.locator('.wp-project-toggle').click();
      await page.waitForTimeout(50);
      assert.ok((await page.locator('.wp-projects-root').boundingBox()).width <= viewport.width);
      assert.deepEqual(log.pageErrors, []);
    });
  });
}
