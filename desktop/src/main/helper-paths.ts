import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fail } from './helper-errors.js';

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

const protectedSegment = /^(?:\.ssh|\.aws|\.gnupg|\.kube|\.git-credentials|\.npmrc|\.pypirc|\.netrc|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|kdbx))$/is;
export class PathPolicy {
  private protectedDirs: string[];
  constructor(readonly roots: readonly string[], userData: string) {
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
    const target = real(selected);
    this.validateRoot(target);
    if (!statSync(target).isDirectory()) fail('NOT_A_DIRECTORY');
    return target;
  }

  // Inspect each link destination before following it, including intermediate links.
  resolve(input: unknown, allowLinks = true): string {
    const target = absolute(input);
    let links = 0;
    const walk = (candidate: string): string => {
      this.sensitive(candidate);
      const root = this.roots.find(dir => contains(dir, candidate));
      if (!root) fail('PATH_NOT_ALLOWED');
      const canonicalRoot = real(root);
      this.sensitive(canonicalRoot);
      // A previously granted root must never silently retarget to another directory.
      if (path.relative(root, canonicalRoot) !== '') fail('PATH_NOT_ALLOWED');
      let current = canonicalRoot;
      const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
      for (const part of parts) {
        current = path.join(current, part);
        this.sensitive(current);
        if (lstatSync(current).isSymbolicLink()) {
          if (!allowLinks || ++links > 40) fail('PATH_NOT_ALLOWED');
          current = walk(absolute(path.resolve(path.dirname(current), readlinkSync(current))));
        }
      }
      const actual = real(current);
      this.sensitive(actual);
      if (path.relative(current, actual) !== '' || !this.roots.some(dir => contains(dir, actual))) fail('PATH_NOT_ALLOWED');
      return actual;
    };
    const resolved = walk(target);
    if (path.relative(resolved, real(target)) !== '') fail('PATH_NOT_ALLOWED');
    return resolved;
  }
}
