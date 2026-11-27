import { retryDelay } from './retry-delay.js';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
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

// Leave the pending marker in place after a failed write or rename. Startup
// checks both names, including an empty file left by an interrupted write.
function persistRevocation(file: string, binding: string) {
  const pending = file + '.pending';
  const fd = openSync(pending, 'w', 0o600);
  try {
    writeFileSync(fd, 'v1.' + binding + '.' + hash('revoked\n' + binding));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(pending, file);
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}

function blocksSession(file: string, cookie: string, identity: string) {
  let marker: string;
  try { marker = readFileSync(file, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  // Accept only canonical SHA-256 digests. Older clients stored the cookie digest.
  let binding = marker;
  if (marker.startsWith('v1.')) {
    const fields = marker.split('.');
    if (fields.length !== 3 || fields[2] !== hash('revoked\n' + fields[1])) return true;
    binding = fields[1];
  }
  const digest = Buffer.from(binding, 'base64url');
  return digest.length !== 32 || digest.toString('base64url') !== binding || binding === cookie || binding === identity;
}

export class DesktopAuth {
  private epoch = 0;
  private queue = Promise.resolve();
  private nextCheck = 0;
  private retryTimer?: NodeJS.Timeout;
  private retryAttempt = 0;
  private current?: string;
  private binding?: string;
  private sessionBinding?: string;
  private revokedBinding?: string;
  private revokeStorageFailed = false;
  constructor(private origin: string, private file: string, private vault: Vault, private io: Transport,
    private status: (text: string) => void, private warn: (text: string) => void = console.warn,
    private changed: (state: 'available' | 'cleared' | 'revoked', unionId?: string) => void = () => {}, private deviceName = hostname) {}

  token() { return this.current; }

  private resetRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAttempt = 0;
  }

  markRevoked() {
    this.resetRetry();
    ++this.epoch;
    this.nextCheck = 0;
    this.current = undefined;
    this.revokedBinding = this.binding;
    this.revokeStorageFailed = false;
    try {
      persistRevocation(this.file + '.revoked', this.binding ?? '');
      rmSync(this.file, { force: true });
    } catch {
      // If even the pending file could not be created, keep the old credential.
      // On restart it must be validated by the gateway, never exchanged via PKCE.
      this.revokeStorageFailed = true;
    }
    this.changed('revoked');
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

  private invalidate() {
    this.resetRetry();
    ++this.epoch;
    this.nextCheck = 0;
    this.current = this.binding = this.sessionBinding = undefined;
    this.changed('cleared');
  }

  cookieChanged(sid: string) {
    const binding = hash(this.origin + '\n' + sid);
    if (this.sessionBinding && this.sessionBinding !== binding) this.invalidate();
    this.sessionBinding = binding;
    return binding;
  }

  clear({ sessionEnded = true } = {}) {
    // The logout button can run before the gateway cookie is actually gone.
    // Keep revocation evidence if cookie removal or logout navigation fails.
    // At startup any saved token is refresh-only until verified. It may be
    // the sole durable evidence left by a failure to create either marker.
    const keepOldToken = !sessionEnded && !this.current;
    let notified = true;
    try { this.invalidate(); } catch { notified = false; }
    const files = keepOldToken ? [] : [this.file];
    if (sessionEnded) {
      this.revokedBinding = undefined;
      this.revokeStorageFailed = false;
      files.push(this.file + '.revoked', this.file + '.revoked.pending');
    }
    let cleaned = true;
    for (const file of files) {
      try { rmSync(file, { force: true }); }
      catch { cleaned = false; }
    }
    this.status(!cleaned ? '已退出，本机凭据文件清理失败' : notified ? '尚未登录' : '本机退出状态更新失败');
    return cleaned && notified;
  }

  sync() {
    const epoch = this.epoch;
    this.queue = this.queue.then(async () => {
      if (epoch === this.epoch) await this.check(epoch);
    }).catch(() => {
      if (epoch !== this.epoch) return;
      this.status('桌面凭据暂不可用，稍后重试');
      // A saved credential may need revalidation before a relay exists.
      if (!this.retryTimer && existsSync(this.file)) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.sync();
        }, retryDelay(this.retryAttempt++)).unref();
      }
    });
    return this.queue;
  }

  private async sessionUser(): Promise<string | null> {
    const me = await this.io.fetch(this.origin + '/_wp/me', { credentials: 'include' });
    if (me.status === 401) return null;
    if (!me.ok) throw new Error('网关暂不可用');
    const { union_id } = await me.json();
    if (typeof union_id !== 'string' || !union_id.length) throw new Error('网关未确认会话身份');
    return union_id;
  }

  private async check(epoch: number) {
    const sid = await this.io.cookie();
    if (epoch !== this.epoch) return;
    if (!sid) { this.clear(); return; }
    const binding = this.cookieChanged(sid);
    epoch = this.epoch;
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
    if ([revoked, revoked + '.pending'].some(file => blocksSession(file, binding, identityBinding))) {
      this.current = undefined;
      this.nextCheck = 0;
      this.revokedBinding = identityBinding;
      this.changed('revoked');
      this.revokedStatus();
      return;
    }
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(this.vault.decryptString(readFileSync(this.file)));
      if (!saved || typeof saved.binding !== 'string' || !saved.binding ||
          typeof saved.union_id !== 'string' || !saved.union_id ||
          typeof saved.access_token !== 'string' || !saved.access_token) throw new Error('本机凭据无效');
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
      this.invalidate();
      const message = '会话身份与桌面凭据不一致，已拒绝此次签发';
      this.warn(message);
      this.status(message);
      return;
    }
    if ((typeof value.access_token !== 'string' || !/^wpd\.[a-zA-Z0-9_.-]+$/.test(value.access_token)) || !(Date.parse(value.expires_at) > now)) throw new Error('凭据无效');
    const encrypted = this.vault.encryptString(JSON.stringify({ binding, union_id: unionId, access_token: value.access_token, expires_at: value.expires_at }));
    writeFileSync(this.file + '.tmp', encrypted, { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.resetRetry();
    this.nextCheck = now + Math.min(day, (Date.parse(value.expires_at) - now) / 2);
    const changed = this.current !== value.access_token;
    if (!this.current) this.status('已登录（已获取桌面凭据）');
    this.current = value.access_token;
    this.revokedBinding = undefined;
    this.revokeStorageFailed = false;
    if (changed) this.changed('available', unionId);
  }
}
