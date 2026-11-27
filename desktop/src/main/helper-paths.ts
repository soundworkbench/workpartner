import { closeSync, constants, fstatSync, openSync, lstatSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { holdHandle } from './helper-handles.js';
import { fail } from './helper-errors.js';
import { checkWindowsAttributes, pinWindowsPath } from './helper-windows.js';

export type CheckedPath = {
  path: string; name: string; stat: BigIntStats; sourceStat: BigIntStats; verify(opened?: BigIntStats): void;
};
export type RootGrant = { path: string; dev: string; ino: string };
function inspect(path: string) {
  const stat = lstatSync(path, { bigint: true });
  checkWindowsAttributes(path);
  if (!stat.ino) fail('PATH_NOT_ALLOWED');
  return stat;
}
function same(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && (left.mode & BigInt(constants.S_IFMT)) === (right.mode & BigInt(constants.S_IFMT));
}

const windows = process.platform === 'win32';
const real = realpathSync.native;
export function contains(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function absolute(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 1024 || input.includes('\0') ||
      !path.isAbsolute(input) || /^[/\\]{2}/.test(input)) fail('INVALID_PARAMS');
  const parts = input.split(windows ? /[/\\]/ : '/');
  if (parts.includes('..')) fail('PATH_NOT_ALLOWED');
  if (windows && (!/^[a-z]:[/\\]/i.test(input) || /[:<>|"*?]/.test(input.slice(2)) ||
      parts.some(s => s !== '.' && (/[ .]$/.test(s) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))))) {
    fail('INVALID_PARAMS');
  }
  return path.normalize(input);
}

const protectedSegment = /^(?:\.ssh|\.aws|\.gnupg|\.kube|\.git-credentials|\.npmrc|\.pypirc|\.netrc|\.env.*|.*\.(?:pem|key|p12|pfx|jks|kdbx))$/is;
export class PathPolicy {
  private protectedDirs: string[];
  readonly grants: readonly RootGrant[];
  constructor(grants: readonly RootGrant[], userData: string) {
    // An explicit nested grant has its own pinned identity.
    this.grants = [...grants].sort((a, b) => b.path.length - a.path.length);
    const home = homedir();
    const systemDrive = process.env.SystemDrive || 'C:';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData/Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData/Roaming');
    const protectedDirs = windows ? [
      ...['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'].map(s => path.join(systemDrive + '\\', s)),
      ...['Google/Chrome/User Data', 'Microsoft/Edge/User Data', 'BraveSoftware/Brave-Browser/User Data'].map(s => path.join(local, s)),
      path.join(roaming, 'Mozilla/Firefox')
    ] : ['/System', '/Library', '/etc', '/private/etc', '/private/var', '/proc', '/sys', '/dev',
      ...['Library/Keychains', 'Library/Cookies', 'Library/Safari', 'Library/Containers/com.apple.Safari',
        'Library/Application Support/Google/Chrome', 'Library/Application Support/Microsoft Edge',
        'Library/Application Support/BraveSoftware', 'Library/Application Support/Firefox',
        '.config/google-chrome', '.config/chromium', '.config/microsoft-edge', '.config/BraveSoftware', '.mozilla/firefox'
      ].map(s => path.join(home, s))];
    this.protectedDirs = [...protectedDirs, userData];
    try { this.protectedDirs.push(real(userData)); } catch { /* Also protect a missing directory lexically. */ }
  }

  private sensitive(target: string) {
    const parts = target.toLowerCase().split(path.sep);
    if (parts.some((s, i) => protectedSegment.test(s) || (s === 'config.json' && parts[i-1] === '.docker')) ||
        this.protectedDirs.some(dir => contains(dir.toLowerCase(), target.toLowerCase()))) fail('SENSITIVE_PATH_BLOCKED');
  }

  validateRoot(input: string) {
    const selected = absolute(input);
    this.sensitive(selected);
    if (selected === path.parse(selected).root) fail('PATH_NOT_ALLOWED');
    return selected;
  }

  selectedDirectory(input: string) {
    const selected = this.validateRoot(input);
    const unpin = windows ? pinWindowsPath(selected) : undefined;
    try {
      const target = this.validateRoot(real(selected));
      const st = inspect(target);
      if (!st.isDirectory()) fail('NOT_A_DIRECTORY');
      if (path.relative(target, real(selected)) !== '' || !same(st, inspect(target))) fail('PATH_NOT_ALLOWED');
      return { path: target, dev: String(st.dev), ino: String(st.ino) };
    } finally { unpin?.(); }
  }

  // All I/O on a resolved name must finish inside visit, while the directory
  // descriptors are live. A descriptor pins an object, not its location: POSIX
  // still permits renames and in-place writes during an operation. Rechecking
  // the chain detects observed moves, but does not provide a filesystem snapshot.
  withResolved<T>(input: unknown, allowLinks: boolean, visit: (target: CheckedPath) => T, parent?: CheckedPath): T {
    const target = absolute(input);
    const observed = new Map<string, BigIntStats>();
    const held: (() => void)[] = [];
    const observe = (name: string) => {
      const st = inspect(name);
      const previous = observed.get(name);
      if (previous && !same(previous, st)) fail('PATH_NOT_ALLOWED');
      observed.set(name, st);
      return st;
    };
    function pinDirectory(name: string, expected: BigIntStats, parentPinned: boolean) {
      if (!expected.isDirectory()) fail('NOT_A_DIRECTORY');
      if (windows) {
        held.push(pinWindowsPath(name, undefined, parentPinned));
        return name;
      }
      const handle = holdHandle(() => openSync(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), closeSync);
      held.push(handle.close);
      const fd = handle.value;
      const st = fstatSync(fd, { bigint: true });
      if (!same(expected, st)) fail('PATH_NOT_ALLOWED');
      if (process.platform !== 'darwin') return '/proc/self/fd/' + fd;
      // Known limitation: Darwin /.vol aliases are path lookups. A same-user
      // process able to modify the grant can race a lookup between checks.
      // Such a process already has its own access to user-readable files.
      const alias = '/.vol/' + st.dev + '/' + st.ino;
      let aliasStat: BigIntStats;
      try { aliasStat = lstatSync(alias, { bigint: true }); }
      catch { fail('PATH_NOT_ALLOWED'); }
      if (!same(st, aliasStat)) fail('PATH_NOT_ALLOWED');
      return alias;
    }
    let links = 0;
    function verifyNames() {
      for (const [name, before] of observed) {
        if (!same(before, inspect(name))) fail('PATH_NOT_ALLOWED');
      }
    }
    const walk = (candidate: string, from?: CheckedPath): Omit<CheckedPath, 'verify'> => {
      this.sensitive(candidate);
      const grant = this.grants.find(g => contains(g.path, candidate));
      if (!grant) fail('PATH_NOT_ALLOWED');
      let current: string, stat: BigIntStats, name: string;
      if (from) {
        if (!from.stat.isDirectory() || path.relative(from.path, path.dirname(candidate)) !== '') fail('PATH_NOT_ALLOWED');
        current = from.path;
        stat = from.stat;
        name = from.name;
      } else {
        current = grant.path;
        stat = observe(current);
        if (!stat.isDirectory() || String(stat.dev) !== grant.dev || String(stat.ino) !== grant.ino ||
            path.relative(current, real(current)) !== '') fail('PATH_NOT_ALLOWED');
        name = pinDirectory(current, stat, false);
      }
      for (const part of path.relative(current, candidate).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        name = path.join(name, part);
        this.sensitive(current);
        stat = observe(name);
        if (from && path.relative(grant.path, current) === '' &&
            (!stat.isDirectory() || String(stat.dev) !== grant.dev || String(stat.ino) !== grant.ino)) fail('PATH_NOT_ALLOWED');
        if (stat.isSymbolicLink()) {
          if (!allowLinks || path.relative(current, candidate) !== '' || ++links > 40) fail('PATH_NOT_ALLOWED');
          const dest = absolute(path.resolve(path.dirname(current), readlinkSync(name)));
          return { ...walk(dest), sourceStat: stat };
        }
        if (stat.isDirectory()) name = pinDirectory(name, stat, true);
        else if (path.relative(current, candidate) !== '') fail('NOT_A_DIRECTORY');
      }
      return { path: current, name, stat, sourceStat: stat };
    };
    try {
      const resolved = walk(target, parent);
      const verify = (opened?: BigIntStats) => {
        if (opened && !same(opened, resolved.stat)) fail('PATH_NOT_ALLOWED');
        parent?.verify();
        verifyNames();
        if (path.relative(resolved.path, real(target)) !== '') fail('PATH_NOT_ALLOWED');
      };
      verify();
      const result = visit({ ...resolved, verify });
      verify();
      return result;
    } finally {
      for (const release of held.reverse()) release();
    }
  }
}
