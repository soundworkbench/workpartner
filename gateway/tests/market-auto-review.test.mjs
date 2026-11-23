import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedSkillStore, inspectSkill } from '../market-shared.mjs';

const author = { unionId: 'author', slug: 'author', name: '作者', backend: 'aionui' };
const reviewer = { unionId: 'reviewer', slug: 'reviewer', name: '审批人', backend: 'aionui' };
const meta = semver => ({ displayName: '测试技能', description: '测试', example: '测试', ...(semver === undefined ? {} : { semver }) });
const bundle = (text = '# skill') => ({ name: 'test-skill', description: '测试', files: [{ path: 'SKILL.md', content: Buffer.from(text).toString('base64') }] });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-auto-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createSharedSkillStore({ stateDir: path.join(root, 'state'), sharedDir: path.join(root, 'shared'), approvers: ['reviewer'], ...options });
  return store;
}

test('first submission remains pending and reports manual reason', async t => {
  const store = fixture(t); const result = await store.submit(author, bundle(), meta('1.0.0'));
  assert.equal(result.status, 'pending'); assert.equal(result.manualReasons[0].rule, 'first-submission'); assert.equal(result.autoPublished, false);
});

test('clean increasing update auto publishes and includes semver summary', async t => {
  const store = fixture(t); const first = await store.submit(author, bundle(), meta('1.0.0')); await store.review(reviewer, first.name, first.version, 'approve');
  const next = await store.submit(author, bundle('# next'), meta('1.0.1'));
  assert.equal(next.status, 'approved'); assert.equal(next.autoPublished, true); assert.equal(store.list(author).company[0].semver, '1.0.1');
});

test('hard blocks expose only structured locations', () => {
  assert.throws(() => inspectSkill(bundle('rm -rf /')), error => error.status === 400 && error.findings[0].line === 1 && !error.message.includes('rm -rf /'));
});

test('trusted domains suppress links and superseded versions leave pending', async t => {
  const store = fixture(t, { trustedDomains: ['example.org'] }); const first = await store.submit(author, bundle(), meta('1.0.0')); await store.review(reviewer, first.name, first.version, 'approve');
  const pending = await store.submit(author, bundle('https://evil.example'), meta('1.1.0')); assert.equal(pending.status, 'pending');
  const next = await store.submit(author, bundle('# clean'), meta('1.2.0')); assert.equal(next.status, 'approved');
  assert.equal(store.list(reviewer).pending.length, 0); assert.equal(store.list(reviewer).reviewed.some(v => v.semver === '1.1.0' && v.status === 'superseded'), true);
});
