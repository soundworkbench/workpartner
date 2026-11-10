import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { labelObject } from './context.mjs';
import { outsideRepository, privateDirectory, privateFile } from './artifacts.mjs';
import { collectPolicyDiagnostics } from './diagnostics.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const write = (file, value) => privateFile(file, JSON.stringify(value, null, 2) + '\n');
// K2a defaults (gateway/runtime/k8s.mjs); select by name, never renderer order.
export const requiredPolicies = ['workpartner-default-deny', 'workpartner-user-egress', 'workpartner-user-ingress'];
export function requiredPolicy(policies, names = requiredPolicies) {
  const policy = names.map(name => policies.find(p => p.metadata.name === name)).find(Boolean);
  if (!policy) throw new Error('No K2a required NetworkPolicy was rendered');
  return policy.metadata.name;
}
export const nodeArguments = (o, node) => [...(o.nodeCommand === 'ssh' ? ['-o', 'BatchMode=yes'] : []), o.sshNodes[node] || node, 'sh', '-s'];
export async function recordOnly(warnings, step, fn) {
  try { await fn(); } catch (error) { warnings.push({ step, ...(error.logPath ? { log: error.logPath } : { error: error.name }) }); }
}
export async function waitForListener(kubectl, { namespace, pod, node, port }, {
  timeoutMs = 30000, intervalMs = 500, now = () => performance.now(), sleep = delay,
} = {}) {
  const end = now() + timeoutMs;
  const code = `const s=require('node:net').connect(${port},'127.0.0.1',()=>{s.destroy()});s.setTimeout(1000,()=>{s.destroy();process.exit(1)});s.on('error',()=>process.exit(1))`;
  let logPath;
  while (now() < end) {
    try {
      const result = kubectl(['exec', '-n', namespace, pod, '--', 'node', '-e', code], {
        acceptFailure: true, timeout: Math.max(1, Math.min(5000, Math.ceil(end - now()))),
      });
      if (result.status === 0 && !result.error) return;
      logPath = result.logPath || logPath;
    } catch (error) {
      logPath = error.logPath || logPath;
    }
    const remaining = end - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  const error = new Error(`TCP listener not ready after ${timeoutMs}ms on node ${node}, port ${port} (pod ${namespace}/${pod})${logPath ? `; log: ${logPath}` : ''}`);
  error.logPath = logPath;
  throw error;
}
export function execute(bin, args, { input = '', acceptFailure = false, timeout = 1200000, env = process.env, cwd, output } = {}) {
  // File descriptors also work in sandboxes where child-process pipe polling is restricted.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-e2e-command-'));
  const names = ['stdin', 'stdout', 'stderr'].map(name => path.join(directory, name));
  fs.writeFileSync(names[0], input, { mode: 0o600 });
  const handles = names.map((name, i) => fs.openSync(name, i === 0 ? 'r' : 'w', 0o600));
  try {
    const result = spawnSync(bin, args, { stdio: handles, timeout, env, cwd });
    const oversized = names.slice(1).some(name => fs.statSync(name).size > 16 * 1024 * 1024);
    const failed = result.error || result.status !== 0 || oversized;
    if (failed && output) {
      privateDirectory(output);
      result.logPath = path.join(output, `command-${randomBytes(8).toString('hex')}.log`);
      // Preserve stderr even on accepted failures; never print it to the terminal.
      fs.copyFileSync(names[2], result.logPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(result.logPath, 0o600);
      if (result.error || oversized) fs.appendFileSync(result.logPath, `\n${result.error?.message || 'Command output limit exceeded'}\n`);
    }
    result.stdout = oversized ? '' : fs.readFileSync(names[1], 'utf8');
    result.stderr = oversized ? '' : fs.readFileSync(names[2], 'utf8');
    if (failed && (!acceptFailure || oversized)) {
      const error = new Error(result.logPath ? `Command failed; log: ${result.logPath}` : `${path.basename(bin)} failed (exit ${result.status ?? 'unavailable'})`);
      error.logPath = result.logPath;
      throw error;
    }
    return result;
  } finally {
    handles.forEach(fd => fs.closeSync(fd));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
export function organization(o) {
  const p = o.prefix;
  return { schemaVersion: 1, organizationId: p, displayName: 'E2E', identity: { appSecretFile: '/e2e-secure/identity.secret' },
    model: { baseUrl: `http://${p}-model:18082`, nextBaseUrl: '', keyPrefix: `${p}-key-`, baseEnvironment: 'MODEL_BASE_URL' },
    runtime: { kind: 'k8s', uid: 1001, nextImage: o.image, nextContainerPrefix: `${p}-`, nextUserLabel: 'workpartner.next-user',
      nextModelKeyFile: '/etc/partner/model.key', nextPort: 25808, nextMemory: 268435456, nanoCpus: 500000000,
      gatewayOrigin: `http://${p}-gateway:18083`, internalOrigin: `http://${p}-gateway:18084`, gatewayPort: 18083, internalPort: 18084,
      localAddress: '127.0.0.1:18085', secureDirectory: '/e2e-secure', stateDirectory: '/e2e-state', usersFile: '/e2e-state/users.json',
      sessionKeyFile: '/e2e-secure/session.key', cookieFile: '/e2e-state/cookies.json',
      migration: { ownersFile: '/e2e-state/owners.json' },
      k8s: { namespace: `${p}-users`, systemNamespace: `${p}-system`, storageClass: `${p}-local`,
        imageConfigMap: `${p}-images`, governingService: `${p}-users`, clusterDomain: o.clusterDomain,
        dataVolumeSize: '64Mi', memoryRequest: '64Mi', cpuRequest: '20m', inspectCacheMs: 0, terminationGraceSeconds: 3,
        podStartTimeoutMs: 120000, keepRunningIntervalMs: 0,
        newUserNodeSelector: { 'kubernetes.io/hostname': o.agentNode },
        deploy: { gatewayImage: o.gatewayImage, gatewayNodeSelector: { 'kubernetes.io/hostname': o.serverNode },
          // Keep the production shape: loopback entry port differs from the Pod listener.
          entry: { mode: 'hostPort', hostIP: '127.0.0.1', hostPort: 18085 },
          // K5 validates these; the fixture replaces all host mounts before apply.
          hostPaths: { organization: '/e2e/organization', secure: '/e2e/secure', state: '/e2e/state', usersFile: '/e2e/users.json' },
          egressExceptCidrs: o.nodeIps.map(ip => `${ip}/32`), modelEgressSelector: { 'workpartner/role': 'model-egress' },
          newUserStorage: { provisioner: o.storageProvisioner, parameters: o.storageParameters },
        },
      },
    },
  };
}
export async function controller(mode, inputFile) {
  const requested = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  if (mode === 'run' && requested.cleanup) return;
  requested.output = outsideRepository(requested.output);
  const stateFile = path.join(requested.output, 'state.json');
  // An automatic trap may only clean a run that this invocation armed.
  if (mode === 'cleanup' && !requested.cleanup && !fs.existsSync(`${inputFile}.armed`)) return;
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  if (state && state.config.prefix !== requested.prefix) throw new Error('Cleanup state prefix mismatch');
  let o = mode === 'cleanup' && state ? { ...state.config, kubeconfig: requested.kubeconfig || state.config.kubeconfig } : requested;
  o.output = requested.output;
  privateDirectory(o.output);
  console.error(`Evidence directory: ${o.output}`);
  const command = (bin, args, options) => execute(bin, args, { ...options, output: o.output });
  const discoveryWarnings = [...(state?.discoveryWarnings || [])];
  const p = o.prefix, selector = `workpartner-e2e=${p}`, sys = `${p}-system`, users = `${p}-users`;
  const kubectl = (args, options) => command('kubectl', [...(o.kubeconfig ? ['--kubeconfig', o.kubeconfig] : []), ...args], options);
  const get = args => JSON.parse(kubectl(['get', ...args, '-o', 'json']).stdout);
  const apply = objects => kubectl(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects.map(obj => labelObject(obj, p)) }) });
  const save = () => write(stateFile, state);
  const remote = (node, script) => command(o.nodeCommand, nodeArguments(o, node), { input: `set -eu\n${script}\n` }).stdout;
  const register = id => {
    const images = JSON.parse(get(['configmap', `${p}-images`, '-n', sys]).data['images.json']);
    kubectl(['patch', 'configmap', `${p}-images`, '-n', sys, '--type=merge', '-p', JSON.stringify({ data: { 'images.json': JSON.stringify({ ...images, [o.image]: id }) } })]);
  };
  async function waitFor(fn, timeout = 180000) {
    const end = Date.now() + timeout;
    do { const result = fn(); if (result) return result; await delay(1000); } while (Date.now() < end);
    throw new Error('Cluster condition timed out');
  }
  function labelVolumes() {
    if (!get(['namespace', '-l', selector]).items.some(ns => ns.metadata.name === users)) return;
    const volumes = get(['pv']).items;
    for (const pv of volumes) {
      if (pv.spec?.claimRef?.namespace !== users) continue;
      if (pv.metadata.labels?.['workpartner-e2e'] && pv.metadata.labels['workpartner-e2e'] !== p) throw new Error('PV ownership conflict');
      kubectl(['label', 'pv', pv.metadata.name, selector, '--overwrite']);
    }
  }
  function audit(label = selector) {
    const residual = [];
    for (const scoped of [false, true]) {
      const discovery = kubectl(['api-resources', '--verbs=list', `--namespaced=${scoped}`, '-o', 'name'], { acceptFailure: true });
      if (discovery.error || (discovery.status !== 0 && !discovery.stdout.trim())) {
        const error = new Error(`API discovery failed; log: ${discovery.logPath}`); error.logPath = discovery.logPath; throw error;
      }
      if (discovery.status !== 0) discoveryWarnings.push({ namespaced: scoped,
        unavailableApiGroups: [...new Set([...discovery.stderr.matchAll(/([a-zA-Z0-9.-]+\/v[0-9][a-zA-Z0-9]*):/g)].map(match => match[1]))],
        log: discovery.logPath });
      const resources = discovery.stdout.trim().split(/\s+/).filter(Boolean);
      for (const resource of resources) {
        const objects = get([resource, ...(scoped ? ['-A'] : []), '-l', label]);
        residual.push(...(objects.items || []).map(item => ({ resource, name: item.metadata.name, namespace: item.metadata.namespace })));
      }
    }
    return residual;
  }
  if (mode === 'cleanup') {
    const errors = [], warnings = [];
    const attempt = async (label, fn) => { try { await fn(); } catch (error) { errors.push(label); if (error.logPath) warnings.push({ step: label, log: error.logPath }); } };
    // Restore policies before anything else if an interrupted S9/S12 removed them.
    if (state?.policiesRemoved) await attempt('restore policies', () => { apply(state.policies); state.policiesRemoved = false; save(); });
    await attempt('label test PVs', labelVolumes);
    await attempt('delete test namespaces', () => kubectl(['delete', 'namespace', '-l', selector, '--ignore-not-found=true', '--wait=true', '--timeout=180s']));
    await attempt('wait namespaces absent', async () => { await waitFor(() => get(['namespace', '-l', selector]).items.length === 0); });
    // Let Delete-policy provisioners remove their data before deleting Retain/static PV objects.
    await attempt('wait dynamic PV reclamation', async () => { await waitFor(() => !get(['pv', '-l', selector]).items.some(pv => pv.spec.persistentVolumeReclaimPolicy === 'Delete')); });
    if (!errors.includes('wait dynamic PV reclamation')) {
      await attempt('delete test StorageClass', () => kubectl(['delete', 'storageclass', '-l', selector, '--ignore-not-found=true', '--wait=true', '--timeout=120s']));
    }
    if (!errors.includes('wait dynamic PV reclamation')) await attempt('delete test PVs', () => kubectl(['delete', 'pv', '-l', selector, '--ignore-not-found=true', '--wait=true', '--timeout=120s']));
    await attempt('delete test PriorityClass', () => kubectl(['delete', 'priorityclass', '-l', selector, '--ignore-not-found=true', '--wait=true', '--timeout=120s']));
    // Do not remove a directory while its namespace or PV may still be mounted.
    if (state?.staticCreated && errors.length === 0) await attempt('remove owned static directory', () => {
      const directory = `${o.staticPvDir}/${p}`;
      remote(o.staticPvNode, `d=${shellQuote(directory)}\nif [ -d "$d" ]; then [ ! -L "$d" ]; [ "$(cat "$d/.workpartner-e2e")" = ${shellQuote(p)} ]; rm -rf -- "$d"; fi`);
      state.staticCreated = false; save();
    });
    for (const record of [...(state?.guards || [])].reverse()) {
      if (record.restored) continue;
      await attempt(`restore guard on ${record.node}`, () => {
        const restore = `delete table inet workpartner_guard\n${record.rules || ''}`;
        remote(record.node, `tables=$(nft list tables)\ncase "$tables" in *'table inet workpartner_guard'*) ;; *) nft add table inet workpartner_guard ;; esac\nprintf %s ${shellQuote(restore)} | nft -f -`);
        record.restored = true; save();
      });
    }
    // Journaled before distribution: even a partly imported image needs unpinning.
    if (state?.config.distribute) {
      state.distributedImages ||= [...new Set([state.config.image, state.config.gatewayImage])].filter(Boolean).map(image => ({ image }));
      for (const record of state.distributedImages) {
        if (record.unpinned) continue;
        await recordOnly(warnings, `unpin ${record.image}`, () => {
          command('bash', [path.join(root, 'tools/k8s/distribute-image.sh'), '--unpin', record.image,
            ...[o.serverNode, o.agentNode].flatMap(node => ['--node', o.sshNodes[node] || node])]);
          record.unpinned = true; save();
        });
      }
    }
    let residual = [];
    await attempt('audit every listable API resource', () => { residual = audit(); if (residual.length) throw new Error('Residual objects'); });
    let allPrefixesResidual = [];
    await recordOnly(warnings, 'audit all workpartner-e2e labels', () => { allPrefixesResidual = audit('workpartner-e2e'); });
    const result = { warnings, discoveryWarnings, allPrefixesResidual, status: errors.length ? 'FAIL' : 'PASS', errors, residual, finishedAt: new Date().toISOString() };
    write(path.join(requested.output, 'cleanup.json'), result);
    if (state) { state.cleanup = result; save(); }
    fs.rmSync(`${inputFile}.armed`, { force: true });
    console.error(`Cleanup ${result.status}; evidence: ${path.join(requested.output, 'cleanup.json')}`);
    console.log(JSON.stringify({ prefix: p, cleanup: result.status, scenarios: state?.results?.map(({ id, phase, status }) => ({ id, phase, status })), output: requested.output }));
    if (errors.length) throw new Error(`Cleanup incomplete; log: ${path.join(requested.output, 'cleanup.json')}`);
    return;
  }
  for (const file of ['tools/k8s/render.mjs', 'gateway/runtime/k8s.mjs', 'gateway/migration.mjs', 'tools/k8s/distribute-image.sh', 'tools/k8s/node-guard.sh']) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`Merge dependency before running: ${file}`);
  }
  if (state) throw new Error('Output already has state.json; use a fresh prefix/output or run --cleanup');
  JSON.parse(fs.readFileSync(o.kubeconfig, 'utf8'));
  const preflightResidual = audit();
  write(path.join(o.output, 'cleanup.json'), { status: 'NOT_RUN', discoveryWarnings });
  if (preflightResidual.length) throw new Error('Prefix already owns cluster objects; clean up first');
  for (const [resource, name] of [['namespace', sys], ['namespace', users], ['namespace', `${p}-probe`], ['storageclass', `${p}-local`], ['priorityclass', `${sys}-gateway`], ['pv', `${p}-static`]]) {
    const result = kubectl(['get', resource, name, '--ignore-not-found=true', '-o', 'name']);
    if (result.stdout.trim()) throw new Error('Test object name is already in use');
  }
  const nodes = get(['nodes']).items;
  for (const name of [o.serverNode, o.agentNode]) {
    const node = nodes.find(n => n.metadata.name === name);
    if (!node || node.metadata.labels?.['kubernetes.io/hostname'] !== name || !node.status.conditions.some(c => c.type === 'Ready' && c.status === 'True')) throw new Error('Selected node is not ready or hostname label differs');
    o.nodeIps.push(...node.status.addresses.filter(a => ['InternalIP', 'ExternalIP'].includes(a.type) && !a.address.includes(':')).map(a => a.address));
  }
  o.nodeIps = [...new Set(o.nodeIps)];
  o.organization = organization(o); o.probeNamespace = `${p}-probe`; o.probeName = `${p}-probe`;
  o.changedImageId = `sha256:${randomBytes(32).toString('hex')}`;
  state = { config: o, distributedImages: [], discoveryWarnings, warnings: [], guards: [], results: [], startedAt: new Date().toISOString() };
  save(); privateFile(`${inputFile}.armed`, p);
  const orgDir = path.join(o.output, 'organization'); privateDirectory(orgDir);
  write(path.join(orgDir, 'organization.json'), o.organization);
  const rendered = command(process.execPath, [path.join(root, 'tools/k8s/render.mjs'), '--org', orgDir]).stdout;
  let objects = rendered.split(/^---\s*$/m).filter(s => s.trim()).map(s => JSON.parse(s));
  objects = objects.map(object => {
    if (object.kind === 'StorageClass') object.reclaimPolicy = 'Delete';
    if (object.kind === 'Deployment') {
      const spec = object.spec.template.spec, container = spec.containers[0];
      container.command = ['node', '/app/tools/k8s/e2e/gateway.mjs']; container.args = [];
      container.volumeMounts = [ { name: 'config', mountPath: '/e2e', readOnly: true }, { name: 'secure', mountPath: '/e2e-secure' }, { name: 'state', mountPath: '/e2e-state' } ];
      spec.volumes = [{ name: 'config', configMap: { name: `${p}-config` } }, { name: 'secure', emptyDir: {} }, { name: 'state', emptyDir: {} }];
      container.readinessProbe = { tcpSocket: { port: 'gateway' }, periodSeconds: 1 };
    }
    return labelObject(object, p);
  });
  state.policies = objects.filter(obj => obj.kind === 'NetworkPolicy' && obj.metadata.namespace === users);
  save();
  const initial = objects.filter(obj => ['Namespace', 'ConfigMap'].includes(obj.kind));
  apply(initial);
  if (o.distribute) {
    const args = ['--namespace', sys, '--configmap', `${p}-images`, '--kubeconfig', o.kubeconfig,
      ...[o.serverNode, o.agentNode].flatMap(n => ['--node', o.sshNodes[n] || n])];
    state.distributedImages = []; save();
    for (const image of new Set([o.image, o.gatewayImage])) {
      state.distributedImages.push({ image, unpinned: false }); save();
      command('bash', [path.join(root, 'tools/k8s/distribute-image.sh'), image, ...args]);
    }
    const registry = JSON.parse(get(['configmap', `${p}-images`, '-n', sys]).data['images.json']);
    // K6 canonicalizes refs; require the caller to use that exact reference.
    if (!registry[o.image]) throw new Error('Use the canonical image reference registered by K6');
    o.imageId = registry[o.image];
  } else {
    o.imageId ||= command('docker', ['image', 'inspect', o.image, '--format', '{{.Id}}']).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(o.imageId)) throw new Error('Invalid imported image ID');
    register(o.imageId);
  }
  save();
  if (o.guard) {
    const rules = command('bash', [path.join(root, 'tools/k8s/node-guard.sh'), 'apply', '--pod-cidr', o.podCidrs,
      '--tunnel-interface', o.tunnelInterface, '--node-ips', o.nodeIps.join(','), '--dry-run']).stdout;
    for (const node of [o.serverNode, o.agentNode]) {
      const previous = remote(node, 'tables=$(nft list tables)\ncase "$tables" in *"table inet workpartner_guard"*) nft list table inet workpartner_guard ;; esac');
      const record = { node, rules: previous, restored: false }; state.guards.push(record); save();
      remote(node, `printf %s ${shellQuote(rules)} | nft -c -f -\nprintf %s ${shellQuote(rules)} | nft -f -`);
    }
  }
  const configMap = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: `${p}-config`, namespace: sys }, data: { 'config.json': JSON.stringify(o) } };
  apply([configMap, ...objects.filter(obj => !['Namespace', 'ConfigMap'].includes(obj.kind))]);
  const auxiliary = (name, namespace, role, command, extra = {}) => ({ apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace, labels: { 'workpartner/role': role, 'app.kubernetes.io/part-of': 'workpartner' } },
    spec: { automountServiceAccountToken: false, enableServiceLinks: false, nodeSelector: { 'kubernetes.io/hostname': o.serverNode },
      tolerations: [{ operator: 'Exists', effect: 'NoSchedule' }], ...extra,
      containers: [{ name: role, image: o.gatewayImage, imagePullPolicy: 'Never', command,
        securityContext: { runAsUser: 1001, runAsGroup: 1001, runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } } }] } });
  const serverCode = port => `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'0.0.0.0')`;
  apply([
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: o.probeNamespace } },
    auxiliary(`${p}-model`, sys, 'model-egress', ['node', '-e', serverCode(18082)]),
    auxiliary(o.probeName, o.probeNamespace, 'probe', ['node', '-e', 'setInterval(()=>{},1000)']),
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: `${p}-probe-exec`, namespace: o.probeNamespace },
      rules: [{ apiGroups: [''], resources: ['pods/exec'], resourceNames: [o.probeName], verbs: ['get', 'create'] }] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: `${p}-probe-exec`, namespace: o.probeNamespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: `${p}-probe-exec` },
      subjects: [{ kind: 'ServiceAccount', name: `${p}-gateway`, namespace: sys }] },
  ]);
  if (o.staticPvNode) {
    const directory = `${o.staticPvDir}/${p}`;
    // Save intent before mkdir so a signal between creation and journaling cannot leak data.
    const exists = remote(o.staticPvNode, `if [ -e ${shellQuote(directory)} ]; then echo exists; fi`);
    if (exists.trim()) throw new Error('Static test child directory already exists');
    state.staticCreated = true; save();
    remote(o.staticPvNode, `mkdir -- ${shellQuote(directory)}\nprintf %s ${shellQuote(p)} > ${shellQuote(`${directory}/.workpartner-e2e`)}\nchmod 0755 ${shellQuote(directory)}`);
    const claim = `${p}-static-data`;
    apply([
      { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: `${p}-static` }, spec: { capacity: { storage: '64Mi' }, accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Retain', storageClassName: `${p}-local`, local: { path: directory },
        claimRef: { namespace: users, name: claim }, nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [o.staticPvNode] }] }] } } } },
      { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claim, namespace: users }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: `${p}-local`,
        volumeName: `${p}-static`, resources: { requests: { storage: '64Mi' } } } },
    ]);
  }
  kubectl(['rollout', 'status', `deployment/${p}-gateway`, '-n', sys, '--timeout=180s']);
  for (const [ns, name] of [[sys, `${p}-model`], [o.probeNamespace, o.probeName]]) {
    kubectl(['wait', '--for=condition=Ready', `pod/${name}`, '-n', ns, '--timeout=120s']);
  }
  await waitForListener(kubectl, { namespace: sys, pod: `${p}-model`, node: o.serverNode, port: 18082 });
  function gateway() {
    return get(['pods', '-n', sys, '-l', `${selector},workpartner/role=gateway`]).items.find(pod => !pod.metadata.deletionTimestamp && pod.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
  }
  let gatewayPod = await waitFor(gateway); o.gatewayIp = gatewayPod.status.podIP; save();
  const probeSource = fs.readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
  const probeScript = probeSource.slice(0, probeSource.indexOf('// The same source'))
    + '\nconsole.log(JSON.stringify(await probe(JSON.parse(readFileSync(0,"utf8")))));';
  async function scenario(id, phase) {
    console.error(`Running ${id}${phase ? '/' + phase : ''}`);
    const result = kubectl(['exec', '-i', '-n', sys, gatewayPod.metadata.name, '-c', 'gateway', '--', 'node', '/app/tools/k8s/e2e/runner.mjs', id, ...(phase ? [phase] : [])], { input: JSON.stringify(o), acceptFailure: true });
    let data;
    try { data = JSON.parse(result.stdout); } catch { data = { id, phase, status: 'FAIL', error: { name: 'RunnerTransportError' } }; }
    if (result.logPath) data.commandLog = result.logPath;
    if (data.evidence?.policyTimeout) {
      data.evidence.policyDiagnostics = await collectPolicyDiagnostics({
        get: (resource, namespace, selector) => JSON.parse(kubectl(['get', resource, '-n', namespace,
          ...(selector ? ['-l', selector] : []), '-o', 'json'], { timeout: 5000 }).stdout),
        probe: (pod, target) => {
          const result = kubectl(['exec', '-i', '-n', pod.namespace, pod.name, '-c', pod.container,
            '--', 'node', '--input-type=module', '-e', probeScript],
          { input: JSON.stringify(target), timeout: 6000 });
          return JSON.parse(result.stdout);
        },
        guard: node => {
          const rules = command(o.nodeCommand, nodeArguments(o, node), {
            input: 'set -eu\nnft list table inet workpartner_guard\n', timeout: 5000,
          }).stdout;
          const file = `guard-${node}.txt`;
          privateFile(path.join(o.output, file), rules);
          return { file, rules };
        },
      }, o, data.evidence.policyTimeout.slug).catch(() => ({ errors: [{ step: 'collect policy diagnostics', status: 'unavailable' }] }));
    }
    state.results.push(data); save(); write(path.join(o.output, 'results.json'), { prefix: p, results: state.results, complete: false });
    labelVolumes();
    if (result.status !== 0 || data.status === 'FAIL') throw new Error(`${id} failed; log: ${result.logPath || path.join(o.output, 'results.json')}`);
    return data;
  }
  async function withHostProbes(fn) {
    try {
      apply([o.serverNode, o.agentNode].map((node, index) => auxiliary(`${p}-host-${index}`, sys, 'probe', ['node', '-e', serverCode(o.samplePort)],
        { hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet', nodeSelector: { 'kubernetes.io/hostname': node } })));
      for (let i = 0; i < 2; i++) kubectl(['wait', '--for=condition=Ready', `pod/${p}-host-${i}`, '-n', sys, '--timeout=120s']);
      // A live listener on each host makes the sampled node-port denials meaningful.
      for (const [i, node] of [o.serverNode, o.agentNode].entries()) {
        await waitForListener(kubectl, { namespace: sys, pod: `${p}-host-${i}`, node, port: o.samplePort });
      }
      return await fn();
    } finally {
      // Preserve the scenario error; namespace cleanup will retry failed deletions.
      for (let i = 0; i < 2; i++) await recordOnly(state.warnings, 'delete host probe', () =>
        kubectl(['delete', 'pod', `${p}-host-${i}`, '-n', sys, '--ignore-not-found=true', '--wait=true', '--timeout=120s']));
      save();
    }
  }
  const relayAllow = { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: `${p}-relay-probe`, namespace: users },
    spec: { podSelector: { matchLabels: { 'workpartner/role': 'user' } }, policyTypes: ['Ingress'], ingress: [{
      from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': o.probeNamespace } }, podSelector: { matchLabels: { 'workpartner/role': 'probe' } } }], ports: [{ protocol: 'TCP', port: 3092 }],
    }] } };
  try {
    for (let i = 1; i <= 6; i++) await scenario(`S${i}`);
    register(o.changedImageId);
    try { await scenario('S7'); } finally { register(o.imageId); }
    await scenario('S8');
    await scenario('S9', 'prepare');
    state.policiesRemoved = true; save();
    kubectl(['delete', 'networkpolicy', requiredPolicy(state.policies, o.organization.runtime.k8s.requiredPolicies), '-n', users, '--wait=true']);
    try { await scenario('S9', 'missing'); } finally { apply(state.policies); state.policiesRemoved = false; save(); }
    await scenario('S9', 'restored');
    await withHostProbes(() => scenario('S10'));
    apply([relayAllow]);
    try { await scenario('S11'); } finally { kubectl(['delete', 'networkpolicy', `${p}-relay-probe`, '-n', users, '--ignore-not-found=true']); }
    if (o.guard) {
      state.policiesRemoved = true; save();
      kubectl(['delete', 'networkpolicy', '-n', users, '-l', selector, '--wait=true']);
      try { await withHostProbes(() => scenario('S12')); } finally { apply(state.policies); state.policiesRemoved = false; save(); }
    } else await scenario('S12');
    o.beforeRestart = (await scenario('S13', 'prepare')).evidence; save();
    const old = gatewayPod.metadata.uid;
    kubectl(['delete', 'pod', gatewayPod.metadata.name, '-n', sys, '--wait=true', '--timeout=120s']);
    gatewayPod = await waitFor(() => { const pod = gateway(); return pod && pod.metadata.uid !== old ? pod : null; });
    o.gatewayIp = gatewayPod.status.podIP;
    await scenario('S13', 'restored');
    write(path.join(o.output, 'results.json'), { prefix: p, complete: true, results: state.results });
  } finally {
    if (o.guard) for (const node of [o.serverNode, o.agentNode]) {
      await recordOnly(state.warnings, `read guard counters on ${node}`, () => {
        const counters = remote(node, 'nft list table inet workpartner_guard');
        privateFile(path.join(o.output, `guard-${node}.txt`), counters);
      });
    }
    save();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  controller(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
