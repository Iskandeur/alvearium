import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { MANIFEST } from '../server/pwa.mjs';

const TOKEN = 'x'.repeat(32);

test('install files answer without a token, the API stays locked', async () => {
  const store = await openStore(':memory:');
  const page = readFileSync(new URL('../server/page.html', import.meta.url), 'utf8');
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const m = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type'), /manifest\+json/);
    const j = await m.json();
    assert.equal(j.display, 'standalone');
    assert.equal(j.start_url, '/');
    assert.ok(j.icons.some((i) => i.sizes === '192x192'));
    assert.ok(j.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    const sw = await fetch(`${base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(await sw.text(), /addEventListener\('fetch'/);
    for (const i of MANIFEST.icons) {
      const r = await fetch(base + i.src);
      assert.equal(r.status, 200);
      const b = Buffer.from(await r.arrayBuffer());
      assert.equal(b.subarray(1, 4).toString(), 'PNG');
      assert.equal(b.readUInt32BE(16), parseInt(i.sizes, 10));
    }
    assert.equal((await fetch(`${base}/apple-touch-icon.png`)).status, 200);
    assert.equal((await fetch(`${base}/icon.svg`)).status, 200);
    // the worker never caches, and steps aside for the API, the live stream and non-GET requests
    const swText = await (await fetch(`${base}/sw.js`)).text();
    assert.ok(!swText.includes('caches.'));
    assert.ok(swText.includes("'/api/'") && swText.includes('text/event-stream') && swText.includes("req.method !== 'GET'"));
    // a write on a public path is never answered 200
    for (const p of ['/manifest.webmanifest', '/sw.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']) {
      const r = await fetch(base + p, { method: 'POST', body: '{}' });
      assert.ok([401, 405].includes(r.status), `${p} POST -> ${r.status}`);
    }
    assert.ok(!/Claude Code session\.?$/.test(j.description) && /Codex/.test(j.description));
    // nothing else leaves the door
    assert.equal((await fetch(`${base}/api/tickets`)).status, 401);
    assert.equal((await fetch(`${base}/api/board`)).status, 401);
    assert.equal((await fetch(`${base}/secret.txt`)).status, 404);
    // the page links them
    for (const frag of ['rel="manifest"', 'apple-touch-icon', 'name="theme-color"', 'apple-mobile-web-app-capable', '/sw.js']) assert.ok(page.includes(frag), frag);
  } finally {
    server.close();
  }
});
