#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { list, matches, publishedLinks, readOwners, requireValue as check, validSlug, withLock, writeOwner } from './adopt-state.mjs';

import { inventoryProbe, parseInventoryProbe, inventoryPaths, inventoryDocument, saveInventory, prepareInventoryDirectory, readDecisions, verificationProbe, verificationRows } from './adopt-inventory.mjs';

const commands = new Set(['pv', 'inventory', 'switch', 'rollback', 'verify', 'status']);
const publishedDefault = '/run/workpartner/published';
const executeFile = promisify(execFile);

export const usage = `Usage: node tools/k8s/adopt-user.mjs <command> [slug] [--apply]
Commands: pv <slug> --node <node> --data-root <host root>
          inventory <slug> | switch <slug> | rollback <slug> | verify <slug> | status
Options: --organization <organization.json> --kubeconfig <flattened.json>
         --users <users.json> --host-secure <absolute host key directory>
         --owners-file <absolute host owners.json> --help
Default: dry-run; no filesystem, Docker, Kubernetes, or exec writes.
--data-root is the Docker host data root: <root><runtime.nextDirectory>/<slug>;
old work is <root>/users/<slug>/work. Run on that Docker host with these paths mounted.
Key directory: --host-secure, then runtime.hostSecure, then runtime.secureDirectory;
empty strings are unset. The final directory must be absolute, checked before any write.
It maps the gateway's secureDirectory (often /secure) to the host key directory.
switch preflight requires a readable <directory>/<keyPrefix><slug>.key
(keyPrefix is model.keyPrefix, default model-).
--owners-file defaults to runtime.migration.ownersFile; override a gateway-only path
with its host path. Both gateways must see replacements of this same file.
Run with both gateways using the same owners file; quiesce user requests and in-flight
lifecycle tasks for the selected user during switch/rollback. Apply operations take
an owners-file lock. After an interrupted process, inspect status before removing a stale lock.
inventory --apply writes <ownersFile>.adopt/<slug>.inventory.json, .inventory.txt
and .decisions.json (mode 0600). Each inventory resets decisions.
Complete every decision: carried with method, or dropped with reason; target may
map a changed path/user/port. switch requires the latest complete table before
any write, including the lock. Credential files are metadata-only; all process
and cron command arguments are redacted. inventory requires a running container
and uses a read-only root Node probe for all users; dry-run only plans this probe.
Acknowledge each inventory issue with acknowledged: true and a reason after manual review.
verify --apply checks carried items and reports mismatches as ALARM.
A missing table only warns and skips per-item checks in verify (also for an already
migrated switch); existing invalid tables still fail, and new switches require a complete table.
verify --apply runs read-only commands inside the workspace and gateway Pod.
Without --apply, verify only performs passive checks and prints the remaining checks.
`;

export function parseArgs(argv) {
  const options = { apply: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help') options.help = true;
    else if (['--node', '--data-root', '--organization', '--kubeconfig', '--users', '--host-secure', '--owners-file'].includes(arg)) {
      const value = argv[i + 1];
      check(typeof value === 'string' && !value.startsWith('--') && (value !== '' || arg === '--host-secure'), `Missing value for ${arg}`);
      check(options[arg.slice(2)] === undefined, `Duplicate option ${arg}`);
      options[arg.slice(2)] = argv[++i];
    } else {
      check(!arg.startsWith('-'), 'Unknown option');
      positional.push(arg);
    }
  }
  if (options.help) return options;
  const [command, slug] = positional;
  check(commands.has(command) && positional.length === (command === 'status' ? 1 : 2), 'Invalid command or arguments; use --help');
  check(command === 'status' || validSlug(slug), 'Invalid user slug');
  check(command === 'pv' || (!options.node && !options['data-root']), 'Node and data root options are only for pv');
  if (command === 'pv') check(options.node && path.isAbsolute(options['data-root'] || ''), 'pv requires --node and an absolute --data-root');
  for (const key of ['host-secure', 'owners-file']) {
    if (options[key] === undefined || (key === 'host-secure' && options[key] === '')) continue;
    check(path.isAbsolute(options[key]), `--${key} requires an absolute host path`);
  }
  return { ...options, command, slug };
}

