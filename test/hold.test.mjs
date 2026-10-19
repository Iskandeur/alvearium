// 0.6.0: on hold — a ticket that waits is woken by the event that unblocks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnOf } from '../lib/core.mjs';
import { defaultNext, normalizePr, sanitizeHold } from '../lib/hold.mjs';
import { openStore } from '../lib/store.mjs';

const T0 = 1_800_000_000_000;
async function board(opts = {}) {
  let now = T0;
  const s = await openStore(':memory:', { now: () => now, ...opts });
  return { s, at: (ms) => (now = T0 + ms), now: () => now };
}

test('sanitizeHold: the four conditions, the three next steps, refusals in words', () => {
  assert.deepEqual(sanitizeHold({ condition: { type: 'blocked_by', keys: 'ALV-1, ALV-2' } }, T0).value.condition, { type: 'blocked_by', keys: ['ALV-1', 'ALV-2'] });
  assert.equal(sanitizeHold({ condition: { type: 'pr_merged', pr: 'https://github.com/Acme/Repo/pull/12' } }, T0).value.condition.pr, 'acme/repo#12');
  assert.equal(normalizePr('acme/repo#x'), null);
  assert.equal(normalizePr('../..#1'), null, 'no dot segments in the API URL');
  assert.equal(normalizePr('acme/..#1'), null);
  assert.equal(normalizePr('acme/repo.js#3'), 'acme/repo.js#3');
  assert.match(sanitizeHold({ condition: { type: 'reply', from: 'ops' }, then: { type: 'assign', to: 'user', status: 'done' } }).error, /open status/);
  assert.equal(sanitizeHold({ condition: { type: 'time', at: '2027-01-15T09:00:00Z' } }, T0).value.condition.at, Date.parse('2027-01-15T09:00:00Z'));
  assert.match(sanitizeHold({ condition: { type: 'time', at: T0 + 400 * 86400000 } }, T0).error, /within a year/);
  assert.match(sanitizeHold({ condition: { type: 'nope' } }).error, /condition.type/);
  assert.match(sanitizeHold({ condition: { type: 'reply', from: 'ops' }, then: { type: 'wake', actor: 'user' } }).error, /agent id/);
  assert.match(sanitizeHold({ condition: { type: 'reply', from: 'ops' }, then: { type: 'assign', to: 'user', status: 'on_hold' } }).error, /open status other than on_hold/);
  assert.match(sanitizeHold({ condition: { type: 'reply', from: 'ops' }, then: { type: 'comment' } }).error, /what to post/);
  assert.deepEqual(defaultNext({ set_by: 'builder', prev_assignee: 'user' }).type, 'wake');
  assert.deepEqual(defaultNext({ set_by: 'user', prev_assignee: 'user' }), { type: 'assign', to: 'user', status: 'todo' });
});

test('blocked_by: out of every lane, then back with the agent that put it on hold when the blocker closes', async () => {
  const { s, at } = await board();
  const a = s.createTicket({ title: 'migrate the schema' }, { actor: 'builder' });
  const b = s.createTicket({ title: 'ship the feature', assignee: 'builder' }, { actor: 'builder' });
  const held = s.hold(b.key, { condition: { type: 'blocked_by', keys: [a.key] } }, { actor: 'builder' });
  assert.equal(held.status, 'on_hold');
  assert.equal(held.column, 'onHold');
  assert.equal(held.hold.waits_for, `${a.key} closed`);
  assert.equal(held.hold.next_text, 'wake @builder');
  const bd = s.ticketBoard({});
  assert.equal(bd.counts.onHold, 1);
  for (const c of ['waiting', 'inProgress', 'todo']) assert.ok(!bd.columns[c].some((t) => t.key === b.key), c);
  assert.equal(s.nextTickets({}).tickets.some((t) => t.key === b.key), false);
  at(60_000);
  s.updateTicket(a.key, { status: 'done' }, { actor: 'user' });
  const after = s.getTicket(b.key);
  assert.equal(after.status, 'todo');
  assert.equal(after.assignee, 'builder');
  assert.equal(after.hold, null);
  const resumed = after.events.find((e) => e.type === 'resumed');
  assert.equal(resumed.text, `Back with @builder: ${a.key} is closed`);
  const c = after.events.filter((e) => e.type === 'comment').at(-1);
  assert.match(c.text, new RegExp(`^@builder ${a.key} is closed\\.`));
  assert.equal(c.target, 'builder');
  // Idempotent: nothing left to fire.
  assert.deepEqual(s.tickHolds(), []);
});

