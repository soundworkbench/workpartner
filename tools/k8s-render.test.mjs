/** Deployment manifests are rendered and checked offline, without kubectl or credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { organizationData } from '../gateway/organization/resolve.mjs';
import { renderManifests, writeManifests } from './k8s/render.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const renderer = path.join(root, 'tools/k8s/render.mjs');
const defaults = organizationData({ WORKPARTNER_ORG_DIR: path.join(root, 'org/default') });
const partOf = { 'app.kubernetes.io/part-of': 'workpartner' };
const userLabels = { ...partOf, 'workpartner/role': 'user' };
const gatewayLabels = { ...partOf, 'workpartner/role': 'gateway' };
const modelLabels = { ...partOf, 'workpartner/role': 'model-egress' };

function fixture() {
  const org = structuredClone(defaults);
  org.publicHost = 'workspace.example.com';
  org.model.baseUrl = 'http://model-egress:4000/v1';
  org.runtime.kind = 'k8s';
  org.runtime.k8s = {
    namespace: 'fixture-users', systemNamespace: 'fixture-system', storageClass: 'fixture-local',
    deploy: {
      gatewayImage: 'workpartner-gateway:fixture',
      entry: { mode: 'hostPort', hostIP: '127.0.0.1', hostPort: 3080 },
      hostPaths: {
        organization: '/srv/workpartner/organization', secure: '/srv/workpartner/secure',
        state: '/srv/workpartner/state', usersFile: '/srv/workpartner/users.json',
      },
      egressExceptCidrs: ['192.0.2.10/32', '192.0.2.11/32'],
      modelEgressSelector: modelLabels,
      newUserStorage: { provisioner: 'example.com/local-path', parameters: { nodePath: '/srv/workpartner/new-data' } },
    },
  };
  return org;
}

function find(objects, kind, name) {
  const matches = objects.filter(object => object.kind === kind && (!name || object.metadata.name === name));
  assert.equal(matches.length, 1, `${kind}/${name || ''}`);
  return matches[0];
}

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-render-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(args, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-render-cli-'));
  const stdoutPath = path.join(directory, 'stdout');
  const stderrPath = path.join(directory, 'stderr');
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [renderer, ...args], {
      env: { PATH: process.env.PATH }, ...options, stdio: ['ignore', stdout, stderr],
    });
    assert.ifError(result.error);
    return { ...result, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') };
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function documents(text) {
  return text.trim().split(/^---\s*$/m).map(document => JSON.parse(document));
}

test('disabled ASR preserves pre-ASR CLI output byte for byte in all deployment modes', t => {
  // Captured from the unmodified renderer before adding ASR support.
  const hashes = {
    'hostPort-selector': '80ccfdaa7a4f99d12db6812864cc33e94a3ba3c8a5400772e35654761657e2b6',
    'hostPort-endpoint': '160615aa58cbe9c1e2625538aa7e0c3beed9341a3fc8fd9095d81e859ed0c9ad',
    'clusterIP-selector': '31fc1981ed41b6ac5c06d87d18b63fba82ce79a5ecf61c0705d4804e0c09f7cc',
    'clusterIP-endpoint': '0e944e7b49c2d8a8a11097532a5907e2debdbc4b5e9baab97e719b095ddd6c35',
  };
  const directory = temporary(t);
  for (const [mode, hash] of Object.entries(hashes)) {
    const org = fixture();
    if (mode.startsWith('clusterIP')) org.runtime.k8s.deploy.entry = { mode: 'clusterIP', clusterIP: '10.43.0.80' };
    if (mode.endsWith('endpoint')) {
      delete org.runtime.k8s.deploy.modelEgressSelector;
      org.runtime.k8s.deploy.modelEgressEndpoint = { address: '192.0.2.10', port: 4100 };
    }
    for (const asr of [undefined, { enabled: false, image: 'unused', nodeName: 'unused', threads: 4 }]) {
      org.runtime.k8s.deploy.asr = asr;
      fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
      const result = cli(['--org', directory]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(createHash('sha256').update(result.stdout).digest('hex'), hash, mode);
    }
  }
});

test('enabled ASR adds only its Deployment, Service and gateway-only NetworkPolicy', () => {
  const org = fixture();
  const baseline = renderManifests(org).objects;
  org.runtime.k8s.deploy.asr = { enabled: true, image: 'docker.io/library/wp-asr:test', nodeName: 'srv2153109', threads: 3 };
  const objects = renderManifests(org).objects;
  assert.deepEqual(objects.slice(0, baseline.length), baseline);
  const added = objects.slice(baseline.length);
  assert.deepEqual(added.map(item => item.kind), ['Deployment', 'Service', 'NetworkPolicy']);
  for (const item of added) assert.equal(item.metadata.namespace, 'fixture-system');
  const deployment = find(added, 'Deployment', 'wp-asr');
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const pod = deployment.spec.template.spec;
  const labels = deployment.spec.template.metadata.labels;
  assert.deepEqual(deployment.spec.selector.matchLabels, labels);
  assert.deepEqual(pod.nodeSelector, { 'kubernetes.io/hostname': 'srv2153109' });
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.runAsUser, 10001);
  const container = pod.containers[0];
  assert.equal(container.image, org.runtime.k8s.deploy.asr.image);
  assert.equal(container.imagePullPolicy, 'Never');
  assert.deepEqual(container.env, [{ name: 'ASR_THREADS', value: '3' }]);
  assert.deepEqual(container.resources, { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '2Gi' } });
  assert.deepEqual(container.securityContext, {
    runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] },
  });
  for (const name of ['readinessProbe', 'livenessProbe', 'startupProbe']) {
    assert.deepEqual(container[name].httpGet, { path: '/healthz', port: 'http' });
  }
  assert.ok(container.readinessProbe.initialDelaySeconds >= 30);
  assert.ok(container.livenessProbe.initialDelaySeconds >= 120);
  const service = find(added, 'Service', 'wp-asr');
  assert.deepEqual(service.spec, { type: 'ClusterIP', selector: labels,
    ports: [{ name: 'http', port: 8080, targetPort: 8080, protocol: 'TCP' }] });
  const policy = find(added, 'NetworkPolicy', 'wp-asr');
  assert.deepEqual(policy.spec, {
    podSelector: { matchLabels: labels }, policyTypes: ['Ingress', 'Egress'],
    ingress: [{ from: [{ podSelector: { matchLabels: gatewayLabels } }], ports: [{ protocol: 'TCP', port: 8080 }] }],
    egress: [],
  });
  delete org.runtime.k8s.deploy.asr.threads;
  assert.deepEqual(find(renderManifests(org).objects, 'Deployment', 'wp-asr').spec.template.spec.containers[0].env,
    [{ name: 'ASR_THREADS', value: '2' }]);
  assert.equal(renderManifests(org, { only: 'NetworkPolicy' }).objects.filter(item => item.metadata.name === 'wp-asr').length, 1);
});

test('ASR rejects invalid enabled configuration', () => {
  for (const change of [{ enabled: 'true' }, { image: '' }, { nodeName: '' }, { threads: 0 }, { threads: 1.5 }, { threads: '2' }]) {
    const org = fixture();
    org.runtime.k8s.deploy.asr = { enabled: true, image: 'wp-asr:test', nodeName: 'srv2153109', ...change };
    assert.throws(() => renderManifests(org), /runtime.k8s.deploy.asr/);
  }
});

test('neutral defaults report all missing deployment settings without inventing organization values', () => {
  assert.throws(() => renderManifests(defaults), error => {
    for (const field of ['runtime.kind', 'runtime.k8s.namespace', 'runtime.k8s.storageClass',
      'runtime.k8s.deploy.gatewayImage', 'runtime.k8s.deploy.entry.mode',
      'runtime.k8s.deploy.hostPaths.organization', 'runtime.k8s.deploy.hostPaths.secure',
      'runtime.k8s.deploy.hostPaths.state', 'runtime.k8s.deploy.hostPaths.usersFile',
      'runtime.k8s.deploy.egressExceptCidrs', 'runtime.k8s.deploy.modelEgressSelector',
      'runtime.k8s.deploy.newUserStorage.provisioner', 'model.baseUrl']) {
      assert.ok(error.message.includes(field), field);
    }
    return true;
  });
});

test('rendering is deterministic, does not mutate configuration, and covers every K5 object', () => {
  const org = fixture();
  const before = structuredClone(org);
  const objects = renderManifests(org).objects;
  assert.deepEqual(org, before);
  assert.deepEqual(renderManifests(org).objects, objects);
  const counts = {};
  for (const object of objects) {
    counts[object.kind] = (counts[object.kind] || 0) + 1;
    assert.equal(object.metadata.labels['app.kubernetes.io/part-of'], 'workpartner');
  }
  assert.deepEqual(counts, { Namespace: 2, ServiceAccount: 1, Role: 2, RoleBinding: 2,
    PriorityClass: 1, Deployment: 1, Service: 3, NetworkPolicy: 4, StorageClass: 1, ConfigMap: 1 });
  assert.equal(new Set(objects.map(item => `${item.kind}/${item.metadata.namespace || ''}/${item.metadata.name}`)).size, objects.length);
  assert.ok(!objects.some(item => ['Secret', 'ClusterRole', 'ClusterRoleBinding', 'PersistentVolume'].includes(item.kind)));
});

test('the user namespace enforces baseline and warns restricted; system hostPath mounts stay separate', () => {
  const objects = renderManifests(fixture()).objects;
  assert.deepEqual(find(objects, 'Namespace', 'fixture-users').metadata.labels, {
    ...partOf, 'pod-security.kubernetes.io/enforce': 'baseline', 'pod-security.kubernetes.io/warn': 'restricted',
  });
  assert.deepEqual(find(objects, 'Namespace', 'fixture-system').metadata.labels, partOf);
});

test('RBAC grants only the runtime operations, with no cluster permissions or image registry writes', () => {
  const objects = renderManifests(fixture()).objects;
  const users = find(objects, 'Role', 'workpartner-users');
  assert.equal(users.metadata.namespace, 'fixture-users');
  assert.deepEqual(users.rules, [
    { apiGroups: ['apps'], resources: ['statefulsets'], verbs: ['get', 'list', 'create', 'update', 'patch', 'delete'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'create', 'delete'] },
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'create', 'update', 'patch'] },
    { apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['get', 'create'] },
    { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['get', 'list'] },
  ]);
  const system = find(objects, 'Role', 'workpartner-system');
  assert.equal(system.metadata.namespace, 'fixture-system');
  assert.deepEqual(system.rules, [
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
    { apiGroups: [''], resources: ['configmaps'], resourceNames: ['workpartner-images'], verbs: ['get'] },
  ]);
  const serviceAccount = find(objects, 'ServiceAccount');
  assert.equal(serviceAccount.metadata.name, 'workpartner-gateway');
  assert.equal(serviceAccount.metadata.namespace, 'fixture-system');
  for (const binding of objects.filter(item => item.kind === 'RoleBinding')) {
    assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'workpartner-gateway', namespace: 'fixture-system' }]);
    const role = find(objects, 'Role', binding.roleRef.name);
    assert.equal(binding.metadata.namespace, role.metadata.namespace);
    assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role.metadata.name });
  }
});

test('gateway uses a single Recreate replica, Guaranteed resources, control-plane placement and local entry', () => {
  const objects = renderManifests(fixture()).objects;
  const deployment = find(objects, 'Deployment');
  assert.equal(deployment.metadata.namespace, 'fixture-system');
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: 'Recreate' });
  assert.deepEqual(deployment.spec.selector.matchLabels, gatewayLabels);
  assert.deepEqual(deployment.spec.template.metadata.labels, gatewayLabels);
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod.nodeSelector, { 'node-role.kubernetes.io/control-plane': 'true' });
  assert.equal(pod.serviceAccountName, 'workpartner-gateway');
  assert.equal(pod.automountServiceAccountToken, true);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.hostNetwork, undefined);
  assert.ok(pod.tolerations.some(item => item.key === 'node-role.kubernetes.io/control-plane' && item.effect === 'NoSchedule'));
  const priority = find(objects, 'PriorityClass');
  assert.equal(priority.metadata.name, pod.priorityClassName);
  assert.equal(priority.value, 1000000);
  assert.equal(priority.globalDefault, false);
  assert.equal(pod.containers.length, 1);
  const container = pod.containers[0];
  assert.equal(container.image, 'workpartner-gateway:fixture');
  assert.equal(container.imagePullPolicy, 'Never');
  assert.deepEqual(container.resources.requests, { cpu: '500m', memory: '512Mi' });
  assert.deepEqual(container.resources.limits, container.resources.requests);
  assert.deepEqual(container.ports, [
    { name: 'gateway', containerPort: 3090, protocol: 'TCP', hostIP: '127.0.0.1', hostPort: 3080 },
    { name: 'internal', containerPort: 3091, protocol: 'TCP' },
  ]);
  assert.deepEqual(container.livenessProbe.tcpSocket, { port: 'gateway' });
  assert.deepEqual(container.readinessProbe, { tcpSocket: { port: 'gateway' }, periodSeconds: 2 });
  assert.deepEqual(container.env, [{ name: 'WORKPARTNER_ORG_DIR', value: '/organization' }]);
});

test('gateway mounts configured paths and the writable shared claim at the configured destination', () => {
  const org = fixture();
  Object.assign(org.runtime, { secureDirectory: '/fixture/secure', stateDirectory: '/fixture/state', usersFile: '/fixture/users.json' });
  org.runtime.sessionKeyFile = '/fixture/secure/session.key';
  org.runtime.cookieFile = '/fixture/state/cookies.json';
  org.identity.appSecretFile = '/fixture/secure/identity.secret';
  const pod = find(renderManifests(org).objects, 'Deployment').spec.template.spec;
  assert.deepEqual(pod.volumes, [
    { name: 'organization', hostPath: { path: '/srv/workpartner/organization', type: 'Directory' } },
    { name: 'secure', hostPath: { path: '/srv/workpartner/secure', type: 'Directory' } },
    { name: 'state', hostPath: { path: '/srv/workpartner/state', type: 'Directory' } },
    { name: 'users', hostPath: { path: '/srv/workpartner/users.json', type: 'File' } },
    { name: 'shared-skills', persistentVolumeClaim: { claimName: 'workpartner-shared-skills' } },
  ]);
  assert.deepEqual(pod.containers[0].volumeMounts, [
    { name: 'organization', mountPath: '/organization', readOnly: true },
    { name: 'secure', mountPath: '/fixture/secure' },
    { name: 'state', mountPath: '/fixture/state' },
    { name: 'users', mountPath: '/fixture/users.json' },
    { name: 'shared-skills', mountPath: org.market.sharedDirectory },
  ]);
  assert.ok(!JSON.stringify(pod).includes('docker.sock'));
});

test('gateway environment Secrets are attached only when configured', () => {
  const org = fixture();
  let container = find(renderManifests(org).objects, 'Deployment').spec.template.spec.containers[0];
  assert.equal(container.envFrom, undefined);
  org.runtime.k8s.deploy.gatewayEnvFrom = ['gateway-data-tools', 'gateway.extra'];
  container = find(renderManifests(org).objects, 'Deployment').spec.template.spec.containers[0];
  assert.deepEqual(container.envFrom, [{ secretRef: { name: 'gateway-data-tools' } }, { secretRef: { name: 'gateway.extra' } }]);
  assert.deepEqual(container.env, [{ name: 'WORKPARTNER_ORG_DIR', value: '/organization' }]);
});

test('shared claim is configurable and absent when the skill market is disabled', () => {
  const org = fixture();
  org.runtime.k8s.sharedSkillsClaim = 'reviewed-library';
  org.market.sharedDirectory = '/reviewed';
  let pod = find(renderManifests(org).objects, 'Deployment').spec.template.spec;
  assert.deepEqual(pod.volumes.at(-1), { name: 'shared-skills', persistentVolumeClaim: { claimName: 'reviewed-library' } });
  assert.equal(pod.containers[0].volumeMounts.at(-1).mountPath, '/reviewed');
  org.runtime.k8s.sharedSkillsClaim = '../invalid';
  assert.throws(() => renderManifests(org), /sharedSkillsClaim/);
  org.features.marketSkills = false;
  pod = find(renderManifests(org).objects, 'Deployment').spec.template.spec;
  assert.equal(pod.volumes.some(volume => volume.name === 'shared-skills'), false);
});

test('Service names and ports come from gateway origins, the governing setting and the model URL', () => {
  const org = fixture();
  Object.assign(org.runtime, { gatewayOrigin: 'http://fixture-gateway:4090', internalOrigin: 'http://fixture-gateway:4091',
    gatewayPort: 4090, internalPort: 4091, nextPort: 25809 });
  org.runtime.k8s.governingService = 'fixture-workspaces';
  org.runtime.k8s.deploy.gatewayNodeSelector = { 'example.com/node-role': 'gateway' };
  org.runtime.k8s.deploy.modelEgressSelector = { 'workpartner/role': 'model-egress', 'example.com/component': 'model' };
  org.model.baseUrl = 'https://fixture-model/v1';
  org.model.nextBaseUrl = 'https://fixture-model:443/next/v1';
  const objects = renderManifests(org).objects;
  assert.deepEqual(find(objects, 'Service', 'fixture-gateway').spec, {
    clusterIP: 'None', selector: gatewayLabels, ports: [
      { name: 'gateway', protocol: 'TCP', port: 4090, targetPort: 4090 },
      { name: 'internal', protocol: 'TCP', port: 4091, targetPort: 4091 },
    ],
  });
  assert.deepEqual(find(objects, 'Service', 'fixture-workspaces').spec, {
    clusterIP: 'None', selector: userLabels,
    ports: [{ name: 'workspace', protocol: 'TCP', port: 25809, targetPort: 25809 }],
  });
  assert.deepEqual(find(objects, 'Service', 'fixture-model').spec, {
    type: 'ClusterIP', selector: { 'workpartner/role': 'model-egress', 'example.com/component': 'model' },
    ports: [{ name: 'model', protocol: 'TCP', port: 443, targetPort: 443 }],
  });
  const pod = find(objects, 'Deployment').spec.template.spec;
  assert.deepEqual(pod.nodeSelector, { 'example.com/node-role': 'gateway' });
  assert.equal(pod.serviceAccountName, 'fixture-gateway');
  const egress = find(objects, 'NetworkPolicy', 'workpartner-user-egress').spec.egress;
  assert.deepEqual(egress[1].ports, [{ protocol: 'TCP', port: 4090 }, { protocol: 'TCP', port: 4091 }]);
  assert.deepEqual(egress[2].ports, [{ protocol: 'TCP', port: 443 }]);
  assert.deepEqual(egress[2].to[0].podSelector.matchLabels, { 'workpartner/role': 'model-egress', 'example.com/component': 'model' });
  assert.equal(find(objects, 'NetworkPolicy', 'workpartner-user-ingress').spec.ingress[0].ports[0].port, 25809);
  org.model.nextBaseUrl = '';
  org.model.baseUrl = 'http://fallback-model/v1';
  assert.equal(find(renderManifests(org).objects, 'Service', 'fallback-model').spec.ports[0].port, 80);
});

test('ClusterIP entry keeps headless gateway DNS and does not publish host ports or the internal port', () => {
  const org = fixture();
  org.runtime.k8s.deploy.entry = { mode: 'clusterIP', clusterIP: '192.0.2.20' };
  const objects = renderManifests(org).objects;
  const container = find(objects, 'Deployment').spec.template.spec.containers[0];
  assert.ok(container.ports.every(port => port.hostPort === undefined && port.hostIP === undefined));
  assert.equal(find(objects, 'Service', 'workpartner-gateway').spec.clusterIP, 'None');
  assert.deepEqual(find(objects, 'Service', 'workpartner-gateway-entry').spec, {
    type: 'ClusterIP', clusterIP: '192.0.2.20', selector: gatewayLabels,
    ports: [{ name: 'gateway', protocol: 'TCP', port: 3090, targetPort: 3090 }],
  });
  assert.ok(objects.filter(item => item.kind === 'Service').every(item => !['NodePort', 'LoadBalancer'].includes(item.spec.type)));
});

test('default deny covers jobs as well as users, and egress opens only scoped DNS, services and public IPv4', () => {
  const org = fixture();
  org.runtime.k8s.deploy.egressExceptCidrs.push('192.0.2.10/32', '10.0.0.0/8');
  const objects = renderManifests(org).objects;
  assert.deepEqual(find(objects, 'NetworkPolicy', 'workpartner-default-deny').spec, {
    podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [],
  });
  const policy = find(objects, 'NetworkPolicy', 'workpartner-user-egress');
  assert.equal(policy.metadata.namespace, 'fixture-users');
  assert.deepEqual(policy.spec.podSelector.matchLabels, userLabels);
  assert.deepEqual(policy.spec.policyTypes, ['Egress']);
  assert.deepEqual(policy.spec.egress, [
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
      ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
    },
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'fixture-system' } },
        podSelector: { matchLabels: gatewayLabels } }],
      ports: [{ protocol: 'TCP', port: 3090 }, { protocol: 'TCP', port: 3091 }],
    },
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'fixture-system' } },
        podSelector: { matchLabels: modelLabels } }],
      ports: [{ protocol: 'TCP', port: 4000 }],
    },
    { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12',
      '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '192.0.2.10/32', '192.0.2.11/32'] } }] },
  ]);
  for (const item of objects.filter(item => item.kind === 'NetworkPolicy' && item.metadata.name !== 'workpartner-default-deny')) {
    assert.notEqual(item.spec.podSelector.matchLabels['workpartner/role'], 'job');
  }
});

test('ingress admits only the gateway to users and only users or the gateway to model egress', () => {
  const objects = renderManifests(fixture()).objects;
  const gatewayPeer = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'fixture-system' } },
    podSelector: { matchLabels: gatewayLabels } };
  const policy = find(objects, 'NetworkPolicy', 'workpartner-user-ingress');
  assert.deepEqual(policy.spec, {
    podSelector: { matchLabels: userLabels }, policyTypes: ['Ingress'],
    ingress: [{ from: [gatewayPeer], ports: [{ protocol: 'TCP', port: 25808 }, { protocol: 'TCP', port: 3092 }] }],
  });
  const model = find(objects, 'NetworkPolicy', 'workpartner-model-ingress');
  assert.equal(model.metadata.namespace, 'fixture-system');
  assert.deepEqual(model.spec, {
    podSelector: { matchLabels: modelLabels }, policyTypes: ['Ingress'],
    ingress: [{ from: [
      { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'fixture-users' } }, podSelector: { matchLabels: userLabels } },
      gatewayPeer,
    ], ports: [{ protocol: 'TCP', port: 4000 }] }],
  });
});

test('storage retains user data and waits for scheduling; the named image registry starts empty', () => {
  const org = fixture();
  org.runtime.k8s.imageConfigMap = 'fixture-images';
  const objects = renderManifests(org).objects;
  const storage = find(objects, 'StorageClass');
  assert.equal(storage.metadata.name, 'fixture-local');
  assert.equal(storage.provisioner, 'example.com/local-path');
  assert.deepEqual(storage.parameters, { nodePath: '/srv/workpartner/new-data' });
  assert.equal(storage.reclaimPolicy, 'Retain');
  assert.equal(storage.volumeBindingMode, 'WaitForFirstConsumer');
  assert.equal(storage.metadata.namespace, undefined);
  const images = find(objects, 'ConfigMap');
  assert.equal(images.metadata.name, 'fixture-images');
  assert.equal(images.metadata.namespace, 'fixture-system');
  assert.deepEqual(images.data, { 'images.json': '{}' });
  assert.deepEqual(find(objects, 'Role', 'workpartner-system').rules[1].resourceNames, ['fixture-images']);
});

test('template values are encoded as data and unrelated configuration or secret references are never copied', () => {
  const org = fixture();
  org.identity.appId = 'must-not-appear';
  org.identity.appSecretFile = '/secure/unreadable/credential-file';
  org.runtime.k8s.deploy.hostPaths.organization = '/srv/workpartner/quoted-"-{{missing}}';
  org.runtime.k8s.deploy.newUserStorage.parameters.note = 'a "quoted" value\n---\n{{notATemplate}}';
  const objects = renderManifests(org).objects;
  const text = JSON.stringify(objects);
  assert.ok(!text.includes('must-not-appear'));
  assert.ok(!text.includes('credential-file'));
  assert.ok(!text.includes('workspace.example.com'));
  assert.equal(find(objects, 'StorageClass').parameters.note, org.runtime.k8s.deploy.newUserStorage.parameters.note);
  assert.equal(find(objects, 'Deployment').spec.template.spec.volumes[0].hostPath.path,
    org.runtime.k8s.deploy.hostPaths.organization);
});

test('invalid or unsafe settings fail before producing manifests', async t => {
  const cases = [
    ['gateway hosts disagree', org => { org.runtime.internalOrigin = 'http://different-gateway:3091'; }, /hostnames must match/],
    ['gateway port disagrees', org => { org.runtime.gatewayOrigin = 'http://workpartner-gateway:4080'; }, /port must equal/],
    ['origin has a path', org => { org.runtime.gatewayOrigin += '/path'; }, /must be an origin/],
    ['origin uses an external hostname', org => { org.runtime.gatewayOrigin = 'https://gateway.example.com'; }, /short Service hostname/],
    ['model has credentials', org => { org.model.baseUrl = 'http://secret-marker@model-egress:4000/v1'; }, /model.baseUrl/],
    ['model collides with gateway', org => { org.model.baseUrl = 'http://workpartner-gateway:4000'; }, /must differ/],
    ['shared namespace', org => { org.runtime.k8s.namespace = 'fixture-system'; }, /must differ/],
    ['Docker organization', org => { org.runtime.kind = 'docker'; }, /must be k8s/],
    ['invalid namespace', org => { org.runtime.k8s.namespace = '../outside'; }, /runtime.k8s.namespace/],
    ['empty model selector', org => { org.runtime.k8s.deploy.modelEgressSelector = {}; }, /modelEgressSelector/],
    ['invalid label key', org => { org.runtime.k8s.deploy.modelEgressSelector = { 'invalid/key/extra': 'model' }; }, /modelEgressSelector/],
    ['unconstrained gateway placement', org => { org.runtime.k8s.deploy.gatewayNodeSelector = {}; }, /gatewayNodeSelector/],
    ['invalid excluded IP', org => { org.runtime.k8s.deploy.egressExceptCidrs = ['192.0.2.999/32']; }, /egressExceptCidrs/],
    ['noncanonical CIDR', org => { org.runtime.k8s.deploy.egressExceptCidrs = ['192.0.2.1/24']; }, /egressExceptCidrs/],
    ['wrong address family', org => { org.runtime.k8s.deploy.egressExceptCidrs = ['::1/128']; }, /egressExceptCidrs/],
    ['public host port', org => { org.runtime.k8s.deploy.entry.hostIP = '192.0.2.10'; }, /IPv4 loopback/],
    ['invalid port', org => { org.runtime.k8s.deploy.entry.hostPort = 65536; }, /entry.hostPort/],
    ['unknown entry', org => { org.runtime.k8s.deploy.entry.mode = 'NodePort'; }, /entry.mode/],
    ['invalid ClusterIP', org => { org.runtime.k8s.deploy.entry = { mode: 'clusterIP', clusterIP: 'invalid' }; }, /entry.clusterIP/],
    ['relative host path', org => { org.runtime.k8s.deploy.hostPaths.secure = 'relative'; }, /hostPaths.secure/],
    ['nonstring storage parameter', org => { org.runtime.k8s.deploy.newUserStorage.parameters = { size: 20 }; }, /newUserStorage.parameters/],
    ['gateway Secret is not a list', org => { org.runtime.k8s.deploy.gatewayEnvFrom = 'gateway-data-tools'; }, /gatewayEnvFrom/],
    ['invalid gateway Secret name', org => { org.runtime.k8s.deploy.gatewayEnvFrom = ['Gateway_Data']; }, /gatewayEnvFrom/],
    ['repeated gateway Secret', org => { org.runtime.k8s.deploy.gatewayEnvFrom = ['data', 'data']; }, /gatewayEnvFrom/],
    ['missing isolation policy', org => { org.runtime.k8s.requiredPolicies = ['custom-policy']; }, /requiredPolicies/],
  ];
  for (const [name, edit, pattern] of cases) await t.test(name, () => {
    const org = fixture();
    edit(org);
    assert.throws(() => renderManifests(org), error => {
      assert.match(error.message, pattern);
      assert.ok(!error.message.includes('secret-marker'));
      return true;
    });
  });
});

test('entry-specific missing values are reported together', () => {
  const org = fixture();
  org.runtime.k8s.deploy.entry = { mode: 'hostPort' };
  assert.throws(() => renderManifests(org), /entry.hostIP, runtime.k8s.deploy.entry.hostPort/);
  org.runtime.k8s.deploy.entry = { mode: 'clusterIP' };
  assert.throws(() => renderManifests(org), /entry.clusterIP/);
});

test('--only selects Kubernetes kinds and rejects unknown kinds', () => {
  const org = fixture();
  const all = renderManifests(org).objects;
  assert.deepEqual(renderManifests(org, { only: 'NetworkPolicy' }).objects, all.filter(item => item.kind === 'NetworkPolicy'));
  assert.deepEqual(renderManifests(org, { only: ['service,namespace'] }).objects, all.filter(item => ['Service', 'Namespace'].includes(item.kind)));
  assert.throws(() => renderManifests(org, { only: 'Secret' }), /--only/);
});

test('CLI loads defaults plus overrides, writes stdout or a directory, and works outside the repository', t => {
  const directory = temporary(t);
  const org = fixture();
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify({ model: org.model, runtime: org.runtime }));
  const stdout = cli(['--org', directory], { cwd: directory });
  assert.equal(stdout.status, 0, stdout.stderr);
  assert.equal(stdout.stderr, '');
  assert.deepEqual(documents(stdout.stdout), renderManifests(org).objects);
  const output = path.join(directory, 'rendered');
  const saved = cli(['--org', directory, '--output', output]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.stdout, '');
  const files = fs.readdirSync(output).sort();
  assert.equal(files.length, 18);
  assert.ok(files.every(file => file.endsWith('.yaml')));
  const contents = files.map(file => fs.readFileSync(path.join(output, file), 'utf8'));
  assert.deepEqual(contents.map(JSON.parse).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    renderManifests(org).objects.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const repeated = cli(['--org', directory, '--output', output]);
  assert.equal(repeated.status, 1);
  assert.equal(repeated.stdout, '');
  assert.match(repeated.stderr, /not empty.*choose an empty directory/);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(output, file), 'utf8')), contents);
  const filtered = cli(['--only', 'service', '--only', 'namespace'], {
    env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: directory },
  });
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(documents(filtered.stdout), renderManifests(org, { only: ['Service', 'Namespace'] }).objects);
});

test('CLI validates before writing and never echoes malformed configuration content', t => {
  const directory = temporary(t);
  const output = path.join(directory, 'rendered');
  fs.writeFileSync(path.join(directory, 'organization.json'), '{}');
  const result = cli(['--org', directory, '--output', output]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Missing required configuration/);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(path.join(directory, 'organization.json'), '{"secret-marker": not-json}');
  const malformed = cli(['--org', directory]);
  assert.equal(malformed.status, 1);
  assert.ok(!malformed.stderr.includes('secret-marker'));
  assert.equal(malformed.stdout, '');
  for (const args of [['--unknown'], ['--output'], ['--only', '--org', directory]]) {
    const bad = cli(args);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
  }
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});

test('model selectors reject every gateway-label subset and require the model-egress role', () => {
  for (const selector of [partOf, { 'workpartner/role': 'gateway' }, gatewayLabels]) {
    const org = fixture();
    org.runtime.k8s.deploy.modelEgressSelector = selector;
    assert.throws(() => renderManifests(org), error => {
      assert.match(error.message, /must not select gateway Pods/);
      assert.match(error.message, /must include workpartner\/role: model-egress/);
      return true;
    });
  }
  for (const selector of [{}, { 'example.com/component': 'model' }, userLabels]) {
    const org = fixture();
    org.runtime.k8s.deploy.modelEgressSelector = selector;
    assert.throws(() => renderManifests(org), /must include workpartner\/role: model-egress/);
  }
  const org = fixture();
  org.runtime.k8s.deploy.modelEgressSelector = { 'workpartner/role': 'model-egress' };
  const objects = renderManifests(org).objects;
  assert.deepEqual(find(objects, 'Service', 'model-egress').spec.selector, { 'workpartner/role': 'model-egress' });
  assert.deepEqual(find(objects, 'NetworkPolicy', 'workpartner-model-ingress').spec.podSelector.matchLabels,
    { 'workpartner/role': 'model-egress' });
});

test('model baseUrl is mandatory and nextBaseUrl must share its hostname and effective port', () => {
  for (const next of ['http://other-model:4000/v1', 'http://model-egress:4001/v1', 'https://model-egress/v1']) {
    const org = fixture();
    org.model.nextBaseUrl = next;
    assert.throws(() => renderManifests(org), /model.baseUrl and model.nextBaseUrl \(hostnames and ports must match\)/);
  }
  const org = fixture();
  org.model.nextBaseUrl = org.model.baseUrl;
  delete org.model.baseUrl;
  assert.throws(() => renderManifests(org), /Missing required configuration: model.baseUrl/);
  org.model.baseUrl = 'http://model-egress/v1';
  org.model.nextBaseUrl = 'http://model-egress:80/next/v1';
  const objects = renderManifests(org).objects;
  assert.equal(find(objects, 'Service', 'model-egress').spec.ports[0].port, 80);
  assert.deepEqual(find(objects, 'NetworkPolicy', 'workpartner-user-egress').spec.egress[2].ports,
    [{ protocol: 'TCP', port: 80 }]);
  assert.deepEqual(find(objects, 'NetworkPolicy', 'workpartner-model-ingress').spec.ingress[0].ports,
    [{ protocol: 'TCP', port: 80 }]);
});

test('--output separates namespace and name unambiguously and omits namespace for cluster objects', t => {
  const directory = temporary(t);
  const org = fixture();
  org.runtime.k8s.namespace = 'fixture';
  org.runtime.k8s.systemNamespace = 'fixture-users';
  org.runtime.k8s.governingService = 'users-gateway';
  org.runtime.gatewayOrigin = 'http://gateway:3090';
  org.runtime.internalOrigin = 'http://gateway:3091';
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
  const output = path.join(directory, 'rendered');
  fs.mkdirSync(output);
  const result = cli(['--org', directory, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  const files = fs.readdirSync(output);
  assert.equal(files.length, renderManifests(org).objects.length);
  for (const name of ['service_fixture_users-gateway.yaml', 'service_fixture-users_gateway.yaml',
    'namespace_fixture.yaml', 'priorityclass_fixture-users-gateway.yaml']) assert.ok(files.includes(name), name);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'service_fixture_users-gateway.yaml'))).metadata.namespace, 'fixture');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'service_fixture-users_gateway.yaml'))).metadata.namespace, 'fixture-users');
});

test('duplicate output filenames fail before any files or directories are written', t => {
  const directory = temporary(t);
  const objects = renderManifests(fixture()).objects;
  objects.push(structuredClone(objects[0]));
  const output = path.join(directory, 'rendered');
  assert.throws(() => writeManifests(objects, output), /Duplicate output filename: namespace_fixture-system.yaml/);
  assert.equal(fs.existsSync(output), false);
  fs.mkdirSync(output);
  assert.throws(() => writeManifests(objects, output), /Duplicate output filename/);
  assert.deepEqual(fs.readdirSync(output), []);
});

test('--output refuses stale files, hidden files and subdirectories without deleting anything', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(fixture()));
  for (const name of ['stale.yaml', '.keep', 'nested']) {
    const output = path.join(directory, name + '-output');
    fs.mkdirSync(output);
    const existing = path.join(output, name);
    if (name === 'nested') fs.mkdirSync(existing);
    else fs.writeFileSync(existing, 'preserve this content\n');
    const result = cli(['--org', directory, '--output', output, '--only', 'Service']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not empty.*choose an empty directory/);
    assert.deepEqual(fs.readdirSync(output), [name]);
    if (name === 'nested') assert.deepEqual(fs.readdirSync(existing), []);
    else assert.equal(fs.readFileSync(existing, 'utf8'), 'preserve this content\n');
  }
  assert.match(cli(['--help']).stdout, /--output must be a new or empty directory/);
});

test('persistent files must be strict descendants of either mounted directory', () => {
  const fields = [
    ['runtime.sessionKeyFile', org => org.runtime, 'sessionKeyFile'],
    ['runtime.cookieFile', org => org.runtime, 'cookieFile'],
    ['identity.appSecretFile', org => org.identity, 'appSecretFile'],
    ['runtime.migration.ownersFile', org => (org.runtime.migration = {}), 'ownersFile'],
  ];
  for (const [field, parent, key] of fields) {
    for (const value of ['/outside/file', '/secure-other/file', '/secure/../outside/file', '/secure', '/state/.',
      '/state/../../outside/file', 'relative/file', '', undefined]) {
      const org = fixture();
      parent(org)[key] = value;
      assert.throws(() => renderManifests(org), error => {
        assert.ok(error.message.includes(field), field);
        assert.match(error.message, /must be below runtime.secureDirectory or runtime.stateDirectory/);
        return true;
      });
    }
    for (const value of ['/secure/nested/file', '/state/nested/file', '/state/nested/../file']) {
      const org = fixture();
      parent(org)[key] = value;
      assert.doesNotThrow(() => renderManifests(org));
    }
  }
});

test('missing deployment settings and all invalid persistent files are reported in one failure', t => {
  const org = fixture();
  delete org.runtime.k8s.deploy.gatewayImage;
  org.runtime.sessionKeyFile = '/outside/session.key';
  org.runtime.cookieFile = '/outside/cookies.json';
  org.identity.appSecretFile = '/outside/identity.secret';
  org.runtime.migration = {};
  const directory = temporary(t);
  const output = path.join(directory, 'rendered');
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
  const result = cli(['--org', directory, '--output', output]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(output), false);
  assert.match(result.stderr, /Missing required configuration:/);
  assert.match(result.stderr, /Invalid configuration:/);
  for (const field of ['runtime.k8s.deploy.gatewayImage', 'runtime.sessionKeyFile', 'runtime.cookieFile',
    'identity.appSecretFile', 'runtime.migration.ownersFile']) assert.ok(result.stderr.includes(field), field);
});

test('rendering returns warnings without writing to stderr or stdout and does not retain them across calls', t => {
  const org = fixture();
  const before = structuredClone(org);
  const writes = [];
  const stderr = t.mock.method(process.stderr, 'write', chunk => { writes.push(chunk); return true; });
  const stdout = t.mock.method(process.stdout, 'write', chunk => { writes.push(chunk); return true; });
  let mismatch;
  let repeated;
  let aligned;
  let clusterIP;
  try {
    org.runtime.localAddress = '127.0.0.1:3081';
    mismatch = renderManifests(org, { only: 'Service' });
    repeated = renderManifests(org, { only: 'Service' });
    org.runtime.localAddress = before.runtime.localAddress;
    aligned = renderManifests(org);
    assert.deepEqual(org, before);
    org.runtime.k8s.deploy.entry = { mode: 'clusterIP', clusterIP: '192.0.2.20' };
    clusterIP = renderManifests(org);
  } finally {
    stderr.mock.restore();
    stdout.mock.restore();
  }
  assert.deepEqual(writes, []);
  assert.equal(mismatch.warnings.length, 1);
  assert.match(mismatch.warnings[0], /hostPort entry hostIP\/hostPort differs.*tunnel targets runtime.localAddress/);
  assert.equal(mismatch.objects.length, 3);
  assert.ok(mismatch.objects.every(object => object.kind === 'Service'));
  assert.deepEqual(repeated, mismatch);
  assert.deepEqual(aligned.warnings, []);
  assert.deepEqual(clusterIP.warnings, []);
  assert.equal(aligned.objects.length, 18);
  assert.equal(clusterIP.objects.length, 19);
});

test('hostPort mismatch warnings go only to stderr and do not block rendering', t => {
  const directory = temporary(t);
  for (const localAddress of ['127.0.0.1:3081', '127.0.0.2:3080', '127.0.0.1:3080']) {
    const org = fixture();
    org.runtime.localAddress = localAddress;
    fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
    const result = cli(['--org', directory]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(documents(result.stdout).length, 18);
    if (localAddress === '127.0.0.1:3080') assert.equal(result.stderr, '');
    else assert.match(result.stderr, /Warning: hostPort entry hostIP\/hostPort differs.*tunnel targets runtime.localAddress/);
  }
  const org = fixture();
  org.runtime.k8s.deploy.entry = { mode: 'clusterIP', clusterIP: '192.0.2.20' };
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
  const result = cli(['--org', directory]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(documents(result.stdout).length, 19);
});

test('gateway security context restricts privileges while preserving image user and volume ownership', () => {
  const pod = find(renderManifests(fixture()).objects, 'Deployment').spec.template.spec;
  assert.deepEqual(pod.containers[0].securityContext, {
    allowPrivilegeEscalation: false, seccompProfile: { type: 'RuntimeDefault' }, capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] },
  });
  assert.equal(pod.securityContext, undefined);
  assert.equal(pod.containers[0].securityContext.runAsUser, undefined);
  assert.equal(pod.initContainers, undefined);
});

test('gateway resource overrides retain equal requests and limits and default omitted fields', () => {
  for (const [configured, expected] of [
    [undefined, { cpu: '500m', memory: '512Mi' }],
    [{}, { cpu: '500m', memory: '512Mi' }],
    [{ cpu: '750m' }, { cpu: '750m', memory: '512Mi' }],
    [{ memory: '1Gi' }, { cpu: '500m', memory: '1Gi' }],
    [{ cpu: '1.5', memory: '2Gi' }, { cpu: '1.5', memory: '2Gi' }],
  ]) {
    const org = fixture();
    org.runtime.k8s.gatewayResources = configured;
    const resources = find(renderManifests(org).objects, 'Deployment').spec.template.spec.containers[0].resources;
    assert.deepEqual(resources.requests, expected);
    assert.deepEqual(resources.limits, expected);
  }
  for (const configured of [null, [], '500m', { cpu: '' }, { memory: '-1Gi' }, { cpu: '0' },
    { cpu: 1 }, { cpu: null }, { memory: 'invalid' }, { memory: '1 ' }]) {
    const org = fixture();
    org.runtime.k8s.gatewayResources = configured;
    assert.throws(() => renderManifests(org), /runtime.k8s.gatewayResources/);
  }
});

function endpointFixture(address = '192.0.2.10', port = 4100) {
  const org = fixture();
  delete org.runtime.k8s.deploy.modelEgressSelector;
  org.runtime.k8s.deploy.modelEgressEndpoint = { address, port };
  org.model.nextBaseUrl = org.model.baseUrl;
  return org;
}

test('RFC1918 endpoint warnings cover exact range boundaries without changing manifests or writing stdio', t => {
  const baseline = renderManifests(endpointFixture('192.0.2.99'));
  assert.deepEqual(baseline.warnings, []);
  const writes = [];
  const stderr = t.mock.method(process.stderr, 'write', chunk => { writes.push(chunk); return true; });
  const stdout = t.mock.method(process.stdout, 'write', chunk => { writes.push(chunk); return true; });
  try {
    // Network boundaries, not deployment addresses. Include neighbors and shared address space.
    for (const [octets, warn] of [
      [[9, 255, 255, 255], false], [[10, 0, 0, 0], true],
      [[10, 255, 255, 255], true], [[11, 0, 0, 0], false],
      [[172, 15, 255, 255], false], [[172, 16, 0, 0], true],
      [[172, 31, 255, 255], true], [[172, 32, 0, 0], false],
      [[192, 167, 255, 255], false], [[192, 168, 0, 0], true],
      [[192, 168, 255, 255], true], [[192, 169, 0, 0], false],
      [[100, 64, 0, 0], false], [[100, 127, 255, 255], false],
      [[192, 0, 2, 10], false],
    ]) {
      const address = octets.join('.');
      const org = endpointFixture(address);
      const before = structuredClone(org);
      const result = renderManifests(org);
      assert.equal(result.warnings.length, warn ? 1 : 0, address);
      if (warn) {
        assert.match(result.warnings[0], /modelEgressEndpoint.address.*RFC1918.*external endpoint.*every node/);
        assert.match(result.warnings[0], /Docker bridge.*relay Pod.*modelEgressSelector/);
        assert.match(result.warnings[0], /docs\/kubernetes.md#model-egress-routing/);
      }
      assert.deepEqual(result.objects, JSON.parse(JSON.stringify(baseline.objects).replaceAll('192.0.2.99', address)));
      assert.deepEqual(renderManifests(org), result);
      assert.deepEqual(renderManifests(org, { only: 'Namespace' }).warnings, result.warnings);
      assert.deepEqual(org, before);
    }
    assert.deepEqual(renderManifests(fixture()).warnings, []);
    assert.deepEqual(renderManifests(endpointFixture()).warnings, []);
  } finally {
    stderr.mock.restore();
    stdout.mock.restore();
  }
  assert.deepEqual(writes, []);
});

test('RFC1918 endpoint CLI warning goes only to stderr for stdout and file output', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(endpointFixture('192.0.2.99')));
  const baseline = cli(['--org', directory]);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.stderr, '');
  for (const octets of [[10, 0, 0, 1], [172, 16, 0, 1], [192, 168, 0, 1]]) {
    const address = octets.join('.');
    const org = endpointFixture(address);
    const { objects, warnings } = renderManifests(org);
    fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
    const result = cli(['--org', directory]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, `Warning: ${warnings[0]}\n`);
    assert.equal(result.stdout, baseline.stdout.replaceAll('192.0.2.99', address));
    const output = path.join(directory, `output-${octets[0]}`);
    const filtered = cli(['--org', directory, '--only', 'EndpointSlice', '--output', output]);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.equal(filtered.stderr, result.stderr);
    assert.equal(filtered.stdout, '');
    const files = fs.readdirSync(output);
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(output, files[0]), 'utf8'),
      JSON.stringify(find(objects, 'EndpointSlice'), null, 2) + '\n');
  }
});

test('fixed model endpoint renders a selector-less Service, matching EndpointSlice and precise TCP egress', () => {
  const org = endpointFixture();
  const before = structuredClone(org);
  const objects = renderManifests(org).objects;
  assert.deepEqual(org, before);
  assert.deepEqual(renderManifests(org).objects, objects);
  const service = find(objects, 'Service', 'model-egress');
  assert.equal(service.metadata.namespace, 'fixture-system');
  assert.ok(!Object.hasOwn(service.spec, 'selector'));
  assert.deepEqual(service.spec, {
    type: 'ClusterIP', ports: [{ name: 'model', protocol: 'TCP', port: 4000, targetPort: 4100 }],
  });
  const slice = find(objects, 'EndpointSlice');
  assert.equal(slice.apiVersion, 'discovery.k8s.io/v1');
  assert.equal(slice.metadata.namespace, service.metadata.namespace);
  assert.equal(slice.metadata.labels['kubernetes.io/service-name'], service.metadata.name);
  assert.equal(slice.metadata.labels['endpointslice.kubernetes.io/managed-by'], 'workpartner-render');
  assert.equal(slice.addressType, 'IPv4');
  assert.deepEqual(slice.ports, [{ name: 'model', protocol: 'TCP', port: 4100 }]);
  assert.deepEqual(slice.endpoints, [{ addresses: ['192.0.2.10'], conditions: { ready: true } }]);
  const policy = find(objects, 'NetworkPolicy', 'workpartner-user-egress');
  assert.equal(policy.metadata.namespace, 'fixture-users');
  assert.deepEqual(policy.spec.egress[2], {
    to: [{ ipBlock: { cidr: '192.0.2.10/32' } }], ports: [{ protocol: 'TCP', port: 4100 }],
  });
  const original = find(renderManifests(fixture()).objects, 'NetworkPolicy', 'workpartner-user-egress');
  assert.deepEqual(policy.spec.egress.filter((_, i) => i !== 2), original.spec.egress.filter((_, i) => i !== 2));
  assert.ok(!objects.some(object => object.metadata.name === 'workpartner-model-ingress'));
  assert.deepEqual(renderManifests(org, { only: 'endpointslice' }).objects, [slice]);
  assert.deepEqual(renderManifests(fixture(), { only: 'EndpointSlice' }).objects, []);
});

test('fixed model endpoint permits only its TCP port inside an otherwise excluded private range', () => {
  const baseline = find(renderManifests(fixture()).objects, 'NetworkPolicy', 'workpartner-user-egress').spec.egress;
  // Derive representative addresses from policy ranges rather than deployment addresses.
  for (const cidr of baseline[3].to[0].ipBlock.except.filter(value => /^(10\.|172\.|192\.168\.|100\.)/.test(value))) {
    const address = cidr.split('/')[0].replace(/0$/, '1');
    const policy = find(renderManifests(endpointFixture(address)).objects, 'NetworkPolicy', 'workpartner-user-egress');
    const expected = structuredClone(baseline);
    expected[2] = { to: [{ ipBlock: { cidr: `${address}/32` } }], ports: [{ protocol: 'TCP', port: 4100 }] };
    assert.deepEqual(policy.spec.egress, expected);
    assert.ok(policy.spec.egress[3].to[0].ipBlock.except.includes(cidr));
  }
});

test('model egress requires exactly one selector or endpoint, including with --only', () => {
  const both = endpointFixture();
  both.runtime.k8s.deploy.modelEgressSelector = modelLabels;
  const neither = fixture();
  delete neither.runtime.k8s.deploy.modelEgressSelector;
  for (const [org, prefix] of [[both, 'Invalid'], [neither, 'Missing required']]) {
    assert.throws(() => renderManifests(org, { only: 'Namespace' }), error => {
      assert.match(error.message, new RegExp(`${prefix} configuration:`));
      assert.match(error.message, /modelEgressSelector.*modelEgressEndpoint.*exactly one required/);
      return true;
    });
  }
});

test('fixed model endpoint rejects invalid addresses, shapes and ports before rendering', () => {
  for (const address of [undefined, null, 123, {}, '', 'example.com', '192.0.2.1:4100', 'http://192.0.2.1',
    '192.0.2.1/32', '192.0.2.256', '192.000.2.1', ' 192.0.2.1', '::1', '::ffff:192.0.2.1',
    '0.0.0.0', '127.0.0.1', '127.255.255.255', '169.254.0.1', '169.254.169.254', '169.254.255.255']) {
    assert.throws(() => renderManifests(endpointFixture(address === undefined ? '' : address)), /Invalid configuration:.*modelEgressEndpoint.address/);
  }
  for (const port of [null, '4100', 0, -1, 65536, 1.5]) {
    assert.throws(() => renderManifests(endpointFixture('192.0.2.10', port)), /Invalid configuration:.*modelEgressEndpoint.port/);
  }
  for (const endpoint of [null, [], '192.0.2.10:4100', {}, { address: '192.0.2.10' }, { port: 4100 }]) {
    const org = endpointFixture();
    org.runtime.k8s.deploy.modelEgressEndpoint = endpoint;
    assert.throws(() => renderManifests(org), /Invalid configuration:.*modelEgressEndpoint/);
  }
  for (const port of [1, 65535]) assert.doesNotThrow(() => renderManifests(endpointFixture('192.0.2.10', port)));
});

test('fixed model endpoint retains baseUrl/nextBaseUrl hostname and port validation', () => {
  for (const url of ['http://other-model:4000/v1', 'http://model-egress:4001/v1']) {
    const org = endpointFixture();
    org.model.nextBaseUrl = url;
    assert.throws(() => renderManifests(org), /model.baseUrl and model.nextBaseUrl \(hostnames and ports must match\)/);
  }
});

test('organization-only deployment resolves all hosts and CLI writes its EndpointSlice', async t => {
  const directory = temporary(t);
  const org = endpointFixture();
  Object.assign(org, { previewHost: 'preview.example.com', legacyHosts: ['old.example.com'], projectHost: 'project.example.com' });
  fs.writeFileSync(path.join(directory, 'organization.json'), JSON.stringify(org));
  const result = cli(['--org', directory]);
  assert.equal(result.status, 0, result.stderr);
  const objects = documents(result.stdout);
  const pod = find(objects, 'Deployment').spec.template.spec;
  assert.deepEqual(pod.containers[0].env, [{ name: 'WORKPARTNER_ORG_DIR', value: '/organization' }]);
  assert.ok(pod.containers[0].volumeMounts.some(mount => mount.mountPath === '/organization' && mount.readOnly));
  const { resolveOrganization } = await import('../gateway/organization/resolve.mjs');
  const server = resolveOrganization({ WORKPARTNER_ORG_DIR: directory }).server;
  assert.equal(server.previewHost, org.previewHost);
  assert.deepEqual(server.legacyHosts, org.legacyHosts);
  assert.equal(server.projectHost, org.projectHost);
  const output = path.join(directory, 'output');
  const filtered = cli(['--org', directory, '--only', 'EndpointSlice', '--output', output]);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(fs.readdirSync(output), ['endpointslice_fixture-system_model-egress.yaml']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, fs.readdirSync(output)[0]), 'utf8')), find(objects, 'EndpointSlice'));
});
