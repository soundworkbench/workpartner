import fs from 'node:fs';
import path from 'node:path';
import { defaultPublishedFiles } from './published-files.mjs';

const partOf = { 'app.kubernetes.io/part-of': 'workpartner' };
const dnsLabel = value => typeof value === 'string' && value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);
function labelKey(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/'), name = parts.pop();
  return parts.length <= 1 && name.length <= 63 && /^[A-Za-z0-9](?:[-_.A-Za-z0-9]*[A-Za-z0-9])?$/.test(name)
    && (!parts.length || (parts[0].length <= 253 && parts[0].split('.').every(dnsLabel)));
}
const running = pod => !!(pod && !pod.metadata?.deletionTimestamp && pod.status?.phase === 'Running'
  && pod.status.podIP && pod.status.containerStatuses?.some(c => c.name === 'workspace' && c.state?.running));
const copy = value => structuredClone(value);
// Bound reset/maintenance output to 1 MiB per one-off Pod.
const jobLogLimitBytes = 1024 * 1024;

/** Dependencies are loaded on first use so Docker deployments do not need the Kubernetes modules.
 * createK8sExec(context) returns exec, execNamed (in systemNamespace), and processes.
 * createK8sFiles({...context, exec}) returns putFiles, readFile, and removeFiles.
 * Context includes client, namespace, systemNamespace, names(slug), uid, container and systemContainer.
 * K2b accepts systemContainer as a string; execNamed resolves its Pod-name default before assembly.
 * Tests can inject client, createK8sExec and createK8sFiles without loading those modules.
 */
