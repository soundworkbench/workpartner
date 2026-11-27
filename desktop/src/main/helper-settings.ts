import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { hash } from './auth.js';
import { fail } from './helper-errors.js';
import { PathPolicy, type RootGrant } from './helper-paths.js';

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
type AccountSettings = { grants: RootGrant[]; preferred: boolean };
type StoredSettings = { deviceName: string; paused: boolean; accounts: Record<string, AccountSettings> };
export class HelperSettings {
  readonly deviceId: string;
  private file: string;
  private config: StoredSettings;
  private account?: string;
  private accountEpoch = 0;
  constructor(readonly userData: string, private pickFolder: () => Promise<string | undefined>, private changed: () => void) {
    const idFile = join(userData, 'device-id');
    const savedId = read(idFile)?.trim();
    if (savedId && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(savedId)) this.deviceId = savedId;
    else { this.deviceId = randomUUID(); atomic(idFile, this.deviceId); }
    this.file = join(userData, 'helper-config.json');
    this.config = { deviceName: cleanName(hostname()), paused: false, accounts: {} };
    const saved = read(this.file);
    if (saved !== undefined) {
      try {
        const data = JSON.parse(saved);
        if (typeof data.deviceName === 'string') this.config.deviceName = cleanName(data.deviceName);
        this.config.paused = data.paused === true;
        // Only explicitly owned grants can be restored. Old top-level grants
        // and preferred flags have no account binding.
        const policy = new PathPolicy([], userData);
        for (const [key, profile] of Object.entries(data.accounts ?? {})) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !profile || typeof profile !== 'object' ||
              !('grants' in profile) || !Array.isArray(profile.grants)) continue;
          const grants: RootGrant[] = [];
          for (const grant of profile.grants.slice(0, 32)) {
            try {
              if (policy.validateRoot(grant.path) === grant.path && typeof grant.dev === 'string' &&
                  /^\d+$/.test(grant.dev) && typeof grant.ino === 'string' && /^[1-9]\d*$/.test(grant.ino) &&
                  !grants.some(g => g.path === grant.path)) grants.push({ path: grant.path, dev: grant.dev, ino: grant.ino });
            } catch { /* Ignore malformed grants. */ }
          }
          this.config.accounts[key] = { grants, preferred: 'preferred' in profile && profile.preferred === true };
        }
      } catch { /* Fail closed on malformed configuration. */ }
    } else atomic(this.file, JSON.stringify(this.config));
  }
  bindAccount(unionId?: string) {
    const key = unionId ? hash(unionId) : undefined;
    if (key !== this.account) this.accountEpoch++;
    this.account = key;
  }
  private profile(): AccountSettings {
    return (this.account && this.config.accounts[this.account]) || { grants: [], preferred: false };
  }
  grants() { return this.profile().grants.map(grant => ({ ...grant })); }
  snapshot(): Config {
    const { deviceName, paused } = this.config;
    const { grants, preferred } = this.profile();
    return { deviceName, paused, preferred, allowedRoots: grants.map(g => g.path) };
  }
  private saveProfile(change: Partial<AccountSettings>) {
    if (!this.account) fail('PATH_NOT_ALLOWED');
    this.save({ accounts: { ...this.config.accounts, [this.account]: { ...this.profile(), ...change } } });
  }
  private save(next: Partial<typeof this.config>) {
    const updated = { ...this.config, ...next };
    atomic(this.file, JSON.stringify(updated));
    this.config = updated;
    this.changed();
  }
  async addDirectory() {
    if (!this.account) fail('PATH_NOT_ALLOWED');
    const epoch = this.accountEpoch;
    const choice = await this.pickFolder();
    if (!choice || epoch !== this.accountEpoch) return;
    const dir = new PathPolicy([], this.userData).selectedDirectory(choice);
    const roots = this.profile().grants;
    if (roots.some(g => g.path === dir.path)) return;
    if (roots.length >= 32) fail('INVALID_PARAMS');
    this.saveProfile({ grants: [...roots, dir] });
  }
  removeDirectory(dir: string) { this.saveProfile({ grants: this.profile().grants.filter(g => g.path !== dir) }); }
  setDeviceName(name: string) { if (typeof name !== 'string') fail('INVALID_PARAMS'); this.save({ deviceName: cleanName(name) }); }
  setPreferred(preferred: boolean) { if (typeof preferred !== 'boolean') fail('INVALID_PARAMS'); this.saveProfile({ preferred }); }
  setPaused(paused: boolean) { if (typeof paused !== 'boolean') fail('INVALID_PARAMS'); this.save({ paused }); }
}
