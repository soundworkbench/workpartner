import { createBrotliCompress, createGzip, constants, brotliCompressSync, gzipSync } from 'node:zlib';

export function encodingFor(req) {
  const value = String(req.headers?.['accept-encoding'] || '').toLowerCase();
  if (/(^|,|\s)br(?:\s*;|\s|,|$)/.test(value)) return 'br';
  if (/(^|,|\s)gzip(?:\s*;|\s|,|$)/.test(value)) return 'gzip';
  return null;
}

export function mergeVary(value, token) {
  const values = String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!values.some(v => v.toLowerCase() === token.toLowerCase())) values.push(token);
  return values.join(', ');
}

export function compressible(headers, status, req, encoding) {
  if (!encoding || process.env.WP_GATEWAY_COMPRESS === '0' || req.method === 'HEAD' || status === 204 || status === 304) return false;
  if (headers['content-encoding'] || String(headers['x-accel-buffering'] || '').toLowerCase() === 'no') return false;
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
