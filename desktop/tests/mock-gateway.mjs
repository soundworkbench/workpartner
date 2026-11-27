import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

export async function mockGateway(t) {
  const http = createServer(), wss = new WebSocketServer({ noServer: true, maxPayload: 1048576 });
  const devices = new Map(), pending = new Map(), attempts = [], replies = [];
  const token = 'wpd.' + randomUUID();
  const mock = { devices, attempts, replies, token, reject: 0, ack: {}, beforeAck: undefined };
  http.on('upgrade', (req, socket, head) => {
    attempts.push({
      url: req.url, headers: Object.keys(req.headers), version: req.headers['x-wp-protocol-version'],
      id: req.headers['x-wp-device-id'], platform: req.headers['x-wp-platform'], app: req.headers['x-wp-app-version']
    });
    const status = mock.reject || (req.url !== '/_wp/desktop/ws' ? 404 :
      req.headers.authorization !== 'Bearer ' + token ? 401 : req.headers['x-wp-protocol-version'] !== '1' ? 426 :
        !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(req.headers['x-wp-device-id']) ? 400 : 0);
    if (status) {
      socket.end('HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let device, alive = Date.now();
      const helloTimeout = setTimeout(() => ws.close(4004, 'hello_timeout'), 5000);
      const heartbeat = setInterval(() => {
        if (Date.now() - alive > 60000) ws.close(4008, 'heartbeat_timeout');
        else ws.ping();
      }, 25000);
      ws.on('pong', () => { alive = Date.now(); });
      ws.on('error', () => { });
      ws.on('message', (raw, binary) => {
        if (binary) {
          ws.close(4004, 'invalid_frame');
          return;
        }
        const msg = JSON.parse(raw);
        alive = Date.now();
        if (!device) {
          if (msg.type !== 'hello' || msg.deviceId !== req.headers['x-wp-device-id'] || msg.protocolVersion !== 1 ||
            !msg.capabilities?.includes('fs.read') || !Array.isArray(msg.allowedRoots) || !msg.deviceName) {
            ws.close(4004, 'invalid_hello');
            return;
          }
          clearTimeout(helloTimeout);
          devices.get(msg.deviceId)?.ws.close(4002, 'replaced_by_new_connection');
          device = { ...msg, ws, connected: Date.now(), active: Date.now(), activeUpdates: 0 };
          devices.set(msg.deviceId, device);
          mock.beforeAck?.(device);
          ws.send(JSON.stringify({
            type: 'hello_ack', protocolVersion: 1, minProtocolVersion: 1, maxProtocolVersion: 1,
            serverTime: Date.now(), heartbeatSec: 25, heartbeatTimeoutSec: 60, maxFrameBytes: 1048576, maxConcurrency: 4, ...mock.ack
          }));
        } else if (msg.type === 'state_update') {
          if (msg.active === true) {
            device.active = Date.now();
            device.activeUpdates++;
          }
          for (const k of ['allowedRoots', 'deviceName', 'preferred']) if (k in msg) device[k] = msg[k];
        } else if (msg.type === 'rpc_res') {
          device.active = Date.now();
          replies.push(msg.reqId);
          const waiter = pending.get(msg.reqId);
          if (waiter?.ws === ws) waiter.done(msg);
        }
      });
      ws.on('close', () => {
        clearTimeout(helloTimeout);
        clearInterval(heartbeat);
        if (device && devices.get(device.deviceId) === device) devices.delete(device.deviceId);
        for (const waiter of pending.values()) if (waiter.ws === ws) waiter.done({ ok: false, error: { code: 'DEVICE_DISCONNECTED' } });
      });
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => http.close(resolve));
  });
  function request(device, name, args = {}, timeoutMs = 15000, gatewayTimeout = timeoutMs) {
    const reqId = 'req_' + randomUUID(), ws = device.ws;
    const result = new Promise(resolve => {
      const done = value => {
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(value);
      };
      const timer = setTimeout(() => {
        ws.send(JSON.stringify({ type: 'rpc_cancel', reqId, reason: 'timeout' }));
        done({ ok: false, error: { code: 'TOOL_TIMEOUT' } });
      }, gatewayTimeout);
      pending.set(reqId, { ws, done });
      ws.send(JSON.stringify({ type: 'rpc_req', reqId, method: 'tools/call', params: { name, arguments: args }, timeoutMs }));
    });
    return { reqId, result };
  }
  function call(name, args = {}) {
    const online = [...devices.values()].sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.active - a.active);
    if (name === 'desktop_list_devices') return {
      ok: true, data: {
        count: online.length,
        devices: online.map(d => ({
          device_id: d.deviceId, device_name: d.deviceName, platform: d.platform, arch: d.arch,
          app_version: d.appVersion, preferred: d.preferred, capabilities: d.capabilities, allowed_roots: d.allowedRoots,
          allowed_roots_count: d.allowedRoots.length, connected_at: new Date(d.connected).toISOString(), last_active_at: new Date(d.active).toISOString()
        }))
      }
    };
    const device = args.device_id ? devices.get(args.device_id) : online[0];
    if (!device) return { ok: false, error: { code: args.device_id ? 'DEVICE_NOT_FOUND' : 'DEVICE_OFFLINE' } };
    return request(device, name, args).result;
  }
  return Object.assign(mock, { origin: 'http://127.0.0.1:' + http.address().port, request, call });
}
