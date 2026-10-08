#!/usr/bin/env node
// Generate .claude-plugin/icon.png (1024×1024, <2MB) deterministically.
// No external deps: pure Node + built-in zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const size = Number.parseInt(arg('--size') || '', 10) || 1024;
const OUT = arg('--out') ? resolve(arg('--out')) : resolve(import.meta.dirname, '..', '.claude-plugin', 'icon.png');
const W = size;
const H = size;

// Palette: keep it sober.
const BG = [0xf6, 0xf6, 0xf7, 0xff];
const FG = [0x4b, 0x5b, 0xdc, 0xff];
const FG_SOFT = [0x4b, 0x5b, 0xdc, 0x24];

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mix(a, b, t) {
  const u = 1 - t;
  return [
    Math.round(a[0] * u + b[0] * t),
    Math.round(a[1] * u + b[1] * t),
    Math.round(a[2] * u + b[2] * t),
    Math.round(a[3] * u + b[3] * t),
  ];
}

// Signed distance to a hexagon centered at (0,0). Adapted from common IQ SDF.
function sdHex(x, y, r) {
  const kx = -0.8660254037844386; // -sqrt(3)/2
  const ky = 0.5;
  const kz = 0.5773502691896257; // 1/sqrt(3)
  let px = Math.abs(x);
  let py = Math.abs(y);
  const dot = px * kx + py * ky;
  const m = Math.min(dot, 0);
  px -= 2 * m * kx;
  py -= 2 * m * ky;
  const cx = clamp01((px - r) / (2 * r));
  const qx = px - r * (1 + cx);
  const qy = py - r * kz;
  const dist = Math.hypot(qx, qy);
  // Sign: inside when max(px - r, py - r*kz) <= 0
  const inside = Math.max(px - r, py - r * kz) <= 0;
  return inside ? -dist : dist;
}

function draw() {
  const rowLen = 1 + W * 4;
  const raw = Buffer.alloc(rowLen * H);

  const centers = [];
  const ringR = 0.38;
  const d = 0.34;
  centers.push([0, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    centers.push([Math.cos(a) * d, Math.sin(a) * d]);
  }

  for (let y = 0; y < H; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const nx = (x + 0.5) / W * 2 - 1;
      const ny = (y + 0.5) / H * 2 - 1;

      // Soft vignette.
      const v = Math.hypot(nx, ny);
      let col = BG;
      col = mix(col, [0xee, 0xee, 0xf2, 0xff], clamp01((v - 0.6) / 0.6));

      // Honeycomb outlines.
      let best = 1e9;
      for (const [cx, cy] of centers) {
        const dx = nx - cx;
        const dy = ny - cy;
        const dist = Math.abs(sdHex(dx, dy, ringR));
        if (dist < best) best = dist;
      }
      const t = 0.012;
      const outline = clamp01(1 - best / t);
      if (outline > 0) col = mix(col, FG, outline);

      // A faint filled core to keep it readable at 64 px.
      let fill = 0;
      for (const [cx, cy] of centers) {
        const d0 = -sdHex(nx - cx, ny - cy, ringR * 0.62);
        fill = Math.max(fill, clamp01(d0 / 0.02));
      }
      if (fill > 0) col = mix(col, mix(BG, FG_SOFT, 1), fill);

      const i = off + 1 + x * 4;
      raw[i + 0] = col[0];
      raw[i + 1] = col[1];
      raw[i + 2] = col[2];
      raw[i + 3] = col[3];
    }
  }
  return raw;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  const body = Buffer.concat([t, data]);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pngBytes() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = draw();
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(OUT), { recursive: true });
const png = pngBytes();
writeFileSync(OUT, png);
process.stdout.write(`${OUT}\n${png.length} bytes\n`);
