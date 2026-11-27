import crypto from 'node:crypto';
import { compressBuffer, compressible, encodedEtag, encodingFor, mergeVary } from './compress.mjs';

export function clientResponse(req, res, body, headers = {}, { compress = true, cache = true } = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const base = cache ? `"${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20)}"` : undefined;
  const encoding = encodingFor(req);
  const sourceHeaders = { 'content-type': 'text/javascript; charset=utf-8', ...headers, 'content-length': String(raw.length) };
  const useCompression = cache && compress && compressible(sourceHeaders, 200, req, encoding);
  const etag = base && encodedEtag(base, useCompression ? encoding : null);
  const cacheControl = cache ? 'private, no-cache' : 'no-store';
  if (cache && req.headers?.['if-none-match'] && String(req.headers['if-none-match']).split(',').some(v => v.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
    res.writeHead(304, { etag, 'cache-control': cacheControl, vary: useCompression ? 'cookie, accept-encoding' : 'cookie' });
    return res.end();
  }
  const output = useCompression ? compressBuffer(raw, encoding) : raw;
  const out = { ...headers, 'cache-control': cacheControl };
  if (cache) { out.etag = etag; out.vary = mergeVary(headers.vary, 'cookie'); }
  if (useCompression) { out['content-encoding'] = encoding; out.vary = mergeVary(out.vary, 'accept-encoding'); }
  out['content-length'] = String(output.length);
  res.writeHead(200, out); res.end(req.method === 'HEAD' ? undefined : output);
}
