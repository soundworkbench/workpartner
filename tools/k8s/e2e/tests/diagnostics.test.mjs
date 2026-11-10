import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPolicyDiagnostics } from '../diagnostics.mjs';
import { organization } from '../controller.mjs';
import { renderManifests } from '../../render.mjs';

function fixture() {
  const config = { prefix: 'wp-e2e-fixture', serverNode: 'server', agentNode: 'agent', guard: true,
    gatewayIp: 'gateway-address', nodeIps: [], image: 'fixture', gatewayImage: 'fixture',
    storageProvisioner: 'fixture', storageParameters: {}, clusterDomain: 'cluster.invalid' };
  config.organization = organization(config);
  const { namespace: users, systemNamespace: system } = config.organization.runtime.k8s;
  const calls = [], sentinel = 'DO-NOT-SERIALIZE';
  const pod = (name, namespace, node, role, ip) => ({
    metadata: { name, namespace, labels: { 'workpartner/role': role }, annotations: { secret: sentinel } },
    spec: { nodeName: node, containers: [{ name: role === 'gateway' ? 'gateway' : 'workspace',
      env: [{ name: 'TOKEN', value: sentinel }], ports: [{ containerPort: 18083 }] }] },
    status: { podIP: ip, phase: 'Running', conditions: [{ type: 'Ready', status: 'True', message: sentinel }],
      containerStatuses: [{ name: role, ready: true, restartCount: 2, state: { running: { message: sentinel } } }] },
  });
  const gateway = pod('gateway', system, 'server', 'gateway', config.gatewayIp);
  const userPods = ['node-server', 'node-agent', 'another'].map((slug, i) =>
    pod(`wp-e2e-fixture-${slug}-0`, users, i === 1 ? 'agent' : 'server', 'user', `user-address-${i}`));
  const service = { metadata: { name: 'wp-e2e-fixture-gateway', namespace: system, annotations: { secret: sentinel } },
    spec: { clusterIP: 'None', selector: { 'workpartner/role': 'gateway' }, ports: [{ port: 18083, targetPort: 18083 }] } };
  const policy = { metadata: { name: 'allow', annotations: { secret: sentinel } }, spec: {
    podSelector: { matchLabels: { 'workpartner/role': 'user' } }, policyTypes: ['Egress'],
    egress: [{ to: [{ podSelector: { matchLabels: { 'workpartner/role': 'gateway' } } }], ports: [{ port: 18083 }, { port: 18084 }] }],
  } };
  const runtime = {
    get: async (resource, namespace, selector) => {
      calls.push({ resource, namespace, selector });
      if (resource === 'pods') return { items: namespace === users ? userPods : [gateway] };
      if (resource.startsWith('service/')) return service;
      if (resource === 'endpointslices.discovery.k8s.io') return { items: [{ metadata: { name: 'slice', namespace: system },
        addressType: 'IPv4', ports: [{ name: 'gateway', port: 18083 }], endpoints: [{ addresses: [config.gatewayIp],
          conditions: { ready: true }, nodeName: 'server', targetRef: { kind: 'Pod', name: 'gateway', namespace: system, secret: sentinel } }] }] };
      if (resource === 'networkpolicies') return { items: [{ ...policy, metadata: { ...policy.metadata, namespace } }] };
      throw new Error(`Unexpected resource ${resource}`);
    },
    probe: async (source, target) => {
      calls.push({ source, target });
      return target.kind === 'http' ? { status: 200, body: sentinel }
        : { open: target.port === 18084 || source.container === 'gateway', reason: 'timeout', stderr: sentinel };
    },
    guard: async node => { calls.push({ guard: node }); return { file: `guard-${node}.txt`, rules: 'counter packets 2 bytes 120 drop' }; },
  };
  return { runtime, config, calls, gateway, sentinel };
}

