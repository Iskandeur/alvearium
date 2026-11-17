// Install-as-an-app files (PWA): the web manifest, a pass-through service worker and the icons.
//
// They are public on purpose: the browser fetches the manifest and the icons without the page's
// credentials, and an install check that meets the "access token needed" wall fails silently. They
// carry nothing private (the logo and a name). Everything else stays behind the door: the service
// worker never caches anything, so the board's content is never kept by it.
import { deflateSync } from 'node:zlib';

const BG = '#0e0f11'; // the dark theme's --bg
const ACCENT = '#8d97ff'; // the dark theme's --accent
const CORE = '#4b5bdc';

// The hexagonal logo, six cells around one, on a 64 x 64 grid (the page's favicon).
const CELLS = [
  '59.7,42.0 54.5,51.0 44.3,51.0 39.1,42.0 44.3,33.1 54.5,33.1',
  '42.3,52.1 37.1,61.0 26.9,61.0 21.7,52.1 26.9,43.2 37.1,43.2',
  '24.9,42.0 19.7,51.0 9.5,51.0 4.3,42.0 9.5,33.1 19.7,33.1',
  '24.9,22.0 19.7,30.9 9.5,30.9 4.3,22.0 9.5,13.0 19.7,13.0',
  '42.3,11.9 37.1,20.8 26.9,20.8 21.7,11.9 26.9,3.0 37.1,3.0',
  '59.7,22.0 54.5,30.9 44.3,30.9 39.1,22.0 44.3,13.0 54.5,13.0',
];
const CENTER = '42.3,32.0 37.1,40.9 26.9,40.9 21.7,32.0 26.9,23.1 37.1,23.1';
const parse = (s) => s.split(' ').map((p) => p.split(',').map(Number));
const SHAPES = [...CELLS.map((c) => ({ pts: parse(c), color: ACCENT })), { pts: parse(CENTER), color: CORE }];

/** The logo on a dark square. `scale` is the share of the square the logo (64 units) fills. */
export function iconSvg(scale = 0.8) {
  const s = (64 * scale) / 64;
  const off = (64 - 64 * s) / 2;
  const polys = SHAPES.map((h) => `<polygon fill='${h.color}' points='${h.pts.map(([x, y]) => `${x},${y}`).join(' ')}'/>`).join('');
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='${BG}'/><g transform='translate(${off} ${off}) scale(${s})'>${polys}</g></svg>`;
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const inside = (pts, x, y) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG of the logo (RGB, 3 x 3 supersampling), no dependency. */
export function iconPng(size, scale = 0.8) {
  const SS = 3;
  const k = (64 * scale) / 64;
  const off = (64 - 64 * k) / 2;
  const bg = hex(BG);
  const shapes = SHAPES.map((h) => ({ pts: h.pts.map(([x, y]) => [x * k + off, y * k + off]), rgb: hex(h.color) }));
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = ((x + (sx + 0.5) / SS) / size) * 64;
          const uy = ((y + (sy + 0.5) / SS) / size) * 64;
          let rgb = bg;
          for (const s of shapes) if (inside(s.pts, ux, uy)) rgb = s.rgb;
          acc[0] += rgb[0];
          acc[1] += rgb[1];
          acc[2] += rgb[2];
        }
      }
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = Math.round(acc[c] / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const MANIFEST = {
  name: 'Alvearium',
  short_name: 'Alvearium',
  description: 'The board of every coding-agent session (Claude Code, Codex).',
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: BG,
  theme_color: BG,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

// Enough for Chrome to offer "Install app" (a fetch handler), and nothing more. The worker leaves
// the API, the live stream (SSE) and every non-GET request alone: it returns without respondWith, so
// the browser handles them itself. Other GETs go to the network as if the worker were not there.
// No cache, so nothing private is kept.
export const SERVICE_WORKER = `// Alvearium: pass-through service worker (installability only, it caches nothing).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return;
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req));
});
`;

const cache = new Map();
const png = (name, size, scale) => () => {
  if (!cache.has(name)) cache.set(name, iconPng(size, scale));
  return cache.get(name);
};
const day = 'public, max-age=86400';
// path -> [content-type, body builder, cache-control]
const FILES = {
  '/manifest.webmanifest': ['application/manifest+json; charset=utf-8', () => JSON.stringify(MANIFEST), 'no-cache'],
  '/sw.js': ['text/javascript; charset=utf-8', () => SERVICE_WORKER, 'no-cache'],
  '/icon.svg': ['image/svg+xml', () => iconSvg(0.8), day],
  '/icon-192.png': ['image/png', png('192', 192, 0.8), day],
  '/icon-512.png': ['image/png', png('512', 512, 0.8), day],
  '/icon-maskable-512.png': ['image/png', png('m512', 512, 0.6), day],
  '/apple-touch-icon.png': ['image/png', png('180', 180, 0.8), day],
};
export const PWA_PATHS = Object.keys(FILES);

/** Answers a GET/HEAD on one of the install files (405 for any other method); false for any other path. No credentials asked. */
export function pwaRoute(req, res, path) {
  const f = FILES[path];
  if (!f) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json' });
    res.end('{"error":"method not allowed"}');
    return true;
  }
  const body = f[1]();
  res.writeHead(200, {
    'content-type': f[0],
    'content-length': Buffer.byteLength(body),
    'cache-control': f[2],
    'x-content-type-options': 'nosniff',
    ...(path === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
