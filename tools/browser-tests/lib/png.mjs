// Tiny PNG encoder for fixtures. With noise the file is incompressible, which makes its size predictable.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
}

export function png(width, height, [r, g, b] = [0, 0, 0], { noise = false } = {}) {
  const row = width * 3 + 1, raw = Buffer.alloc(row * height);
  if (noise) crypto.randomFillSync(raw);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    if (!noise) for (let x = 0; x < width; x++) { const o = y * row + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: noise ? 0 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Smallest noise PNG that is larger than the given number of bytes. */
export function pngLargerThan(bytes) {
  let side = 16, image;
  do { side += 16; image = png(side, side, [0, 0, 0], { noise: true }); } while (image.length <= bytes);
  return image;
}

export const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export const file = (name, buffer, mimeType = 'image/png') => ({ name, mimeType, buffer });
