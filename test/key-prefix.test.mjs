// 0.5.3: ticket keys ALV-n on a new board; a board made before keeps SB-n until BOARD_KEY_PREFIX
// switches it, and old keys keep resolving (API, MCP, search, ?ticket= links): only the number counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { normalizeKeyPrefix } from '../lib/core.mjs';

const TOKEN = 'x'.repeat(32);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('a new board numbers tickets ALV-n', async () => {
  const store = await openStore(':memory:');
  assert.equal(store.prefix, 'ALV');
  assert.equal(store.createTicket({ title: 'one' }).key, 'ALV-1');
});

test('a board with tickets from before 0.5.3 keeps SB; BOARD_KEY_PREFIX switches it, SB-n still resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alv-prefix-'));
  const file = join(dir, 'board.db');
  try {
    let store = await openStore(file);
    store.createTicket({ title: 'Old ticket, linked as SB-1 in notes' });
    // What a 0.5.2 board looks like: tickets, no key_prefix in meta.
    store.db.exec("DELETE FROM meta WHERE key = 'key_prefix'");
    store.close();

    store = await openStore(file);
    assert.equal(store.prefix, 'SB');
    assert.equal(store.getTicket('SB-1').key, 'SB-1');
    store.close();

    store = await openStore(file, { keyPrefix: 'alv' });
    assert.equal(store.prefix, 'ALV');
    assert.equal(store.getTicket('SB-1').key, 'ALV-1');
    assert.equal(store.getTicket('ALV-1').title, 'Old ticket, linked as SB-1 in notes');
    assert.equal(store.createTicket({ title: 'new' }).key, 'ALV-2');
    assert.deepEqual(store.listTickets({ q: 'SB-1' }).tickets.map((t) => t.key), ['ALV-1']);
    store.close();

    // The switch is remembered without the variable.
    store = await openStore(file);
    assert.equal(store.prefix, 'ALV');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('API: SB-n and ALV-n are the same ticket (get, update, dependency)', async () => {
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = store.createTicket({ title: 'a' });
    const b = store.createTicket({ title: 'b' });
    const got = await (await fetch(`${base}/api/tickets/SB-1`, { headers: auth })).json();
    assert.equal(got.key, a.key);
    const up = await fetch(`${base}/api/tickets/sb-2`, { method: 'POST', headers: auth, body: JSON.stringify({ priority: 'P1', blocked_by_add: ['SB-1'] }) });
    assert.equal(up.status, 200);
    const body = await up.json();
    assert.equal(body.key, b.key);
    assert.equal(body.priority, 'P1');
    assert.deepEqual(body.blocked_by.map((x) => x.key), ['ALV-1']);
  } finally {
    server.close();
  }
});

test('normalizeKeyPrefix: 2 to 8 letters, upper-cased; anything else is refused', () => {
  assert.equal(normalizeKeyPrefix('alv'), 'ALV');
  assert.equal(normalizeKeyPrefix(' SB '), 'SB');
  for (const bad of ['', 'A', 'TOOLONGXX', 'A-B', '12', undefined, null]) assert.equal(normalizeKeyPrefix(bad), null);
});
