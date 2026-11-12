import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createK8sRuntime } from '../gateway/runtime/k8s.mjs';
import { createRuntime, createLegacyRuntime } from '../gateway/runtime/index.mjs';

const core = '/api/v1/namespaces/users';
const apps = '/apis/apps/v1/namespaces/users/statefulsets';
const stsPath = `${apps}/fixture-person`;
const podPath = `${core}/pods/fixture-person-0`;
const registry = '/api/v1/namespaces/system/configmaps/workpartner-images';
const policy = name => `/apis/networking.k8s.io/v1/namespaces/users/networkpolicies/${name}`;
const defaults = { namespace: 'users', storageClass: 'local-data', containerPrefix: 'fixture-', image: 'workspace:test' };
const clone = value => structuredClone(value);
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key] ??= {}, value);
    else target[key] = clone(value);
  }
}
function fakeClient() {
  const objects = new Map(), calls = [], pending = new Map();
  let sequence = 0;
  objects.set(registry, { data: { 'images.json': JSON.stringify({ 'workspace:test': 'sha256:fixture' }) } });
  for (const name of ['workpartner-default-deny', 'workpartner-user-egress', 'workpartner-user-ingress']) objects.set(policy(name), { metadata: { name } });
  function reconcile() {
    for (const [route, remaining] of pending) {
      if (remaining > 1) pending.set(route, remaining - 1);
      else { objects.delete(route); pending.delete(route); }
    }
    const sts = objects.get(stsPath);
    if (sts?.spec.replicas === 1 && !sts.metadata.deletionTimestamp && !objects.has(podPath)) {
      objects.set(podPath, { metadata: { name: 'fixture-person-0', uid: `pod-${++sequence}`, labels: sts.spec.template.metadata.labels },
        status: { phase: 'Running', podIP: '192.0.2.10', containerStatuses: [{ name: 'workspace', state: { running: {} } }] } });
    }
    for (const [route, pod] of objects) {
      if (route.startsWith(`${core}/pods/`) && pod.metadata.labels?.['workpartner/role'] === 'job' && !pod.metadata.deletionTimestamp) {
        pod.status = { phase: 'Succeeded', containerStatuses: [{ name: 'workspace', state: { terminated: { exitCode: 3 } } }] };
      }
    }
  }
  const c = { namespace: 'system', objects, calls, pending, onTick: undefined,
    async get(route) {
      calls.push(['get', route]);
      if (route.startsWith(`${core}/pods?`)) {
        const selector = new URLSearchParams(route.split('?')[1]).get('labelSelector');
        const [key, value] = selector.split('=');
        return { items: [...objects.entries()].filter(([p, o]) => p.startsWith(`${core}/pods/`) && o.metadata.labels?.[key] === value).map(([, o]) => clone(o)) };
      }
      return clone(objects.get(route) ?? null);
    },
    async create(route, object) {
      calls.push(['create', route, clone(object)]);
      const key = `${route}/${object.metadata.name}`;
      if (objects.has(key)) throw Object.assign(new Error('Already exists'), { status: 409, reason: 'AlreadyExists' });
      objects.set(key, clone(object));
      return clone(object);
    },
    async patch(route, body, type) {
      calls.push(['patch', route, clone(body), type]);
      assert.equal(type, 'merge');
      if (!objects.has(route)) throw Object.assign(new Error('Not found'), { status: 404 });
      merge(objects.get(route), body);
      if (route === stsPath && body.spec?.replicas === 0 && objects.has(podPath)) await c.remove(podPath, { gracePeriodSeconds: 10 });
      reconcile();
      return clone(objects.get(route));
    },
    async remove(route, options) {
      calls.push(['remove', route, clone(options)]);
      const object = objects.get(route);
      if (!object) return false;
      object.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
      pending.set(route, 3);
      if (route === stsPath && objects.has(podPath)) await c.remove(podPath, options);
      return true;
    },
    async waitFor(fn, options) {
      calls.push(['waitFor', options]);
      for (let i = 0; i < 20; i++) {
        if (await fn()) return true;
        reconcile();
        await c.onTick?.(i);
        await setImmediate();
      }
      throw Object.assign(new Error('Timed out'), { reason: 'Timeout', status: 0 });
    },
    async logs(...args) { calls.push(['logs', ...args]); return 'new password: fixture\n'; },
  };
  return c;
}
function fixture(t, options = {}) {
  const secureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-k8s-'));
  t.after(() => fs.rmSync(secureDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(secureDir, 'model-person.key'), 'fixture-key\n');
  const client = fakeClient();
  const runtime = createK8sRuntime({ ...defaults, secureDir, client, ...options });
  return { runtime, client, secureDir };
}
const writes = c => c.calls.filter(([method]) => ['create', 'patch', 'remove'].includes(method));

test('organization userImages selects registered images per user without changing other workspace settings', async t => {
  const { client, secureDir } = fixture(t);
  client.objects.set(registry, { data: { 'images.json': JSON.stringify({
    'workspace:test': 'sha256:fixture', 'workspace:pilot': 'sha256:pilot',
  }) } });
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    secureDirectory: secureDir, k8s: { namespace: 'users', storageClass: 'local-data',
      newUserNodeSelector: { pool: 'workers' }, userImages: { person: 'workspace:pilot' } } } };
  const runtime = createRuntime(organization, { client });
  await runtime.create({ slug: 'person' });
  const pilot = clone(client.objects.get(stsPath));
  assert.equal(pilot.spec.template.spec.containers[0].image, 'workspace:pilot');
  assert.equal(pilot.spec.template.spec.initContainers[0].image, 'workspace:pilot');
  assert.equal(pilot.metadata.annotations['workpartner/image-id'], 'sha256:pilot');

  fs.writeFileSync(path.join(secureDir, 'model-other.key'), 'fixture-key');
  await runtime.create({ slug: 'other' });
  const otherPath = `${apps}/fixture-other`;
  const other = clone(client.objects.get(otherPath));
  assert.equal(other.spec.template.spec.containers[0].image, 'workspace:test');
  assert.equal(other.spec.template.spec.initContainers[0].image, 'workspace:test');
  assert.equal(other.metadata.annotations['workpartner/image-id'], 'sha256:fixture');

  delete organization.runtime.k8s.userImages.person;
  await runtime.create({ slug: 'person' });
  const restored = client.objects.get(stsPath);
  assert.equal(restored.spec.template.spec.containers[0].image, 'workspace:test');
  assert.equal(restored.metadata.annotations['workpartner/image-id'], 'sha256:fixture');
  const expectedPod = clone(pilot.spec.template.spec);
  expectedPod.containers[0].image = expectedPod.initContainers[0].image = 'workspace:test';
  assert.deepEqual(restored.spec.template.spec, expectedPod);
  for (const userImages of [{}, undefined]) {
    organization.runtime.k8s.userImages = userImages;
    await createRuntime(organization, { client }).create({ slug: 'other' });
    assert.deepEqual(client.objects.get(otherPath), other);
  }
});

test('create rejects an unregistered per-user image even when nextImage is registered', async t => {
  const { runtime, client } = fixture(t, { userImages: { person: 'workspace:unregistered' } });
  await assert.rejects(runtime.create({ slug: 'person' }), /Runtime image is not registered/);
  assert.deepEqual(writes(client), []);
});

