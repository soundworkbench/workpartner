import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { probe } from './probe.mjs';

export { assert, delay };
export async function until(fn, timeout = 120000, interval = 200) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(interval);
  } while (Date.now() < deadline);
  throw new Error('Condition timed out', { cause: last });
}
export function labelObject(object, prefix) {
  const body = structuredClone(object);
  body.metadata = { ...body.metadata, labels: { ...body.metadata?.labels, 'workpartner-e2e': prefix } };
  if (body.spec?.template) body.spec.template.metadata = { ...body.spec.template.metadata,
    labels: { ...body.spec.template.metadata?.labels, 'workpartner-e2e': prefix } };
  return body;
}
export async function context(config) {
  const { createRuntime } = await import('../../../gateway/runtime/index.mjs');
  const { createKubeClient } = await import('../../../gateway/runtime/kube-client.mjs');
  const raw = createKubeClient({ inCluster: true });
  const client = { ...raw,
    create: (route, body) => raw.create(route, labelObject(body, config.prefix)),
    patch: (route, body, type) => raw.patch(route, type === 'json' ? body : labelObject(body, config.prefix), type),
  };
  const org = config.organization;
  const runtime = createRuntime(org, { client });
  const ns = org.runtime.k8s.namespace, sys = org.runtime.k8s.systemNamespace;
  const name = slug => `${org.runtime.nextContainerPrefix}${slug}`;
  const core = `/api/v1/namespaces/${ns}`;
  const pod = slug => client.get(`${core}/pods/${name(slug)}-0`);
  const pods = async slug => (await client.get(`${core}/pods?labelSelector=${encodeURIComponent(`${org.runtime.nextUserLabel}=${slug}`)}`)).items;
  const makeRuntime = overrides => createRuntime(org, { client, ...overrides });
  async function create(slug, rt = runtime) {
    await fs.mkdir(org.runtime.secureDirectory, { recursive: true });
    await fs.writeFile(`${org.runtime.secureDirectory}/${org.model.keyPrefix}${slug}.key`, randomBytes(24), { mode: 0o600 });
    await rt.create({ slug, name: slug, backend: 'aionui' }, { modelConfig: JSON.stringify({ gatewayOrigin: org.runtime.gatewayOrigin }) });
    await rt.putFiles(slug, [{ path: '.zp-preview-relay-key', content: randomBytes(32).toString('hex') }]);
  }
  async function ready(slug, rt = runtime) {
    await rt.start(slug);
    await until(async () => {
      const address = await rt.address(slug);
      return address && (await probe({ ...address, kind: 'http', path: '/api/auth/status' })).status === 200;
    });
  }
  const source = await fs.readFile(new URL('./probe.mjs', import.meta.url), 'utf8');
  // Avoid depending on files in the user image; stdin only contains probe arguments.
  const script = source.slice(0, source.indexOf('// The same source')) + '\nconsole.log(JSON.stringify(await probe(JSON.parse(readFileSync(0,"utf8")))));';
  async function from(slug, spec) {
    const result = await runtime.exec(slug, ['node', '--input-type=module', '-e', script], { stdin: JSON.stringify(spec), timeout: 6000 });
    assert.equal(result.exitCode, 0, 'Probe process must complete');
    return JSON.parse(result.stdout);
  }
  async function fromProbe(spec) {
    const result = await client.exec(config.probeNamespace, config.probeName, 'probe', ['node', '--input-type=module', '-e', script], { stdin: JSON.stringify(spec), timeoutMs: 6000 });
    assert.equal(result.exitCode, 0, 'Probe process must complete');
    return JSON.parse(result.stdout);
  }
  return { config, org, client, runtime, makeRuntime, create, ready, ns, sys, core, name, pod, pods, from, fromProbe, probe, probeScript: script };
}
