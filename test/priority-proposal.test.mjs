// 0.9.5: a priority remembers who set it. On a ticket assigned to the owner (or on a project), an agent's
// priority is a proposal until a human sets or confirms it; a project's confirmed priority lends itself to
// its tickets. Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.mjs';
import { renderTicketsText } from '../lib/core.mjs';

test('an agent sets a priority on your ticket: a proposal, with who proposed it', async () => {
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'Send the form', assignee: 'user', priority: 'P0' }, { actor: 'kaa' });
  const got = store.getTicket(t.key);
  assert.equal(got.priority, 'P0');
  assert.equal(got.priority_by, 'kaa');
  assert.equal(got.priority_proposed, true);
  const mine = store.createTicket({ title: 'Call the bank', assignee: 'user', priority: 'P1' }, { actor: 'user' });
  assert.equal(store.getTicket(mine.key).priority_proposed, false, 'set by you');
  const theirs = store.createTicket({ title: 'Refactor', assignee: 'kaa', priority: 'P0' }, { actor: 'kaa' });
  assert.equal(store.getTicket(theirs.key).priority_proposed, false, "an agent's priority on its own work is not a proposal");
  assert.equal(store.getTicket(store.createTicket({ title: 'No priority', assignee: 'user' }, { actor: 'kaa' }).key).priority_proposed, false);
});

test('you confirm by setting the same value; an agent setting it again makes it a proposal again', async () => {
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'Book the flight', assignee: 'user', priority: 'P1' }, { actor: 'kaa' });
  store.updateTicket(t.key, { priority: 'P1' }, { actor: 'kaa' });
  assert.equal(store.getTicket(t.key).priority_proposed, true, 'the agent cannot confirm itself');
  store.updateTicket(t.key, { priority: 'P1' }, { actor: 'user' });
  let got = store.getTicket(t.key);
  assert.deepEqual([got.priority, got.priority_by, got.priority_proposed], ['P1', 'user', false]);
  assert.ok(got.events.some((e) => e.type === 'edit' && e.actor === 'user' && /priority/.test(e.text)), 'the confirmation is in the history');
  store.updateTicket(t.key, { priority: 'P1' }, { actor: 'user' });
  assert.equal(store.getTicket(t.key).events.filter((e) => e.type === 'edit').length, 1, 'confirming twice writes nothing');
  store.updateTicket(t.key, { priority: 'P0' }, { actor: 'kaa' });
  got = store.getTicket(t.key);
  assert.deepEqual([got.priority, got.priority_by, got.priority_proposed], ['P0', 'kaa', true]);
  store.updateTicket(t.key, { priority: null }, { actor: 'kaa' });
  got = store.getTicket(t.key);
  assert.deepEqual([got.priority, got.priority_by, got.priority_proposed], [null, null, false]);
});

test('a project you ranked lends its priority; a project priority an agent proposed lends nothing', async () => {
  const store = await openStore(':memory:');
  const health = store.createTicket({ title: 'Health', labels: ['front', 'front-id:health'], priority: 'P0', assignee: 'lupi' }, { actor: 'lupi' });
  assert.equal(store.getTicket(health.key).priority_proposed, true, "a project's priority is the owner's call, whoever holds it");
  const child = store.createTicket({ title: 'Book the check-up', assignee: 'user', parent: health.key }, { actor: 'lupi' });
  const byLabel = store.createTicket({ title: 'Renew the prescription', assignee: 'user', labels: ['front-id:health'] }, { actor: 'lupi' });
  assert.equal(store.getTicket(child.key).project_priority, null);
  store.updateTicket(health.key, { priority: 'P0' }, { actor: 'user' });
  for (const k of [child.key, byLabel.key]) assert.deepEqual(store.getTicket(k).project_priority, { key: health.key, title: 'Health', priority: 'P0' }, k);
  const grandchild = store.createTicket({ title: 'Fast before it', assignee: 'user', parent: child.key }, { actor: 'lupi' });
  assert.equal(store.getTicket(grandchild.key).project_priority.priority, 'P0', 'up the parents');
  const p = store.ticketBoard({}).projects.find((x) => x.key === health.key);
  assert.equal(p.priority_proposed, false);
});

test('the lane: a confirmed P1 passes a proposed P0; the text board marks the proposal', async () => {
  const store = await openStore(':memory:');
  const proposed = store.createTicket({ title: 'Agent says urgent', assignee: 'user', status: 'waiting_on_user', kind: 'decision', priority: 'P0' }, { actor: 'kaa' });
  const yours = store.createTicket({ title: 'You said next', assignee: 'user', status: 'waiting_on_user', kind: 'decision', priority: 'P1' }, { actor: 'user' });
  const board = store.ticketBoard({});
  assert.deepEqual(board.columns.waiting.map((t) => t.key), [yours.key, proposed.key]);
  const text = renderTicketsText(board);
  assert.match(text, new RegExp(`${proposed.key} P0\\? Agent says urgent`));
  assert.match(text, new RegExp(`${yours.key} P1 You said next`));
});

test('page: a proposal reads "P1?" with who proposed it, and the panel offers to confirm it', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  assert.match(page, /t\?\.priority_proposed\s*\? `<span class="prio \$\{esc\(p\)\} proposed"/);
  assert.match(page, /proposed by \{by\}: not yours until you set or confirm it', \{ p: PRIO\[p\] \|\| p, by: t\.priority_by_name/);
  assert.match(page, /data-confirm-prio="\$\{esc\(t\.key\)\}">Confirm \$\{esc\(t\.priority\)\}/);
  assert.match(page, /await api\(`tickets\/\$\{encodeURIComponent\(t\.key\)\}`, \{ priority: t\.priority \}\)/);
  for (const call of ['prio(p.priority, p)', 'prio(t.priority, t)']) assert.ok(page.includes(call), call);
  assert.ok(!/prio\(t\.priority\)/.test(page), 'every chip knows its ticket');
});

test('an existing board: who set each priority is read back from the history once', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'alv-prio-')), 'board.db');
  let store = await openStore(file);
  const a = store.createTicket({ title: 'Set by an agent', assignee: 'user', priority: 'P0' }, { actor: 'kaa' });
  const b = store.createTicket({ title: 'Then by you', assignee: 'user', priority: 'P2' }, { actor: 'kaa' });
  store.updateTicket(b.key, { priority: 'P1' }, { actor: 'user' });
  store.db.exec('ALTER TABLE tickets DROP COLUMN priority_by');
  store.close();
  store = await openStore(file);
  assert.deepEqual([store.getTicket(a.key).priority_by, store.getTicket(a.key).priority_proposed], ['kaa', true]);
  assert.deepEqual([store.getTicket(b.key).priority_by, store.getTicket(b.key).priority_proposed], ['user', false]);
  store.close();
});
