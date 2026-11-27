import { closeSync, constants, fstatSync, openSync, opendirSync, readSync, type Dir, type Dirent } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { join, relative } from 'node:path';
import { errorCode, fail } from './helper-errors.js';
import { PathPolicy, type CheckedPath, type RootGrant } from './helper-paths.js';
import { pinWindowsPath } from './helper-windows.js';

type Args = Record<string, unknown>;
type Match = { path: string; kind?: 'file' | 'dir'; line?: number; snippet?: string };
export type SearchProgress = { match: Match; mode: string };
export type ToolData = Record<string, unknown>;
const fields: Record<string, string[]> = {
  desktop_list_dir: ['path','limit','max_depth','include_hidden'],
  desktop_read_file: ['path','start_line','end_line','max_bytes'],
  desktop_search_files: ['path','query','mode','max_depth','max_results','case_sensitive']
};
function integer(args: Args, key: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = args[key] === undefined ? fallback : args[key];
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > max) fail('INVALID_PARAMS');
  return n;
}
function boolean(args: Args, key: string) {
  if (args[key] !== undefined && typeof args[key] !== 'boolean') fail('INVALID_PARAMS');
  return args[key] === true;
}
function withDirectory(policy: PathPolicy, input: unknown, visit: (dir: CheckedPath, handle: Dir) => void) {
  policy.withResolved(input, false, dir => {
    if (!dir.stat.isDirectory()) fail('NOT_A_DIRECTORY');
    const unpin = process.platform === 'win32' ? pinWindowsPath(dir.path) : undefined;
    try {
      dir.verify();
      const handle = opendirSync(dir.name);
      try { visit(dir, handle); } finally { handle.closeSync(); }
    } finally { unpin?.(); }
  });
}
function ignoreEntry(e: unknown) {
  if (!['PATH_NOT_ALLOWED','SENSITIVE_PATH_BLOCKED','PATH_NOT_FOUND','NOT_A_DIRECTORY','NOT_A_REGULAR_FILE',
    'BINARY_FILE_UNSUPPORTED','FILE_TOO_LARGE','INVALID_PARAMS'].includes(errorCode(e))) throw e;
}
function list(policy: PathPolicy, args: Args, check: () => void) {
  const depth = integer(args, 'max_depth', 1, 3), limit = integer(args, 'limit', 100, 200);
  const hidden = boolean(args, 'include_hidden');
  let root = '';
  type Entry = { name: string; path: string; kind: string; mtime: string; size_bytes?: number };
  const entries: Entry[] = [];
  let skipped = 0, visited = 0, truncated = false;
  function walk(input: unknown, level: number) {
    const children: Entry[] = [];
    withDirectory(policy, input, (dir, handle) => {
      if (level === 1) root = dir.path;
      for (let d: Dirent | null; (d = handle.readSync());) {
        check();
        if (visited >= 2000) { truncated = true; break; }
        visited++;
        if (!hidden && d.name.startsWith('.')) { skipped++; continue; }
        const name = d.name;
        const path = join(dir.path, name);
        try {
          const entry = policy.withResolved(path, true, target => {
            const st = target.sourceStat;
            if (!st.isSymbolicLink() && !st.isFile() && !st.isDirectory()) return;
            const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
            return { name, path, kind, mtime: st.mtime.toISOString(), ...(kind === 'file' && { size_bytes: Number(st.size) }) };
          });
          if (entry) children.push(entry); else skipped++;
        } catch (e) { ignoreEntry(e); skipped++; }
      }
    });
    children.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of children) {
      check();
      if (entries.length === limit) { truncated = true; break; }
      entries.push(item);
      if (item.kind === 'dir' && level < depth) {
        if (visited >= 2000) { truncated = true; continue; }
        try { walk(item.path, level + 1); } catch (e) { ignoreEntry(e); skipped++; }
      }
    }
  }
  walk(args.path, 1);
  return { path: root, entries, skipped_count: skipped, truncated };
}

