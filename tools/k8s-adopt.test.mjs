import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { runAdopt, parseArgs, main } from './k8s/adopt-user.mjs';
import { matches, readOwners, writeOwner } from './k8s/adopt-state.mjs';
import { createRuntime } from '../gateway/runtime/index.mjs';

const core = '/api/v1/namespaces/workspaces';
const apps = '/apis/apps/v1/namespaces/workspaces/statefulsets';
const name = 'workspace-user1';
const label = 'workpartner.next-user';
const secret = 'fixture-secret-must-never-be-logged';

async function fixture(t, { migrated = false, oldwork = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-adopt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'workspaces/user1');
  await fs.mkdir(directory, { recursive: true });
  const secureDirectory = path.join(root, 'secure');
  await fs.mkdir(secureDirectory);
  await fs.writeFile(path.join(secureDirectory, 'model-user1.key'), secret, { mode: 0o600 });
  const ownersFile = path.join(root, 'owners.json');
  await fs.writeFile(ownersFile, JSON.stringify({ version: 1, default: 'docker', users: { user1: migrated ? 'k8s' : 'docker', user2: 'docker' } }), { mode: 0o640 });
  const organization = { runtime: {
    kind: 'docker', nextContainerPrefix: 'workspace-', nextUserLabel: label, nextDirectory: '/workspaces',
    nextImage: 'workspace:test', nextPort: 25808, uid: 1001, secureDirectory,
    migration: { ownersFile }, k8s: { namespace: 'workspaces', systemNamespace: 'system', storageClass: 'local', dataVolumeSize: '20Gi' },
  } };
  const users = [{ slug: 'user1', backend: 'aionui' }, { slug: 'user2', backend: 'legacy' }];
  const events = [], logs = [], snapshots = [];
  const objects = new Map();
  const state = { exists: migrated, running: migrated, replicas: migrated ? 1 : null, annotations: {}, address: { host: '192.0.2.10', port: 25808 } };
  const container = { Name: `/${name}`, State: { Running: !migrated }, HostConfig: { RestartPolicy: { Name: migrated ? 'no' : 'unless-stopped' } },
    Mounts: [{ Destination: '/data', Source: directory, Type: 'bind', RW: true }] };
  const pod = (slug = 'user1', suffix = '0') => ({ metadata: { name: `workspace-${slug}-${suffix}`, labels: { [label]: slug } }, spec: { nodeName: 'node-a' }, status: { phase: 'Running' } });
  let pods = migrated ? [pod()] : [];
  const volume = { metadata: { name: `workspaces-${name}-data` }, spec: {
    local: { path: directory }, claimRef: { name: `${name}-data`, namespace: 'workspaces' },
    nodeAffinity: { required: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-a'] }] }] } },
  } };
  objects.set(`${core}/persistentvolumeclaims/${name}-data`, { spec: { volumeName: volume.metadata.name }, status: { phase: 'Bound' } });
  objects.set(`/api/v1/persistentvolumes/${volume.metadata.name}`, volume);
  objects.set('/api/v1/nodes/node-a', { metadata: { name: 'node-a' } });
  if (oldwork) {
    const old = path.join(root, 'users/user1/work');
    await fs.mkdir(old, { recursive: true });
    container.Mounts.push({ Destination: '/data/old-work', Source: old, Type: 'bind', RW: false });
  }
  const f = { root, directory, ownersFile, organization, users, events, logs, snapshots, objects, state, container, volume, pod,
    get pods() { return pods; }, set pods(value) { pods = value; },
    fail: null, after: null, image: 'sha256:fixture', bridgeConfigured: true, bridgeRunning: true, gatewayHealthy: true, previewValid: true,
    diff: 'A /usr/local/bin/custom-cli\nC /usr/local/bin/readme\nD /usr/local/bin/removed\nC /etc/settings\n',
  };
  async function record(event) {
    events.push(event);
    if (f.fail === event) throw new Error(secret);
  }
  async function changed(event) {
    snapshots.push({ event, docker: container.State.Running, pods: pods.length, owner: (await readOwners(ownersFile)).users.user1 });
    if (f.after) await f.after(event);
  }
  const client = {
    namespace: 'system',
    async get(route) {
      await record(`get ${route}`);
      if (route === `${core}/pods`) return { items: structuredClone(pods) };
      if (route.startsWith('/api/v1/namespaces/system/pods?')) return { items: [{ metadata: { name: 'gateway-pod' }, status: { phase: 'Running' } }] };
      if (route === apps) return { items: state.exists ? [{ metadata: { name, labels: { [label]: 'user1' } } }] : [] };
      const value = structuredClone(objects.get(route) ?? null);
      if (f.apiVolumeDefaults && value && /\/persistentvolume(?:claims|s)\//.test(route)) {
        value.apiVersion = 'v1'; value.kind = route.includes('/persistentvolumeclaims/') ? 'PersistentVolumeClaim' : 'PersistentVolume';
        if (value.spec.storageClassName === '') delete value.spec.storageClassName;
        if (value.spec.claimRef) Object.assign(value.spec.claimRef, { uid: 'claim-uid', kind: 'PersistentVolumeClaim', apiVersion: 'v1' });
        for (const term of value.spec.nodeAffinity?.required?.nodeSelectorTerms ?? []) term.matchExpressions = [];
      }
      return value;
    },
    async create(route, object) {
      await record(`create ${object.kind} ${object.metadata.name}`);
      objects.set(`${route}/${object.metadata.name}`, structuredClone(object));
      await changed(`create ${object.kind}`);
    },
    async patch(route, body, type) {
      const value = body.metadata.annotations['workpartner/paused'];
      await record(value ? 'pause' : 'unpause');
      assert.equal(route, `${apps}/${name}`); assert.equal(type, 'merge');
      if (value) state.annotations['workpartner/paused'] = value;
      else delete state.annotations['workpartner/paused'];
      await changed(value ? 'pause' : 'unpause');
    },
  };
  const runtime = {
    async inspect(slug) { await record(`inspect ${slug}`); return structuredClone(slug === 'user1' ? state : { exists: false, running: false, replicas: null, annotations: {} }); },
    async imageId(image) { await record('imageId'); assert.equal(image, organization.runtime.nextImage); return f.image; },
    async ensureIsolation(slug) { await record('ensureIsolation'); assert.equal(slug, 'user1'); await changed('ensureIsolation'); },
    async create(user, options) {
      await record('runtime create'); assert.equal(user, users[0]); assert.deepEqual(options, { modelConfig: 'fixture-model-config' });
      state.exists = true; state.replicas = 0; await changed('runtime create');
    },
    async start(slug) {
      await record('runtime start'); assert.equal(slug, 'user1');
      assert.equal(container.State.Running, false); assert.equal((await readOwners(ownersFile)).users.user1, 'k8s');
      state.running = true; state.replicas = 1; pods = [pod()]; await changed('runtime start');
    },
    async stop(slug) {
      await record('runtime stop'); assert.equal(slug, 'user1');
      state.running = false; state.replicas = 0; pods = []; await changed('runtime stop');
    },
    async execNamed(gateway, argv, _options, targetContainer) {
      assert.equal(targetContainer, 'gateway');
      await record('gateway status'); assert.equal(gateway, 'gateway-pod'); assert.deepEqual(argv.slice(-2), ['192.0.2.10', '25808']);
      assert.match(argv[2], /\/api\/auth\/status/); return { exitCode: f.gatewayHealthy ? 0 : 1, stderr: secret };
    },
    async exec(slug, argv) {
      assert.equal(slug, 'user1');
      if (argv[2] === 'test -f /data/.cc-connect/config.toml') { await record('bridge config'); return { exitCode: f.bridgeConfigured ? 0 : 1 }; }
      await record('preview link'); assert.match(argv[2], /test -L/); assert.match(argv[2], /test -s/);
      return { exitCode: f.previewValid ? 0 : 1, stderr: secret };
    },
    async processes() { await record('processes'); return f.bridgeRunning ? [{ pid: '12', args: '/opt/workpartner/bin/cc-connect --config /data/.cc-connect/config.toml' }] : []; },
  };
  const command = async (program, args) => {
    assert.equal(program, 'docker');
    if (args[0] === 'ps') {
      await record('docker list');
      return { exitCode: 0, stdout: JSON.stringify({ Names: name, State: container.State.Running ? 'running' : 'exited' }) };
    }
    if (args[0] === 'inspect') { await record('docker inspect'); return { exitCode: 0, stdout: JSON.stringify([container]) }; }
    if (args[0] === 'diff') { await record('docker diff'); return { exitCode: 0, stdout: f.diff }; }
    if (args[0] === 'exec') {
      assert.equal(args[2], '1001:1001');
      const copy = args.includes('-ec');
      await record(copy ? 'inventory copy' : 'inventory executable');
      if (!copy) return { exitCode: args.at(-1) === '/usr/local/bin/custom-cli' ? 0 : 1, stdout: '' };
      assert.match(args[6], /install -m 0755/); assert.equal(args.at(-1), 'custom-cli');
      await changed('inventory copy'); return { exitCode: 0, stdout: '' };
    }
    if (args[0] === 'update') {
      await record(`docker ${args[1]}`);
      container.HostConfig.RestartPolicy.Name = args[1].slice('--restart='.length);
      await changed(`docker ${args[1]}`);
    } else if (args[0] === 'stop') { await record('docker stop'); container.State.Running = false; await changed('docker stop'); }
    else if (args[0] === 'start') {
      await record('docker start'); assert.equal(pods.length, 0);
      assert.equal((await readOwners(ownersFile)).users.user1, 'docker');
      container.State.Running = true; await changed('docker start');
    } else assert.fail(`Unexpected Docker operation ${args[0]}`);
    return { exitCode: 0, stdout: '' };
  };
  f.dependencies = { organization, users, client, command, modelConfig: 'fixture-model-config',
    createRuntime: (org, overrides) => {
      (f.runtimeOrganizations ??= []).push(org);
      assert.equal(org.runtime.kind, 'k8s'); assert.equal(overrides.inspectCacheMs, 0); assert.equal(overrides.client, client);
      return { ...runtime, execNamed: (pod, argv, options) => runtime.execNamed(pod, argv, options, org.runtime.k8s.systemContainer ?? pod) };
    }, log: line => logs.push(line) };
  f.run = (command, apply = true, extra = {}) => runAdopt({ command, slug: command === 'status' ? undefined : 'user1', apply, ...extra }, f.dependencies);
  f.owner = async () => (await readOwners(ownersFile)).users.user1;
  f.assertSafe = () => {
    for (const snapshot of snapshots) assert.ok(!(snapshot.docker && snapshot.pods), JSON.stringify(snapshot));
    assert.ok(!logs.join('\n').includes(secret));
  };
  return f;
}

function ordered(events, expected) {
  let offset = 0;
  for (const item of expected) {
    const index = events.indexOf(item, offset);
    assert.ok(index >= offset, `Missing/out-of-order ${item}\n${events.join('\n')}`);
    offset = index + 1;
  }
}

test('CLI is dry-run by default, validates arguments and works on Node 22 without runtime imports for help', async () => {
  assert.equal(parseArgs(['switch', 'user1']).apply, false);
  assert.equal(parseArgs(['rollback', 'user1', '--apply']).apply, true);
  for (const args of [[], ['unknown'], ['switch', '../user1'], ['switch', 'a'], ['status', 'user1'], ['pv', 'user1'], ['switch', 'user1', '--node', 'node-a'], ['verify', 'user1', '--wat'], ['pv', 'user1', '--node']]) assert.throws(() => parseArgs(args));
  const output = [];
  assert.equal(await main(['--help'], { log: line => output.push(line) }), 0);
  assert.match(output.join('\n'), /Default: dry-run/);
});

test('switch follows PVC, image, Docker disable/stop, atomic ownership, isolation, create, start, verify order', async t => {
  const f = await fixture(t);
  const inode = (await fs.stat(f.ownersFile)).ino;
  f.after = async event => {
    if (event === 'docker stop') assert.equal(await f.owner(), 'docker');
    if (event === 'ensureIsolation') assert.equal(await f.owner(), 'k8s');
  };
  const result = await f.run('switch');
  assert.equal(result.exitCode, 0); assert.equal(result.verified, true);
  ordered(f.events, [`get ${core}/persistentvolumeclaims/${name}-data`, 'imageId', 'docker --restart=no', 'docker stop', 'ensureIsolation', 'runtime create', 'runtime start', 'gateway status', 'bridge config', 'processes', 'preview link', 'docker inspect']);
  ordered(f.logs, ['APPLY docker stop', 'APPLY owner -> k8s (atomic rename)', 'APPLY k8s ensureIsolation', 'APPLY k8s create', 'APPLY k8s start', 'APPLY verify Pod and expected node']);
  assert.notEqual((await fs.stat(f.ownersFile)).ino, inode);
  assert.equal((await fs.stat(f.ownersFile)).mode & 0o777, 0o640);
  assert.equal((await readOwners(f.ownersFile)).users.user2, 'docker');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['owners.json', 'secure', 'workspaces']);
  f.assertSafe();
});

