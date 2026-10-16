// Files attached to a ticket or a comment (0.5.16 pictures, 0.5.18 any file). The type is decided by the
// bytes, never by a name or a declared type. Only a short list is ever shown in the browser (PNG, JPEG and
// WebP pictures, PDF, plain text, common audio and video); everything else, HTML and SVG included, is a
// download (`Content-Disposition: attachment`, `nosniff`, a sandbox CSP). The server never fetches a URL,
// the page uploads the bytes.
import { imageSize, sniffImage } from './avatar.mjs';

/** Default largest file, in MB (BOARD_ATTACHMENT_MAX_MB changes it). */
export const ATTACHMENT_DEFAULT_MB = 25;
/** Never above this, whatever the setting says: the whole body is held in memory and in SQLite. */
export const ATTACHMENT_HARD_MAX_MB = 200;
/** Largest accepted file at the default setting. */
export const ATTACHMENT_MAX_BYTES = ATTACHMENT_DEFAULT_MB * 1024 * 1024;
/** Largest accepted side in pixels: a small picture can still declare huge dimensions. */
export const ATTACHMENT_MAX_SIDE = 12000;
/** Files kept per ticket, linked or still waiting for their comment. */
export const ATTACHMENTS_PER_TICKET = 40;
/** Files a single comment (or a new ticket) can carry. */
export const ATTACHMENTS_PER_COMMENT = 10;
/** Files one actor may have waiting for a ticket that does not exist yet (the new ticket form). */
export const ATTACHMENTS_PENDING_PER_ACTOR = 20;
/** A file nobody claimed is dropped after this long. */
export const ATTACHMENT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** Types the page may show in the browser. Anything else is served as a download. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'video/mp4', 'video/webm']);

/** BOARD_ATTACHMENT_MAX_MB as bytes: a number of MB between 1 and 200, else the default. */
export function attachmentMaxBytes(value) {
  const n = Number(String(value ?? '').trim());
  if (!value || !Number.isFinite(n) || n < 1) return ATTACHMENT_MAX_BYTES;
  return Math.floor(Math.min(n, ATTACHMENT_HARD_MAX_MB) * 1024 * 1024);
}

/** "25 MB", "1.5 MB", "300 KB": the cap as people read it. */
export function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return `${Math.round((b / 1024 / 1024) * 10) / 10} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

const EXT_ZIP = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', epub: 'application/epub+zip' };
const MARKUP_EXT = /\.(html?|xhtml|svgz?|xml|xsl|xslt|mht|mhtml|hta|js|mjs)$/i;
const TEXT_EXT = { csv: 'text/csv', md: 'text/markdown', json: 'application/json' };

/** Valid UTF-8 with no NUL and few control characters: a text file. */
function looksText(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  if (head.includes(0)) return false;
  let ctl = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) ctl++;
  if (ctl > head.length / 100) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.length > head.length ? head.subarray(0, head.length - 4) : head);
    return true;
  } catch { return false; }
}

/**
 * The type of these bytes, read from their first bytes only; `name` refines a ZIP (an Office document is
 * a ZIP) and a text, never the other way round. Markup (HTML, SVG, XML) and unknown bytes come back as
 * `application/octet-stream`: they are only ever downloaded.
 */
export function sniffFile(buf, name = '') {
  const img = sniffImage(buf);
  if (img) return img;
  const s = (a, b) => buf.toString('latin1', a, b);
  const ext = (String(name).match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase();
  if (s(0, 5) === '%PDF-') return 'application/pdf';
  if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7)) return EXT_ZIP[ext] || 'application/zip';
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'application/gzip';
  if (s(0, 6) === '7z\xbc\xaf\x27\x1c') return 'application/x-7z-compressed';
  if (s(0, 4) === 'Rar!') return 'application/vnd.rar';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (s(0, 4) === 'fLaC') return 'audio/flac';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav';
  if (s(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && buf.length > 3 && !looksText(buf))) return 'audio/mpeg';
  if (s(4, 8) === 'ftyp') return /^(M4A |M4B )/.test(s(8, 12)) ? 'audio/mp4' : s(8, 11) === 'qt ' ? 'video/quicktime' : 'video/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  if (looksText(buf)) {
    const start = buf.toString('utf8', 0, Math.min(buf.length, 512)).replace(/^\uFEFF/, '').trimStart();
    if (MARKUP_EXT.test(String(name)) || start.startsWith('<')) return 'application/octet-stream';
    return TEXT_EXT[ext] || 'text/plain';
  }
  return 'application/octet-stream';
}

/**
 * A file name safe to store and to put in a header: no path, no control or reserved character, no
 * leading dot, at most 120 characters with the extension kept; `file` when nothing is left.
 */
export function cleanFileName(raw) {
  let n = String(raw ?? '');
  n = n.split(/[\\/]/).pop();
  n = n.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069"*:<>?|]/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if ([...n].length > 120) {
    const m = n.match(/(\.[\p{L}0-9]{1,8})$/u);
    const ext = m ? m[1] : '';
    n = [...n.slice(0, n.length - ext.length)].slice(0, 120 - ext.length).join('').trim() + ext;
  }
  return n || 'file';
}

/** `Content-Disposition` for this name: an ASCII fallback and the exact name in RFC 5987 form. */
export function contentDisposition(kind, name) {
  const clean = cleanFileName(name);
  const ascii = clean.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\%]/g, '').trim() || 'file';
  const star = encodeURIComponent(clean).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/**
 * Check an uploaded file. Returns `{ mime, name, width, height }` (width and height for a picture only)
 * or throws an error carrying an HTTP status.
 */
export function checkAttachment(buf, { name = '', maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!buf || !buf.length) throw fail(400, 'empty file');
  if (buf.length > maxBytes) throw fail(413, `file too large (max ${humanSize(maxBytes)})`);
  const mime = sniffFile(buf, name);
  const clean = cleanFileName(name || (mime.startsWith('image/') ? 'picture' : 'file'));
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return { mime, name: clean, width: null, height: null };
  const size = imageSize(buf, mime);
  if (!size || !size.width || !size.height) throw fail(422, 'unreadable image header');
  if (size.width > ATTACHMENT_MAX_SIDE || size.height > ATTACHMENT_MAX_SIDE) throw fail(422, `image too big (max ${ATTACHMENT_MAX_SIDE}×${ATTACHMENT_MAX_SIDE} px)`);
  return { mime, name: clean, ...size };
}
