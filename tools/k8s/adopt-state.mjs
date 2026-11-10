import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const validSlug = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(value);
export function requireValue(condition, message, { retry = true } = {}) {
  if (!condition) throw Object.assign(new Error(message), { code: 'AdoptCheckFailed', retry });
}

export async function readOwners(filename, { allowInvalidSlugs = false } = {}) {
  requireValue(typeof filename === 'string' && path.isAbsolute(filename), 'Configure an absolute runtime.migration.ownersFile');
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  requireValue(value?.version === 1 && ['docker', 'k8s'].includes(value.default)
    && value.users && typeof value.users === 'object' && !Array.isArray(value.users)
    && Object.entries(value.users).every(([slug, owner]) => (allowInvalidSlugs || validSlug(slug)) && ['docker', 'k8s'].includes(owner)), 'Invalid owners file');
  return value;
}

export async function writeOwner(filename, slug, owner) {
  const value = await readOwners(filename);
  value.users[slug] = owner;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const original = await fs.stat(filename);
    const file = await fs.open(temporary, 'wx', original.mode & 0o777);
    try {
      await file.chown(original.uid, original.gid);
      await file.chmod(original.mode & 0o777);
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    }
    finally { await file.close(); }
    await fs.rename(temporary, filename);
    const directory = await fs.open(path.dirname(filename), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

// One host-side lock protects both the ownership read/replace and lifecycle operations.
export async function withLock(filename, fn) {
  const lock = `${filename}.adopt.lock`;
  const file = await fs.open(lock, 'wx');
  try { return await fn(); }
  finally { await file.close(); await fs.unlink(lock); }
}

export async function list(client, route) {
  const items = [];
  let cursor;
  do {
    const result = await client.get(`${route}${cursor ? `${route.includes('?') ? '&' : '?'}continue=${encodeURIComponent(cursor)}` : ''}`);
    requireValue(Array.isArray(result?.items), 'Invalid Kubernetes list response');
    items.push(...result.items);
    cursor = result.metadata?.continue;
  } while (cursor);
  return items;
}

// Exact rational bytes avoid floating-point rounding for binary/decimal SI and exponents.
function storageQuantity(value) {
  if (typeof value !== 'string') return null;
  const parsed = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+|[KMGTPE]i|[numkMGTPE]|)$/.exec(value);
  if (!parsed) return null;
  const [, sign, number, suffix] = parsed;
  const fraction = number.split('.')[1]?.length ?? 0;
  const decimal = { '': 0, n: -9, u: -6, m: -3, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 };
  const binary = suffix.endsWith('i');
  const exponent = (binary ? 0 : decimal[suffix] ?? Number(suffix.slice(1))) - fraction;
  // Reject unreasonable exponents rather than allocate unbounded BigInts.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let numerator = BigInt(`${sign}${number.replace('.', '')}`);
  if (binary) numerator *= 1024n ** BigInt('KMGTPE'.indexOf(suffix[0]) + 1);
  return [numerator * 10n ** BigInt(Math.max(exponent, 0)), 10n ** BigInt(Math.max(-exponent, 0))];
}

// Existing volumes must match; silently rebinding a claim could select different data.
export function matches(actual, wanted, field = '') {
  // API omitempty fields can disappear on GET. Compare the requested projection,
  // including array elements, while accepting omitted empty values and API metadata.
  if (actual == null && (wanted === '' || (wanted && typeof wanted === 'object' && Object.keys(wanted).length === 0))) actual = wanted;
  if (Array.isArray(wanted)) return Array.isArray(actual) && actual.length === wanted.length && wanted.every((value, index) => matches(actual[index], value, `${field}.${index}`));
  if (wanted && typeof wanted === 'object') return !!actual && Object.entries(wanted).every(([key, value]) => matches(actual[key], value, field ? `${field}.${key}` : key));
  if (field === 'spec.capacity.storage' || field === 'spec.resources.requests.storage') {
    const a = storageQuantity(actual), b = storageQuantity(wanted);
    if (a && b) return a[0] * b[1] === b[0] * a[1];
  }
  return actual === wanted;
}

export async function publishedLinks(directory, publishedDirectory) {
  const links = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const filename = path.join(directory, name);
    if (!(await fs.lstat(filename)).isSymbolicLink()) continue;
    const target = path.posix.resolve('/data', await fs.readlink(filename));
    if (target.startsWith(`${publishedDirectory.replace(/\/$/, '')}/`)) links.push(filename);
  }
  return links;
}
