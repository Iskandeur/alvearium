import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bearerOk, createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

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
const event = (id, state, extra = {}, at = Date.now()) => ({
  v: 1,
  session: { sessionId: id, repo: 'acme/app', branch: 'main', host: 'mac', surface: 'terminal' },
  transition: { state, ...extra },
  at,
});
const post = (base, path, body, headers = auth) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
const getJson = async (base, path) => (await fetch(`${base}${path}`, { headers: auth })).json();

test('bearerOk is exact', () => {
  assert.equal(bearerOk(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerOk(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerOk(undefined, TOKEN), false);
  assert.equal(bearerOk('Bearer ', ''), false);
});

test('server: v0.1 routes still answer (auth, ingest, board, dismiss, page)', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    assert.equal((await fetch(`${base}/api/board`)).status, 401);
    assert.equal((await fetch(`${base}/api/tickets`)).status, 401);
    assert.equal((await fetch(`${base}/api/event`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: 'nope' })).status, 400);
    assert.equal((await post(base, '/api/event', { session: {} })).status, 400);

    const t0 = Date.now();
    assert.equal((await post(base, '/api/event', event('a', 'working', { prompt: 'ship it' }, t0))).status, 202);
    await post(base, '/api/event', event('b', 'waiting', { kind: 'permission', detail: 'Permission: Bash: rm -rf build' }, t0 + 1));
    await post(base, '/api/event', event('c', 'review', { detail: 'done', pr: 'https://github.com/acme/app/pull/9' }, t0 + 2));
    // A v0.1 cloud clone posts exactly this shape, without `at`.
    await post(base, '/api/event', { v: 1, session: { sessionId: 'cloud1', surface: 'cloud', url: 'https://claude.ai/code/session_01X' }, transition: { state: 'working', prompt: 'from the cloud' } });

    let board = await getJson(base, '/api/board');
    assert.deepEqual([board.counts.waiting, board.counts.working, board.counts.review], [1, 2, 1]);
    assert.ok(board.inProgress.some((r) => r.title === 'ship it'));
    assert.equal(board.review[0].pr, 'https://github.com/acme/app/pull/9');
    assert.deepEqual(board.tickets.counts, { waiting: 2, inProgress: 3, todo: 0, done: 0 }, 'ticket counts for the mod');

    assert.equal((await post(base, '/api/dismiss', { sessionId: 'c' })).status, 200);
    board = await getJson(base, '/api/board');
    assert.equal(board.counts.review, 0);
    assert.equal(board.tickets.counts.waiting, 1);
    assert.equal((await post(base, '/api/dismiss', { sessionId: 'zzz' })).status, 404);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('server: ticket routes — create, filter, search, update, comment, detail, board, facets', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    await post(base, '/api/event', event('s1', 'working', { prompt: 'build the export' }));
    let res = await post(base, '/api/tickets', { title: 'Create the S3 bucket', body: 'eu-west-3, versioned', labels: ['infra'], session_id: 's1' }, { ...auth, 'x-session-board-actor': 'claude' });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.match(created.key, /^SB-\d+$/);
    assert.equal(created.repo, 'acme/app', 'context inherited from the session');
    assert.equal(created.source, 'claude');
    assert.equal((await post(base, '/api/tickets', { body: 'no title' })).status, 400);
    assert.equal((await post(base, '/api/tickets', { title: 'x', status: 'bogus' })).status, 400);
    await post(base, '/api/tickets', { title: 'Write the README', repo: 'acme/docs' });

    let list = await getJson(base, '/api/tickets?repo=acme/app');
    assert.equal(list.total, 2, 'session ticket + bucket');
    list = await getJson(base, '/api/tickets?q=bucket');
    assert.deepEqual(list.tickets.map((t) => t.key), [created.key]);
    list = await getJson(base, `/api/tickets?q=${created.key}`);
    assert.equal(list.tickets[0].key, created.key, 'a key in the search box finds the ticket');
    list = await getJson(base, '/api/tickets?label=infra&session=s1');
    assert.equal(list.total, 1);
    list = await getJson(base, '/api/tickets?repo=docs');
    assert.equal(list.total, 1, 'bare repo name matches any owner');

    res = await fetch(`${base}/api/tickets/${created.key}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'in_progress', comment: 'on it' }) });
    assert.equal(res.status, 200);
    assert.equal((await post(base, `/api/tickets/${created.key}/comments`, { text: 'versioning enabled' })).status, 201);
    assert.equal((await getJson(base, '/api/tickets?q=versioning')).total, 1, 'comments are searchable');
    const detail = await getJson(base, `/api/tickets/${created.key}`);
    assert.deepEqual(detail.events.map((e) => e.type), ['created', 'status', 'comment', 'comment']);
    assert.equal(detail.comments_count, 2);
    assert.equal((await fetch(`${base}/api/tickets/SB-999`, { headers: auth })).status, 404);

    const board = await getJson(base, '/api/tickets/board?repo=acme/app');
    assert.equal(board.counts.inProgress, 2);
    assert.equal(board.counts.todo, 0);
    const facets = await getJson(base, '/api/facets');
    assert.deepEqual(facets.repos.map((r) => r.value).sort(), ['acme/app', 'acme/docs']);
    assert.equal(facets.labels[0].value, 'infra');
    assert.equal(facets.sessions[0].id, 's1');
    const sessions = await getJson(base, '/api/sessions?repo=acme/app');
    assert.equal(sessions.sessions[0].tickets, 2);
  });
});

test('server: actors can be renamed (stored), agents can only rename themselves', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    // Create a ticket attributed to an agent actor, so the actor exists.
    const res = await post(base, '/api/tickets', { title: 'By ticketmaster', assignee: 'lupi/ticketmaster' }, { ...auth, 'x-session-board-actor': 'lupi/ticketmaster' });
    assert.equal(res.status, 201);

    // Rename via the main token.
    const renamed = await fetch(`${base}/api/actors/lupi/ticketmaster`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: 'Ticketmaster' }) });
    assert.equal(renamed.status, 200);
    const body = await renamed.json();
    assert.equal(body.actor.id, 'lupi/ticketmaster');
    assert.equal(body.actor.name, 'Ticketmaster');

    // Touching the actor again must not override the manual name.
    await post(base, '/api/tickets', { title: 'Second', assignee: 'lupi/ticketmaster' }, { ...auth, 'x-session-board-actor': 'lupi/ticketmaster' });
    const actors = await getJson(base, '/api/actors');
    const a = (actors.actors || []).find((x) => x.id === 'lupi/ticketmaster');
    assert.equal(a.name, 'Ticketmaster');

    // Built-ins are never renamed.
    const bad = await fetch(`${base}/api/actors/user`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: 'Hacker' }) });
    assert.equal(bad.status, 400);
  });
});

test('server: body size limit', async () => {
  await withServer(await openStore(':memory:'), async (base) => {
    const big = JSON.stringify({ pad: 'x'.repeat(100 * 1024) });
    const res = await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: big }).catch(() => ({ status: 413 }));
    assert.equal(res.status, 413);
  });
});

test('store: persists to disk; board.json (v0.1) migrates once and is kept as .migrated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-store-'));
  const now = Date.now();
  writeFileSync(
    join(dir, 'board.json'),
    JSON.stringify({
      v: 1,
      sessions: [
        { sessionId: 'p', state: 'waiting', kind: 'permission', detail: 'Permission: Bash: make deploy', repo: 'acme/app', lastSeen: now, since: now },
        { sessionId: 'q', state: 'review', detail: 'Done', title: 'fix login', repo: 'acme/app', lastSeen: now, since: now },
        { sessionId: 'r', state: 'closed', repo: 'acme/web', lastSeen: now - 1000 },
        { sessionId: 's', state: 'idle', repo: 'acme/web', lastSeen: now },
      ],
    }),
  );
  const a = await openStore(join(dir, 'board.db'));
  assert.equal(a.migrateBoardJson(join(dir, 'board.json')), 4);
  assert.ok(existsSync(join(dir, 'board.json.migrated')));
  const counts = a.counts();
  assert.deepEqual([counts.sessions, counts.tickets], [4, 4], 'p: session + permission, q: review, r: done, s: no ticket');
  a.close();
  const b = await openStore(join(dir, 'board.db'));
  assert.equal(b.migrateBoardJson(join(dir, 'board.json')), 0, 'nothing left to migrate');
  const board = b.ticketBoard({});
  assert.deepEqual(board.columns.waiting.map((t) => t.title).sort(), ['Approve Bash: make deploy', 'fix login']);
  assert.equal(b.legacyBoard().counts.waiting, 1);
  b.close();
});
