#!/usr/bin/env node
/** Compare an offline rendered Deployment with a live Deployment JSON snapshot. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { organizationData } from '../../gateway/organization/resolve.mjs';
import { renderManifests } from './render.mjs';

const ABSENT = Symbol('absent');
const serverDefaults = Object.freeze({
  deployment: new Map([
    ['progressDeadlineSeconds', 600],
    ['revisionHistoryLimit', 10],
  ]),
  pod: new Map([
    ['dnsPolicy', 'ClusterFirst'],
    ['restartPolicy', 'Always'],
    ['schedulerName', 'default-scheduler'],
    ['serviceAccount', (value, pod) => value === pod.serviceAccountName
      || (value === 'default' && pod.serviceAccountName === 'default')],
    ['terminationGracePeriodSeconds', 30],
  ]),
  container: new Map([
    ['terminationMessagePath', '/dev/termination-log'],
    ['terminationMessagePolicy', 'File'],
  ]),
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sortNamed(items) {
  return Array.isArray(items) && items.every(item => item && typeof item === 'object' && typeof item.name === 'string')
    ? [...items].sort((a, b) => a.name.localeCompare(b.name)) : items;
}

function normalizeProbe(probe) {
  if (!probe || typeof probe !== 'object') return probe;
  const out = { ...probe };
  for (const [key, value] of [['failureThreshold', 3], ['successThreshold', 1], ['timeoutSeconds', 1]]) {
    if (out[key] === value) delete out[key];
  }
  return out;
}

function removeServerDefaults(target, defaults) {
  for (const [key, defaultValue] of defaults) {
    const isDefault = typeof defaultValue === 'function'
      ? defaultValue(target[key], target)
      : target[key] === defaultValue;
    if (isDefault) delete target[key];
  }
}

function expandEnvironment(container, secretKeys) {
  const explicit = Array.isArray(container.env) ? container.env.map(clone) : [];
  const names = new Set(explicit.map(entry => entry?.name));
  const remaining = [];
  for (const source of Array.isArray(container.envFrom) ? container.envFrom : []) {
    const secret = source?.secretRef;
    const keys = secret && secretKeys?.[secret.name];
    if (!Array.isArray(keys)) {
      remaining.push(clone(source));
      continue;
    }
    for (const key of keys) {
      if (names.has(key)) continue;
      names.add(key);
      explicit.push({ name: key, valueFrom: { secretKeyRef: { name: secret.name, key } } });
    }
  }
  container.env = sortNamed(explicit);
  if (remaining.length) container.envFrom = remaining;
  else delete container.envFrom;
}

/** Normalize the fields that Kubernetes adds or that are intentionally ignored by this comparison. */
export function normalizeDeployment(deployment, { compareImage = false, secretKeys } = {}) {
  const out = clone(deployment);
  if (!out || typeof out !== 'object') throw new Error('Deployment JSON must be an object');
  delete out.status;
  if (out.metadata && typeof out.metadata === 'object') {
    out.metadata = Object.fromEntries(['name', 'namespace', 'labels']
      .filter(key => out.metadata[key] !== undefined).map(key => [key, clone(out.metadata[key])]));
  }
  if (out.spec && typeof out.spec === 'object') {
    removeServerDefaults(out.spec, serverDefaults.deployment);
  }
  const pod = out.spec?.template?.spec;
  if (pod && typeof pod === 'object') {
    removeServerDefaults(pod, serverDefaults.pod);
    if (pod.securityContext && Object.keys(pod.securityContext).length === 0) delete pod.securityContext;
    pod.containers = sortNamed(pod.containers);
    pod.initContainers = sortNamed(pod.initContainers);
    pod.volumes = sortNamed(pod.volumes);
    for (const container of pod.containers || []) {
      removeServerDefaults(container, serverDefaults.container);
      if (!compareImage) delete container.image;
      container.env = sortNamed(container.env);
      container.envFrom = sortNamed(container.envFrom);
      container.volumeMounts = sortNamed(container.volumeMounts);
      if (container.readinessProbe) container.readinessProbe = normalizeProbe(container.readinessProbe);
      if (container.livenessProbe) container.livenessProbe = normalizeProbe(container.livenessProbe);
      expandEnvironment(container, secretKeys);
    }
  }
  const templateAnnotations = out.spec?.template?.metadata?.annotations;
  if (templateAnnotations && typeof templateAnnotations === 'object') {
    delete templateAnnotations['kubectl.kubernetes.io/restartedAt'];
    if (!Object.keys(templateAnnotations).length) delete out.spec.template.metadata.annotations;
  }
  return out;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function walk(live, rendered, path, differences) {
  if (same(live, rendered)) return;
  if (live === ABSENT || rendered === ABSENT || live === null || rendered === null
    || typeof live !== 'object' || typeof rendered !== 'object'
    || Array.isArray(live) !== Array.isArray(rendered)) {
    differences.push({ path, live: live === ABSENT ? null : live, rendered: rendered === ABSENT ? null : rendered });
    return;
  }
  if (Array.isArray(live)) {
    const length = Math.max(live.length, rendered.length);
    for (let index = 0; index < length; index++) {
      walk(index < live.length ? live[index] : ABSENT, index < rendered.length ? rendered[index] : ABSENT,
        `${path}[${index}]`, differences);
    }
    return;
  }
  const keys = new Set([...Object.keys(live), ...Object.keys(rendered)]);
  for (const key of [...keys].sort()) {
    walk(Object.hasOwn(live, key) ? live[key] : ABSENT, Object.hasOwn(rendered, key) ? rendered[key] : ABSENT,
      path ? `${path}.${key}` : key, differences);
  }
}

export function diffDeployments(live, rendered, options = {}) {
  const normalizedLive = normalizeDeployment(live, options);
  const normalizedRendered = normalizeDeployment(rendered, options);
  const differences = [];
  walk(normalizedLive, normalizedRendered, '', differences);
  return differences;
}

function parseJson(text, name) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Invalid ${name} JSON: ${error.message}`); }
}

function readJsonFile(file, name) {
  try { return parseJson(readFileSync(file, 'utf8'), name); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Cannot read ${name}: ${file}`);
    throw error;
  }
}

