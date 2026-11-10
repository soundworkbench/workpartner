#!/usr/bin/env node
/** Render offline deployment manifests; JSON documents are also valid YAML. */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { organizationData } from '../../gateway/organization/resolve.mjs';

const templateDirectory = new URL('../../deploy/k8s/', import.meta.url);
const templates = ['namespaces', 'rbac', 'gateway', 'services', 'network-policies', 'storage', 'images'];
const kinds = ['Namespace', 'ServiceAccount', 'Role', 'RoleBinding', 'PriorityClass',
  'Deployment', 'Service', 'EndpointSlice', 'NetworkPolicy', 'StorageClass', 'ConfigMap'];
const privateCidrs = ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12',
  '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8'];
const policyNames = ['workpartner-default-deny', 'workpartner-user-egress', 'workpartner-user-ingress'];
const partOf = { 'app.kubernetes.io/part-of': 'workpartner' };
const gatewayLabels = { ...partOf, 'workpartner/role': 'gateway' };
const userLabels = { ...partOf, 'workpartner/role': 'user' };

function serviceAccountNamespace() {
  try { return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function context(organization) {
  const runtime = organization.runtime || {};
  const k8s = runtime.k8s || {};
  const deploy = k8s.deploy || {};
  const entry = deploy.entry || {};
  const paths = deploy.hostPaths || {};
  const storage = deploy.newUserStorage || {};
  const systemNamespace = k8s.systemNamespace ?? serviceAccountNamespace();
  const modelAddress = organization.model?.baseUrl;
  const missing = [];
  const invalid = [];
  const need = (name, value) => {
    if (value === undefined || value === null || value === '') missing.push(name);
  };
  const check = (name, condition) => { if (!condition) invalid.push(name); };
  for (const [name, value] of Object.entries({
    'runtime.kind': runtime.kind,
    'runtime.k8s.namespace': k8s.namespace,
    'runtime.k8s.systemNamespace': systemNamespace,
    'runtime.k8s.storageClass': k8s.storageClass,
    'runtime.k8s.deploy.gatewayImage': deploy.gatewayImage,
    'runtime.k8s.deploy.entry.mode': entry.mode,
    'runtime.k8s.deploy.hostPaths.organization': paths.organization,
    'runtime.k8s.deploy.hostPaths.secure': paths.secure,
    'runtime.k8s.deploy.hostPaths.state': paths.state,
    'runtime.k8s.deploy.hostPaths.usersFile': paths.usersFile,
    'runtime.k8s.deploy.egressExceptCidrs': deploy.egressExceptCidrs,
    'runtime.k8s.deploy.newUserStorage.provisioner': storage.provisioner,
    'runtime.gatewayOrigin': runtime.gatewayOrigin,
    'runtime.internalOrigin': runtime.internalOrigin,
    'runtime.gatewayPort': runtime.gatewayPort,
    'runtime.internalPort': runtime.internalPort,
    'runtime.nextPort': runtime.nextPort,
    'runtime.secureDirectory': runtime.secureDirectory,
    'runtime.stateDirectory': runtime.stateDirectory,
    'runtime.usersFile': runtime.usersFile,
    'model.baseUrl': modelAddress,
  })) need(name, value);
  if (entry.mode === 'hostPort') {
    need('runtime.k8s.deploy.entry.hostIP', entry.hostIP);
    need('runtime.k8s.deploy.entry.hostPort', entry.hostPort);
  } else if (entry.mode === 'clusterIP') need('runtime.k8s.deploy.entry.clusterIP', entry.clusterIP);

  const dnsLabel = value => typeof value === 'string' && value.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
  const dnsName = value => typeof value === 'string' && value.length <= 253 && value.split('.').every(dnsLabel);
  const serviceName = value => dnsLabel(value) && /^[a-z]/.test(value);
  const labelPart = value => typeof value === 'string' && value.length <= 63
    && /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i.test(value);
  const labelKey = key => {
    const parts = key.split('/');
    return parts.length === 1 ? labelPart(key) : parts.length === 2 && dnsName(parts[0]) && labelPart(parts[1]);
  };
  const stringMap = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string');
  const selector = value => stringMap(value) && Object.keys(value).length > 0
    && Object.entries(value).every(([key, item]) => labelKey(key) && (item === '' || labelPart(item)));
  const port = value => Number.isInteger(value) && value > 0 && value <= 65535;
  const absolutePath = value => typeof value === 'string' && isAbsolute(value) && value !== '/' && !/[\0\r\n]/.test(value);
  const persistentFiles = {
    'runtime.sessionKeyFile': runtime.sessionKeyFile,
    'runtime.cookieFile': runtime.cookieFile,
    'identity.appSecretFile': organization.identity?.appSecretFile,
    ...(runtime.migration !== undefined && runtime.migration !== null
      ? { 'runtime.migration.ownersFile': runtime.migration.ownersFile } : {}),
  };
  for (const [name, value] of Object.entries(persistentFiles)) {
    need(name, value);
    check(`${name} (must be below runtime.secureDirectory or runtime.stateDirectory)`,
      absolutePath(value) && [runtime.secureDirectory, runtime.stateDirectory].some(directory => {
        if (!absolutePath(directory)) return false;
        const child = relative(directory, value);
        return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
      }));
  }
  const cidr = value => {
    if (typeof value !== 'string') return false;
    const [address, prefix, extra] = value.split('/');
    if (isIP(address) !== 4 || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(prefix) || extra !== undefined) return false;
    const bits = address.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
    return bits % (2 ** (32 - Number(prefix))) === 0;
  };
  const endpoint = (name, value) => {
    try {
      const url = new URL(value);
      const suffix = `.${systemNamespace}.svc.${k8s.clusterDomain ?? 'cluster.local'}`;
      const service = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : url.hostname;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || !dnsName(url.hostname) || !serviceName(service)) throw new Error();
      return { name: service, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url };
    } catch { invalid.push(`${name} (expected an HTTP(S) URL with a short Service hostname or its system-namespace FQDN)`); return {}; }
  };

  const gateway = endpoint('runtime.gatewayOrigin', runtime.gatewayOrigin);
  const internal = endpoint('runtime.internalOrigin', runtime.internalOrigin);
  const model = endpoint('model.baseUrl', modelAddress);
  if (organization.model?.nextBaseUrl) {
    const nextModel = endpoint('model.nextBaseUrl', organization.model.nextBaseUrl);
    check('model.baseUrl and model.nextBaseUrl (hostnames and ports must match)',
      model.name === nextModel.name && model.port === nextModel.port);
  }
  check('runtime.kind (must be k8s)', runtime.kind === 'k8s');
  check('runtime.k8s.namespace', dnsLabel(k8s.namespace));
  check('runtime.k8s.systemNamespace (must differ from the user namespace)',
    dnsLabel(systemNamespace) && systemNamespace !== k8s.namespace);
  check('runtime.k8s.storageClass', dnsName(k8s.storageClass));
  const imageConfigMap = k8s.imageConfigMap ?? 'workpartner-images';
  const governingService = k8s.governingService ?? 'workpartner-users';
  const gatewayNodeSelector = deploy.gatewayNodeSelector ?? { 'node-role.kubernetes.io/control-plane': 'true' };
  check('runtime.k8s.imageConfigMap', dnsName(imageConfigMap));
  check('runtime.k8s.governingService', serviceName(governingService));
  check('runtime.k8s.deploy.gatewayNodeSelector', selector(gatewayNodeSelector));
  const hasModelSelector = deploy.modelEgressSelector !== undefined;
  const hasModelEndpoint = deploy.modelEgressEndpoint !== undefined;
  const modelEndpoint = deploy.modelEgressEndpoint;
  const modelChoice = 'runtime.k8s.deploy.modelEgressSelector or runtime.k8s.deploy.modelEgressEndpoint (exactly one required)';
  if (!hasModelSelector && !hasModelEndpoint) missing.push(modelChoice);
  check(modelChoice, !(hasModelSelector && hasModelEndpoint));
  if (hasModelSelector) {
    check('runtime.k8s.deploy.modelEgressSelector', selector(deploy.modelEgressSelector));
    check('runtime.k8s.deploy.modelEgressSelector (must include workpartner/role: model-egress)',
      deploy.modelEgressSelector?.['workpartner/role'] === 'model-egress');
    if (selector(deploy.modelEgressSelector)) {
      check('runtime.k8s.deploy.modelEgressSelector (must not select gateway Pods)',
        !Object.entries(deploy.modelEgressSelector).every(([key, value]) => gatewayLabels[key] === value));
    }
  }
  if (hasModelEndpoint) {
    check('runtime.k8s.deploy.modelEgressEndpoint (expected an address/port object)',
      modelEndpoint !== null && typeof modelEndpoint === 'object' && !Array.isArray(modelEndpoint));
    check('runtime.k8s.deploy.modelEgressEndpoint.address (expected IPv4, excluding unspecified, loopback and link-local)',
      isIP(modelEndpoint?.address) === 4 && modelEndpoint.address !== '0.0.0.0'
      && !modelEndpoint.address.startsWith('127.') && !modelEndpoint.address.startsWith('169.254.'));
    check('runtime.k8s.deploy.modelEgressEndpoint.port', port(modelEndpoint?.port));
  }
  const resources = k8s.gatewayResources;
  check('runtime.k8s.gatewayResources (expected a cpu/memory object)',
    resources === undefined || (resources !== null && typeof resources === 'object' && !Array.isArray(resources)));
  const gatewayResources = {
    cpu: resources?.cpu === undefined ? '500m' : resources.cpu,
    memory: resources?.memory === undefined ? '512Mi' : resources.memory,
  };
  for (const [name, value] of Object.entries(gatewayResources)) {
    const quantity = typeof value === 'string'
      && value.match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+))(?:[numkMGTPE]|[KMGTPE]i|[eE][+-]?\d+)?$/);
    check(`runtime.k8s.gatewayResources.${name} (expected a positive resource quantity string)`,
      Boolean(quantity) && Number(quantity[1]) > 0);
  }
  check('runtime.k8s.deploy.gatewayImage', typeof deploy.gatewayImage === 'string' && !/\s/.test(deploy.gatewayImage));
  check('runtime.k8s.deploy.newUserStorage.provisioner',
    typeof storage.provisioner === 'string' && /^[a-z0-9][a-z0-9./-]*$/.test(storage.provisioner));
  check('runtime.k8s.deploy.newUserStorage.parameters', stringMap(storage.parameters ?? {}));
  check('runtime.k8s.deploy.egressExceptCidrs', Array.isArray(deploy.egressExceptCidrs) && deploy.egressExceptCidrs.every(cidr));
  for (const name of ['organization', 'secure', 'state', 'usersFile']) {
    check(`runtime.k8s.deploy.hostPaths.${name}`, absolutePath(paths[name]));
  }
  for (const name of ['secureDirectory', 'stateDirectory', 'usersFile']) check(`runtime.${name}`, absolutePath(runtime[name]));
  for (const name of ['gatewayPort', 'internalPort', 'nextPort']) check(`runtime.${name}`, port(runtime[name]));
  check('runtime.gatewayPort and runtime.internalPort (must differ)', runtime.gatewayPort !== runtime.internalPort);
  check('runtime.gatewayOrigin and runtime.internalOrigin (hostnames must match)', gateway.name === internal.name);
  check('runtime.gatewayOrigin (port must equal runtime.gatewayPort)', gateway.port === runtime.gatewayPort);
  check('runtime.internalOrigin (port must equal runtime.internalPort)', internal.port === runtime.internalPort);
  for (const [name, item] of [['gatewayOrigin', gateway], ['internalOrigin', internal]]) {
    check(`runtime.${name} (must be an origin)`, item.url?.pathname === '/' && !item.url.search && !item.url.hash);
  }
  check('model hostname (must differ from the gateway Service)', model.name !== gateway.name);
  if (k8s.requiredPolicies !== undefined) {
    check('runtime.k8s.requiredPolicies (must name rendered user policies)',
      Array.isArray(k8s.requiredPolicies) && k8s.requiredPolicies.every(name => policyNames.includes(name)));
  }
  check('runtime.k8s.deploy.entry.mode (hostPort or clusterIP)', ['hostPort', 'clusterIP'].includes(entry.mode));
  if (entry.mode === 'hostPort') {
    check('runtime.k8s.deploy.entry.hostIP (must be IPv4 loopback)', isIP(entry.hostIP) === 4 && entry.hostIP.startsWith('127.'));
    check('runtime.k8s.deploy.entry.hostPort', port(entry.hostPort));
  } else if (entry.mode === 'clusterIP') {
    check('runtime.k8s.deploy.entry.clusterIP', isIP(entry.clusterIP) === 4 && !/^(?:0|127)\./.test(entry.clusterIP));
    check('gateway entry Service name (gateway hostname plus -entry)', serviceName(`${gateway.name}-entry`));
    check('model hostname (must differ from the gateway entry Service)', model.name !== `${gateway.name}-entry`);
  }
  if (missing.length || invalid.length) throw new Error([
    ...(missing.length ? [`Missing required configuration: ${missing.join(', ')}`] : []),
    ...(invalid.length ? [`Invalid configuration: ${invalid.join(', ')}`] : []),
  ].join('\n'));
  const warnings = [];
  if (hasModelEndpoint) {
    const [first, second] = modelEndpoint.address.split('.').map(Number);
    if (first === 10 || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)) {
      warnings.push('modelEgressEndpoint.address is in an RFC1918 private range; ensure it is an external endpoint '
        + 'routable from every node, not a node-local or Docker bridge address. For Docker services, use a relay Pod '
        + 'with modelEgressSelector. See docs/kubernetes.md#model-egress-routing.');
    }
  }
  if (entry.mode === 'hostPort' && `${entry.hostIP}:${entry.hostPort}` !== runtime.localAddress) {
    warnings.push('hostPort entry hostIP/hostPort differs from runtime.localAddress; '
      + 'the tunnel targets runtime.localAddress. Align the organization configuration with the entry.');
  }

  const gatewayContainerPorts = [
    { name: 'gateway', containerPort: runtime.gatewayPort, protocol: 'TCP',
      ...(entry.mode === 'hostPort' ? { hostIP: entry.hostIP, hostPort: entry.hostPort } : {}) },
    { name: 'internal', containerPort: runtime.internalPort, protocol: 'TCP' },
  ];
  return {
    partOf, gatewayLabels, userLabels, warnings,
    namespace: k8s.namespace, systemNamespace, imageConfigMap, governingService,
    gatewayName: gateway.name, gatewayEntryName: `${gateway.name}-entry`,
    gatewayPriorityClass: `${systemNamespace}-gateway`, gatewayNodeSelector,
    gatewayImage: deploy.gatewayImage, gatewayPort: runtime.gatewayPort, internalPort: runtime.internalPort,
    gatewayContainerPorts, gatewayResources,
    gatewayServicePorts: gatewayContainerPorts.map(item => ({
      name: item.name, protocol: item.protocol, port: item.containerPort, targetPort: item.containerPort,
    })),
    entryMode: entry.mode, entryClusterIP: entry.clusterIP,
    organizationHostPath: paths.organization, secureHostPath: paths.secure,
    stateHostPath: paths.state, usersHostPath: paths.usersFile,
    secureDirectory: runtime.secureDirectory, stateDirectory: runtime.stateDirectory, usersFile: runtime.usersFile,
    nextPort: runtime.nextPort, modelName: model.name, modelPort: model.port,
    modelEgressSelector: deploy.modelEgressSelector,
    modelEndpoint,
    modelServiceSpec: {
      type: 'ClusterIP',
      ...(!hasModelEndpoint ? { selector: deploy.modelEgressSelector } : {}),
      ports: [{ name: 'model', protocol: 'TCP', port: model.port, targetPort: modelEndpoint?.port ?? model.port }],
    },
    modelEgressRule: {
      to: hasModelEndpoint ? [{ ipBlock: { cidr: `${modelEndpoint.address}/32` } }] : [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': systemNamespace } },
        podSelector: { matchLabels: deploy.modelEgressSelector },
      }],
      ports: [{ protocol: 'TCP', port: modelEndpoint?.port ?? model.port }],
    },
    modelEndpointAddress: modelEndpoint?.address,
    modelEndpointPort: modelEndpoint?.port,
    egressExceptCidrs: [...new Set([...privateCidrs, ...deploy.egressExceptCidrs])],
    storageClass: k8s.storageClass, storageProvisioner: storage.provisioner, storageParameters: storage.parameters ?? {},
  };
}

