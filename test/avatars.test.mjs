// 0.5: profile pictures. Checked by their bytes (PNG, JPEG, WebP only, never SVG), bounded in size
// and pixels, served with their own type, nosniff and a sandbox CSP; an agent only sets its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { AVATAR_MAX_BYTES, checkAvatar, imageSize, sniffImage } from '../lib/avatar.mjs';
import { fakeJpegHeader, fakeWebpHeader, makePng } from './helpers/png.mjs';

const MAIN = 'm'.repeat(32);
const AGENT = 'a'.repeat(32);
const agents = [{ actor: 'lupi', token: AGENT }];

async function withServer(fn) {
  const store = await openStore(':memory:');
  store.touchActor({ id: 'lupi', type: 'agent' });
  store.touchActor({ id: 'lupi/job-1', type: 'subagent', parent: 'lupi' });
  store.touchActor({ id: 'ci-bot', type: 'agent' });
  const server = createServer(createApp({ token: MAIN, agents, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
  }
}

const put = (base, id, body, token = MAIN, type = 'image/png') =>
  fetch(`${base}/api/actors/${encodeURIComponent(id)}/avatar`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body });
const get = (base, id, headers = {}) => fetch(`${base}/api/actors/${encodeURIComponent(id)}/avatar`, { headers: { authorization: `Bearer ${MAIN}`, ...headers } });

test('sniffing: PNG, JPEG and WebP by their bytes; SVG, GIF and HTML are not images here', () => {
  assert.equal(sniffImage(makePng()), 'image/png');
  assert.equal(sniffImage(fakeJpegHeader(10, 10)), 'image/jpeg');
  assert.equal(sniffImage(fakeWebpHeader(10, 10)), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')), null);
  assert.equal(sniffImage(Buffer.from('<!doctype html><html><script>alert(1)</script>')), null);
  assert.deepEqual(imageSize(makePng(12, 7), 'image/png'), { width: 12, height: 7 });
  assert.deepEqual(imageSize(fakeJpegHeader(300, 200), 'image/jpeg'), { width: 300, height: 200 });
  assert.deepEqual(imageSize(fakeWebpHeader(64, 48), 'image/webp'), { width: 64, height: 48 });
  assert.throws(() => checkAvatar(makePng(2000, 4)), (e) => e.status === 422);
  assert.throws(() => checkAvatar(Buffer.alloc(AVATAR_MAX_BYTES + 1)), (e) => e.status === 413);
});

test('upload, then served as stored: its own type, nosniff, sandbox CSP, etag and 304', async () => {
  await withServer(async (base) => {
    const png = makePng(16, 16);
    const r = await put(base, 'lupi', png, MAIN, 'text/html');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.mime, 'image/png', 'the declared type is ignored, the bytes decide');
    assert.ok(body.avatar);
    const g = await get(base, 'lupi');
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type'), 'image/png');
    assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
    assert.match(g.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
    assert.match(g.headers.get('cache-control'), /private/);
    assert.ok(Buffer.from(await g.arrayBuffer()).equals(png));
    const again = await get(base, 'lupi', { 'if-none-match': g.headers.get('etag') });
    assert.equal(again.status, 304);
    const list = await (await fetch(`${base}/api/actors`, { headers: { authorization: `Bearer ${MAIN}` } })).json();
    assert.equal(list.actors.find((a) => a.id === 'lupi').avatar, body.avatar);
    assert.equal(list.actors.find((a) => a.id === 'ci-bot').avatar, null);
  });
});

test('refused: SVG (even sent as image/png), GIF, HTML, too large, too many pixels, empty', async () => {
  await withServer(async (base) => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>');
    assert.equal((await put(base, 'lupi', svg, MAIN, 'image/png')).status, 415);
    assert.equal((await put(base, 'lupi', svg, MAIN, 'image/svg+xml')).status, 415);
    assert.equal((await put(base, 'lupi', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'))).status, 415);
    assert.equal((await put(base, 'lupi', Buffer.from('<html><script>alert(1)</script></html>'))).status, 415);
    const big = Buffer.concat([makePng(8, 8), Buffer.alloc(AVATAR_MAX_BYTES)]);
    assert.equal((await put(base, 'lupi', big)).status, 413);
    assert.equal((await put(base, 'lupi', makePng(1500, 1))).status, 422);
    assert.equal((await put(base, 'lupi', Buffer.alloc(0))).status, 400);
    assert.equal((await get(base, 'lupi')).status, 404, 'nothing was stored');
  });
});

test('JPEG and WebP accepted; delete; unknown actor 404', async () => {
  await withServer(async (base) => {
    assert.equal((await put(base, 'ci-bot', fakeJpegHeader(256, 256), MAIN, 'image/jpeg')).status, 200);
    assert.equal((await get(base, 'ci-bot')).headers.get('content-type'), 'image/jpeg');
    assert.equal((await put(base, 'ci-bot', fakeWebpHeader(128, 128), MAIN, 'image/webp')).status, 200);
    assert.equal((await get(base, 'ci-bot')).headers.get('content-type'), 'image/webp');
    const d = await fetch(`${base}/api/actors/ci-bot/avatar`, { method: 'DELETE', headers: { authorization: `Bearer ${MAIN}` } });
    assert.equal(d.status, 200);
    assert.equal((await get(base, 'ci-bot')).status, 404);
    assert.equal((await put(base, 'nobody-here', makePng())).status, 404);
  });
});

test('an agent sets its own picture and its sub-actors, never another actor', async () => {
  await withServer(async (base) => {
    assert.equal((await put(base, 'lupi', makePng(), AGENT)).status, 200);
    assert.equal((await put(base, 'lupi/job-1', makePng(), AGENT)).status, 200);
    assert.equal((await put(base, 'ci-bot', makePng(), AGENT)).status, 403);
    assert.equal((await put(base, 'user', makePng(), AGENT)).status, 403);
    const d = await fetch(`${base}/api/actors/ci-bot/avatar`, { method: 'DELETE', headers: { authorization: `Bearer ${AGENT}` } });
    assert.equal(d.status, 403);
    assert.equal((await put(base, 'lupi', makePng(), 'x'.repeat(32))).status, 401);
  });
});

test('the page: pictures fetched with credentials into blob URLs, initials as fallback, upload resized', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../server/page.html', import.meta.url), 'utf8');
  assert.match(page, /URL\.createObjectURL\(await res\.blob\(\)\)/);
  assert.match(page, /\/avatar\?v=/);
  assert.match(page, /esc\(initials\(a\)\)/);
  assert.match(page, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(page, /toBlob\(ok, 'image\/webp'/);
  assert.doesNotMatch(page, /accept="[^"]*svg/);
});
