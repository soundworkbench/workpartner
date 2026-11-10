import { mappedItem, defaultDecision } from './adopt-mappings.mjs';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireValue as check } from './adopt-state.mjs';

// Serialized into the container. No credential/config file contents are opened.
// Command arguments are deliberately all hidden: unknown positional secrets are
// indistinguishable from ordinary arguments. Cron comparison uses a digest.
export function collectInventory() {
  const fs = require('node:fs'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const items = [], issues = [];
  const add = (kind, value) => items.push({ kind, ...value });
  const problem = category => { if (!issues.includes(category)) issues.push(category); };
  const stat = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code !== 'ENOENT') problem('metadata'); return null; } };
  const dirs = p => { try { return fs.readdirSync(p).sort(); } catch (e) { if (e.code !== 'ENOENT') problem('directory-list'); return []; } };
  const run = (exe, args, timeout = 10000) => execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 4 * 1024 * 1024 });
  const existsTool = tool => (process.env.PATH || '/usr/bin:/bin').split(':').some(p => stat(path.join(p, tool)));
  const digest = text => createHash('sha256').update(text).digest('hex');
  const hiddenCommand = command => {
    // Only display a conventional executable path/name, never assignments or shell text.
    const executable = command.trim().split(/\s+/)[0];
    return /^[a-zA-Z_/][a-zA-Z0-9_./-]*$/.test(executable) ? `${executable} [arguments redacted]` : '[command redacted]';
  };
  const cron = (source, user, text, system = false) => {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const environment = /^[A-Za-z_][A-Za-z_0-9]*\s*=/.test(line);
      const fields = line.split(/\s+/), count = line.startsWith('@') ? 1 : 5;
      const owner = system && !environment ? fields[count] : user;
      add('cron', { source, user: owner, fingerprint: digest(line),
        entry: environment ? `${line.split('=')[0].trim()}=[redacted]` : `${fields.slice(0, count).join(' ')} ${hiddenCommand(fields.slice(count + (system ? 1 : 0)).join(' '))}` });
    }
  };
  let users = [];
  try { users = fs.readFileSync('/etc/passwd', 'utf8').trim().split('\n').map(line => { const f = line.split(':'); return { user: f[0], uid: Number(f[2]), home: f[5] }; }); }
  catch { problem('users'); }
  const homes = new Set();
  function homeMetadata(user, home) {
    if (!path.isAbsolute(home || '') || homes.has(home)) return;
    homes.add(home);
    for (const name of ['.gitconfig', '.git-credentials', '.config/gh', '.ssh', '.netrc']) {
      const p = path.join(home, name), s = stat(p);
      add('dotfile', { user, path: p, exists: !!s, size: s?.size ?? 0 });
    }
  }
  const crontabTool = existsTool('crontab');
  for (const user of users) {
    if (crontabTool) {
      try { cron(`crontab:${user.user}`, user.user, run('crontab', ['-u', user.user, '-l'])); }
      catch (e) {
        // Only the documented empty-crontab response is absence; permission errors
        // and missing utilities must never look like an empty successful scan.
        if (!/no crontab for/i.test(String(e.stderr))) problem('user-crontab');
      }
    }
    if (user.uid >= 1000 || stat(user.home)?.isDirectory()) homeMetadata(user.user, user.home);
    for (const tool of ['tmux', 'screen']) {
      if (!existsTool(tool)) continue;
      try {
        const args = tool === 'tmux' ? ['list-sessions', '-F', '#S'] : ['-ls'];
        const output = process.getuid() === user.uid ? run(tool, args) : run('runuser', ['-u', user.user, '--', tool, ...args]);
        const names = tool === 'tmux' ? output.trim().split('\n').filter(Boolean) : [...output.matchAll(/^\s*\d+\.([^\s]+)\s+\(/gm)].map(m => m[1]);
        for (const name of names) add('session', { user: user.user, tool, name });
      } catch (e) {
        if (!/no server running|no sessions|No Sockets found|error connecting.*No such file/i.test(`${e.stdout || ''}${e.stderr || ''}`)) problem(`${tool}-sessions`);
      }
    }
  }
  // Runtime HOME may differ from passwd (the workspace commonly uses /data).
  for (const home of [process.env.HOME, '/data'].filter(p => path.isAbsolute(p || ''))) {
    const s = stat(home);
    if (s?.isDirectory()) homeMetadata(users.find(u => u.uid === s.uid)?.user ?? String(s.uid), home);
  }
  function cronFile(p, user, system) {
    const s = stat(p);
    if (!s) return;
    if (!s.isFile()) { problem('cron-nonregular-file'); return; }
    try {
      const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { cron(p, user, fs.readFileSync(fd, 'utf8'), system); } finally { fs.closeSync(fd); }
    } catch { problem('cron-read'); }
  }
  cronFile('/etc/crontab', 'root', true);
  for (const name of dirs('/etc/cron.d')) cronFile(`/etc/cron.d/${name}`, 'root', true);
  const spoolUsers = new Set();
  const spoolCron = (p, user) => {
    if (spoolUsers.has(user)) return;
    spoolUsers.add(user);
    cronFile(p, user, false);
  };
  if (!crontabTool) for (const name of dirs('/var/spool/cron')) {
    const p = `/var/spool/cron/${name}`;
    if (name === 'crontabs' && stat(p)?.isDirectory()) {
      for (const user of dirs(p)) spoolCron(`${p}/${user}`, user);
    } else spoolCron(p, name);
  }
  for (const root of ['/srv', '/opt']) for (const name of dirs(root)) {
    const p = `${root}/${name}`, s = stat(p);
    if (!s?.isDirectory()) continue;
    let sizeKiB = null;
    try { sizeKiB = Number(run('du', ['-sk', '--', p], 60000).split(/\s+/)[0]); } catch { problem('directory-size'); }
    add('directory', { path: p, name, sizeKiB, uid: s.uid, gid: s.gid, owner: users.find(u => u.uid === s.uid)?.user ?? String(s.uid) });
  }
  for (const pid of dirs('/proc').filter(p => /^\d+$/.test(p) && Number(p) !== process.pid)) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      for (let i = 1; i < argv.length; i++) {
        const config = argv[i] === '--config' || argv[i] === '-c' ? argv[i + 1] : argv[i].startsWith('--config=') ? argv[i].slice(9) : null;
        if (config && path.isAbsolute(config) && /\.(?:toml|json|ya?ml|ini|conf)$/i.test(config) && stat(config)?.isFile()) add('bot-config', { path: config });
      }
      if (argv.length) add('process', { pid: Number(pid), command: hiddenCommand(argv[0]), executable: /^[\w/.-]+$/.test(argv[0]) ? argv[0] : '[redacted]',
        ...(path.basename(argv[0]) === 'claude' ? { interactive: !argv.slice(1).some(arg => arg === '-p' || arg === '--print' || arg.startsWith('--print=')) } : {}),
      });
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) problem('process-list'); }
  }
  for (const protocol of ['tcp', 'tcp6', 'udp', 'udp6']) {
    try {
      for (const line of fs.readFileSync(`/proc/net/${protocol}`, 'utf8').trim().split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[3] !== (protocol.startsWith('tcp') ? '0A' : '07')) continue;
        add('port', { protocol, port: parseInt(fields[1].split(':')[1], 16) });
      }
    } catch (e) { if (e.code !== 'ENOENT') problem('listening-ports'); }
  }
  // Discover common bridge/bot config names, without opening them or traversing
  // credential directories, symlinks, dependency trees or other virtual filesystems.
  const roots = [...new Set(['/data', '/srv', '/opt', ...users.filter(u => u.uid >= 1000).map(u => u.home).filter(p => path.isAbsolute(p || '') && p !== '/')])];
  const seen = new Set();
  function walk(p, depth) {
    if (depth > 4 || ['/data/old-work', '/proc', '/sys', '/dev'].some(root => p === root || p.startsWith(`${root}/`)) || seen.has(p)) return;
    seen.add(p);
    const s = stat(p);
    if (!s || s.isSymbolicLink()) return;
    if (s.isFile()) {
      if (/(?:^|\/)(?:\.cc-connect|\.openclaw|\.aionui|bots?|robots?)(?:\/|$)/i.test(p) && /\.(?:toml|json|ya?ml|ini|conf)$/i.test(p)
          || /(?:^|\/)(?:bot|robot|cc-connect|openclaw)[-.]?config\.(?:toml|json|ya?ml|ini|conf)$/i.test(p)) add('bot-config', { path: p });
      return;
    }
    if (!s.isDirectory() || depth === 4) return;
    for (const name of dirs(p)) {
      if (['.ssh', '.git', 'gh', '.cache', 'node_modules', '.git-credentials', '.netrc', '.gitconfig'].includes(name)) continue;
      walk(path.join(p, name), depth + 1);
    }
  }
  for (const root of roots) walk(root, 0);
  return { items, issues };
}