test('successful switch is repeatable and does not recreate or restart the migrated workspace', async t => {
  const f = await fixture(t, { migrated: true });
  assert.equal((await f.run('switch')).exitCode, 0);
  assert.ok(!f.events.includes('runtime create')); assert.ok(!f.events.includes('docker stop')); f.assertSafe();
});

test('rollback pauses keep-running, waits for stop, changes owner, removes only published links, then enables and starts Docker', async t => {
  const f = await fixture(t, { migrated: true });
  await fs.symlink('/run/workpartner/published/.zp-preview-relay-key', path.join(f.directory, '.zp-preview-relay-key'));
  await fs.symlink('/run/workpartner/published/custom-config', path.join(f.directory, 'custom-config'));
  await fs.symlink('/run/workpartner/published-other/keep', path.join(f.directory, 'other-link'));
  await fs.symlink('/data/keep', path.join(f.directory, 'user-link'));
  await fs.writeFile(path.join(f.directory, '.zp-market-token'), 'regular-user-data');
  f.after = async event => {
    if (event === 'runtime stop') assert.equal(await f.owner(), 'k8s');
    if (event === 'docker --restart=unless-stopped') {
      assert.equal(await f.owner(), 'docker');
      await assert.rejects(fs.lstat(path.join(f.directory, '.zp-preview-relay-key')), { code: 'ENOENT' });
    }
  };
  assert.equal((await f.run('rollback')).exitCode, 0);
  ordered(f.events, ['pause', 'runtime stop', `get ${core}/pods`, 'docker --restart=unless-stopped', 'docker start']);
  ordered(f.logs, ['APPLY k8s stop and wait for Pod deletion', 'APPLY owner -> docker (atomic rename)', 'APPLY remove published link ".zp-preview-relay-key"', 'APPLY remove published link "custom-config"', 'APPLY docker restart=unless-stopped', 'APPLY docker start']);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.zp-market-token', 'other-link', 'user-link']);
  assert.equal(await fs.readFile(path.join(f.directory, '.zp-market-token'), 'utf8'), 'regular-user-data');
  f.assertSafe();
  f.after = null;
  assert.equal((await f.run('rollback')).exitCode, 0); f.assertSafe();
});

