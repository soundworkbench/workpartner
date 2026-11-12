/** Composer voice input: the browser records, the gateway transcribes with the person's own model key. */
import crypto from 'node:crypto';
import { voiceInputClient } from './voice-input-client.mjs';

const API = '/_wp/api/voice-input';
export const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
const fail = status => Object.assign(new Error('Voice input request failed'), { status });

/** Normalize the live voiceInput section; anything invalid disables admission or falls back to defaults. */
export function voicePolicy(config, defaultLanguage) {
  const object = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const allow = Array.isArray(object.allow) && object.allow.every(v => typeof v === 'string') ? object.allow : [];
  const model = typeof object.model === 'string' && /^[\w.:/@-]{1,200}$/.test(object.model) ? object.model : '';
  const language = typeof object.language === 'string' && /^[a-z]{2,3}$/.test(object.language) ? object.language
    : (/^([a-z]{2,3})(?:-|$)/i.exec(String(defaultLanguage || ''))?.[1].toLowerCase() || '');
  const maxSeconds = Number.isInteger(object.maxSeconds) ? Math.max(5, Math.min(300, object.maxSeconds)) : 60;
  const maxBytes = Number.isInteger(object.maxBytes) ? Math.max(65536, Math.min(25 * 1024 * 1024, object.maxBytes)) : 5 * 1024 * 1024;
  return { allow, model, language, maxSeconds, maxBytes };
}

/** Accept only known recorder containers, ignoring codec parameters. */
export function audioExtension(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return Object.hasOwn(AUDIO_TYPES, type) ? { type, extension: AUDIO_TYPES[type] } : null;
}

/** Build an OpenAI-compatible transcription form without third-party dependencies. */
export function transcriptionForm({ audio, type, extension, model, language }) {
  const boundary = 'wp-voice-' + crypto.randomBytes(12).toString('hex');
  const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const parts = [field('model', model), field('response_format', 'json')];
  if (language) parts.push(field('language', language));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${extension}"\r\nContent-Type: ${type}\r\n\r\n`),
    audio, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function readAudio(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, oversized = false;
    req.on('data', chunk => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxBytes) { oversized = true; chunks.length = 0; reject(fail(413)); }
      else chunks.push(chunk);
    });
    req.on('error', () => reject(fail(400)));
    req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
  });
}

export function createVoiceInput({ organization, organizationData, authenticate, sessionAuthenticate = () => null, keyFor, fetcher = fetch, timeoutMs = 60000 }) {
  const origin = organization.server.publicOrigin || `https://${organization.server.publicHost}`;
  const base = organization.model.baseUrl.endsWith('/') ? organization.model.baseUrl : organization.model.baseUrl + '/';
  const inFlight = new Set();
  function policy() {
    try { return voicePolicy(organizationData()?.voiceInput, organization.model.defaults?.language); }
    catch { return voicePolicy(null); }
  }
  const admitted = (user, config) => Boolean(config.model && user?.slug && user?.unionId
    && config.allow.some(v => v === '*' || v === user.slug || v === user.unionId));
  const reply = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      ...(data === undefined ? { 'content-length': 0 } : {}) });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  const handle = async (req, res, url) => {
    if (url.pathname !== API) return false;
    let user;
    try {
      user = authenticate(req);
      if (!user && !sessionAuthenticate(req)) throw fail(401);
      const config = policy();
      if (!admitted(user, config)) { reply(res, 404); return true; }
      if (req.method !== 'POST') throw fail(405);
      const audioType = audioExtension(req.headers['content-type']);
      if (req.headers.origin !== origin || !audioType) throw fail(403);
      if (inFlight.has(user.slug)) throw fail(429);
      inFlight.add(user.slug);
      try {
        const audio = await readAudio(req, config.maxBytes);
        if (!audio.length) throw fail(400);
        let key;
        try { key = (await keyFor(user))?.trim(); } catch { key = ''; }
        if (!key) throw fail(503);
        const form = transcriptionForm({ audio, ...audioType, model: config.model, language: config.language });
        let response;
        try {
          response = await fetcher(new URL('audio/transcriptions', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            headers: { authorization: `Bearer ${key}`, 'content-type': form.contentType, 'user-agent': 'workpartner-gateway' }, body: form.body });
        } catch { throw fail(502); }
        if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw fail(502); }
        let data;
        try { data = await response.json(); } catch { throw fail(502); }
        if (typeof data?.text !== 'string') throw fail(502);
        reply(res, 200, { text: data.text.trim().slice(0, 20000) });
      } finally { inFlight.delete(user.slug); }
    } catch (error) {
      // Never log audio, transcripts, keys or upstream bodies.
      if (!error.status || error.status >= 500) console.error('[voice-input] ' + (error.status || 'UNAVAILABLE'));
      reply(res, error.status || 503, { error: 'Voice input request failed' });
    }
    return true;
  };
  handle.clientFor = user => {
    const config = policy();
    return admitted(user, config) ? voiceInputClient({ maxSeconds: config.maxSeconds, maxBytes: config.maxBytes }) : '';
  };
  return handle;
}
