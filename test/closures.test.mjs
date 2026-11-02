// 0.9.31: what became of each actor's closures. A pure calculation over the status history, per actor and per week:
// tickets moved to done, the share reopened within 7 days, the share sent back from review, bulk closures apart,
// every share with its n, and nothing that scores an actor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BULK_MIN, CLOSURES_FIGURE, CLOSURES_READ_AS, closureRows, describeClosureRow, weekOf } from '../lib/closures.mjs';
import { figureCards } from '../lib/figures.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;
// Wednesday 2026-10-28 12:00 UTC; its week starts Monday 2026-10-26.
const NOW = Date.parse('2026-10-28T12:00:00Z');
const MON = Date.parse('2026-10-19T09:00:00Z'); // the Monday before
let seq = 0;
const ev = (ticket, at, actor, from, to) => ({ id: ++seq, ticket_id: ticket, at, actor, from_status: from, to_status: to });
const find = (out, actor, week) => out.rows.find((r) => r.actor === actor && r.week === week);

test('weekOf: the Monday (UTC) of the week, Sunday night included', () => {
  assert.equal(weekOf(Date.parse('2026-10-26T00:00:00Z')), '2026-10-26');
  assert.equal(weekOf(Date.parse('2026-11-01T23:59:59Z')), '2026-10-26');
  assert.equal(weekOf(Date.parse('2026-11-02T00:00:00Z')), '2026-11-02');
  assert.equal(weekOf(Date.parse('2026-01-01T10:00:00Z')), '2025-12-29');
});

test('closures: done, reopened under 7 days, reopened later, sent back from review, each with its n and what is judged', () => {
  const E = [
    // claude closes three tickets in the week of 10-19, spread out (not a bulk).
    ev('t1', MON, 'claude', 'in_progress', 'done'),
    ev('t1', MON + 2 * DAY, 'user', 'done', 'in_progress'), // reopened after 2 days
    ev('t2', MON + 1 * DAY, 'claude', 'in_progress', 'done'),
    ev('t2', MON + 1 * DAY + 8 * DAY, 'user', 'done', 'todo'), // reopened after 8 days: outside the window
    ev('t3', MON + 2 * DAY, 'claude', 'review', 'done'),
    // a closure less than 7 days old, not reopened: not judged yet.
    ev('t4', NOW - 1 * DAY, 'claude', 'in_progress', 'done'),
    // done → waiting_on_user or cancelled is not a reopening.
    ev('t5', MON + 3 * DAY, 'claude', 'in_progress', 'done'),
    ev('t5', MON + 3 * DAY + MIN, 'user', 'done', 'cancelled'),
    // review: claude puts three in review; one comes back, one goes on, one is still there.
    ev('r1', MON, 'claude', 'in_progress', 'review'),
    ev('r1', MON + DAY, 'user', 'review', 'in_progress'),
    ev('r2', MON, 'claude', 'in_progress', 'review'),
    ev('r2', MON + DAY, 'user', 'review', 'done'),
    ev('r3', MON, 'claude', 'in_progress', 'review'),
  ];
  const out = closureRows(E, { now: NOW, weeks: 4 });
  const w = find(out, 'claude', '2026-10-19');
  // claude closed t1, t2, t3, t5 that week (r2 was closed by user).
  assert.equal(w.done.n, 4);
  assert.equal(w.done.settled, 3, 't5 is 6 days old at NOW and not reopened: not judged yet');
  assert.equal(w.done.reopened, 1, 'only t1: done → in_progress under 7 days');
  assert.equal(w.done.reopened_share, 0.333);
  assert.deepEqual(w.review, { n: 3, settled: 2, sent_back: 1, sent_back_share: 0.5 });
  const cur = find(out, 'claude', '2026-10-26');
  assert.deepEqual([cur.done.n, cur.done.settled, cur.done.reopened, cur.done.reopened_share], [1, 0, 0, null], 'a young closure is counted, not judged, and has no share');
  assert.deepEqual(find(out, 'user', '2026-10-19').done.n, 1, 'r2 closed by user');
});

test('closures: 5 or more by one actor in one go are bulk, counted apart, and split the reopen rate', () => {
  const E = [];
  for (let i = 0; i < BULK_MIN; i++) E.push(ev(`b${i}`, MON + i * MIN, 'ruche', 'todo', 'done'));
  E.push(ev('b0', MON + 3 * DAY, 'user', 'done', 'todo')); // one of the bulk comes back
  // four in a row is not a bulk
  for (let i = 0; i < BULK_MIN - 1; i++) E.push(ev(`c${i}`, MON + DAY + i * MIN, 'ruche', 'todo', 'done'));
  // another actor's tickets in the same minutes do not make ruche's chain longer or shorter
  for (let i = 0; i < 3; i++) E.push(ev(`d${i}`, MON + i * MIN, 'kaa', 'todo', 'done'));
  const out = closureRows(E, { now: NOW });
  const r = find(out, 'ruche', '2026-10-19');
  assert.equal(r.done.n, 9);
  assert.deepEqual(r.done.bulk, { n: 5, settled: 5, reopened: 1 });
  assert.deepEqual(r.done.regular, { n: 4, settled: 4, reopened: 0 });
  assert.equal(find(out, 'kaa', '2026-10-19').done.bulk.n, 0);
  // A gap longer than the window cuts the chain: five closures an hour apart are not a bulk.
  const spaced = Array.from({ length: 5 }, (_, i) => ev(`s${i}`, MON + i * 60 * MIN, 'x', 'todo', 'done'));
  assert.equal(find(closureRows(spaced, { now: NOW }), 'x', '2026-10-19').done.bulk.n, 0);
  assert.equal(find(closureRows(spaced, { now: NOW, bulkGapMs: 2 * 3600 * 1000 }), 'x', '2026-10-19').done.bulk.n, 5);
});