test('the owner only gets it back directly when the next step says so', async () => {
  const { s } = await board();
  const a = s.createTicket({ title: 'blocker' }, { actor: 'builder' });
  const b = s.createTicket({ title: 'pick a name', kind: 'decision', assignee: 'builder' }, { actor: 'builder' });
  s.hold(b.key, { condition: { type: 'blocked_by', keys: [a.key] }, then: { type: 'assign', to: 'user', status: 'waiting_on_user', text: 'Both names are ready.' } }, { actor: 'builder' });
  s.updateTicket(a.key, { status: 'cancelled' });
  const t = s.getTicket(b.key);
  assert.equal(t.assignee, 'user');
  assert.equal(t.status, 'waiting_on_user');
  assert.equal(t.column, 'waiting');
  assert.equal(t.events.find((e) => e.type === 'resumed').text, `Back with you: ${a.key} is closed`);
});

test('pull request merged, time reached, reply from an actor', async () => {
  const { s, at } = await board();
  const p = s.createTicket({ title: 'after the merge', assignee: 'builder' }, { actor: 'builder' });
  s.hold(p.key, { condition: { type: 'pr_merged', pr: 'acme/repo#7' }, then: { type: 'comment', text: 'Merged: deploy it.' } }, { actor: 'builder' });
  assert.deepEqual(s.awaitedPrs(), ['acme/repo#7']);
  assert.deepEqual(s.signalPr('acme/repo#7', 'open').woken, []);
  assert.deepEqual(s.signalPr('acme/repo#7', 'merged').woken, [p.key]);
  assert.equal(s.getTicket(p.key).assignee, 'builder');
  assert.equal(s.getTicket(p.key).events.filter((e) => e.type === 'comment').at(-1).text, 'Merged: deploy it.');

  const q = s.createTicket({ title: 'call back on Monday' }, { actor: 'user' });
  s.hold(q.key, { condition: { type: 'time', at: T0 + 3600_000 } }, { actor: 'user' });
  assert.deepEqual(s.tickHolds(), []);
  at(3600_000);
  assert.deepEqual(s.tickHolds(), [q.key]);
  assert.equal(s.getTicket(q.key).assignee, 'user');

  s.touchActor({ id: 'reviewer', type: 'agent' });
  const r = s.createTicket({ title: 'needs a review', assignee: 'builder' }, { actor: 'builder' });
  s.hold(r.key, { condition: { type: 'reply', from: 'reviewer' }, then: { type: 'wake', actor: 'builder', text: 'Read the review.' } }, { actor: 'builder' });
  s.comment(r.key, 'unrelated', { actor: 'user' });
  assert.equal(s.getTicket(r.key).status, 'on_hold');
  s.comment(r.key, 'Looks good.', { actor: 'reviewer' });
  const rr = s.getTicket(r.key);
  assert.equal(rr.status, 'todo');
  assert.match(rr.events.filter((e) => e.type === 'comment').at(-1).text, /^@builder @reviewer replied\. Read the review\.$/);
});