function usage() {
  return 'Usage: node tools/k8s/live-diff.mjs --org <directory> --live <deployment.json|-> [--secret-keys <json>] [--compare-image] [--json]';
}

export function run(args, { stdin = process.stdin } = {}) {
  let orgDirectory;
  let liveFile;
  let secretFile;
  let compareImage = false;
  let jsonOutput = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: usage() };
    if (argument === '--compare-image') { compareImage = true; continue; }
    if (argument === '--json') { jsonOutput = true; continue; }
    if (!['--org', '--live', '--secret-keys'].includes(argument)
      || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(usage());
    const value = args[++index];
    if (argument === '--org') orgDirectory = value;
    else if (argument === '--live') liveFile = value;
    else secretFile = value;
  }
  if (!orgDirectory || !liveFile) throw new Error(usage());
  const live = liveFile === '-'
    ? parseJson(readFileSync(0, 'utf8'), 'live Deployment')
    : readJsonFile(liveFile, 'live Deployment');
  if (!live || live.kind !== 'Deployment' || !live.metadata?.name || !live.metadata?.namespace) {
    throw new Error('Live JSON must be a Deployment with metadata.name and metadata.namespace');
  }
  const secretKeys = secretFile === undefined ? undefined : readJsonFile(secretFile, 'secret keys');
  if (secretKeys !== undefined && (!secretKeys || typeof secretKeys !== 'object' || Array.isArray(secretKeys)
    || Object.values(secretKeys).some(keys => !Array.isArray(keys) || keys.some(key => typeof key !== 'string')))) {
    throw new Error('Secret keys JSON must map Secret names to arrays of key names');
  }
  let organization;
  try { organization = organizationData({ WORKPARTNER_ORG_DIR: orgDirectory }); }
  catch (error) { throw new Error(`Cannot read organization.json: ${error.message}`); }
  let rendered;
  try {
    rendered = renderManifests(organization, { only: 'Deployment' }).objects
      .find(object => object.metadata?.name === live.metadata.name && object.metadata?.namespace === live.metadata.namespace);
  } catch (error) { throw new Error(`Cannot render Deployment: ${error.message}`); }
  if (!rendered) throw new Error(`Rendered Deployment ${live.metadata.namespace}/${live.metadata.name} was not found`);
  const differences = diffDeployments(live, rendered, { compareImage, secretKeys });
  return { differences, jsonOutput };
}

function print(result) {
  if (result.help) { process.stdout.write(`${result.help}\n`); return; }
  if (result.jsonOutput) { process.stdout.write(`${JSON.stringify(result.differences)}\n`); return; }
  for (const difference of result.differences) {
    const format = value => value === null ? '<absent>' : JSON.stringify(value);
    process.stdout.write(`${difference.path}: live=${format(difference.live)} rendered=${format(difference.rendered)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = run(process.argv.slice(2));
    print(result);
    if (!result.help) process.exitCode = result.differences.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