test('closures: the window of weeks, the order of rows, input in any order, junk ignored', () => {
  const E = [
    ev('a', Date.parse('2026-08-03T10:00:00Z'), 'old', 'todo', 'done'), // 12 weeks back
    ev('b', NOW - DAY, 'zed', 'todo', 'done'),
    ev('c', NOW - DAY, 'amy', 'todo', 'done'),
    ev('d', MON, 'amy', 'todo', 'done'),
    null,
    { ticket_id: 'e', at: 'x', actor: 'amy', from_status: 'todo', to_status: 'done' },
  ];
  const out = closureRows([...E].reverse(), { now: NOW, weeks: 4 });
  assert.equal(out.from, '2026-10-05');
  assert.equal(find(out, 'old', '2026-08-03'), undefined, 'outside the window');
  assert.deepEqual(out.rows.map((r) => `${r.week} ${r.actor}`), ['2026-10-26 amy', '2026-10-26 zed', '2026-10-19 amy'], 'newest week first, then by name, never by a rate');
  assert.deepEqual(closureRows([], { now: NOW }).rows, []);
  assert.deepEqual(closureRows(undefined, { now: NOW }).rows, []);
});

test('closures: no score, rank or grade comes out; the rows say how to read them; a share never comes without its n', () => {
  const out = closureRows([ev('t', MON, 'claude', 'todo', 'done'), ev('t', MON + DAY, 'u', 'done', 'todo')], { now: NOW });
  const keys = JSON.stringify(out);
  assert.doesNotMatch(keys, /"(score|rank|grade|rating|best|worst|ok)"/i);
  assert.equal(out.read_as, CLOSURES_READ_AS);
  assert.ok(out.read_as.some((s) => /No score, rank or threshold/.test(s)));
  for (const r of out.rows) {
    for (const part of [r.done, r.review]) assert.ok('n' in part && 'settled' in part, 'n and settled sit with the share');
    assert.equal(typeof r.done.reopened_share === 'number' ? r.done.settled > 0 : true, true);
  }
  assert.equal(describeClosureRow(find(out, 'claude', '2026-10-19')), 'claude, week of 2026-10-19: 1 done, reopened 1 of 1 judged');
  const young = closureRows([ev('t', NOW - DAY, 'claude', 'todo', 'done')], { now: NOW });
  assert.match(describeClosureRow(young.rows[0]), /1 done, reopened none judged yet$/);
  const bulk = closureRows(Array.from({ length: 5 }, (_, i) => ev(`q${i}`, MON + i, 'ruche', 'todo', 'done')).concat(ev('rv', MON, 'ruche', 'todo', 'review'), ev('rv', MON + DAY, 'u', 'review', 'in_progress')), { now: NOW });
  assert.equal(describeClosureRow(bulk.rows[0]), 'ruche, week of 2026-10-19: 5 done (5 in bulk), reopened 0 of 5 judged; review: sent back 1 of 1 judged of 1');
});

test('GET /api/closures: read from the board history, with lines and the reading rules', async () => {
  let t = Date.parse('2026-10-20T09:00:00Z');
  const store = await openStore(':memory:', { now: () => t });
  const TOKEN = 'x'.repeat(32);
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  const a = store.createTicket({ title: 'Fix the thing', status: 'in_progress' }, { actor: 'claude', now: t });
  store.updateTicket(a.key, { status: 'done' }, { actor: 'claude', now: t + 1000 });
  store.updateTicket(a.key, { status: 'todo' }, { actor: 'user', now: t + DAY });
  const b = store.createTicket({ title: 'Ship the other', status: 'in_progress' }, { actor: 'claude', now: t });
  store.updateTicket(b.key, { status: 'done' }, { actor: 'claude', now: t + 2000 });
  t = NOW;
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { authorization: `Bearer ${TOKEN}` };
    const res = await fetch(`${base}/api/closures?weeks=4`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.rows.find((r) => r.actor === 'claude' && r.week === '2026-10-19');
    assert.equal(row.done.n, 2);
    assert.equal(row.done.reopened, 1);
    assert.equal(row.done.reopened_share, 0.5);
    assert.equal(body.lines[0], 'claude, week of 2026-10-19: 2 done, reopened 1 of 2 judged');
    assert.ok(body.read_as.length >= 4);
    assert.equal(body.figure.id, 'closures', 'the card travels with the numbers');
    assert.match(body.figure.notFor.join(' '), /ranking an agent.*Comparing two agents.*count alone/s);
    assert.equal((await fetch(`${base}/api/closures`)).status, 401, 'not for a stranger');
    assert.equal((await fetch(`${base}/api/closures`, { method: 'POST', headers: auth })).status, 405);
  } finally {
    server.close();
    store.close();
  }
});

test('the closures card is registered with the figures: measure, week clock, blind spots, not for grading, comparing, or a count alone', () => {
  assert.equal(figureCards().closures, CLOSURES_FIGURE);
  assert.match(CLOSURES_FIGURE.clock, /ISO week/);
  assert.match(CLOSURES_FIGURE.clock, /7 days/);
  assert.match(CLOSURES_FIGURE.fr.notFor.join(' '), /Noter ou classer.*Comparer deux agents.*nombre de fermetures seul/s);
});
