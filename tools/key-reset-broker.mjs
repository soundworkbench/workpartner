import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BOOTSTRAP = `python3 -I -c 'import sys,json;d=json.load(sys.stdin);exec(compile(d["source"],"helper","exec"),{"REQUEST":d})'`;
const sources = Object.fromEntries(['gateway-host', 'key-store'].map(name =>
  [name, fs.readFileSync(new URL(`./key-reset/${name}.py`, import.meta.url), 'utf8')]));
const ID = /^[0-9a-f]{32}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HASH = /^[0-9a-f]{64}$/;
const DAY = 86400000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = (pattern, value) => typeof value === 'string' && value === value.trim() && pattern.test(value);
const error = code => Object.assign(new Error(code), { code });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const iso = time => new Date(time).toISOString();
const dateOf = time => iso(time).slice(0, 10);

export function validateConfig(input) {
  const bad = field => { throw error(`config.${field}`); };
  if (!object(input)) bad('root');
  const config = structuredClone(input);
  const absolute = (value, field) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')
      || value.split('/').some(part => part === '..' || part === '.')) bad(field);
  };
  const argv = (value, field) => {
    if (!Array.isArray(value) || !value.length || value.length > 128
      || value.some(v => typeof v !== 'string' || !v.trim() || v.includes('\0') || v.length > 8192)) bad(field);
  };
  for (const host of ['gatewayHost', 'keyStore']) {
    if (!object(config[host])) bad(host);
    argv(config[host].command, `${host}.command`);
  }
  for (const field of ['organizationFile', 'usersFile', 'stateDirectory', 'secureDirectory'])
    absolute(config.gatewayHost[field], `gatewayHost.${field}`);
  absolute(config.keyStore.file, 'keyStore.file');
  argv(config.keyStore.rotate, 'keyStore.rotate');
  if (config.keyStore.rotate.reduce((n, v) => n + v.split('{id}').length - 1, 0) !== 1) bad('keyStore.rotate');
  absolute(config.stateDirectory, 'stateDirectory');
  for (const [field, fallback, min, max] of [['pollSeconds', 5, 1, 30], ['dailyLimit', 3, 1, 3], ['windowSeconds', 120, 1, 3600]]) {
    if (config[field] === undefined) config[field] = fallback;
    if (!Number.isInteger(config[field]) || config[field] < min || config[field] > max) bad(field);
  }
  if (config.newKeyPrefix === undefined) config.newKeyPrefix = 'sk-wp-';
  if (!valid(/^[A-Za-z0-9_-]{1,64}$/, config.newKeyPrefix)) bad('newKeyPrefix');
  return config;
}

export function loadConfig(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw error('config.permissions');
    if (info.size > 65536) throw error('config.size');
    let data;
    try { data = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { throw error('config.json'); }
    return validateConfig(data);
  } catch (failure) {
    if (failure.code?.startsWith('config.')) throw failure;
    throw error('config.file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function runHelper({ command, source, op, args, timeoutMs = op === 'rotate' ? 90000 : 30000 }) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const finish = (code, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      if (code) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child?.kill('SIGKILL'); }
        reject(error(code));
      } else resolve(value);
    };
    try {
      child = spawn(command[0], [...command.slice(1), BOOTSTRAP], {
        shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      timer = setTimeout(() => finish('transport-timeout'), timeoutMs);
      child.on('error', () => finish('transport-failed'));
      child.stdin.on('error', () => finish('transport-failed'));
      child.stderr.on('data', () => {});
      child.stdout.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (size > 256 * 1024) finish('transport-size');
        else chunks.push(chunk);
      });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) return finish('transport-failed');
        try {
          const line = Buffer.concat(chunks).toString('utf8');
          if (!/^[^\r\n]+\n$/.test(line)) throw error('transport-json');
          const value = JSON.parse(line);
          if (!object(value) || value.error) throw error('transport-json');
          finish(null, value);
        } catch { finish('transport-json'); }
      });
      child.stdin.end(JSON.stringify({ source, op, args }));
    } catch { finish('transport-failed'); }
  });
}

