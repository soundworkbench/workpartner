import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const slugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const idPattern = /^[0-9a-f]{32}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);
const failures = new Set(['denied', 'limit', 'stale', 'replay', 'no-key', 'rotate-failed', 'interrupted']);
const systemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOSPC', 'EROFS', 'EIO', 'ECONNRESET', 'ETIMEDOUT']);
const fail = (status, reason) => Object.assign(new Error('My key request failed'), { status, reason });
const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const readKey = file => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
};
const unlink = file => { try { fs.unlinkSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const entries = directory => {
  try { return fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

export function createMyKeyReset({ organization, policy, runtime, restarted, keyFile, now, verify, timers = {}, timing = {} }) {
  const root = path.join(organization.runtime.stateDirectory, 'my-key'), reset = path.join(root, 'reset');
  const options = { claimTimeoutMs: 30000, heartbeatAgeMs: 45000, pollIntervalMs: 1000,
    retryDelayMs: 2000, maxRetryDelayMs: 60000, verifyDelayMs: 2000, orphanAgeMs: 120000,
    brokerTimeoutMs: 600000, outcomeAgeMs: 600000, auditIntervalMs: 600000, cleanupIntervalMs: 60000, ...timing };
  const schedule = timers.setTimeout || setTimeout, cancel = timers.clearTimeout || clearTimeout;
  const pendingTimers = new Map(), decisions = new Map(), drivers = new Set();
  let closed = false;
  const at = () => new Date(now()).toISOString();
  const file = (directory, name) => path.join(reset, directory, name + '.json');
  const activeFile = slug => file('active', slug);
  const stagedFile = (slug, id) => keyFile({ slug }) + '.' + id + '.next';
  function directory(target) {
    if (fs.existsSync(target)) return;
    directory(path.dirname(target));
    try {
      fs.mkdirSync(target, { mode: 0o700 });
      const parent = fs.statSync(path.dirname(target)), child = fs.statSync(target);
      if (parent.uid !== child.uid || parent.gid !== child.gid) fs.chownSync(target, parent.uid, parent.gid);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  function init() {
    directory(root); directory(reset);
    for (const name of ['tmp', 'active', 'requests', 'claimed', 'results', 'last', 'days', 'progress', 'locks']) directory(path.join(reset, name));
  }
  function write(target, value) {
    const temp = path.join(reset, 'tmp', crypto.randomBytes(16).toString('hex'));
    try {
      fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true });
      const owner = fs.statSync(reset), stat = fs.statSync(temp);
      if (owner.uid !== stat.uid || owner.gid !== stat.gid) fs.chownSync(temp, owner.uid, owner.gid);
      fs.renameSync(temp, target);
    } finally { unlink(temp); }
  }
  function audit(slug, id, result, extra = {}) {
    fs.appendFileSync(path.join(root, 'audit.log'), JSON.stringify({ at: at(), slug, action: 'reset', result, id, ...extra }) + '\n', { mode: 0o600, flush: true });
  }
  const dayFile = (slug, date = at().slice(0, 10)) => file('days', slug + '-' + date);
  function day(slug) {
    const value = read(dayFile(slug));
    if (value === null) return { attempts: [], completed: [] };
    if (!Array.isArray(value.attempts) || !Array.isArray(value.completed)
      || [...value.attempts, ...value.completed].some(id => !validId(id))) throw fail(503, 'unavailable');
    return value;
  }
  const enabled = config => Boolean(runtime && config.reset?.enabled === true);
  function summary(user, config = policy()) {
    if (!enabled(config)) return null;
    if (!slugPattern.test(user.slug)) throw fail(404);
    const left = Math.max(0, 3 - new Set(day(user.slug).completed).size);
    const status = fs.existsSync(activeFile(user.slug)) ? 'pending' : 'idle';
    const blocked = config.reset.blocked.some(v => v === '*' || v === user.slug || v === user.unionId);
    let heartbeat;
    try { heartbeat = read(path.join(reset, 'broker.json')); } catch { /* Unreadable means unavailable. */ }
    const age = now() - Date.parse(heartbeat?.at);
    const fresh = Number.isFinite(age) && age >= -30000 && age <= options.heartbeatAgeMs;
    const reason = blocked ? 'blocked' : !fs.existsSync(keyFile(user)) ? 'no-key' : !left ? 'limit' : !fresh ? 'unavailable' : null;
    return { status, allowed: !reason && status === 'idle', reason, note: blocked ? config.reset.blockedNote : '', left, limit: 3 };
  }
  function status(user, config) {
    const state = summary(user, config);
    if (!state) return null;
    const last = read(file('last', user.slug));
    const recent = last && validId(last.id) && ['done', 'failed'].includes(last.status)
      && (last.status === 'done' ? last.code === 'ok' : failures.has(last.code) || ['unavailable', 'invalid'].includes(last.code))
      && now() - Date.parse(last.at) < options.outcomeAgeMs;
    const { limit: _, ...rest } = state;
    return { ...rest, status: state.status === 'pending' ? 'pending' : recent ? last.status : 'idle', code: state.status === 'pending' ? '' : recent ? last.code : '' };
  }
  function mutex(slug, fn) {
    const result = (decisions.get(slug) || Promise.resolve()).catch(() => {}).then(fn);
    decisions.set(slug, result);
    const release = () => { if (decisions.get(slug) === result) decisions.delete(slug); };
    result.then(release, release);
    return result;
  }
  function accept(user) {
    return mutex(user.slug, () => {
      const config = policy();
      if (!enabled(config) || !config.allow.some(v => v === '*' || v === user.slug || v === user.unionId)) throw fail(404);
      const state = summary(user, config);
      const codes = { blocked: 403, 'no-key': 409, limit: 429, unavailable: 503 };
      if (['blocked', 'no-key', 'limit'].includes(state.reason)) throw fail(codes[state.reason], state.reason);
      if (day(user.slug).attempts.length >= 10) throw fail(429, 'limit');
      if (state.reason) throw fail(codes[state.reason], state.reason);
      if (state.status === 'pending') throw fail(409, 'busy');
      init(); cleanup();
      const id = crypto.randomBytes(16).toString('hex'), attempt = { id, at: at() };
      const release = lock(user.slug);
      if (!release) throw fail(409, 'busy');
      let reserved = false;
      try {
        const fd = fs.openSync(activeFile(user.slug), 'wx', 0o600);
        reserved = true;
        try {
          fs.writeFileSync(fd, JSON.stringify(attempt)); fs.fsyncSync(fd);
          const owner = fs.statSync(reset), stat = fs.fstatSync(fd);
          if (owner.uid !== stat.uid || owner.gid !== stat.gid) fs.fchownSync(fd, owner.uid, owner.gid);
        } finally { fs.closeSync(fd); }
        // The exclusive active file also serializes daily counters across gateway processes.
        const counts = day(user.slug);
        if (counts.completed.length >= 3 || counts.attempts.length >= 10) throw fail(429, 'limit');
        counts.attempts.push(id); write(dayFile(user.slug), counts);
        audit(user.slug, id, 'requested');
        write(file('requests', id), { id, slug: user.slug, at: attempt.at });
      } catch (error) {
        if (reserved) unlink(activeFile(user.slug));
        if (!reserved && error.code === 'EEXIST') throw fail(409, 'busy');
        throw error.status ? error : fail(503, 'unavailable');
      } finally { release(); }
      drive(user.slug);
      return { status: 'pending' };
    });
  }
  function pause(ms) {
    return new Promise(resolve => {
      const timer = schedule(() => { pendingTimers.delete(timer); resolve(); }, ms);
      timer?.unref?.(); pendingTimers.set(timer, resolve);
    });
  }
  function cleanup() {
    const cutoff = Date.parse(at().slice(0, 10)) - 7 * 86400000;
    for (const name of entries(path.join(reset, 'days'))) {
      const match = /^[a-z0-9][a-z0-9-]{0,62}-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (match && Date.parse(match[1]) < cutoff) unlink(path.join(reset, 'days', name));
    }
    const referenced = new Set();
    for (const name of entries(path.join(reset, 'active'))) {
      try { const value = read(path.join(reset, 'active', name)); if (validId(value?.id)) referenced.add(value.id); }
      catch { /* The recovery driver handles invalid active files. */ }
    }
    for (const name of ['results', 'tmp']) for (const entry of entries(path.join(reset, name))) {
      const target = path.join(reset, name, entry);
      if (referenced.has(entry.replace(/\.json$/, ''))) continue;
      try {
        if (now() - fs.statSync(target).mtimeMs <= 3600000) continue;
        let value; try { value = read(target); } catch { /* Incomplete temporary files have no reference. */ }
        if (!referenced.has(value?.id)) fs.rmSync(target, { recursive: name === 'tmp', force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  function processStart(pid) {
    try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19]; }
    catch { return null; }
  }
  // Publish a populated directory: rename cannot replace a live, nonempty lock.
  // Reapers unlink only the dead owner's unique file; rmdir cannot remove a new owner.
  function lock(slug) {
    const target = path.join(reset, 'locks', slug);
    try {
      const names = fs.readdirSync(target);
      let cleared = false;
      for (const name of names) {
        const match = /^(\d+)-(\d+|unknown)-[0-9a-f]{32}$/.exec(name);
        const pid = Number(match?.[1]);
        if (!match || !Number.isSafeInteger(pid) || pid <= 0) {
          const entry = path.join(target, name);
          try {
            if (now() - fs.lstatSync(entry).mtimeMs <= Math.max(options.claimTimeoutMs, 600000)) return null;
            fs.rmSync(entry, { recursive: true });
            if (!cleared) { audit(slug, '', 'lock-cleared'); cleared = true; }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
        let alive = true;
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === 'ESRCH') alive = false; }
        const started = processStart(pid);
        if (alive && (!started || match[2] === 'unknown' || started === match[2])) return null;
        unlink(path.join(target, name));
      }
      try { fs.rmdirSync(target); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const token = crypto.randomBytes(16).toString('hex'), temp = path.join(reset, 'tmp', token);
    const owner = `${process.pid}-${processStart(process.pid) || 'unknown'}-${token}`;
    directory(temp);
    try {
      fs.writeFileSync(path.join(temp, owner), '', { mode: 0o600, flag: 'wx' });
      const parent = fs.statSync(reset), stat = fs.statSync(path.join(temp, owner));
      if (parent.uid !== stat.uid || parent.gid !== stat.gid) fs.chownSync(path.join(temp, owner), parent.uid, parent.gid);
      fs.renameSync(temp, target);
      return () => {
        unlink(path.join(target, owner));
        try { fs.rmdirSync(target); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      };
    } catch (error) { if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return null; throw error; }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  function done(slug, id) {
    const last = read(file('last', slug));
    return (last?.id === id && last.status === 'done') || day(slug).completed.includes(id);
  }
  function removeActive(slug, id) {
    if (read(activeFile(slug))?.id === id) unlink(activeFile(slug));
  }
  function finish(slug, id, outcome, code, extra = {}) {
    audit(slug, id, outcome === 'done' ? 'ok' : 'failed', { code, ...extra });
    write(file('last', slug), { id, status: outcome, code, at: at() });
    unlink(stagedFile(slug, id)); unlink(file('results', id));
    removeActive(slug, id); unlink(file('progress', id));
  }
  async function install(slug, id, report) {
    let delay = options.retryDelayMs, progress;
    while (!closed) {
      let step = 'install';
      try {
        if (done(slug, id)) {
          const progress = read(file('progress', id));
          finish(slug, id, 'done', 'ok', typeof progress?.verified === 'boolean' ? { verified: progress.verified } : {}); return;
        }
        progress ||= read(file('progress', id)) || {};
        let key;
        try { key = readKey(stagedFile(slug, id)).trim(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; report('stuck', 'staged-missing'); await pause(delay); delay = Math.min(delay * 2, options.maxRetryDelayMs); continue; }
        if (!key) throw new Error('Empty staged key');
        if (typeof progress.verified !== 'boolean') {
          progress.verified = false;
          for (let i = 0; i < 3 && !closed; i++) {
            if (await verify(key)) { progress.verified = true; break; }
            if (i < 2) await pause(options.verifyDelayMs);
          }
          if (closed) return;
          write(file('progress', id), progress);
        }
        // Preserve the inode for read-only bind mounts; the container is restarted right after installation.
        if (!progress.installed || readKey(keyFile({ slug })) !== key) {
          const fd = fs.openSync(keyFile({ slug }), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
          try {
            const bytes = Buffer.from(key); let offset = 0;
            while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
            fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          if (readKey(keyFile({ slug })) !== key) throw new Error('Key verification failed');
          progress.installed = true; write(file('progress', id), progress);
        }
        key = undefined;
        step = 'rekey';
        if (!progress.rekeyed) { await runtime.rekey?.(slug); progress.rekeyed = true; write(file('progress', id), progress); }
        step = 'restart';
        if (!progress.restarted) {
          const state = await runtime.inspect(slug);
          if (state.exists && state.running) { await runtime.restart(slug); await restarted(slug); }
          progress.restarted = true; write(file('progress', id), progress);
        }
        step = 'record';
        const counts = day(slug);
        if (!counts.completed.includes(id)) { counts.completed.push(id); write(dayFile(slug), counts); }
        finish(slug, id, 'done', 'ok', { verified: progress.verified }); return;
      } catch (error) { report('retry', step, systemCodes.has(error.code) ? error.code : 'ERROR'); }
      await pause(delay); delay = Math.min(delay * 2, options.maxRetryDelayMs);
    }
  }
  async function run(slug) {
    const reports = new Map(); let id = '', outcome;
    const report = (result, step, code) => {
      const key = result + ':' + step, previous = reports.get(key);
      if (previous !== undefined && (result === 'stuck' || now() - previous < options.auditIntervalMs)) return;
      try { audit(slug, id, result, { step, ...(code ? { code } : {}) }); reports.set(key, now()); }
      catch { console.error('[my-key] UNAVAILABLE'); }
    };
    while (!closed && fs.existsSync(activeFile(slug))) {
      try {
        let active;
        try { active = read(activeFile(slug)); } catch { /* Invalid active records cannot be routed. */ }
        if (!active || !validId(active.id) || !Number.isFinite(Date.parse(active.at))) {
          audit(slug, '', 'failed', { code: 'invalid' }); unlink(activeFile(slug)); return;
        }
        id = active.id;
        const age = now() - Date.parse(active.at);
        const last = read(file('last', slug));
        if (!outcome && last?.id === id && last.status === 'failed' && (failures.has(last.code) || ['unavailable', 'invalid'].includes(last.code))) outcome = last.code;
        if (outcome) { finish(slug, id, 'failed', outcome); return; }
        const result = read(file('results', id));
        if (result?.id === id && result.slug === slug && Number.isFinite(Date.parse(result.at))) {
          if (result.ok === false && failures.has(result.code)) { outcome = result.code; finish(slug, id, 'failed', outcome); return; }
          if (result.ok === true && result.code === 'ok') { await install(slug, id, report); return; }
        }
        if (done(slug, id)) {
          const progress = read(file('progress', id));
          finish(slug, id, 'done', 'ok', typeof progress?.verified === 'boolean' ? { verified: progress.verified } : {}); return;
        }
        if (age >= options.claimTimeoutMs && unlinkRequest(id)) { outcome = 'unavailable'; finish(slug, id, 'failed', outcome); return; }
        const claimed = fs.existsSync(file('claimed', id));
        if (claimed && age >= options.brokerTimeoutMs) report('stuck', 'broker');
        if (age >= options.orphanAgeMs && !claimed && !fs.existsSync(file('requests', id))
          && !fs.existsSync(file('results', id)) && !fs.existsSync(stagedFile(slug, id))) {
          finish(slug, id, 'failed', 'invalid'); return;
        }
      } catch { report('retry', 'record', 'ERROR'); }
      await pause(options.pollIntervalMs);
    }
  }
  const unlinkRequest = id => unlink(file('requests', id));
  function drive(slug) {
    if (!runtime || !slugPattern.test(slug) || closed) return;
    const identity = activeFile(slug);
    if (drivers.has(identity)) return;
    drivers.add(identity);
    void (async () => {
      let release;
      try {
        while (!closed && fs.existsSync(identity)) {
          try {
            release = lock(slug);
            if (release) { await run(slug); break; }
          } catch { console.error('[my-key] UNAVAILABLE'); }
          await pause(options.pollIntervalMs);
        }
      } catch { console.error('[my-key] UNAVAILABLE'); }
      finally {
        try { release?.(); } catch { console.error('[my-key] UNAVAILABLE'); }
        drivers.delete(identity);
        if (!closed && fs.existsSync(identity)) drive(slug);
      }
    })();
  }
  if (runtime) {
    try {
      cleanup();
      for (const name of entries(path.join(reset, 'active'))) if (name.endsWith('.json')) drive(name.slice(0, -5));
    } catch { console.error('[my-key] UNAVAILABLE'); }
    void (async () => {
      while (!closed) {
        await pause(options.cleanupIntervalMs);
        if (closed) return;
        try {
          cleanup();
          for (const name of entries(path.join(reset, 'active'))) if (name.endsWith('.json')) drive(name.slice(0, -5));
        } catch { console.error('[my-key] UNAVAILABLE'); }
      }
    })();
  }
  return { enabled, summary, status, accept, close() {
    closed = true;
    for (const [timer, resolve] of pendingTimers) { cancel(timer); resolve(); }
    pendingTimers.clear();
  } };
}
