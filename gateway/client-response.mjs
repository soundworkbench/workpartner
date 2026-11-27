import crypto from 'node:crypto';
import { compressBuffer, compressible, encodedEtag, encodingFor, mergeVary } from './compress.mjs';

export function clientResponse(req, res, body, headers = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const base = `"${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20)}"`;
  const encoding = encodingFor(req);
  const sourceHeaders = { 'content-type': 'text/javascript; charset=utf-8', ...headers, 'content-length': String(raw.length) };
  const useCompression = compressible(sourceHeaders, 200, req, encoding);
  const output = useCompression ? compressBuffer(raw, encoding) : raw;
  const etag = encodedEtag(base, useCompression ? encoding : null);
  if (req.headers?.['if-none-match'] && String(req.headers['if-none-match']).split(',').some(v => v.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''))) {
    res.writeHead(304, { etag, 'cache-control': 'private, no-cache', vary: useCompression ? 'cookie, accept-encoding' : 'cookie' });
    return res.end();
  }
  const out = { ...headers, etag, 'cache-control': 'private, no-cache', vary: mergeVary(headers.vary, 'cookie') };
  if (useCompression) { out['content-encoding'] = encoding; out.vary = mergeVary(out.vary, 'accept-encoding'); }
  out['content-length'] = String(output.length);
  res.writeHead(200, out); res.end(output);
}
