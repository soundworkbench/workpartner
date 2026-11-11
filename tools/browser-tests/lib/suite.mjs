// Per-file wiring: one harness and one browser for all tests of a group, torn down at the end.
import { before, after } from 'node:test';
import { createHarness } from './harness.mjs';
import { launch, open, shooter } from './browser.mjs';

export const LONG = { timeout: 240000 };

/**
 * `prepare(suite)` starts the gateways and seeds data before the browser is launched.
 * `suite.session(label, options, body)` opens a page, runs the body and always closes the page;
 * when the body throws, a screenshot named failed-<label>.png is kept next to the others.
 */
export function createSuite(group, prepare) {
  const suite = { group };
  before(async () => {
    suite.harness = await createHarness(group);
    suite.shot = shooter(group);
    await prepare(suite);
    suite.browser = await launch(suite.harness);
  }, LONG);
  after(async () => {
    await suite.browser?.close();
    await suite.harness?.stop();
  }, LONG);
  suite.session = async (label, options, body) => {
    const session = await open(suite.browser, suite.harness, options);
    try { return await body(session); }
    catch (error) {
      await suite.shot(session.page, 'failed-' + label).catch(() => {});
      throw error;
    } finally { await session.close(); }
  };
  return suite;
}

/** Poll a condition evaluated in the test process (for example: "an alert was recorded"). */
export async function until(condition, what, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
