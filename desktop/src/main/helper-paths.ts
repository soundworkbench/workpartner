import { lstatSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail } from './helper-errors.js';
import { checkWindowsAttributes, pinWindowsPath } from './helper-windows.js';

export type RootGrant = { path: string; dev: string; ino: string };
function inspect(path: string) {
  const stat = lstatSync(path, { bigint: true });
  checkWindowsAttributes(path);
  if (!stat.ino) fail('PATH_NOT_ALLOWED');
  return stat;
}
function same(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.isSymbolicLink() === right.isSymbolicLink();
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

  // Capture every component, including a permitted POSIX link and its destination.
  resolve(input: unknown, allowLinks = true) {
    const target = absolute(input);
    const observed = new Map<string, BigIntStats>();
    const observe = (path: string) => {
      const st = inspect(path);
      const previous = observed.get(path);
      if (previous && !same(previous, st)) fail('PATH_NOT_ALLOWED');
      observed.set(path, st);
      return st;
    };
    let links = 0;
    const walk = (candidate: string): string => {
      this.sensitive(candidate);
      const grant = this.grants.find(g => contains(g.path, candidate));
      if (!grant) fail('PATH_NOT_ALLOWED');
      let current = grant.path;
      const root = observe(current);
      if (!root.isDirectory() || String(root.dev) !== grant.dev || String(root.ino) !== grant.ino ||
          path.relative(current, real(current)) !== '') fail('PATH_NOT_ALLOWED');
      for (const part of path.relative(current, candidate).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        this.sensitive(current);
        if (observe(current).isSymbolicLink()) {
          if (!allowLinks || path.relative(current, candidate) !== '' || ++links > 40) fail('PATH_NOT_ALLOWED');
          current = walk(absolute(path.resolve(path.dirname(current), readlinkSync(current))));
        }
      }
      return current;
    };
    const resolved = walk(target);
    const stat = observed.get(resolved)!;
    // Node has no openat. Sampling names cannot rule out an ancestor moving away
    // and back between checks. Bind I/O to the verified object and recheck the
    // original chain before using its data.
    const verify = (opened?: BigIntStats) => {
      if (opened && !same(opened, stat)) fail('PATH_NOT_ALLOWED');
      for (const [name, before] of observed) {
        if (!same(before, inspect(name))) fail('PATH_NOT_ALLOWED');
      }
      if (path.relative(resolved, real(target)) !== '') fail('PATH_NOT_ALLOWED');
    };
    verify();
    return { path: resolved, stat, sourceStat: observed.get(target) ?? stat, verify };
  }
}