test('shared skills use a read-only PVC without adding hostPath access to personal Pods or jobs', async t => {
  const { client, secureDir } = fixture(t);
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    secureDirectory: secureDir, k8s: { namespace: 'users', storageClass: 'local-data', sharedSkillsClaim: 'reviewed-library' } },
    model: { keyPrefix: 'model-' }, features: { marketSkills: true },
    market: { containerDirectory: '/opt/reviewed', preinstalled: ['meeting-notes'] } };
  const runtime = createRuntime(organization, { client });
  await runtime.create({ slug: 'person' });
  const pod = client.objects.get(stsPath).spec.template.spec;
  assert.deepEqual(pod.volumes.find(volume => volume.name === 'shared-skills'),
    { name: 'shared-skills', persistentVolumeClaim: { claimName: 'reviewed-library', readOnly: true } });
  assert.deepEqual(pod.containers[0].volumeMounts.find(mount => mount.name === 'shared-skills'),
    { name: 'shared-skills', mountPath: '/opt/reviewed', readOnly: true });
  assert.equal(pod.volumes.some(volume => volume.hostPath), false);
  const env = Object.fromEntries(pod.containers[0].env.map(({ name, value }) => [name, value]));
  assert.equal(env.WORKPARTNER_SHARED_SKILLS, '/opt/reviewed');
  assert.deepEqual(JSON.parse(env.WORKPARTNER_MARKET_PREINSTALLED), ['meeting-notes']);
  await runtime.runOnce('person');
  const job = client.calls.find(([method, route]) => method === 'create' && route === `${core}/pods`)[2].spec;
  assert.equal(job.volumes.some(volume => volume.name === 'shared-skills'), false);
});

test('user and job Pods set ndots only when explicitly configured', async t => {
  for (const dnsNdots of [undefined, 1, 4, 15]) await t.test(String(dnsNdots), async t => {
    const { runtime, client } = fixture(t, { dnsNdots, clusterDomain: 'cluster.invalid' });
    await runtime.create({ slug: 'person' });
    await runtime.runOnce('person');
    const user = client.objects.get(stsPath).spec.template.spec;
    const job = client.calls.find(([method, route]) => method === 'create' && route === `${core}/pods`)[2].spec;
    for (const pod of [user, job]) {
      assert.deepEqual(pod.dnsConfig.searches, ['system.svc.cluster.invalid']);
      if (dnsNdots === undefined) {
        assert.equal(Object.hasOwn(pod.dnsConfig, 'options'), false);
        assert.equal(JSON.stringify(pod.dnsConfig), '{"searches":["system.svc.cluster.invalid"]}');
      } else {
        assert.deepEqual(pod.dnsConfig.options, [{ name: 'ndots', value: String(dnsNdots) }]);
      }
    }
  });
});