const MiB = 1024 * 1024;
function readText(target: CheckedPath, limit: number, check: () => void, onRead?: (n: number) => void) {
  const path = target.path;
  if (!target.stat.isFile()) fail('NOT_A_REGULAR_FILE');
  const unpin = process.platform === 'win32' ? pinWindowsPath(path) : undefined;
  let fd: number | undefined;
  try {
    const opened = openSync(target.name, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    fd = opened;
    const verify = () => {
      const st = fstatSync(opened, { bigint: true });
      if (!st.isFile()) fail('NOT_A_REGULAR_FILE');
      if (st.nlink !== 1n) fail('PATH_NOT_ALLOWED');
      target.verify(st);
      return st;
    };
    const st = verify();
    if (st.size > limit) fail('FILE_TOO_LARGE');
    const buf = Buffer.allocUnsafe(Number(st.size));
    let count = 0;
    while (count < buf.length) {
      check();
      const n = readSync(fd, buf, count, Math.min(64 * 1024, buf.length - count), count);
      if (!n) break;
      count += n;
      onRead?.(n);
    }
    verify();
    const bytes = buf.subarray(0, count);
    if (bytes.subarray(0, 8192).includes(0) || !isUtf8(bytes)) fail('BINARY_FILE_UNSUPPORTED');
    return { path, bytes };
  } finally {
    if (fd !== undefined) closeSync(fd);
    unpin?.();
  }
}
function readFile(policy: PathPolicy, args: Args, check: () => void) {
  const start = integer(args, 'start_line', 1), end = integer(args, 'end_line', Number.MAX_SAFE_INTEGER);
  const max = integer(args, 'max_bytes', 65536, 262144);
  if (start > end) fail('INVALID_PARAMS');
  const { path, bytes } = policy.withResolved(args.path, true, target => readText(target, 20 * MiB, check));
  let offset = 0, line = 1;
  while (offset < bytes.length && line < start) {
    const nl = bytes.indexOf(10, offset);
    offset = nl < 0 ? bytes.length : nl + 1;
    line++;
    if (!(line % 4096)) check();
  }
  let stop = offset, last = 0;
  const cap = Math.min(bytes.length, offset + max);
  while (stop < cap && line <= end) {
    const nl = bytes.subarray(stop, cap).indexOf(10);
    stop = nl < 0 ? cap : stop + nl + 1;
    last = line++;
  }
  const truncated = stop < bytes.length && (last < end || (last === end && bytes[stop-1] !== 10));
  while (stop > offset && (bytes[stop] & 0xc0) === 0x80) stop--;
  if (stop > offset && stop < cap && bytes[stop - 1] === 10) last--;
  const content = bytes.toString('utf8', offset, stop);
  return { path, encoding: 'utf-8', total_size_bytes: bytes.length, start_line: start, end_line: stop === offset ? 0 : last,
    returned_bytes: stop - offset, truncated, content };
}

// A bitset tracks all reachable glob positions in one pass (at most 200 pattern characters).
function nameMatcher(query: string) {
  if (!/[*?]/.test(query)) return (s: string) => s.includes(query);
  const pattern = [...query.replace(/\*+/g, '*')];
  let stars = 0n, any = 0n;
  const literals = new Map<string, bigint>();
  for (const [i, c] of pattern.entries()) {
    const bit = 1n << BigInt(i);
    if (c === '*') stars |= bit;
    else if (c === '?') any |= bit;
    else literals.set(c, (literals.get(c) || 0n) | bit);
  }
  const end = 1n << BigInt(pattern.length);
  const epsilon = (positions: bigint) => positions | ((positions & stars) << 1n);
  return (s: string) => {
    let state = epsilon(1n);
    for (const c of s) state = epsilon((state & stars) | ((state & (any | (literals.get(c) || 0n))) << 1n));
    return (state & end) !== 0n;
  };
}
function search(policy: PathPolicy, args: Args, check: () => void, progress?: (p: SearchProgress) => void, scanCount?: Int32Array) {
  const mode = args.mode === undefined ? 'name' : args.mode;
  if (mode !== 'name' && mode !== 'content') fail('INVALID_PARAMS');
  if (typeof args.query !== 'string' || !args.query.length || args.query.length > 200) fail('INVALID_PARAMS');
  const max = integer(args, 'max_results', 50, 100), depth = integer(args, 'max_depth', 5, 8);
  const sensitive = boolean(args, 'case_sensitive');
  const fold = (s: string) => sensitive ? s : s.toLowerCase();
  const query = fold(args.query), nameMatches = nameMatcher(query);
  const matches: Match[] = [];
  let scanned = 0, bytesRead = 0, truncated = false, timedOut = false;
  function hit(match: Match) {
    matches.push(match);
    progress?.({ match, mode: mode as string });
    if (matches.length >= max) truncated = true;
  }
  function scanContent(target: CheckedPath) {
    const { path, stat: st } = target;
    if (st.size > 2 * MiB) return;
    const remaining = 50 * MiB - bytesRead;
    if (st.size > remaining) { truncated = true; return; }
    // Charge the bytes even when the opened file turns out to be binary.
    const { bytes } = readText(target, Math.min(remaining, 2 * MiB), check, n => { bytesRead += n; });
    const text = bytes.toString('utf8');
    let line = 1, at = 0;
    while (at < text.length && !truncated) {
      check();
      const nl = text.indexOf('\n', at);
      const value = text.slice(at, nl < 0 ? text.length : nl).replace(/\r$/, '');
      const found = fold(value).indexOf(query);
      if (found >= 0) hit({ path, line, snippet: value.slice(Math.max(0, found - 40), Math.max(0, found - 40) + 200) });
      at = nl < 0 ? text.length : nl + 1;
      line++;
    }
  }
  function walk(input: unknown, level: number, base?: string) {
    withDirectory(policy, input, (dir, handle) => {
      const root = base ?? dir.path;
      for (let d: Dirent | null; !truncated && (d = handle.readSync());) {
        check();
        if (d.isSymbolicLink() || d.name === '.git' || d.name === 'node_modules') continue;
        const name = d.name;
        const path = join(dir.path, name);
        try {
          policy.withResolved(path, false, target => {
            dir.verify();
            const st = target.stat;
            if (!st.isDirectory() && !st.isFile()) return;
            if (st.isFile()) {
              scanned++;
              if (scanCount) Atomics.store(scanCount, 0, scanned);
            }
            if (mode === 'name' && (nameMatches(fold(name)) || nameMatches(fold(relative(root, path))))) {
              hit({ path, kind: st.isDirectory() ? 'dir' : 'file' });
            }
            if (mode === 'content' && st.isFile()) scanContent(target);
            if (st.isDirectory() && level < depth && !truncated) walk(path, level + 1, root);
          });
        } catch (e) { ignoreEntry(e); }
        if (scanned >= 5000 || bytesRead >= 50 * MiB) truncated = true;
      }
    });
  }
  try {
    for (const input of args.path === undefined ? policy.grants.map(g => g.path) : [args.path]) {
      walk(input, 1);
      if (truncated) break;
    }
  } catch (e) {
    if (errorCode(e) !== 'TOOL_TIMEOUT' || !matches.length) throw e;
    timedOut = truncated = true;
  }
  return { mode, matches, truncated, timed_out: timedOut, scanned_files: scanned };
}

export function executeTool(name: string, args: Args, roots: RootGrant[], userData: string, deadline: number,
    progress?: (p: SearchProgress) => void, scanCount?: Int32Array, cancelFlag?: Int32Array): ToolData {
  if (!Object.hasOwn(fields, name)) fail('TOOL_NOT_SUPPORTED');
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'device_id' && !fields[name].includes(k)) ||
      (args.device_id !== undefined && (typeof args.device_id !== 'string' || !args.device_id.length || args.device_id.length > 64))) fail('INVALID_PARAMS');
  if (!roots.length) fail('NO_ALLOWED_ROOTS');
  const policy = new PathPolicy(roots, userData);
  const check = () => {
    if (Date.now() >= deadline || (cancelFlag && Atomics.load(cancelFlag, 0))) fail('TOOL_TIMEOUT');
  };
  check();
  if (name === 'desktop_list_dir') return list(policy, args, check);
  if (name === 'desktop_read_file') return readFile(policy, args, check);
  return search(policy, args, check, progress, scanCount);
}
