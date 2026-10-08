import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { chunkExport, sessionStartNotice, syncLocalToServer } from '../lib/sync.mjs';

const TOKEN = 'y'.repeat(32);

async function withServer(store, fn) {
  const server = createServer(createApp({ token: TOKEN, store, page: '<html></html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

/** A machine's data dir with a local board.db written by 0.2.0 (MCP in local mode by mistake). */
async function localBoard(build) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-sync-'));
  const local = await openStore(join(dir, 'board.db'));
  await build(local);
  local.close();
  return dir;
}

const envFor = (dir, base) => ({ SESSION_BOARD_DIR: dir, SESSION_BOARD_URL: base, SESSION_BOARD_TOKEN: TOKEN });
const files = (dir) => readdirSync(dir).sort();

test('sync: local tickets reach the server once, keys renumbered, history, dates and parents kept, file renamed', async () => {
  const t0 = Date.now() - 3 * 24 * 3600 * 1000;
  const dir = await localBoard(async (s) => {
    s.ingest({ v: 1, identity: { sessionId: 'sess-1', repo: 'acme/app', branch: 'main', host: 'pc', surface: 'terminal' }, transition: { state: 'working', prompt: 'go' }, at: Date.now() });
    const a = s.createTicket({ title: 'Add the STRIPE_KEY secret', body: 'staging', labels: ['deploy'], priority: 'high', session_id: 'sess-1' }, { actor: 'claude', now: t0 });
    s.createTicket({ title: 'Step one', parent: a.key, assignee: 'claude' }, { actor: 'claude', now: t0 + 1000 });
    s.comment(a.key, 'done half of it', { actor: 'user', now: t0 + 2000 });
    s.updateTicket(a.key, { status: 'done' }, { actor: 'user', now: t0 + 3000 });
  });
  const server = await openStore(':memory:');
  // The server already holds tickets of its own: imported keys must not collide.
  server.createTicket({ title: 'server ticket' });
  server.ingest({ v: 1, identity: { sessionId: 'sess-1', repo: 'acme/app', branch: 'main', host: 'pc', surface: 'terminal' }, transition: { state: 'working', prompt: 'go' }, at: Date.now() });
  await withServer(server, async (base) => {
    const env = envFor(dir, base);
    const r = await syncLocalToServer({ env });
    assert.equal(r.status, 'uploaded');
    assert.equal(r.total, 3);
    assert.equal(r.imported, 2, 'the two tickets Claude and the user wrote');
    assert.equal(r.duplicate, 1, 'the session ticket the server already follows through the hooks');
    assert.equal(r.pending, 0);
    assert.ok(!existsSync(join(dir, 'board.db')), 'board.db is renamed');
    assert.ok(files(dir).some((f) => /^board\.db\.uploaded-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/.test(f)), files(dir).join(','));

    const list = server.listTickets({ q: 'STRIPE_KEY', archived: 'include' }).tickets;
    assert.equal(list.length, 1);
    const t = server.getTicket(list[0].key);
    assert.equal(t.status, 'done');
    assert.equal(t.priority, 'P1', 'the 0.2 priority "high" arrives as P1');
    assert.deepEqual(t.labels, ['deploy']);
    assert.equal(t.created_at, t0);
    assert.equal(t.closed_at, t0 + 3000);
    assert.equal(t.source, 'claude');
    assert.equal(t.session_id, 'sess-1');
    assert.equal(t.children.length, 1, 'the sub-ticket follows its parent');
    assert.ok(t.events.some((e) => e.type === 'comment' && e.text === 'done half of it'));
    assert.ok(t.events.some((e) => e.type === 'note' && /Imported from the local board of .* \(was SB-\d+ there\)/.test(e.text)));
    assert.equal(server.listTickets({ q: 'half', archived: 'include' }).total, 1, 'comments are searchable');
    const keys = server.listTickets({ archived: 'include', limit: 100 }).tickets.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, 'no key collision');

    // Second pass on the renamed file's content: zero duplicates.
    const before = server.counts().tickets;
    const again = await localBoard(async () => {});
    renameBack(dir, again);
    const r2 = await syncLocalToServer({ env: envFor(again, base) });
    assert.equal(r2.imported, 0);
    assert.equal(r2.skipped + r2.duplicate, 3);
    assert.equal(server.counts().tickets, before, 'two passes, zero duplicates');
  });
});

/** Copy the uploaded file back as a fresh board.db in another dir (simulates a crash before the rename). */
function renameBack(fromDir, toDir) {
  const f = readdirSync(fromDir).find((n) => /^board\.db\.uploaded-[^-]+-\d\d-\d\dT\d\d-\d\d-\d\d$/.test(n));
  writeFileSync(join(toDir, 'board.db'), readFileSync(join(fromDir, f)));
}

test('sync: a partial import keeps the file, counts what is left, and the retry finishes without duplicates', async () => {
  const dir = await localBoard(async (s) => {
    for (let i = 0; i < 60; i++) s.createTicket({ title: `ticket ${i}` }, { actor: 'claude' });
  });
  const server = await openStore(':memory:');
  await withServer(server, async (base) => {
    let calls = 0;
    // The second request dies (network cut): 25 tickets are in, 35 are not.
    const flaky = (url, init) => (++calls === 2 ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init));
    const r = await syncLocalToServer({ env: envFor(dir, base), fetchImpl: flaky });
    assert.equal(r.status, 'partial');
    assert.equal(r.imported, 25);
    assert.equal(r.pending, 35);
    assert.ok(existsSync(join(dir, 'board.db')), 'nothing renamed while tickets are left');

    const r2 = await syncLocalToServer({ env: envFor(dir, base) });
    assert.equal(r2.status, 'uploaded');
    assert.equal(r2.imported, 35);
    assert.equal(r2.skipped, 25);
    assert.equal(server.counts().tickets, 60);
    assert.ok(!existsSync(join(dir, 'board.db')));
  });
});

test('sync: nothing to do in local mode, without a local board, or against an old server', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'sb-sync-'));
  assert.equal((await syncLocalToServer({ env: { SESSION_BOARD_DIR: empty } })).status, 'local-mode');
  assert.equal((await syncLocalToServer({ env: envFor(empty, 'http://127.0.0.1:9') })).status, 'none');

  const dir = await localBoard(async (s) => s.createTicket({ title: 'keep me' }));
  const old = async () => new Response('{"error":"not found"}', { status: 404 });
  const r = await syncLocalToServer({ env: envFor(dir, 'http://board.test'), fetchImpl: old });
  assert.equal(r.status, 'failed');
  assert.equal(r.pending, 1);
  assert.match(r.error, /update the server/);
  assert.ok(existsSync(join(dir, 'board.db')));
});

