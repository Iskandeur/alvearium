// 0.9.12: typing a ticket key always finds that ticket, even closed, even when many other tickets
// mention similar keys, and even when the page is opened under a sub-path without its trailing slash.
// Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const T0 = Date.UTC(2026, 9, 1);
const keys = (rows) => (rows || []).map((t) => t.key);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

/** A closed ticket, then 40 tickets closed after it whose text mentions keys that start like its own. */
async function crowded() {
  let t = T0;
  const store = await openStore(':memory:', { now: () => (t += 1000), jobActors: [] });
  const target = store.createTicket({ title: 'Send the return card', labels: ['carte-retour'], assignee: 'helper' }, { actor: 'user' });
  store.updateTicket(target.key, { status: 'done' });
  for (let i = 0; i < 40; i++) {
    const n = store.createTicket({ title: `Follow-up ${i}`, body: `Same as ALV-${10 + i} in the alvearium board.` }, { actor: 'user' });
    store.updateTicket(n.key, { status: 'done' });
  }
  return { store, target };
}

test('search: the exact key of a closed ticket finds it in Done, even when 40 newer closed tickets mention similar keys', async () => {
  const { store, target } = await crowded();
  assert.equal(target.key, 'ALV-1');
  for (const q of [target.key, target.key.toLowerCase(), ` ${target.key} `, 'SB-1', '1']) {
    const done = keys(store.ticketBoard({ q }).columns.done);
    assert.equal(done[0], target.key, `"${q}": the ticket heads Done (${done.slice(0, 3).join(', ')})`);
  }
  assert.equal(keys(store.listTickets({ q: target.key }).tickets)[0], target.key, 'and heads the list');
});

test('search: a key matches the tickets that mention that exact key, not every key that starts the same', async () => {
  let t = T0;
  const store = await openStore(':memory:', { now: () => (t += 1000), jobActors: [] });
  const a = store.createTicket({ title: 'First' }, { actor: 'user' });
  const cites = store.createTicket({ title: 'Mentions it', body: `Blocked until ${a.key} lands.` }, { actor: 'user' });
  const other = store.createTicket({ title: 'Mentions another', body: `See ${a.key}0 and the alvearium notes.` }, { actor: 'user' });
  const found = keys(store.listTickets({ q: a.key }).tickets);
  assert.equal(found[0], a.key, 'the ticket itself first');
  assert.ok(found.includes(cites.key), 'a ticket that cites the key');
  assert.ok(!found.includes(other.key), 'not a ticket that cites ALV-10');
  assert.deepEqual(keys(store.listTickets({ q: 'Mentions' }).tickets).sort(), [cites.key, other.key].sort(), 'a word search is unchanged');
});

test('page: a key typed in the search opens the Done drawer when the ticket is closed', () => {
  const from = page.indexOf('/** 0.9.12: the ticket a search names by its key');
  const to = page.indexOf('function renderBoard(');
  assert.ok(from > 0 && to > from, 'helper found');
  const searchedKey = new Function(`${page.slice(from, to)}\nreturn searchedKey;`)();
  assert.equal(searchedKey('ALV-12', [{ key: 'ALV-3' }, { key: 'ALV-12' }]), 'ALV-12');
  assert.equal(searchedKey(' alv-12 ', [{ key: 'ALV-12' }]), 'ALV-12', 'any case');
  assert.equal(searchedKey('SB-12', [{ key: 'ALV-12' }]), 'ALV-12', 'another prefix');
  assert.equal(searchedKey('12', [{ key: 'ALV-12' }]), 'ALV-12', 'the bare number');
  assert.equal(searchedKey('ALV-12', [{ key: 'ALV-120' }]), null);
  assert.equal(searchedKey('return card', [{ key: 'ALV-12' }]), null, 'a word is not a key');
  assert.equal(searchedKey('', []), null);
  assert.match(page, /if \(searchedKey\(state\.q, b\.columns\?\.done\)\) \$\('doneBox'\)\.open = true;/);
});

test('page: opened under a sub-path without its trailing slash, it adds the slash so api/ stays under that path', () => {
  const from = page.indexOf('// 0.9.12: the page is the directory');
  assert.ok(from > 0, 'fix found');
  const line = page.slice(from, page.indexOf('\n', page.indexOf('\n', from) + 1));
  const run = (pathname) => {
    const calls = [];
    const location = { pathname, search: '?q=ALV-1', hash: '#x' };
    const history = { replaceState: (s, t, url) => calls.push(url) };
    new Function('location', 'history', line)(location, history);
    return calls;
  };
  assert.deepEqual(run('/alvearium'), ['/alvearium/?q=ALV-1#x']);
  assert.deepEqual(run('/alvearium/'), []);
  assert.deepEqual(run('/'), []);
  assert.ok(page.indexOf('// 0.9.12: the page is the directory') < page.indexOf("fetch('api/"), 'before any request');
  assert.ok(!/fetch\('\/api\//.test(page), 'no absolute api path');
});

test('server: GET /api/tickets/board?q=<key> returns the closed ticket at the head of Done', async () => {
  const { store, target } = await crowded();
  const token = 'k'.repeat(32);
  const server = createServer(createApp({ token, store, page: '<html></html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tickets/board?q=${target.key}`, { headers: { authorization: `Bearer ${token}` } });
    const b = await res.json();
    assert.equal(b.columns.done[0].key, target.key);
    assert.equal(b.columns.done[0].status, 'done');
  } finally {
    server.closeAllConnections?.();
    server.close();
    store.close();
  }
});