test('pv retains matching PV/PVC on rerun after API omits empty storageClassName and adds binding metadata', async t => {
  const f = await fixture(t, { oldwork: true });
  f.apiVolumeDefaults = true;
  f.objects.delete(`${core}/persistentvolumeclaims/${name}-data`);
  f.objects.delete(`/api/v1/persistentvolumes/workspaces-${name}-data`);
  const options = { node: 'node-a', 'data-root': f.root };
  const result = await f.run('pv', true, options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(f.events.filter(event => event.startsWith('create ')), [
    `create PersistentVolume workspaces-${name}-data`, `create PersistentVolumeClaim ${name}-data`,
    `create PersistentVolume workspaces-${name}-oldwork`, `create PersistentVolumeClaim ${name}-oldwork`,
  ]);
  const [volume, claim, old] = result.manifests;
  assert.equal(volume.spec.local.path, f.directory); assert.equal(volume.spec.persistentVolumeReclaimPolicy, 'Retain');
  assert.deepEqual(volume.spec.claimRef, { namespace: 'workspaces', name: `${name}-data` });
  assert.deepEqual(volume.spec.nodeAffinity.required.nodeSelectorTerms[0].matchFields[0].values, ['node-a']);
  assert.equal(claim.spec.volumeName, volume.metadata.name); assert.equal(claim.spec.storageClassName, '');
  assert.deepEqual(old.spec.accessModes, ['ReadOnlyMany']);
  assert.equal(old.spec.local.path, path.join(f.root, 'users/user1/work'));
  f.events.length = 0;
  assert.equal((await f.run('pv', true, options)).exitCode, 0);
  assert.ok(!f.events.some(event => event.startsWith('create ')));
});

test('pv validates all existing bindings before writing; a conflicting old-work PVC leaves data PV untouched', async t => {
  const f = await fixture(t, { oldwork: true });
  f.objects.delete(`${core}/persistentvolumeclaims/${name}-data`); f.objects.delete(`/api/v1/persistentvolumes/workspaces-${name}-data`);
  f.objects.set(`${core}/persistentvolumeclaims/${name}-oldwork`, { spec: { volumeName: 'another-users-data' } });
  assert.equal((await f.run('pv', true, { node: 'node-a', 'data-root': f.root })).exitCode, 1);
  assert.ok(!f.events.some(event => event.startsWith('create '))); assert.match(f.logs.at(-1), /NEXT:.*Do not delete data/);
});

test('inventory diffs before executable checks and copies only eligible files as runtime uid', async t => {
  const f = await fixture(t);
  const result = await f.run('inventory');
  assert.equal(result.exitCode, 0);
  ordered(f.events, ['docker diff', 'inventory executable', 'inventory copy', 'inventory executable']);
  assert.deepEqual(result.inventory.map(item => item.action), ['copy', 'needs-running-container-or-readable-executable', 'report-only', 'report-only']);
  assert.equal(f.events.filter(event => event === 'inventory copy').length, 1);
});

for (const command of ['pv', 'inventory', 'switch', 'rollback', 'verify', 'status']) {
  test(`${command} dry-run issues no writes, Docker exec, or runtime exec and leaves files intact`, async t => {
    const f = await fixture(t, { migrated: ['rollback', 'verify'].includes(command) });
    await fs.symlink('/run/workpartner/published/.zp-preview-relay-key', path.join(f.directory, '.zp-preview-relay-key'));
    const before = await fs.readFile(f.ownersFile, 'utf8'), inode = (await fs.stat(f.ownersFile)).ino;
    if (command === 'pv') {
      f.objects.delete(`${core}/persistentvolumeclaims/${name}-data`); f.objects.delete(`/api/v1/persistentvolumes/workspaces-${name}-data`);
    }
    const result = await f.run(command, false, { node: 'node-a', 'data-root': f.root });
    assert.equal(result.exitCode, 0); assert.equal(result.dryRun, true);
    assert.equal(f.snapshots.length, 0);
    assert.ok(!f.events.some(event => /^(runtime (create|start|stop)|pause|unpause|create |gateway status|bridge config|processes|preview link|inventory (executable|copy))/.test(event)));
    assert.equal(await fs.readFile(f.ownersFile, 'utf8'), before); assert.equal((await fs.stat(f.ownersFile)).ino, inode);
    assert.ok((await fs.lstat(path.join(f.directory, '.zp-preview-relay-key'))).isSymbolicLink());
    assert.ok(!(await fs.readdir(f.root)).some(name => name.endsWith('.lock') || name.endsWith('.tmp')));
    if (command === 'verify') assert.equal(result.verified, false);
  });
}

for (const failed of ['imageId', 'docker --restart=no', 'docker stop', 'ensureIsolation', 'runtime create', 'runtime start', 'gateway status', 'bridge config', 'processes', 'preview link']) {
  test(`switch fails safely at ${failed}, logs recovery, and never logs upstream secrets`, async t => {
    const f = await fixture(t); f.fail = failed;
    assert.equal((await f.run('switch')).exitCode, 1);
    assert.match(f.logs.at(-1), /FAILED.*NEXT:/);
    f.assertSafe();
    if (['imageId', 'docker --restart=no', 'docker stop'].includes(failed)) {
      assert.equal(await f.owner(), 'docker'); assert.ok(!f.events.includes('runtime start'));
    } else { assert.equal(await f.owner(), 'k8s'); assert.equal(f.container.State.Running, false); }
    assert.ok(!(await fs.readdir(f.root)).some(name => name.endsWith('.lock')));
  });
}

for (const failed of ['pause', 'runtime stop', 'docker --restart=unless-stopped', 'docker start']) {
  test(`rollback fails safely at ${failed} and logs a next step`, async t => {
    const f = await fixture(t, { migrated: true }); f.fail = failed;
    assert.equal((await f.run('rollback')).exitCode, 1); assert.match(f.logs.at(-1), /FAILED.*NEXT:/);
    f.assertSafe(); assert.equal(f.container.State.Running, false);
    if (['pause', 'runtime stop'].includes(failed)) assert.equal(await f.owner(), 'k8s');
  });
}

test('rollback independently confirms Pod deletion, including terminating and job Pods, before changing ownership', async t => {
  const f = await fixture(t, { migrated: true });
  f.after = async event => { if (event === 'runtime stop') f.pods = [{ ...f.pod('user1', 'job'), metadata: { ...f.pod('user1', 'job').metadata, deletionTimestamp: '2026-11-10T00:00:00Z' } }]; };
  assert.equal((await f.run('rollback')).exitCode, 1); assert.equal(await f.owner(), 'k8s');
  assert.ok(!f.events.includes('docker start')); assert.match(f.logs.at(-1), /never start Docker/);
});

test('failed atomic ownership replacement stops switch before any runtime start', async t => {
  const f = await fixture(t);
  f.after = async event => { if (event === 'docker stop') await fs.rename(f.ownersFile, `${f.ownersFile}.saved`); };
  assert.equal((await f.run('switch')).exitCode, 1);
  assert.equal(f.container.State.Running, false); assert.ok(!f.events.includes('ensureIsolation')); assert.ok(!f.events.includes('runtime start'));
  assert.match(f.logs.at(-1), /owner -> k8s.*NEXT:.*Keep Docker stopped/);
});

test('stateful start that succeeds remotely then throws leaves Docker disabled and recovery is rollback', async t => {
  const f = await fixture(t);
  f.after = async event => { if (event === 'runtime start') throw new Error(secret); };
  assert.equal((await f.run('switch')).exitCode, 1);
  assert.equal(f.pods.length, 1); assert.equal(f.container.State.Running, false); assert.equal(f.container.HostConfig.RestartPolicy.Name, 'no');
  assert.match(f.logs.at(-1), /rollback --apply/); f.assertSafe();
});

test('duplicate found during switch confirms zero replicas and no Pods then restores Docker ownership', async t => {
  const f = await fixture(t, { migrated: true }); f.container.State.Running = true;
  assert.equal((await f.run('switch')).exitCode, 1);
  assert.equal(f.pods.length, 0); assert.equal(f.container.State.Running, true);
  assert.equal(f.state.replicas, 0); assert.equal(await f.owner(), 'docker');
  assert.ok(!f.events.includes('runtime start')); assert.match(f.logs.at(-1), /Duplicate instances/);
  assert.match(f.logs.at(-1), /owner is docker/);
  assert.match(f.logs.at(-1), /FAILED at duplicate instances detected/);
  assert.ok(!f.logs.at(-1).includes('FAILED at owner -> docker'));
  assert.equal((await f.run('status')).exitCode, 0);
});

for (const reappeared of ['replicas', 'pod']) {
  test(`duplicate cleanup refuses ownership change when ${reappeared} reappears after stop`, async t => {
    const f = await fixture(t, { migrated: true }); f.container.State.Running = true;
    f.after = async event => {
      if (event === 'runtime stop') {
        if (reappeared === 'replicas') f.state.replicas = 1;
        else f.pods = [f.pod('user1', 'job')];
      }
    };
    assert.equal((await f.run('switch')).exitCode, 1);
    assert.equal(await f.owner(), 'k8s');
    assert.ok(!f.logs.some(line => line.includes('owner -> docker')));
    assert.match(f.logs.at(-1), /NEXT:.*confirm.*replicas/);
  });
}

for (const replicas of [1, null]) {
  test(`rollback refuses Docker start when StatefulSet replicas becomes ${replicas} during docker update`, async t => {
    const f = await fixture(t, { migrated: true });
    f.after = async event => { if (event === 'docker --restart=unless-stopped') f.state.replicas = replicas; };
    assert.equal((await f.run('rollback')).exitCode, 1);
    assert.equal(await f.owner(), 'docker'); assert.equal(f.pods.length, 0);
    assert.equal(f.container.State.Running, false); assert.ok(!f.events.includes('docker start'));
    assert.match(f.logs.at(-1), /replicas.*NEXT:/);
  });
}

test('rollback refuses Docker start when a Pod reappears during docker update despite zero replicas', async t => {
  const f = await fixture(t, { migrated: true });
  f.after = async event => { if (event === 'docker --restart=unless-stopped') f.pods = [f.pod('user1', 'job')]; };
  assert.equal((await f.run('rollback')).exitCode, 1);
  assert.equal(f.state.replicas, 0); assert.equal(f.container.State.Running, false);
  assert.ok(!f.events.includes('docker start'));
});

for (const change of ['owner', 'docker']) {
  test(`switch refuses runtime start when ${change} changes during create`, async t => {
    const f = await fixture(t);
    f.after = async event => {
      if (event === 'runtime create') {
        if (change === 'owner') await writeOwner(f.ownersFile, 'user1', 'docker');
        else f.container.State.Running = true;
      }
    };
    assert.equal((await f.run('switch')).exitCode, 1);
    assert.ok(!f.events.includes('runtime start')); assert.equal(f.pods.length, 0);
    assert.match(f.logs.at(-1), /k8s start.*NEXT:/);
  });
}

for (const failure of ['unbound', 'image', 'wrong-data', 'oldwork-unbound', 'replicas']) {
  test(`switch rejects ${failure} preflight without stopping Docker or writing ownership`, async t => {
    const f = await fixture(t);
    if (failure === 'unbound') f.objects.get(`${core}/persistentvolumeclaims/${name}-data`).status.phase = 'Pending';
    if (failure === 'image') f.image = null;
    if (failure === 'wrong-data') f.container.Mounts[0].Source = path.join(f.root, 'other');
    if (failure === 'oldwork-unbound') f.objects.set(`${core}/persistentvolumeclaims/${name}-oldwork`, { status: { phase: 'Pending' } });
    if (failure === 'replicas') Object.assign(f.state, { exists: true, replicas: 1 });
    assert.equal((await f.run('switch')).exitCode, 1); assert.equal(await f.owner(), 'docker');
    assert.equal(f.snapshots.length, 0); assert.equal(f.container.State.Running, true);
  });
}

for (const failure of ['node', 'gateway', 'bridge', 'preview', 'docker', 'extra-pod', 'not-running']) {
  test(`verify detects ${failure} failure and returns nonzero`, async t => {
    const f = await fixture(t, { migrated: true });
    if (failure === 'node') f.pods[0].spec.nodeName = 'node-b';
    if (failure === 'gateway') f.gatewayHealthy = false;
    if (failure === 'bridge') f.bridgeRunning = false;
    if (failure === 'preview') f.previewValid = false;
    if (failure === 'docker') f.container.State.Running = true;
    if (failure === 'extra-pod') f.pods.push(f.pod('user1', 'job'));
    if (failure === 'not-running') f.state.running = false;
    assert.equal((await f.run('verify')).exitCode, 1); assert.match(f.logs.at(-1), /NEXT:/);
  });
}

test('verify skips cc-connect process requirement when configuration is absent', async t => {
  const f = await fixture(t, { migrated: true }); f.bridgeConfigured = false; f.bridgeRunning = false;
  assert.equal((await f.run('verify')).exitCode, 0);
  assert.ok(!f.events.includes('processes'));
});

test('verify uses real createRuntime and K2b with gateway container and workspace container through fake K1', async t => {
  const f = await fixture(t, { migrated: true });
  const get = f.dependencies.client.get;
  Object.assign(f.pods[0].status, { podIP: '192.0.2.10', containerStatuses: [{ name: 'workspace', state: { running: {} } }] });
  f.dependencies.client.get = async route => {
    if (route === `${apps}/${name}`) return { spec: { replicas: 1, template: { spec: { containers: [{ name: 'workspace', image: 'workspace:test' }] } } }, metadata: { annotations: {} } };
    if (route === `${core}/pods/${name}-0`) return structuredClone(f.pods[0]);
    return get(route);
  };
  const calls = [];
  f.dependencies.client.exec = async (namespace, pod, container, argv) => {
    calls.push({ namespace, pod, container });
    if (namespace === 'system') {
      assert.equal(container, 'gateway');
      assert.equal(pod, 'gateway-pod');
      assert.match(argv[2], /\/api\/auth\/status/);
    } else {
      assert.equal(namespace, 'workspaces'); assert.equal(pod, `${name}-0`); assert.equal(container, 'workspace');
    }
    return { exitCode: 0, stdout: argv.at(-1) === '/proc' ? JSON.stringify([{ pid: '12', ppid: '1', args: '/opt/bin/cc-connect' }]) : '', stderr: '', logs: '' };
  };
  f.organization.runtime.k8s.systemContainer = 'other-system';
  f.dependencies.createRuntime = createRuntime;
  assert.equal((await f.run('verify')).exitCode, 0, f.logs.join('\n'));
  assert.deepEqual(calls.map(call => call.container), ['gateway', 'workspace', 'workspace', 'workspace']);
  assert.equal(f.organization.runtime.k8s.systemContainer, 'other-system');
});

for (const alarm of ['k8s-owner-docker-running', 'docker-owner-pod-exists', 'multiple-pods']) {
  test(`status reports ${alarm}, lists all users and returns nonzero without writes even with --apply`, async t => {
    const f = await fixture(t, { migrated: alarm !== 'docker-owner-pod-exists' });
    if (alarm === 'k8s-owner-docker-running') f.container.State.Running = true;
    if (alarm === 'docker-owner-pod-exists') f.pods = [f.pod()];
    if (alarm === 'multiple-pods') f.pods.push(f.pod('user1', 'job'));
    const result = await f.run('status');
    assert.equal(result.exitCode, 1); assert.ok(result.alarms.some(item => item.alarm === alarm));
    assert.deepEqual(result.rows.map(row => row.slug), ['user1', 'user2']);
    assert.match(f.logs.join('\n'), new RegExp(`ALARM user1 ${alarm}`)); assert.equal(f.snapshots.length, 0);
    assert.equal(await main(['status', '--apply'], f.dependencies), 1);
  });
}

test('status discovers orphan and terminating Pods, defaults ownership, and forces legacy users to Docker', async t => {
  const f = await fixture(t);
  await writeOwner(f.ownersFile, 'user2', 'k8s');
  f.pods = [f.pod('orphan'), f.pod('user2')];
  f.pods[0].metadata.deletionTimestamp = '2026-11-10T00:00:00Z';
  const result = await f.run('status', false);
  assert.equal(result.exitCode, 1); assert.deepEqual(result.rows.map(row => row.slug), ['orphan', 'user1', 'user2']);
  assert.equal(result.rows.find(row => row.slug === 'user2').owner, 'docker');
  assert.deepEqual(result.alarms.map(item => item.slug), ['orphan', 'user2']);
});

test('healthy status exits zero and legacy user cannot be migrated', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('status')).exitCode, 0);
  assert.equal((await f.run('switch', true, { slug: 'user2' })).exitCode, 1);
  assert.equal(f.snapshots.length, 0);
});