test('SessionStart notice: once per failure, a success line, and warnings when the storage leaves a server', async () => {
  const dir = await localBoard(async (s) => {
    s.createTicket({ title: 'one' });
    s.createTicket({ title: 'two' });
  });
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  const env = envFor(dir, 'http://board.test');
  const m1 = await sessionStartNotice({ env, fetchImpl: down });
  assert.match(m1, /2 tickets of this machine's local board .* not on the board on board\.test yet .*\/alvearium:board sync/);
  assert.equal(await sessionStartNotice({ env, fetchImpl: down }), null, 'the same failure is not repeated');

  const server = await openStore(':memory:');
  await withServer(server, async (base) => {
    const m2 = await sessionStartNotice({ env: envFor(dir, base) });
    assert.match(m2, /the board server changed from board\.test to 127\.0\.0\.1:\d+/);
    assert.match(m2, /2 tickets from this machine's local board moved to the board on 127\.0\.0\.1:\d+\. The local file is kept as board\.db\.uploaded-/);
    assert.equal(await sessionStartNotice({ env: envFor(dir, base) }), null, 'quiet afterwards');
    const m3 = await sessionStartNotice({ env: { SESSION_BOARD_DIR: dir } });
    assert.match(m3, /local mode now\. Tickets on 127\.0\.0\.1:\d+ stay there/);
    assert.equal(await sessionStartNotice({ env: { SESSION_BOARD_DIR: dir } }), null);
  });
});

test('hook script: SessionStart sends the local board and tells the user in systemMessage', async () => {
  const dir = await localBoard(async (s) => {
    s.createTicket({ title: 'from 0.2.0' }, { actor: 'claude' });
  });
  const server = await openStore(':memory:');
  await withServer(server, async (base) => {
    const hook = fileURLToPath(new URL('../hooks/report.mjs', import.meta.url));
    const child = spawn(process.execPath, [hook, 'SessionStart'], { env: { ...process.env, ...envFor(dir, base) }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(JSON.stringify({ session_id: 'hook-sess', hook_event_name: 'SessionStart', source: 'startup', cwd: dir }));
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);
    const msg = JSON.parse(out.trim());
    assert.match(msg.systemMessage, /1 ticket from this machine's local board moved to the board on 127\.0\.0\.1/);
    assert.equal(server.listTickets({ q: 'from 0.2.0' }).total, 1);
    assert.ok(!existsSync(join(dir, 'board.db')));
  });
});

test('sync: an earlier uploaded file with the same name is never overwritten', async () => {
  const now = Date.UTC(2026, 9, 2, 18, 0, 0);
  const dir = await localBoard(async (s) => s.createTicket({ title: 'second batch' }));
  writeFileSync(join(dir, 'board.db.uploaded-2026-10-02T18-00-00'), 'first batch');
  const server = await openStore(':memory:');
  await withServer(server, async (base) => {
    const r = await syncLocalToServer({ env: envFor(dir, base), now });
    assert.equal(r.status, 'uploaded');
    assert.ok(r.file.endsWith('board.db.uploaded-2026-10-02T18-00-00-2'));
    assert.equal(readFileSync(join(dir, 'board.db.uploaded-2026-10-02T18-00-00'), 'utf8'), 'first batch');
  });
});

test('chunkExport: sessions in the first request, at most 25 tickets per request', () => {
  const tickets = Array.from({ length: 51 }, (_, i) => ({ id: 't' + i, title: 'x' }));
  const chunks = chunkExport({ sessions: [{ id: 's' }], tickets });
  assert.deepEqual(chunks.map((c) => c.tickets.length), [25, 25, 1]);
  assert.deepEqual(chunks.map((c) => c.sessions.length), [1, 0, 0]);
});

test('server: DELETE /api/sessions/:id removes a session and its tickets only', async () => {
  const store = await openStore(':memory:');
  const id = (s) => ({ v: 1, identity: { sessionId: s, host: 'pc', surface: 'terminal' }, transition: { state: 'working', prompt: 'x' }, at: Date.now() });
  store.ingest(id('keep'));
  store.ingest(id('test-session'));
  store.createTicket({ title: 'mine', session_id: 'test-session' });
  await withServer(store, async (base) => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${base}/api/sessions/test-session`, { method: 'DELETE' })).status, 401);
    const r = await (await fetch(`${base}/api/sessions/test-session`, { method: 'DELETE', headers: auth })).json();
    assert.deepEqual(r, { session: 1, tickets: 2 });
    assert.equal((await fetch(`${base}/api/sessions/test-session`, { method: 'DELETE', headers: auth })).status, 404);
  });
  assert.equal(store.counts().sessions, 1);
  assert.equal(store.counts().tickets, 1);
});
