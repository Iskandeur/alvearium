// 0.9.18: "important for you", an assistant's reading of the owner's queue, apart from priority. It rides the
// same who-set-it axis as priority (0.9.5), but the owner wins outright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.mjs';
import { renderTicketsText } from '../lib/core.mjs';
import { compareWaiting, isImportant } from '../lib/triage.mjs';

const mk = (store, title, extra = {}, actor = 'kaa') => store.createTicket({ title, assignee: 'user', status: 'waiting_on_user', kind: 'decision', ...extra }, { actor });

test('an agent sets importance with a reason and a rank; serialised with who set it', async () => {
  const store = await openStore(':memory:');
  const t = mk(store, 'Sign the lease');
  store.updateTicket(t.key, { importance: 'high', importance_reason: '  The landlord needs it by Friday  ', importance_rank: 2 }, { actor: 'kaa' });
  const got = store.getTicket(t.key);
  assert.deepEqual(
    [got.importance, got.importance_reason, got.importance_rank, got.importance_by, got.importance_yours],
    ['high', 'The landlord needs it by Friday', 2, 'kaa', false],
  );
  assert.ok('importance_by_name' in got);
  assert.ok(got.events.some((e) => e.type === 'edit' && /importance none → high/.test(e.text)));
  assert.equal(store.getTicket(mk(store, 'Plain').key).importance, null);
});

test('validation: a bad level, a long reason and a bad rank', async () => {
  const store = await openStore(':memory:');
  const t = mk(store, 'x');
  assert.throws(() => store.updateTicket(t.key, { importance: 'huge' }, { actor: 'kaa' }), /importance must be one of/);
  assert.throws(() => store.updateTicket(t.key, { importance_rank: 0 }, { actor: 'kaa' }), /importance_rank/);
  store.updateTicket(t.key, { importance: 'low', importance_reason: 'x'.repeat(400) }, { actor: 'kaa' });
  assert.equal(store.getTicket(t.key).importance_reason.length, 160);
});

test('the owner wins: an agent write is ignored once a human set it; the rank still moves', async () => {
  const store = await openStore(':memory:');
  const t = mk(store, 'Pay the invoice');
  store.updateTicket(t.key, { importance: 'high', importance_reason: 'late fee' }, { actor: 'kaa' });
  store.updateTicket(t.key, { importance: 'low', importance_reason: 'not that important' }, { actor: 'user' });
  let got = store.getTicket(t.key);
  assert.deepEqual([got.importance, got.importance_reason, got.importance_by, got.importance_yours], ['low', 'not that important', 'user', true]);
  const back = store.updateTicket(t.key, { importance: 'high', importance_reason: 'agent again', importance_rank: 3 }, { actor: 'kaa' });
  assert.deepEqual([back.importance, back.importance_reason, back.importance_rank, back.importance_yours], ['low', 'not that important', 3, true]);
  got = store.getTicket(t.key);
  assert.ok(got.events.some((e) => e.actor === 'user' && /importance high → low/.test(e.text)), 'the correction is in the history');
  store.updateTicket(t.key, { importance: null }, { actor: 'user' });
  got = store.getTicket(t.key);
  assert.deepEqual([got.importance, got.importance_reason, got.importance_by, got.importance_yours], [null, null, null, false]);
  store.updateTicket(t.key, { importance: 'medium' }, { actor: 'kaa' });
  assert.equal(store.getTicket(t.key).importance, 'medium', 'once cleared, an agent may set it again');
});

test('the owner confirms an assistant level by setting the same value', async () => {
  const store = await openStore(':memory:');
  const t = mk(store, 'Confirm me');
  store.updateTicket(t.key, { importance: 'high' }, { actor: 'kaa' });
  store.updateTicket(t.key, { importance: 'high' }, { actor: 'user' });
  assert.equal(store.getTicket(t.key).importance_yours, true);
});

