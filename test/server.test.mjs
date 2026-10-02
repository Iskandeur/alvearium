import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardStore, bearerOk, createApp } from '../server/server.mjs';

const TOKEN = 'x'.repeat(32);

async function withServer(store, fn) {
  const server = createServer(createApp({ token: TOKEN, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const event = (id, state, extra = {}) => ({ v: 1, session: { sessionId: id, repo: 'acme/app', surface: 'terminal' }, transition: { state, ...extra } });

test('bearerOk is exact', () => {
  assert.equal(bearerOk(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerOk(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerOk(undefined, TOKEN), false);
  assert.equal(bearerOk('Bearer ', ''), false);
});

test('server: auth, ingest, board, dismiss, page', async () => {
  const store = new BoardStore(null);
  await withServer(store, async (base) => {
    assert.equal((await fetch(`${base}/api/board`)).status, 401);
    assert.equal((await fetch(`${base}/api/event`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: 'nope' })).status, 400);
    assert.equal((await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: JSON.stringify({ session: {} }) })).status, 400);

    let res = await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: JSON.stringify(event('a', 'working', { prompt: 'ship it' })) });
    assert.equal(res.status, 202);
    await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: JSON.stringify(event('b', 'waiting', { detail: 'Permission: Bash: rm -rf' })) });
    await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: JSON.stringify(event('c', 'review', { detail: 'done', pr: 'https://github.com/acme/app/pull/9' })) });

    let board = await (await fetch(`${base}/api/board`, { headers: auth })).json();
    assert.deepEqual([board.counts.waiting, board.counts.working, board.counts.review], [1, 1, 1]);
    assert.equal(board.inProgress[0].title, 'ship it');
    assert.equal(board.review[0].pr, 'https://github.com/acme/app/pull/9');

    res = await fetch(`${base}/api/dismiss`, { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'c' }) });
    assert.equal(res.status, 200);
    board = await (await fetch(`${base}/api/board`, { headers: auth })).json();
    assert.equal(board.counts.review, 0);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('server: body size limit', async () => {
  await withServer(new BoardStore(null), async (base) => {
    const big = JSON.stringify({ pad: 'x'.repeat(100 * 1024) });
    const res = await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: big }).catch(() => ({ status: 413 }));
    assert.equal(res.status, 413);
  });
});

test('store: persists to disk and reloads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'sb-store-')), 'board.json');
  const a = new BoardStore(file);
  a.apply({ identity: { sessionId: 'p' }, transition: { state: 'waiting', detail: 'Allow?' } }, 1000);
  a.saveNow();
  clearTimeout(a.timer);
  const b = new BoardStore(file);
  assert.equal(b.sessions.get('p').state, 'waiting');
});
