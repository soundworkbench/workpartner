import http from 'node:http';
import https from 'node:https';
import { voiceClient } from './voice-client.mjs';

const API = '/_wp/api/voice/recognize';
const MAX = 2 * 1024 * 1024;

function read(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const fail = status => {
      req.pause(); req.removeListener('data', data); req.removeListener('end', end);
      chunks.length = 0; reject(Object.assign(new Error('Voice request failed'), { status }));
    };
    const data = chunk => { size += chunk.length; if (size > MAX) fail(413); else chunks.push(chunk); };
    const end = () => resolve(Buffer.concat(chunks));
    req.on('error', () => fail(400)); req.on('aborted', () => fail(400));
    if (Number(req.headers['content-length']) > MAX) return fail(413);
    req.on('data', data); req.on('end', end);
  });
}

function upstream(base, body, timeoutMs) {
  return new Promise(resolve => {
    let request, timer, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); request?.destroy(); };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const target = new URL(base.replace(/\/+$/, '') + '/v1/recognize');
      const transport = target.protocol === 'http:' ? http : target.protocol === 'https:' ? https : null;
      if (!transport || target.username || target.password) return finish(null);
      request = transport.request(target, { method: 'POST', headers: { 'content-type': 'audio/wav', 'content-length': body.length } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) finish(null); else chunks.push(chunk); });
        response.on('error', () => finish(null));
        response.on('end', () => {
          try { finish({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish(null); }
        });
      });
      request.on('error', () => finish(null)); request.end(body);
    } catch { finish(null); }
  });
}

export function createVoice({ organization, organizationData, authenticate, asrUrl = process.env.WP_ASR_URL || 'http://wp-asr:8080', timeoutMs = 30000 }) {
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  const active = new Set();
  function policy() {
    try {
      const data = organizationData();
      return { enabled: data?.features?.voice === true,
        allow: Array.isArray(data?.voice?.allow) && data.voice.allow.every(v => typeof v === 'string') ? data.voice.allow : [] };
    } catch { return { enabled: false, allow: [] }; }
  }
  const admitted = (user, config) => Boolean(config.enabled && typeof user?.slug === 'string'
    && /^[a-z0-9][a-z0-9-]{0,62}$/.test(user.slug) && user?.unionId
    && config.allow.some(v => v === '*' || v === user.slug || v === user.unionId));
  const reply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(status === 413 ? { connection: 'close' } : {}) });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  const handle = async (req, res, url) => {
    if (url.pathname !== API) return false;
    let owner;
    try {
      const user = authenticate(req);
      if (!admitted(user, policy())) { reply(res, 404); return true; }
      if (req.method !== 'POST') { reply(res, 405); return true; }
      if (req.headers.origin !== origin) { reply(res, 403); return true; }
      if (!/^audio\/wav(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { reply(res, 415); return true; }
      if (active.has(user.unionId)) { reply(res, 429, { error: 'busy' }); return true; }
      owner = user.unionId; active.add(owner);
      const result = await upstream(asrUrl, await read(req), timeoutMs);
      if (result?.status === 200 && typeof result.data?.text === 'string') reply(res, 200, { text: Array.from(result.data.text).slice(0, 2000).join('') });
      else if (result?.status === 400 && ['bad_audio', 'too_long'].includes(result.data?.error)) reply(res, 400, { error: result.data.error });
      else if (result?.status === 503) reply(res, 503, { error: 'busy' });
      else reply(res, 503, { error: 'unavailable' });
    } catch (error) {
      if (error.status === 413) res.once('finish', () => req.destroy());
      reply(res, error.status || 503, { error: error.status === 413 ? 'too_large' : 'unavailable' });
    } finally { if (owner) active.delete(owner); }
    return true;
  };
  handle.clientFor = user => admitted(user, policy()) ? voiceClient() : '';
  return handle;
}