test('create builds the complete StatefulSet, PVC and Secret contract', async t => {
  const { runtime, client } = fixture(t, { systemNamespace: 'control', clusterDomain: 'example.test',
    userLabel: 'example.test/user', modelBaseEnvironment: 'CUSTOM_BASE', modelBaseUrl: 'https://model.example.test/v1',
    modelKeyFile: '/etc/workspace/key', uid: 1002, memory: 4294967296, nanoCpus: 1500000000,
    memoryRequest: '768Mi', cpuRequest: '200m', dataVolumeSize: '30Gi', publishedDirectory: '/run/published',
    newUserNodeSelector: { 'example.test/pool': 'workers' }, userPriorityClass: 'users-priority', terminationGraceSeconds: 17,
    governingService: 'users-service', imageConfigMap: 'images' });
  client.objects.set('/api/v1/namespaces/control/configmaps/images', client.objects.get(registry));
  client.objects.set(`${core}/persistentvolumeclaims/fixture-person-oldwork`, { metadata: { name: 'fixture-person-oldwork' } });
  await runtime.create({ slug: 'person', name: 'Fixture' }, { modelConfig: '{"defaults":{}}' });
  const sts = client.objects.get(stsPath), pod = sts.spec.template.spec, container = pod.containers[0];
  const labels = { 'app.kubernetes.io/part-of': 'workpartner', 'workpartner/role': 'user', 'example.test/user': 'person' };
  assert.equal(sts.apiVersion, 'apps/v1');
  assert.equal(sts.kind, 'StatefulSet');
  assert.deepEqual(sts.metadata, { name: 'fixture-person', labels, annotations: { 'workpartner/image-id': 'sha256:fixture' } });
  assert.equal(sts.spec.replicas, 0);
  assert.equal(sts.spec.serviceName, 'users-service');
  assert.deepEqual(sts.spec.updateStrategy, { type: 'OnDelete' });
  assert.deepEqual(sts.spec.selector, { matchLabels: labels });
  assert.deepEqual(sts.spec.template.metadata.labels, labels);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.restartPolicy, 'Always');
  assert.equal(pod.terminationGracePeriodSeconds, 17);
  assert.equal(pod.priorityClassName, 'users-priority');
  assert.deepEqual(pod.nodeSelector, { 'example.test/pool': 'workers' });
  assert.deepEqual(pod.dnsConfig, { searches: ['control.svc.example.test'] });
  assert.deepEqual(container.securityContext, { runAsUser: 1002, runAsGroup: 1002, runAsNonRoot: true,
    allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } });
  assert.equal(container.imagePullPolicy, 'Never');
  assert.equal(container.image, 'workspace:test');
  assert.deepEqual(container.resources, { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } });
  assert.deepEqual(container.env, [{ name: 'CUSTOM_BASE', value: 'https://model.example.test/v1' }, { name: 'PARTNER_USER_NAME', value: 'Fixture' },
    { name: 'WORKPARTNER_MODEL_CONFIG', value: '{"defaults":{}}' }, { name: 'WORKPARTNER_PUBLISHED_DIR', value: '/run/published' }]);
  assert.deepEqual(container.volumeMounts, [{ name: 'data', mountPath: '/data' },
    { name: 'model-key', mountPath: '/etc/workspace/key', subPath: 'model.key', readOnly: true },
    { name: 'published', mountPath: '/run/published', readOnly: true }, { name: 'oldwork', mountPath: '/data/old-work', readOnly: true }]);
  assert.deepEqual(pod.volumes, [{ name: 'data', persistentVolumeClaim: { claimName: 'fixture-person-data' } },
    { name: 'model-key', secret: { secretName: 'fixture-person-model-key', defaultMode: 0o444 } },
    { name: 'published', secret: { secretName: 'fixture-person-published', defaultMode: 0o444 } },
    { name: 'oldwork', persistentVolumeClaim: { claimName: 'fixture-person-oldwork', readOnly: true } }]);
  assert.deepEqual(pod.initContainers, [{ name: 'fix-owner', image: 'workspace:test', imagePullPolicy: 'Never', command: ['chown', '1002:1002', '/data'],
    securityContext: { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false, allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'], add: ['CHOWN'] }, seccompProfile: { type: 'RuntimeDefault' } }, volumeMounts: [{ name: 'data', mountPath: '/data' }] }]);
  assert.deepEqual(client.objects.get(`${core}/persistentvolumeclaims/fixture-person-data`).spec,
    { accessModes: ['ReadWriteOnce'], storageClassName: 'local-data', resources: { requests: { storage: '30Gi' } } });
  assert.ok(Buffer.from(client.objects.get(`${core}/secrets/fixture-person-model-key`).data['model.key'], 'base64').toString() === 'fixture-key\n');
  assert.deepEqual(client.objects.get(`${core}/secrets/fixture-person-published`).data, {});
  assert.deepEqual(writes(client).map(([method, route]) => [method, route]), [
    ['create', `${core}/secrets`], ['create', `${core}/secrets`], ['create', `${core}/persistentvolumeclaims`], ['create', apps],
  ]);
});

test('create defaults, repeated updates and bound PVCs preserve existing data and published files', async t => {
  const { runtime, client, secureDir } = fixture(t, { newUserNodeSelector: { pool: 'workers' } });
  await runtime.create({ slug: 'person' });
  const sts = client.objects.get(stsPath), pod = sts.spec.template.spec;
  assert.deepEqual(pod.containers[0].resources, { requests: { memory: '512Mi', cpu: '100m' }, limits: { memory: '3221225472', cpu: '2' } });
  assert.deepEqual(pod.dnsConfig.searches, ['system.svc.cluster.local']);
  assert.equal(pod.terminationGracePeriodSeconds, 10);
  assert.equal(pod.volumes.length, 3);
  assert.deepEqual(pod.containers[0].env.map(e => e.name), ['MODEL_BASE_URL', 'PARTNER_USER_NAME', 'WORKPARTNER_PUBLISHED_DIR']);
  const pvc = client.objects.get(`${core}/persistentvolumeclaims/fixture-person-data`);
  pvc.status = { phase: 'Bound' }; pvc.spec.volumeName = 'retained-volume';
  client.objects.get(`${core}/secrets/fixture-person-published`).data = { '.zp-market-token': 'Zml4dHVyZQ==' };
  sts.metadata.annotations['workpartner/paused'] = 'true';
  await runtime.start('person');
  fs.writeFileSync(path.join(secureDir, 'model-person.key'), 'updated-fixture');
  await runtime.create({ slug: 'person' });
  assert.equal(sts.spec.replicas, 1);
  assert.equal(sts.metadata.annotations['workpartner/paused'], 'true');
  assert.equal(sts.spec.template.spec.nodeSelector, undefined);
  assert.equal(pvc.spec.volumeName, 'retained-volume');
  assert.ok(client.objects.get(`${core}/secrets/fixture-person-published`).data['.zp-market-token'] === 'Zml4dHVyZQ==');
  assert.ok(Buffer.from(client.objects.get(`${core}/secrets/fixture-person-model-key`).data['model.key'], 'base64').toString() === 'updated-fixture');
  assert.equal(client.calls.filter(([method, route]) => method === 'create' && route === apps).length, 1);
  assert.equal(writes(client).filter(([method, route]) => method === 'patch' && route.includes('persistentvolumeclaims')).length, 0);
});

test('invalid configuration and slugs fail before any request', async t => {
  for (const options of [{ namespace: undefined }, { storageClass: '' }, { uid: 0 }, { uid: -1 },
    { userLabel: '/user' }, { userLabel: 'bad/key/name' }, { userLabel: 'Bad.example.test/user' },
    { userLabel: 'workpartner/role' }, { userLabel: 'a'.repeat(64) },
    { systemContainer: '' }, { systemContainer: 123 }, { systemContainer: 'bad/name' }]) {
    assert.throws(() => createK8sRuntime({ ...defaults, ...options }));
  }
  const { runtime, client } = fixture(t);
  for (const slug of ['a', 'Upper', '../escape', 'a_b', 'a'.repeat(32), '', 'person/other']) {
    await assert.rejects(async () => runtime.create({ slug }), /Invalid workspace slug/);
    await assert.rejects(runtime.inspect(slug), /Invalid workspace slug/);
    for (const name of ['start', 'stop', 'restart', 'remove', 'runOnce', 'ensureIsolation', 'exec', 'processes', 'putFiles', 'readFile', 'removeFiles', 'address']) {
      await assert.rejects(async () => runtime[name](slug), /Invalid workspace slug/);
    }
  }
  assert.deepEqual(client.calls, []);
});

test('missing model key or unregistered image emits no writes', async t => {
  const { runtime, client, secureDir } = fixture(t);
  fs.unlinkSync(path.join(secureDir, 'model-person.key'));
  await assert.rejects(runtime.create({ slug: 'person' }), { message: '没有 person 的模型钥匙' });
  assert.deepEqual(client.calls, []);
  fs.writeFileSync(path.join(secureDir, 'model-person.key'), 'fixture-key');
  client.objects.get(registry).data['images.json'] = '{}';
  await assert.rejects(runtime.create({ slug: 'person' }), /not registered/);
  assert.deepEqual(writes(client), []);
});

test('isolation fails closed for create, start, restart and runOnce', async t => {
  const { runtime, client } = fixture(t);
  await runtime.create({ slug: 'person' });
  client.objects.delete(policy('workpartner-user-egress'));
  const before = writes(client).length;
  for (const action of [() => runtime.ensureIsolation('person'), () => runtime.create({ slug: 'person' }),
    () => runtime.start('person'), () => runtime.restart('person'), () => runtime.runOnce('person')]) {
    await assert.rejects(action(), /Required NetworkPolicy is missing: workpartner-user-egress/);
  }
  assert.equal(writes(client).length, before);
  const custom = createK8sRuntime({ ...defaults, client, requiredPolicies: ['custom-policy'] });
  await assert.rejects(custom.ensureIsolation('person'), /custom-policy/);
  client.objects.set(policy('custom-policy'), {});
  await custom.ensureIsolation('person');
});

test('lifecycle waits for deletion, changes restart uid, preserves PVCs and Secrets and tolerates 404', async t => {
  const { runtime, client } = fixture(t);
  assert.deepEqual(await runtime.inspect('person'), { exists: false, running: false, image: null, imageId: null, address: null, replicas: null, annotations: {} });
  await runtime.create({ slug: 'person' });
  assert.equal((await runtime.inspect('person')).running, false);
  await runtime.start('person');
  const info = await runtime.inspect('person');
  assert.equal(info.exists, true); assert.equal(info.running, true);
  assert.equal(info.image, 'workspace:test'); assert.equal(info.imageId, 'sha256:fixture');
  assert.equal(info.name, 'fixture-person'); assert.equal(info.replicas, 1); assert.equal(info.paused, false);
  assert.deepEqual(info.env, ['MODEL_BASE_URL=undefined', 'PARTNER_USER_NAME=', 'WORKPARTNER_PUBLISHED_DIR=/run/workpartner/published']);
  assert.deepEqual(info.address, { host: '192.0.2.10', port: 25808 });
  const uid = client.objects.get(podPath).metadata.uid;
  await runtime.restart('person');
  assert.notEqual(client.objects.get(podPath).metadata.uid, uid);
  await runtime.stop('person');
  assert.equal(client.objects.has(podPath), false);
  assert.equal((await runtime.inspect('person')).running, false);
  await runtime.start('person');
  await runtime.remove('person');
  assert.equal(client.objects.has(podPath), false);
  assert.equal(client.objects.has(stsPath), false);
  assert.equal((await runtime.inspect('person')).exists, false);
  assert.ok(client.objects.has(`${core}/persistentvolumeclaims/fixture-person-data`));
  assert.ok(client.objects.has(`${core}/secrets/fixture-person-model-key`));
  assert.ok(client.objects.has(`${core}/secrets/fixture-person-published`));
  assert.deepEqual(client.calls.find(([method, route]) => method === 'remove' && route === stsPath)[2],
    { propagationPolicy: 'Foreground', gracePeriodSeconds: 10 });
  await runtime.remove('person'); await runtime.stop('person');
  await runtime.create({ slug: 'person' }); await runtime.restart('person');
  assert.equal((await runtime.inspect('person')).running, true);
});

test('start requires main container running, IP, and no deletion timestamp; timeout includes reasons', async t => {
  for (const reason of ['Unschedulable', 'ErrImageNeverPull']) {
    const { runtime, client } = fixture(t, { podStartTimeoutMs: 123 });
    await runtime.create({ slug: 'person' });
    const pod = { metadata: { name: 'fixture-person-0', labels: { 'workpartner.next-user': 'person' } }, status: { phase: 'Pending',
      conditions: [{ status: 'False', reason }], containerStatuses: [{ name: 'workspace', state: { waiting: { reason } } }] } };
    client.objects.set(podPath, pod);
    await assert.rejects(runtime.start('person'), new RegExp(reason));
    assert.ok(client.calls.some(([method, opts]) => method === 'waitFor' && opts.timeoutMs === 123));
    pod.status = { phase: 'Running', podIP: '192.0.2.11', containerStatuses: [{ name: 'sidecar', state: { running: {} } }] };
    assert.equal((await runtime.inspect('person')).running, false);
    await assert.rejects(runtime.start('person'), /did not start/);
    pod.status.containerStatuses = [{ name: 'workspace', state: { running: {} } }];
    delete pod.status.podIP;
    await assert.rejects(runtime.start('person'), /did not start/);
    pod.status.podIP = '192.0.2.11'; pod.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
    await assert.rejects(runtime.start('person'), /did not start/);
    delete pod.metadata.deletionTimestamp;
    await runtime.start('person');
  }
});

test('inspect and image caches expire and all lifecycle operations invalidate them', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { runtime, client } = fixture(t, { inspectCacheMs: 25 });
  await runtime.create({ slug: 'person' });
  await runtime.inspect('person');
  client.objects.get(stsPath).metadata.annotations['workpartner/paused'] = '';
  assert.equal((await runtime.inspect('person')).paused, false);
  now += 26;
  assert.equal((await runtime.inspect('person')).paused, true);
  const info = await runtime.inspect('person'); info.annotations['workpartner/paused'] = 'changed';
  assert.equal((await runtime.inspect('person')).annotations['workpartner/paused'], '');
  await runtime.imageId('workspace:test');
  client.objects.get(registry).data['images.json'] = '{"workspace:test":"sha256:new"}';
  assert.equal(await runtime.imageId('workspace:test'), 'sha256:fixture');
  now += 10001;
  assert.equal(await runtime.imageId('workspace:test'), 'sha256:new');
  assert.equal((await runtime.inspect('person')).imageId, 'sha256:fixture');
  for (const operation of [() => runtime.create({ slug: 'person' }), () => runtime.start('person'),
    () => runtime.restart('person'), () => runtime.stop('person'), () => runtime.runOnce('person'), () => runtime.remove('person')]) {
    await runtime.inspect('person'); await runtime.imageId('workspace:test');
    await operation();
    const before = client.calls.length;
    await runtime.inspect('person'); await runtime.imageId('workspace:test');
    assert.ok(client.calls.slice(before).some(([m, route]) => m === 'get' && route === stsPath));
    assert.ok(client.calls.slice(before).some(([m, route]) => m === 'get' && route === registry));
  }
});

test('address preserves Docker semantics for inspection and supplied endpoints', async t => {
  const { runtime } = fixture(t);
  assert.equal(await runtime.address('person'), null);
  await runtime.create({ slug: 'person' }); await runtime.start('person');
  assert.deepEqual(await runtime.address('person', 3092), { host: '192.0.2.10', port: 3092 });
  assert.deepEqual(await runtime.address('person', 9000, { ip: '192.0.2.20', port: 8000 }), { host: '192.0.2.20', port: 9000 });
  assert.deepEqual(await runtime.address('person', undefined, { address: { host: '192.0.2.20', port: 8000 } }), { host: '192.0.2.20', port: 8000 });
  for (const existing of [null, {}, { ip: '' }, { address: null }]) assert.equal(await runtime.address('person', 9000, existing), null);
});

test('runOnce rejects any existing Pod and the controller creation gap without writes', async t => {
  const { runtime, client } = fixture(t);
  await runtime.create({ slug: 'person' });
  for (const metadata of [{ name: 'fixture-person-0' }, { name: 'fixture-person-job', labels: { 'workpartner.next-user': 'person' }, deletionTimestamp: '2026-01-01T00:00:00Z' }]) {
    client.objects.set(`${core}/pods/${metadata.name}`, { metadata, status: { phase: 'Succeeded' } });
    const before = writes(client).length;
    await assert.rejects(runtime.runOnce('person'), /still has a Pod/);
    assert.equal(writes(client).length, before);
    client.objects.delete(`${core}/pods/${metadata.name}`);
  }
  client.objects.get(stsPath).spec.replicas = 1;
  const before = writes(client).length;
  await assert.rejects(runtime.runOnce('person'), /active StatefulSet/);
  assert.equal(writes(client).length, before);
});

test('runOnce uses an isolated job with data only, returns logs and waits for cleanup', async t => {
  const { runtime, client } = fixture(t);
  await runtime.create({ slug: 'person' });
  const result = await runtime.runOnce('person', { name: 'reset', image: 'workspace:test', entrypoint: ['/bin/reset'], cmd: ['--data', '/data'], timeoutMs: 543 });
  assert.deepEqual(result, { exitCode: 3, logs: 'new password: fixture\n' });
  const job = client.calls.find(([method, route]) => method === 'create' && route === `${core}/pods`)[2];
  assert.equal(job.metadata.name, 'fixture-person-reset');
  assert.equal(job.metadata.labels['workpartner/role'], 'job');
  assert.equal(job.metadata.labels['workpartner.next-user'], 'person');
  assert.equal(job.spec.restartPolicy, 'Never');
  assert.equal(job.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.enableServiceLinks, false);
  assert.equal(job.spec.containers[0].securityContext.runAsNonRoot, true);
  assert.deepEqual(job.spec.volumes, [{ name: 'data', persistentVolumeClaim: { claimName: 'fixture-person-data' } }]);
  assert.deepEqual(job.spec.containers[0].volumeMounts, [{ name: 'data', mountPath: '/data' }]);
  assert.deepEqual(job.spec.containers[0].command, ['/bin/reset']);
  assert.deepEqual(job.spec.containers[0].args, ['--data', '/data']);
  assert.equal(client.objects.has(`${core}/pods/fixture-person-reset`), false);
  assert.ok(client.calls.some(([m, opts]) => m === 'waitFor' && opts.timeoutMs === 543));
  assert.deepEqual(client.calls.find(([method]) => method === 'logs'), ['logs', 'users', 'fixture-person-reset', 'workspace', { limitBytes: 1024 * 1024 }]);
});

test('runOnce cleans up after timeout, log failure and uncertain create failure', async t => {
  for (const failure of ['wait', 'logs', 'create']) {
    const { runtime, client } = fixture(t);
    await runtime.create({ slug: 'person' });
    const originalWait = client.waitFor, originalCreate = client.create;
    if (failure === 'wait') {
      let first = true;
      client.waitFor = async (...args) => { if (first) { first = false; throw new Error('job timeout'); } return originalWait(...args); };
    } else if (failure === 'logs') client.logs = async () => { throw new Error('log failure'); };
    else client.create = async (...args) => { await originalCreate(...args); throw new Error('connection lost'); };
    await assert.rejects(runtime.runOnce('person'), /job timeout|log failure|connection lost/);
    assert.equal(client.objects.has(`${core}/pods/fixture-person-resetpass`), false);
    await runtime.start('person');
  }
});

test('concurrent lifecycle and jobs serialize without overlapping user Pods', async t => {
  const { runtime, client } = fixture(t);
  await runtime.create({ slug: 'person' });
  let maxPods = 0;
  client.onTick = () => {
    const count = [...client.objects.keys()].filter(route => route.startsWith(`${core}/pods/`)).length;
    maxPods = Math.max(maxPods, count);
    assert.ok(count <= 1);
  };
  const operations = [];
  for (let i = 0; i < 10; i++) operations.push(runtime.start('person'), runtime.runOnce('person'), runtime.stop('person'), runtime.runOnce('person'), runtime.restart('person'));
  const results = await Promise.allSettled(operations);
  assert.equal(results.filter(r => r.status === 'rejected').length, 10);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => /still has a Pod/.test(r.reason.message)));
  assert.equal(maxPods, 1);
  assert.equal((await runtime.inspect('person')).running, true);
});

