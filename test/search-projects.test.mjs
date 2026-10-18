// 0.6.1: a search still finds the projects. They stay out of the task columns, so the board shows the
// ones that match in a group above the lanes. Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../lib/store.mjs';

const H = 3600000;
const T0 = Date.UTC(2026, 9, 1);
const keys = (rows) => (rows || []).map((t) => t.key);
const openColumns = (b) => [...keys(b.columns.waiting), ...keys(b.columns.inProgress), ...keys(b.columns.todo)];

async function board() {
  let t = T0;
  const store = await openStore(':memory:', { now: () => (t += 1000), jobActors: [] });
  const mk = (o, actor = 'user') => store.createTicket({ title: 'A made-up ticket', ...o }, { actor });
  return { store, mk };
}

test('search: a project is found by its key and by a word of its title, a closed one is not listed', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Reels pipeline', labels: ['front'] });
  const closed = mk({ title: 'Reels archive', labels: ['front'] });
  mk({ title: 'A plain task about reels' });
  store.updateTicket(closed.key, { status: 'done' });
  const byKey = store.ticketBoard({ q: p.key });
  assert.deepEqual(keys(byKey.projects), [p.key], 'the exact key finds the project');
  assert.ok(!openColumns(byKey).includes(p.key), 'it is still out of the columns');
  assert.deepEqual(keys(store.ticketBoard({ q: p.key.toLowerCase() }).projects), [p.key], 'any case');
  assert.deepEqual(keys(store.ticketBoard({ q: 'Reels' }).projects), [p.key], 'by a word of the title');
  assert.ok(!keys(store.ticketBoard({ q: closed.key }).projects).includes(closed.key), 'a closed project is not listed as a project');
  assert.ok(keys(store.ticketBoard({ q: closed.key }).columns.done).includes(closed.key), 'it shows in Done');
  assert.deepEqual(keys(store.ticketBoard({ q: 'nothing like it' }).projects), []);
  assert.deepEqual(keys(store.ticketBoard({}).projects), [p.key], 'without a search, the projects are unchanged');
});

test('search: an exact key finds a ticket closed long ago (archived), a word does not', async () => {
  let t = T0;
  const store = await openStore(':memory:', { now: () => t, jobActors: [] });
  const old = store.createTicket({ title: 'Ancient front', labels: ['front'] }, { actor: 'user' });
  store.updateTicket(old.key, { status: 'done' });
  t += 90 * 24 * H;
  assert.deepEqual(keys(store.listTickets({ q: 'Ancient' }).tickets), [], 'archived: hidden from a word search');
  assert.deepEqual(keys(store.listTickets({ q: old.key }).tickets), [old.key], 'but the key opens it');
});

test('page: the search shows the projects above the lanes, and only while searching', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  for (const s of ['id="searchProjects"', 'renderSearchProjects(b, now);']) assert.ok(page.includes(s), s);
  const a = page.indexOf('function renderSearchProjects(');
  const b = page.indexOf('function renderBoard(');
  assert.ok(a > 0 && b > a);
  const nodes = { searchProjects: { hidden: true, html: '' } };
  const make = new Function('state', '$', 'setHtml', 'pjOrder', 'pjCard', `${page.slice(a, b)}\nreturn renderSearchProjects;`);
  const run = (q, projects) => {
    const render = make({ q }, (id) => nodes[id], (n, h) => { n.html = h; }, (l) => l || [], (p) => `<card ${p.key}>`);
    render({ projects }, 0);
    return nodes.searchProjects;
  };
  const shown = run('ALV-1', [{ key: 'ALV-1' }, { key: 'ALV-2' }]);
  assert.equal(shown.hidden, false);
  assert.ok(shown.html.includes('<card ALV-1><card ALV-2>') && shown.html.includes('Projects · 2'));
  assert.equal(run('', [{ key: 'ALV-1' }]).hidden, true, 'no search: nothing changes');
  assert.equal(run('zzz', []).hidden, true);
});
