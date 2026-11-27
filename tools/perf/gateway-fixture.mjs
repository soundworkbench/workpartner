// Real gateway entry point with synthetic organization, sessions and personal runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable, Writable, PassThrough } from 'node:stream';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function gatewayFixture({ address, delay = 0, autoTitle = false, root = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const { organizationData, nextModelConfig } = await import(pathToFileURL(path.join(root, 'gateway/organization/resolve.mjs')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-load-'));
  const org = structuredClone(organizationData({}));
  org.publicHost = 'perf.test';
  org.model.baseUrl = 'http://models.invalid/v1';
  for (const name of Object.keys(org.features)) org.features[name] = false;
  org.features.feishuBot = org.features.feishuOnboarding = true;
  org.features.autoTitle = autoTitle;
  org.feishuBot = { allow: ['*'], subAgents: { allow: ['*'] } };
  org.extensions = {};
  org.dataTools = null;
  org.market.sharedDirectory = path.join(dir, 'shared');
  Object.assign(org.runtime, { kind: 'docker', gatewayPort: 0, internalPort: 0, uid: process.getuid(),
    nextImage: 'fixture-image', sessionKeyFile: path.join(dir, 'session.key'), usersFile: path.join(dir, 'users.json'),
    stateDirectory: path.join(dir, 'state'), secureDirectory: path.join(dir, 'secure'), nextDirectory: path.join(dir, 'workspaces') });
  const user = { slug: 'perf-user', unionId: 'perf-union', backend: 'aionui' };
  const other = { slug: 'other-user', unionId: 'other-union', backend: 'aionui' };
  const key = 'synthetic-perf-session-key';
  fs.mkdirSync(path.join(dir, 'secure/aionui'), { recursive: true });
  for (const u of [user, other]) fs.writeFileSync(path.join(dir, `secure/aionui/aionui-${u.slug}.pass`), 'synthetic-password');
  fs.writeFileSync(path.join(dir, 'secure', org.model.keyPrefix + user.slug + '.key'), 'synthetic-model-key');
  fs.writeFileSync(org.runtime.sessionKeyFile, key);
  fs.writeFileSync(org.runtime.usersFile, JSON.stringify([user, other]));
  fs.writeFileSync(path.join(dir, 'organization.json'), JSON.stringify(org));
  const calls = [];
  const runtime = {
    inspect: async () => ({ exists: true, running: true, image: 'fixture-image', imageId: 'sha256:fixture',
      address, env: ['WORKPARTNER_MODEL_CONFIG=' + JSON.stringify(nextModelConfig(org))] }),
    imageId: async () => 'sha256:fixture', ensureIsolation: async () => {},
    exec: async (slug, argv) => {
      calls.push({ slug, argv });
      await new Promise(resolve => setTimeout(resolve, delay));
      const data = argv.includes('status') ? { status: 'connected' } : { ok: true, bots: [] };
      const stdout = JSON.stringify(data);
      return { exitCode: 0, stdout, logs: stdout };
    },
  };
  globalThis.__gatewayLoadRuntime = runtime;
  const runtimeUrl = pathToFileURL(path.join(root, 'gateway/runtime/index.mjs')).href;
  const hook = registerHooks({ load(url, context, next) {
    if (url === runtimeUrl) return { format: 'module', shortCircuit: true,
      source: 'export const createRuntime = () => globalThis.__gatewayLoadRuntime; export const createLegacyRuntime = () => ({});' };
    return next(url, context);
  } });
  const previousOrg = process.env.WORKPARTNER_ORG_DIR;
  process.env.WORKPARTNER_ORG_DIR = dir;
  const listen = http.Server.prototype.listen;
  let server;
  http.Server.prototype.listen = function () { server = this; return this; };
  try { await import(pathToFileURL(path.join(root, 'gateway/gateway.mjs'))); }
  catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { http.Server.prototype.listen = listen; hook.deregister(); delete globalThis.__gatewayLoadRuntime; }
  const cookieFor = u => {
    const data = Buffer.from(JSON.stringify({ u: u.unionId, n: u.slug, e: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    return `wp_sid=${data}.${crypto.createHmac('sha256', key).update(data).digest('base64url')}`;
  };
  return { server, calls, org, cookie: cookieFor(user), otherCookie: cookieFor(other), close() {
    server.closeAllConnections(); server.close();
    if (previousOrg === undefined) delete process.env.WORKPARTNER_ORG_DIR; else process.env.WORKPARTNER_ORG_DIR = previousOrg;
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

// Only the transport is replaced; both HTTP server handlers and all gateway code still run.
export function memoryTransport(servers) {
  const original = http.request;
  http.request = (options, callback) => {
    const chunks = [];
    const outgoing = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); }, final(done) {
      const server = servers.get(options.port);
      if (!server) { done(new Error('Unknown fixture port')); return; }
      const req = Readable.from(chunks);
      Object.assign(req, { url: options.path, method: options.method || 'GET', headers: options.headers || {}, socket: { remoteAddress: '127.0.0.1' } });
      const res = new PassThrough();
      res.headers = {}; res.statusCode = 200;
      res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
      res.writeHead = (status, headers = {}) => {
        res.statusCode = status; Object.assign(res.headers, headers); res.headersSent = true;
        callback(res); return res;
      };
      queueMicrotask(() => {
        Promise.resolve(server.listeners('request')[0](req, res)).catch(error => res.destroy(error));
      });
      done();
    } });
    return outgoing;
  };
  return () => { http.request = original; };
}
