// 0.10.0: the search bar's query language (lib/query.mjs): the pure parser, then the same queries run
// against a store. Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { closest, compileQuery, fold, parseQuery, readDate } from '../lib/query.mjs';
import { parseFilters } from '../lib/core.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const T0 = Date.UTC(2026, 9, 1);
const DAY = 24 * 60 * 60 * 1000;
const keys = (r) => (r.tickets || []).map((t) => t.key).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
const codes = (q) => parseQuery(q).errors.map((e) => e.code);

// ---- parser ----------------------------------------------------------------------------------------

test('query: plain words stay plain (the old search runs on them, unchanged)', () => {
  for (const q of ['login bug', 'ALV-12', '12', 'café crème', '10:30 meeting', 'https://example.com/x', 'C++']) {
    const p = parseQuery(q);
    assert.equal(p.plain, true, q);
    assert.equal(p.node, null, q);
    assert.deepEqual(p.errors, [], q);
  }
});

test('query: a field, a minus, a phrase, OR, parentheses are a query', () => {
  for (const q of ['status:todo', '-label:noise', '"exact phrase"', 'a OR b', '(a b)', '#vigie', 'NOT x']) assert.equal(parseQuery(q).plain, false, q);
});

test('query: fields and their values, with aliases, case and accents folded', () => {
  const p = parseQuery('Statut:TODO p:p1 Priorité:2 assignee:me #Vigie type:bug');
  assert.deepEqual(p.errors, []);
  const f = p.node.items;
  assert.deepEqual(f.map((x) => x.field), ['status', 'priority', 'priority', 'assignee', 'label', 'type']);
  assert.deepEqual(f[0].values[0].list, ['todo']);
  assert.deepEqual(f[1].values[0].list, ['P1']);
  assert.deepEqual(f[2].values[0].list, ['P2']);
  assert.equal(f[3].values[0].op, 'me');
  assert.equal(f[4].values[0].value, 'vigie');
  assert.equal(fold('Priorité'), 'priorite');
  assert.equal(fold('in-progress'), 'in_progress');
});

test('query: free words beside filters keep the old search; the rest becomes the tree', () => {
  const p = parseQuery('login status:todo crash');
  assert.equal(p.text, 'login crash');
  assert.equal(p.node.type, 'field');
});

test('query: comma = any of, open/closed expand, OR binds tighter than the spaces', () => {
  assert.deepEqual(parseQuery('status:todo,in-progress').node.values.flatMap((v) => v.list), ['todo', 'in_progress']);
  assert.ok(parseQuery('is:open').node.values[0].value === 'open');
  const p = parseQuery('status:todo label:a OR label:b');
  assert.equal(p.node.type, 'and');
  assert.equal(p.node.items[1].type, 'or');
  const g = parseQuery('(p:P0 OR label:urgent) -is:blocked');
  assert.equal(g.node.items[0].type, 'or');
  assert.equal(g.node.items[1].type, 'not');
  assert.equal(parseQuery('a | b').node.type, 'or');
});

test('query: priority comparisons follow the board (P0 first): p:<=P1 is P0 and P1', () => {
  const list = (q) => parseQuery(q).node.values[0].list;
  assert.deepEqual(list('p:<=P1'), ['P0', 'P1']);
  assert.deepEqual(list('p:<P2'), ['P0', 'P1']);
  assert.deepEqual(list('p:>P1'), ['P2', 'P3']);
  assert.deepEqual(list('p:>=p2'), ['P2', 'P3']);
  assert.deepEqual(list('p:P1..P2'), ['P1', 'P2']);
  assert.deepEqual(list('p:urgent'), ['P0']);
  assert.deepEqual(list('p:none'), ['none']);
});