function privateDirectory(directory) {
  const parent = path.dirname(directory);
  if (parent !== directory) {
    if (!fs.existsSync(parent)) privateDirectory(parent);
    else {
      let current = parent;
      while (true) {
        if (!fs.lstatSync(current).isDirectory()) throw error('state-directory');
        if (path.dirname(current) === current) break;
        current = path.dirname(current);
      }
    }
  }
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
  if (!fs.lstatSync(directory).isDirectory()) throw error('state-directory');
  fs.chmodSync(directory, 0o700);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readState(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw error('state-file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (failure) {
    if (failure.code === 'ENOENT') return null;
    throw error('state-file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function saveState(filename, data) {
  const temporary = `${filename}.${crypto.randomBytes(16).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  fs.renameSync(temporary, filename);
  syncDirectory(path.dirname(filename));
}

export function createBroker(input, { now = Date.now, randomBytes = crypto.randomBytes, run = runHelper,
  log = line => process.stderr.write(line + '\n') } = {}) {
  const config = validateConfig(input), root = config.stateDirectory;
  const pending = new Map(), stuck = new Map(), unresolved = new Map();
  let lock, running = false, stopping = false, lastPing = -Infinity, lastAnswer = -Infinity;
  const local = (kind, name) => path.join(root, kind, name);
  const say = code => log(`[key-reset] ${code}`);
  const healthy = () => now() >= lastAnswer && now() - lastAnswer < 60000;
  const call = async (host, op, args = {}) => {
    const settings = host === 'gateway-host' ? config.gatewayHost : config.keyStore;
    try {
      const value = await run({ command: settings.command, source: sources[host], op,
        args: host === 'gateway-host' ? { organizationFile: settings.organizationFile, usersFile: settings.usersFile,
          stateDirectory: settings.stateDirectory, secureDirectory: settings.secureDirectory, ...args }
          : { file: settings.file, ...args }, timeoutMs: op === 'rotate' ? 90000 : 30000 });
      if (!object(value) || value.error) throw error('helper-failed');
      return value;
    } catch { throw error('helper-failed'); }
  };
  function start() {
    if (lock) return;
    try {
      privateDirectory(root);
      for (const name of ['seen', 'days', 'inflight']) privateDirectory(path.join(root, name));
      const filename = path.join(root, 'broker.pid');
      try {
        const info = fs.lstatSync(filename);
        const pid = readState(filename);
        if (!Number.isInteger(pid) || pid < 1) throw error('broker-running');
        try { process.kill(pid, 0); throw error('broker-running'); }
        catch (failure) { if (failure.code !== 'ESRCH') throw error('broker-running'); }
        const current = fs.lstatSync(filename);
        if (current.ino !== info.ino || current.dev !== info.dev) throw error('broker-running');
        fs.unlinkSync(filename);
      } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      const fd = fs.openSync(filename, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${process.pid}\n`); fs.fsyncSync(fd);
        lock = fs.fstatSync(fd);
      } finally { fs.closeSync(fd); }
      syncDirectory(root);
    } catch (failure) { throw error(failure.code === 'broker-running' || failure.code === 'EEXIST' ? 'broker-running' : 'state-failed'); }
  }
  function close() {
    if (running) throw error('broker-busy');
    if (!lock) return;
    try {
      const filename = path.join(root, 'broker.pid'), info = fs.lstatSync(filename);
      if (info.ino === lock.ino && info.dev === lock.dev) { fs.unlinkSync(filename); syncDirectory(root); }
    } catch (failure) { if (failure.code !== 'ENOENT') throw error('state-failed'); }
    finally { lock = undefined; }
  }
  function day(date) {
    const value = readState(local('days', `${date}.json`)) ?? {};
    if (!object(value) || Object.entries(value).some(([slug, entry]) => !valid(SLUG, slug) || !object(entry)
      || !Number.isInteger(entry.started) || entry.started < 0 || !Array.isArray(entry.done)
      || entry.done.some(id => !valid(ID, id)))) throw error('state-day');
    return value;
  }
  const counter = (data, slug) => Object.hasOwn(data, slug) ? data[slug] : (data[slug] = { started: 0, done: [] });
  function count(row, field) {
    const date = dateOf(Date.parse(row.at)), data = day(date), entry = counter(data, row.slug);
    if (field === 'started') entry.started++;
    else if (!entry.done.includes(row.id)) entry.done.push(row.id);
    saveState(local('days', `${date}.json`), data);
  }
  function audit(row, result, code, extra = {}) {
    const filename = path.join(root, 'audit.log');
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw error('state-audit');
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ at: iso(now()), slug: row.slug, id: row.id, action: 'reset', result, code, ...extra }) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  function markStuck(row, step) {
    if (!stuck.has(row.id) || now() - stuck.get(row.id) >= 600000) {
      audit(row, 'stuck', 'unknown', { step }); stuck.set(row.id, now()); say(`${step} stuck`);
    }
  }
  async function deliver(attempt) {
    const { row, ok, code } = attempt;
    try {
      const response = await call('gateway-host', 'finish', { id: row.id, slug: row.slug, ok, code });
      if (response.done !== true) throw error('finish-failed');
      fs.rmSync(local('inflight', `${row.id}.json`), { force: true });
      syncDirectory(path.join(root, 'inflight'));
      pending.delete(row.id); stuck.delete(row.id);
    } catch { say('finish-failed'); }
  }
  async function complete(row, ok, code, result = ok ? 'ok' : 'failed', extra = {}) {
    // Keep the decision even if a local write fails; never turn a known success into failure.
    const attempt = { row, ok, code, result, extra, recorded: false };
    unresolved.delete(row.id);
    pending.set(row.id, attempt);
    await recordAndDeliver(attempt);
  }
  async function recordAndDeliver(attempt) {
    if (!attempt.recorded) {
      if (attempt.ok) count(attempt.row, 'done');
      audit(attempt.row, attempt.result, attempt.code, attempt.extra);
      attempt.recorded = true;
      say(`rotate ${attempt.ok ? 'ok' : attempt.code}`);
    }
    await deliver(attempt);
  }
  async function which(hashes) {
    const response = await call('key-store', 'which', { hashes });
    if (!Array.isArray(response.present) || response.present.length !== hashes.length
      || response.present.some(value => typeof value !== 'boolean')) throw error('which-failed');
    return response.present;
  }
  async function decide(row, step) {
    let present;
    try { present = await which([row.current, row.next]); }
    catch { markStuck(row, step); return; }
    if (present[1]) await complete(row, true, 'ok', step === 'resume' ? 'resumed' : 'ok');
    else if (present[0]) await complete(row, false, step === 'resume' ? 'interrupted' : 'rotate-failed');
    else markStuck(row, step);
  }
  function inflight(id) {
    const row = readState(local('inflight', `${id}.json`));
    if (row !== null && (!object(row) || row.id !== id || !valid(SLUG, row.slug) || !valid(HASH, row.current)
      || !valid(HASH, row.next) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)))) throw error('state-inflight');
    return row;
  }
  async function resume(claimed) {
    const row = inflight(claimed.id);
    if (row) {
      if (row.slug !== claimed.slug) throw error('state-inflight');
      await decide(row, 'resume');
      return;
    }
    let inspected, present = false;
    try {
      inspected = await call('gateway-host', 'inspect', claimed);
      if (inspected.next !== null) {
        if (!valid(HASH, inspected.next)) throw error('inspect-failed');
        [present] = await which([inspected.next]);
      }
    } catch { markStuck(claimed, 'resume'); return; }
    const recovered = { id: claimed.id, slug: claimed.slug, at: iso(now()) };
    await complete(recovered, present, present ? 'ok' : 'interrupted', present ? 'resumed' : 'failed');
  }
  async function refuse(row, code) {
    const claimed = await call('gateway-host', 'claim', { id: row.id, slug: row.slug, stage: false });
    if (claimed.claimed === true) await complete(row, false, code, 'refused');
  }
  async function handle(request, hostNow) {
    // Unavailable stores leave requests entirely untouched, including the replay guard.
    if (!healthy()) return;
    try {
      fs.writeFileSync(local('seen', request.id), '', { flag: 'wx', mode: 0o600, flush: true });
      fs.utimesSync(local('seen', request.id), new Date(now()), new Date(now()));
      syncDirectory(path.join(root, 'seen'));
    } catch (failure) {
      if (failure.code === 'EEXIST') { await refuse(request, 'replay'); return; }
      throw error('state-seen');
    }
    if (typeof request.at !== 'string' || !Number.isFinite(Date.parse(request.at))
      || Math.abs(Date.parse(request.at) - hostNow) > config.windowSeconds * 1000) return refuse(request, 'stale');
    if (request.allowed !== true) return refuse(request, 'denied');
    const data = day(dateOf(now())), entry = counter(data, request.slug);
    if (entry.done.length >= config.dailyLimit || entry.started >= 2 * config.dailyLimit) return refuse(request, 'limit');
    let value = config.newKeyPrefix + randomBytes(42).toString('base64url');
    let claim;
    try { claim = await call('gateway-host', 'claim', { id: request.id, slug: request.slug, stage: true, next: value }); }
    catch { value = undefined; say('claim-failed'); return; }
    if (claim.claimed !== true) { value = undefined; return; }
    if (claim.allowed !== true) { value = undefined; return complete(request, false, 'denied', 'refused'); }
    if (claim.key !== true || !valid(HASH, claim.current)) { value = undefined; return complete(request, false, 'no-key'); }
    const row = { id: request.id, slug: request.slug, at: iso(now()), current: claim.current, next: digest(value) };
    let rotated;
    try {
      // This exclusive file is flushed before any rotation; hashes never enter temporary files.
      fs.writeFileSync(local('inflight', `${row.id}.json`), JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      syncDirectory(path.join(root, 'inflight'));
      count(row, 'started');
      try { rotated = await call('key-store', 'rotate', { current: row.current, next: value, rotate: config.keyStore.rotate }); }
      catch { rotated = { ok: false, code: 'unknown' }; }
    } finally { value = undefined; }
    if (rotated.ok === true) {
      const extra = {};
      if (Array.isArray(rotated.drift) && rotated.drift.length) extra.drift = rotated.drift.filter(v =>
        typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v) && !['secret', 'masked'].includes(v));
      if (rotated.entries === false) extra.entries = false;
      await complete(row, true, 'ok', 'ok', extra);
    } else if (rotated.ok === false && ['no-key', 'rotate-failed'].includes(rotated.code)) {
      await complete(row, false, rotated.code);
    } else {
      unresolved.set(row.id, row);
      await decide(row, 'rotate');
    }
  }
  function prune() {
    for (const name of fs.readdirSync(path.join(root, 'seen'))) {
      if (!valid(ID, name)) continue;
      const filename = local('seen', name);
      if (now() - fs.lstatSync(filename).mtimeMs > 2 * DAY
        && !pending.has(name) && !fs.existsSync(local('inflight', `${name}.json`))) fs.unlinkSync(filename);
    }
    for (const name of fs.readdirSync(path.join(root, 'days'))) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && Date.parse(name.slice(0, 10)) <= Date.parse(dateOf(now())) - 7 * DAY)
        fs.unlinkSync(local('days', name));
    }
  }
  async function cycle() {
    if (running) throw error('broker-busy');
    start(); running = true;
    try {
      if (now() - lastPing >= 30000 || now() < lastPing) {
        lastPing = now();
        try { if ((await call('key-store', 'ping')).ok === true) lastAnswer = now(); }
        catch { say('ping-failed'); }
      }
      let poll;
      try {
        poll = await call('gateway-host', 'poll', { heartbeat: healthy() });
        if (poll.ready === false) return;
        if (poll.ready !== true || !Number.isFinite(Date.parse(poll.now)) || !Array.isArray(poll.requests)
          || !Array.isArray(poll.claimed)) throw error('poll-failed');
      } catch { say('poll-failed'); return; }
      const handled = new Set(pending.keys());
      for (const attempt of [...pending.values()]) {
        if (stopping) break;
        await recordAndDeliver(attempt);
      }
      const rows = value => value.filter(row => object(row) && valid(ID, row.id) && valid(SLUG, row.slug)).slice(0, 50);
      for (const row of rows(poll.claimed)) {
        if (stopping) break;
        if (handled.has(row.id)) continue;
        handled.add(row.id);
        try {
          if (unresolved.has(row.id)) await decide(unresolved.get(row.id), 'rotate');
          else await resume(row);
        } catch { say('resume-failed'); }
      }
      // A lost finish reply can leave local inflight state after the gateway removed the claim.
      for (const name of fs.readdirSync(path.join(root, 'inflight'))) {
        if (stopping) break;
        const id = name.slice(0, -5);
        if (!name.endsWith('.json') || !valid(ID, id) || handled.has(id)) continue;
        handled.add(id);
        try { await resume(inflight(id)); } catch { say('resume-failed'); }
      }
      const busySlugs = new Set([...pending.values()].map(attempt => attempt.row.slug));
      for (const row of rows(poll.claimed)) if (stuck.has(row.id)) busySlugs.add(row.slug);
      for (const name of fs.readdirSync(path.join(root, 'inflight'))) {
        if (/^[0-9a-f]{32}\.json$/.test(name)) busySlugs.add(inflight(name.slice(0, -5)).slug);
      }
      for (const row of rows(poll.requests).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        if (stopping) break;
        if (handled.has(row.id) || busySlugs.has(row.slug)) continue;
        try { await handle(row, Date.parse(poll.now)); } catch { say('request-failed'); }
        if (pending.has(row.id) || fs.existsSync(local('inflight', `${row.id}.json`))) busySlugs.add(row.slug);
      }
      prune();
    } catch { throw error('state-failed'); }
    finally { running = false; }
  }
  async function check() {
    try {
      if ((await call('key-store', 'ping')).ok !== true) throw error('check-store');
      const poll = await call('gateway-host', 'poll', { heartbeat: false });
      if (poll.ready !== true) throw error('check-gateway');
      return true;
    } catch { throw error('check-failed'); }
  }
  return { start, cycle, close, check, stop: () => { stopping = true; } };
}

