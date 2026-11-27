import WebSocket from 'ws';
import type { HelperSettings } from './helper-settings.js';
import { createToolRunner, type RunTool } from './helper-runner.js';
import { createAudit } from './helper-audit.js';
import { errorCode, wireError, type ErrorCode } from './helper-errors.js';
import type { ToolData } from './helper-tools.js';

const maxBytes = 1048576;
const maxBufferedBytes = 4 * maxBytes;
const slowRetryMs = 600000;
const deviceLimitStatus = '在线桌面设备已达上限（5 台），稍后重试';
const steps = [1000, 2000, 4000, 8000, 15000, 30000];
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.round(steps[Math.min(attempt, steps.length - 1)] * (0.8 + random() * 0.4));
type Auth = { token(): string | undefined; refresh(): Promise<boolean>; markRevoked(): void };
type Options = { origin: string; appVersion: string; settings: HelperSettings; auth: Auth;
  status: (text: string, connection: Connection) => void; loopbackTest?: boolean; run?: RunTool };
type Incoming = Record<string, unknown>;
function object(v: unknown): v is Incoming { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function positive(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v > 0; }

export type Connection = 'connected' | 'connecting' | 'offline' | 'revoked' | 'paused';

export class DesktopRelay {
  private url: URL;
  private ws?: WebSocket;
  private ready = false;
  private terminal = false;
  private negotiated = false;
  private attemptedRefresh = false;
  private refreshing = false;
  private attempt = 0;
  private epoch = 0;
  private waiting?: NodeJS.Timeout;
  private slowRetry = false;
  private retryNotBefore = 0;
  private watchdog?: NodeJS.Timeout;
  private healthy?: NodeJS.Timeout;
  private lastActive = -Infinity;
  private frameLimit = maxBytes;
  private concurrency = 4;
  private inflight = new Map<string, AbortController>();
  private roots: string[] = [];
  private run: RunTool;
  private audit: ReturnType<typeof createAudit>;
  state = '尚未登录';
  connection: Connection = 'offline';
  get canRetry() { return !!this.waiting && !this.slowRetry; }
  constructor(private opts: Options) {
    this.url = new URL('/_wp/desktop/ws', opts.origin);
    if (this.url.protocol === 'https:') this.url.protocol = 'wss:';
    else if (opts.loopbackTest && this.url.protocol === 'http:' && this.url.hostname === '127.0.0.1') this.url.protocol = 'ws:';
    else throw new Error('本机助手需要安全连接');
    this.run = opts.run || createToolRunner();
    this.audit = createAudit(opts.settings.userData);
  }
  private status(text: string, connection: Connection = 'offline') {
    this.state = text;
    this.connection = connection;
    this.opts.status(text, connection);
  }
  private abortAll() {
    for (const job of this.inflight.values()) job.abort();
    this.inflight.clear();
  }
  private resetConnection() {
    this.ws = undefined;
    this.ready = false;
    clearTimeout(this.watchdog);
    clearTimeout(this.healthy);
    this.abortAll();
  }
  stop(reason: 'user_logout' | 'helper_paused' | 'app_quit') {
    this.epoch++;
    this.refreshing = false;
    clearTimeout(this.waiting);
    this.waiting = undefined;
    const ws = this.ws;
    const closed = ws && ws.readyState !== WebSocket.CLOSED
      ? new Promise<void>(resolve => ws.once('close', () => resolve())) : Promise.resolve();
    this.resetConnection();
    if (ws?.readyState === WebSocket.OPEN) ws.close(1000, reason);
    else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    if (reason === 'user_logout') {
      this.retryNotBefore = 0;
      this.attempt = 0;
      this.attemptedRefresh = this.terminal = false;
      this.status('尚未登录');
    } else if (reason === 'helper_paused' && !this.terminal) this.status('本机助手已暂停', 'paused');
    if (reason === 'app_quit') this.terminal = true;
    return closed;
  }
  private halt(text: string, connection: Connection = 'offline') { this.terminal = true; this.status(text, connection); }
  private schedule(slowStatus?: string, slowDelay = slowRetryMs) {
    if (this.terminal || this.opts.settings.snapshot().paused || !this.opts.auth.token()) return;
    this.slowRetry = slowStatus !== undefined;
    const delay = this.slowRetry ? slowDelay : retryDelay(this.attempt++);
    this.waiting = setTimeout(() => { this.waiting = undefined; this.connect(); }, delay);
    const text = slowStatus ?? '本机助手已断开，等待重连';
    this.status(text + '（约 ' + Math.ceil(delay / 1000) + ' 秒）', 'offline');
  }
  wake() {
    if (this.terminal || this.refreshing || this.opts.settings.snapshot().paused || Date.now() < this.retryNotBefore) return;
    clearTimeout(this.waiting);
    this.waiting = undefined;
    const stale = this.ws;
    if (stale) {
      this.resetConnection();
      stale.terminate();
    }
    this.attempt = 0;
    this.connect();
  }
  credentialsChanged(state: 'available' | 'cleared' | 'revoked', unionId?: string) {
    this.opts.settings.bindAccount(state === 'available' ? unionId : undefined);
    if (state === 'available') this.connect();
    else if (state === 'revoked') this.credentialsRevoked();
    else this.stop('user_logout');
  }
  credentialsRevoked() {
    this.stop('user_logout');
    this.halt('桌面登录已失效，请退出后重新登录', 'revoked');
  }
  private async refresh(epoch: number) {
    if (!this.attemptedRefresh) {
      this.refreshing = this.attemptedRefresh = true;
      this.status('正在更新桌面凭据', 'connecting');
      let renewed = false;
      try { renewed = await this.opts.auth.refresh(); } catch { /* Failure invalidates this session. */ }
      if (this.epoch !== epoch) return;
      this.refreshing = false;
      if (renewed) { this.connect(); return; }
    }
    this.revoke();
  }
  private revoke() {
    this.halt('桌面登录已失效，请退出后重新登录', 'revoked');
    try { this.opts.auth.markRevoked(); }
    catch { this.status('桌面登录已失效，本机撤销记录保存失败', 'revoked'); }
  }
  private disconnected(code: number, reason: string, http: number) {
    this.resetConnection();
    if (http === 401 || (code === 4001 && reason === 'token_expired')) { void this.refresh(this.epoch); return; }
    if (code === 4001) { this.revoke(); return; }
    if (code === 1000) { this.halt('本机助手已断开'); return; }
    if (code === 4002) { this.halt('本机助手已由新连接接替'); return; }
    if (http === 403 || code === 4003) { this.halt('本机助手未开通'); return; }
    if (code === 4004 && reason === 'unsupported_protocol') { this.halt('本机助手协议不兼容，请升级桌面客户端'); return; }
    if (http === 429) {
      this.retryNotBefore = Date.now() + slowRetryMs;
      this.schedule(deviceLimitStatus);
      return;
    }
    if (code === 1009) console.warn('[desktop] 中继帧超过大小上限');
    if (!this.negotiated && [404,405,426,501].includes(http)) {
      this.schedule(http === 426 ? '本机助手协议不兼容，请升级桌面客户端' : '当前网关暂不支持本机助手');
    } else this.schedule();
  }
  connect() {
    const { settings, auth, appVersion } = this.opts;
    const token = auth.token();
    if (!token || this.terminal || this.refreshing || this.waiting || this.ws) return;
    if (settings.snapshot().paused) { this.status('本机助手已暂停', 'paused'); return; }
    const remaining = this.retryNotBefore - Date.now();
    if (remaining > 0) { this.schedule(deviceLimitStatus, remaining); return; }
    this.status('本机助手连接中', 'connecting');
    const ws = new WebSocket(this.url, { headers: { Authorization: 'Bearer ' + token, 'X-WP-Protocol-Version': '1',
      'X-WP-Device-Id': settings.deviceId, 'X-WP-Platform': process.platform, 'X-WP-App-Version': appVersion },
      maxPayload: maxBytes, handshakeTimeout: 10000, perMessageDeflate: false, autoPong: false, followRedirects: false });
    this.ws = ws;
    this.frameLimit = maxBytes;
    let http = 0, receivedOversize = false;
    ws.on('unexpected-response', (_req, res) => { http = res.statusCode || 0; res.destroy(); ws.terminate(); });
    ws.on('error', (e: NodeJS.ErrnoException) => {
      receivedOversize = e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';
    });
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.disconnected(receivedOversize ? 1009 : code, reason.toString(), http);
    });
    const watch = (ms: number) => {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => ws.terminate(), ms);
    };
    ws.on('open', () => {
      if (this.ws !== ws) return;
      const { deviceName, allowedRoots, preferred } = settings.snapshot();
      this.roots = allowedRoots;
      this.send(ws, JSON.stringify({ type: 'hello', protocolVersion: 1, deviceId: settings.deviceId, deviceName, allowedRoots, preferred,
        appVersion, platform: process.platform, arch: process.arch, capabilities: ['fs.read'] }));
      watch(5000);
    });
    ws.on('ping', data => {
      this.send(ws, data);
      if (this.ws === ws && this.ready) watch(65000);
    });
    ws.on('message', (raw, binary) => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (binary) { ws.close(4004, 'invalid_frame'); return; }
      const frame = raw.toString();
      if (this.ready && Buffer.byteLength(frame) > this.frameLimit) { ws.close(1009, 'message_too_big'); return; }
      let msg: unknown;
      try { msg = JSON.parse(frame); } catch { /* Reject malformed frames below. */ }
      if (!object(msg) || typeof msg.type !== 'string') { ws.close(4004, 'invalid_frame'); return; }
      if (!this.ready) {
        if (msg.type !== 'hello_ack') { ws.close(4004, 'invalid_hello'); return; }
        if (msg.protocolVersion !== 1 || !positive(msg.minProtocolVersion) || !positive(msg.maxProtocolVersion) ||
            msg.minProtocolVersion > 1 || msg.maxProtocolVersion < 1) {
          this.halt('本机助手协议不兼容，请升级桌面客户端'); ws.close(4004, 'unsupported_protocol'); return;
        }
        if (!positive(msg.maxFrameBytes) || !positive(msg.maxConcurrency) || !positive(msg.heartbeatSec) ||
            !positive(msg.heartbeatTimeoutSec) || !positive(msg.serverTime)) { ws.close(4004, 'invalid_hello'); return; }
        this.ready = true;
        this.negotiated = true;
        this.frameLimit = Math.min(maxBytes, msg.maxFrameBytes);
        this.concurrency = Math.min(4, msg.maxConcurrency);
        this.lastActive = -Infinity;
        this.status('本机助手已连接', 'connected');
        this.healthy = setTimeout(() => { this.attempt = 0; this.attemptedRefresh = false; }, 10000);
        this.settingsChanged();
      } else if (msg.type === 'rpc_req') void this.request(ws, msg);
      else if (msg.type === 'rpc_cancel' && typeof msg.reqId === 'string') this.inflight.get(msg.reqId)?.abort();
      watch(65000);
    });
  }
  private send(ws: WebSocket | undefined, frame: string | Buffer) {
    if (!ws || ws !== this.ws || ws.readyState !== WebSocket.OPEN) return;
    // A masked client frame adds at most 14 bytes. Include queued control frames.
    if (ws.bufferedAmount + Buffer.byteLength(frame) + 14 > maxBufferedBytes) {
      ws.terminate();
      return;
    }
    if (typeof frame === 'string') ws.send(frame);
    else ws.pong(frame);
  }
  settingsChanged() {
    const { paused, deviceName, allowedRoots, preferred } = this.opts.settings.snapshot();
    if (paused) { this.stop('helper_paused'); return; }
    if (this.roots.some(root => !allowedRoots.includes(root))) {
      for (const job of this.inflight.values()) job.abort('PATH_NOT_ALLOWED');
    }
    this.roots = allowedRoots;
    if (this.ready) this.send(this.ws, JSON.stringify({ type: 'state_update', deviceName, allowedRoots, preferred }));
    else if (this.connection === 'paused' && !this.opts.auth.token()) this.status('尚未登录');
    else this.connect();
  }
  active() {
    if (!this.ready || Date.now() - this.lastActive < 10000) return;
    this.lastActive = Date.now();
    this.send(this.ws, '{"type":"state_update","active":true}');
  }
  private async request(ws: WebSocket, msg: Incoming) {
    const reqId = msg.reqId;
    if (typeof reqId !== 'string' || !reqId.length || Buffer.byteLength(reqId) > 1024 || this.inflight.has(reqId)) {
      ws.close(4004, 'invalid_request'); return;
    }
    const params = object(msg.params) ? msg.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = object(params.arguments) ? params.arguments : {};
    const start = Date.now();
    let code: ErrorCode | undefined, data: ToolData | undefined, returnedBytes = 0;
    let controller: AbortController | undefined;
    try {
      if (this.inflight.size >= this.concurrency) code = 'CONCURRENCY_LIMIT_EXCEEDED';
      else if (msg.method !== 'tools/call' || !positive(msg.timeoutMs) || !name || !object(params.arguments)) code = 'INVALID_PARAMS';
      else {
        controller = new AbortController();
        this.inflight.set(reqId, controller);
        data = await this.run({ name, args, roots: this.opts.settings.grants(), userData: this.opts.settings.userData,
          timeout: Math.min(10000, msg.timeoutMs) }, controller.signal);
      }
    } catch (e) { code = errorCode(e); }
    finally {
      if (controller && this.inflight.get(reqId) === controller) this.inflight.delete(reqId);
    }
    const removedRoot = controller?.signal.reason === 'PATH_NOT_ALLOWED';
    if (removedRoot) code = 'PATH_NOT_ALLOWED';
    const cancelled = (controller?.signal.aborted && !removedRoot) || this.ws !== ws || ws.readyState !== WebSocket.OPEN;
    if (cancelled) code = 'TOOL_TIMEOUT';
    let frame = '';
    if (!code && data) {
      frame = JSON.stringify({ type: 'rpc_res', reqId, ok: true, data });
      if (Buffer.byteLength(frame) > this.frameLimit) code = 'PAYLOAD_TOO_LARGE';
      else returnedBytes = typeof data.returned_bytes === 'number' ? data.returned_bytes : Buffer.byteLength(JSON.stringify(data));
    }
    try { this.audit({ reqId, tool: name, args, code, durationMs: Date.now() - start, returnedBytes, truncated: !code && data?.truncated === true }); }
    catch { code = 'INTERNAL_ERROR'; }
    if (cancelled) return;
    if (code) frame = JSON.stringify({ type: 'rpc_res', reqId, ok: false, error: wireError(code) });
    if (Buffer.byteLength(frame) <= this.frameLimit) this.send(ws, frame);
    else ws.close(1009, 'message_too_big');
  }
}