test('query: dates (a day, today, an age, a range)', () => {
  assert.deepEqual(readDate('2026-10-01'), { day: T0 });
  assert.deepEqual(readDate('7d'), { rel: 7 * DAY });
  assert.deepEqual(readDate('2w'), { rel: 14 * DAY });
  assert.deepEqual(readDate('3j'), { rel: 3 * DAY });
  assert.deepEqual(readDate('today'), { today: 0 });
  assert.equal(readDate('soon'), null);
  const r = parseQuery('created:2026-10-01..2026-10-15').node.values[0];
  assert.equal(r.op, 'between');
});

test('query: quotes make a phrase, also as a value', () => {
  const p = parseQuery('"two words" label:"needs review"');
  assert.deepEqual(p.node.items[0], { type: 'text', value: 'two words', phrase: true });
  assert.equal(p.node.items[1].values[0].value, 'needs review');
});

test('query: an unknown field is searched as text and named, with the closest field', () => {
  const p = parseQuery('stauts:todo');
  assert.equal(p.errors[0].code, 'unknown_field');
  assert.equal(p.errors[0].field, 'stauts');
  assert.equal(p.errors[0].suggestion, 'status');
  assert.equal(p.text, 'stauts:todo');
  assert.equal(p.fix, 'status:todo');
  assert.equal(parseQuery('asignee:me').fix, 'assignee:me');
  assert.equal(parseQuery('zzzzzz:1').errors[0].suggestion, null);
  assert.equal(parseQuery('zzzzzz:1').fix, null);
});

test('query: a value that cannot be read leaves the filter out, says why and suggests', () => {
  const p = parseQuery('status:tdo bug');
  assert.deepEqual(codes('status:tdo bug'), ['bad_value']);
  assert.equal(p.errors[0].suggestion, 'todo');
  assert.equal(p.fix, 'status:todo bug');
  assert.equal(p.node, null, 'the bad filter is left out');
  assert.equal(p.text, 'bug', 'the rest still searches');
  assert.equal(parseQuery('p:P7').errors[0].code, 'bad_value');
  assert.equal(parseQuery('is:blokced').fix, 'is:blocked');
  assert.equal(parseQuery('no:prio').errors.length, 0);
});

test('query: other errors are named (empty value, operator, date, quote, parenthesis, OR)', () => {
  assert.deepEqual(codes('label:'), ['empty_value']);
  assert.deepEqual(codes('label:>a'), ['bad_operator']);
  assert.deepEqual(codes('updated:soon'), ['bad_date']);
  assert.deepEqual(codes('"open phrase'), ['unclosed_quote']);
  assert.deepEqual(codes('(a b'), ['unmatched_paren']);
  assert.deepEqual(codes('a b)'), ['unmatched_paren']);
  assert.deepEqual(codes('OR a'), ['dangling_or']);
  assert.deepEqual(codes('a OR'), ['dangling_or']);
  assert.deepEqual(codes('type:bgu'), ['unknown_kind']);
  assert.equal(parseQuery('type:bgu').node.values[0].value, 'bgu', 'a kind of their own still filters');
  assert.equal(parseQuery('type:custom-kind').errors.length, 0);
});

test('query: Kaa review of #83: a negated type keeps the cuts, -5 and "!!" stay plain, is: takes the status aliases', () => {
  assert.equal(parseQuery('type:feedback').kinds, true);
  assert.equal(parseQuery('-type:session').kinds, false, 'leaving a type out does not bring feedback in');
  assert.equal(parseQuery('NOT is:archived').archived, false);
  assert.equal(parseQuery('is:archived OR p:P0').archived, true);
  for (const q of ['-5', '!!', '--', '?', 'temp -1.5']) assert.equal(parseQuery(q).plain, true, q);
  for (const [q, v] of [['is:doing', 'in_progress'], ['is:wip', 'in_progress'], ['is:canceled', 'cancelled'], ['is:waiting', 'waiting_on_user']]) {
    assert.deepEqual(parseQuery(q).errors, [], q);
    assert.equal(parseQuery(q).node.values[0].value, v, q);
  }
});