test('missing or malformed ownership file fails closed without writes', async t => {
  const f = await fixture(t);
  for (const value of [secret, JSON.stringify({ version: 2, default: 'docker', users: {} }), JSON.stringify({ version: 1, default: 'docker', users: { user1: 'unknown' } })]) {
    await fs.writeFile(f.ownersFile, value);
    assert.equal((await f.run('switch')).exitCode, 1);
  }
  await fs.unlink(f.ownersFile);
  assert.equal((await f.run('rollback')).exitCode, 1); assert.equal(f.events.length, 0); assert.ok(!f.logs.join('\n').includes(secret));
});

test('apply refuses an existing operation lock and does not remove another process lock', async t => {
  const f = await fixture(t);
  await fs.writeFile(`${f.ownersFile}.adopt.lock`, 'held');
  assert.equal((await f.run('switch')).exitCode, 1);
  assert.equal(f.events.length, 0); assert.equal(await fs.readFile(`${f.ownersFile}.adopt.lock`, 'utf8'), 'held');
  assert.equal((await f.run('switch', false)).exitCode, 0);
});

test('atomic owner updates preserve defaults and other users through repeated replacements', async t => {
  const f = await fixture(t);
  await writeOwner(f.ownersFile, 'user1', 'k8s'); await writeOwner(f.ownersFile, 'user2', 'k8s'); await writeOwner(f.ownersFile, 'user1', 'docker');
  assert.deepEqual(await readOwners(f.ownersFile), { version: 1, default: 'docker', users: { user1: 'docker', user2: 'k8s' } });
  assert.ok(!(await fs.readdir(f.root)).some(name => name.endsWith('.tmp')));
});

