// 0.5.15: less to do for the owner. A reply you have not read shows at a glance (stored per reader on the
// server), a comment of yours hands the ticket over (to whom you @mention, else to the installation's
// router), and a mention can name a sub-actor (crew/router).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mentionedIds, openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const TOKEN = 'x'.repeat(32);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

function clocked(opts = {}) {
  let t = 1_000_000;
  const clock = () => (t += 1000);
  return openStore(':memory:', { now: clock, ...opts });
}
const agent = (store, id, name, parent = null) => store.touchActor({ id, type: 'agent', name, parent });

// ---- mentions -----------------------------------------------------------------------------------

test('mentionedIds: plain ids and one level of sub-actor, never inside a word or an email', () => {
  assert.deepEqual(mentionedIds('@fern look'), ['fern']);
  assert.deepEqual(mentionedIds('ping @crew/router, then (@crew/scout)'), ['crew/router', 'crew/scout']);
  assert.deepEqual(mentionedIds('mail me@host.io or x@crew'), []);
  assert.deepEqual(mentionedIds('@a/b/c'), [], 'two levels is not an actor id the page offers');
});

const from = page.indexOf('function computeMention(text, caret, all) {');
const to = page.indexOf('function mentionUpdate(ta) {', from);
const computeMention = new Function(`${page.slice(from, to)}; return computeMention;`)();
const ALL = [
  { id: 'crew', name: 'Crew' },
  { id: 'crew/router', name: 'Router' },
  { id: 'crew/scout', name: 'Scout' },
  { id: 'fern', name: 'Fern' },
];

test('page mentions: a sub-actor is offered by its name, its own part, or its full id', () => {
  assert.deepEqual(computeMention('@rou', 4, ALL).list.map((a) => a.id), ['crew/router'], 'by name');
  assert.deepEqual(computeMention('@crew/', 6, ALL).list.map((a) => a.id), ['crew/router', 'crew/scout'], 'the slash keeps the box open');
  assert.deepEqual(computeMention('@crew/s', 7, ALL).list.map((a) => a.id), ['crew/scout']);
  assert.deepEqual(computeMention('@sco', 4, ALL).list.map((a) => a.id), ['crew/scout'], 'by its own part');
  assert.equal(computeMention('@crew/x/y', 9, ALL), null);
});

test('page mentions: the id pattern accepts a sub-actor and the renderer turns it into a pill', () => {
  const m = page.match(/const MENTION_ID = (\/.+\/u);/);
  assert.ok(m, 'MENTION_ID is in the page');
  const re = new Function(`return ${m[1]}`)();
  assert.ok(re.test('fern') && re.test('crew/router'));
  assert.ok(!re.test('a/b/c') && !re.test('crew/') && !re.test('x y'));
  assert.match(page, /@\(\[\\p\{L\}0-9-\]\{1,64\}\(\?:\\\/\[\\p\{L\}0-9-\]\{1,64\}\)\?\)/, 'the renderer reads @parent/child');
});

// ---- a comment of the owner hands the ticket over -----------------------------------------------

test('owner comment: to the actor it mentions, out of the waiting lane, back when handed back', async () => {
  const store = await clocked({ defaultRouter: 'crew/router' });
  agent(store, 'crew', 'Crew');
  agent(store, 'crew/scout', 'Scout', 'crew');
  const t = store.createTicket({ title: 'Pick a host', status: 'waiting_on_user', assignee: 'user' }, { actor: 'crew' });
  const out = store.comment(t.key, 'Not sure, @crew/scout can you compare prices?', { actor: 'user' });
  assert.equal(out.assignee, 'crew/scout');
  assert.equal(out.status, 'todo', 'it left "waiting on you"');
  assert.equal(store.ticketBoard({}).columns.waiting.length, 0);
  // The agent's own comment changes nothing; its hand-back does.
  store.comment(t.key, 'Looking.', { actor: 'crew/scout' });
  assert.equal(store.getTicket(t.key).assignee, 'crew/scout');
  store.updateTicket(t.key, { assignee: 'user', status: 'waiting_on_user' }, { actor: 'crew/scout' });
  assert.equal(store.ticketBoard({}).columns.waiting.length, 1);
  const types = store.getTicket(t.key).events.map((e) => e.type);
  assert.ok(types.includes('assigned'), 'the hand-over is in the history');
});

test('owner comment: no mention → the default router; no router → nothing moves', async () => {
  const routed = await clocked({ defaultRouter: 'crew/router' });
  agent(routed, 'crew/router', 'Router', 'crew');
  const a = routed.createTicket({ title: 'A', status: 'waiting_on_user', assignee: 'user' });
  assert.equal(routed.comment(a.key, 'Done on my side, what next?', { actor: 'user' }).assignee, 'crew/router');

  const plain = await clocked();
  const b = plain.createTicket({ title: 'B', status: 'waiting_on_user', assignee: 'user' });
  const out = plain.comment(b.key, 'noted', { actor: 'user' });
  assert.equal(out.assignee, 'user');
  assert.equal(out.status, 'waiting_on_user');
});

