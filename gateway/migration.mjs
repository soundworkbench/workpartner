import fs from 'node:fs';
import crypto from 'node:crypto';
import { proxyHttp, proxyUpgrade } from '../preview/transport.mjs';
import { previewPort } from '../preview/policy.mjs';

const kinds = ['docker', 'k8s'];
const marker = 'x-workpartner-delegated';

/** Read ownership on demand so an atomic file replacement takes effect without a restart. */
export function createMigration({ runtime }, log = console.error) {
  const kind = runtime.kind ?? 'docker';
  const config = runtime.migration;
  let stamp, cached;
  function owners() {
    if (!config?.ownersFile) return null;
    try {
      const stat = fs.statSync(config.ownersFile, { bigint: true });
      const next = `${stat.mtimeNs}:${stat.ino}:${stat.size}`;
      if (next === stamp) return cached;
      const value = JSON.parse(fs.readFileSync(config.ownersFile, 'utf8'));
      if (value?.version !== 1 || !kinds.includes(value.default) || !value.users || typeof value.users !== 'object'
        || Array.isArray(value.users) || Object.values(value.users).some(owner => !kinds.includes(owner))) {
        throw new Error('Invalid migration owners file');
      }
      cached = value; stamp = next;
    } catch {
      log(`[migration] Owners file unavailable; ${cached ? 'using last valid ownership' : 'requests and runtime writes disabled'}`);
    }
    return cached;
  }
  function owner(user) {
    const value = owners();
    if (value === null) return kind;
    if (!value || !user) return null;
    if (user.backend !== 'aionui') return 'docker';
    return Object.hasOwn(value.users, user.slug) ? value.users[user.slug] : value.default;
  }
  const owns = user => owner(user) === kind;
  const assertOwned = user => {
    if (!owns(user)) throw Object.assign(new Error('Workspace migration in progress'), {
      code: 'WORKSPACE_NOT_OWNED', status: owners() === undefined ? 503 : 403,
    });
  };
  let target;
  if (config?.peerOrigin) {
    const url = new URL(config.peerOrigin);
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('runtime.migration.peerOrigin must be an internal HTTP origin');
    }
    target = { hostname: url.hostname, port: url.port || 80 };
  }
  function forward(req, response, user, head) {
    const unavailable = owners() === undefined;
    if (!unavailable && (!user || owns(user))) return false;
    const loop = req.headers[marker] !== undefined;
    if (unavailable || loop || !target) {
      const status = !unavailable && loop ? 502 : 503;
      const body = '<!doctype html><meta charset="utf-8"><title>工作区迁移中</title><h2>工作区迁移中</h2><p>请稍后重试。</p>';
      const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
      if (head === undefined) { response.writeHead(status, headers); response.end(body); }
      else response.end(`HTTP/1.1 ${status} ${status === 502 ? 'Bad Gateway' : 'Service Unavailable'}\r\nContent-Type: ${headers['content-type']}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } else {
      const headers = { ...req.headers, [marker]: '1' };
      // Personal operations may take minutes before sending response headers.
      const options = { responseTimeoutMs: 0, errorMessage: '服务暂时不可用，请稍后重试。' };
      if (head === undefined) proxyHttp(req, response, target, headers, undefined, undefined, options);
      else proxyUpgrade(req, response, head, target, headers, undefined, options);
    }
    return true;
  }
  // Recheck before each runtime write, including work queued before an ownership change.
  function guardRuntime(runtime, users, fixedUser) {
    if (!config?.ownersFile) return runtime;
    const writes = new Set(['ensureIsolation', 'create', 'start', 'stop', 'restart', 'remove', 'exec', 'processes', 'runOnce', 'putFiles', 'removeFiles']);
    return new Proxy(runtime, { get(target, name) {
      const method = target[name];
      if (typeof method !== 'function') return method;
      if (!writes.has(name) && !(fixedUser && name === 'execNamed')) return method.bind(target);
      return (...args) => {
        const user = fixedUser || (name === 'create' ? args[0] : users().find(user => user.slug === args[0]));
        assertOwned(user);
        return method.apply(target, args);
      };
    } });
  }
  return { kind, owner, owns, assertOwned, forward, guardRuntime };
}

/** Match the signed preview session protocol without trusting a main-site cookie on a preview origin. */
export function previewSessionUser(req, { key, host, users, now = Date.now }) {
  const token = String(req.headers.cookie || '').split(/;\s*/).find(value => value.startsWith('__Host-zp-preview='))?.slice('__Host-zp-preview='.length);
  if (!token || token.length > 32768) return null;
  const [data, mac, extra] = token.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(mac || '')) return null;
  const expected = crypto.createHmac('sha256', key).update(`session:${data}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const value = JSON.parse(Buffer.from(data, 'base64url').toString());
    return value.h === host && value.e > now() / 1000 && value.until > now() / 1000 && previewPort(value.p)
      ? users().find(user => user.unionId === value.u) || null : null;
  } catch { return null; }
}