test('pv partial failure rerun retains API-normalized PV and creates only the missing PVC', async t => {
  const f = await fixture(t);
  f.apiVolumeDefaults = true;
  f.objects.delete(`${core}/persistentvolumeclaims/${name}-data`); f.objects.delete(`/api/v1/persistentvolumes/workspaces-${name}-data`);
  f.fail = `create PersistentVolumeClaim ${name}-data`;
  const options = { node: 'node-a', 'data-root': f.root };
  assert.equal((await f.run('pv', true, options)).exitCode, 1);
  assert.equal(f.objects.get(`/api/v1/persistentvolumes/workspaces-${name}-data`).spec.claimRef.name, `${name}-data`);
  assert.match(f.logs.at(-1), /NEXT:.*rerun pv/); f.assertSafe();
  f.fail = null; f.events.length = 0;
  assert.equal((await f.run('pv', true, options)).exitCode, 0);
  assert.deepEqual(f.events.filter(event => event.startsWith('create ')), [`create PersistentVolumeClaim ${name}-data`]);
});

test('inventory copy failure stops immediately with manual recovery and no lifecycle writes', async t => {
  const f = await fixture(t); f.fail = 'inventory copy';
  assert.equal((await f.run('inventory')).exitCode, 1);
  assert.equal(f.events.at(-1), 'inventory copy'); assert.equal(f.snapshots.length, 0);
  assert.equal(await f.owner(), 'docker'); assert.match(f.logs.at(-1), /NEXT:.*inventory/); f.assertSafe();
});

test('rollback ownership failure leaves Docker stopped and paused Pod deleted', async t => {
  const f = await fixture(t, { migrated: true });
  f.after = async event => { if (event === 'runtime stop') await fs.rename(f.ownersFile, `${f.ownersFile}.saved`); };
  assert.equal((await f.run('rollback')).exitCode, 1);
  assert.equal(f.pods.length, 0); assert.equal(f.container.State.Running, false);
  assert.ok(!f.events.includes('docker --restart=unless-stopped')); assert.match(f.logs.at(-1), /owner -> docker.*NEXT:/);
});

test('rollback link cleanup failure never enables or starts Docker', async t => {
  const f = await fixture(t, { migrated: true });
  await fs.symlink('/run/workpartner/published/.zp-preview-relay-key', path.join(f.directory, '.zp-preview-relay-key'));
  f.after = async event => { if (event === 'runtime stop') await fs.rename(f.directory, `${f.directory}-moved`); };
  assert.equal((await f.run('rollback')).exitCode, 1);
  assert.equal(await f.owner(), 'docker'); assert.equal(f.container.State.Running, false); assert.equal(f.pods.length, 0);
  assert.ok(!f.events.includes('docker --restart=unless-stopped'));
  assert.match(f.logs.at(-1), /NEXT:.*published-link cleanup/); f.assertSafe();
});

