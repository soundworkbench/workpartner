import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fail } from './helper-errors.js';
import { PathPolicy } from './helper-paths.js';

function read(file: string) {
  try { return readFileSync(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
function atomic(file: string, value: string) {
  const tmp = file + '.' + randomUUID();
  try {
    writeFileSync(tmp, value, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}
function cleanName(name: string) {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 128).replace(/[\uD800-\uDBFF]$/, '') || 'WorkPartner Desktop';
}
type Config = { deviceName: string; allowedRoots: string[]; preferred: boolean; paused: boolean };
export class HelperSettings {
  readonly deviceId: string;
  private file: string;
  private config: Config;
  constructor(readonly userData: string, private pickFolder: () => Promise<string | undefined>, private changed: () => void) {
    const idFile = join(userData, 'device-id');
    const savedId = read(idFile)?.trim();
    if (savedId && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(savedId)) this.deviceId = savedId;
    else { this.deviceId = randomUUID(); atomic(idFile, this.deviceId); }
    this.file = join(userData, 'helper-config.json');
    this.config = { deviceName: cleanName(hostname()), allowedRoots: [], preferred: false, paused: false };
    const saved = read(this.file);
    if (saved !== undefined) {
      try {
        const data = JSON.parse(saved);
        if (typeof data.deviceName === 'string') this.config.deviceName = cleanName(data.deviceName);
        this.config.preferred = data.preferred === true;
        this.config.paused = data.paused === true;
        if (Array.isArray(data.allowedRoots)) {
          const policy = new PathPolicy([], userData);
          for (const root of data.allowedRoots.slice(0, 32)) {
            try { if (policy.validateRoot(root) === root && !this.config.allowedRoots.includes(root)) this.config.allowedRoots.push(root); }
            catch { /* Ignore invalid persisted grants. Resolve available volumes on each request. */ }
          }
        }
      } catch { /* Fail closed on malformed configuration. */ }
    } else atomic(this.file, JSON.stringify(this.config));
  }
  snapshot(): Config { return { ...this.config, allowedRoots: [...this.config.allowedRoots] }; }
  private save(next: Partial<Config>) {
    const updated = { ...this.config, ...next };
    atomic(this.file, JSON.stringify(updated));
    this.config = updated;
    this.changed();
  }
  async addDirectory() {
    const choice = await this.pickFolder();
    if (!choice) return;
    const dir = new PathPolicy([], this.userData).selectedDirectory(choice);
    const roots = this.config.allowedRoots;
    if (roots.includes(dir)) return;
    if (roots.length >= 32) fail('INVALID_PARAMS');
    this.save({ allowedRoots: [...roots, dir] });
  }
  removeDirectory(dir: string) { this.save({ allowedRoots: this.config.allowedRoots.filter(root => root !== dir) }); }
  setDeviceName(name: string) { if (typeof name !== 'string') fail('INVALID_PARAMS'); this.save({ deviceName: cleanName(name) }); }
  setPreferred(preferred: boolean) { if (typeof preferred !== 'boolean') fail('INVALID_PARAMS'); this.save({ preferred }); }
  setPaused(paused: boolean) { if (typeof paused !== 'boolean') fail('INVALID_PARAMS'); this.save({ paused }); }
}
