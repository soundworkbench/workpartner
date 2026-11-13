import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuOnboarding } from '../feishu-onboarding.mjs';

for (const mode of ['success', 'stderr', 'missing', 'nonzero', 'invalid', 'failed']) {
  test(`onboarding restart ${mode}: service first, container fallback only on failure`, async () => {
    const calls = [], user = { slug: 'tang', backend: 'aionui' };
    const handler = createFeishuOnboarding({ authenticate: () => user, uid: 1001,
      execute: async (_, action) => { calls.push(action); return { status: 'needs_restart' }; },
      runtime: {
        exec: async (...args) => {
          calls.push(['exec', ...args]);
          if (mode === 'missing') throw new Error('script missing');
          const stdout = mode === 'invalid' ? 'invalid' : JSON.stringify({ ok: mode !== 'failed' });
          const stderr = mode === 'stderr' ? 'worker diagnostic: token private\n' : '';
          return { exitCode: mode === 'nonzero' ? 1 : 0, stdout, stderr, logs: stderr + stdout };
        },
        restart: async slug => { calls.push(['restart', slug]); },
      }, restarted: slug => calls.push(['forget', slug]) });
    let code, body;
    await handler({ method: 'GET', headers: {} }, { writeHead: status => { code = status; }, end: value => { body = value; } }, new URL('https://test/_wp/aionui/feishu/status'));
    assert.equal(code, 200); assert.deepEqual(JSON.parse(body), { status: 'connected' });
    assert.deepEqual(calls, ['status', 'restarting', ['exec', 'tang', ['python3', '/opt/workpartner/bin/wp-feishu-bot.py', 'restart'], { user: '1001', timeout: 20000, maxOutputBytes: 1024 * 1024 }],
      ...(['success', 'stderr'].includes(mode) ? [] : [['restart', 'tang']]), 'connected', ['forget', 'tang']]);
  });
}
