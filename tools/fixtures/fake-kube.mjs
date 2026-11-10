import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { duplexPair } from 'node:stream';
import { urlToHttpOptions } from 'node:url';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';

const { WebSocketServer } = createRequire(new URL('../../gateway/package.json', import.meta.url))('ws');
const servers = new Map();
let nextPort = 12000, restore;

/** Disposable self-signed certificate, generated with Node alone; no stored private key. */
export function createCertificate() {
  const der = (tag, ...parts) => {
    const value = Buffer.concat(parts), length = [];
    for (let size = value.length; size; size >>>= 8) length.unshift(size & 255);
    return Buffer.concat([Buffer.from([tag, ...(value.length < 128 ? [value.length] : [128 | length.length, ...length])]), value]);
  };
  const sequence = (...parts) => der(0x30, ...parts);
  const oid = hex => der(0x06, Buffer.from(hex, 'hex'));
  const extension = (id, value) => sequence(oid(id), der(0x04, value));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('example.com')))));
  const algorithm = sequence(oid('2a8648ce3d040302'));
  const time = offset => der(0x17, Buffer.from(new Date(Date.now() + offset).toISOString().slice(2, 19).replace(/\D/g, '') + 'Z'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const body = sequence(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algorithm, name,
    sequence(time(-86400000), time(86400000)), name, publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      extension('551d13', sequence(der(0x01, Buffer.from([255])))),
      extension('551d11', sequence(der(0x82, Buffer.from('example.com')))),
      extension('551d25', sequence(oid('2b06010505070301'), oid('2b06010505070302'))),
    )));
  const certificate = sequence(body, algorithm, der(0x03, Buffer.from([0]), sign('sha256', body, privateKey)));
  return { cert: Buffer.from(`-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// Use real HTTP/TLS/WebSocket parsers over memory streams; no listening socket is needed.
function installTransport() {
  if (restore) return;
  const originals = [http.request, https.request];
  for (const [index, transport] of [http, https].entries()) {
    transport.request = (input, options, callback) => {
      if (typeof options === 'function') { callback = options; options = undefined; }
      const config = input instanceof URL || typeof input === 'string'
        ? { ...urlToHttpOptions(new URL(input)), ...options } : { ...input, ...options };
      const server = (config.hostname || config.host) === 'example.com' && servers.get(String(config.port));
      if (!server) throw new Error('Unexpected fake Kubernetes destination');
      const agent = new transport.Agent();
      agent.createConnection = connectionOptions => {
        const [local, remote] = duplexPair();
        for (const stream of [local, remote]) {
          stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = stream.ref = stream.unref = () => stream;
          stream.on('error', () => {});
        }
        local.on('close', () => remote.destroy());
        remote.on('close', () => local.destroy());
        server.emit('connection', remote);
        return index === 1 ? tls.connect({ ...connectionOptions, socket: local, servername: 'example.com' }) : local;
      };
      return originals[index].call(transport, { ...config, agent }, callback);
    };
  }
  restore = () => { [http.request, https.request] = originals; restore = undefined; };
}

export function sendChannel(socket, channel, value) {
  socket.send(Buffer.concat([Buffer.from([channel]), Buffer.from(value)]));
}

export function sendStatus(socket, exitCode = 0) {
  sendChannel(socket, 3, JSON.stringify(exitCode === 0 ? { status: 'Success' } : {
    status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: String(exitCode) }] },
  }));
  socket.close();
}

/** In-memory HTTP(S) API with observable requests and a real exec WebSocket handshake. */
export async function createFakeKube({ tls, protocols = ['v5.channel.k8s.io', 'v4.channel.k8s.io'], onRequest, onExec, onUpgrade } = {}) {
  const requests = [], executions = [], sockets = new Set(), connections = new Set();
  const handler = async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    const record = { method: req.method, path: req.url, headers: req.headers, rawBody,
      body: rawBody ? JSON.parse(rawBody) : undefined, authorized: req.socket.authorized };
    requests.push(record);
    if (onRequest) await onRequest(record, res);
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); }
  };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  const ws = new WebSocketServer({ noServer: true, handleProtocols: offered => protocols.find(protocol => offered.has(protocol)) || false });
  server.on('upgrade', (req, socket, head) => {
    if (onUpgrade && onUpgrade(req, socket) === false) return;
    ws.handleUpgrade(req, socket, head, client => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      client.on('error', () => {});
      const url = new URL(req.url, 'http://example.com');
      const record = { path: url.pathname, query: url.searchParams, headers: req.headers,
        protocol: client.protocol, frames: [], authorized: req.socket.authorized };
      executions.push(record);
      client.on('message', data => record.frames.push(Buffer.from(data)));
      if (onExec) onExec(client, record);
      else sendStatus(client);
    });
  });
  installTransport();
  const port = String(nextPort++);
  servers.set(port, server);
  return {
    url: `${tls ? 'https' : 'http'}://example.com:${port}`, requests, executions, sockets,
    close: async () => {
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.terminate();
      for (const socket of connections) socket.destroy();
      await Promise.all([closed, new Promise(resolve => ws.close(resolve))]);
      servers.delete(port);
      if (!servers.size) restore();
    },
  };
}
