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
        : target.kind === 'lookup' ? { addresses: [{ address: config.gatewayIp, family: 4 }], ms: target.host.endsWith('.') ? 2 : 1200 }
        : target.kind === 'resolv' ? ['search fixture-users.svc.cluster.invalid fixture-system.svc.cluster.invalid', 'options ndots:5']
        : target.kind === 'route' ? 'cni-address'
          : { open: allowedLabels.includes(target.label), reason: 'fixture' });
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
    },
    stop: async () => {},
    runOnce: async slug => { jobs.push(slug); return { exitCode: 0 }; },
  };
  const c = {
    config, runtime,
    org: { runtime: { gatewayOrigin: 'http://gateway.fixture-system.svc.cluster.invalid:18080', gatewayPort: 18080, internalPort: 18082,
      k8s: { systemNamespace: 'fixture-system', clusterDomain: 'cluster.invalid' } },
      model: { baseUrl: 'http://model.fixture-system.svc.cluster.invalid:18083' } },
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
  await assert.rejects(s10.run(f.c), /Policy convergence timed out for Pod fixture-node-agent-0.*node-agent: gateway HTTP \(timeout\)/);
  assert.deepEqual(f.c.evidence.policyTimeout, { slug: 'node-agent', pod: 'fixture-node-agent-0' });
  assert.equal(f.c.evidence.nameResolution.length, 2);
  assert.ok(f.c.evidence.nameResolution.every(entry => entry.lookups.length === 4 && entry.resolv.length === 2));
  assert.equal(f.calls.filter(call => call.open === false).length, 0);
  assert.equal(f.jobs.length, 0);
});

test('S10 retains the original matrix allow assertion after convergence', async () => {
  let attempts = 0;
  const f = fixture({ respond: (_slug, target) => {
    if (target.label === 'gateway HTTP') return { open: ++attempts <= 2, reason: 'ECONNREFUSED' };
  } });
  await assert.rejects(s10.run(f.c), /node-server: gateway HTTP \(ECONNREFUSED\)/);
  assert.equal(f.c.evidence.nameResolution.length, 2);
  assert.equal(attempts, 3);
  assert.equal(f.jobs.length, 0);
});

test('S10 records configured gateway/model, short and absolute lookup timings before convergence, including on PASS', async () => {
  const f = fixture();
  const result = await s10.run(f.c);
  assert.deepEqual(result.nameResolution.map(entry => entry.source), slugs);
  for (const entry of result.nameResolution) {
    assert.deepEqual(entry.lookups, [
      { host: 'gateway.fixture-system.svc.cluster.invalid', addresses: [{ address: f.c.config.gatewayIp, family: 4 }], ms: 1200 },
      { host: 'model.fixture-system.svc.cluster.invalid', addresses: [{ address: f.c.config.gatewayIp, family: 4 }], ms: 1200 },
      { host: 'gateway', addresses: [{ address: f.c.config.gatewayIp, family: 4 }], ms: 1200 },
      { host: 'gateway.fixture-system.svc.cluster.invalid.', addresses: [{ address: f.c.config.gatewayIp, family: 4 }], ms: 2 },
    ]);
    assert.deepEqual(entry.resolv, ['search fixture-users.svc.cluster.invalid fixture-system.svc.cluster.invalid', 'options ndots:5']);
  }
  assert.deepEqual(f.calls.slice(0, 10).map(call => [call.slug, call.kind]),
    slugs.flatMap(slug => ['resolv', 'lookup', 'lookup', 'lookup', 'lookup'].map(kind => [slug, kind])));
  assert.ok(f.calls.filter(call => call.kind === 'dns' || call.label?.startsWith('gateway ')
    && call.open === true).every(call => call.host === 'gateway.fixture-system.svc.cluster.invalid'));
  assert.ok(f.calls.filter(call => call.label === 'model egress').every(call => call.host === 'model.fixture-system.svc.cluster.invalid'));
});

test('S10 retains lookup errors and continues collecting evidence after a probe transport failure', async () => {
  const f = fixture({ respond: (slug, target) => {
    if (target.kind !== 'lookup' || target.host !== 'gateway') return;
    if (slug === 'node-server') throw Object.assign(new Error('not evidence'), { code: 'Timeout' });
    return { error: 'EAI_AGAIN', ms: 1500 };
  } });
  const result = await s10.run(f.c);
  assert.deepEqual(result.nameResolution[0].lookups[2], { host: 'gateway', status: 'unavailable', error: 'Timeout' });
  assert.deepEqual(result.nameResolution[1].lookups[2], { host: 'gateway', error: 'EAI_AGAIN', ms: 1500 });
  assert.ok(result.nameResolution.every(entry => entry.lookups[3].ms === 2));
});

test('S10 uses a no reason fallback in convergence and matrix assertion messages', async t => {
  for (const stage of ['convergence', 'matrix']) await t.test(stage, async () => {
    let attempts = 0;
    const f = fixture({ respond: (_slug, target) => {
      if (target.label === 'gateway HTTP') return { open: stage === 'matrix' && ++attempts <= 2 };
    } });
    f.c.config.policyTimeoutMs = 10;
    await assert.rejects(s10.run(f.c), /node-server: gateway HTTP \(no reason\)/);
  });
});
