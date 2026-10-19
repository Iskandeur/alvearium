// 0.8.0: a hold that waits for a state of the world, lifted by a proof (or past its deadline, "not met").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHold } from '../lib/hold.mjs';
import { openStore } from '../lib/store.mjs';

const T0 = 1_800_000_000_000;
async function board() {
  let now = T0;
  const s = await openStore(':memory:', { now: () => now });
  return { s, at: (ms) => (now = T0 + ms) };
}
const lastComment = (t) => t.events.filter((e) => e.type === 'comment').at(-1)?.text;

test('sanitizeHold external: what in words, an optional deadline and otherwise, refusals', () => {
  const v = sanitizeHold({ condition: { type: 'external', what: '  the hall   sensor sees someone ', deadline: T0 + 3600_000, otherwise: { type: 'assign', to: 'user' } } }, T0).value;
  assert.deepEqual(v.condition, { type: 'external', what: 'the hall sensor sees someone', deadline: T0 + 3600_000, otherwise: { type: 'assign', to: 'user', status: 'todo' } });
  assert.deepEqual(sanitizeHold({ condition: { type: 'external', what: 'x' } }, T0).value.condition, { type: 'external', what: 'x' });
  assert.match(sanitizeHold({ condition: { type: 'external' } }, T0).error, /condition.what/);
  assert.match(sanitizeHold({ condition: { type: 'external', what: 'x', deadline: 'soon' } }, T0).error, /condition.deadline/);
  assert.match(sanitizeHold({ condition: { type: 'external', what: 'x', deadline: T0 + 400 * 86400000 } }, T0).error, /within a year/);
  assert.match(sanitizeHold({ condition: { type: 'external', what: 'x', otherwise: { type: 'wake', actor: 'user' } } }, T0).error, /condition.otherwise.actor/);
});

test('external: waits in words, fired with a proof, back through then with the proof in the history', async () => {
  const { s, at } = await board();
  const t = s.createTicket({ title: 'check the hall sensor', assignee: 'builder' }, { actor: 'builder' });
  const held = s.hold(t.key, { condition: { type: 'external', what: 'the hall sensor sees someone come in', deadline: T0 + 7200_000 }, then: { type: 'assign', to: 'user', text: 'It works.' } }, { actor: 'builder' });
  assert.equal(held.status, 'on_hold');
  assert.match(held.hold.waits_for, /^the hall sensor sees someone come in \(until .* UTC\)$/);
  at(60_000);
  assert.deepEqual(s.tickHolds(), [], 'the clock never lifts an external hold before its deadline');
  assert.throws(() => s.fireHoldExternal(t.key, { proof: ' ' }, { actor: 'watcher' }), /proof/);
  const back = s.fireHoldExternal(t.key, { proof: 'on at 19:42 (history)' }, { actor: 'watcher' });
  assert.equal(back.status, 'todo');
  assert.equal(back.assignee, 'user');
  assert.equal(back.hold, null);
  const full = s.getTicket(t.key);
  assert.ok(full.events.some((e) => e.type === 'resumed' && /seen: the hall sensor sees someone come in \(on at 19:42 \(history\)\)/.test(e.text)));
  assert.equal(lastComment(full), 'It works.');
  assert.throws(() => s.fireHoldExternal(t.key, { proof: 'again' }, { actor: 'watcher' }), (e) => e.status === 409, 'a second fire finds nothing');
  at(8000_000);
  assert.deepEqual(s.tickHolds(), [], 'nothing fires twice');
});

test('external past its deadline, unmet: back through otherwise, saying it was not seen', async () => {
  const { s, at } = await board();
  const t = s.createTicket({ title: 'check the sensor', assignee: 'builder' }, { actor: 'builder' });
  s.hold(t.key, {
    condition: { type: 'external', what: 'the sensor sees me', deadline: T0 + 3600_000, otherwise: { type: 'assign', to: 'user', text: 'Nothing seen: look at the sensor.' } },
    then: { type: 'wake', actor: 'builder' },
  }, { actor: 'builder' });
  at(3600_000);
  assert.deepEqual(s.tickHolds(), [t.key]);
  const full = s.getTicket(t.key);
  assert.equal(full.assignee, 'user');
  assert.ok(full.events.some((e) => e.type === 'resumed' && /not met: the sensor sees me was not seen by/.test(e.text)));
  assert.equal(lastComment(full), 'Nothing seen: look at the sensor.');

  // Without otherwise, an unmet deadline runs then.
  const u = s.createTicket({ title: 'other', assignee: 'builder' }, { actor: 'builder' });
  s.hold(u.key, { condition: { type: 'external', what: 'it answers', deadline: T0 + 7200_000 }, then: { type: 'wake', actor: 'builder' } }, { actor: 'builder' });
  at(7200_000);
  assert.deepEqual(s.tickHolds(), [u.key]);
  assert.match(lastComment(s.getTicket(u.key)), /^@builder not met: it answers was not seen by/);
});

test('refusals: a deadline already past, a fire on a hold of another kind or a ticket not on hold', async () => {
  const { s } = await board();
  const t = s.createTicket({ title: 'x' }, { actor: 'user' });
  assert.throws(() => s.hold(t.key, { condition: { type: 'external', what: 'x', deadline: T0 - 1 } }, { actor: 'user' }), /already past/);
  assert.throws(() => s.fireHoldExternal(t.key, { proof: 'p' }, { actor: 'user' }), (e) => e.status === 409);
  s.hold(t.key, { condition: { type: 'time', at: T0 + 60_000 } }, { actor: 'user' });
  assert.throws(() => s.fireHoldExternal(t.key, { proof: 'p' }, { actor: 'user' }), /external state/);
  assert.throws(() => s.fireHoldExternal('ALV-999', { proof: 'p' }, { actor: 'user' }), (e) => e.status === 404);
});
