// A session title stored before 0.9.6 with a harness's header line is not shown: the board falls back to the session id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.mjs';

test('store: a ticket of a session titled by a header line carries no session title', async () => {
  const store = await openStore(':memory:');
  const now = Date.now();
  const ins = store.db.prepare('INSERT INTO sessions (id, title, name, repo, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('old', '[Usage limits] 5 h: 25 % (reset 03:50) · week: 31 % [Policy: spend] [Background job] Fix the…', null, 'acme/app', now, now);
  ins.run('new', 'Fix the login page', null, 'acme/app', now, now);
  const a = store.createTicket({ title: 'one' });
  const b = store.createTicket({ title: 'two' });
  store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('old', a.id);
  store.db.prepare('UPDATE tickets SET session_id = ? WHERE id = ?').run('new', b.id);
  assert.equal(store.getTicket(a.key).session.title, null);
  assert.equal(store.getTicket(b.key).session.title, 'Fix the login page');
  store.close();
});
