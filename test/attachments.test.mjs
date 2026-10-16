// Pictures attached to comments: checked by their bytes, bounded, claimed by one comment of their own
// ticket, served with nosniff and a sandbox CSP, listed on the comment in the ticket's history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { ATTACHMENT_MAX_BYTES, checkAttachment } from '../lib/attachment.mjs';
import { fakeJpegHeader, makePng } from './helpers/png.mjs';

const MAIN = 'm'.repeat(32);

async function withServer(fn) {
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: MAIN, agents: [], store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
  }
}

const auth = { authorization: `Bearer ${MAIN}` };
const json = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const upload = (base, key, body, type = 'image/png') => fetch(`${base}/api/tickets/${key}/attachments`, { method: 'POST', headers: { ...auth, 'content-type': type }, body });

test('checkAttachment: bytes decide, size and pixels are bounded', () => {
  assert.equal(checkAttachment(makePng(20, 10)).mime, 'image/png');
  assert.equal(checkAttachment(fakeJpegHeader(4000, 3000)).mime, 'image/jpeg');
  assert.throws(() => checkAttachment(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), (e) => e.status === 415);
  assert.throws(() => checkAttachment(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')), (e) => e.status === 415);
  assert.throws(() => checkAttachment(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)), (e) => e.status === 413);
  assert.throws(() => checkAttachment(makePng(13000, 2)), (e) => e.status === 422);
  assert.throws(() => checkAttachment(Buffer.alloc(0)), (e) => e.status === 400);
});

test('upload, comment with the picture, history lists it, served safely', async () => {
  await withServer(async (base, store) => {
    const t = store.createTicket({ title: 'photo' }, { actor: 'user' });
    const png = makePng(16, 16);
    const up = await upload(base, t.key, png);
    assert.equal(up.status, 201);
    const pic = await up.json();
    assert.equal(pic.mime, 'image/png');
    assert.equal(pic.width, 16);

    const c = await json(base, `/api/tickets/${t.key}/comments`, { text: 'look', attachments: [pic.id] });
    assert.equal(c.status, 201);
    const full = await (await fetch(`${base}/api/tickets/${t.key}`, { headers: auth })).json();
    const ev = full.events.find((e) => e.type === 'comment');
    assert.equal(ev.attachments.length, 1);
    assert.equal(ev.attachments[0].id, pic.id);
    assert.equal(ev.id, undefined);
    assert.equal(full.events.find((e) => e.type === 'created').attachments, undefined);

    const r = await fetch(`${base}/api/attachments/${pic.id}`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/api/attachments/${pic.id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/attachments/999`, { headers: auth })).status, 404);
  });
});

test('refusals: not an image, unknown ticket, picture reused or from another ticket', async () => {
  await withServer(async (base, store) => {
    const a = store.createTicket({ title: 'a' }, { actor: 'user' });
    const b = store.createTicket({ title: 'b' }, { actor: 'user' });
    assert.equal((await upload(base, a.key, Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
    assert.equal((await upload(base, 'ALV-999', makePng())).status, 404);
    const pic = await (await upload(base, a.key, makePng())).json();
    // another ticket cannot claim it, and the refused comment leaves nothing behind
    const bad = await json(base, `/api/tickets/${b.key}/comments`, { text: 'steal', attachments: [pic.id] });
    assert.equal(bad.status, 400);
    const bFull = await (await fetch(`${base}/api/tickets/${b.key}`, { headers: auth })).json();
    assert.equal(bFull.events.filter((e) => e.type === 'comment').length, 0);
    // the right ticket claims it once; a second claim is refused
    assert.equal((await json(base, `/api/tickets/${a.key}/comments`, { text: 'ok', attachments: [pic.id] })).status, 201);
    assert.equal((await json(base, `/api/tickets/${a.key}/comments`, { text: 'again', attachments: [pic.id] })).status, 400);
    assert.equal((await json(base, `/api/tickets/${a.key}/comments`, { text: 'junk', attachments: ['x'] })).status, 400);
  });
});