test('assembly delegates K2b methods and passes the fixed namespace, names and file context', async t => {
  const calls = [], contexts = [];
  const { runtime, client } = fixture(t, {
    systemContainer: 'model-egress',
    createK8sExec: context => {
      contexts.push(context);
      return Object.fromEntries(['exec', 'execNamed', 'processes'].map(name => [name, async (...args) => { calls.push([name, ...args]); return name; }]));
    },
    createK8sFiles: context => {
      contexts.push(context);
      return Object.fromEntries(['putFiles', 'readFile', 'removeFiles'].map(name => [name, async (...args) => { calls.push([name, ...args]); return name; }]));
    },
  });
  const cmd = ['node', '--version'], options = { timeout: 123, env: ['A=B'] }, lease = {};
  assert.equal(await runtime.exec('person', cmd, options), 'exec');
  assert.equal(await runtime.execNamed('model-egress', cmd, options), 'execNamed');
  assert.equal(await runtime.processes('person', 500), 'processes');
  assert.equal(await runtime.putFiles('person', [], options), 'putFiles');
  assert.equal(await runtime.readFile('person', '.zp-market-token'), 'readFile');
  assert.equal(await runtime.removeFiles('person', ['staging'], lease), 'removeFiles');
  assert.deepEqual(calls, [['exec', 'person', cmd, options], ['execNamed', 'model-egress', cmd, options], ['processes', 'person', 500],
    ['putFiles', 'person', [], options], ['readFile', 'person', '.zp-market-token'], ['removeFiles', 'person', ['staging'], lease]]);
  assert.equal(contexts.length, 2);
  for (const context of contexts) {
    assert.equal(context.client, client); assert.equal(context.namespace, 'users'); assert.equal(context.systemNamespace, 'system');
    assert.equal(context.container, 'workspace'); assert.equal(context.uid, 1001);
    assert.equal(context.systemContainer, 'model-egress');
    assert.equal(context.names('person').pod, 'fixture-person-0');
    assert.equal(context.names('person').published, 'fixture-person-published');
    assert.deepEqual(context.publishedFiles, ['.zp-market-token', '.wp-feishu-cli.json', '.zp-preview-relay-key']);
  }
  assert.equal(contexts[1].exec, runtime.exec);
  await assert.rejects(runtime.execNamed('../escape', cmd), /Invalid runtime Pod name/);
});

