// Profile pictures: one small raster image per actor, checked by its bytes, never by a name or a
// declared type. SVG (scriptable), GIF, HTML and anything else are refused. The server never fetches
// an image from a URL (no SSRF): the page uploads the bytes.

/** Largest accepted file. The page resizes to 256 px before sending, so this is a generous bound. */
export const AVATAR_MAX_BYTES = 256 * 1024;
/** Largest accepted side in pixels: a small file can still declare huge dimensions. */
export const AVATAR_MAX_SIDE = 1024;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `image/png`, `image/jpeg` or `image/webp` from the magic bytes; null for anything else. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (PNG_SIG.every((b, i) => buf[i] === b)) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Width and height read from the header, or null when the header cannot be read. */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') {
      if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
      return null;
    }
  } catch {}
  return null;
}

/**
 * Check an uploaded avatar. Returns `{ mime, width, height }` or throws an error with an HTTP status
 * (413 too large, 415 not a PNG/JPEG/WebP, 422 unreadable or too many pixels).
 */
export function checkAvatar(buf) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!buf || !buf.length) throw fail(400, 'empty image');
  if (buf.length > AVATAR_MAX_BYTES) throw fail(413, `image too large (max ${AVATAR_MAX_BYTES / 1024} KiB)`);
  const mime = sniffImage(buf);
  if (!mime) throw fail(415, 'only PNG, JPEG or WebP images');
  const size = imageSize(buf, mime);
  if (!size || !size.width || !size.height) throw fail(422, 'unreadable image header');
  if (size.width > AVATAR_MAX_SIDE || size.height > AVATAR_MAX_SIDE) throw fail(422, `image too big (max ${AVATAR_MAX_SIDE}×${AVATAR_MAX_SIDE} px)`);
  return { mime, ...size };
}
