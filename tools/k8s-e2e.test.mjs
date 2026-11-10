import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './k8s/e2e/options.mjs';
import { organization, execute, nodeArguments, requiredPolicy, requiredPolicies, recordOnly } from './k8s/e2e/controller.mjs';
import { labelObject } from './k8s/e2e/context.mjs';
import { privateDirectory, privateFile } from './k8s/e2e/artifacts.mjs';
import { scenarios } from './k8s/e2e/scenarios.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = name => path.join(root, 'tools/k8s', name);
const args = ['--prefix', 'wp-e2e-offline', '--kubeconfig', '/tmp/e2e-config.json', '--image', 'images.test/fixture:v1',
  '--gateway-image', 'images.test/gateway:v1', '--server-node', 'server', '--agent-node', 'agent'];
const run = (file, argv = [], env = {}) => execute('/bin/bash', [file, ...argv], { cwd: root, env: { ...process.env, ...env }, timeout: 40000, acceptFailure: true });
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-e2e-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}

test('both entry scripts and image entrypoint pass bash -n', () => {
  for (const name of ['e2e.sh', 'e2e-k3d.sh', 'fixtures/e2e-image/start.sh']) {
    const result = execute('bash', ['-n', script(name)], { acceptFailure: true });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('help and print-config need no cluster tools', () => {
  for (const name of ['e2e.sh', 'e2e-k3d.sh']) {
    const result = run(script(name), ['--help']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Usage:/);
  }
  const result = run(script('e2e.sh'), [...args, '--node-ips', '192.0.2.10,192.0.2.11', '--external-probe', 'probe.test:443', '--print-config']);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.nodeIps, ['192.0.2.10', '192.0.2.11']);
  assert.deepEqual(config.externalProbe, { host: 'probe.test', port: 443 });
  assert.equal(config.image, 'images.test/fixture:v1');
});

test('argument parser rejects unsafe or incomplete invocations before mutations', () => {
  for (const more of [['--unknown'], ['--guard'], ['--static-pv-node', 'server'], ['--static-pv-dir', '/tmp'],
    ['--node-ips', 'not-an-ip'], ['--external-probe', 'probe.test:0'], ['--sample-port', '18083'], ['--sample-port', '18085'],
    ['--image-id', 'bad'], ['--storage-parameters', '[]'], ['--ssh-node', 'server=-oProxyCommand=bad']]) {
    assert.throws(() => parseArgs([...args, ...more]));
  }
  for (const prefix of ['production', 'wp-e2e-', '../wp-e2e-test', 'wp-e2e-' + 'a'.repeat(30)]) {
    assert.throws(() => parseArgs(['--cleanup', '--prefix', prefix]));
  }
  assert.equal(parseArgs(['--cleanup', '--prefix', 'wp-e2e-offline']).cleanup, true);
  const result = run(script('e2e.sh'), ['--prefix', 'wp-e2e-offline', '--image']); assert.notEqual(result.status, 0);
  const down = run(script('e2e-k3d.sh'), ['down', '--prefix', 'production']); assert.notEqual(down.status, 0);
});

test('all scenario and orchestration modules import without K2a/K3/K5 or a cluster', async () => {
  const directory = new URL('./k8s/e2e/', import.meta.url);
  for (const name of await fs.readdir(directory)) if (name.endsWith('.mjs')) await import(new URL(name, directory));
  const { scenarios } = await import('./k8s/e2e/scenarios.mjs');
  assert.deepEqual(scenarios.map(s => s.id), Array.from({ length: 13 }, (_, i) => `S${i + 1}`));
  assert.ok(scenarios.every(s => typeof s.run === 'function'));
});

test('test config takes names/images/nodes from arguments and labels preserve runtime selectors', () => {
  const options = parseArgs([...args, '--node-ips', '192.0.2.10']);
  const org = organization(options);
  assert.equal(org.runtime.nextImage, options.image);
  assert.equal(org.runtime.k8s.namespace, 'wp-e2e-offline-users');
  assert.deepEqual(org.runtime.k8s.deploy.egressExceptCidrs, ['192.0.2.10/32']);
  const obj = { metadata: { labels: { role: 'user' } }, spec: { selector: { matchLabels: { role: 'user' } }, template: { metadata: { labels: { role: 'user' } } } } };
  const labelled = labelObject(obj, options.prefix);
  assert.equal(labelled.spec.template.metadata.labels['workpartner-e2e'], options.prefix);
  assert.deepEqual(labelled.spec.selector, obj.spec.selector);
  assert.equal(obj.metadata.labels['workpartner-e2e'], undefined);
});

async function fakeKubectl(t, { failDelete = false, residue = false, partialApi = false, otherResidue = false, pendingPv = false } = {}) {
  const directory = await temporary(t), bin = path.join(directory, 'bin'); await fs.mkdir(bin);
  const log = path.join(directory, 'calls.jsonl');
  await fs.writeFile(path.join(bin, 'kubectl'), `#!${process.execPath}
const fs = require('node:fs');
let a = process.argv.slice(2);
fs.appendFileSync(process.env.E2E_CALLS, JSON.stringify(a)+'\\n');
if(a[0]==='--kubeconfig') a=a.slice(2);
if(a[0]==='api-resources') { console.log(a.includes('--namespaced=true')?'pods\\nsecrets\\nconfigmaps':'namespaces\\npersistentvolumes\\nstorageclasses\\npriorityclasses'); if(process.env.E2E_PARTIAL==='1') { console.error('error: unable to retrieve the complete list of server APIs: metrics.k8s.io/v1beta1: stale GroupVersion discovery'); process.exit(1); } process.exit(0); }
if(process.env.E2E_RUN==='1') {
 if(a[0]==='apply') { const body=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync(process.env.E2E_CALLS,JSON.stringify(['applied',...body.items.map(o=>o.metadata.name)])+'\\n'); const deployment=body.items.find(o=>o.kind==='Deployment'); if(deployment) fs.appendFileSync(process.env.E2E_CALLS,JSON.stringify(['gateway-ports',deployment.spec.template.spec.containers[0].ports])+'\\n'); }
 if(a[0]==='get' && a[1]==='nodes') { console.log(JSON.stringify({items:['server','agent'].map(name=>({metadata:{name,labels:{'kubernetes.io/hostname':name}},status:{conditions:[{type:'Ready',status:'True'}],addresses:[]}}))})); process.exit(0); }
 if(a[0]==='get' && a[1]==='configmap') { console.log(JSON.stringify({data:{'images.json':JSON.stringify({'images.test/fixture:v1':'sha256:'+'a'.repeat(64)})}})); process.exit(0); }
 if(a[0]==='get' && a[1]==='pods' && a.some(v=>v.includes('workpartner/role=gateway'))) { console.log(JSON.stringify({items:[{metadata:{name:'gateway',namespace:'wp-e2e-offline-system',uid:String(Date.now())},spec:{nodeName:'server'},status:{podIP:'192.0.2.20',conditions:[{type:'Ready',status:'True'}]}}]})); process.exit(0); }
 if(a[0]==='get' && a[1]==='pods' && a.includes('wp-e2e-offline-users')) { console.log(JSON.stringify({items:['node-server','node-agent'].map((slug,i)=>({metadata:{name:'wp-e2e-offline-'+slug+'-0',namespace:'wp-e2e-offline-users'},spec:{nodeName:i?'agent':'server'}}))})); process.exit(0); }
 if(a[0]==='exec' && a.includes('--input-type=module')) { const target=JSON.parse(fs.readFileSync(0,'utf8')); console.log(JSON.stringify(target.kind==='http'?{status:200}:{open:true,reason:'connected'})); process.exit(0); }
 const runner=a.indexOf('/app/tools/k8s/e2e/runner.mjs');
 if(runner>=0) { const id=a[runner+1], phase=a[runner+2]; const fail=id===process.env.E2E_FAIL_SCENARIO; console.log(JSON.stringify({id,phase,status:fail?'FAIL':'PASS',evidence:{users:{},...(fail?{policyTimeout:{slug:'node-server'}}:{})}})); if(fail) console.error('runner diagnostic'); process.exit(fail?1:0); }
}
if(a[0]==='delete' && a[1]==='storageclass' && process.env.E2E_FAIL==='1') process.exit(1);
if(a[0]==='get') {
 if(a[1]==='pv' && process.env.E2E_PENDING_PV==='1') {
   const marker=process.env.E2E_CALLS+'.pv';
   const pending=!fs.existsSync(marker); fs.writeFileSync(marker,'seen');
   console.log(JSON.stringify({items:pending?[{spec:{persistentVolumeReclaimPolicy:'Delete'}}]:[]})); process.exit(0);
 }
 if(a.includes('--ignore-not-found=true')) process.exit(0);
 const items=(process.env.E2E_RESIDUE==='1' || (process.env.E2E_OTHER==='1' && a.includes('workpartner-e2e'))) && a[1]==='secrets' ? [{metadata:{name:'leftover',namespace:'wp-e2e-offline-users'}}] : [];
 console.log(JSON.stringify({items}));
}
`, { mode: 0o755 });
  return { directory, log, env: { PATH: `${bin}:${process.env.PATH}`, E2E_CALLS: log, E2E_FAIL: failDelete ? '1' : '0', E2E_RESIDUE: residue ? '1' : '0', E2E_PARTIAL: partialApi ? '1' : '0', E2E_OTHER: otherResidue ? '1' : '0', E2E_PENDING_PV: pendingPv ? '1' : '0' } };
}

test('--cleanup is repeatable and deletes only the label-scoped inventory, then audits all resources', async t => {
  const f = await fakeKubectl(t), output = path.join(f.directory, 'results');
  for (let i = 0; i < 2; i++) {
    const result = run(script('e2e.sh'), ['--cleanup', '--prefix', 'wp-e2e-offline', '--kubeconfig', '/tmp/admin.json', '--output', output], f.env);
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call[0] === '--kubeconfig' && call[1] === '/tmp/admin.json'));
  const commands = calls.map(call => call.slice(2)), deletes = commands.filter(call => call[0] === 'delete');
  assert.deepEqual(deletes.map(call => call[1]), ['namespace', 'storageclass', 'pv', 'priorityclass', 'namespace', 'storageclass', 'pv', 'priorityclass']);
  for (const call of deletes) {
    assert.equal(call[call.indexOf('-l') + 1], 'workpartner-e2e=wp-e2e-offline');
    assert.ok(call.includes('--ignore-not-found=true')); assert.ok(call.includes('--wait=true'));
    assert.ok(!call.includes('--all')); assert.ok(!call.includes('--force'));
  }
  assert.ok(commands.some(call => call[0] === 'get' && call[1] === 'secrets' && call.includes('-A')));
  const cleanup = JSON.parse(await fs.readFile(path.join(output, 'cleanup.json'), 'utf8'));
  assert.deepEqual(cleanup.residual, []); assert.equal(cleanup.status, 'PASS');
});

test('cleanup failures stay nonzero while remaining cleanup steps still run', async t => {
  const f = await fakeKubectl(t, { failDelete: true });
  const result = run(script('e2e.sh'), ['--cleanup', '--prefix', 'wp-e2e-offline', '--output', path.join(f.directory, 'results')], f.env);
  assert.notEqual(result.status, 0);
  const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call[0] === 'delete' && call[1] === 'pv'));
  assert.ok(calls.some(call => call[0] === 'delete' && call[1] === 'priorityclass'));
});

