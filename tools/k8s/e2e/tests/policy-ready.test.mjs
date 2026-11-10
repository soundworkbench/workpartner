import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRunners } from '../context.mjs';
import { scenarios } from '../scenarios.mjs';

const s10 = scenarios.find(s => s.id === 'S10');
const slugs = ['node-server', 'node-agent'];
const allowedLabels = ['gateway HTTP', 'gateway internal', 'model egress', 'external'];

// All probes run through an offline runtime; addresses are fixture identifiers.
function fixture({ external = true, respond = () => undefined } = {}) {
  const calls = [], jobs = [], recreated = [];
  const config = {
    policyTimeoutMs: 3000, gatewayIp: 'gateway-address', samplePort: 18081,
    nodeIps: ['server-address', 'agent-address'],
    apiProbe: { host: 'api-address', port: 443 },
    privateProbe: { host: 'private-address', port: 80 },
    ...(external ? { externalProbe: { host: 'external-address', port: 443 } } : {}),
  };
  const runtime = {
    exec: async (slug, _args, { stdin }) => {
      const target = JSON.parse(stdin);
      calls.push({ slug, ...target });
      const override = respond(slug, target, calls);
      const value = override ?? (target.kind === 'dns' ? [config.gatewayIp]
        : target.kind === 'route' ? 'cni-address'
          : { open: allowedLabels.includes(target.label), reason: 'fixture' });
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
    },
    stop: async () => {},
    runOnce: async slug => { jobs.push(slug); return { exitCode: 0 }; },
  };
  const c = {
    config, runtime,
    org: { runtime: { gatewayOrigin: 'http://gateway.invalid:18080', gatewayPort: 18080, internalPort: 18082 },
      model: { baseUrl: 'http://model.invalid:18083' } },
    name: slug => `fixture-${slug}`,
    pod: async slug => ({ status: { podIP: `${slug}-address-${recreated.includes(slug) ? 'new' : 'old'}` } }),
    ready: async slug => { recreated.push(slug); },
    probe: async () => ({ open: true }),
    ...probeRunners(runtime, { exec: async () => ({ exitCode: 0, stdout: '{"open":false}', stderr: '' }) }, config, ''),
  };
  return { c, calls, jobs, recreated };
}

function assertDenialsOnce(calls, rows) {
  const denied = calls.filter(call => call.open === false);
  assert.equal(denied.length, 30);
  assert.equal(new Set(denied.map(({ slug, host, port }) => JSON.stringify([slug, host, port]))).size, 30);
  assert.equal(rows.filter(row => row.expectedOpen === false).length, 30);
}

test('S10 waits for TCP allow rules on both Pods and probes denials only once', async t => {
  for (const label of allowedLabels) await t.test(label, async () => {
    const attempts = new Map();
    const f = fixture({ respond: (slug, target) => {
      if (target.label !== label) return;
      const attempt = (attempts.get(slug) ?? 0) + 1;
      attempts.set(slug, attempt);
      return { open: attempt > 2, reason: attempt > 2 ? 'connected' : 'timeout' };
    } });
    const result = await s10.run(f.c);
    assert.equal(result.external, 'PASS');
    assert.deepEqual(f.jobs, slugs);
    assert.deepEqual(f.recreated, slugs);
    for (const slug of slugs) {
      assert.ok(attempts.get(slug) >= 4, 'retry, convergence and original matrix probe must all run');
      for (const allowed of allowedLabels) {
        const row = result.rows.find(row => row.source === slug && row.label === allowed);
        assert.equal(row.expectedOpen, true);
        assert.equal(row.open, true);
      }
    }
    assertDenialsOnce(f.calls, result.rows);
  });
});

test('S10 works without an external probe and still waits for DNS', async () => {
  const attempts = new Map();
  const f = fixture({ external: false, respond: (slug, target) => {
    if (target.kind !== 'dns') return;
    const attempt = (attempts.get(slug) ?? 0) + 1;
    attempts.set(slug, attempt);
    if (attempt === 1) throw Object.assign(new Error('Timed out'), { code: 'Timeout' });
    if (attempt === 2) return [f.c.config.gatewayIp, 'unexpected-address'];
  } });
  const result = await s10.run(f.c);
  assert.equal(result.external, 'SKIP: no --external-probe');
  assert.ok(f.calls.every(call => call.label !== 'external'));
  assertDenialsOnce(f.calls, result.rows);
});

test('S10 fails on a transient open denial without retrying it', async () => {
  let denied = 0;
  const f = fixture({ respond: (_slug, target) => {
    if (target.open === false) return { open: ++denied === 1 };
  } });
  await assert.rejects(s10.run(f.c), /gateway other listening port/);
  assert.equal(denied, 1);
  assert.equal(f.jobs.length, 0);
});

test('S10 persistent TCP failure times out before any denial or job runs', async () => {
  const f = fixture({ respond: (slug, target) => {
    if (slug === 'node-agent' && target.label === 'gateway HTTP') return { open: false, reason: 'timeout' };
  } });
  f.c.config.policyTimeoutMs = 10;
  await assert.rejects(s10.run(f.c), /Policy convergence timed out for Pod fixture-node-agent-0/);
  assert.deepEqual(f.c.evidence.policyTimeout, { slug: 'node-agent', pod: 'fixture-node-agent-0' });
  assert.equal(f.calls.filter(call => call.open === false).length, 0);
  assert.equal(f.jobs.length, 0);
});

test('S10 retains the original matrix allow assertion after convergence', async () => {
  let attempts = 0;
  const f = fixture({ respond: (_slug, target) => {
    if (target.label === 'gateway HTTP') return { open: ++attempts <= 2 };
  } });
  await assert.rejects(s10.run(f.c), /node-server: gateway HTTP/);
  assert.equal(attempts, 3);
  assert.equal(f.jobs.length, 0);
});