test('index selects k8s, rejects unknown kinds and disables every legacy method', async t => {
  const { client, secureDir } = fixture(t);
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    nextMemory: 2147483648, nanoCpus: 1000000000, secureDirectory: secureDir,
    k8s: { namespace: 'users', storageClass: 'local-data' } }, model: { keyPrefix: 'model-', baseUrl: 'https://model.example.test/v1' } };
  const runtime = createRuntime(organization, { client });
  await runtime.create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources.limits, { memory: '2147483648', cpu: '1' });
  for (const kind of ['unknown', '', null, false]) assert.throws(() => createRuntime({ runtime: { kind } }), /Unsupported runtime kind/);
  for (const method of Object.values(createLegacyRuntime(organization))) await assert.rejects(method(), { name: 'LegacyRuntimeUnavailable', code: 'LegacyRuntimeUnavailable' });
  assert.equal(typeof createRuntime({ runtime: {} }).inspect, 'function');
  const script = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (/docker|kube-client|k8s-exec|k8s-files/.test(specifier)) throw new Error('Unexpected dependency import');
      return next(specifier, context);
    } });
    const { createRuntime } = await import(${JSON.stringify(new URL('../gateway/runtime/index.mjs', import.meta.url).href)});
    createRuntime({ runtime: { kind: 'k8s', k8s: { namespace: 'users', storageClass: 'local-data' } } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});

test('create reconciles AlreadyExists races without replacing published Secret data', async t => {
  const { runtime, client } = fixture(t);
  const originalCreate = client.create;
  client.create = async (route, object) => {
    await originalCreate(route, object);
    if (object.metadata.name.endsWith('-published')) client.objects.get(`${route}/${object.metadata.name}`).data = { '.zp-market-token': 'Zml4dHVyZQ==' };
    throw Object.assign(new Error('Already exists'), { status: 409, reason: 'AlreadyExists' });
  };
  await runtime.create({ slug: 'person' });
  assert.equal(client.objects.get(stsPath).spec.replicas, 0);
  assert.ok(client.objects.get(`${core}/secrets/fixture-person-published`).data['.zp-market-token'] === 'Zml4dHVyZQ==');
  const sts = client.objects.get(stsPath);
  sts.spec.selector.matchLabels = Object.fromEntries(Object.entries(sts.spec.selector.matchLabels).reverse());
  await runtime.create({ slug: 'person' });
  sts.spec.replicas = 2;
  await assert.rejects(runtime.create({ slug: 'person' }), /Incompatible runtime StatefulSet/);
});

