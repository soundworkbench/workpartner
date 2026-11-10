import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';

const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
const reasons = new Set(['Unauthorized', 'Forbidden', 'NotFound', 'AlreadyExists', 'Conflict', 'Invalid',
  'BadRequest', 'Timeout', 'ServerTimeout', 'TooManyRequests', 'InternalError', 'ServiceUnavailable',
  'MethodNotAllowed', 'NotAcceptable', 'RequestEntityTooLarge', 'UnsupportedMediaType', 'Gone', 'Expired']);
const statusReasons = { 400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound',
  409: 'Conflict', 410: 'Gone', 422: 'Invalid', 429: 'TooManyRequests', 500: 'InternalError',
  503: 'ServiceUnavailable', 504: 'Timeout' };

// Never include server messages, request paths, credentials, or native transport errors.
function failure(reason, status = 0) {
  return Object.assign(new Error(`Kubernetes request failed: ${reason} (${status})`), { status, reason });
}

function apiFailure(status, body, creating = false) {
  let reason;
  try { reason = JSON.parse(body).reason; } catch { /* Non-JSON errors are intentionally discarded. */ }
  return failure(creating && status === 409 ? 'AlreadyExists'
    : reasons.has(reason) ? reason : statusReasons[status] || 'ApiError', status);
}

function duration(value) {
  if (!Number.isFinite(value) || value <= 0) throw failure('InvalidOptions');
  return value;
}

function byteLimit(value) {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) throw failure('InvalidOptions');
  return value;
}

function configuration({ inCluster, kubeconfigJson }) {
  try {
    if (kubeconfigJson !== undefined) {
      if (inCluster) throw new Error();
      const config = typeof kubeconfigJson === 'string' ? JSON.parse(kubeconfigJson) : kubeconfigJson;
      const context = config.contexts.find(item => item.name === config['current-context']).context;
      const cluster = config.clusters.find(item => item.name === context.cluster).cluster;
      const user = config.users.find(item => item.name === context.user).user;
      if (cluster['insecure-skip-tls-verify'] || user.exec || user['auth-provider']) throw new Error();
      const decode = value => {
        if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
        return Buffer.from(value, 'base64');
      };
      const ca = cluster['certificate-authority-data'] ? decode(cluster['certificate-authority-data']) : undefined;
      if (cluster['certificate-authority'] || user['client-certificate'] || user['client-key']) throw new Error();
      const cert = user['client-certificate-data'] ? decode(user['client-certificate-data']) : undefined;
      const key = user['client-key-data'] ? decode(user['client-key-data']) : undefined;
      if (!!cert !== !!key || (!user.token && !cert)) throw new Error();
      if (user.token !== undefined && (typeof user.token !== 'string' || !user.token.trim())) throw new Error();
      return { server: cluster.server, namespace: context.namespace || 'default',
        credentials: () => ({ ca, cert, key, token: user.token }) };
    }
    if (inCluster === false) throw new Error();
    const options = typeof inCluster === 'object' && inCluster !== null ? inCluster : {};
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const server = options.server || (host && `https://${host.includes(':') ? `[${host}]` : host}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS || process.env.KUBERNETES_SERVICE_PORT || 443}`);
    const namespace = fs.readFileSync(options.namespaceFile || `${serviceAccount}/namespace`, 'utf8').trim();
    if (!namespace) throw new Error();
    return { server, namespace, credentials: () => {
      const token = fs.readFileSync(options.tokenFile || `${serviceAccount}/token`, 'utf8').trim();
      const ca = fs.readFileSync(options.caFile || `${serviceAccount}/ca.crt`);
      if (!token || !ca.length) throw new Error();
      return { token, ca };
    } };
  } catch { throw failure('InvalidConfiguration'); }
}

/** Accept a parsed or serialized flattened JSON kubeconfig, or use the mounted ServiceAccount.
 * inCluster defaults to true; an object may override server, namespaceFile, tokenFile and caFile.
 * Local errors have status 0. HTTP failures retain status and a sanitized Kubernetes reason.
 */