export const inventoryProbe = ['node', '-e', `process.stdout.write(JSON.stringify((${collectInventory.toString()})()))`];

export function parseInventoryProbe(result) {
  check(result?.exitCode === 0, 'Inventory probe failed; no complete inventory available');
  let value;
  try { value = JSON.parse(result.stdout); } catch { check(false, 'Invalid inventory probe response'); }
  check(Array.isArray(value?.items) && Array.isArray(value?.issues), 'Invalid inventory probe response');
  return value;
}

export const inventoryPaths = (ownersFile, slug) => {
  const directory = `${ownersFile}.adopt`;
  return { directory, inventory: path.join(directory, `${slug}.inventory.json`), text: path.join(directory, `${slug}.inventory.txt`), decisions: path.join(directory, `${slug}.decisions.json`) };
};

export function inventoryDocument(slug, items, issues = []) {
  const unique = new Map(items.map(item => [JSON.stringify(item), item]));
  return { version: 1, slug, inventoryId: randomUUID(), generatedAt: new Date().toISOString(), issues,
    items: [...unique.values()].map(item => ({ id: createHash('sha256').update(JSON.stringify(item)).digest('hex'), ...item })) };
}

export async function prepareInventoryDirectory(files) {
  await fs.mkdir(files.directory, { recursive: true, mode: 0o700 });
  const directory = await fs.open(files.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { await directory.chmod(0o700); }
  finally { await directory.close(); }
}

async function writeReport(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(contents);
      await file.chmod(0o600);
      await file.sync();
    } finally { await file.close(); }
    // Replace the directory entry itself, never follow an existing report symlink.
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function saveInventory(files, inventory) {
  await prepareInventoryDirectory(files);
  // Publish the inventory first. Any interrupted write leaves a missing, invalid,
  // or older checklist, and therefore cannot unlock switch.
  await writeReport(files.inventory, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeReport(files.text, `Inventory ${inventory.slug} ${inventory.inventoryId}\n${inventory.items.map(item => `[${item.kind}] ${item.path || item.source || item.executable || item.name || `${item.protocol}:${item.port}`}\n  id: ${item.id}\n  ${Object.entries(item).filter(([key]) => !['id', 'kind', 'path', 'source'].includes(key)).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('; ')}`).join('\n')}\nIssues: ${inventory.issues.join(', ') || 'none'}\n`);
  await writeReport(files.decisions, `${JSON.stringify({ version: 1, slug: inventory.slug, inventoryId: inventory.inventoryId,
    issues: inventory.issues.map(issue => ({ issue, acknowledged: false, reason: '' })),
    items: inventory.items.map(item => ({ id: item.id, kind: item.kind, source: item, ...defaultDecision(item) })) }, null, 2)}\n`);
}

export async function readDecisions(files, slug, { allowMissing = false } = {}) {
  const message = 'Complete the latest inventory decision table first (carried + method, or dropped + reason); rerun inventory --apply if missing, stale or incomplete';
  try {
    // Only an absent table is optional. A dangling symlink or missing inventory
    // behind an existing table is still an invalid checklist.
    try { await fs.lstat(files.decisions); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
    const inventory = JSON.parse(await fs.readFile(files.inventory, 'utf8'));
    const table = JSON.parse(await fs.readFile(files.decisions, 'utf8'));
    const [a, b] = await Promise.all([fs.stat(files.inventory), fs.stat(files.decisions)]);
    check(inventory.version === 1 && table.version === 1 && inventory.slug === slug && table.slug === slug
      && typeof inventory.inventoryId === 'string' && inventory.inventoryId === table.inventoryId && b.mtimeMs >= a.mtimeMs
      && Array.isArray(inventory.issues) && Array.isArray(inventory.items) && inventory.items.length > 0
      && Array.isArray(table.items) && inventory.items.length === table.items.length, message);
    const acknowledgments = table.issues ?? [];
    check(Array.isArray(acknowledgments) && acknowledgments.length === inventory.issues.length, message);
    const acknowledged = new Set();
    for (const row of acknowledgments) {
      check(inventory.issues.includes(row.issue) && !acknowledged.has(row.issue)
        && row.acknowledged === true && typeof row.reason === 'string' && row.reason.trim(), message);
      acknowledged.add(row.issue);
    }
    const ids = new Set();
    for (const item of table.items) {
      const source = inventory.items.find(source => source.id === item.id);
      check(source && !ids.has(item.id), message); ids.add(item.id);
      check(item.decision === 'carried' && typeof item.method === 'string' && item.method.trim()
        || item.decision === 'dropped' && typeof item.reason === 'string' && item.reason.trim(), message);
      check(item.target && typeof item.target === 'object' && !Array.isArray(item.target), message);
      // Source fields in the editable table are explanatory only, never authoritative.
      item.source = source;
      for (const key of Object.keys(item.target)) check(['path', 'user', 'port', 'protocol', 'fingerprint', 'executable', 'name'].includes(key), message);
      if (item.target.path !== undefined) check(typeof item.target.path === 'string' && path.posix.isAbsolute(item.target.path) && !item.target.path.includes('\0'), message);
    }
    return table;
  } catch { check(false, message); }
}

// Runs only the requested checks in the Pod, so unrelated root-only paths do
// not make an ordinary user's verification fail. Arguments are data, not shell.
export function verifyInventory(rows) {
  const fs = require('node:fs'), { execFileSync } = require('node:child_process');
  const { createHash } = require('node:crypto');
  const alarms = [];
  for (const row of rows) {
    const item = row;
    let matched = false;
    try {
      switch (item.kind) {
        case 'directory': matched = fs.statSync(item.path).isDirectory(); break;
        case 'dotfile': {
          try { fs.statSync(item.path); matched = item.exists; }
          catch (e) { if (e.code === 'ENOENT') matched = !item.exists; else throw e; }
          break;
        }
        case 'bot-config': matched = fs.statSync(item.path).isFile(); break;
        case 'docker-diff': {
          const p = item.path;
          try { fs.statSync(p); matched = item.change !== 'D'; }
          catch (e) { if (e.code === 'ENOENT') matched = item.change === 'D'; else throw e; }
          break;
        }
        case 'cron': {
          let text;
          if (!item.source.startsWith('crontab:')) {
            const p = item.source;
            // Never turn an editable target into an arbitrary file-content read.
            if (!/^\/(?:etc\/(?:crontab|cron\.d\/[^/.][^/]*)|var\/spool\/cron\/(?:crontabs\/)?[^/.][^/]*)$/.test(p)) break;
            const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try { if (!fs.fstatSync(fd).isFile()) break; text = fs.readFileSync(fd, 'utf8'); }
            finally { fs.closeSync(fd); }
          } else {
            const account = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':')).find(fields => fields[0] === item.user);
            const args = account && Number(account[2]) === process.getuid() ? ['-l'] : ['-u', item.user, '-l'];
            text = execFileSync('crontab', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
          }
          matched = text.split('\n').some(line => createHash('sha256').update(line.trim()).digest('hex') === item.fingerprint);
          break;
        }
        case 'port': {
          if (!['tcp', 'tcp6', 'udp', 'udp6'].includes(item.protocol)) break;
          matched = fs.readFileSync(`/proc/net/${item.protocol}`, 'utf8').trim().split('\n').slice(1).some(line => {
            const fields = line.trim().split(/\s+/);
            return fields[3] === (item.protocol.startsWith('tcp') ? '0A' : '07') && parseInt(fields[1].split(':')[1], 16) === item.port;
          });
          break;
        }
        case 'process': {
          matched = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).some(pid => {
            try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] === item.executable; }
            catch { return false; }
          });
          break;
        }
        case 'session': {
          const args = item.tool === 'tmux' ? ['list-sessions', '-F', '#S'] : ['-ls'];
          const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(line => line.split(':'));
          const uid = Number(passwd.find(user => user[0] === item.user)?.[2]);
          const output = execFileSync(process.getuid() === uid ? item.tool : 'runuser', process.getuid() === uid ? args : ['-u', item.user, '--', item.tool, ...args],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
          matched = item.tool === 'tmux' ? output.trim().split('\n').includes(item.name)
            : [...output.matchAll(/^\s*\d+\.([^\s]+)\s+\(/gm)].some(m => m[1] === item.name);
          break;
        }
      }
    } catch { /* Missing/inaccessible sources are alarms, never success. */ }
    if (!matched) alarms.push({ id: row.id, kind: item.kind, alarm: 'carried-item-missing-or-mismatched' });
  }
  return alarms;
}

// Keep explanatory metadata and operator notes out of process arguments and stdin.
export function verificationRows(rows) {
  const fields = {
    directory: ['path'], dotfile: ['path', 'exists'], 'bot-config': ['path'],
    'docker-diff': ['path', 'change'], cron: ['source', 'user', 'fingerprint'],
    port: ['protocol', 'port'], process: ['executable'], session: ['tool', 'user', 'name'],
  };
  return rows.map(row => {
    const item = { ...mappedItem(row.source), ...row.target };
    if (item.kind === 'cron') item.source = row.target.path || item.source;
    if (item.kind === 'docker-diff') item.path = row.target.path || (item.action === 'copy' ? `/data/.zp-init.d/bin/${item.path.split('/').pop()}` : item.path);
    return { id: row.id, kind: item.kind, ...Object.fromEntries((fields[item.kind] || []).map(key => [key, item[key]])) };
  });
}

export const verificationProbe = ['node', '-e', `process.stdout.write(JSON.stringify((${verifyInventory.toString()})(JSON.parse(require('node:fs').readFileSync(0, 'utf8')))))`];