test('owner comment: agents, unknown mentions, session tickets, closed tickets and explicit moves are left alone', async () => {
  const store = await clocked({ defaultRouter: 'crew/router' });
  const t = store.createTicket({ title: 'T', status: 'waiting_on_user', assignee: 'user' });
  assert.equal(store.comment(t.key, 'a note', { actor: 'crew' }).assignee, 'user', 'an agent commenting does not route');
  assert.equal(store.comment(t.key, '@nobody look', { actor: 'user' }).assignee, 'crew/router', 'an unknown name falls back on the router');
  const closed = store.createTicket({ title: 'C', status: 'done', assignee: 'user' });
  assert.equal(store.comment(closed.key, 'thanks', { actor: 'user' }).assignee, 'user');
  const s = store.createTicket({ title: 'S', status: 'waiting_on_user', assignee: 'user', kind: 'session' });
  assert.equal(store.comment(s.key, 'go on', { actor: 'user' }).assignee, 'user', 'a session ticket follows its hooks');
  const m = store.createTicket({ title: 'M', status: 'waiting_on_user', assignee: 'user' });
  const kept = store.updateTicket(m.key, { status: 'in_progress', comment: 'on it myself' }, { actor: 'user' });
  assert.equal(kept.assignee, 'user', 'a comment riding with its own move keeps that move');
  assert.equal(kept.status, 'in_progress');
  const r = store.createTicket({ title: 'R', status: 'todo', assignee: 'crew/scout' });
  assert.equal(store.comment(r.key, 'any news?', { actor: 'user' }).assignee, 'crew/scout', 'already with someone: stays there without a mention');
});

// ---- replies you have not read ------------------------------------------------------------------

test('unread replies: a later comment by someone else, cleared by a visit or by answering', async () => {
  const store = await clocked();
  const t = store.createTicket({ title: 'Mine', assignee: 'crew' }, { actor: 'user' });
  const other = store.createTicket({ title: 'Not mine', assignee: 'crew' }, { actor: 'crew' });
  store.comment(other.key, 'chatter', { actor: 'crew' });
  assert.equal(store.unreadReplies('user').length, 0, 'nothing answered yet');
  store.comment(t.key, 'Here is the answer', { actor: 'crew' });
  assert.deepEqual(store.unreadReplies('user').map((x) => [x.key, x.by]), [[t.key, 'crew']]);
  assert.deepEqual(store.listTickets({ unread: 'user' }).tickets?.map((x) => x.key) ?? store.listTickets({ unread: 'user' }).map((x) => x.key), [t.key]);
  store.markSeen(t.key, 'user');
  assert.equal(store.unreadReplies('user').length, 0, 'read once opened');
  store.comment(t.key, 'One more thing', { actor: 'crew' });
  assert.equal(store.unreadReplies('user').length, 1);
  store.comment(t.key, 'ok', { actor: 'user' });
  assert.equal(store.unreadReplies('user').length, 0, 'answering reads it too');
  assert.equal(store.unreadReplies('crew').length, 1, 'each reader has its own state');
});

test('unread replies over HTTP: count, filter, seen from any device', async () => {
  const store = await clocked();
  const server = createServer(createApp({ token: TOKEN, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  try {
    const t = store.createTicket({ title: 'Mine', assignee: 'crew' }, { actor: 'user' });
    store.comment(t.key, 'answered', { actor: 'crew' });
    const u = await (await fetch(`${base}/api/unread`, { headers: h })).json();
    assert.equal(u.count, 1);
    assert.equal(u.open, 1);
    assert.equal(u.tickets[0].key, t.key);
    // A reply on a closed ticket stays listed, but `open` (the number the page shows) leaves it out.
    const closed = store.createTicket({ title: 'Closed', assignee: 'crew' }, { actor: 'user' });
    store.comment(closed.key, 'answered', { actor: 'crew' });
    store.updateTicket(closed.key, { status: 'done' }, { actor: 'crew' });
    const u2 = await (await fetch(`${base}/api/unread`, { headers: h })).json();
    assert.equal(u2.count, 2);
    assert.equal(u2.open, 1);
    store.markSeen(closed.key, 'user');
    const board = await (await fetch(`${base}/api/tickets/board?unread=1`, { headers: h })).json();
    const keys = Object.values(board.columns).flat().map((x) => x.key);
    assert.deepEqual(keys, [t.key]);
    assert.equal((await fetch(`${base}/api/tickets/${t.key}/seen`, { method: 'POST', headers: h, body: '{}' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/unread`, { headers: h })).json()).count, 0);
    assert.equal((await fetch(`${base}/api/tickets/${t.key}/seen`, { headers: h })).status, 405);
  } finally {
    server.close();
  }
});
