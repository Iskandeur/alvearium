// 0.9.25: the board's heavy reads (the actor list, the projects, a ticket's project priority) answer the same
// as before with a few reads instead of a scan of every ticket per row; `limit` caps the board's columns.
// Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const TOKEN = 'x'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}` };

test('the actor list counts each open ticket once per actor, assigned or created, closed ones left out', async () => {
  const store = await openStore(':memory:');
  for (const id of ['kaa', 'ferao', 'user']) store.touchActor({ id, type: id === 'user' ? 'human' : 'agent' });
  store.createTicket({ title: 'Own work', assignee: 'kaa' }, { actor: 'kaa' });
  store.createTicket({ title: 'For you', assignee: 'user' }, { actor: 'kaa' });
  const done = store.createTicket({ title: 'Finished', assignee: 'kaa' }, { actor: 'kaa' });
  store.updateTicket(done.key, { status: 'done' }, { actor: 'kaa' });
  store.createTicket({ title: 'Handed over', assignee: 'ferao' }, { actor: 'user' });
  const open = Object.fromEntries(store.listActors().map((a) => [a.id, a.open]));
  assert.equal(open.kaa, 2, 'assigned and created by kaa counts once, plus what it created for you');
  assert.equal(open.user, 2);
  assert.equal(open.ferao, 1);
});

test("a ticket's project priority follows a change made after it was first read", async () => {
  const store = await openStore(':memory:');
  const a = store.createTicket({ title: 'Garden', labels: ['front', 'front-id:garden'], assignee: 'lupi' }, { actor: 'lupi' });
  const t = store.createTicket({ title: 'Water the roses', assignee: 'user', labels: ['front-id:garden'] }, { actor: 'lupi' });
  assert.equal(store.getTicket(t.key).project_priority, null);
  store.updateTicket(a.key, { priority: 'P1' }, { actor: 'user' });
  assert.equal(store.getTicket(t.key).project_priority.priority, 'P1');
  // An older open project with the same tag wins, as before; a closed one lends nothing.
  const older = store.createTicket({ title: 'Garden (old)', labels: ['front', 'front-id:garden'], priority: 'P3', assignee: 'lupi' }, { actor: 'user' });
  assert.equal(store.getTicket(t.key).project_priority.key, a.key, 'the lowest number first');
  store.updateTicket(a.key, { status: 'done' }, { actor: 'user' });
  assert.equal(store.getTicket(t.key).project_priority.key, older.key, 'a closed project lends nothing');
});

test('a project counts its sub-tickets and its tagged tickets once each, never itself', async () => {
  const store = await openStore(':memory:');
  const p = store.createTicket({ title: 'Move house', labels: ['front', 'front-id:move'], assignee: 'lupi' }, { actor: 'user' });
  const q = store.createTicket({ title: 'Plant trees', labels: ['front', 'front-id:trees'], assignee: 'lupi' }, { actor: 'user' });
  store.createTicket({ title: 'Boxes', parent: p.key, labels: ['front-id:move'] }, { actor: 'lupi' });
  store.createTicket({ title: 'Movers', labels: ['front-id:move'] }, { actor: 'lupi' });
  const keys = store.createTicket({ title: 'Keys', parent: p.key }, { actor: 'lupi' });
  store.updateTicket(keys.key, { status: 'done' }, { actor: 'user' });
  store.createTicket({ title: 'Oak', labels: ['front-id:trees'] }, { actor: 'lupi' });
  const byKey = Object.fromEntries(store.ticketBoard({}).projects.map((x) => [x.key, x]));
  assert.deepEqual(byKey[p.key].tickets, { total: 3, open: 2 });
  assert.deepEqual(byKey[q.key].tickets, { total: 1, open: 1 });
});

test('GET /api/tickets/board?limit=N caps each column, the counts stay exact; without limit nothing changes', async () => {
  const store = await openStore(':memory:');
  for (let i = 0; i < 5; i++) store.createTicket({ title: `Task ${i}`, status: 'todo', assignee: 'kaa' }, { actor: 'kaa' });
  for (let i = 0; i < 40; i++) store.updateTicket(store.createTicket({ title: `Old ${i}`, assignee: 'kaa' }, { actor: 'kaa' }).key, { status: 'done' }, { actor: 'kaa' });
  const server = createServer(createApp({ token: TOKEN, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const one = await (await fetch(`${base}/api/tickets/board?limit=1`, { headers: auth })).json();
    assert.equal(one.counts.todo, 5);
    assert.equal(one.counts.done, 40);
    assert.equal(one.columns.todo.length, 1);
    assert.equal(one.columns.done.length, 1);
    const all = await (await fetch(`${base}/api/tickets/board`, { headers: auth })).json();
    assert.equal(all.columns.todo.length, 5);
    assert.equal(all.columns.done.length, 30, 'Done keeps its 30');
    const big = await (await fetch(`${base}/api/tickets/board?limit=100`, { headers: auth })).json();
    assert.equal(big.columns.done.length, 30, 'a limit never shows more of Done');
  } finally {
    server.close();
  }
});