test('timeout diagnostics include actual resources, both ports, same-node peer and both guards without secrets', async () => {
  const f = fixture();
  const result = await collectPolicyDiagnostics(f.runtime, f.config, 'node-server');
  assert.deepEqual(result.errors, []);
  assert.equal(result.gatewayPods[0].ip, f.config.gatewayIp);
  assert.equal(result.gatewayPods[0].ready, 'True');
  assert.equal(result.gatewayPods[0].statuses[0].restartCount, 2);
  assert.equal(result.services[0].ports[0].targetPort, 18083);
  assert.deepEqual(result.endpointSlices[0].endpoints[0].addresses, [f.config.gatewayIp]);
  assert.equal(result.networkPolicies.length, 2);
  assert.deepEqual(result.networkPolicies[0].egress[0].ports.map(p => p.port), [18083, 18084]);
  assert.equal(result.probes.length, 12);
  const self = result.probes.filter(p => p.source.container === 'gateway');
  assert.equal(self.length, 6);
  assert.deepEqual([...new Set(self.map(p => p.target.host))], ['127.0.0.1', f.config.gatewayIp]);
  assert.equal(self.filter(p => p.target.kind === 'http' && p.result.status === 200).length, 2);
  const peer = result.probes.filter(p => p.source.name === 'wp-e2e-fixture-another-0');
  assert.deepEqual(peer.map(p => [p.target.host, p.target.port, p.result.open]),
    [[f.config.gatewayIp, 18083, false], [f.config.gatewayIp, 18084, true]]);
  assert.deepEqual(result.sameNodeUserPods, ['wp-e2e-fixture-node-server-0', 'wp-e2e-fixture-another-0']);
  assert.deepEqual(result.guards.map(g => g.file), ['guard-server.txt', 'guard-agent.txt']);
  assert.ok(result.guards.every(g => g.rules.includes('counter')));
  assert.ok(!JSON.stringify(result).includes(f.sentinel));
  assert.ok(f.calls.every(c => !c.resource || !/secret|configmap/.test(c.resource)));
});

test('diagnostic API, exec and node failures preserve partial evidence and never include exception text', async () => {
  const f = fixture(), get = f.runtime.get;
  f.runtime.get = (...args) => {
    if (args[0] === 'networkpolicies') throw new Error(f.sentinel);
    return get(...args);
  };
  f.runtime.probe = async () => { throw new Error(f.sentinel); };
  f.runtime.guard = async node => { if (node === 'server') throw new Error(f.sentinel); return { file: 'guard-agent.txt' }; };
  const result = await collectPolicyDiagnostics(f.runtime, f.config, 'node-agent');
  assert.equal(result.services.length, 1);
  assert.equal(result.probes.length, 10);
  assert.ok(result.probes.every(p => p.result.status === 'unavailable'));
  assert.equal(result.guards[0].status, 'unavailable');
  assert.equal(result.guards[1].file, 'guard-agent.txt');
  assert.equal(result.errors.length, 13);
  assert.ok(!JSON.stringify(result).includes(f.sentinel));
});

test('missing gateway and disabled guards are explicit; diagnostics do not create resources', async () => {
  const f = fixture();
  f.runtime.get = async () => ({ items: [] });
  f.config.guard = false;
  const result = await collectPolicyDiagnostics(f.runtime, f.config, 'node-server');
  assert.deepEqual(result.gatewayPods, []);
  assert.deepEqual(result.probes, []);
  assert.ok(result.errors.some(e => e.status === 'no gateway Pod'));
  assert.ok(result.errors.some(e => e.status === 'no same-node user Pod'));
  assert.ok(result.guards.every(g => g.status === 'disabled'));
  assert.equal(f.calls.length, 0);
});

test('e2e rendering uses distinct entry and Pod ports and consistent Service and policy ports', () => {
  const { config } = fixture(), org = config.organization;
  const { objects, warnings } = renderManifests(org);
  assert.deepEqual(warnings, []);
  const ports = objects.find(o => o.kind === 'Deployment').spec.template.spec.containers[0].ports;
  assert.equal(ports[0].hostPort, 18085);
  assert.notEqual(ports[0].hostPort, ports[0].containerPort);
  assert.equal(org.runtime.localAddress, `${ports[0].hostIP}:${ports[0].hostPort}`);
  assert.deepEqual(ports.map(p => p.containerPort), [org.runtime.gatewayPort, org.runtime.internalPort]);
  const svc = objects.find(o => o.kind === 'Service' && o.metadata.name.endsWith('-gateway'));
  assert.equal(svc.spec.clusterIP, 'None');
  assert.deepEqual(svc.spec.ports.map(p => [p.port, p.targetPort]), ports.map(p => [p.containerPort, p.containerPort]));
  const policy = objects.find(o => o.metadata.name === 'workpartner-user-egress');
  assert.deepEqual(policy.spec.egress[1].ports.map(p => p.port), ports.map(p => p.containerPort));
});
