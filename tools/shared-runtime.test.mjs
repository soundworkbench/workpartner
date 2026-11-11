/** Reviewed skills retain the public runtime's file leases and execution adapters. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../gateway/runtime/index.mjs';
import { skillExecutor } from '../gateway/market-skills.mjs';

test('Docker factory mounts the shared library read-only and supplies startup policy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-docker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'model-person.key'), 'fixture');
  let created;
  const organization = { runtime: { kind: 'docker', uid: process.getuid(), nextImage: 'fixture-image',
    nextDirectory: dir, usersDirectory: dir, secureDirectory: dir, hostSecure: '/secure-host', hostData: '/host-data' },
    model: { keyPrefix: 'model-', baseUrl: 'https://models.example.test/v1' },
    features: { marketSkills: true },
    market: { sharedDirectory: '/reviewed', containerDirectory: '/opt/reviewed', preinstalled: ['meeting-notes'] } };
  const runtime = createRuntime(organization, { docker: async (method, route, body) => {
    assert.equal(method, 'POST'); assert.ok(route.startsWith('/containers/create?'));
    created = body; return { status: 201, body: Buffer.from('{}') };
  } });
  await runtime.create({ slug: 'person' });
  assert.ok(created.HostConfig.Binds.includes('/host-data/reviewed:/opt/reviewed:ro'));
  assert.ok(created.Env.includes('WORKPARTNER_SHARED_SKILLS=/opt/reviewed'));
  assert.ok(created.Env.includes('WORKPARTNER_MARKET_PREINSTALLED=["meeting-notes"]'));
});

test('export and shared install use the selected runtime with the original uid and propagate worker failures', async () => {
  const calls = [];
  const execute = skillExecutor({ async exec(...args) {
    calls.push(args); return { exitCode: 0, stdout: '{"name":"meeting-notes","files":[]}' };
  } }, 1002);
  const user = { slug: 'person' };
  for (const action of ['export', 'shared-install', 'delete']) {
    assert.equal((await execute(user, action, { name: 'meeting-notes' })).name, 'meeting-notes');
    assert.deepEqual(calls.at(-1), ['person', ['/opt/workpartner/bin/wp-skill', action, '--', 'meeting-notes'],
      { user: '1002', strictOutput: true }]);
  }
  const failed = skillExecutor({ async exec() { return { exitCode: 1, stdout: '{}' }; } });
  await assert.rejects(failed(user, 'export', { name: 'meeting-notes' }), /worker failed/);
});
