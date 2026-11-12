/** Session-owned model credentials and a deliberately narrow self-service usage view. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { myKeyClient } from './my-key-client.mjs';

const API = '/_wp/api/my-key';
export const USAGE_ZONE = 'UTC';
const DAY = 86400000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const fail = status => Object.assign(new Error('My key request failed'), { status });

export function maskKey(key) {
  return key.length < 12 ? '••••••••' : (key.startsWith('sk-') ? 'sk-' : '') + '••••••••' + key.slice(-4);
}

export function usageWindows(now) {
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monday = today - ((date.getUTCDay() + 6) % 7) * DAY;
  const window = (start, duration) => ({ start: new Date(start).toISOString(), reset: new Date(start + duration).toISOString() });
  return { today: window(today, DAY), week: window(monday, 7 * DAY),
    period: new Date(monday).toISOString().slice(0, 10) + '..' + new Date(today).toISOString().slice(0, 10) };
}

export function mapLimits(entries) {
  const result = { day: null, week: null };
  if (!Array.isArray(entries)) return result;
  for (const entry of entries) {
    if (!object(entry) || !['day', 'week'].includes(entry.period)) continue;
    if (['calls', 'tokens', 'cost', 'tokenLimit', 'costLimit', 'tokensLeft', 'costLeft']
      .some(field => entry[field] !== undefined && !number(entry[field]))) continue;
    const unit = number(entry.costLimit) && entry.costLimit > 0 ? 'cost'
      : number(entry.tokenLimit) && entry.tokenLimit > 0 ? 'tokens' : null;
    if (!unit) continue;
    const limit = unit === 'cost' ? entry.costLimit : entry.tokenLimit;
    const used = entry[unit], left = entry[unit === 'cost' ? 'costLeft' : 'tokensLeft'];
    const start = iso(entry.start), reset = iso(entry.reset);
    if (!number(used) || !number(left) || !start || !reset || reset <= start || typeof entry.spent !== 'boolean'
      || (entry.models !== undefined && (!Array.isArray(entry.models) || entry.models.some(v => typeof v !== 'string')))) continue;
    const partial = Boolean(entry.models?.length);
    if (!result[entry.period] || (result[entry.period].partial && !partial)) {
      result[entry.period] = { unit, limit, used, left, start, reset, spent: entry.spent, partial };
    }
  }
  return result;
}

export function mapUsage(data, profileName, windows, limits) {
  const unavailable = { today: null, week: null };
  if (!object(data) || !number(data.calls) || !number(data.cost) || !Array.isArray(data.series) || !data.series.length
    || !iso(data.series[0]?.time) || Date.parse(data.series[0].time) !== Date.parse(windows.week.start)
    || !Array.isArray(data.callerKeys) || data.callerKeys.length > 1 || !Array.isArray(data.by?.callerKey) || data.by.callerKey.length > 1
    || (data.callerKeys.length === 1 && data.callerKeys[0]?.name !== profileName)
    || !Array.isArray(data.by?.model)) return unavailable;
  let calls = 0, cost = 0;
  for (const point of data.series) {
    if (!object(point) || !iso(point.time) || !number(point.calls) || !number(point.cost)) return unavailable;
    if (Date.parse(point.time) >= Date.parse(windows.today.start)) { calls += point.calls; cost += point.cost; }
  }
  if (!number(calls) || !number(cost)) return unavailable;
  const merged = new Map();
  for (const model of data.by.model) {
    if (!object(model) || typeof model.id !== 'string' || !number(model.calls) || !number(model.cost)) return unavailable;
    const name = model.id.split('/').at(-1).slice(0, 200);
    const value = (merged.get(name) || 0) + (data.cost > 0 ? model.cost : model.calls);
    if (!number(value)) return unavailable;
    merged.set(name, value);
  }
  const total = data.cost > 0 ? data.cost : data.calls;
  const models = [...merged].map(([name, value]) => ({ name, share: total > 0 ? value / total : 0 }))
    .filter(m => number(m.share) && m.share >= 0.01).sort((a, b) => b.share - a.share).slice(0, 3)
    .map(m => ({ name: m.name, share: Number(m.share.toFixed(4)) }));
  const window = (computed, limit) => ({ start: limit?.start || computed.start, reset: limit?.reset || computed.reset });
  return { today: { ...window(windows.today, limits.day), calls, cost },
    week: { ...window(windows.week, limits.week), calls: data.calls, cost: data.cost, models } };
}

export function mapUpstream(profile, usage, windows) {
  if (!object(profile) || typeof profile.name !== 'string' || !Array.isArray(profile.limits) || !Array.isArray(profile.models)
    || profile.models.some(m => !object(m) || typeof m.id !== 'string' || typeof m.label !== 'string')) return { usage: null, models: [] };
  const limits = mapLimits(profile.limits);
  return { usage: { ...mapUsage(usage, profile.name, windows, limits), limits },
    models: profile.models.slice(0, 500).map(m => ({ id: m.id.slice(0, 200), label: m.label.slice(0, 200) })) };
}

export function publicBaseUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) return '';
    return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
  } catch { return ''; }
}

// A wall-clock deadline also covers DNS, connection setup and a slowly trickling body.
function upstream(url, key, timeoutMs) {
  return new Promise(resolve => {
    let request, timer, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); request?.destroy(); };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const target = new URL(url), transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
      if (!transport || target.username || target.password) return finish(null);
      request = transport.request(target, { method: 'GET', headers: { authorization: `Bearer ${key}`, 'user-agent': 'workpartner-gateway' } }, response => {
        if (response.statusCode !== 200) { response.resume(); return finish(null); }
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) finish(null); else chunks.push(chunk); });
        response.on('error', () => finish(null));
        response.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null); } });
      });
      request.on('error', () => finish(null)); request.end();
    } catch { finish(null); }
  });
}

function readAction(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, oversized = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024) { oversized = true; chunks.length = 0; reject(fail(400)); }
      else if (!oversized) chunks.push(chunk);
    });
    req.on('error', () => reject(fail(400)));
    req.on('end', () => {
      if (oversized) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(body) || !['show', 'copy', 'copy-config'].includes(body.action)) throw fail(400);
        resolve(body.action);
      } catch { reject(fail(400)); }
    });
  });
}

export function createMyKey({ organization, organizationData, authenticate, sessionAuthenticate = () => null, keyFor, now = Date.now, timeoutMs = 5000 }) {
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  function policy() {
    try {
      const config = organizationData()?.myKey;
      return { allow: Array.isArray(config?.allow) && config.allow.every(v => typeof v === 'string') ? config.allow : [],
        baseUrl: publicBaseUrl(config?.publicBaseUrl),
        revealSeconds: Number.isInteger(config?.revealSeconds) ? Math.max(2, Math.min(300, config.revealSeconds)) : 30 };
    } catch { return { allow: [], baseUrl: '', revealSeconds: 30 }; }
  }
  const admitted = (user, config) => Boolean(user?.slug && user?.unionId && config.allow.some(v => v === '*' || v === user.slug || v === user.unionId));
  async function readKey(user) {
    try { return (await keyFor(user))?.trim() || null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const reply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  const handle = async (req, res, url) => {
    if (![API, API + '/reveal'].includes(url.pathname)) return false;
    try {
      const user = authenticate(req);
      if (!user && !sessionAuthenticate(req)) throw fail(401);
      const config = policy();
      if (!admitted(user, config)) { reply(res, 404); return true; }
      const reveal = url.pathname.endsWith('/reveal');
      if (req.method !== (reveal ? 'POST' : 'GET')) throw fail(405);
      if (reveal) {
        if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(403);
        const action = await readAction(req), key = await readKey(user);
        if (!key) throw fail(404);
        const directory = path.join(organization.runtime.stateDirectory, 'my-key');
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.promises.appendFile(path.join(directory, 'audit.log'), JSON.stringify({ at: new Date(now()).toISOString(), slug: user.slug, action }) + '\n', { mode: 0o600, flush: true });
        reply(res, 200, { key });
      } else {
        const key = await readKey(user), windows = usageWindows(now());
        const defaults = Object.fromEntries(['codex', 'claude', 'opus', 'sonnet', 'haiku'].map(name => [name,
          typeof organization.model.defaults?.[name] === 'string' ? organization.model.defaults[name] : '']));
        let mapped = { usage: null, models: [] };
        if (key) {
          const base = organization.model.baseUrl.replace(/\/+$/, '');
          const [profile, usage] = await Promise.all([upstream(base + '/magpie/me', key, timeoutMs),
            upstream(base + '/magpie/usage/requests?period=' + windows.period + '&limit=1&offset=0', key, timeoutMs)]);
          mapped = mapUpstream(profile, usage, windows);
        }
        reply(res, 200, { key: key ? { masked: maskKey(key) } : null, revealSeconds: config.revealSeconds, baseUrl: config.baseUrl, defaults, ...mapped });
      }
    } catch (error) {
      // Only known system codes may be logged; never error messages, bodies or upstream data.
      if (!error.status) console.error('[my-key] ' + (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOSPC', 'EROFS', 'EIO'].includes(error.code) ? error.code : 'UNAVAILABLE'));
      reply(res, error.status || 503, { error: 'My key request failed' });
    }
    return true;
  };
  handle.clientFor = user => organization.features?.myKey === false || !admitted(user, policy()) ? '' : myKeyClient();
  return handle;
}
