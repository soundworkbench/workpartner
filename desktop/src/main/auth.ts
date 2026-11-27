import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';

const day = 86_400_000;
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
type Credential = { access_token: string; expires_at: string };
type Saved = Credential & { binding: string; union_id: string };
type Vault = { encryptString(value: string): Buffer; decryptString(value: Buffer): string; isEncryptionAvailable(): boolean };
type Transport = {
  cookie(): Promise<string | undefined>;
  authorize(url: string): Promise<{ status: number; location?: string }>;
  fetch(url: string, options: RequestInit): Promise<Response>;
};

export class DesktopAuth {
  private epoch = 0;
  private queue = Promise.resolve();
  private nextCheck = 0;
  private current?: string;
  private binding?: string;
  private revokedBinding?: string;
  private revokeStorageFailed = false;
  constructor(private origin: string, private file: string, private vault: Vault, private io: Transport,
    private status: (text: string) => void, private warn: (text: string) => void = console.warn,
    private changed: (state: 'available' | 'cleared' | 'revoked') => void = () => {}, private deviceName = hostname) {}

  token() { return this.current; }

  markRevoked() {
    ++this.epoch;
    this.nextCheck = 0;
    this.current = undefined;
    this.changed('revoked');
    this.revokedBinding = this.binding;
    this.revokeStorageFailed = false;
    try {
      if (this.binding) writeFileSync(this.file + '.revoked', this.binding, { mode: 0o600 });
    } catch { this.revokeStorageFailed = true; }
    try { rmSync(this.file, { force: true }); }
    catch { this.revokeStorageFailed = true; }
    this.revokedStatus();
  }

  private revokedStatus() {
    this.status(this.revokeStorageFailed ? '桌面登录已失效，本机撤销记录保存失败' : '桌面登录已失效，请退出后重新登录');
  }

  async refresh() {
    const epoch = this.epoch;
    let renewed = false;
    const work = this.queue.then(async () => {
      if (epoch !== this.epoch || !this.current) return;
      this.nextCheck = 0;
      await this.check(epoch);
      renewed = epoch === this.epoch && !!this.current && this.nextCheck > 0;
    });
    this.queue = work.catch(() => {});
    await work;
    return renewed;
  }

  async revokeAll() {
    if (!this.current) throw new Error('本机没有可用的桌面凭据');
    const response = await this.io.fetch(this.origin + '/_wp/api/desktop/revoke-all', {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.current }
    });
    if (!response.ok) throw new Error('退出所有桌面设备失败');
  }

  clear() {
    ++this.epoch;
    this.nextCheck = 0;
    this.current = this.binding = this.revokedBinding = undefined;
    this.changed('cleared');
    rmSync(this.file + '.revoked', { force: true });
    rmSync(this.file, { force: true });
    this.status('尚未登录');
  }

  sync() {
    const epoch = this.epoch;
    this.queue = this.queue.then(async () => {
      if (epoch === this.epoch) await this.check(epoch);
    }).catch(() => {
      if (epoch === this.epoch) this.status('桌面凭据暂不可用，稍后重试');
    });
    return this.queue;
  }

  private async sessionUser(): Promise<string | null> {
    const me = await this.io.fetch(this.origin + '/_wp/me', { credentials: 'include' });
    if (me.status === 401) return null;
    if (!me.ok) throw new Error('网关暂不可用');
    const { union_id } = await me.json();
    return typeof union_id === 'string' && union_id.length ? union_id : null;
  }

  private async check(epoch: number) {
    const sid = await this.io.cookie();
    if (epoch !== this.epoch) return;
    if (!sid) { this.clear(); return; }
    const binding = hash(this.origin + '\n' + sid);
    if (!this.vault.isEncryptionAvailable()) { this.status('系统凭据存储不可用'); return; }
    const unionId = await this.sessionUser();
    if (epoch !== this.epoch) return;
    if (!unionId) { this.clear(); return; }
    const revoked = this.file + '.revoked';
    const identityBinding = hash(binding + '\n' + unionId);
    if (this.binding && this.binding !== identityBinding) {
      this.current = undefined;
      this.nextCheck = 0;
      this.changed('cleared');
    }
    this.binding = identityBinding;
    if (this.revokedBinding === identityBinding) {
      this.revokedStatus();
      return;
    }
    if (existsSync(revoked)) {
      const marker = readFileSync(revoked, 'utf8');
      // Older clients recorded just the cookie binding.
      if (marker === binding || marker === identityBinding) {
        this.changed('revoked');
        this.status('桌面登录已失效，请退出后重新登录');
        return;
      }
    }
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(this.vault.decryptString(readFileSync(this.file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (saved && (saved.binding !== binding || saved.union_id !== unionId)) {
      rmSync(this.file, { force: true });
      saved = undefined;
    }
    const now = Date.now();
    if (saved && now < this.nextCheck && Date.parse(saved.expires_at) > now) return;

    let response: Response;
    if (saved) {
      // Revalidate at startup and renew within the last week.
      if (this.nextCheck && Date.parse(saved.expires_at) - now >= 7 * day) {
        this.nextCheck = now + day;
        return;
      }
      response = await this.io.fetch(this.origin + '/_wp/api/desktop/refresh', {
        method: 'POST', headers: { Authorization: 'Bearer ' + saved.access_token }
      });
    } else {
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      // Intercept Location in the main process before any request reaches the loopback address.
      const redirect = 'http://127.0.0.1:' + randomInt(49152, 65536) + '/cb';
      const query = new URLSearchParams({ redirect_uri: redirect, state,
        code_challenge: hash(verifier), code_challenge_method: 'S256' });
      const auth = await this.io.authorize(this.origin + '/_wp/desktop/authorize?' + query);
      if (epoch !== this.epoch) return;
      if (auth.status === 403) { this.status('本机助手未开通'); return; }
      if (auth.status !== 302 || !auth.location) throw new Error('授权失败');
      const cb = new URL(auth.location);
      const code = cb.searchParams.get('code');
      if (cb.origin + cb.pathname !== redirect || cb.username || cb.password || cb.hash ||
          cb.searchParams.get('state') !== state || !code) throw new Error('回调无效');
      response = await this.io.fetch(this.origin + '/_wp/api/desktop/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect, device_name: this.deviceName() })
      });
    }
    if (epoch !== this.epoch) return;
    if (saved && [401, 403].includes(response.status)) {
      this.markRevoked();
      return;
    }
    if (!response.ok) throw new Error('无法获取桌面凭据');
    const value = await response.json() as Credential & { user?: { union_id?: string } };
    const sameIdentity = value.user?.union_id === unionId &&
      await this.sessionUser() === unionId && await this.io.cookie() === sid;
    if (epoch !== this.epoch) return;
    if (!sameIdentity) {
      this.clear();
      const message = '会话身份与桌面凭据不一致，已丢弃凭据';
      this.warn(message);
      this.status(message);
      return;
    }
    if ((typeof value.access_token !== 'string' || !/^wpd\.[a-zA-Z0-9_.-]+$/.test(value.access_token)) || !(Date.parse(value.expires_at) > now)) throw new Error('凭据无效');
    const encrypted = this.vault.encryptString(JSON.stringify({ binding, union_id: unionId, access_token: value.access_token, expires_at: value.expires_at }));
    writeFileSync(this.file + '.tmp', encrypted, { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.nextCheck = now + Math.min(day, (Date.parse(value.expires_at) - now) / 2);
    const changed = this.current !== value.access_token;
    if (!this.current) this.status('已登录（已获取桌面凭据）');
    this.current = value.access_token;
    if (changed) this.changed('available');
  }
}