test('switch clears a rollback pause only after ownership, isolation and create, before start', async t => {
  const f = await fixture(t, { migrated: true });
  assert.equal((await f.run('rollback')).exitCode, 0);
  f.events.length = 0;
  assert.equal((await f.run('switch')).exitCode, 0);
  ordered(f.events, ['docker stop', 'ensureIsolation', 'runtime create', 'unpause', 'runtime start']);
  assert.equal(f.state.annotations['workpartner/paused'], undefined); f.assertSafe();
});

test('status follows Kubernetes list pagination so duplicates on another page cannot be missed', async t => {
  const f = await fixture(t, { migrated: true });
  const get = f.dependencies.client.get;
  f.dependencies.client.get = async route => {
    if (route === `${core}/pods`) return { items: [f.pod()], metadata: { continue: 'next-page' } };
    if (route === `${core}/pods?continue=next-page`) return { items: [f.pod('user1', 'job')] };
    return get(route);
  };
  const result = await f.run('status');
  assert.equal(result.exitCode, 1); assert.deepEqual(result.alarms, [{ slug: 'user1', alarm: 'multiple-pods' }]);
});

test('status displays the legacy Docker container using the configured legacy prefix', async t => {
  const f = await fixture(t);
  f.organization.runtime.containerPrefix = 'legacy-';
  const command = f.dependencies.command;
  f.dependencies.command = async (program, args) => {
    const value = await command(program, args);
    if (args[0] === 'ps') value.stdout += `\n${JSON.stringify({ Names: 'legacy-user2', State: 'running' })}`;
    return value;
  };
  const result = await f.run('status');
  assert.equal(result.exitCode, 0); assert.equal(result.rows.find(row => row.slug === 'user2').docker, 'running');
});

test('Docker API errors cannot masquerade as an absent container during verify', async t => {
  const f = await fixture(t, { migrated: true }); f.fail = 'docker list';
  assert.equal((await f.run('verify')).exitCode, 1); assert.match(f.logs.at(-1), /verify Docker stopped/);
  assert.ok(!f.logs.join('\n').includes(secret));
});

test('rollback scans published links after Pod deletion, including links created during shutdown', async t => {
  const f = await fixture(t, { migrated: true });
  f.after = async event => {
    if (event === 'runtime stop') await fs.symlink('/run/workpartner/published/late-config', path.join(f.directory, 'late-config'));
  };
  assert.equal((await f.run('rollback')).exitCode, 0);
  await assert.rejects(fs.lstat(path.join(f.directory, 'late-config')), { code: 'ENOENT' }); f.assertSafe();
});

test('ownership defaults use own properties even for a slug named constructor', async t => {
  const f = await fixture(t);
  f.users.push({ slug: 'constructor', backend: 'aionui' });
  const result = await f.run('status');
  assert.equal(result.exitCode, 0);
  assert.equal(result.rows.find(row => row.slug === 'constructor').owner, 'docker');
});

test('host path options map secure directory and ownership file without changing organization config', async t => {
  const f = await fixture(t);
  const hostSecure = f.organization.runtime.secureDirectory;
  f.organization.runtime.secureDirectory = '/gateway/secure';
  f.organization.runtime.hostSecure = '/host/secure';
  f.organization.runtime.migration.ownersFile = '/gateway/owners.json';
  const options = parseArgs(['switch', 'user1', '--apply', '--host-secure', hostSecure, '--owners-file', f.ownersFile]);
  assert.equal((await runAdopt(options, f.dependencies)).exitCode, 0, f.logs.join('\n'));
  assert.equal(await f.owner(), 'k8s');
  assert.ok(f.runtimeOrganizations.every(org => org.runtime.secureDirectory === hostSecure));
  assert.equal(f.organization.runtime.secureDirectory, '/gateway/secure');
  assert.equal(f.organization.runtime.migration.ownersFile, '/gateway/owners.json');
  assert.ok(!(await fs.readdir(f.root)).some(file => file.endsWith('.lock')));
  for (const flag of ['--host-secure', '--owners-file']) assert.throws(() => parseArgs(['status', flag, 'relative/path']));
});

test('host secure directory defaults to runtime.hostSecure for runtime create', async t => {
  const f = await fixture(t);
  const hostSecure = f.organization.runtime.secureDirectory;
  f.organization.runtime.secureDirectory = '/gateway/secure';
  f.organization.runtime.hostSecure = hostSecure;
  assert.equal((await f.run('switch')).exitCode, 0);
  assert.ok(f.runtimeOrganizations.every(org => org.runtime.secureDirectory === hostSecure));
  assert.equal(f.organization.runtime.secureDirectory, '/gateway/secure');
});

test('empty hostSecure falls back to secureDirectory for switch and runtime create', async t => {
  const f = await fixture(t);
  f.organization.runtime.hostSecure = '';
  assert.equal((await f.run('switch')).exitCode, 0, f.logs.join('\n'));
  const options = parseArgs(['switch', 'user1', '--apply', '--host-secure', '']);
  assert.equal((await runAdopt(options, f.dependencies)).exitCode, 0, f.logs.join('\n'));
  assert.ok(f.runtimeOrganizations.length > 0);
  assert.ok(f.runtimeOrganizations.every(org => org.runtime.secureDirectory === f.organization.runtime.secureDirectory));
  assert.equal(f.organization.runtime.hostSecure, '');
  ordered(f.logs, ['APPLY switch preflight: readable model key', 'APPLY docker restart=no', 'APPLY docker stop']);
  f.assertSafe();
});

for (const command of ['switch', 'pv', 'inventory', 'rollback', 'verify', 'status']) {
  test(`${command} rejects nonabsolute final key directory before any write or runtime construction`, async t => {
    const f = await fixture(t);
    const before = await fs.readFile(f.ownersFile, 'utf8'), inode = (await fs.stat(f.ownersFile)).ino;
    const open = fs.open;
    t.mock.method(fs, 'open', async (filename, flags, ...args) => {
      assert.equal(flags, 'r', 'invalid key directory must not even create an operation lock');
      return open(filename, flags, ...args);
    });
    for (const config of [
      { hostSecure: '', secureDirectory: 'relative/keys' },
      { hostSecure: 'relative/host-keys', secureDirectory: path.join(f.root, 'secure') },
      { hostSecure: '', secureDirectory: '' },
      { hostSecure: undefined, secureDirectory: undefined },
    ]) {
      Object.assign(f.organization.runtime, config);
      const result = await f.run(command, true, { node: 'node-a', 'data-root': f.root });
      assert.equal(result.exitCode, 1); assert.equal(result.failedStage, 'configuration');
      assert.match(f.logs.at(-1), /Key directory must be absolute/);
    }
    assert.equal(f.runtimeOrganizations, undefined);
    assert.deepEqual(f.events, []); assert.deepEqual(f.snapshots, []);
    assert.equal(await fs.readFile(f.ownersFile, 'utf8'), before);
    assert.equal((await fs.stat(f.ownersFile)).ino, inode);
    assert.equal(f.container.State.Running, true);
    assert.deepEqual((await fs.readdir(f.root)).sort(), ['owners.json', 'secure', 'workspaces']);
  });
}