test('query: closest() finds typos and prefixes, not unrelated words', () => {
  assert.equal(closest('stat', ['status', 'label']), 'status');
  assert.equal(closest('lable', ['status', 'label']), 'label');
  assert.equal(closest('xyz', ['status', 'label']), null);
});

test('query: compileQuery binds every value as a parameter', () => {
  const p = parseQuery("label:\"a'b\" title:x%");
  const c = compileQuery(p.node, { now: T0, fts: false, ftsQuery: () => '', blockedSql: '0', archivedSql: '0' });
  assert.ok(!c.sql.includes("a'b"));
  assert.deepEqual(c.params, ["a'b", '%x\\%%']);
});

// ---- against a store ---------------------------------------------------------------------------------

async function board() {
  let t = T0;
  const store = await openStore(':memory:', { now: () => t, jobActors: [] });
  const make = (body, at, status) => {
    t = at;
    const x = store.createTicket(body, { actor: body.by || 'user' });
    if (status) store.updateTicket(x.key, { status });
    return x.key;
  };
  make({ title: 'Login page crashes', priority: 'P0', labels: ['vigie', 'web'], assignee: 'user' }, T0);
  make({ title: 'Write the release notes', priority: 'P2', labels: ['docs'], assignee: 'claude' }, T0 + DAY, 'in_progress');
  make({ title: 'Login button colour', priority: 'P3', labels: ['web'], assignee: 'lupi/job-4', body: 'The login colour is off' }, T0 + 2 * DAY, 'done');
  make({ title: 'Decide the hosting', kind: 'decision', assignee: 'user', body: 'Two options to compare' }, T0 + 10 * DAY);
  make({ title: 'Noise ticket', priority: 'P1', labels: ['noise'], assignee: 'helper', by: 'helper' }, T0 + 11 * DAY);
  t = T0 + 12 * DAY;
  return store;
}

const run = (store, q, extra = {}) => keys(store.listTickets({ q, limit: 100, ...extra }));

test('query on a store: plain words find what they found before', async () => {
  const store = await board();
  assert.deepEqual(run(store, 'login'), ['ALV-1', 'ALV-3']);
  assert.deepEqual(run(store, 'ALV-4'), ['ALV-4']);
});

test('query on a store: filters, exclusion, any-of, OR, groups', async () => {
  const store = await board();
  assert.deepEqual(run(store, 'status:todo'), ['ALV-1', 'ALV-4', 'ALV-5']);
  assert.deepEqual(run(store, 'is:open -label:noise'), ['ALV-1', 'ALV-2', 'ALV-4']);
  assert.deepEqual(run(store, 'status:done,in_progress'), ['ALV-2', 'ALV-3']);
  assert.deepEqual(run(store, 'label:docs OR p:P0'), ['ALV-1', 'ALV-2']);
  assert.deepEqual(run(store, 'login (p:P0 OR is:closed)'), ['ALV-1', 'ALV-3']);
  assert.deepEqual(run(store, '#web -is:closed'), ['ALV-1']);
  assert.deepEqual(run(store, 'login -crashes'), ['ALV-3']);
  assert.deepEqual(run(store, '"login colour"'), ['ALV-3']);
});

test('query on a store: priority, people, type, has/no, keys', async () => {
  const store = await board();
  assert.deepEqual(run(store, 'p:<=P1'), ['ALV-1', 'ALV-5']);
  assert.deepEqual(run(store, 'no:priority'), ['ALV-4']);
  assert.deepEqual(run(store, 'assignee:me'), ['ALV-1', 'ALV-4']);
  assert.deepEqual(run(store, 'assignee:me', { me: 'claude' }), ['ALV-2']);
  assert.deepEqual(run(store, 'assignee:lupi/*'), ['ALV-3']);
  assert.deepEqual(run(store, 'author:helper'), ['ALV-5']);
  assert.deepEqual(run(store, 'type:decision'), ['ALV-4']);
  assert.deepEqual(run(store, 'key:ALV-2..ALV-3'), ['ALV-2', 'ALV-3']);
  assert.deepEqual(run(store, 'key:>4'), ['ALV-5']);
  assert.deepEqual(run(store, 'title:hosting'), ['ALV-4']);
});