test('waiting on you: own P0/P1, then importance_rank, then level, then as before', async () => {
  const store = await openStore(':memory:');
  const plain = mk(store, 'plain');
  const med = mk(store, 'med');
  const high = mk(store, 'high');
  const r2 = mk(store, 'rank2');
  const r1 = mk(store, 'rank1');
  const own = mk(store, 'own P1', { priority: 'P1' }, 'user');
  store.updateTicket(med.key, { importance: 'medium' }, { actor: 'kaa' });
  store.updateTicket(high.key, { importance: 'high' }, { actor: 'kaa' });
  store.updateTicket(r2.key, { importance_rank: 2, importance: 'low' }, { actor: 'kaa' });
  store.updateTicket(r1.key, { importance_rank: 1 }, { actor: 'kaa' });
  const order = store.ticketBoard({}).columns.waiting.map((t) => t.title);
  assert.deepEqual(order, ['own P1', 'rank1', 'rank2', 'high', 'med', 'plain']);
  assert.ok(plain.key);
});

test('matrix rule: high counts as important; a low you set removes it unless your P0/P1', () => {
  const base = { priority: 'P1', priority_proposed: false };
  assert.equal(isImportant({ priority: 'P3' }), false);
  assert.equal(isImportant({ priority: 'P3', importance: 'high' }), true);
  assert.equal(isImportant({ ...base, priority: 'P2' }), false);
  assert.equal(isImportant({ priority: 'P0', priority_proposed: true, importance: 'low', importance_yours: true }), false, 'a proposal is not yours');
  assert.equal(isImportant({ priority: 'P0', priority_proposed: true, importance: 'low', importance_yours: false }, { deadline: true }), true, "an assistant's low does not remove");
  assert.equal(isImportant({ ...base, importance: 'low', importance_yours: true }), true, 'your own P1 stays');
  assert.equal(isImportant({ priority: 'P2', importance: 'low', importance_yours: true }), false);
  assert.ok(compareWaiting({ seq: 1, importance_rank: 1 }, { seq: 2 }) < 0);
});

test('text board marks high and low', async () => {
  const store = await openStore(':memory:');
  const a = mk(store, 'Up');
  const b = mk(store, 'Down');
  store.updateTicket(a.key, { importance: 'high' }, { actor: 'kaa' });
  store.updateTicket(b.key, { importance: 'low' }, { actor: 'kaa' });
  const text = renderTicketsText(store.ticketBoard({}));
  assert.match(text, new RegExp(`${a.key} ↑ Up`));
  assert.match(text, new RegExp(`${b.key} ↓ Down`));
});

test('an existing board gets the columns by migration', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'alv-imp-')), 'board.db');
  let store = await openStore(file);
  const t = mk(store, 'Old');
  for (const c of ['importance', 'importance_reason', 'importance_rank', 'importance_by']) store.db.exec(`ALTER TABLE tickets DROP COLUMN ${c}`);
  store.close();
  store = await openStore(file);
  store.updateTicket(t.key, { importance: 'high', importance_rank: 1 }, { actor: 'kaa' });
  assert.deepEqual([store.getTicket(t.key).importance, store.getTicket(t.key).importance_rank], ['high', 1]);
  store.close();
});

test('MCP ticket_update schema and the page carry the fields', () => {
  const mcp = readFileSync(join(import.meta.dirname, '..', 'mcp', 'server.mjs'), 'utf8');
  for (const f of ['importance:', 'importance_reason:', 'importance_rank:']) assert.ok(mcp.includes(f), f);
  assert.match(mcp, /separate from priority/);
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  assert.ok(page.includes('class="imp imp-${esc(t.importance)}"'));
  assert.ok(page.includes('data-imp-key'));
  assert.ok(page.includes("importance: b.dataset.imp === '' ? null : b.dataset.imp"));
  assert.ok(page.includes('${impChip(t)}'));
  assert.ok(page.includes('high for you'));
  assert.match(page, /"low for you" that you set removes it/);
});
