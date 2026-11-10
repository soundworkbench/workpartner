/** Resolve a local organization without reading credentials or writing profiles. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import defaults from './default.json' with { type: 'json' };

/** Fill omitted organization fields from the neutral configuration. */
function merge(base, selected) {
  const out = { ...base };
  for (const [key, value] of Object.entries(selected)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(base[key] || {}, value) : value;
  }
  return out;
}

/** Validate a deployment hostname; an empty optional hostname remains empty. */
function hostname(value, name, optional = false) {
  if (optional && !value) return '';
  if (typeof value !== 'string' || !/^[a-z0-9.-]+(?::[0-9]+)?$/iu.test(value)
    || new URL(`https://${value}`).host !== value.toLowerCase()) {
    throw new Error(`${name} must be a hostname without a scheme, path or credentials`);
  }
  return value;
}

/** Read non-secret release data without requiring deployment endpoints during a build. */
export function organizationData(environment = process.env) {
  const directory = environment.WORKPARTNER_ORG_DIR ? resolve(environment.WORKPARTNER_ORG_DIR) : fileURLToPath(new URL('../../org/default/', import.meta.url));
  const selected = environment.WORKPARTNER_ORG_DIR ? JSON.parse(readFileSync(resolve(directory, 'organization.json'), 'utf8')) : {};
  const data = merge(defaults, selected);
  if (data.schemaVersion !== 1 || typeof data.organizationId !== 'string') throw new Error('Unsupported organization configuration');
  if (!/^\/_[a-z0-9]+\/callback$/.test(data.identity.callbackPath)) throw new Error('Invalid identity.callbackPath');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(data.model.keyEnvironment) || !/^[A-Z_][A-Z0-9_]*$/.test(data.model.baseEnvironment)) throw new Error('Invalid model environment variable');
  if (!['pool', 'exec'].includes(data.model.keyMode)) throw new Error('Invalid model key mode');
  if (!['unrestricted', 'pilot-group'].includes(data.identity.admission)) throw new Error('Invalid admission policy');
  return { ...data, directory };
}

/** Model defaults and optional catalog entries, shared by gateway and image startup. */
export function nextModelConfig(data, environment = {}) {
  const selected = environment.WORKPARTNER_MODEL_CONFIG
    ? JSON.parse(environment.WORKPARTNER_MODEL_CONFIG) : { defaults: data.model.defaults, catalog: data.model.catalog };
  const defaults = { ...selected.defaults };
  for (const [field, variable] of Object.entries({ claude: 'ANTHROPIC_MODEL', opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL', haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' })) {
    if (environment[variable]) defaults[field] = environment[variable];
  }
  for (const name of ['codex', 'claude', 'opus', 'sonnet', 'haiku', 'effort', 'language', 'claudePrefix']) {
    if (typeof defaults?.[name] !== 'string' || !defaults[name] || /[\r\n]/.test(defaults[name])) throw new Error(`Invalid model.defaults.${name}`);
  }
  const catalog = {};
  for (const backend of ['codex', 'claude']) {
    const entries = selected.catalog?.[backend] || [{ default: backend, also: ['default'] }];
    if (!Array.isArray(entries) || !entries.length) throw new Error(`Invalid model.catalog.${backend}`);
    catalog[backend] = entries.map(entry => {
      const key = entry.default ? defaults[entry.default] : entry.key;
      const id = entry.id || key;
      if (typeof key !== 'string' || !key || typeof id !== 'string' || !id
        || (entry.also && (!Array.isArray(entry.also) || entry.also.some(value => typeof value !== 'string')))) throw new Error('Invalid model catalog entry');
      return { id, key, name: entry.name || key.split('/').at(-1), also: entry.also || [] };
    });
  }
  return { defaults, catalog };
}

/** Environment consumed by the next image; credentials remain in the mounted key file. */
export function nextEnvironment(data, environment = {}) {
  const model = data.model;
  const config = nextModelConfig(data, environment);
  const defaults = config.defaults;
  const base = environment.MODEL_BASE_URL || environment[model.baseEnvironment] || model.nextBaseUrl || model.baseUrl;
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid MODEL_BASE_URL');
  return {
    WORKPARTNER_MODEL_CONFIG: JSON.stringify(config),
    PARTNER_GATEWAY_ORIGIN: data.runtime.gatewayOrigin,
    PARTNER_CODEX_MODEL: defaults.codex,
    PARTNER_DEFAULT_EFFORT: defaults.effort,
    MODEL_BASE_URL: base,
    PARTNER_CODEX_PROVIDER: model.codexProvider,
    PARTNER_MODEL_KEY_FILE: environment.PARTNER_MODEL_KEY_FILE || data.runtime.nextModelKeyFile,
    PARTNER_MODEL_KEY_ENV: model.keyEnvironment,
    ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL || base.replace(/\/v1\/?$/, ''),
    ANTHROPIC_MODEL: environment.ANTHROPIC_MODEL || defaults.claude,
    ANTHROPIC_DEFAULT_OPUS_MODEL: environment.ANTHROPIC_DEFAULT_OPUS_MODEL || defaults.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: environment.ANTHROPIC_DEFAULT_SONNET_MODEL || defaults.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: environment.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaults.haiku,
    PARTNER_DEFAULT_LANGUAGE: defaults.language,
    PARTNER_CLAUDE_MODEL_PREFIX: defaults.claudePrefix,
    AIONUI_PORT: environment.AIONUI_PORT || String(data.runtime.nextPort),
  };
}