for (const problem of ['missing', 'unreadable', 'directory']) {
  test(`switch rejects ${problem} model key before stopping Docker in apply and dry-run`, async t => {
    const f = await fixture(t);
    const filename = path.join(f.organization.runtime.secureDirectory, 'model-user1.key');
    if (problem === 'unreadable') {
      // Deterministic even when tests run as root, which can read chmod 000 files.
      const open = fs.open;
      t.mock.method(fs, 'open', async (target, ...args) => {
        if (target === filename) throw Object.assign(new Error(secret), { code: 'EACCES' });
        return open(target, ...args);
      });
    } else {
      await fs.unlink(filename);
      if (problem === 'directory') await fs.mkdir(filename);
    }
    await fs.writeFile(path.join(f.organization.runtime.secureDirectory, 'model-user2.key'), secret);
    const before = await fs.readFile(f.ownersFile, 'utf8'), inode = (await fs.stat(f.ownersFile)).ino;
    for (const apply of [false, true]) {
      const result = await f.run('switch', apply);
      assert.equal(result.exitCode, 1); assert.equal(result.failedStage, 'switch preflight: readable model key');
      assert.match(f.logs.at(-1), /Model key file must exist and be readable.*NEXT:.*preflight/);
    }
    assert.equal(f.container.State.Running, true);
    assert.equal(f.container.HostConfig.RestartPolicy.Name, 'unless-stopped');
    assert.ok(!f.events.includes('docker stop')); assert.equal(f.snapshots.length, 0);
    assert.equal(await fs.readFile(f.ownersFile, 'utf8'), before);
    assert.equal((await fs.stat(f.ownersFile)).ino, inode);
    f.assertSafe();
  });
}

test('switch checks the configured model keyPrefix for the selected user', async t => {
  const f = await fixture(t);
  f.organization.model = { keyPrefix: 'custom-' };
  assert.equal((await f.run('switch')).exitCode, 1, 'the default-prefix key must not satisfy this check');
  assert.equal(f.container.State.Running, true); assert.equal(f.snapshots.length, 0);
  await fs.rename(path.join(f.organization.runtime.secureDirectory, 'model-user1.key'), path.join(f.organization.runtime.secureDirectory, 'custom-user1.key'));
  assert.equal((await f.run('switch')).exitCode, 0, f.logs.join('\n'));
  f.assertSafe();
});

test('duplicate dry-run reports detection without claiming owner write failure or issuing writes', async t => {
  const f = await fixture(t, { migrated: true }); f.container.State.Running = true;
  const before = await fs.readFile(f.ownersFile, 'utf8');
  const open = fs.open;
  t.mock.method(fs, 'open', async (filename, flags, ...args) => {
    assert.equal(flags, 'r');
    return open(filename, flags, ...args);
  });
  const result = await f.run('switch', false);
  assert.equal(result.exitCode, 1); assert.equal(result.failedStage, 'duplicate instances detected');
  assert.match(f.logs.at(-1), /FAILED at duplicate instances detected/);
  assert.ok(!f.logs.at(-1).includes('owner -> docker'));
  assert.ok(!f.logs.at(-1).includes('owner is docker'));
  assert.equal(f.snapshots.length, 0);
  assert.equal(await fs.readFile(f.ownersFile, 'utf8'), before);
  assert.equal(f.container.State.Running, true); assert.equal(f.pods.length, 1); assert.equal(f.state.replicas, 1);
});

for (const reappeared of ['replicas', 'pod']) {
  test(`duplicate cleanup alarms when ${reappeared} reappears after Docker ownership is restored`, async t => {
    const f = await fixture(t, { migrated: true }); f.container.State.Running = true;
    const factory = f.dependencies.createRuntime;
    let checkedAfterOwner = false;
    f.dependencies.createRuntime = (...args) => {
      const runtime = factory(...args);
      return { ...runtime, inspect: async slug => {
        if (await f.owner() === 'docker') {
          checkedAfterOwner = true;
          if (reappeared === 'replicas') f.state.replicas = 1;
          else f.pods = [f.pod('user1', 'job')];
        }
        return runtime.inspect(slug);
      } };
    };
    const result = await f.run('switch');
    assert.equal(result.exitCode, 1); assert.equal(checkedAfterOwner, true);
    assert.equal(result.failedStage, 'confirm duplicate k8s stopped after owner -> docker');
    assert.equal(await f.owner(), 'docker'); assert.equal(f.container.State.Running, true);
    assert.match(f.logs.at(-1), /NEXT:.*rollback --apply/);
    assert.ok(!f.logs.at(-1).includes('Pod stopped; owner is docker'));
    assert.ok(!f.events.includes('runtime start'));
  });
}

test('status lists invalid slugs only as skipped and exits zero when valid users are healthy', async t => {
  const f = await fixture(t);
  f.users.push({ slug: 'Legacy_User', backend: 'legacy' });
  f.pods.push(f.pod('bad_pod'));
  const result = await f.run('status');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.skipped, [{ slug: 'Legacy_User', reason: 'invalid-slug' }, { slug: 'bad_pod', reason: 'invalid-slug' }]);
  assert.deepEqual(result.alarms, []);
  assert.equal(f.logs.filter(line => line.startsWith('SKIP ')).length, 2);
  assert.ok(!f.logs.some(line => line.startsWith('ALARM ')));
  assert.ok(!f.events.some(event => /^inspect .*_/.test(event)));
  assert.equal(await main(['status'], f.dependencies), 0);
  assert.equal(f.snapshots.length, 0);
});

test('pv rerun accepts API-normalized capacity and requests: 20480Mi equals 20Gi', async t => {
  const f = await fixture(t, { oldwork: true });
  f.organization.runtime.k8s.dataVolumeSize = '20480Mi';
  f.objects.delete(`${core}/persistentvolumeclaims/${name}-data`);
  f.objects.delete(`/api/v1/persistentvolumes/workspaces-${name}-data`);
  const options = { node: 'node-a', 'data-root': f.root };
  assert.equal((await f.run('pv', true, options)).exitCode, 0);
  for (const [route, object] of f.objects) {
    if (route.includes('/persistentvolumes/')) object.spec.capacity.storage = '20Gi';
    if (route.includes('/persistentvolumeclaims/')) object.spec.resources.requests.storage = '20Gi';
  }
  f.apiVolumeDefaults = true; f.events.length = 0; f.snapshots.length = 0;
  assert.equal((await f.run('pv', true, options)).exitCode, 0, f.logs.join('\n'));
  assert.ok(!f.events.some(event => event.startsWith('create '))); assert.equal(f.snapshots.length, 0);
  for (const suffix of ['data', 'oldwork']) {
    for (const kind of ['capacity', 'requests']) {
      const object = f.objects.get(kind === 'capacity' ? `/api/v1/persistentvolumes/workspaces-${name}-${suffix}` : `${core}/persistentvolumeclaims/${name}-${suffix}`);
      const storage = kind === 'capacity' ? object.spec.capacity : object.spec.resources.requests;
      storage.storage = '21Gi';
      assert.equal((await f.run('pv', true, options)).exitCode, 1);
      assert.equal(f.snapshots.length, 0);
      storage.storage = '20Gi';
    }
  }
});