test('terminating Pods block stop and remove completion without force deletion', async t => {
  for (const action of ['stop', 'remove']) {
    const { runtime, client } = fixture(t);
    await runtime.create({ slug: 'person' }); await runtime.start('person');
    client.onTick = () => {
      if (!client.objects.has(podPath)) client.objects.set(podPath, { metadata: { name: 'fixture-person-0', deletionTimestamp: '2026-01-01T00:00:00Z' } });
    };
    await assert.rejects(runtime[action]('person'), /Timed out.*fixture-person-0/);
    assert.ok(client.objects.has(podPath));
    assert.ok(client.calls.filter(([m]) => m === 'remove').every(([, , options]) => options.gracePeriodSeconds === 10));
    client.onTick = undefined;
    client.objects.delete(podPath);
    await runtime.stop('person');
  }
});

test('start and restart reject stray job Pods before writes', async t => {
  const { runtime, client } = fixture(t);
  await runtime.create({ slug: 'person' });
  client.objects.set(`${core}/pods/fixture-person-job`, { metadata: { name: 'fixture-person-job', labels: { 'workpartner.next-user': 'person' } } });
  const before = writes(client).length;
  for (const action of ['start', 'restart']) await assert.rejects(runtime[action]('person'), /another Pod/);
  assert.equal(writes(client).length, before);
});

test('runOnce does not delete a conflicting job and rejects invalid job names before writes', async t => {
  const { runtime, client } = fixture(t);
  await runtime.create({ slug: 'person' });
  const before = writes(client).length;
  await assert.rejects(runtime.runOnce('person', { name: '../other' }), /Invalid runtime job name/);
  assert.equal(writes(client).length, before);
  client.create = async () => { throw Object.assign(new Error('Already exists'), { status: 409, reason: 'AlreadyExists' }); };
  await assert.rejects(runtime.runOnce('person'), /Already exists/);
  assert.equal(client.calls.filter(([m]) => m === 'remove').length, 0);
});

test('in-flight inspect and image requests cannot repopulate invalidated caches', async t => {
  const { runtime, client } = fixture(t);
  const originalGet = client.get;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  client.get = async route => {
    const object = await originalGet(route);
    if (route === stsPath && !intercepted) { intercepted = true; entered(); await blocked; }
    return object;
  };
  const stale = runtime.inspect('person');
  await started;
  await runtime.create({ slug: 'person' });
  release();
  assert.equal((await stale).exists, false);
  assert.equal((await runtime.inspect('person')).exists, true);
  let releaseImage, enteredImage;
  const imageStarted = new Promise(resolve => { enteredImage = resolve; });
  const imageBlocked = new Promise(resolve => { releaseImage = resolve; });
  intercepted = false;
  client.get = async route => {
    const object = await originalGet(route);
    if (route === registry && !intercepted) { intercepted = true; enteredImage(); await imageBlocked; }
    return object;
  };
  const staleImage = runtime.imageId('workspace:test');
  await imageStarted;
  await runtime.stop('person');
  client.objects.get(registry).data['images.json'] = '{"workspace:test":"sha256:updated"}';
  releaseImage();
  assert.equal(await staleImage, 'sha256:fixture');
  assert.equal(await runtime.imageId('workspace:test'), 'sha256:updated');
});

test('image registry missing references and invalid JSON do not disclose registry contents', async t => {
  const { runtime, client } = fixture(t);
  assert.equal(await runtime.imageId('unknown'), null);
  assert.equal(await runtime.imageId('__proto__'), null);
  await runtime.stop('person');
  client.objects.get(registry).data['images.json'] = 'fixture-sensitive-invalid-json';
  await assert.rejects(runtime.imageId('workspace:test'), { message: 'Invalid image registry ConfigMap' });
});

test('StatefulSet names allow 52 characters and reject 53 before requests', async t => {
  for (const length of [52, 53]) {
    const containerPrefix = `${'a'.repeat(length - 'person'.length - 1)}-`;
    const { runtime, client } = fixture(t, { containerPrefix });
    if (length === 52) {
      await runtime.create({ slug: 'person' });
      const name = `${containerPrefix}person`;
      assert.equal(name.length, 52);
      assert.ok(client.objects.has(`${apps}/${name}`));
      assert.equal(client.objects.get(`${apps}/${name}`).metadata.name.length + '-1234567890'.length, 63);
    } else {
      await assert.rejects(async () => runtime.create({ slug: 'person' }), /Invalid runtime container name/);
      await assert.rejects(runtime.inspect('person'), /Invalid runtime container name/);
      assert.deepEqual(client.calls, []);
    }
  }
});

test('inspect exposes replicas and annotations and hides addresses until the main Pod is running', async t => {
  const { runtime, client } = fixture(t, { inspectCacheMs: 0 });
  const missing = await runtime.inspect('person');
  assert.equal(missing.replicas, null);
  assert.deepEqual(missing.annotations, {});
  await runtime.create({ slug: 'person' });
  const sts = client.objects.get(stsPath);
  sts.metadata.annotations['workpartner/paused'] = '';
  sts.metadata.annotations['fixture.test/note'] = 'retained';
  const stopped = await runtime.inspect('person');
  assert.equal(stopped.replicas, 0);
  assert.deepEqual(stopped.annotations, { 'workpartner/image-id': 'sha256:fixture', 'workpartner/paused': '', 'fixture.test/note': 'retained' });
  assert.equal(stopped.address, null);
  await runtime.start('person');
  const active = await runtime.inspect('person');
  assert.equal(active.replicas, 1);
  assert.equal(active.running, true);
  assert.deepEqual(active.address, { host: '192.0.2.10', port: 25808 });
  const pod = client.objects.get(podPath);
  pod.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
  const terminating = await runtime.inspect('person');
  assert.equal(terminating.running, false);
  assert.equal(terminating.address, null);
  assert.equal(await runtime.address('person'), null);
  delete pod.metadata.deletionTimestamp;
  for (const phase of ['Pending', 'Succeeded', 'Failed']) {
    pod.status.phase = phase;
    assert.equal((await runtime.inspect('person')).address, null);
  }
  delete sts.metadata.annotations;
  assert.deepEqual((await runtime.inspect('person')).annotations, {});
  delete sts.spec.replicas;
  assert.equal((await runtime.inspect('person')).replicas, null);
});

test('start and restart preserve API and network error identity while polling', async t => {
  for (const action of ['start', 'restart']) {
    for (const failure of [Object.assign(new Error('Forbidden'), { status: 403, reason: 'Forbidden' }),
      Object.assign(new Error('Connection failed'), { reason: 'NetworkError' }),
      Object.assign(new Error('Socket reset'), { code: 'ECONNRESET' })]) {
      const { runtime, client } = fixture(t);
      await runtime.create({ slug: 'person' });
      const get = client.get, waitFor = client.waitFor;
      let polling = false;
      client.waitFor = (...args) => { polling = true; return waitFor(...args); };
      client.get = route => {
        if (polling && route === podPath) throw failure;
        return get(route);
      };
      await assert.rejects(runtime[action]('person'), error => error === failure);
    }
  }
});