export function createKubeClient(options = {}) {
  const config = configuration(options);
  const timeout = duration(options.timeoutMs ?? 10000);
  let base;
  try {
    base = new URL(config.server);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { throw failure('InvalidConfiguration'); }

  function connection(route) {
    if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\') || route.includes('#')) {
      throw failure('InvalidPath');
    }
    try {
      const { token, ...tls } = config.credentials();
      const url = new URL(base.href.replace(/\/$/, '') + route);
      return { url, tls, headers: token ? { Authorization: `Bearer ${token}` } : {} };
    } catch { throw failure('CredentialsUnavailable'); }
  }

  function request(method, route, body, contentType, limitBytes = Infinity) {
    return new Promise((resolve, reject) => {
      let req, timer, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { reject(error); req?.destroy(); }
        else resolve(result);
      };
      try {
        const { url, tls, headers } = connection(route);
        let payload;
        try { payload = body === undefined ? undefined : JSON.stringify(body); }
        catch { throw failure('InvalidBody'); }
        if (payload !== undefined) {
          headers['Content-Type'] = contentType || 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }
        req = (url.protocol === 'https:' ? https : http).request(url, { method, ...tls, headers, agent: false }, res => {
          const chunks = []; let size = 0;
          const success = res.statusCode >= 200 && res.statusCode < 300;
          const maxBytes = success ? limitBytes : 65536;
          res.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) {
              if (success) finish(failure('OutputLimitExceeded'));
              else chunks.length = 0;
            } else chunks.push(chunk);
          });
          res.on('error', () => finish(failure('TransportError')));
          res.on('aborted', () => finish(failure('TransportError')));
          res.on('end', () => finish(null, { status: res.statusCode, body: Buffer.concat(chunks) }));
        });
        req.on('error', () => finish(failure('TransportError')));
        timer = setTimeout(() => finish(failure('Timeout')), timeout);
        req.end(payload);
      } catch (error) { finish(error?.status === 0 ? error : failure('TransportError')); }
    });
  }

  async function json(method, route, body, contentType) {
    const result = await request(method, route, body, contentType);
    if ((method === 'GET' || method === 'DELETE') && result.status === 404) return null;
    if (result.status < 200 || result.status >= 300) throw apiFailure(result.status, result.body, method === 'POST');
    if (!result.body.length) return {};
    try { return JSON.parse(result.body); }
    catch { throw failure('InvalidResponse', result.status); }
  }

  function podPath(ns, pod, container, operation) {
    if (![ns, pod, container].every(value => typeof value === 'string' && value.length > 0)) throw failure('InvalidOptions');
    return `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/${operation}`;
  }

  async function exec(ns, pod, container, cmd, { stdin, timeoutMs = 30000, connectTimeoutMs = timeout, maxOutputBytes = Infinity } = {}) {
    duration(timeoutMs); duration(connectTimeoutMs); byteLimit(maxOutputBytes);
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every(value => typeof value === 'string')
      || (stdin !== undefined && typeof stdin !== 'string' && !Buffer.isBuffer(stdin))) throw failure('InvalidOptions');
    const query = new URLSearchParams({ container, stdout: 'true', stderr: 'true', stdin: String(stdin !== undefined), tty: 'false' });
    cmd.forEach(value => query.append('command', value));
    const { url, tls, headers } = connection(`${podPath(ns, pod, container, 'exec')}?${query}`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      let socket, connectTimer, runTimer, settled = false, exitCode;
      const stdout = [], stderr = [], logs = [];
      let size = 0;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer); clearTimeout(runTimer);
        if (error) { reject(error); socket?.terminate(); }
        else resolve({ exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), logs: Buffer.concat(logs).toString() });
      };
      try {
        socket = new WebSocket(url, stdin === undefined ? ['v5.channel.k8s.io', 'v4.channel.k8s.io'] : ['v5.channel.k8s.io'], {
          ...tls, headers, followRedirects: false, perMessageDeflate: false,
          maxPayload: Number.isFinite(maxOutputBytes) ? Math.max(maxOutputBytes + 1, 65536) : 100 * 1024 * 1024,
        });
        connectTimer = setTimeout(() => finish(failure('ConnectTimeout')), connectTimeoutMs);
        socket.on('error', error => finish(failure(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' && Number.isFinite(maxOutputBytes)
          ? 'OutputLimitExceeded' : 'TransportError')));
        socket.on('unexpected-response', (req, res) => {
          finish(apiFailure(res.statusCode));
          res.destroy(); req.destroy();
        });
        socket.on('open', () => {
          clearTimeout(connectTimer);
          if (settled) return;
          if (socket.protocol !== 'v5.channel.k8s.io' && (stdin !== undefined || socket.protocol !== 'v4.channel.k8s.io')) {
            finish(failure('UnsupportedProtocol')); return;
          }
          runTimer = setTimeout(() => finish(failure('Timeout')), timeoutMs);
          if (stdin !== undefined) {
            const input = Buffer.from(stdin);
            // v5 closes stdin without closing stdout, stderr, or the status stream.
            const send = offset => {
              if (settled) return;
              const end = Math.min(offset + 65536, input.length);
              const frame = offset < input.length ? Buffer.concat([Buffer.from([0]), input.subarray(offset, end)]) : Buffer.from([255, 0]);
              socket.send(frame, error => {
                if (error) finish(failure('TransportError'));
                else if (offset < input.length) send(end);
              });
            };
            send(0);
          }
        });
        socket.on('message', (data, binary) => {
          if (settled) return;
          if (!binary || !data.length) { finish(failure('InvalidExecResponse')); return; }
          const channel = data[0], payload = data.subarray(1);
          if (channel === 1 || channel === 2) {
            size += payload.length;
            if (size > maxOutputBytes) { finish(failure('OutputLimitExceeded')); return; }
            (channel === 1 ? stdout : stderr).push(payload);
            logs.push(payload);
          } else if (channel === 3) {
            try {
              if (exitCode !== undefined) throw new Error();
              const status = JSON.parse(payload);
              if (status.status === 'Success') exitCode = 0;
              else if (status.reason === 'NonZeroExitCode') {
                const code = status.details?.causes?.find(cause => cause.reason === 'ExitCode')?.message;
                if (typeof code !== 'string' || !/^[1-9][0-9]*$/.test(code) || !Number.isSafeInteger(Number(code))) throw new Error();
                exitCode = Number(code);
              } else throw new Error();
            } catch { finish(failure('InvalidExecStatus')); }
          } else if (!(channel === 255 && socket.protocol === 'v5.channel.k8s.io' && payload.length === 1 && payload[0] <= 3)) {
            finish(failure('InvalidExecResponse'));
          }
        });
        socket.on('close', code => {
          if (code !== 1000 && code !== 1005) finish(failure('TransportError'));
          else if (exitCode === undefined) finish(failure('MissingExecStatus'));
          else finish();
        });
      } catch { finish(failure('TransportError')); }
    });
  }

  async function logs(ns, pod, container, { limitBytes = Infinity } = {}) {
    byteLimit(limitBytes);
    const query = new URLSearchParams({ container });
    if (Number.isFinite(limitBytes)) query.set('limitBytes', String(limitBytes));
    const result = await request('GET', `${podPath(ns, pod, container, 'log')}?${query}`, undefined, undefined, limitBytes);
    if (result.status < 200 || result.status >= 300) throw apiFailure(result.status, result.body);
    return result.body.toString();
  }

  async function waitFor(fn, { timeoutMs = timeout, intervalMs = 200 } = {}) {
    duration(timeoutMs); duration(intervalMs);
    return new Promise((resolve, reject) => {
      let finished = false, pollTimer;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline); clearTimeout(pollTimer);
        if (error) reject(error); else resolve(value);
      };
      const deadline = setTimeout(() => finish(failure('Timeout')), timeoutMs);
      const poll = async () => {
        try {
          const result = await fn();
          if (finished) return;
          if (result) finish(null, result);
          else pollTimer = setTimeout(poll, intervalMs);
        } catch (error) { finish(error); }
      };
      poll();
    });
  }

  return {
    namespace: config.namespace,
    get: route => json('GET', route),
    create: (route, body) => json('POST', route, body),
    patch: async (route, body, type = 'merge') => {
      if (type !== 'merge' && type !== 'json') throw failure('InvalidPatchType');
      return json('PATCH', route, body, `application/${type === 'merge' ? 'merge-patch' : 'json-patch'}+json`);
    },
    remove: async (route, { propagationPolicy, gracePeriodSeconds } = {}) => {
      const result = await json('DELETE', route, { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy, gracePeriodSeconds });
      return result !== null;
    },
    exec, logs, waitFor,
  };
}
