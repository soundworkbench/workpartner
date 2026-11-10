import test from 'node:test';
import assert from 'node:assert/strict';
import { organization } from '../controller.mjs';
import { renderManifests } from '../../render.mjs';

const options = { prefix: 'fixture', nodeIps: [], image: 'fixture', gatewayImage: 'fixture',
  serverNode: 'server', agentNode: 'agent', storageProvisioner: 'fixture', storageParameters: {} };

test('organization uses system-namespace FQDN origins with default and custom cluster domains', async t => {
  for (const [clusterDomain, dnsNdots] of [[undefined, 4], [null, 4], ['cluster.invalid', 4], ['test.cluster.invalid', 5]]) await t.test(String(clusterDomain), () => {
    const org = organization({ ...options, clusterDomain });
    const domain = clusterDomain ?? 'cluster.local';
    assert.equal(org.runtime.gatewayOrigin, `http://fixture-gateway.fixture-system.svc.${domain}:18083`);
    assert.equal(org.runtime.internalOrigin, `http://fixture-gateway.fixture-system.svc.${domain}:18084`);
    assert.equal(org.model.baseUrl, `http://fixture-model.fixture-system.svc.${domain}:18082`);
    assert.equal(org.runtime.k8s.clusterDomain, domain);
    assert.equal(org.runtime.k8s.dnsNdots, dnsNdots);

    // Services, RBAC, policies, Deployment env and entry ports retain their shape.
    const short = structuredClone(org);
    short.runtime.gatewayOrigin = 'http://fixture-gateway:18083';
    short.runtime.internalOrigin = 'http://fixture-gateway:18084';
    short.model.baseUrl = 'http://fixture-model:18082';
    assert.deepEqual(renderManifests(org), renderManifests(short));
    const { objects } = renderManifests(org);
    const deployment = objects.find(object => object.kind === 'Deployment');
    assert.equal(deployment.metadata.name, 'fixture-gateway');
    assert.equal(deployment.spec.template.spec.serviceAccountName, 'fixture-gateway');
    assert.deepEqual(deployment.spec.template.spec.containers[0].env,
      [{ name: 'WORKPARTNER_ORG_DIR', value: '/organization' }]);
    const model = objects.find(object => object.kind === 'Service' && object.metadata.name === 'fixture-model');
    assert.deepEqual(model.spec.selector, { 'workpartner/role': 'model-egress' });
    assert.equal(model.spec.ports[0].port, 18082);
  });
});

test('rendering accepts only short Service names or FQDNs in the configured system namespace and domain', () => {
  for (const host of ['gateway.other-system.svc.cluster.invalid', 'gateway.fixture-system.svc.other.invalid',
    'gateway.external.invalid', 'nested.gateway.fixture-system.svc.cluster.invalid']) {
    const org = organization({ ...options, clusterDomain: 'cluster.invalid' });
    org.runtime.gatewayOrigin = `http://${host}:18083`;
    assert.throws(() => renderManifests(org), /runtime.gatewayOrigin.*system-namespace FQDN/);
    const modelOrg = organization({ ...options, clusterDomain: 'cluster.invalid' });
    modelOrg.model.baseUrl = `http://${host}:18082`;
    assert.throws(() => renderManifests(modelOrg), /model.baseUrl.*system-namespace FQDN/);
  }
});

test('FQDN rendering preserves hostname and port consistency checks and Service collision checks', () => {
  const org = organization({ ...options, clusterDomain: 'cluster.invalid' });
  org.model.nextBaseUrl = `${org.model.baseUrl}/v1`;
  assert.doesNotThrow(() => renderManifests(org));
  org.model.nextBaseUrl = org.model.baseUrl.replace('fixture-model.', 'other-model.');
  assert.throws(() => renderManifests(org), /hostnames and ports must match/);
  org.model.nextBaseUrl = '';
  org.runtime.internalOrigin = org.runtime.internalOrigin.replace('fixture-gateway.', 'other-gateway.');
  assert.throws(() => renderManifests(org), /hostnames must match/);
  org.runtime.internalOrigin = org.runtime.gatewayOrigin.replace(':18083', ':18084');
  org.model.baseUrl = org.runtime.gatewayOrigin.replace(':18083', ':18082');
  assert.throws(() => renderManifests(org), /must differ from the gateway Service/);
});
