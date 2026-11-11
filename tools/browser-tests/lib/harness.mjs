// Local stand-in for a deployment, bound to 127.0.0.1 on ephemeral ports only:
//   browser -> TLS front (self-signed, generated per run) -> the REAL gateway/gateway.mjs -> fixture upstream.
// Fixture parts: the upstream application (a static page built from the real overlay files), the container
// API, the user list and the signed sessions. Every name, host, key and token below is a made-up test value.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite } from './site.mjs';

export const HOST = 'workspace.example.test';
export const ORIGIN = `https://${HOST}`;
export const PREVIEW_HOST = 'preview.example.test';
export const repo = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const outputRoot = path.resolve(process.env.BROWSER_TESTS_OUTPUT || fileURLToPath(new URL('../output', import.meta.url)));

// "pending" has a valid session but no workspace; it is deliberately absent from the user list.
export const USERS = [
  { slug: 'member', unionId: 'union-member', name: 'Test Member', backend: 'aionui' },
  { slug: 'member2', unionId: 'union-member2', name: 'Second Member', backend: 'aionui' },
  { slug: 'handler', unionId: 'union-handler', name: 'Test Handler', backend: 'aionui' },
  { slug: 'outsider', unionId: 'union-outsider', name: 'Test Outsider', backend: 'aionui' },
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

export async function createHarness(group) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-browser-tests-'));
  const logs = path.join(outputRoot, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const staticDir = buildSite(repo, path.join(work, 'site'));
  const { organizationData, nextModelConfig } = await import(pathToFileURL(path.join(repo, 'gateway/organization/resolve.mjs')).href);
  const sessionKey = crypto.randomBytes(24).toString('hex');
  const gateways = [];

  // Fixture upstream: login always succeeds, API calls return an empty list, everything else is a static file.
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream');
    if (url.pathname === '/login') { res.writeHead(200, { 'set-cookie': 'fixture-session=1; HttpOnly' }); return res.end('{}'); }
    if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"success":true,"data":[]}'); }
    const file = path.resolve(staticDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file.startsWith(staticDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  const upstreamPort = await listen(upstream);

  const tls = path.join(work, 'tls');
  fs.mkdirSync(tls);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-keyout', path.join(tls, 'key.pem'), '-out', path.join(tls, 'cert.pem')], { stdio: 'ignore' });
  let target = 0;
  const front = https.createServer({ key: fs.readFileSync(path.join(tls, 'key.pem')), cert: fs.readFileSync(path.join(tls, 'cert.pem')) }, (req, res) => {
    const proxy = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers },
      reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    proxy.on('error', error => { res.writeHead(502); res.end(String(error)); });
    req.pipe(proxy);
  });
  const frontPort = await listen(front);

  function cookie(who) {
    const user = USERS.find(u => u.slug === who) || { unionId: 'union-' + who, name: 'Pending Person' };
    const data = Buffer.from(JSON.stringify({ u: user.unionId, n: user.name, e: Math.floor(Date.now() / 1000) + 6 * 3600 })).toString('base64url');
    return data + '.' + crypto.createHmac('sha256', sessionKey).update(data).digest('base64url');
  }

  async function startGateway(name, { preview = true, feedback = true, allow = ['member'], handlers = ['union-handler'], maxImageBytes = 300000, maxImagesPerItem = 3 } = {}) {
    const run = path.join(work, 'run-' + name);
    fs.mkdirSync(path.join(run, 'secure/aionui'), { recursive: true });
    const org = structuredClone(organizationData({}));
    org.market.sharedDirectory = path.join(run, 'shared-skills');
    org.publicHost = HOST;
    org.model.baseUrl = 'http://127.0.0.1:9/v1';
    for (const key of Object.keys(org.features)) org.features[key] = false;
    org.features.preview = preview;
    org.features.feedback = feedback;
    Object.assign(org.runtime, { gatewayPort: 0, internalPort: 0, uid: process.getuid(), nextImage: 'fixture-image', nextPort: upstreamPort,
      sessionKeyFile: path.join(run, 'session.key'), usersFile: path.join(run, 'users.json'), cookieFile: path.join(run, 'cookies.json'),
      nextDirectory: path.join(run, 'workspaces'), stateDirectory: path.join(run, 'state'), secureDirectory: path.join(run, 'secure') });
    const botToken = 'fixture-bot-token-' + crypto.randomBytes(6).toString('hex');
    org.feedback = { ...org.feedback, allow, handlers, botTokenFile: path.join(run, 'feedback-bot.token'), maxImageBytes, maxImagesPerItem };
    org.identity.appId = 'fixture-app';
    org.identity.appSecretFile = path.join(run, 'identity.secret');
    fs.writeFileSync(org.feedback.botTokenFile, botToken + '\n');
    fs.writeFileSync(org.runtime.sessionKeyFile, sessionKey);
    fs.writeFileSync(org.identity.appSecretFile, 'fixture-app-secret');
    for (const user of USERS) {
      fs.writeFileSync(path.join(run, `secure/aionui/aionui-${user.slug}.pass`), 'fixture-password');
      fs.writeFileSync(path.join(run, `secure/model-${user.slug}.key`), 'fixture-model-key');
    }
    fs.writeFileSync(org.runtime.usersFile, JSON.stringify(USERS));

    // Fixture container API: every workspace container exists, runs the expected image and is reachable on loopback.
    const networks = Object.fromEntries(USERS.map(u => [`workpartner-next-${u.slug}-net`, { IPAddress: '127.0.0.1' }]));
    const docker = http.createServer(async (req, res) => {
      for await (const _ of req);
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/exec')) { res.writeHead(201); return res.end('{"Id":"command"}'); }
      if (req.url === '/exec/command/json') return res.end('{"ExitCode":0}');
      if (req.url === '/exec/command/start') {
        const bytes = Buffer.from('{"skills":[]}'), header = Buffer.alloc(8);
        header[0] = 1; header.writeUInt32BE(bytes.length, 4);
        return res.end(Buffer.concat([header, bytes]));
      }
      if (req.url.startsWith('/containers/')) return res.end(JSON.stringify({ Config: { Image: 'fixture-image', Env: [
        'WORKPARTNER_MODEL_CONFIG=' + JSON.stringify(nextModelConfig(org)), 'WORKPARTNER_SHARED_SKILLS=' + org.market.containerDirectory,
        'WORKPARTNER_MARKET_PREINSTALLED=' + JSON.stringify(org.market.preinstalled)] },
      Image: 'sha256:fixture', State: { Running: true }, NetworkSettings: { Networks: networks } }));
      if (req.url.startsWith('/images/')) return res.end('{"Id":"sha256:fixture"}');
      if (req.url.startsWith('/networks/')) return res.end('{"Containers":{}}');
      res.writeHead(500); res.end('{}');
    });
    const dockerPort = await listen(docker);
    const organizationFile = path.join(run, 'organization.json');
    fs.writeFileSync(organizationFile, JSON.stringify(org, null, 2));

    // Preloaded into the gateway process: the container socket goes to the fixture, listeners move to
    // 127.0.0.1 on an ephemeral port (reported back over IPC), and anything that is not loopback is refused.
    const transport = path.join(run, 'transport.mjs');
    fs.writeFileSync(transport, `
import http from 'node:http';
import https from 'node:https';
const request = http.request;
const local = host => !host || host === '127.0.0.1' || host === 'localhost';
http.request = (options, ...rest) => {
  if (typeof options === 'string' || options instanceof URL) {
    const url = new URL(options);
    if (!local(url.hostname)) throw new Error('fixture: blocked ' + url.hostname);
    return request.call(http, options, ...rest);
  }
  if (options.socketPath) return request.call(http, { ...options, socketPath: undefined, host: '127.0.0.1', port: ${dockerPort} }, ...rest);
  if (!local(options.host || options.hostname)) throw new Error('fixture: blocked ' + (options.host || options.hostname));
  return request.call(http, options, ...rest);
};
https.request = () => { throw new Error('fixture: https blocked'); };
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  const callback = typeof args.at(-1) === 'function' ? args.at(-1) : null;
  this.once('listening', () => process.send({ kind: callback ? 'gateway' : 'internal', port: this.address().port }));
  return listen.call(this, 0, '127.0.0.1', ...(callback ? [callback] : []));
};
globalThis.fetch = async url => { throw new Error('fixture: external fetch blocked ' + String(url).slice(0, 80)); };
`);
    const child = fork(path.join(repo, 'gateway/gateway.mjs'), [], { execArgv: ['--import', pathToFileURL(transport).href], silent: true,
      env: { PATH: process.env.PATH, WORKPARTNER_ORG_DIR: run, ...(preview ? { PREVIEW_HOST } : {}) } });
    const logFile = path.join(logs, `${group}-gateway-${name}.log`);
    const log = fs.createWriteStream(logFile);
    child.stdout.pipe(log); child.stderr.pipe(log);
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway ${name}: startup timeout, see ${logFile}`)), 20000);
      child.on('message', message => { if (message.kind === 'gateway') { clearTimeout(timer); resolve(message.port); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway ${name}: exited with ${code}, see ${logFile}`)); });
    });

    const gateway = {
      name, port, preview, feedback, botToken,
      // The gateway re-reads the organization file on every request, so this takes effect immediately.
      setPolicy(nextAllow, nextHandlers = handlers) {
        const data = JSON.parse(fs.readFileSync(organizationFile, 'utf8'));
        data.feedback.allow = nextAllow; data.feedback.handlers = nextHandlers;
        fs.writeFileSync(organizationFile + '.tmp', JSON.stringify(data, null, 2));
        fs.renameSync(organizationFile + '.tmp', organizationFile);
      },
      /** Plain HTTP straight to the gateway port, with the public Host header. */
      async request(method, route, { who = 'none', bot = false, body, raw = false, headers = {} } = {}) {
        const all = { host: HOST, ...headers };
        if (bot) all.authorization = 'Bearer ' + botToken;
        else if (who !== 'none') all.cookie = 'wp_sid=' + cookie(who);
        if (method === 'POST') {
          if (!bot) all.origin = ORIGIN;
          all['content-type'] = raw ? 'application/octet-stream' : 'application/json';
        }
        const req = http.request({ host: '127.0.0.1', port, method, path: route, headers: all });
        req.end(body === undefined ? undefined : raw ? body : JSON.stringify(body));
        const [res] = await once(req, 'response');
        const bytes = await collect(res);
        let json = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* Not every reply is JSON. */ }
        return { status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: bytes, json };
      },
      async stop() {
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
        docker.close(); log.end();
      },
    };
    gateways.push(gateway);
    if (!target) target = port;
    return gateway;
  }

  return {
    group, frontPort, sessionKey, cookie, startGateway,
    /** Point the browser-facing front at another gateway. */
    use(gateway) { target = gateway.port; },
    async stop() {
      for (const gateway of gateways) await gateway.stop();
      front.close(); upstream.close();
      front.closeAllConnections?.(); upstream.closeAllConnections?.();
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

/** Create one feedback item through the real API and return it. */
export async function seedItem(gateway, { who = 'member', type = 'bug', title, body = 'Seeded by the browser tests.', images = [], comments = [], bot } = {}) {
  const created = await gateway.request('POST', '/_wp/api/feedback', { who, body: { type, title, body } });
  if (created.status !== 201) throw new Error(`seed: create returned ${created.status} ${created.body}`);
  const { id } = created.json.item;
  for (const [index, bytes] of images.entries()) {
    const reply = await gateway.request('POST', `/_wp/api/feedback/items/${id}/files?filename=${encodeURIComponent(`seed-${index + 1}.png`)}`, { who, body: bytes, raw: true });
    if (reply.status !== 201) throw new Error(`seed: upload returned ${reply.status} ${reply.body}`);
  }
  for (const text of comments) {
    const reply = await gateway.request('POST', `/_wp/api/feedback/items/${id}/comments`, { who, body: { text } });
    if (reply.status !== 200) throw new Error(`seed: comment returned ${reply.status} ${reply.body}`);
  }
  if (bot) {
    const reply = await gateway.request('POST', `/_wp/api/feedback/bot/items/${id}`, { bot: true, body: bot });
    if (reply.status !== 200) throw new Error(`seed: bot update returned ${reply.status} ${reply.body}`);
  }
  return created.json.item;
}
