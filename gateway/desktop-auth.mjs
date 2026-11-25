/** Desktop login, bearer tokens and access to the current user's model key. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { myKeyAllowed, readMyKey, publicBaseUrl } from './my-key.mjs';

const AUTHORIZE = '/_wp/desktop/authorize';
const TOKEN = '/_wp/api/desktop/token';
const REFRESH = '/_wp/api/desktop/refresh';
const KEY = '/_wp/api/desktop/key';
const REVOKE = '/_wp/api/desktop/revoke-all';
const CODE_TTL = 60 * 1000;
const TOKEN_TTL_DEFAULT = 30;
const RATE_DEFAULT = 30;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_RE = /^[\x21-\x7e]{1,256}$/;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
let generationBumpQueue = Promise.resolve();

function json(res, status, body, extra = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
  return true;
}

function page(res, status, title, message) {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><body style="font-family:-apple-system,sans-serif;display:grid;place-items:center;height:90vh"><main><h2>${escape(title)}</h2><p>${escape(message)}</p></main></body>`);
  return true;
}

function fail(res, status, error) { return json(res, status, { error }); }

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { over = true; chunks.length = 0; }
      else if (!over) chunks.push(chunk);
    });
    req.on('error', () => reject(new Error('body')));
    req.on('end', () => {
      if (over) return reject(new Error('body'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('body')); }
    });
  });
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && /^Bearer (.+)$/i.exec(value)?.[1] || null;
}

export function createDesktopAuth({ organization, organizationData, users, sessionAuthenticate = () => null,
  keyFor, keyFile = user => path.join(organization.runtime.secureDirectory, `${organization.model.keyPrefix || 'model-'}${user.slug}.key`),
  sessionKey, now = Date.now, randomBytes = crypto.randomBytes }) {
  const pending = new Map();
  const pendingByUser = new Map();
  const rates = new Map();
  const tokenKey = crypto.createHmac('sha256', sessionKey).update('wp-desktop-token-v1').digest();
  const stateDir = path.join(organization.runtime.stateDirectory, 'desktop-auth');
  const generationFile = path.join(stateDir, 'generations.json');
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;

  function policy() {
    try {
      const value = organizationData()?.desktop;
      const allow = Array.isArray(value?.allow) && value.allow.every(item => typeof item === 'string') ? value.allow : [];
      const tokenDays = Number.isInteger(value?.tokenDays) && value.tokenDays > 0 ? value.tokenDays : TOKEN_TTL_DEFAULT;
      const rate = Number.isInteger(value?.keyRateLimitPerMinute) && value.keyRateLimitPerMinute > 0 ? value.keyRateLimitPerMinute : RATE_DEFAULT;
      return { enabled: value?.enabled === true, allow, tokenDays, rate };
    } catch { return { enabled: false, allow: [], tokenDays: TOKEN_TTL_DEFAULT, rate: RATE_DEFAULT }; }
  }
  const admitted = (user, config = policy()) => Boolean(config.enabled && user && config.allow.some(item => item === '*' || item === user.slug || item === user.unionId));
  const currentUser = unionId => users().find(user => user.unionId === unionId) || null;

  function readGenerations() {
    try {
      const value = JSON.parse(fs.readFileSync(generationFile, 'utf8'));
      if (!object(value)) throw new Error('invalid generations');
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  }
  function generation(unionId) {
    const value = readGenerations()[unionId];
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function removePending(code, record = pending.get(code)) {
    if (!record) return;
    pending.delete(code);
    const codes = pendingByUser.get(record.unionId);
    if (!codes) return;
    const index = codes.indexOf(code);
    if (index >= 0) codes.splice(index, 1);
    if (!codes.length) pendingByUser.delete(record.unionId);
  }
  function bump(unionId) {
    const operation = generationBumpQueue.then(() => {
      const value = readGenerations();
      const current = Number.isSafeInteger(value[unionId]) && value[unionId] >= 0 ? value[unionId] : 0;
      value[unionId] = current + 1;
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${generationFile}.${randomBytes(8).toString('hex')}`;
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, generationFile);
    });
    generationBumpQueue = operation.catch(() => {});
    return operation;
  }
  function sign(data) { return crypto.createHmac('sha256', tokenKey).update(`wpd.${data}`).digest('base64url'); }
  function issue(user, did = '') {
    const iat = Math.floor(now() / 1000);
    const exp = iat + policy().tokenDays * 86400;
    const data = Buffer.from(JSON.stringify({ u: user.unionId, g: generation(user.unionId), iat, exp, did })).toString('base64url');
    return { access_token: `wpd.${data}.${sign(data)}`, expires_at: new Date(exp * 1000).toISOString(), user: { union_id: user.unionId, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}) } };
  }
  function verify(token) {
    const match = /^wpd\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token || '');
    if (!match) return null;
    const [, data, mac] = match, expected = sign(data);
    const left = Buffer.from(mac), right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
    let value;
    try { value = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { return null; }
    if (!object(value) || typeof value.u !== 'string' || !Number.isSafeInteger(value.g) || value.g < 0
      || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || value.exp <= now() / 1000
      || typeof value.did !== 'string' || value.did.length > 200) return null;
    try {
      const user = currentUser(value.u);
      if (!user || value.g !== generation(value.u) || !admitted(user)) return null;
      return { user, value };
    } catch { return null; }
  }
  function tokenResponse(user, did) { return issue(user, typeof did === 'string' ? did.slice(0, 200) : ''); }
  function validRedirect(value) {
    if (typeof value !== 'string' || value.includes('%')) return false;
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/cb$/.exec(value);
    return Boolean(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535);
  }
  function validAuthorize(url) {
    const redirectUri = url.searchParams.get('redirect_uri');
    const challenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');
    const state = url.searchParams.get('state');
    return validRedirect(redirectUri) && CHALLENGE_RE.test(challenge || '') && method === 'S256' && STATE_RE.test(state || '')
      ? { redirectUri, challenge, state } : null;
  }
  function allowKey(user) {
    try { return organization.features?.myKey === true && myKeyAllowed(user, organizationData()?.myKey); } catch { return false; }
  }
  function authToken(req) {
    const result = verify(bearer(req));
    if (!result) return null;
    return result;
  }
  function rateLimited(unionId, limit) {
    const t = now(), row = rates.get(unionId);
    if (!row || t - row.start >= 60000) { rates.set(unionId, { start: t, count: 1 }); return null; }
    if (row.count >= limit) return Math.max(1, Math.ceil((60000 - (t - row.start)) / 1000));
    row.count++;
    return null;
  }
  async function handle(req, res, url) {
    if (![AUTHORIZE, TOKEN, REFRESH, KEY, REVOKE].includes(url.pathname)) return false;
    if (url.pathname === AUTHORIZE) {
      if (req.method !== 'GET') return page(res, 405, '请求方法不支持', '请使用 GET。');
      const parameters = validAuthorize(url);
      if (!parameters) return page(res, 400, '桌面登录请求无效', 'redirect_uri、code_challenge、code_challenge_method 或 state 不符合要求。');
      if (organization.features?.myKey !== true) return page(res, 403, '桌面版暂未开放', '桌面版钥匙功能尚未开放。');
      const who = sessionAuthenticate(req), user = who && currentUser(who.unionId);
      if (!who) { const next = `${url.pathname}${url.search}`; res.writeHead(302, { location: `/_wp/login?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' }); res.end(); return true; }
      if (!user || !admitted(user)) return page(res, 403, '桌面版暂未开放', '你的工作伙伴尚未开通桌面版登录。');
      const current = now();
      for (const [oldCode, old] of pending) if (old.until <= current) removePending(oldCode, old);
      const code = randomBytes(32).toString('base64url');
      const record = { ...parameters, unionId: user.unionId, until: current + CODE_TTL, created: current };
      pending.set(code, record);
      const userCodes = pendingByUser.get(user.unionId) || [];
      userCodes.push(code);
      pendingByUser.set(user.unionId, userCodes);
      while (userCodes.length > 5) removePending(userCodes.shift());
      while (pending.size > 10000) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        removePending(oldest);
      }
      const target = new URL(parameters.redirectUri); target.searchParams.set('code', code); target.searchParams.set('state', parameters.state);
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }); res.end(); return true;
    }
    if (url.pathname === TOKEN) {
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
      let body; try { body = await readBody(req); } catch { return fail(res, 400, 'invalid_request'); }
      const code = typeof body?.code === 'string' ? body.code : '';
      const record = pending.get(code); if (record) removePending(code, record);
      if (!record || record.until <= now() || typeof body?.code_verifier !== 'string' || typeof body?.redirect_uri !== 'string'
        || body.redirect_uri !== record.redirectUri || crypto.createHash('sha256').update(body.code_verifier).digest('base64url') !== record.challenge) return fail(res, 400, 'invalid_grant');
      if (organization.features?.myKey !== true) return fail(res, 400, 'invalid_grant');
      const user = currentUser(record.unionId); if (!user || !admitted(user)) return fail(res, 400, 'invalid_grant');
      try { return json(res, 200, tokenResponse(user, body.device_name)); } catch { return fail(res, 500, 'state_unavailable'); }
    }
    if (url.pathname === REFRESH) {
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
      if (organization.features?.myKey !== true) return fail(res, 401, 'invalid_token');
      const result = authToken(req); if (!result) return fail(res, 401, 'invalid_token');
      try { return json(res, 200, tokenResponse(result.user, result.value.did)); } catch { return fail(res, 500, 'state_unavailable'); }
    }
    if (url.pathname === KEY) {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
      const result = authToken(req); if (!result) return fail(res, 401, 'invalid_token');
      if (!allowKey(result.user)) return fail(res, 403, 'key_not_allowed');
      const fp = url.searchParams.get('fp');
      if (fp !== null && fp !== '' && !/^[a-f0-9]{12}$/i.test(fp)) return fail(res, 400, 'invalid_fingerprint');
      const retry = rateLimited(result.user.unionId, policy().rate);
      if (retry) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(retry) });
      let key;
      try { key = await readMyKey(keyFor, result.user); } catch { return fail(res, 503, 'key_unavailable'); }
      if (!key) return fail(res, 404, 'key_not_found');
      const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
      if (fp && fp.toLowerCase() === fingerprint) return json(res, 204, undefined);
      let issuedAt;
      try { issuedAt = (await fs.promises.stat(keyFile(result.user))).mtime.toISOString(); } catch { return fail(res, 404, 'key_not_found'); }
      try {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(path.join(stateDir, 'audit.log'), JSON.stringify({ at: new Date(now()).toISOString(), unionId: result.user.unionId, device_name: result.value.did, fingerprint }) + '\n', { mode: 0o600, flush: true });
      } catch { return fail(res, 503, 'audit_unavailable'); }
      let baseUrl = '';
      try { baseUrl = publicBaseUrl(organizationData()?.myKey?.publicBaseUrl); } catch { /* fail closed */ }
      return json(res, 200, { key, fingerprint, base_url: baseUrl, issued_at: issuedAt });
    }
    if (url.pathname === REVOKE) {
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
      if (organization.features?.myKey !== true) return fail(res, 403, 'desktop_unavailable');
      const tokenResult = authToken(req);
      let user = tokenResult?.user;
      if (!tokenResult) {
        if (req.headers.origin !== origin) return fail(res, 403, 'origin_required');
        const who = sessionAuthenticate(req); user = who && currentUser(who.unionId);
        if (!user || !admitted(user)) return fail(res, 401, 'invalid_session');
      }
      try { await bump(user.unionId); } catch { return fail(res, 500, 'state_unavailable'); }
      return json(res, 200, { ok: true });
    }
    return false;
  }
  handle.isDesktopRoute = url => [AUTHORIZE, TOKEN, REFRESH, KEY, REVOKE].includes(url.pathname);
  return handle;
}