test('cleanup reports residual objects and does not declare success', async t => {
  const f = await fakeKubectl(t, { residue: true }), output = path.join(f.directory, 'results');
  const result = run(script('e2e.sh'), ['--cleanup', '--prefix', 'wp-e2e-offline', '--output', output], f.env);
  assert.notEqual(result.status, 0);
  const cleanup = JSON.parse(await fs.readFile(path.join(output, 'cleanup.json'), 'utf8'));
  assert.equal(cleanup.status, 'FAIL'); assert.equal(cleanup.residual[0].name, 'leftover');
});

test('cleanup resumes persisted kubeconfig and guard restoration, but automatic unarmed cleanup is inert', async t => {
  const f = await fakeKubectl(t), output = path.join(f.directory, 'results'); await fs.mkdir(output);
  const remoteLog = path.join(f.directory, 'remote.log'), adapter = path.join(f.directory, 'remote');
  await fs.writeFile(adapter, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(remoteLog)},JSON.stringify(process.argv.slice(2))+'\\n'+require('node:fs').readFileSync(0,'utf8'));\n`, { mode: 0o755 });
  const config = parseArgs([...args, '--output', output, '--node-command', adapter]);
  await fs.writeFile(path.join(output, 'state.json'), JSON.stringify({ config, guards: [{ node: 'server', rules: 'table inet workpartner_guard { }\n', restored: false }] }));
  const input = path.join(f.directory, 'input.json'); await fs.writeFile(input, JSON.stringify(config));
  const inert = execute(process.execPath, [script('e2e/controller.mjs'), 'cleanup', input], { env: { ...process.env, ...f.env }, acceptFailure: true });
  assert.equal(inert.status, 0); await assert.rejects(fs.stat(f.log), { code: 'ENOENT' });
  const result = run(script('e2e.sh'), ['--cleanup', '--prefix', config.prefix, '--output', output], f.env);
  assert.equal(result.status, 0, result.stderr);
  const remote = await fs.readFile(remoteLog, 'utf8'); assert.match(remote, /delete table inet workpartner_guard/); assert.match(remote, /table inet workpartner_guard \{ \}/);
  const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call[1] === config.kubeconfig));
});

test('output defaults outside git; repository paths and symlink aliases are rejected before commands', async t => {
  const directory = await temporary(t);
  const config = parseArgs(args);
  assert.ok(config.output.startsWith('/tmp/wp-e2e-offline-results-'));
  assert.equal(config.policyTimeoutMs, 60000);
  await fs.symlink(root, path.join(directory, 'repo'));
  for (const output of [root, path.join(root, 'new/results'), path.join(directory, 'repo/new/results')]) {
    assert.throws(() => parseArgs([...args, '--output', output]), /outside any git/);
    const result = run(script('e2e.sh'), ['--cleanup', '--prefix', 'wp-e2e-offline', '--output', output]);
    assert.equal(result.status, 2);
  }
  const repo = path.join(directory, 'another-repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  assert.throws(() => parseArgs([...args, '--output', path.join(repo, 'results')]), /outside any git/);
});

test('artifacts and command stderr logs are private, including accepted failures', async t => {
  const directory = await temporary(t), output = path.join(directory, 'results');
  await fs.mkdir(output, { mode: 0o755 });
  privateDirectory(output);
  const file = path.join(output, 'state.json');
  await fs.writeFile(file, 'old', { mode: 0o644 });
  privateFile(file, '{}');
  assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const argv = ['-e', 'process.stderr.write("private diagnostic"); process.exit(7)'];
  let failure;
  try { execute(process.execPath, argv, { output }); } catch (error) { failure = error; }
  assert.ok(failure.logPath.startsWith(output));
  assert.equal(failure.message, `Command failed; log: ${failure.logPath}`);
  assert.equal(await fs.readFile(failure.logPath, 'utf8'), 'private diagnostic');
  const accepted = execute(process.execPath, argv, { output, acceptFailure: true });
  assert.equal(accepted.status, 7);
  for (const log of [failure.logPath, accepted.logPath]) assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
});

test('partial API discovery continues in preflight and cleanup; all-prefix residues are report-only', async t => {
  const f = await fakeKubectl(t, { partialApi: true, otherResidue: true });
  const output = path.join(f.directory, 'results'), kubeconfig = path.join(f.directory, 'config.json');
  await fs.writeFile(kubeconfig, '{}');
  const config = parseArgs([...args.filter((_, i) => ![2, 3].includes(i)), '--kubeconfig', kubeconfig, '--output', output]);
  const input = path.join(f.directory, 'input.json'); await fs.writeFile(input, JSON.stringify(config));
  const preflight = execute(process.execPath, [script('e2e/controller.mjs'), 'run', input], { env: { ...process.env, ...f.env }, acceptFailure: true });
  // The fake cluster has no Ready nodes: reaching this check proves discovery did not abort preflight.
  assert.match(preflight.stderr, /Selected node is not ready/);
  const pre = JSON.parse(await fs.readFile(path.join(output, 'cleanup.json')));
  assert.equal(pre.status, 'NOT_RUN'); assert.equal(pre.discoveryWarnings.length, 2);
  const result = run(script('e2e.sh'), ['--cleanup', '--prefix', config.prefix, '--output', output], f.env);
  assert.equal(result.status, 0, result.stderr);
  const cleanup = JSON.parse(await fs.readFile(path.join(output, 'cleanup.json')));
  assert.equal(cleanup.status, 'PASS'); assert.deepEqual(cleanup.residual, []);
  assert.equal(cleanup.allPrefixesResidual[0].name, 'leftover');
  assert.ok(cleanup.discoveryWarnings.every(w => w.unavailableApiGroups.includes('metrics.k8s.io/v1beta1')));
  for (const warning of cleanup.discoveryWarnings) assert.match(await fs.readFile(warning.log, 'utf8'), /stale GroupVersion/);
  const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(a => a.includes('secrets') && a.includes('workpartner-e2e')));
  assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(output, 'cleanup.json'))).mode & 0o777, 0o600);
});

test('cleanup waits for Delete PV reclamation before deleting StorageClass and Retain PVs', async t => {
  const f = await fakeKubectl(t, { pendingPv: true });
  const result = run(script('e2e.sh'), ['--cleanup', '--prefix', 'wp-e2e-offline', '--output', path.join(f.directory, 'results')], f.env);
  assert.equal(result.status, 0, result.stderr);
  const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  const checks = calls.flatMap((a, i) => a[0] === 'get' && a[1] === 'pv' ? [i] : []);
  const deletion = resource => calls.findIndex(a => a[0] === 'delete' && a[1] === resource);
  assert.equal(checks.length, 2);
  assert.ok(deletion('namespace') < checks[0]);
  assert.ok(checks[1] < deletion('storageclass'));
  assert.ok(deletion('storageclass') < deletion('pv'));
});

test('unpin uses journaled images and mapped nodes only for distribute; failure is recorded and retried', async t => {
  const f = await fakeKubectl(t), output = path.join(f.directory, 'results'); await fs.mkdir(output);
  const unpinLog = path.join(f.directory, 'unpin.jsonl');
  await fs.writeFile(path.join(f.directory, 'bin/bash'), `#!${process.execPath}
const fs=require('node:fs'), a=process.argv.slice(2);
if (!a[0].endsWith('/distribute-image.sh') || a[1]!=='--unpin') process.exit(99);
fs.appendFileSync(process.env.E2E_UNPIN,JSON.stringify(a)+'\\n');
if(a[2].includes('fixture') && process.env.E2E_UNPIN_FAIL==='1') { console.error('unpin diagnostic'); process.exit(9); }
`, { mode: 0o755 });
  const config = parseArgs([...args, '--distribute', '--output', output, '--ssh-node', 'server=server.test', '--ssh-node', 'agent=agent.test']);
  const state = { config, distributedImages: [config.image, config.gatewayImage].map(image => ({ image, unpinned: false })), results: [{ id: 'S10', status: 'FAIL' }] };
  const stateFile = path.join(output, 'state.json'); await fs.writeFile(stateFile, JSON.stringify(state));
  const cleanupArgs = ['--cleanup', '--prefix', config.prefix, '--output', output];
  const env = { ...f.env, E2E_UNPIN: unpinLog, E2E_UNPIN_FAIL: '1' };
  assert.equal(run(script('e2e.sh'), cleanupArgs, env).status, 0);
  const cleanup = JSON.parse(await fs.readFile(path.join(output, 'cleanup.json')));
  assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.warnings.length, 1);
  assert.match(await fs.readFile(cleanup.warnings[0].log, 'utf8'), /unpin diagnostic/);
  assert.equal(JSON.parse(await fs.readFile(stateFile)).results[0].status, 'FAIL');
  assert.equal(run(script('e2e.sh'), cleanupArgs, { ...env, E2E_UNPIN_FAIL: '0' }).status, 0);
  const calls = (await fs.readFile(unpinLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(a => a[2]), [config.image, config.gatewayImage, config.image]);
  for (const a of calls) assert.deepEqual(a.slice(3), ['--node', 'server.test', '--node', 'agent.test']);
  state.config.distribute = false; await fs.writeFile(stateFile, JSON.stringify(state));
  assert.equal(run(script('e2e.sh'), cleanupArgs, env).status, 0);
  assert.equal((await fs.readFile(unpinLog, 'utf8')).trim().split('\n').length, 3);
});

test('S11 retries probe errors and waits for both HTTP controls; timeout still fails', async () => {
  const s = scenarios.find(s => s.id === 'S11');
  let attempts = 0, gatewayChecks = 0;
  const c = { config: { policyTimeoutMs: 2000 }, runtime: { readFile: async () => 'key' }, pod: async () => ({ status: { podIP: '192.0.2.10' } }),
    probe: async () => { gatewayChecks++; return { status: 200 }; },
    fromProbe: async () => { attempts++; if (attempts === 1) throw new Error('Probe process must complete'); return { status: attempts === 2 ? 200 : 403 }; } };
  assert.equal((await s.run(c)).length, 2);
  assert.equal(attempts, 4); assert.equal(gatewayChecks, 4);
  c.config.policyTimeoutMs = 10; c.fromProbe = async () => ({ status: 200 });
  await assert.rejects(s.run(c), /Condition timed out/);
});

test('S12 retries only the positive control and fails immediately on an open node port', async () => {
  const s = scenarios.find(s => s.id === 'S12');
  let positive = 0, denied = 0;
  const c = { config: { guard: true, policyTimeoutMs: 2000, nodeIps: ['192.0.2.10'], gatewayIp: '192.0.2.20', samplePort: 18081 },
    name: slug => `fixture-${slug}`,
    from: async (_, target) => {
      if (target.kind === 'route') return '192.0.2.10';
      if (target.host === '192.0.2.20') return { open: ++positive > 1 };
      if ([6443, 10250].includes(target.port)) return { open: true };
      denied++; return { open: false };
    } };
  const evidence = await s.run(c);
  assert.equal(positive, 3);
  assert.equal(denied, 4);
  assert.ok(evidence.rows.filter(r => r.label === 'nft node denial').every(r => r.open === false));
  c.from = async (_, target) => {
    if (target.kind === 'route') return c.config.nodeIps[0];
    if (target.host === c.config.gatewayIp) return { open: true };
    // A transient open denial must fail, even if a retry would be closed.
    return { open: ++denied === 5 };
  };
  await assert.rejects(s.run(c), /nft node denial/);
  assert.equal(denied, 5);
  c.config.policyTimeoutMs = 10;
  c.from = async (_, target) => target.kind === 'route' ? c.config.nodeIps[0] : { open: false };
  await assert.rejects(s.run(c), /Policy convergence timed out for Pod fixture-node-server-0/);
});

test('S9 chooses a K2a required policy by name and SSH defaults are noninteractive', () => {
  const policies = ['unrelated', ...requiredPolicies.toReversed()].map(name => ({ metadata: { name } }));
  assert.equal(requiredPolicy(policies), 'workpartner-default-deny');
  assert.throws(() => requiredPolicy(policies.slice(0, 1)), /No K2a required/);
  const config = parseArgs(args);
  assert.deepEqual(nodeArguments(config, 'server'), ['-o', 'BatchMode=yes', 'server', 'sh', '-s']);
  assert.deepEqual(nodeArguments({ ...config, nodeCommand: '/tmp/adapter' }, 'server'), ['server', 'sh', '-s']);
});

test('finally diagnostic failure records only a log reference and preserves the scenario error', async () => {
  const warnings = [], original = new Error('scenario failure');
  await assert.rejects(async () => {
    try { throw original; } finally {
      await recordOnly(warnings, 'read guard counters', () => { throw Object.assign(new Error('private stderr'), { logPath: '/tmp/command.log' }); });
    }
  }, error => error === original);
  assert.deepEqual(warnings, [{ step: 'read guard counters', log: '/tmp/command.log' }]);
});

test('host probes exist only during network scenarios and are deleted immediately on success or failure', async t => {
  for (const fail of ['', 'S10']) {
    const f = await fakeKubectl(t), output = path.join(f.directory, 'results'), kubeconfig = path.join(f.directory, 'config.json');
    await fs.writeFile(kubeconfig, '{}');
    const adapter = path.join(f.directory, 'node-adapter');
    await fs.writeFile(adapter, `#!${process.execPath}
const input=require('node:fs').readFileSync(0,'utf8');
if(input==='set -eu\\nnft list table inet workpartner_guard\\n') { console.error('counter diagnostic'); process.exit(8); }
`, { mode: 0o755 });
    const argv = [...args]; argv[3] = kubeconfig;
    argv.push('--guard', '--pod-cidrs', '10.42.0.0/16', '--tunnel-interface', 'flannel.1', '--node-ips', '192.0.2.10,192.0.2.11', '--node-command', adapter);
    const result = run(script('e2e.sh'), [...argv, '--image-id', `sha256:${'a'.repeat(64)}`, '--output', output],
      { ...f.env, E2E_RUN: '1', E2E_FAIL_SCENARIO: fail });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const calls = (await fs.readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse).map(a => a[0] === '--kubeconfig' ? a.slice(2) : a);
    const scene = id => calls.findIndex(a => a.includes('/app/tools/k8s/e2e/runner.mjs') && a.includes(id));
    const gatewayPorts = calls.find(a => a[0] === 'gateway-ports')[1];
    assert.equal(gatewayPorts[0].hostPort, 18085);
    assert.equal(gatewayPorts[0].hostIP, '127.0.0.1');
    assert.equal(gatewayPorts[0].containerPort, 18083);
    const hosts = calls.findIndex(a => a[0] === 'applied' && a.includes('wp-e2e-offline-host-0'));
    assert.ok(scene('S9') < hosts && hosts < scene('S10'));
    for (let i = 0; i < 2; i++) {
      const deleted = calls.findIndex(a => a[0] === 'delete' && a[1] === 'pod' && a[2] === `wp-e2e-offline-host-${i}`);
      assert.ok(deleted > scene('S10'));
      if (!fail) {
        assert.ok(deleted < scene('S11'));
        const deletions = calls.flatMap((a, j) => a[0] === 'delete' && a[1] === 'pod' && a[2] === `wp-e2e-offline-host-${i}` ? [j] : []);
        assert.equal(deletions.length, 2);
        assert.ok(scene('S12') < deletions[1] && deletions[1] < scene('S13'));
      }
      else assert.ok(deleted < calls.findIndex(a => a[0] === 'delete' && a[1] === 'namespace'));
    }
    const state = JSON.parse(await fs.readFile(path.join(output, 'state.json')));
    assert.equal(state.warnings.filter(w => w.step.startsWith('read guard counters')).length, 2);
    assert.doesNotMatch(result.stderr, /counter diagnostic/);
    assert.equal(state.policies.length, 3); // Real main K5 rendering was used.
    assert.ok(requiredPolicies.every(name => state.policies.some(p => p.metadata.name === name)));
    if (fail) {
      assert.equal(state.results.at(-1).status, 'FAIL');
      const diagnostics = state.results.at(-1).evidence.policyDiagnostics;
      assert.equal(diagnostics.gatewayPods[0].name, 'gateway');
      assert.equal(diagnostics.probes.length, 10);
      assert.equal(diagnostics.guards.length, 2);
      assert.ok(diagnostics.guards.every(g => g.status === 'unavailable'));
      assert.ok(!JSON.stringify(diagnostics).includes('counter diagnostic'));
      const saved = JSON.parse(await fs.readFile(path.join(output, 'results.json')));
      assert.deepEqual(saved.results.at(-1).evidence.policyDiagnostics, diagnostics);
      const slices = calls.findIndex(a => a[0] === 'get' && a[1] === 'endpointslices.discovery.k8s.io');
      assert.ok(scene('S10') < slices);
      assert.ok(slices < calls.findIndex(a => a[0] === 'delete' && a[1] === 'pod'));
      assert.match(await fs.readFile(state.results.at(-1).commandLog, 'utf8'), /runner diagnostic/);
      assert.doesNotMatch(result.stderr, /runner diagnostic/);
    } else {
      assert.ok(!calls.some(a => a[0] === 'get' && a[1] === 'endpointslices.discovery.k8s.io'));
    }
  }
});
