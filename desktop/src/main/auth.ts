import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';

const day = 86_400_000;
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
type Credential = { access_token: string; expires_at: string };
type Saved = Credential & { binding: string };
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
  constructor(private origin: string, private file: string, private vault: Vault, private io: Transport,
    private status: (text: string) => void) {}

  clear() {
    ++this.epoch;
    this.nextCheck = 0;
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

  private async check(epoch: number) {
    const sid = await this.io.cookie();
    if (epoch !== this.epoch) return;
    if (!sid) { this.clear(); return; }
    const binding = hash(this.origin + '\n' + sid);
    if (existsSync(this.file + '.revoked') && readFileSync(this.file + '.revoked', 'utf8') === binding) {
      this.status('桌面登录已失效，请退出后重新登录');
      return;
    }
    if (!this.vault.isEncryptionAvailable()) { this.status('系统凭据存储不可用'); return; }
    let saved: Saved | undefined;
    try {
      saved = JSON.parse(this.vault.decryptString(readFileSync(this.file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (saved && saved.binding !== binding) {
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
      const me = await this.io.fetch(this.origin + '/_wp/me', { credentials: 'include' });
      if (me.status === 401) { if (epoch === this.epoch) this.status('尚未登录'); return; }
      if (!me.ok) throw new Error('网关暂不可用');
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
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirect, device_name: hostname() })
      });
    }
    const currentSid = await this.io.cookie();
    if (epoch !== this.epoch || currentSid !== sid) return;
    if (saved && [401, 403].includes(response.status)) {
      this.clear();
      writeFileSync(this.file + '.revoked', binding, { mode: 0o600 });
      this.status('桌面登录已失效，请退出后重新登录');
      return;
    }
    if (!response.ok) throw new Error('无法获取桌面凭据');
    const value = await response.json() as Credential;
    if (!value.access_token?.startsWith('wpd.') || !(Date.parse(value.expires_at) > now)) throw new Error('凭据无效');
    if (epoch !== this.epoch) return;
    const encrypted = this.vault.encryptString(JSON.stringify({ binding, access_token: value.access_token, expires_at: value.expires_at }));
    writeFileSync(this.file + '.tmp', encrypted, { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.nextCheck = now + Math.min(day, (Date.parse(value.expires_at) - now) / 2);
    this.status('已登录（已获取桌面凭据）');
  }
}