test('a pull request closed without merge leaves the hold stuck, and says why', async () => {
  const { s } = await board();
  const p = s.createTicket({ title: 'x' }, { actor: 'builder' });
  s.hold(p.key, { condition: { type: 'pr_merged', pr: 'acme/repo#8' } }, { actor: 'builder' });
  s.signalPr('acme/repo#8', 'closed');
  const t = s.getTicket(p.key);
  assert.equal(t.status, 'on_hold');
  assert.match(t.hold.stuck, /closed without being merged/);
  assert.deepEqual(s.awaitedPrs(), []);
});

test('refusals: nothing to wait for, a closed ticket, the bounce cap; status on_hold uses the open blockers', async () => {
  const { s } = await board({ holdMaxBounces: 2 });
  const a = s.createTicket({ title: 'a' });
  assert.throws(() => s.hold(a.key, { condition: { type: 'blocked_by' } }), /nothing open blocks it/);
  assert.throws(() => s.updateTicket(a.key, { status: 'on_hold' }), /nothing open blocks it/);
  assert.equal(s.getTicket(a.key).status, 'todo', 'refused whole');
  const b = s.createTicket({ title: 'b' });
  const viaStatus = s.updateTicket(a.key, { status: 'on_hold', blocked_by_add: [b.key] }, { actor: 'builder' });
  assert.equal(viaStatus.status, 'on_hold');
  assert.deepEqual(viaStatus.hold.condition, { type: 'blocked_by', keys: [b.key] });
  s.updateTicket(b.key, { status: 'done' });
  s.updateTicket(b.key, { status: 'todo' });
  s.hold(a.key, { condition: { type: 'blocked_by' } });
  s.updateTicket(b.key, { status: 'done' });
  assert.equal(s.getTicket(a.key).hold, null);
  s.updateTicket(b.key, { status: 'todo' });
  assert.throws(() => s.hold(a.key, { condition: { type: 'blocked_by' } }), /woken 2 times already/);
  s.updateTicket(b.key, { status: 'done' });
  assert.throws(() => s.hold(b.key, { condition: { type: 'time', at: T0 + 1000 } }), /closed ticket/);
});

test('the bounce cap counts the wakes of the last 7 days, and starts again after a hold lifted by hand', async () => {
  const { s, at } = await board({ holdMaxBounces: 2 });
  const a = s.createTicket({ title: 'a' });
  const wake = (ms) => {
    at(ms);
    s.hold(a.key, { condition: { type: 'time', at: T0 + ms + 1000 } });
    at(ms + 1000);
    s.tickHolds();
  };
  wake(0);
  wake(10_000);
  assert.throws(() => s.hold(a.key, { condition: { type: 'time', at: T0 + 30_000 } }), /woken 2 times already/);
  // Eight days later the two old wakes no longer count.
  const D8 = 8 * 86400_000;
  wake(D8);
  // One fresh wake: a hold lifted by hand then starts the count over, so two more wakes still pass.
  at(D8 + 5000);
  s.hold(a.key, { condition: { type: 'time', at: T0 + D8 + 60_000 } });
  s.unhold(a.key);
  wake(D8 + 10_000);
  wake(D8 + 20_000);
  assert.throws(() => s.hold(a.key, { condition: { type: 'time', at: T0 + D8 + 60_000 } }), /woken 2 times already/);
});

test('lifting a hold by hand, or moving the ticket, drops the hold without running the next step', async () => {
  const { s } = await board();
  const t = s.createTicket({ title: 't', assignee: 'builder', status: 'in_progress' }, { actor: 'builder' });
  s.hold(t.key, { condition: { type: 'time', at: T0 + 5000 } }, { actor: 'builder' });
  const back = s.unhold(t.key, { actor: 'user' });
  assert.equal(back.status, 'in_progress');
  assert.equal(back.assignee, 'builder');
  s.hold(t.key, { condition: { type: 'time', at: T0 + 5000 } }, { actor: 'builder' });
  s.updateTicket(t.key, { status: 'todo' });
  assert.equal(s.holdOf(t.id), null);
  assert.equal(columnOf({ status: 'on_hold', assignee: 'user' }), 'onHold');
});
