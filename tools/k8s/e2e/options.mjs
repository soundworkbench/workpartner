import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { outsideRepository } from './artifacts.mjs';

export const usage = `Usage: tools/k8s/e2e.sh --kubeconfig JSON --prefix wp-e2e-SUFFIX
  --image REF --gateway-image REF --server-node NAME --agent-node NAME
  [--node-ips IP,IP] [--external-probe HOST:PORT]
  [--static-pv-node NAME --static-pv-dir ABSOLUTE_PARENT]
  [--guard --pod-cidrs CIDR,CIDR --tunnel-interface NAME]
  [--node-command EXECUTABLE] [--ssh-node NODE=TARGET] (repeat per node)
  [--distribute] [--image-id sha256:HEX] [--output DIRECTORY]
  [--storage-provisioner NAME] [--storage-parameters JSON]
  [--api-probe IP:PORT] [--private-probe IP:PORT] [--sample-port PORT]
  [--cluster-domain DOMAIN] [--policy-timeout-ms MS] [--print-config]
  tools/k8s/e2e.sh --cleanup --prefix wp-e2e-SUFFIX [--kubeconfig JSON] [--output DIRECTORY]

Cleanup can use the saved output/state.json. Keep it until cleanup succeeds.
--node-command receives NODE sh -s, with a script on stdin (default: ssh -o BatchMode=yes).
Results default to a private /tmp directory; --output must be outside git repositories.
--ssh-node maps Kubernetes node names to SSH targets or adapter identifiers.
--guard mutates each selected node's nft table, then restores its saved state.
Authorize this outside the sandbox before invoking it on real nodes.
--static-pv-dir is a parent; only its newly created PREFIX child is removed.
No cluster or network access occurs with --help or --print-config.
`;
const valueOptions = new Set(['kubeconfig', 'prefix', 'image', 'gateway-image', 'server-node', 'agent-node',
  'node-ips', 'external-probe', 'static-pv-node', 'static-pv-dir', 'pod-cidrs', 'tunnel-interface',
  'node-command', 'ssh-node', 'image-id', 'output', 'storage-provisioner', 'storage-parameters',
  'api-probe', 'private-probe', 'sample-port', 'cluster-domain', 'policy-timeout-ms']);
const flags = new Set(['cleanup', 'guard', 'distribute', 'print-config', 'help']);
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
export function endpoint(value) {
  const match = /^([^\s:/]+):(\d+)$/.exec(value || '');
  if (!match || +match[2] < 1 || +match[2] > 65535) throw new Error('Expected IPv4-or-host:port');
  return { host: match[1], port: +match[2] };
}
export function parseArgs(args) {
  const o = { sshNodes: {}, nodeIps: [], storageProvisioner: 'rancher.io/local-path', storageParameters: {},
    nodeCommand: 'ssh', policyTimeoutMs: 60000, clusterDomain: 'cluster.local', samplePort: 18081,
    apiProbe: { host: '10.43.0.1', port: 443 }, privateProbe: { host: '10.0.0.1', port: 80 } };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || (!flags.has(name) && !valueOptions.has(name))) throw new Error(`Unknown argument: ${args[i]}`);
    if (seen.has(name) && name !== 'ssh-node') throw new Error(`Repeated argument: --${name}`);
    seen.add(name);
    if (flags.has(name)) { o[camel(name)] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) throw new Error(`Missing or invalid value: --${name}`);
    if (name === 'ssh-node') {
      const pos = value.indexOf('=');
      if (pos < 1 || !value.slice(pos + 1) || value.slice(pos + 1).startsWith('-')) throw new Error('Expected NODE=TARGET');
      o.sshNodes[value.slice(0, pos)] = value.slice(pos + 1);
    } else o[camel(name)] = value;
  }
  if (o.help) return o;
  if (!/^wp-e2e-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(o.prefix || '') || o.prefix.length > 30) throw new Error('Use a wp-e2e- prefix of at most 30 characters');
  o.output = outsideRepository(o.output || `/tmp/${o.prefix}-results-${randomUUID()}`);
  if (o.kubeconfig) o.kubeconfig = resolve(o.kubeconfig);
  if (o.cleanup) return o;
  for (const key of ['kubeconfig', 'image', 'gatewayImage', 'serverNode', 'agentNode']) if (!o[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`);
  if (o.serverNode === o.agentNode) throw new Error('Two different nodes are required');
  for (const key of ['serverNode', 'agentNode', 'staticPvNode']) if (o[key] && !/^[a-z0-9][a-z0-9.-]*$/.test(o[key])) throw new Error(`Invalid ${key}`);
  for (const key of ['image', 'gatewayImage']) if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(o[key])) throw new Error(`Invalid ${key}`);
  o.nodeIps = typeof o.nodeIps === 'string' ? o.nodeIps.split(',') : [];
  if (o.nodeIps.some(ip => isIP(ip) !== 4)) throw new Error('--node-ips requires IPv4 addresses');
  for (const key of ['externalProbe', 'apiProbe', 'privateProbe']) if (typeof o[key] === 'string') o[key] = endpoint(o[key]);
  o.policyTimeoutMs = Number(o.policyTimeoutMs);
  if (!Number.isSafeInteger(o.policyTimeoutMs) || o.policyTimeoutMs <= 0) throw new Error('Invalid policy timeout');
  o.samplePort = Number(o.samplePort);
  if (!Number.isInteger(o.samplePort) || o.samplePort < 1024 || o.samplePort > 65535 || [6443, 10250, 18082, 18083, 18084, 18085, 25808, 3092].includes(o.samplePort)) throw new Error('Invalid sample port');
  if (!!o.staticPvNode !== !!o.staticPvDir) throw new Error('Supply both --static-pv-node and --static-pv-dir');
  if (o.staticPvDir && (!/^\/[a-zA-Z0-9_./-]+$/.test(o.staticPvDir) || o.staticPvDir.split('/').includes('..') || o.staticPvDir === '/')) throw new Error('Invalid static PV parent');
  if (o.staticPvNode && ![o.serverNode, o.agentNode].includes(o.staticPvNode)) throw new Error('Static PV node must be one of the two test nodes');
  if (o.guard && (!o.podCidrs || !o.tunnelInterface)) throw new Error('--guard requires --pod-cidrs and --tunnel-interface');
  if (o.imageId && !/^sha256:[a-f0-9]{64}$/.test(o.imageId)) throw new Error('Invalid image ID');
  if (typeof o.storageParameters === 'string') o.storageParameters = JSON.parse(o.storageParameters);
  if (!o.storageParameters || Array.isArray(o.storageParameters) || typeof o.storageParameters !== 'object' || Object.values(o.storageParameters).some(v => typeof v !== 'string')) throw new Error('Storage parameters must be a string map');
  return o;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const o = parseArgs(process.argv.slice(2)); process.stdout.write(o.help ? usage : JSON.stringify(o) + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