/** Return { objects, warnings } without writing to stdio, contacting a cluster or changing the organization. */
export function renderManifests(organization, { only } = {}) {
  const selected = only === undefined ? kinds.map(kind => kind.toLowerCase())
    : (Array.isArray(only) ? only : [only]).flatMap(value => value.split(',')).map(value => value.toLowerCase());
  if (!selected.length || selected.some(value => !kinds.some(kind => kind.toLowerCase() === value))) {
    throw new Error(`--only must contain Kubernetes kinds: ${kinds.join(', ')}`);
  }
  const values = context(organization);
  const files = [...templates, values.modelEndpoint ? 'model-endpoint' : 'model-ingress',
    ...(values.entryMode === 'clusterIP' ? ['gateway-entry'] : [])];
  const objects = files.flatMap(name => {
    const template = readFileSync(new URL(`${name}.yaml.tmpl`, templateDirectory), 'utf8');
    const rendered = template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => {
      if (values[key] === undefined) throw new Error(`Missing template value: ${key}`);
      return JSON.stringify(values[key]);
    });
    return rendered.split(/^---\s*$/m).map(document => JSON.parse(document));
  }).filter(object => selected.includes(object.kind.toLowerCase()));
  return { objects, warnings: values.warnings };
}

const help = `Usage: node tools/k8s/render.mjs [--org <directory>] [--output <directory>] [--only <Kind,...>]

Reads organization.json using the repository defaults. --org overrides WORKPARTNER_ORG_DIR.
Writes JSON-form YAML documents to stdout, or one .yaml file per object with --output.
--output must be a new or empty directory; existing files are never removed or overwritten.
If writing fails partway through, partial files remain; rerun with a new empty directory.
--only accepts Kubernetes kinds (case-insensitive), and can be repeated.
All deployment configuration is validated before output, including when using --only.

Required: runtime.kind=k8s; runtime.k8s.namespace, systemNamespace, storageClass;
runtime.k8s.deploy.gatewayImage, hostPaths.{organization,secure,state,usersFile},
egressExceptCidrs (all node public IPv4 /32 addresses; an explicit [] is allowed),
exactly one of modelEgressSelector (must include workpartner/role: model-egress and exclude gateway Pods)
or modelEgressEndpoint {address:<IPv4>,port:<1-65535>},
newUserStorage.{provisioner,parameters?}.
Storage parameters are a string map, passed through to the provisioner.
systemNamespace defaults to the mounted ServiceAccount namespace when available.
entry is {mode:"hostPort",hostIP:"127.0.0.1",hostPort:<port>} or
{mode:"clusterIP",clusterIP:<IPv4>}. ClusterIP mode adds <gateway>-entry and keeps
the gateway's same-name headless Service for preview source validation.
Gateway origins must name the same Service and match their configured ports.
Service hostnames may be short names or <name>.<systemNamespace>.svc.<clusterDomain> (default cluster.local).
The model Service uses model.baseUrl; model.nextBaseUrl must match its hostname and port if set.
modelEgressEndpoint creates a selector-less Service and an IPv4 EndpointSlice, with precise
TCP egress to address/32 at the endpoint port. Unspecified, loopback and link-local addresses are rejected.
Mounts: organization -> /organization (read-only); secure/state/usersFile -> runtime paths.
sessionKeyFile, cookieFile, identity.appSecretFile and migration.ownersFile (when migration
is configured) must be below runtime.secureDirectory or runtime.stateDirectory.
hostPort entry mismatches warn on stderr: the tunnel targets runtime.localAddress.
runtime.k8s.gatewayResources optionally sets cpu/memory (default 500m/512Mi; requests = limits).
The gateway image must include K1/K2/K3 and be imported onto its selected node first.
Only rendered objects are written; no credentials are read and no cluster is contacted.
Apply the ConfigMap only for initial registration; later use --only to exclude ConfigMap
when reapplying deployment objects, preserving the live image registry.
Kinds: ${kinds.join(', ')}
`;

