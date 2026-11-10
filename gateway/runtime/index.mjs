import os from 'node:os';
import { createDockerRuntime } from './docker.mjs';

/** Select the configured runtime at startup; omitted kind preserves Docker deployments.
 * Runtime methods are asynchronous; inspect returns normalized state and address returns {host, port} or null.
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
  if (kind !== 'docker') throw new Error(`Unsupported runtime kind: ${kind}`);
  return createDockerRuntime({
    self: os.hostname(), modelContainer: r.modelContainer, modelBaseUrl: model.baseUrl ? new URL(model.baseUrl).href : undefined, modelBaseEnvironment: model.baseEnvironment,
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