export async function main(argv = process.argv.slice(2)) {
  let broker, wake;
  let stopping = false;
  const stop = () => { stopping = true; broker?.stop(); wake?.(); };
  try {
    let filename, once = false, check = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--config' && !filename && argv[index + 1] && !argv[index + 1].startsWith('--')) filename = argv[++index];
      else if (argv[index] === '--once' && !once) once = true;
      else if (argv[index] === '--check' && !check) check = true;
      else throw error('arguments');
    }
    if (!filename || (once && check)) throw error('arguments');
    const config = loadConfig(filename);
    broker = createBroker(config);
    if (check) { await broker.check(); process.stdout.write('ok\n'); return 0; }
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    do {
      await broker.cycle();
      if (once || stopping) break;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, config.pollSeconds * 1000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    } while (!stopping);
    return 0;
  } catch (failure) {
    const code = typeof failure.code === 'string' && /^(?:config\.[A-Za-z.]+|arguments|broker-running|state-failed|check-failed)$/.test(failure.code)
      ? failure.code : 'broker-failed';
    if (argv.includes('--check')) process.stdout.write(code + '\n');
    else process.stderr.write(`[key-reset] ${code}\n`);
    return 1;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    try { broker?.close(); } catch { process.stderr.write('[key-reset] close-failed\n'); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
