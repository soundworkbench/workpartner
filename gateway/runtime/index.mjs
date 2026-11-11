import os from 'node:os';
import { createRequire } from 'node:module';
import { createK8sRuntime } from './k8s.mjs';

// Keep the runtime factory synchronous while loading Docker only when selected (Node 24 require(ESM)).
const require = createRequire(import.meta.url);

/** Select the configured runtime at startup; omitted kind preserves Docker deployments.
 * Runtime methods are asynchronous; inspect returns normalized state and address returns {host, port} or null.
 * Kubernetes inspect also includes StatefulSet replicas (null when absent) and annotations ({} when absent).
 * create(user, {modelConfig}) uses the configured image and limits; exec/execNamed return {exitCode, stdout, stderr, logs}.
 * logs preserves stdout/stderr frame order; createTimeout and timeout control exec creation and start separately.
 * Incomplete output frames are ignored unless strictOutput is true or maxOutputBytes is supplied.
 * Detached exec returns a null exitCode. runOnce accepts {name, image, entrypoint, cmd, timeoutMs}.
 * File paths are relative to the personal data root; putFiles accepts [{path, content, mode}].
 * Its optional cleanup paths return an opaque lease to pass to removeFiles(slug, paths, lease) after use.
 * This retains staging ownership and cleanup across a worker's filesystem changes.
 */
export function createRuntime(organization, overrides = {}) {
  const { runtime: r, model = {} } = organization;
  const kind = r.kind === undefined ? 'docker' : r.kind;
  const sharedSkills = organization.features?.marketSkills ? {
    ...(kind === 'k8s' ? { claim: r.k8s?.sharedSkillsClaim ?? 'workpartner-shared-skills' }
      : { host: `${r.hostData}${organization.market.sharedDirectory}` }),
    container: organization.market.containerDirectory, preinstalled: organization.market.preinstalled,
  } : undefined;
  if (kind === 'k8s') return createK8sRuntime({
    ...r.k8s, sharedSkills, image: r.nextImage, containerPrefix: r.nextContainerPrefix, userLabel: r.nextUserLabel,
    modelKeyFile: r.nextModelKeyFile, port: r.nextPort, uid: r.uid,
    secureDir: r.secureDirectory, keyPrefix: model.keyPrefix,
    modelBaseUrl: model.baseUrl ? new URL(model.baseUrl).href : undefined, modelBaseEnvironment: model.baseEnvironment,
    memory: r.nextMemory, nanoCpus: r.nanoCpus, ...overrides,
  });
  if (kind !== 'docker') throw new Error(`Unsupported runtime kind: ${kind}`);
  const { createDockerRuntime } = require('./docker.mjs');
  return createDockerRuntime({
    sharedSkills, self: os.hostname(), modelContainer: r.modelContainer, modelBaseUrl: model.baseUrl ? new URL(model.baseUrl).href : undefined, modelBaseEnvironment: model.baseEnvironment,
    image: r.nextImage, containerPrefix: r.nextContainerPrefix, userLabel: r.nextUserLabel,
    modelKeyFile: r.nextModelKeyFile, port: r.nextPort, uid: r.uid,
    dataDir: r.nextDirectory, hostData: `${r.hostData}${r.nextDirectory}`,
    usersDir: r.usersDirectory, hostUsers: `${r.hostData}/users`, secureDir: r.secureDirectory,
    hostSecure: r.hostSecure, keyPrefix: model.keyPrefix,
    memory: r.nextMemory, nanoCpus: r.nanoCpus, pidsLimit: r.nextPidsLimit,
    ...overrides,
  });
}

/** Legacy containers only support operations independent of next-runtime image, mounts and networks. */
export function createLegacyRuntime(organization, overrides = {}) {
  if (organization.runtime.kind === 'k8s') {
    const unavailable = async () => {
      const error = new Error('LegacyRuntimeUnavailable');
      error.name = error.code = 'LegacyRuntimeUnavailable';
      throw error;
    };
    return Object.fromEntries(['putFiles', 'readFile', 'removeFiles', 'exec', 'stop', 'remove', 'address'].map(name => [name, unavailable]));
  }
  const runtime = createRuntime(organization, {
    ...overrides, containerPrefix: organization.runtime.containerPrefix, dataDir: organization.runtime.usersDirectory,
  });
  const { putFiles, readFile, removeFiles, exec, stop, remove } = runtime;
  return { putFiles, readFile, removeFiles, exec, stop, remove,
    address: async (slug, port, existing) => {
      if (existing === undefined) throw new Error('Legacy runtime does not support address lookup without an existing endpoint');
      return runtime.address(slug, port, existing);
    },
  };
}