/** Preflight all output names and preserve any existing directory contents. */
export function writeManifests(objects, output) {
  const files = objects.map(object => ({
    name: [object.kind.toLowerCase(), object.metadata.namespace, object.metadata.name].filter(Boolean).join('_') + '.yaml',
    contents: JSON.stringify(object, null, 2) + '\n',
  }));
  const names = new Set();
  for (const { name } of files) {
    if (names.has(name)) throw new Error(`Duplicate output filename: ${name}`);
    names.add(name);
  }
  try {
    if (readdirSync(output).length) throw new Error('--output directory is not empty; choose an empty directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(output, { recursive: true });
  for (const { name, contents } of files) writeFileSync(resolve(output, name), contents, { flag: 'wx' });
}

function main(args) {
  let directory = process.env.WORKPARTNER_ORG_DIR;
  let output;
  const only = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') { process.stdout.write(help); return; }
    if (!['--org', '--output', '--only'].includes(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Expected --org <directory>, --output <directory>, --only <Kind,...>, or --help');
    }
    const value = args[++index];
    if (argument === '--org') directory = value;
    else if (argument === '--output') output = value;
    else only.push(value);
  }
  let organization;
  try { organization = organizationData(directory ? { WORKPARTNER_ORG_DIR: directory } : {}); }
  catch { throw new Error('Cannot read organization.json; expected a valid organization configuration'); }
  const { objects, warnings } = renderManifests(organization, only.length ? { only } : {});
  for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
  if (output) writeManifests(objects, output);
  else process.stdout.write(objects.map(object => JSON.stringify(object, null, 2)).join('\n---\n') + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