async function defaultCommand(program, args) {
  try {
    const result = await executeFile(program, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (Number.isInteger(error.code)) return { exitCode: error.code, stdout: error.stdout || '' };
    throw new Error('Command unavailable or timed out');
  }
}

/** All runtime lifecycle work goes through the injected createRuntime factory.
 * client implements K1; command(program, argv) returns {exitCode, stdout}.
 * Users use the gateway users.json array format. Logs never include command errors or payloads.
 */
export async function runAdopt(options, dependencies) {
  const { organization, users, client, createRuntime, command = defaultCommand, log = console.log } = dependencies;
  const r = { ...organization.runtime,
    secureDirectory: options['host-secure'] || organization.runtime.hostSecure || organization.runtime.secureDirectory,
    migration: { ...organization.runtime.migration, ownersFile: options['owners-file'] ?? organization.runtime.migration?.ownersFile },
  }, k = r.k8s || {};
  let stage = 'configuration';
  let recovery = 'Correct configuration, then retry the command.';
  const report = { exitCode: 0, dryRun: !options.apply };
  const say = message => log(message);
  const step = async (name, action) => { stage = name; say(`${options.apply ? 'APPLY' : 'DRY-RUN'} ${name}`); return action(); };
  try {
    check(commands.has(options.command), 'Invalid command');
    for (const key of ['host-secure', 'owners-file']) {
      if (options[key] === undefined || (key === 'host-secure' && options[key] === '')) continue;
      check(typeof options[key] === 'string' && path.isAbsolute(options[key]), `--${key} requires an absolute host path`);
    }
    check(typeof r.secureDirectory === 'string' && path.isAbsolute(r.secureDirectory), 'Key directory must be absolute: configure --host-secure, runtime.hostSecure or runtime.secureDirectory');
    check(options.command === 'status' || validSlug(options.slug), 'Invalid user slug');
    check(typeof k.namespace === 'string' && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(k.namespace), 'Invalid user namespace');
    check(typeof r.nextContainerPrefix === 'string' && r.nextContainerPrefix.length > 0, 'Missing container prefix');
    check(typeof r.nextUserLabel === 'string' && r.nextUserLabel.length > 0, 'Missing user label');
    check(Number.isInteger(r.uid) && r.uid > 0, 'runtime.uid must be a non-root integer');
    const isStatus = options.command === 'status';
    check(Array.isArray(users) && users.every(user => user && typeof user.slug === 'string' && (isStatus || validSlug(user.slug))) && new Set(users.map(user => user.slug)).size === users.length, 'Invalid users list');
    let owners = await readOwners(r.migration?.ownersFile, { allowInvalidSlugs: isStatus });
    const user = users.find(item => item.slug === options.slug);
    if (options.command !== 'status') check(user?.backend === 'aionui', 'Only existing aionui users can be adopted');
    const slug = options.slug;
    const nameOf = value => {
      check(validSlug(value), 'Invalid user slug');
      const name = `${r.nextContainerPrefix}${value}`;
      check(/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) && name.length <= 52, 'Invalid runtime object name');
      return name;
    };
    const name = slug ? nameOf(slug) : undefined;
    const core = `/api/v1/namespaces/${k.namespace}`;
    const sts = `/apis/apps/v1/namespaces/${k.namespace}/statefulsets`;
    const published = k.publishedDirectory ?? publishedDefault;
    check(path.posix.isAbsolute(published) && path.posix.normalize(published) === published && published !== '/', 'Invalid published directory');
    // Disable inspect caching for an administrative operation spanning ownership changes.
    const runtime = await createRuntime({ ...organization, runtime: { ...r, kind: 'k8s' } }, { client, inspectCacheMs: 0 });
    const docker = async args => {
      const result = await command('docker', args);
      check(Number.isInteger(result?.exitCode), 'Invalid command result');
      check(result.exitCode === 0, 'Docker command failed');
      return result.stdout || '';
    };
    const dockerList = async () => (await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']))
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const dockerInspect = async (container = name) => {
      if (!(await dockerList()).some(item => item.Names === container)) return null;
      const value = JSON.parse(await docker(['inspect', '--type', 'container', container]));
      check(value.length === 1 && value[0].Name === `/${container}` && typeof value[0].State?.Running === 'boolean', 'Invalid Docker inspect result');
      return value[0];
    };
    const dockerActive = value => !!value && (value.State.Running || value.State.Restarting || value.State.Paused);
    const podSlug = pod => pod.metadata?.labels?.[r.nextUserLabel]
      || (pod.metadata?.name?.startsWith(r.nextContainerPrefix) ? pod.metadata.name.slice(r.nextContainerPrefix.length).replace(/-0$/, '') : null);
    const podsFor = async value => (await list(client, `${core}/pods`)).filter(pod => podSlug(pod) === value);
    const ownerFor = value => users.find(user => user.slug === value)?.backend !== 'aionui' && users.some(user => user.slug === value)
      ? 'docker' : Object.hasOwn(owners.users, value) ? owners.users[value] : owners.default;
    const ensureK8sStopped = async () => {
      const state = await runtime.inspect(slug);
      check(!state.exists || state.replicas === 0, 'StatefulSet replicas must be zero or StatefulSet absent');
      check((await podsFor(slug)).length === 0, 'Pod objects still exist');
    };
    const boundVolume = async (suffix = 'data', optional = false) => {
      const claim = await client.get(`${core}/persistentvolumeclaims/${name}-${suffix}`);
      if (!claim && optional) return null;
      check(claim?.status?.phase === 'Bound' && claim.spec?.volumeName && !claim.metadata?.deletionTimestamp, 'PVC must be Bound and not deleting');
      const volume = await client.get(`/api/v1/persistentvolumes/${claim.spec.volumeName}`);
      check(!volume?.metadata?.deletionTimestamp && volume?.spec?.claimRef?.name === `${name}-${suffix}` && volume.spec.claimRef.namespace === k.namespace
        && volume.spec.local?.path, 'PVC must reference this user local PV');
      return volume;
    };
    const expectedHostname = volume => {
      const terms = volume.spec.nodeAffinity?.required?.nodeSelectorTerms;
      check(!terms?.some(term => term.matchFields?.some(item => item.key === 'metadata.name')),
        'Legacy node affinity: manually delete the PV/PVC objects (Retain; do not delete data), then rerun pv');
      check(terms?.length === 1, 'PV requires a single expected node');
      const expression = terms[0].matchExpressions?.find(item => item.key === 'kubernetes.io/hostname');
      check(expression?.operator === 'In' && expression.values?.length === 1
        && typeof expression.values[0] === 'string' && expression.values[0].length > 0, 'PV requires an exact kubernetes.io/hostname affinity');
      return expression.values[0];
    };
    const adoptionVolumes = async () => {
      const data = await boundVolume();
      const hostname = expectedHostname(data);
      const oldwork = await boundVolume('oldwork', true);
      check(!oldwork || expectedHostname(oldwork) === hostname, 'Data and old-work volumes must use the same node');
      return data;
    };
    const dataMount = container => {
      const mount = container?.Mounts?.find(item => item.Destination === '/data');
      check(mount?.Type === 'bind' && mount.RW === true && path.isAbsolute(mount.Source), 'Docker /data must be a writable host bind mount');
      return mount.Source;
    };
    const mutation = async (description, fn) => step(description, async () => options.apply ? fn() : undefined);
    const setOwner = target => mutation(`owner -> ${target} (atomic rename)`, async () => {
      await writeOwner(r.migration.ownersFile, slug, target);
      owners.users[slug] = target;
    });
    const pause = async value => {
      const state = await runtime.inspect(slug);
      if (state.exists && (value || Object.hasOwn(state.annotations ?? {}, 'workpartner/paused'))) {
        await mutation(value ? 'pause k8s keep-running' : 'clear k8s pause', () => client.patch(`${sts}/${name}`,
          { metadata: { annotations: { 'workpartner/paused': value ? 'true' : null } } }, 'merge'));
      }
    };

    const files = inventoryPaths(r.migration.ownersFile, slug);
    async function decisionPreflight() {
      recovery = 'Complete the latest inventory decision table before switch; run inventory --apply if needed.';
      return step('switch preflight: inventory decisions', async () => {
        const table = await readDecisions(files, slug, { allowMissing: ownerFor(slug) === 'k8s' });
        if (!table && (!(await runtime.inspect(slug)).running || dockerActive(await dockerInspect()))) {
          return readDecisions(files, slug);
        }
        return table;
      });
    }

    async function verify() {
      recovery = 'Keep Docker stopped. Repair the failed check and rerun verify --apply, or run rollback --apply.';
      await step('verify Pod and expected node', async () => {
        const volume = await adoptionVolumes();
        const state = await runtime.inspect(slug), pods = await podsFor(slug);
        check(state.running && pods.length === 1 && pods[0].metadata.name === `${name}-0`
          && pods[0].status?.phase === 'Running' && !pods[0].metadata.deletionTimestamp, 'Expected exactly one running workspace Pod');
        const nodeName = pods[0].spec?.nodeName;
        check(typeof nodeName === 'string' && nodeName.length > 0, 'Pod has no assigned node');
        const node = await client.get(`/api/v1/nodes/${encodeURIComponent(nodeName)}`);
        check(node?.metadata?.name === nodeName
          && node.metadata.labels?.['kubernetes.io/hostname'] === expectedHostname(volume), 'Pod is on the wrong node');
        report.node = pods[0].spec.nodeName;
        report.address = state.address;
      });
      await step('verify gateway AionUi status', async () => {
        if (!options.apply) return say('DRY-RUN planned gateway exec: GET /api/auth/status');
        check(k.systemNamespace || client.namespace, 'Missing system namespace');
        const gateways = await list(client, `/api/v1/namespaces/${k.systemNamespace || client.namespace}/pods?labelSelector=${encodeURIComponent('workpartner/role=gateway')}`);
        const gateway = gateways.find(pod => pod.status?.phase === 'Running' && !pod.metadata.deletionTimestamp);
        check(gateway && report.address, 'Gateway Pod or workspace address unavailable');
        const script = 'const http=require("node:http");const [host,port]=process.argv.slice(1);const q=http.get({host,port,path:"/api/auth/status",timeout:10000},r=>{r.resume();process.exitCode=r.statusCode===200?0:1});q.on("timeout",()=>q.destroy());q.on("error",()=>{process.exitCode=1});';
        // Deployment Pod names differ from their container name. Keep this override local
        // to the gateway probe so other system Pods retain their configured/default target.
        const gatewayRuntime = await createRuntime({ ...organization, runtime: { ...r, kind: 'k8s', k8s: { ...k, systemContainer: 'gateway' } } }, { client, inspectCacheMs: 0 });
        const result = await gatewayRuntime.execNamed(gateway.metadata.name, ['node', '-e', script, report.address.host, String(report.address.port)], { timeout: 15000 });
        check(result.exitCode === 0, 'Gateway cannot reach AionUi status');
      });
      await step('verify configured cc-connect process', async () => {
        if (!options.apply) return say('DRY-RUN planned workspace exec and processes check');
        const configured = await runtime.exec(slug, ['sh', '-c', 'test -f /data/.cc-connect/config.toml'], { timeout: 10000 });
        check([0, 1].includes(configured.exitCode), 'Unable to check bridge configuration');
        if (configured.exitCode === 0) check((await runtime.processes(slug)).some(process => /(^|\/)cc-connect$/.test(process.args.split(/\s+/)[0])), 'Configured cc-connect process missing');
      });
      await step('verify preview key link', async () => {
        if (!options.apply) return say('DRY-RUN planned workspace exec: preview key link and readable target');
        const result = await runtime.exec(slug, ['sh', '-c', 'test -L /data/.zp-preview-relay-key && test "$(readlink /data/.zp-preview-relay-key)" = "$1/.zp-preview-relay-key" && test -s /data/.zp-preview-relay-key && test -r /data/.zp-preview-relay-key', 'verify', published], { timeout: 10000 });
        check(result.exitCode === 0, 'Preview key link is invalid');
      });
      await step('verify Docker stopped', async () => check(!dockerActive(await dockerInspect()), 'Docker is still active'));
      await step('verify carried inventory items', async () => {
        const table = await readDecisions(files, slug, { allowMissing: true });
        if (!table) {
          report.inventoryVerified = false;
          report.alarms = [{ slug, alarm: 'missing-pre-migration-inventory',
            message: 'This user has no pre-migration inventory decision table; per-item checks skipped. Manually check cron, /srv and /opt services, processes, listening ports, tmux/screen sessions, credential dotfiles, bot configs and container-layer patches.' }];
          say(`ALARM ${JSON.stringify(report.alarms[0])}`);
          return;
        }
        if (!options.apply) return say('DRY-RUN planned per-item carried inventory checks');
        const rows = table.items.filter(item => item.decision === 'carried');
        report.alarms = [];
        if (rows.length) {
          const result = await runtime.exec(slug, verificationProbe, { timeout: 120000, stdin: JSON.stringify(verificationRows(rows)), strictOutput: true });
          check(result.exitCode === 0, 'Carried inventory verification probe failed');
          report.alarms = JSON.parse(result.stdout);
          check(Array.isArray(report.alarms), 'Invalid carried inventory verification response');
        }
        for (const alarm of report.alarms) say(`ALARM ${JSON.stringify(alarm)}`);
        check(report.alarms.length === 0, 'Carried inventory items missing or mismatched');
        report.inventoryVerified = true;
      });
      report.verified = !!options.apply;
      say(options.apply ? (report.inventoryVerified === false ? 'Runtime checks passed; missing pre-migration inventory requires manual review' : 'Verified') : 'DRY-RUN passive checks passed; run verify --apply to complete verification');
    }

    async function pv() {
      recovery = 'Inspect existing PV/PVC bindings; correct the conflict and rerun pv. Do not delete data or rebind another claim.';
      check(options.node && path.isAbsolute(options['data-root'] || ''), 'pv requires node and data root');
      check(path.posix.isAbsolute(r.nextDirectory || '') && !r.nextDirectory.split('/').includes('..'), 'Invalid nextDirectory');
      const root = path.resolve(options['data-root']);
      const data = path.join(root, r.nextDirectory, slug);
      const oldwork = path.join(root, 'users', slug, 'work');
      check((await fs.stat(data)).isDirectory(), 'Existing user data directory required');
      const container = await dockerInspect();
      check(container && path.resolve(dataMount(container)) === data, 'Data root does not match Docker /data');
      const node = await client.get(`/api/v1/nodes/${encodeURIComponent(options.node)}`);
      check(node?.metadata?.name === options.node, 'Node not found');
      const hostname = node.metadata.labels?.['kubernetes.io/hostname'];
      check(typeof hostname === 'string' && hostname.length > 0, 'Node requires a non-empty kubernetes.io/hostname label');
      const volumes = [['data', data]];
      try { if ((await fs.stat(oldwork)).isDirectory()) volumes.push(['oldwork', oldwork]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const planned = [];
      for (const [suffix, directory] of volumes) {
        const claimName = `${name}-${suffix}`, volumeName = `${k.namespace}-${claimName}`;
        check(volumeName.length <= 253, 'PV name too long');
        if (suffix === 'oldwork') check(container.Mounts.some(mount => mount.Destination === '/data/old-work' && mount.Type === 'bind' && !mount.RW && path.resolve(mount.Source) === directory), 'Old work directory must match the read-only Docker mount');
        const labels = { 'app.kubernetes.io/part-of': 'workpartner', 'workpartner/role': 'user', [r.nextUserLabel]: slug };
        const accessModes = [suffix === 'data' ? 'ReadWriteOnce' : 'ReadOnlyMany'];
        const size = k.dataVolumeSize ?? '20Gi';
        const volume = { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: volumeName, labels }, spec: {
          capacity: { storage: size }, volumeMode: 'Filesystem', accessModes, persistentVolumeReclaimPolicy: 'Retain', storageClassName: '',
          local: { path: directory }, claimRef: { namespace: k.namespace, name: claimName },
          nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [hostname] }] }] } },
        } };
        const claim = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claimName, namespace: k.namespace, labels }, spec: {
          volumeMode: 'Filesystem', accessModes, storageClassName: '', volumeName, resources: { requests: { storage: size } },
        } };
        planned.push(['/api/v1/persistentvolumes', volume], [`${core}/persistentvolumeclaims`, claim]);
      }
      const matchesPlan = (actual, wanted) => {
        if (actual && wanted.kind === 'PersistentVolume') expectedHostname(actual);
        return matches(actual, wanted);
      };
      // Validate the entire plan before the first create, including the optional old-work claim.
      for (const item of planned) {
        item[2] = await client.get(`${item[0]}/${item[1].metadata.name}`);
        check(!item[2] || matchesPlan(item[2], item[1]), 'Existing PV/PVC conflicts with requested data');
      }
      report.manifests = planned.map(item => item[1]);
      for (const [route, object, existing] of planned) await mutation(`${existing ? 'retain' : 'create'} ${object.kind} ${object.metadata.name}`, async () => {
        if (existing) return;
        try { await client.create(route, object); }
        catch (error) {
          if (error.reason !== 'AlreadyExists') throw error;
          check(matchesPlan(await client.get(`${route}/${object.metadata.name}`), object), 'Concurrent PV/PVC conflict');
        }
      });
    }

    async function inventory() {
      recovery = 'Review the inventory report. Resolve unsupported patches manually; rerun inventory before switch.';
      const container = await dockerInspect();
      check(container, 'Docker container missing');
      report.inventory = [];
      let collected;
      if (options.apply) {
        check(container.State.Running, 'Inventory requires a running Docker container');
        // Invalidate a previous approval even when this new attempt later fails.
        await prepareInventoryDirectory(files);
        await fs.rm(files.decisions, { force: true });
        collected = await step('inventory all users and services', async () => parseInventoryProbe(
          await command('docker', ['exec', '--user', '0:0', '--env', 'NODE_OPTIONS=', '--env', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', name, ...inventoryProbe])));
      } else say('DRY-RUN planned read-only all-user inventory probe and report/decision files');
      const diff = await step('inventory docker diff', () => docker(['diff', name]));
      for (const line of diff.split('\n').filter(Boolean)) {
        const match = /^([ACD]) (\/[^\r\n]*)$/.exec(line);
        check(match, 'Invalid docker diff output');
        const [, change, filename] = match;
        const candidate = change !== 'D' && /^\/usr\/local\/bin\/[^/]+$/.test(filename) && !['.', '..'].includes(path.posix.basename(filename));
        let executable = false, linkTarget;
        if (candidate && container.State.Running && options.apply) {
          const result = await command('docker', ['exec', '--user', `${r.uid}:${r.uid}`, name, 'sh', '-c', 'if test -L "$1"; then readlink -- "$1" || exit 3; exit 2; fi; test -f "$1" && test -x "$1" && test -r "$1"', 'inventory', filename]);
          check([0, 1, 2].includes(result.exitCode), 'Executable inspection failed');
          executable = result.exitCode === 0;
          if (result.exitCode === 2) {
            check(typeof result.stdout === 'string' && result.stdout.length > 0, 'Symlink target unavailable');
            linkTarget = result.stdout.replace(/\n$/, '');
          }
        }
        const action = linkTarget !== undefined ? 'symlink-review' : executable ? 'copy' : candidate && !options.apply ? 'plan-check-executable-and-copy' : candidate ? 'needs-running-container-or-readable-executable' : 'report-only';
        const entry = { change, path: filename, action, ...(linkTarget !== undefined ? { linkTarget } : {}) };
        report.inventory.push(entry);
        say(`INVENTORY ${JSON.stringify(entry)}`);
        if (executable) await mutation(`inventory copy ${JSON.stringify(filename)} as uid ${r.uid}`, () => docker([
          'exec', '--user', `${r.uid}:${r.uid}`, name, 'sh', '-ec',
          'test ! -L "$1"; test -f "$1"; test -x "$1"; test -r "$1"; test ! -L /data/.zp-init.d; test ! -L /data/.zp-init.d/bin; mkdir -p /data/.zp-init.d/bin; install -m 0755 -- "$1" "/data/.zp-init.d/bin/$2"',
          'inventory', filename, path.posix.basename(filename),
        ]));
      }
      if (collected) {
        report.inventoryReport = inventoryDocument(slug, [
          ...collected.items, ...report.inventory.map(item => ({ kind: 'docker-diff', ...item })),
        ], collected.issues);
        await saveInventory(files, report.inventoryReport);
        report.inventoryFiles = files;
        say(`INVENTORY files ${JSON.stringify(files)}`);
        check(collected.issues.length === 0, 'Inventory incomplete; resolve probe issues and rerun inventory --apply, or acknowledge each issue with a reason in the decision table');
      }
    }

    async function switchUser() {
      const decisions = await decisionPreflight();
      recovery = 'Docker ownership is unchanged. Correct preflight checks and rerun switch.';
      const volume = await step('switch preflight: bound PVC and registered image', async () => {
        const data = await adoptionVolumes();
        check(await runtime.imageId(r.nextImage), 'Image is not registered');
        return data;
      });
      await step('switch preflight: readable model key', async () => {
        const filename = path.join(r.secureDirectory, `${organization.model?.keyPrefix ?? 'model-'}${slug}.key`);
        try {
          const file = await fs.open(filename, 'r');
          try { check((await file.stat()).isFile(), 'Model key must be a regular file'); }
          finally { await file.close(); }
        } catch { check(false, 'Model key file must exist and be readable'); }
      });
      const container = await dockerInspect();
      check(container && path.resolve(dataMount(container)) === path.resolve(volume.spec.local.path), 'Docker and PV must use the same data directory');
      const pods = await podsFor(slug), state = await runtime.inspect(slug);
      const alreadyMigrated = ownerFor(slug) === 'k8s' && state.running && !dockerActive(container);
      // Recheck the exception against the state used for this switch, before any mutation.
      if (!decisions && !alreadyMigrated) await step('switch preflight: inventory decisions', () => readDecisions(files, slug));
      if (pods.length && dockerActive(container)) {
        recovery = 'Duplicate instances detected. Stop the new Pod and confirm StatefulSet replicas=0 and no Pods; rerun switch to restore Docker ownership.';
        await pause(true);
        await mutation('stop new duplicate Pod', () => runtime.stop(slug));
        if (options.apply) await ensureK8sStopped();
        await setOwner('docker');
        if (options.apply) {
          recovery = 'Owner is docker, but duplicate cleanup is not confirmed. Run rollback --apply to stop k8s and verify replicas=0 and no Pods before retaining Docker.';
          await step('confirm duplicate k8s stopped after owner -> docker', ensureK8sStopped);
          recovery = 'Duplicate instances detected and Pod stopped; owner is docker, Docker is retained. Inspect status, then retry switch.';
        }
        stage = 'duplicate instances detected';
        throw new Error('Duplicate instances detected');
      }
      if (alreadyMigrated) {
        check(container.HostConfig?.RestartPolicy?.Name === 'no', 'Migrated Docker restart policy must remain no');
        return verify();
      }
      check(pods.length === 0 && !state.running && (state.replicas === 0 || !state.exists), 'Stop existing k8s workload before switching');
      recovery = 'Do not start a Pod. Correct the Docker operation and rerun switch; Docker ownership may still be active.';
      await mutation('docker restart=no', () => docker(['update', '--restart=no', name]));
      await mutation('docker stop', () => docker(['stop', name]));
      if (options.apply) {
        const stopped = await dockerInspect();
        check(stopped && !dockerActive(stopped) && stopped.HostConfig?.RestartPolicy?.Name === 'no', 'Docker did not stop with restart=no');
      }
      recovery = 'Keep Docker stopped with restart=no. Rerun switch, or run rollback --apply to restore Docker safely.';
      await setOwner('k8s');
      await mutation('k8s ensureIsolation', () => runtime.ensureIsolation(slug));
      await mutation('k8s create', () => runtime.create(user, dependencies.modelConfig ? { modelConfig: dependencies.modelConfig } : {}));
      await pause(false);
      await mutation('k8s start', async () => {
        owners = await readOwners(r.migration.ownersFile);
        check(ownerFor(slug) === 'k8s', 'Ownership changed during switch; expected k8s');
        check(!dockerActive(await dockerInspect()), 'Docker restarted during switch');
        await runtime.start(slug);
      });
      if (options.apply) await verify();
      else say('DRY-RUN verify after start: Pod/node, gateway status, cc-connect, preview link, Docker stopped');
    }

    async function rollback() {
      recovery = 'Keep Docker stopped. Resolve the k8s stop failure and rerun rollback; never start Docker while any Pod exists.';
      const container = await dockerInspect();
      check(container, 'Docker container missing');
      const directory = dataMount(container);
      await pause(true);
      await mutation('k8s stop and wait for Pod deletion', () => runtime.stop(slug));
      if (options.apply) await ensureK8sStopped();
      recovery = 'Pod is stopped. Rerun rollback to finish ownership and published-link cleanup before starting Docker.';
      await setOwner('docker');
      const links = await step('scan published links after Pod deletion', () => publishedLinks(directory, published));
      for (const filename of links) await mutation(`remove published link ${JSON.stringify(path.basename(filename))}`, async () => {
        // Re-evaluate the target immediately before unlink; never remove regular data files.
        if ((await publishedLinks(directory, published)).includes(filename)) await fs.unlink(filename);
      });
      recovery = 'Owner is docker. Keep Docker stopped until StatefulSet replicas=0 (or absent) and no Pods remain; rerun rollback to restore restart=unless-stopped and start Docker.';
      await mutation('docker restart=unless-stopped', () => docker(['update', '--restart=unless-stopped', name]));
      await mutation('docker start', async () => {
        await ensureK8sStopped();
        await docker(['start', name]);
        check(dockerActive(await dockerInspect()), 'Docker did not start');
      });
    }

    async function status() {
      recovery = 'Resolve ownership and duplicate-instance alarms, then rerun status. For duplicates, stop the new instance first.';
      const pods = await list(client, `${core}/pods`), containers = await dockerList();
      const sets = await list(client, sts);
      const slugs = new Set([...users.map(user => user.slug), ...Object.keys(owners.users), ...pods.map(podSlug),
        ...sets.map(item => item.metadata?.labels?.[r.nextUserLabel] || (item.metadata?.name?.startsWith(r.nextContainerPrefix) ? item.metadata.name.slice(r.nextContainerPrefix.length) : null)),
        ...containers.filter(item => item.Names.startsWith(r.nextContainerPrefix)).map(item => item.Names.slice(r.nextContainerPrefix.length))]);
      report.rows = []; report.alarms = []; report.skipped = [];
      for (const value of [...slugs].filter(value => value != null && !validSlug(value)).sort()) {
        const row = { slug: value, reason: 'invalid-slug' };
        report.skipped.push(row);
        say(`SKIP ${JSON.stringify(row)}`);
      }
      for (const value of [...slugs].filter(validSlug).sort()) {
        const userPods = pods.filter(pod => podSlug(pod) === value);
        const entry = users.find(user => user.slug === value);
        const containerName = entry && entry.backend !== 'aionui' && r.containerPrefix ? `${r.containerPrefix}${value}` : nameOf(value);
        const container = containers.find(item => item.Names === containerName);
        const state = await runtime.inspect(value), owner = ownerFor(value);
        const row = { slug: value, owner, pod: userPods.map(pod => ({ name: pod.metadata.name, phase: pod.status?.phase ?? 'Unknown', terminating: !!pod.metadata.deletionTimestamp })), replicas: state.replicas ?? null, docker: container?.State ?? 'absent' };
        report.rows.push(row); say(`STATUS ${JSON.stringify(row)}`);
        const alarms = [];
        if (owner === 'k8s' && ['running', 'restarting', 'paused'].includes(row.docker)) alarms.push('k8s-owner-docker-running');
        if (owner === 'docker' && userPods.length) alarms.push('docker-owner-pod-exists');
        if (userPods.length > 1) alarms.push('multiple-pods');
        for (const alarm of alarms) { report.alarms.push({ slug: value, alarm }); say(`ALARM ${value} ${alarm}`); }
      }
      if (report.alarms.length) { report.exitCode = 1; say(`NEXT: ${recovery}`); }
    }
    const action = async () => {
      stage = options.command;
      await { pv, inventory, switch: switchUser, rollback, verify, status }[options.command]();
    };
    if (options.command === 'switch') {
      await decisionPreflight();
      recovery = 'Docker ownership is unchanged. Correct volume preflight checks and rerun switch.';
      // Reject unsafe affinities before even creating the operation lock; recheck under lock.
      await step('switch preflight: volume affinity', adoptionVolumes);
    }
    stage = 'acquire operation lock';
    recovery = 'If another adoption is active, wait for it. For a stale owners-file .adopt.lock, inspect status before removing the lock and retrying.';
    if (options.apply && !['status', 'verify'].includes(options.command)) await withLock(r.migration.ownersFile, async () => {
      stage = options.command;
      owners = await readOwners(r.migration.ownersFile);
      await action();
    });
    else await action();
    return report;
  } catch (error) {
    // Upstream errors may contain tokens, command output, or Secret data.
    report.exitCode = 1; report.failedStage = stage;
    say(`FAILED at ${stage}${error.code === 'AdoptCheckFailed' ? `: ${error.message}` : ''}. NEXT: ${recovery}`);
    return report;
  }
}

export async function main(argv = process.argv.slice(2), injected = {}) {
  const log = injected.log ?? console.log;
  try {
    const options = parseArgs(argv);
    if (options.help) { log(usage); return 0; }
    const { resolveOrganization, nextModelConfig } = await import('../../gateway/organization/resolve.mjs');
    const organization = injected.organization ?? (options.organization
      ? JSON.parse(await fs.readFile(options.organization, 'utf8')) : resolveOrganization());
    const users = injected.users ?? JSON.parse(await fs.readFile(options.users || organization.runtime.usersFile, 'utf8'));
    const client = injected.client ?? (await import('../../gateway/runtime/kube-client.mjs')).createKubeClient({
      ...(options.kubeconfig ? { kubeconfigJson: await fs.readFile(options.kubeconfig, 'utf8') } : { inCluster: true }),
      timeoutMs: organization.runtime.k8s?.apiTimeoutMs,
    });
    const createRuntime = injected.createRuntime ?? (await import('../../gateway/runtime/index.mjs')).createRuntime;
    const modelConfig = injected.modelConfig ?? JSON.stringify(nextModelConfig(organization));
    return (await runAdopt(options, { ...injected, organization, users, client, createRuntime, modelConfig, log })).exitCode;
  } catch { log('FAILED to load command/configuration. NEXT: use --help and check organization, users, owners and JSON kubeconfig.'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
