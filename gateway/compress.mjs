import { createBrotliCompress, createGzip, constants, brotliCompressSync, gzipSync } from 'node:zlib';

export function encodingFor(req) {
  const qualities = new Map(String(req.headers?.['accept-encoding'] || '').toLowerCase().split(',').map(item => {
    const [name, ...params] = item.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    return [name.trim(), Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0];
  }));
  for (const name of ['br', 'gzip']) if ((qualities.get(name) ?? qualities.get('*') ?? 0) > 0) return name;
  return null;
}

export function mergeVary(value, token) {
  const values = String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!values.some(v => v.toLowerCase() === token.toLowerCase())) values.push(token);
  return values.join(', ');
}

export function compressible(headers, status, req, encoding) {
  if (!encoding || process.env.WP_GATEWAY_COMPRESS === '0' || req.method !== 'GET' || status === 204 || status === 206 || status === 304) return false;
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://gateway').pathname); } catch { return false; }
  if (req.headers?.range !== undefined || /^\/api(?:\/|$)/i.test(pathname) || headers['set-cookie'] !== undefined
    || /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(String(headers['cache-control'] || ''))) return false;
  if (headers['content-encoding'] !== undefined || String(headers['x-accel-buffering'] || '').toLowerCase() === 'no') return false;
  const type = String(headers['content-type'] || '').toLowerCase().split(';', 1)[0].trim();
  if (type === 'text/event-stream' || !(type.startsWith('text/') || ['application/javascript', 'application/json', 'image/svg+xml', 'application/manifest+json'].includes(type))) return false;
  const length = Number(headers['content-length']);
  return !Number.isFinite(length) || length >= 1024;
}

export function compressor(encoding) {
  if (encoding === 'br') return createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  if (encoding === 'gzip') return createGzip({ level: 6 });
  return null;
}

export function compressBuffer(body, encoding) {
  if (encoding === 'br') return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
  if (encoding === 'gzip') return gzipSync(body, { level: 6 });
  return body;
}

export function encodedEtag(etag, encoding) {
  if (!etag || !encoding) return etag;
  const value = String(etag).replace(/^W\//, '');
  return `W/${value.slice(0, -1)}-${encoding}"`;
}