/**
 * Read organization.json from WORKPARTNER_ORG_DIR, otherwise use neutral defaults.
 * @param {NodeJS.ProcessEnv} environment Existing deployment variables; omitted uses process.env.
 * @returns {import('./resolve.mjs').Organization} Effective non-secret values and secret file references.
 */
export function resolveOrganization(environment = process.env) {
  const { directory, ...data } = organizationData(environment);
  const host = hostname(environment.PUBLIC_HOST || data.publicHost, 'PUBLIC_HOST');
  const projectHost = hostname(environment.MEEGLE_HOST || '', 'MEEGLE_HOST', true);
  const baseUrl = environment.MODEL_BASE_URL || environment.MODEL_BASE_URL || data.model.baseUrl;
  const modelUrl = new URL(baseUrl);
  // HTTPS proxy support belongs to a later phase; retain the existing transport here.
  if (!['http:', 'https:'].includes(modelUrl.protocol) || modelUrl.username || modelUrl.password) throw new Error('Invalid MODEL_BASE_URL');
  const keyPrefix = environment.MODEL_KEY_PREFIX || environment.MODEL_KEY_PREFIX || data.model.keyPrefix;
  if (!/^[a-zA-Z0-9_-]+$/.test(keyPrefix)) throw new Error('Invalid MODEL_KEY_PREFIX');
  return {
    ...data,
    directory,
    server: {
      publicHost: host,
      publicOrigin: `https://${host}`,
      legacyHosts: String(environment.OLD_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean),
      previewHost: environment.PREVIEW_HOST || '',
      projectHost,
    },
    identity: { ...data.identity, appId: environment.FEISHU_APP_ID ?? data.identity.appId, pilotChatId: environment.ADMISSION_GROUP_ID ?? environment.ADMISSION_GROUP_ID ?? data.identity.pilotChatId },
    model: { ...data.model, baseUrl, keyPrefix, keyMode: environment.MODEL_KEYS || environment.MODEL_KEYS || data.model.keyMode },
    runtime: {
      ...data.runtime,
      modelContainer: environment.MODEL_CONTAINER ?? data.runtime.modelContainer ?? modelUrl.hostname,
      nextImage: environment.NEXT_IMAGE || data.runtime.nextImage,
      image: environment.PARTNER_IMAGE || data.runtime.image,
      hostData: environment.HOST_PARTNER_DATA || environment.PARTNER_DATA || data.runtime.hostData || '',
      hostSecure: environment.HOST_PARTNER_SECURE || environment.PARTNER_SECURE || data.runtime.hostSecure || '',
      hostConfig: environment.HOST_PARTNER_CONFIG || environment.PARTNER_CONFIG || data.runtime.hostConfig || '',
    },
  };
}

/**
 * Resolve only the pre-existing public desktop fields from environment or packaged defaults.
 * @param {NodeJS.ProcessEnv} environment Runtime or build overrides.
 * @param {{ PUBLIC_HOST?: unknown, MEEGLE_HOST?: unknown }} packaged Public packaged fields, used when an override is absent.
 * @returns {{ PUBLIC_HOST: string, MEEGLE_HOST: string }} Validated lowercase desktop package configuration.
 */
export function desktopPublicConfig(environment, packaged = {}) {
  return {
    PUBLIC_HOST: hostname(environment.PUBLIC_HOST ?? packaged.PUBLIC_HOST, 'PUBLIC_HOST').toLowerCase(),
    MEEGLE_HOST: hostname(environment.MEEGLE_HOST ?? packaged.MEEGLE_HOST ?? '', 'MEEGLE_HOST', true).toLowerCase(),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === 'build-json') process.stdout.write(JSON.stringify(organizationData()));
  else if (mode === 'next-env') {
    for (const [name, value] of Object.entries(nextEnvironment(organizationData(), process.env))) {
      process.stdout.write(`export ${name}='${String(value).replaceAll("'", "'\\''")}'\n`);
    }
  } else {
    const organization = resolveOrganization();
    if (mode === 'json') process.stdout.write(JSON.stringify(organization));
    else throw new Error('Expected json, build-json, next-env or web-env');
  }
}
