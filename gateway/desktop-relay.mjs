import crypto from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { desktopTools, object, errors, failure, success, validArguments, precheck } from './desktop-tools.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FRAME = 1048576;
const rootsValid = roots => Array.isArray(roots) && roots.length <= 32 && roots.every(root => typeof root === 'string' && root.length > 0 && root.length <= 1024 && !root.includes('\0'));
const nameValid = name => typeof name === 'string' && name.trim().length > 0 && name.length <= 128;
const cleanName = name => name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 128) || 'WorkPartner Desktop';

export function rejectUpgrade(socket, status, headers = {}) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
}

export function createDesktopRelay({ desktopAuth, migration, allowedHost, now = Date.now,
  audit = record => console.log(JSON.stringify(record)), timing = {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const registry = new Map(), sessions = new Set();
  const duration = { hello: 5000, ping: 25000, heartbeat: 60000, review: 60000, call: 15000, search: 20000, ...timing };
  function log(event, session, extra = {}) {
    audit({ at: new Date(now()).toISOString(), event, unionId: session.user.unionId, deviceId: session.deviceId, ...extra });
  }
  function send(session, message) {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_FRAME || session.ws.readyState !== WebSocket.OPEN) return false;
    session.ws.send(text, error => { if (error) drop(session, 4008, 'heartbeat_timeout'); });
    return true;
  }
  function detach(session) {
    if (!sessions.delete(session)) return false;
    clearTimeout(session.helloTimer); clearTimeout(session.heartbeatTimer);
    const devices = registry.get(session.user.unionId);
    if (devices?.get(session.deviceId) === session) devices.delete(session.deviceId);
    if (devices?.size === 0) registry.delete(session.user.unionId);
    for (const job of session.inFlight.values()) job.finish(failure('DEVICE_DISCONNECTED'), 'DEVICE_DISCONNECTED');
    return true;
  }
  function drop(session, code, reason) {
    if (!detach(session)) return;
    log('disconnect', session, { closeCode: code });
    session.ws.close(code, reason);
    const timer = setTimeout(() => session.ws.terminate(), 1000); timer.unref();
    session.ws.once('close', () => clearTimeout(timer));
  }
  function alive(session) {
    if (!sessions.has(session)) return;
    clearTimeout(session.heartbeatTimer);
    session.heartbeatTimer = setTimeout(() => drop(session, 4008, 'heartbeat_timeout'), duration.heartbeat);
    session.heartbeatTimer.unref();
  }
  function review(unionId) {
    for (const s of sessions) {
      if (unionId && s.user.unionId !== unionId) continue;
      if (!desktopAuth.admitted(s.user)) drop(s, 4003, 'not_admitted');
      else if (!desktopAuth.verify(s.token)) drop(s, 4001, s.expires <= now() / 1000 ? 'token_expired' : 'token_revoked');
    }
  }
  function message(s, bytes, binary) {
    if (!sessions.has(s)) return;
    if (binary) return drop(s, 4004, 'invalid_hello');
    let msg;
    try { msg = JSON.parse(bytes.toString()); } catch { return drop(s, 4004, 'invalid_hello'); }
    if (!object(msg) || typeof msg.type !== 'string') return drop(s, 4004, 'invalid_hello');
    if (!s.ready) {
      if (msg.type === 'hello' && Number.isInteger(msg.protocolVersion) && msg.protocolVersion !== 1) return drop(s, 4004, 'unsupported_protocol');
      if (msg.type !== 'hello' || msg.protocolVersion !== 1 || msg.deviceId !== s.deviceId || !nameValid(msg.deviceName)
        || !['darwin', 'win32', 'linux'].includes(msg.platform) || typeof msg.arch !== 'string' || msg.arch.length > 64
        || typeof msg.appVersion !== 'string' || msg.appVersion.length > 128
        || !Array.isArray(msg.capabilities) || msg.capabilities.length > 32 || !msg.capabilities.every(cap => typeof cap === 'string' && cap.length <= 128)
        || !rootsValid(msg.allowedRoots) || (msg.preferred !== undefined && typeof msg.preferred !== 'boolean')) return drop(s, 4004, 'invalid_hello');
      review(s.user.unionId);
      if (!sessions.has(s)) return;
      const old = registry.get(s.user.unionId)?.get(s.deviceId);
      if (old) drop(old, 4002, 'replaced_by_new_connection');
      Object.assign(s, { ready: true, deviceName: cleanName(msg.deviceName), platform: msg.platform, arch: msg.arch,
        appVersion: msg.appVersion, capabilities: msg.capabilities, allowedRoots: msg.allowedRoots, preferred: msg.preferred ?? false,
        connectedAt: now(), lastActiveAt: now() });
      clearTimeout(s.helloTimer);
      send(s, { type: 'hello_ack', protocolVersion: 1, minProtocolVersion: 1, maxProtocolVersion: 1, serverTime: now(),
        heartbeatSec: 25, heartbeatTimeoutSec: 60, maxFrameBytes: MAX_FRAME, maxConcurrency: 4 });
      if (!registry.has(s.user.unionId)) registry.set(s.user.unionId, new Map());
      registry.get(s.user.unionId).set(s.deviceId, s);
      log('connect', s); alive(s); return;
    }
    if (msg.type === 'state_update') {
      if ((msg.deviceName !== undefined && !nameValid(msg.deviceName)) || (msg.allowedRoots !== undefined && !rootsValid(msg.allowedRoots))
        || ['preferred', 'active'].some(key => msg[key] !== undefined && typeof msg[key] !== 'boolean')) return drop(s, 4004, 'invalid_hello');
      if (msg.deviceName !== undefined) s.deviceName = cleanName(msg.deviceName);
      if (msg.allowedRoots !== undefined) s.allowedRoots = msg.allowedRoots;
      if (msg.preferred !== undefined) s.preferred = msg.preferred;
      if (msg.active) s.lastActiveAt = now();
    } else if (msg.type === 'rpc_res') {
      if (typeof msg.reqId !== 'string' || typeof msg.ok !== 'boolean' || (msg.ok ? !object(msg.data) : !object(msg.error))) return drop(s, 4004, 'invalid_hello');
      const job = s.inFlight.get(msg.reqId);
      if (job) {
        s.lastActiveAt = now();
        let code = msg.ok ? null : (typeof msg.error.code === 'string' && Object.hasOwn(errors, msg.error.code) ? msg.error.code : 'INTERNAL_ERROR');
        let result;
        try { result = msg.ok ? success({ ...msg.data, device_id: s.deviceId, device_name: s.deviceName, _meta: job.meta }) : failure(code); }
        catch { code = 'INTERNAL_ERROR'; result = failure(code); }
        job.finish(result, code);
      }
    } else return drop(s, 4004, 'invalid_hello');
    alive(s);
  }
  function upgrade(req, socket, head) {
    if (!allowedHost(String(req.headers.host || '').toLowerCase())) return rejectUpgrade(socket, 403);
    if ((req.headers['x-wp-protocol-version'] ?? '1') !== '1') return rejectUpgrade(socket, 426, { 'X-WP-Min-Protocol-Version': 1, 'X-WP-Max-Protocol-Version': 1 });
    const deviceId = req.headers['x-wp-device-id'];
    if (!UUID.test(deviceId || '')) return rejectUpgrade(socket, 400);
    // Queries never carry credentials, even if a valid Authorization header is also present.
    if (new URL(req.url, 'http://gateway').search) return rejectUpgrade(socket, 401);
    const auth = desktopAuth.authenticate(req);
    if (!auth) return rejectUpgrade(socket, 401);
    if (migration && !migration.owns(auth.user) && migration.forward(req, socket, auth.user, head)) return;
    review(auth.user.unionId);
    const own = [...sessions].filter(s => s.user.unionId === auth.user.unionId);
    const ids = new Set(own.map(s => s.deviceId));
    if (!ids.has(deviceId) && ids.size >= 5) return rejectUpgrade(socket, 429);
    wss.handleUpgrade(req, socket, head, ws => {
      const s = { ws, deviceId, user: auth.user, token: req.headers.authorization.slice(7), expires: auth.value.exp, inFlight: new Map(), ready: false };
      sessions.add(s);
      s.helloTimer = setTimeout(() => drop(s, 4004, 'hello_timeout'), duration.hello); s.helloTimer.unref();
      ws.on('message', (bytes, binary) => {
        try { message(s, bytes, binary); } catch { drop(s, 4004, 'invalid_hello'); }
      });
      ws.on('pong', () => alive(s));
      ws.on('error', () => drop(s, 1009, 'message_too_big'));
      ws.on('close', code => { if (detach(s)) log('disconnect', s, { closeCode: code }); });
      alive(s);
    });
  }
  const ping = setInterval(() => { for (const s of sessions) if (s.ws.readyState === WebSocket.OPEN) s.ws.ping(); }, duration.ping); ping.unref();
  const check = setInterval(() => review(), duration.review); check.unref();
  function devices(user) {
    return [...(registry.get(user.unionId)?.values() || [])].map(s => ({ device_id: s.deviceId, device_name: s.deviceName,
      platform: s.platform, arch: s.arch, app_version: s.appVersion, preferred: s.preferred, capabilities: s.capabilities,
      allowed_roots: s.allowedRoots, allowed_roots_count: s.allowedRoots.length,
      connected_at: new Date(s.connectedAt).toISOString(), last_active_at: new Date(s.lastActiveAt).toISOString() }));
  }
  async function call(user, params, signal) {
    review(user.unionId);
    if (!desktopAuth.admitted(user)) return failure('DESKTOP_NOT_ADMITTED');
    if (!object(params) || typeof params.name !== 'string') return failure('INVALID_PARAMS');
    const tool = desktopTools.find(tool => tool.name === params.name);
    if (!tool) return failure('TOOL_NOT_SUPPORTED');
    const args = params.arguments ?? {};
    if (!validArguments(tool.inputSchema, args)) return failure('INVALID_PARAMS');
    const list = devices(user);
    if (tool.name === 'desktop_list_devices') {
      const result = success({ count: list.length, devices: list });
      if (!list.length) result.content.push({ type: 'text', text: '请打开桌面客户端连接本机助手。' });
      return result;
    }
    const online = [...(registry.get(user.unionId)?.values() || [])];
    const selected = args.device_id ? online.find(s => s.deviceId === args.device_id)
      : online.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.lastActiveAt - a.lastActiveAt)[0];
    if (!selected) return failure(args.device_id ? 'DEVICE_NOT_FOUND' : 'DEVICE_OFFLINE', args.device_id ? { devices: list } : undefined);
    if (!selected.capabilities.includes('fs.read')) return failure('TOOL_NOT_SUPPORTED');
    const denied = precheck(args.path, selected.allowedRoots, selected.platform);
    if (denied) return failure(denied);
    if (selected.inFlight.size >= 4 || online.reduce((sum, s) => sum + s.inFlight.size, 0) >= 8) return failure('CONCURRENCY_LIMIT_EXCEEDED');
    if (signal?.aborted) return failure('INTERNAL_ERROR');
    const reqId = `req_${crypto.randomUUID()}`, started = now(), timeoutMs = tool.name === 'desktop_search_files' ? duration.search : duration.call;
    return new Promise(resolve => {
      let timer;
      const cancel = reason => send(selected, { type: 'rpc_cancel', reqId, reason });
      const aborted = () => { cancel('caller_aborted'); finish(failure('INTERNAL_ERROR'), 'INTERNAL_ERROR'); };
      const finish = (result, code) => {
        if (!selected.inFlight.delete(reqId)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        log('call', selected, { tool: tool.name, reqId, durationMs: now() - started, status: code ? 'error' : 'ok', errorCode: code });
        resolve(result);
      };
      selected.inFlight.set(reqId, { finish, meta: { device_id: selected.deviceId, device_name: selected.deviceName,
        online_devices: online.length, routed_by: args.device_id ? 'device_id' : selected.preferred ? 'preferred' : 'lastActiveAt' } });
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => { cancel('timeout'); finish(failure('TOOL_TIMEOUT'), 'TOOL_TIMEOUT'); }, timeoutMs); timer.unref();
      if (!send(selected, { type: 'rpc_req', reqId, method: 'tools/call', params: { name: tool.name, arguments: args }, timeoutMs })) finish(failure('PAYLOAD_TOO_LARGE'), 'PAYLOAD_TOO_LARGE');
    });
  }
  return { upgrade, call, review, registry,
    revoke(unionId) { for (const s of sessions) if (s.user.unionId === unionId) drop(s, 4001, 'token_revoked'); },
    close() {
      clearInterval(ping); clearInterval(check);
      for (const s of sessions) {
        for (const reqId of s.inFlight.keys()) send(s, { type: 'rpc_cancel', reqId, reason: 'gateway_shutdown' });
        drop(s, 1001, 'server_shutdown');
      }
      wss.close();
    },
  };
}