test('query on a store: dates (age, day, comparison)', async () => {
  const store = await board();
  // now = T0 + 12 days
  assert.deepEqual(run(store, 'created:<7d'), ['ALV-4', 'ALV-5']);
  assert.deepEqual(run(store, 'created:7d'), ['ALV-4', 'ALV-5']);
  assert.deepEqual(run(store, 'created:>7d'), ['ALV-1', 'ALV-2', 'ALV-3']);
  assert.deepEqual(run(store, 'created:2026-10-02'), ['ALV-2']);
  assert.deepEqual(run(store, 'created:>2026-10-02'), ['ALV-3', 'ALV-4', 'ALV-5']);
  assert.deepEqual(run(store, 'created:2026-10-01..2026-10-02'), ['ALV-1', 'ALV-2']);
});

test('query on a store: the problems come back with the results, never an empty board in silence', async () => {
  const store = await board();
  const r = store.listTickets({ q: 'stauts:todo login', limit: 100 });
  assert.equal(r.query.errors[0].code, 'unknown_field');
  assert.equal(r.query.fix, 'status:todo login');
  const b = store.ticketBoard({ q: 'status:tdo login' });
  assert.equal(b.query.errors[0].suggestion, 'todo');
  const all = Object.values(b.columns).flat().map((t) => t.key).sort();
  assert.deepEqual(all, ['ALV-1', 'ALV-3'], 'the bad filter is left out, the words still search');
  assert.equal(store.listTickets({ q: 'login' }).query, undefined, 'nothing to say on a plain search');
  assert.equal(store.listTickets({ q: 'status:todo' }).query, undefined, 'nor on a good query');
});

test('query over HTTP: the commas of q reach the parser, the problems come back in the board', async () => {
  assert.equal(parseFilters(new URLSearchParams('q=status:todo,review -label:x')).q, 'status:todo,review -label:x');
  assert.equal(parseFilters({ q: 'a,b' }).q, 'a,b');
  const store = await board();
  const TOKEN = 'x'.repeat(32);
  const server = createServer(createApp({ token: TOKEN, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/tickets`;
  const get = async (path) => (await fetch(base + path, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  try {
    const b = await get('/board?q=' + encodeURIComponent('status:todo,in_progress -label:noise'));
    assert.deepEqual(Object.values(b.columns).flat().map((t) => t.key).sort(), ['ALV-1', 'ALV-2', 'ALV-4']);
    const l = await get('?q=' + encodeURIComponent('stauts:todo'));
    assert.equal(l.query.fix, 'status:todo');
    const n = await get('/next?q=' + encodeURIComponent('assignee:me p:<=P1'));
    assert.deepEqual(n.tickets.map((t) => t.key), ['ALV-1']);
  } finally {
    server.close();
  }
});

test('query on a store: without the full-text index, words and phrases still search (LIKE)', async () => {
  const store = await board();
  store.fts = false;
  assert.deepEqual(run(store, '"login colour"'), ['ALV-3']);
  assert.deepEqual(run(store, 'login -crashes'), ['ALV-3']);
  assert.deepEqual(run(store, 'hosting OR release'), ['ALV-2', 'ALV-4']);
});

test('query on a store: type:feedback reaches what the default views leave out, and next takes the type asked', async () => {
  const store = await board();
  const fb = store.createTicket({ title: 'Board feedback', kind: 'feedback' }, { actor: 'claude' });
  assert.ok(!run(store, 'board').includes(fb.key));
  assert.deepEqual(run(store, 'type:feedback'), [fb.key]);
  assert.ok(!run(store, '-type:session').includes(fb.key), 'excluding a type keeps feedback out');
  const next = store.nextTickets({ q: 'type:decision', limit: 50 });
  assert.deepEqual(next.tickets.map((t) => t.key), ['ALV-4']);
});
