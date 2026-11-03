import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, STATEMENT_CACHE_MAX } from '../lib/store.mjs';

const DAY = 86400000;

// The board is read on every poll. The text of its SQL must not depend on the clock: `Store.q` keeps every
// statement it prepares, so a literal that moves with `now` was one new cached statement per read, for ever.
test('reading the board at different times prepares the same SQL', async () => {
  const store = await openStore(':memory:', { projectLabel: 'project' });
  store.createTicket({ title: 'one', assignee: 'user' }, { actor: 'user' });
  const seen = new Set();
  const real = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => (seen.add(sql), real(sql));
  const t0 = Date.now();
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    store.ticketBoard({}, { perColumn: 5, doneShown: 5, now: t0 + i * 37 * DAY });
    store.listTickets({}, t0 + i * 37 * DAY);
    store.legacyBoard(t0 + i * 37 * DAY);
    sizes.push(seen.size);
  }
  assert.ok(sizes[0] > 0);
  // Same reads, later clock: not one new SQL text.
  assert.deepEqual(sizes, Array(6).fill(sizes[0]), `new SQL texts appeared as the clock moved: ${sizes}`);
  assert.ok(store.stmts.size < 80, `cache grew to ${store.stmts.size}`);
});

test('the archive and snooze cutoffs still do their job as bound values', async () => {
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'old and done', assignee: 'user' }, { actor: 'user' });
  store.updateTicket(t.key, { status: 'done' }, { actor: 'user' });
  const now = Date.now();
  assert.equal(store.listTickets({}, now).total, 1, 'a fresh closed ticket is listed');
  assert.equal(store.listTickets({}, now + 400 * DAY).total, 0, 'a year later it is archived');
  assert.equal(store.listTickets({ archived: 'only' }, now + 400 * DAY).total, 1);
  assert.equal(store.ticketBoard({}, { now: now + 400 * DAY }).columns.done.length, 0);
});

test('the statement cache has a ceiling, the oldest statement goes first', async () => {
  const store = await openStore(':memory:');
  for (let i = 0; i < STATEMENT_CACHE_MAX + 50; i++) store.q(`SELECT ${i} AS n`);
  assert.equal(store.stmts.size, STATEMENT_CACHE_MAX);
  assert.ok(!store.stmts.has('SELECT 0 AS n'));
  assert.ok(store.stmts.has(`SELECT ${STATEMENT_CACHE_MAX + 49} AS n`));
});
