// Pictures attached to a comment (a screenshot, a photo). Same rules as profile pictures: checked by
// their bytes, never by a name or a declared type; PNG, JPEG and WebP only (SVG is scriptable, GIF and
// HTML are refused); the server never fetches anything from a URL, the page uploads the bytes. Bigger
// than an avatar, because a phone photo is several MB.
import { imageSize, sniffImage } from './avatar.mjs';

/** Largest accepted file (a 12-megapixel phone photo is 3 to 6 MB). */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Largest accepted side in pixels: a small file can still declare huge dimensions. */
export const ATTACHMENT_MAX_SIDE = 12000;
/** Pictures kept per ticket, linked or still waiting for their comment. */
export const ATTACHMENTS_PER_TICKET = 40;
/** Pictures a single comment can carry. */
export const ATTACHMENTS_PER_COMMENT = 8;

/** Check an uploaded picture. Returns `{ mime, width, height }` or throws an error carrying an HTTP status. */
export function checkAttachment(buf) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!buf || !buf.length) throw fail(400, 'empty image');
  if (buf.length > ATTACHMENT_MAX_BYTES) throw fail(413, `image too large (max ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MiB)`);
  const mime = sniffImage(buf);
  if (!mime) throw fail(415, 'only PNG, JPEG or WebP images');
  const size = imageSize(buf, mime);
  if (!size || !size.width || !size.height) throw fail(422, 'unreadable image header');
  if (size.width > ATTACHMENT_MAX_SIDE || size.height > ATTACHMENT_MAX_SIDE) throw fail(422, `image too big (max ${ATTACHMENT_MAX_SIDE}×${ATTACHMENT_MAX_SIDE} px)`);
  return { mime, ...size };
}