test('storage quantities compare exactly without normalizing unrelated fields', () => {
  const volume = storage => ({ spec: { capacity: { storage } } });
  for (const [left, right] of [['1.5Gi', '1536Mi'], ['20G', '20000000000'], ['2e10', '20G'], ['1m', '1000u'], ['1u', '1000n'], ['.5Ki', '512'], ['1Ei', '1152921504606846976']]) {
    assert.equal(matches(volume(left), volume(right)), true, `${left} = ${right}`);
    assert.equal(matches(volume(right), volume(left)), true);
  }
  for (const [left, right] of [['20G', '20Gi'], ['1Ei', '1152921504606846977'], ['invalid', '20Gi'], ['1e9999999', '1']]) {
    assert.equal(matches(volume(left), volume(right)), false, `${left} != ${right}`);
  }
  assert.equal(matches({ metadata: { name: '20480Mi' } }, { metadata: { name: '20Gi' } }), false);
  assert.equal(matches({ spec: { local: { path: '/20480Mi' } } }, { spec: { local: { path: '/20Gi' } } }), false);
});

test('status skips and reports invalid legacy slugs while still detecting valid-user duplicate alarms', async t => {
  const f = await fixture(t, { migrated: true });
  f.users.push({ slug: 'Legacy_User', backend: 'legacy' });
  const owners = JSON.parse(await fs.readFile(f.ownersFile, 'utf8'));
  owners.users['old_owner'] = 'docker';
  await fs.writeFile(f.ownersFile, JSON.stringify(owners));
  f.pods.push(f.pod('bad_pod'), f.pod('user1', 'job'));
  const result = await f.run('status');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.rows.map(row => row.slug), ['user1', 'user2']);
  assert.deepEqual(result.skipped.map(row => row.slug), ['Legacy_User', 'bad_pod', 'old_owner']);
  assert.ok(result.alarms.some(item => item.slug === 'user1' && item.alarm === 'multiple-pods'));
  assert.ok(result.alarms.every(item => item.slug === 'user1'));
  assert.ok(!f.events.some(event => /^inspect .*_/.test(event)));
  assert.ok(!f.logs.some(line => line.startsWith('FAILED')));
  assert.equal(f.snapshots.length, 0);
  assert.equal((await f.run('inventory')).exitCode, 1);
  f.users.pop();
  assert.equal((await f.run('inventory')).exitCode, 1);
});

for (const command of ['pv', 'inventory']) {
  test(`${command} pre-step failure reports command stage instead of lock acquisition`, async t => {
    const f = await fixture(t);
    if (command === 'inventory') f.fail = 'docker list';
    for (const apply of [false, true]) {
      const result = await f.run(command, apply);
      assert.equal(result.exitCode, 1); assert.equal(result.failedStage, command);
      assert.ok(!f.logs.at(-1).includes('acquire operation lock'));
    }
  });
}

for (const broken of [false, true]) {
  test(`inventory reports ${broken ? 'broken' : 'executable'} symlink target without copying it (real shell probe)`, async t => {
    const f = await fixture(t);
    f.diff = 'A /usr/local/bin/custom-cli\n';
    const bin = path.join(f.root, 'usr/local/bin');
    const target = '../lib/node_modules/example-cli/cli.js';
    await fs.mkdir(bin, { recursive: true });
    if (!broken) {
      await fs.mkdir(path.resolve(bin, path.dirname(target)), { recursive: true });
      await fs.writeFile(path.resolve(bin, target), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    await fs.symlink(target, path.join(bin, 'custom-cli'));
    const command = f.dependencies.command;
    f.dependencies.command = async (program, args) => {
      if (args[0] !== 'exec') return command(program, args);
      assert.equal(args[5], '-c', 'symlink must not reach install');
      try {
        return { exitCode: 0, stdout: execFileSync('sh', [...args.slice(5, -1), path.join(bin, 'custom-cli')], { encoding: 'utf8' }) };
      } catch (error) { return { exitCode: error.status, stdout: error.stdout }; }
    };
    const result = await f.run('inventory');
    assert.equal(result.exitCode, 0, f.logs.join('\n'));
    assert.deepEqual(result.inventory, [{ change: 'A', path: '/usr/local/bin/custom-cli', action: 'symlink-review', linkTarget: target }]);
    assert.ok(f.logs.some(line => line.includes(target)));
    assert.equal(f.snapshots.length, 0);
  });
}

test('atomic ownership rename syncs parent directory before reporting success', async t => {
  const f = await fixture(t);
  const open = fs.open, events = [];
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    const isDirectory = filename === f.root;
    if (isDirectory) events.push('open directory');
    const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
    handle.sync = async () => {
      if (isDirectory) { events.push('sync directory'); assert.equal(await f.owner(), 'k8s'); }
      else events.push('sync file');
      return sync();
    };
    handle.close = async () => { if (isDirectory) events.push('close directory'); return close(); };
    return handle;
  });
  await writeOwner(f.ownersFile, 'user1', 'k8s');
  assert.deepEqual(events, ['sync file', 'open directory', 'sync directory', 'close directory']);
});

test('directory fsync failure stops switch after ownership rename and before runtime create or start', async t => {
  const f = await fixture(t);
  const open = fs.open;
  let closed = false;
  t.mock.method(fs, 'open', async (filename, ...args) => {
    const handle = await open(filename, ...args);
    if (filename === f.root) {
      handle.sync = async () => { throw new Error('directory sync failure'); };
      const close = handle.close.bind(handle);
      handle.close = async () => { closed = true; return close(); };
    }
    return handle;
  });
  assert.equal((await f.run('switch')).exitCode, 1);
  assert.equal(await f.owner(), 'k8s'); assert.equal(closed, true);
  assert.equal(f.container.State.Running, false);
  assert.ok(!f.events.includes('runtime create')); assert.ok(!f.events.includes('runtime start'));
  assert.match(f.logs.at(-1), /owner -> k8s.*NEXT:/); f.assertSafe();
});

for (const conflict of ['storageClassName', 'local path', 'claimRef', 'node affinity']) {
  test(`pv normalization still rejects conflicting ${conflict} without writes`, async t => {
    const f = await fixture(t);
    f.objects.delete(`${core}/persistentvolumeclaims/${name}-data`);
    f.objects.delete(`/api/v1/persistentvolumes/workspaces-${name}-data`);
    const options = { node: 'node-a', 'data-root': f.root };
    assert.equal((await f.run('pv', true, options)).exitCode, 0);
    f.apiVolumeDefaults = true;
    const spec = f.objects.get(`/api/v1/persistentvolumes/workspaces-${name}-data`).spec;
    if (conflict === 'storageClassName') spec.storageClassName = 'another-class';
    if (conflict === 'local path') spec.local.path = '/another/data';
    if (conflict === 'claimRef') spec.claimRef.namespace = 'another-namespace';
    if (conflict === 'node affinity') spec.nodeAffinity.required.nodeSelectorTerms[0].matchFields[0].values = ['node-b'];
    f.events.length = 0;
    assert.equal((await f.run('pv', true, options)).exitCode, 1);
    assert.ok(!f.events.some(event => event.startsWith('create ')));
    assert.match(f.logs.at(-1), /conflicts.*NEXT:/);
  });
}