test('repeated create clears removed optional template settings and obsolete selector keys', async t => {
  const { runtime, client, secureDir } = fixture(t, {
    newUserNodeSelector: { pool: 'workers', zone: 'fixture' }, userPriorityClass: 'users-priority',
  });
  client.objects.set(`${core}/persistentvolumeclaims/fixture-person-oldwork`, { metadata: { name: 'fixture-person-oldwork' } });
  await runtime.create({ slug: 'person' }, { modelConfig: '{"defaults":{}}' });
  const pod = client.objects.get(stsPath).spec.template.spec;
  assert.equal(pod.priorityClassName, 'users-priority');
  assert.deepEqual(pod.nodeSelector, { pool: 'workers', zone: 'fixture' });
  await createK8sRuntime({ ...defaults, client, secureDir, newUserNodeSelector: { pool: 'other' } }).create({ slug: 'person' });
  assert.deepEqual(pod.nodeSelector, { pool: 'other' });
  assert.equal(Object.hasOwn(pod, 'priorityClassName'), false);
  client.objects.delete(`${core}/persistentvolumeclaims/fixture-person-oldwork`);
  await createK8sRuntime({ ...defaults, client, secureDir }).create({ slug: 'person' });
  assert.equal(Object.hasOwn(pod, 'nodeSelector'), false);
  assert.equal(Object.hasOwn(pod, 'priorityClassName'), false);
  assert.equal(pod.containers[0].env.some(e => e.name === 'WORKPARTNER_MODEL_CONFIG'), false);
  assert.equal(pod.volumes.some(v => v.name === 'oldwork'), false);
  assert.equal(pod.containers[0].volumeMounts.some(v => v.name === 'oldwork'), false);
  const update = client.calls.filter(([method, route]) => method === 'patch' && route === stsPath).at(-1)[2];
  assert.equal(update.spec.template.spec.priorityClassName, null);
  assert.equal(update.spec.template.spec.nodeSelector, null);
});

test('stop and remove identify stranded jobs without deleting them and preserve polling errors', async t => {
  for (const action of ['stop', 'remove']) {
    const { runtime, client } = fixture(t);
    await runtime.create({ slug: 'person' });
    const names = ['fixture-person-job', 'fixture-person-reset'];
    for (const name of names) client.objects.set(`${core}/pods/${name}`, {
      metadata: { name, labels: { 'workpartner.next-user': 'person' } }, status: { phase: 'Succeeded' },
    });
    await assert.rejects(runtime[action]('person'), error => {
      assert.match(error.message, /Timed out/);
      for (const name of names) assert.ok(error.message.includes(name));
      assert.equal(error.cause.reason, 'Timeout');
      return true;
    });
    for (const name of names) {
      assert.ok(client.objects.has(`${core}/pods/${name}`));
      assert.equal(client.calls.some(([method, route]) => method === 'remove' && route === `${core}/pods/${name}`), false);
    }
    for (const reason of ['Forbidden', 'NetworkError']) {
      const failure = Object.assign(new Error(reason), { reason });
      client.waitFor = async fn => { await fn(); throw failure; };
      await assert.rejects(runtime[action]('person'), error => error === failure);
    }
  }
});

test('assembly passes nonempty container strings to K1 for exec and execNamed', async t => {
  for (const systemContainer of [undefined, 'service-container']) {
    const { client } = fixture(t);
    const calls = [], contexts = [], result = { exitCode: 0, stdout: 'ok', stderr: '', logs: 'ok' };
    client.exec = async (namespace, pod, container, cmd, options) => {
      if (typeof container !== 'string' || !container.length) throw Object.assign(new Error('InvalidOptions'), { reason: 'InvalidOptions' });
      calls.push({ namespace, pod, container, cmd, options });
      await setImmediate();
      return result;
    };
    // Match K2b's scalar systemContainer contract; leave validation to the K1-style client.
    const createK8sExec = context => {
      contexts.push(context);
      const { client, namespace, systemNamespace, containerPrefix, container, systemContainer } = context;
      return {
        exec: (slug, cmd, options) => client.exec(namespace, `${containerPrefix}${slug}-0`, container, cmd, options),
        execNamed: (name, cmd, options) => client.exec(systemNamespace, name, systemContainer, cmd, options),
      };
    };
    const runtime = createRuntime({ runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-',
      k8s: { namespace: 'users', storageClass: 'local-data', systemNamespace: 'control', systemContainer } } }, { client, createK8sExec });
    const cmd = ['node', '--version'], options = { timeout: 123 };
    assert.deepEqual(await Promise.all([
      runtime.exec('person', cmd, options), runtime.execNamed('model-egress', cmd, options),
      runtime.execNamed('other-service', cmd, options), runtime.execNamed('model-egress', cmd, options),
    ]), [result, result, result, result]);
    assert.deepEqual(calls.sort((a, b) => a.pod.localeCompare(b.pod)), [
      { namespace: 'users', pod: 'fixture-person-0', container: 'workspace', cmd, options },
      { namespace: 'control', pod: 'model-egress', container: systemContainer ?? 'model-egress', cmd, options },
      { namespace: 'control', pod: 'model-egress', container: systemContainer ?? 'model-egress', cmd, options },
      { namespace: 'control', pod: 'other-service', container: systemContainer ?? 'other-service', cmd, options },
    ]);
    assert.equal(contexts.length, systemContainer === undefined ? 3 : 1);
  }
});

test('organization userResources overrides each user limit independently without changing requests', async t => {
  const { client, secureDir } = fixture(t);
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    nextMemory: 4294967296, nanoCpus: 1500000000, secureDirectory: secureDir,
    k8s: { namespace: 'users', storageClass: 'local-data', memoryRequest: '768Mi', cpuRequest: '200m',
      userResources: { person: { memory: '8Gi', cpu: '2' }, 'fixture-memory': { memory: '6Gi' }, 'fixture-cpu': { cpu: '750m' } } } },
    model: { keyPrefix: 'model-' } };
  const runtime = createRuntime(organization, { client });
  const expected = { person: { memory: '8Gi', cpu: '2' }, 'fixture-memory': { memory: '6Gi', cpu: '1.5' },
    'fixture-cpu': { memory: '4294967296', cpu: '750m' }, 'fixture-default': { memory: '4294967296', cpu: '1.5' } };
  for (const [slug, limits] of Object.entries(expected)) {
    fs.writeFileSync(path.join(secureDir, `model-${slug}.key`), 'fixture-key');
    await runtime.create({ slug });
    assert.deepEqual(client.objects.get(`${apps}/fixture-${slug}`).spec.template.spec.containers[0].resources,
      { requests: { memory: '768Mi', cpu: '200m' }, limits });
  }
  organization.runtime.k8s.userResources.person = { cpu: '3' };
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '3' } });
  delete organization.runtime.k8s.userResources;
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } });
});

