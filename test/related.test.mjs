// 0.9.13: the "Related" section of a ticket's detail: sub-tickets, blockers, blocked tickets and the
// tickets of the same front, computed by the server (bounded) and rendered by the page. Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const T0 = Date.UTC(2026, 9, 1);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

async function board() {
  let t = T0;
  const store = await openStore(':memory:', { now: () => (t += 1000), jobActors: [] });
  const mk = (o) => store.createTicket({ title: 'A made-up ticket', ...o }, { actor: 'user' });
  return { store, mk };
}

test('related: sub-tickets, blockers, blocked and same-front tickets, each once, closed ones included', async () => {
  const { store, mk } = await board();
  const front = mk({ title: 'Checkout front', labels: ['front', 'front-id:checkout'] });
  const child = mk({ title: 'Child step', parent: front.key });
  const doneChild = mk({ title: 'Closed child', parent: front.key });
  store.updateTicket(doneChild.key, { status: 'done' });
  const blocker = mk({ title: 'Blocker' });
  const blocked = mk({ title: 'Waits on the front' });
  store.updateTicket(front.key, { blocked_by: [blocker.key] });
  store.updateTicket(blocked.key, { blocked_by: [front.key] });
  const sameId = mk({ title: 'Same front id', labels: ['front-id:checkout'] });
  const card = mk({ title: 'A card pointing at it', labels: ['card-of:checkout'] });
  const closedCard = mk({ title: 'An old card', labels: ['card-of:checkout'] });
  store.updateTicket(closedCard.key, { status: 'done' });
  const alsoChild = mk({ title: 'Child and same front', parent: front.key, labels: ['front-id:checkout'] });
  mk({ title: 'Another front', labels: ['front-id:billing', 'card-of:billing'] });
  mk({ title: 'Unrelated' });

  const rel = store.getTicket(front.key).related;
  const by = (r) => rel.filter((x) => x.rel === r).map((x) => x.key);
  assert.deepEqual(by('child'), [child.key, alsoChild.key, doneChild.key], 'open sub-tickets first');
  assert.deepEqual(by('blocked_by'), [blocker.key]);
  assert.deepEqual(by('blocks'), [blocked.key]);
  assert.deepEqual(new Set(by('front')), new Set([sameId.key, card.key, closedCard.key]));
  assert.equal(by('front').at(-1), closedCard.key, 'closed last');
  assert.equal(new Set(rel.map((x) => x.key)).size, rel.length, 'each ticket once');
  assert.ok(!rel.some((x) => x.key === front.key), 'never itself');
  assert.deepEqual(Object.keys(rel[0]).sort(), ['key', 'rel', 'status', 'title']);

  // From the other side: a sub-ticket's related has no front (it carries no front id) and no parent entry.
  assert.deepEqual(store.getTicket(blocker.key).related.map((x) => [x.rel, x.key]), [['blocks', front.key]]);
  assert.deepEqual(store.getTicket(mk({ title: 'Alone' }).key).related, [], 'empty when nothing relates');
});

test('related: bounded to 50 entries', async () => {
  const { store, mk } = await board();
  const front = mk({ title: 'Big front', labels: ['front', 'front-id:big'] });
  for (let i = 0; i < 70; i++) mk({ title: `Card ${i}`, labels: ['card-of:big'] });
  assert.equal(store.getTicket(front.key).related.length, 50);
});

test('server: GET /api/tickets/<key> carries related', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Parent' });
  const c = mk({ title: 'Child', parent: p.key });
  const token = 'r'.repeat(32);
  const server = createServer(createApp({ token, store, page: '<html></html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const t = await (await fetch(`http://127.0.0.1:${server.address().port}/api/tickets/${p.key}`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(t.related, [{ key: c.key, title: 'Child', status: 'todo', rel: 'child' }]);
  } finally {
    server.closeAllConnections?.();
    server.close();
    store.close();
  }
});

test('page: the Related section, open at 5 entries or fewer, collapsed above, hidden when empty, closed ones greyed, each clickable', () => {
  const from = page.indexOf('// ---- related (0.9.13)');
  const to = page.indexOf('// ---- end of related');
  assert.ok(from > 0 && to > from, 'helper found');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fr = { Related: 'Liées', 'Same front': 'Même front', 'Sub-ticket': 'Sous-ticket', 'Blocked by': 'Bloqué par', Blocks: 'Bloque' };
  const make = (tr) => new Function('esc', 'ttl', 'tr', `${page.slice(from, to)}\nreturn relatedSection;`)(esc, esc, tr);
  const en = make((s) => s);
  const item = (n, status = 'todo', rel = 'front') => ({ key: `ALV-${n}`, title: `T<${n}>`, status, rel });
  assert.equal(en([]), '');
  assert.equal(en(undefined), '');
  const few = en([item(1, 'todo', 'child'), item(2, 'done', 'blocked_by'), item(3)]);
  assert.match(few, /^<details class="related" open><summary class="sect"[^>]*>Related · 3<\/summary>/);
  assert.match(few, /<div class="dep relRow" data-open="ALV-1" tabindex="0">.*Sub-ticket/);
  assert.match(few, /<div class="dep relRow closed" data-open="ALV-2"/, 'closed: greyed');
  assert.ok(few.includes('T&lt;3&gt;'), 'titles escaped');
  const many = en([1, 2, 3, 4, 5, 6].map((n) => item(n)));
  assert.match(many, /^<details class="related"><summary/, 'collapsed above 5');
  assert.match(en([1, 2, 3, 4, 5].map((n) => item(n))), /^<details class="related" open>/);
  const french = make((s) => fr[s] ?? s)([item(1)]);
  assert.match(french, /Liées · 1/);
  assert.match(french, /Même front/);
  assert.match(page, /\$\{relatedSection\(t\.related\)\}\n\s*<div class="sect">\$\{tr\('History'\)\}<\/div>/, 'rendered above the history');
  for (const [k, v] of Object.entries({ Related: 'Liées', 'Sub-ticket': 'Sous-ticket', 'Same front': 'Même front' })) assert.ok(page.includes(`'${k}': '${v}'`), k);
});