export function createK8sRuntime(o = {}) {
  const namespace = o.namespace;
  if (!dnsLabel(namespace)) throw new Error('runtime.k8s.namespace is required and must be a DNS label');
  if (!o.storageClass) throw new Error('runtime.k8s.storageClass is required');
  if (o.systemContainer != null && !dnsLabel(o.systemContainer)) throw new Error('Invalid runtime.k8s.systemContainer');
  const userLabel = o.userLabel ?? 'workpartner.next-user';
  if (!labelKey(userLabel) || userLabel === 'workpartner/role' || userLabel === 'app.kubernetes.io/part-of') {
    throw new Error('Invalid runtime.nextUserLabel');
  }
  const uid = o.uid ?? 1001, port = o.port ?? 25808;
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('runtime.uid must be a non-root integer');
  const publishedDirectory = o.publishedDirectory ?? '/run/workpartner/published';
  const publishedFiles = o.publishedFiles ?? defaultPublishedFiles;
  const timeoutMs = o.podStartTimeoutMs ?? 120000;
  const gracePeriodSeconds = o.terminationGraceSeconds ?? 10;
  const cacheMs = o.inspectCacheMs ?? 2000;
  if (!Number.isFinite(cacheMs) || cacheMs < 0) throw new Error('Invalid runtime.k8s.inspectCacheMs');
  const core = `/api/v1/namespaces/${namespace}`;
  const apps = `/apis/apps/v1/namespaces/${namespace}/statefulsets`;
  const names = slug => {
    if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(slug)) throw new Error('Invalid workspace slug');
    const container = `${o.containerPrefix ?? 'workpartner-next-'}${slug}`;
    // Reserve 11 characters for the controller-revision-hash label suffix (and Secret/PVC suffixes).
    if (!dnsLabel(container) || container.length > 52) throw new Error('Invalid runtime container name');
    return { container, pod: `${container}-0`, data: `${container}-data`, oldwork: `${container}-oldwork`,
      modelKey: `${container}-model-key`, published: `${container}-published` };
  };
  const labels = (slug, role = 'user') => ({ ...partOf, 'workpartner/role': role, [userLabel]: slug });
  let clientPromise;
  const client = () => clientPromise ??= Promise.resolve(o.client ?? import('./kube-client.mjs').then(({ createKubeClient }) =>
    createKubeClient({ ...(o.kubeconfigJson !== undefined ? { kubeconfigJson: o.kubeconfigJson } : { inCluster: o.inCluster ?? true }),
      timeoutMs: o.apiTimeoutMs ?? 10000 })));
  const systemNamespace = c => {
    const value = o.systemNamespace ?? c.namespace;
    if (!dnsLabel(value)) throw new Error('runtime.k8s.systemNamespace is required outside a ServiceAccount');
    return value;
  };
  const caches = new Map(), generations = new Map(), locks = new Map();
  let images, imageGeneration = 0;
  function invalidate(slug) {
    caches.delete(slug);
    generations.set(slug, (generations.get(slug) ?? 0) + 1);
    images = undefined;
    imageGeneration++;
  }
  function exclusive(slug, operation) {
    names(slug);
    const previous = locks.get(slug) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(async () => {
      invalidate(slug);
      try { return await operation(await client()); } finally { invalidate(slug); }
    });
    locks.set(slug, result);
    const release = () => { if (locks.get(slug) === result) locks.delete(slug); };
    result.then(release, release);
    return result;
  }
  const wait = (c, fn, limit = timeoutMs) => c.waitFor(fn, { timeoutMs: limit, intervalMs: 200 });
  async function userPods(c, slug) {
    const list = await c.get(`${core}/pods?labelSelector=${encodeURIComponent(`${userLabel}=${slug}`)}`);
    const pods = list?.items ?? [];
    const main = await c.get(`${core}/pods/${names(slug).pod}`);
    if (main && !pods.some(p => p.metadata.name === main.metadata.name)) pods.push(main);
    return pods;
  }
  async function gone(c, slug, route) {
    let pods = [], statefulSet;
    try {
      await wait(c, async () => {
        pods = await userPods(c, slug);
        statefulSet = route ? await c.get(route) : null;
        return !statefulSet && !pods.length;
      });
    } catch (error) {
      if (error.reason !== 'Timeout') throw error;
      throw new Error(`Timed out waiting for runtime deletion; Pods: ${pods.map(p => p.metadata.name).join(', ') || 'none'}`
        + (statefulSet ? `; StatefulSet: ${names(slug).container}` : ''), { cause: error });
    }
  }
  async function ensureIsolation(slug) {
    names(slug);
    const c = await client();
    for (const name of o.requiredPolicies ?? ['workpartner-default-deny', 'workpartner-user-egress', 'workpartner-user-ingress']) {
      if (!await c.get(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/${encodeURIComponent(name)}`)) {
        throw new Error(`Required NetworkPolicy is missing: ${name}`);
      }
    }
  }
  async function imageId(ref) {
    if (!images || images.expires <= Date.now()) {
      const generation = imageGeneration;
      const c = await client();
      const map = await c.get(`/api/v1/namespaces/${systemNamespace(c)}/configmaps/${encodeURIComponent(o.imageConfigMap ?? 'workpartner-images')}`);
      let values;
      try { values = JSON.parse(map?.data?.['images.json'] ?? '{}'); }
      catch { throw new Error('Invalid image registry ConfigMap'); }
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid image registry ConfigMap');
      if (generation === imageGeneration) images = { values, expires: Date.now() + 10000 };
      return Object.hasOwn(values, ref) && typeof values[ref] === 'string' ? values[ref] || null : null;
    }
    return Object.hasOwn(images.values, ref) && typeof images.values[ref] === 'string' ? images.values[ref] || null : null;
  }
  async function registered(ref) {
    const id = await imageId(ref);
    if (!id) throw new Error('Runtime image is not registered');
    return id;
  }
  async function ensure(c, collection, object, update) {
    const route = `${collection}/${object.metadata.name}`;
    let existing = await c.get(route);
    if (!existing) {
      try { return await c.create(collection, object); }
      catch (error) { if (error.reason !== 'AlreadyExists') throw error; }
      existing = await c.get(route);
      if (!existing) throw new Error('Runtime object disappeared during creation');
    }
    return update ? c.patch(route, update(existing), 'merge') : existing;
  }
  const securityContext = { runAsUser: uid, runAsGroup: uid, runAsNonRoot: true,
    allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };
  function podSpec(image, n, pvc, system, oldwork, job = false) {
    const mounts = [{ name: 'data', mountPath: '/data' }];
    const volumes = [{ name: 'data', persistentVolumeClaim: { claimName: n.data } }];
    if (!job) {
      mounts.push({ name: 'model-key', mountPath: o.modelKeyFile ?? '/etc/partner/model.key', subPath: 'model.key', readOnly: true },
        { name: 'published', mountPath: publishedDirectory, readOnly: true });
      volumes.push({ name: 'model-key', secret: { secretName: n.modelKey, defaultMode: 0o444 } },
        { name: 'published', secret: { secretName: n.published, defaultMode: 0o444 } });
      if (o.sharedSkills) {
        mounts.push({ name: 'shared-skills', mountPath: o.sharedSkills.container, readOnly: true });
        volumes.push({ name: 'shared-skills', persistentVolumeClaim: { claimName: o.sharedSkills.claim, readOnly: true } });
      }
      if (oldwork) {
        mounts.push({ name: 'oldwork', mountPath: '/data/old-work', readOnly: true });
        volumes.push({ name: 'oldwork', persistentVolumeClaim: { claimName: n.oldwork, readOnly: true } });
      }
    }
    return {
      automountServiceAccountToken: false, enableServiceLinks: false,
      terminationGracePeriodSeconds: gracePeriodSeconds, restartPolicy: job ? 'Never' : 'Always',
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      dnsConfig: { searches: [`${system}.svc.${o.clusterDomain ?? 'cluster.local'}`],
        ...(o.dnsNdots !== undefined ? { options: [{ name: 'ndots', value: String(o.dnsNdots) }] } : {}) },
      ...(pvc?.status?.phase !== 'Bound' && !pvc?.spec?.volumeName ? { nodeSelector: o.newUserNodeSelector ?? {} } : {}),
      ...(o.userPriorityClass ? { priorityClassName: o.userPriorityClass } : {}),
      initContainers: [{ name: 'fix-owner', image, imagePullPolicy: 'Never', command: ['chown', `${uid}:${uid}`, '/data'],
        securityContext: { runAsUser: 0, runAsGroup: 0, runAsNonRoot: false, allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'], add: ['CHOWN'] }, seccompProfile: { type: 'RuntimeDefault' } },
        volumeMounts: [{ name: 'data', mountPath: '/data' }] }],
      containers: [{ name: 'workspace', image, imagePullPolicy: 'Never', securityContext: copy(securityContext),
        resources: { requests: { memory: o.memoryRequest ?? '512Mi', cpu: o.cpuRequest ?? '100m' },
          limits: { memory: String(o.memory ?? 3221225472), cpu: String((o.nanoCpus ?? 2000000000) / 1e9) } }, volumeMounts: mounts }], volumes,
    };
  }
  function create(user, { modelConfig } = {}) {
    const quickModel = modelConfig && JSON.parse(modelConfig).quickLineModel;
    return exclusive(user.slug, async c => {
      const slug = user.slug, n = names(slug);
      let key;
      try { key = fs.readFileSync(path.join(o.secureDir, `${o.keyPrefix ?? 'model-'}${slug}.key`)); }
      catch (error) { if (error.code === 'ENOENT') throw new Error(`没有 ${slug} 的模型钥匙`); throw new Error('Cannot read model key file'); }
      const image = o.userImages?.[slug] ?? o.image;
      const id = await registered(image);
      await ensureIsolation(slug);
      const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: n.modelKey, labels: labels(slug) }, type: 'Opaque',
        data: { 'model.key': key.toString('base64') } };
      await ensure(c, `${core}/secrets`, secret, () => ({ metadata: { labels: labels(slug) }, data: secret.data }));
      await ensure(c, `${core}/secrets`, { apiVersion: 'v1', kind: 'Secret', metadata: { name: n.published, labels: labels(slug) }, type: 'Opaque', data: {} });
      const pvc = await ensure(c, `${core}/persistentvolumeclaims`, { apiVersion: 'v1', kind: 'PersistentVolumeClaim',
        metadata: { name: n.data, labels: labels(slug) }, spec: { accessModes: ['ReadWriteOnce'], storageClassName: o.storageClass,
          resources: { requests: { storage: o.dataVolumeSize ?? '20Gi' } } } });
      const oldwork = await c.get(`${core}/persistentvolumeclaims/${n.oldwork}`);
      const spec = podSpec(image, n, pvc, systemNamespace(c), oldwork);
      const overrides = o.userResources?.[slug] ?? {};
      for (const resource of ['memory', 'cpu']) for (const kind of ['limits', 'requests']) {
        const value = overrides[kind === 'limits' ? resource : `${resource}Request`];
        if ((typeof value === 'string' && value.length) || Number.isFinite(value)) {
          spec.containers[0].resources[kind][resource] = String(value);
        }
      }
      spec.containers[0].env = [
        { name: o.modelBaseEnvironment ?? 'MODEL_BASE_URL', value: String(o.modelBaseUrl) },
        { name: 'PARTNER_USER_NAME', value: user.name || '' },
        ...(o.sharedSkills ? [
          { name: 'WORKPARTNER_SHARED_SKILLS', value: o.sharedSkills.container },
          { name: 'WORKPARTNER_MARKET_PREINSTALLED', value: JSON.stringify(o.sharedSkills.preinstalled) },
        ] : []),
        ...(modelConfig ? [{ name: 'WORKPARTNER_MODEL_CONFIG', value: modelConfig }] : []),
        ...(quickModel ? [{ name: 'QUICK_LINE_MODEL', value: quickModel }] : []),
        { name: 'WORKPARTNER_PUBLISHED_DIR', value: publishedDirectory },
      ];
      const object = { apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: n.container, labels: labels(slug),
        annotations: { 'workpartner/image-id': id } }, spec: { replicas: 0, serviceName: o.governingService ?? 'workpartner-users',
        updateStrategy: { type: 'OnDelete' }, selector: { matchLabels: labels(slug) },
        template: { metadata: { labels: labels(slug) }, spec } } };
      await ensure(c, apps, object, existing => {
        const selector = existing.spec.selector?.matchLabels ?? {}, expected = labels(slug);
        if (![0, 1].includes(existing.spec.replicas) || Object.keys(selector).length !== Object.keys(expected).length
          || Object.entries(expected).some(([key, value]) => selector[key] !== value)
          || existing.spec.serviceName !== object.spec.serviceName) throw new Error('Incompatible runtime StatefulSet');
        return { metadata: object.metadata, spec: { ...object.spec, replicas: existing.spec.replicas,
          template: { ...object.spec.template, spec: { ...spec,
            nodeSelector: Object.keys(spec.nodeSelector ?? {}).length ? {
              ...Object.fromEntries(Object.keys(existing.spec.template.spec.nodeSelector ?? {}).map(key => [key, null])),
              ...spec.nodeSelector,
            } : null,
            priorityClassName: spec.priorityClassName ?? null,
          } } } };
      });
    });
  }
  const rekey = slug => exclusive(slug, async c => {
    const route = `${core}/secrets/${names(slug).modelKey}`;
    let key;
    try { key = fs.readFileSync(path.join(o.secureDir, `${o.keyPrefix ?? 'model-'}${slug}.key`)); }
    catch { throw new Error('Cannot read model key file'); }
    if (await c.get(route)) {
      try { await c.patch(route, { data: { 'model.key': key.toString('base64') } }, 'merge'); }
      catch (error) { if (error.status !== 404) throw error; }
    }
  });
  async function inspect(slug) {
    const n = names(slug), cached = caches.get(slug);
    if (cached && cached.expires > Date.now()) return copy(cached.value);
    const generation = generations.get(slug), c = await client();
    const sts = await c.get(`${apps}/${n.container}`);
    let value = { exists: false, running: false, image: null, imageId: null, address: null, replicas: null, annotations: {} };
    if (sts) {
      const pod = await c.get(`${core}/pods/${n.pod}`), container = sts.spec.template.spec.containers.find(c => c.name === 'workspace');
      value = { exists: true, running: running(pod), image: container?.image, imageId: sts.metadata.annotations?.['workpartner/image-id'] ?? null,
        env: (container?.env ?? []).map(e => `${e.name}=${e.value ?? ''}`), name: n.container,
        address: running(pod) ? { host: pod.status.podIP, port } : null,
        replicas: sts.spec.replicas ?? null, paused: Object.hasOwn(sts.metadata.annotations ?? {}, 'workpartner/paused'),
        annotations: sts.metadata.annotations ?? {} };
    }
    if (generation === generations.get(slug)) caches.set(slug, { value: copy(value), expires: Date.now() + cacheMs });
    return value;
  }
  async function waitRunning(c, slug, oldUid) {
    let pod;
    try {
      await wait(c, async () => {
        pod = await c.get(`${core}/pods/${names(slug).pod}`);
        return running(pod) && (oldUid === undefined || (pod.metadata.uid && pod.metadata.uid !== oldUid));
      });
    } catch (error) {
      if (error.reason !== 'Timeout') throw error;
      const reasons = [pod?.status?.reason, ...(pod?.status?.conditions ?? []).filter(c => c.status !== 'True').map(c => c.reason),
        ...[...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])].map(c => c.state?.waiting?.reason ?? c.state?.terminated?.reason)].filter(Boolean);
      throw new Error(`Runtime Pod did not start: ${reasons.join(', ') || pod?.status?.phase || 'MissingPod'}`, { cause: error });
    }
  }
  const start = slug => exclusive(slug, async c => {
    const n = names(slug);
    await ensureIsolation(slug);
    const sts = await c.get(`${apps}/${n.container}`);
    if (!sts || sts.metadata.deletionTimestamp) throw new Error('Runtime StatefulSet is unavailable');
    if ((await userPods(c, slug)).some(p => p.metadata.name !== n.pod)) throw new Error('User already has another Pod');
    await c.patch(`${apps}/${n.container}`, { spec: { replicas: 1 } }, 'merge');
    await waitRunning(c, slug);
  });
  const stop = slug => exclusive(slug, async c => {
    const route = `${apps}/${names(slug).container}`;
    if (await c.get(route)) {
      try { await c.patch(route, { spec: { replicas: 0 } }, 'merge'); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    await gone(c, slug);
  });
  const restart = slug => exclusive(slug, async c => {
    const n = names(slug);
    await ensureIsolation(slug);
    const sts = await c.get(`${apps}/${n.container}`);
    if (!sts || sts.metadata.deletionTimestamp) throw new Error('Runtime StatefulSet is unavailable');
    const pods = await userPods(c, slug);
    if (pods.some(p => p.metadata.name !== n.pod)) throw new Error('User already has another Pod');
    const old = pods.find(p => p.metadata.name === n.pod);
    if (old) await c.remove(`${core}/pods/${n.pod}`, { gracePeriodSeconds });
    await c.patch(`${apps}/${n.container}`, { spec: { replicas: 1 } }, 'merge');
    await waitRunning(c, slug, old?.metadata.uid);
  });
  const remove = slug => exclusive(slug, async c => {
    const route = `${apps}/${names(slug).container}`;
    await c.remove(route, { propagationPolicy: 'Foreground', gracePeriodSeconds });
    await gone(c, slug, route);
  });
  const runOnce = (slug, spec = {}) => exclusive(slug, async c => {
    const n = names(slug), name = `${n.container}-${spec.name ?? 'resetpass'}`;
    if (!dnsLabel(name)) throw new Error('Invalid runtime job name');
    const sts = await c.get(`${apps}/${n.container}`);
    if ((sts && sts.spec.replicas !== 0) || (await userPods(c, slug)).length) throw new Error('User still has a Pod or an active StatefulSet');
    const image = spec.image ?? o.image;
    await registered(image);
    await ensureIsolation(slug);
    const pvc = await c.get(`${core}/persistentvolumeclaims/${n.data}`);
    if (!pvc) throw new Error('Runtime data PVC is missing');
    const job = podSpec(image, n, pvc, systemNamespace(c), false, true);
    if (spec.entrypoint !== undefined) job.containers[0].command = spec.entrypoint;
    if (spec.cmd !== undefined) job.containers[0].args = spec.cmd;
    const route = `${core}/pods/${name}`;
    let cleanup = true;
    try {
      try { await c.create(`${core}/pods`, { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels: labels(slug, 'job') }, spec: job }); }
      catch (error) { if (error.reason === 'AlreadyExists') cleanup = false; throw error; }
      let pod;
      await wait(c, async () => {
        pod = await c.get(route);
        return ['Succeeded', 'Failed'].includes(pod?.status?.phase);
      }, spec.timeoutMs ?? 60000);
      const logs = await c.logs(namespace, name, 'workspace', { limitBytes: jobLogLimitBytes });
      return { exitCode: pod.status.containerStatuses?.find(c => c.name === 'workspace')?.state?.terminated?.exitCode ?? null, logs };
    } finally {
      if (cleanup) {
        await c.remove(route, { gracePeriodSeconds });
        await wait(c, async () => !await c.get(route));
      }
    }
  });
  const execPromises = new Map();
  let filesPromise;
  async function context(systemContainer = o.systemContainer) {
    const c = await client();
    return { ...o, client: c, namespace, systemNamespace: systemNamespace(c), systemContainer, names, uid, container: 'workspace',
      containerPrefix: o.containerPrefix ?? 'workpartner-next-', userLabel, publishedDirectory, publishedFiles };
  }
  const execMethods = (systemContainer = o.systemContainer) => {
    if (!execPromises.has(systemContainer)) execPromises.set(systemContainer, (async () => {
      const factory = o.createK8sExec ?? (await import('./k8s-exec.mjs')).createK8sExec;
      return factory(await context(systemContainer));
    })());
    return execPromises.get(systemContainer);
  };
  const exec = async (slug, ...args) => { names(slug); return (await execMethods()).exec(slug, ...args); };
  const files = () => filesPromise ??= (async () => {
    const factory = o.createK8sFiles ?? (await import('./k8s-files.mjs')).createK8sFiles;
    return factory({ ...await context(), exec });
  })();
  return { inspect, ensureIsolation, create, start, stop, restart, rekey, remove, runOnce, imageId, exec,
    execNamed: async (name, ...args) => {
      if (!dnsLabel(name)) throw new Error('Invalid runtime Pod name');
      return (await execMethods(o.systemContainer ?? name)).execNamed(name, ...args);
    },
    processes: async (slug, ...args) => { names(slug); return (await execMethods()).processes(slug, ...args); },
    putFiles: async (slug, ...args) => { names(slug); return (await files()).putFiles(slug, ...args); },
    readFile: async (slug, ...args) => { names(slug); return (await files()).readFile(slug, ...args); },
    removeFiles: async (slug, ...args) => { names(slug); return (await files()).removeFiles(slug, ...args); },
    address: async (slug, requestedPort, existing) => {
      names(slug);
      const address = existing === undefined ? (await inspect(slug)).address
        : existing?.address || (existing?.ip ? { host: existing.ip } : null);
      return address && { ...address, port: requestedPort ?? address.port ?? existing?.port ?? port };
    },
  };
}