test('organization userResources overrides requests independently alongside limits', async t => {
  const { client, secureDir } = fixture(t);
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    nextMemory: 4294967296, nanoCpus: 1500000000, secureDirectory: secureDir,
    k8s: { namespace: 'users', storageClass: 'local-data', memoryRequest: '768Mi', cpuRequest: '200m',
      userResources: { 'fixture-memory': { memoryRequest: '1Gi' }, 'fixture-cpu': { cpuRequest: '500m' },
        person: { memoryRequest: '2Gi', cpuRequest: '750m', memory: '8Gi', cpu: '3' }, 'fixture-empty': {} } } } };
  const runtime = createRuntime(organization, { client });
  const expected = {
    'fixture-memory': { requests: { memory: '1Gi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } },
    'fixture-cpu': { requests: { memory: '768Mi', cpu: '500m' }, limits: { memory: '4294967296', cpu: '1.5' } },
    person: { requests: { memory: '2Gi', cpu: '750m' }, limits: { memory: '8Gi', cpu: '3' } },
    'fixture-empty': { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } },
    'fixture-default': { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } },
  };
  for (const [slug, resources] of Object.entries(expected)) {
    fs.writeFileSync(path.join(secureDir, `model-${slug}.key`), 'fixture-key');
    await runtime.create({ slug });
    assert.deepEqual(client.objects.get(`${apps}/fixture-${slug}`).spec.template.spec.containers[0].resources, resources);
  }
  await runtime.runOnce('person');
  const job = client.calls.find(([method, route]) => method === 'create' && route === `${core}/pods`)[2];
  assert.deepEqual(job.spec.containers[0].resources,
    { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } });
});

test('organization userResources stringifies finite numeric requests and limits', async t => {
  const { client, secureDir } = fixture(t);
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    secureDirectory: secureDir, k8s: { namespace: 'users', storageClass: 'local-data' } } };
  for (const [overrides, expected] of [
    [{ memoryRequest: 268435456, cpuRequest: 0.5, memory: 4294967296, cpu: 2 },
      { requests: { memory: '268435456', cpu: '0.5' }, limits: { memory: '4294967296', cpu: '2' } }],
    [{ memoryRequest: 0, cpuRequest: 0, memory: 0, cpu: 0 },
      { requests: { memory: '0', cpu: '0' }, limits: { memory: '0', cpu: '0' } }],
  ]) {
    organization.runtime.k8s.userResources = { person: overrides };
    await createRuntime(organization, { client }).create({ slug: 'person' });
    assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources, expected);
  }
});

test('organization userResources ignores invalid values independently without affecting other users', async t => {
  const { client, secureDir } = fixture(t);
  fs.writeFileSync(path.join(secureDir, 'model-fixture-default.key'), 'fixture-key');
  const valid = { memoryRequest: '1Gi', cpuRequest: '500m', memory: '8Gi', cpu: '3' };
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    nextMemory: 4294967296, nanoCpus: 1500000000, secureDirectory: secureDir,
    k8s: { namespace: 'users', storageClass: 'local-data', memoryRequest: '768Mi', cpuRequest: '200m' } } };
  const expected = {
    memoryRequest: { requests: { memory: '768Mi', cpu: '500m' }, limits: { memory: '8Gi', cpu: '3' } },
    cpuRequest: { requests: { memory: '1Gi', cpu: '200m' }, limits: { memory: '8Gi', cpu: '3' } },
    memory: { requests: { memory: '1Gi', cpu: '500m' }, limits: { memory: '4294967296', cpu: '3' } },
    cpu: { requests: { memory: '1Gi', cpu: '500m' }, limits: { memory: '8Gi', cpu: '1.5' } },
  };
  for (const value of [null, '', {}, [], true, false, NaN, Infinity, -Infinity]) {
    for (const [key, resources] of Object.entries(expected)) {
      organization.runtime.k8s.userResources = { person: { ...valid, [key]: value } };
      const runtime = createRuntime(organization, { client });
      await assert.doesNotReject(() => runtime.create({ slug: 'person' }));
      assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources, resources);
      await runtime.create({ slug: 'fixture-default' });
      assert.deepEqual(client.objects.get(`${apps}/fixture-fixture-default`).spec.template.spec.containers[0].resources,
        { requests: { memory: '768Mi', cpu: '200m' }, limits: { memory: '4294967296', cpu: '1.5' } });
    }
  }
});

test('organization userResources persists requests on recreation and restores removed keys to global values', async t => {
  const { client, secureDir } = fixture(t);
  const organization = { runtime: { kind: 'k8s', nextContainerPrefix: 'fixture-', nextImage: 'workspace:test',
    nextMemory: 4294967296, nanoCpus: 1500000000, secureDirectory: secureDir,
    k8s: { namespace: 'users', storageClass: 'local-data', memoryRequest: '768Mi', cpuRequest: '200m',
      userResources: { person: { memoryRequest: '1Gi', cpuRequest: '500m', memory: '8Gi', cpu: '3' } } } } };
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '1Gi', cpu: '500m' }, limits: { memory: '8Gi', cpu: '3' } });
  organization.runtime.k8s.memoryRequest = '256Mi';
  organization.runtime.k8s.cpuRequest = '100m';
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '1Gi', cpu: '500m' }, limits: { memory: '8Gi', cpu: '3' } });
  await createRuntime(organization, { client }).remove('person');
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '1Gi', cpu: '500m' }, limits: { memory: '8Gi', cpu: '3' } });
  delete organization.runtime.k8s.userResources.person.memoryRequest;
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '256Mi', cpu: '500m' }, limits: { memory: '8Gi', cpu: '3' } });
  delete organization.runtime.k8s.userResources;
  await createRuntime(organization, { client }).create({ slug: 'person' });
  assert.deepEqual(client.objects.get(stsPath).spec.template.spec.containers[0].resources,
    { requests: { memory: '256Mi', cpu: '100m' }, limits: { memory: '4294967296', cpu: '1.5' } });
});

test('user Pod renders and clears the optional quick-line model from runtime configuration', async t => {
  const { runtime, client } = fixture(t);
  for (const quickLineModel of ['fast-model', undefined, '']) {
    const modelConfig = JSON.stringify({ defaults: {}, ...(quickLineModel === undefined ? {} : { quickLineModel }) });
    await runtime.create({ slug: 'person' }, { modelConfig });
    const env = client.objects.get(stsPath).spec.template.spec.containers[0].env;
    assert.deepEqual(env.filter(value => value.name === 'QUICK_LINE_MODEL'),
      quickLineModel ? [{ name: 'QUICK_LINE_MODEL', value: quickLineModel }] : []);
    assert.equal(env.find(value => value.name === 'WORKPARTNER_MODEL_CONFIG').value, modelConfig);
  }
});

test('rekey updates only an existing model Secret and preserves file bytes', async t => {
  const { runtime, client, secureDir } = fixture(t);
  await runtime.create({ slug: 'person' });
  const route = `${core}/secrets/fixture-person-model-key`;
  fs.writeFileSync(path.join(secureDir, 'model-person.key'), 'fixture-replacement\n');
  client.calls.length = 0;
  await runtime.rekey('person');
  assert.deepEqual(writes(client), [['patch', route, { data: { 'model.key': Buffer.from('fixture-replacement\n').toString('base64') } }, 'merge']]);
  assert.equal(Buffer.from(client.objects.get(route).data['model.key'], 'base64').toString(), 'fixture-replacement\n');
  client.objects.delete(route); client.calls.length = 0;
  await runtime.rekey('person');
  assert.deepEqual(writes(client), []);
  assert.equal(client.objects.has(route), false);
});
