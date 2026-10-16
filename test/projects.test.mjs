// 0.5.17: projects. Tickets with the project label (`front` by default, BOARD_PROJECT_LABEL) leave the task
// columns, stay open, and are listed with their latest state, what hangs off them and what waits on the owner.
// Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProjectLabel, openStore } from '../lib/store.mjs';

const H = 3600000;
const T0 = Date.UTC(2026, 9, 1);

async function board(opts = {}) {
  let t = T0;
  const store = await openStore(':memory:', { now: () => (t += 1000), jobActors: ['crew'], ...opts });
  const mk = (o, actor = 'user') => store.createTicket({ title: 'A made-up ticket', ...o }, { actor });
  return { store, mk };
}
const keys = (rows) => (rows || []).map((t) => t.key);
const openColumns = (b) => [...keys(b.columns.waiting), ...keys(b.columns.inProgress), ...keys(b.columns.todo)];

test('a project leaves the task columns but stays open', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Rewrite the parser', labels: ['front'] });
  const busy = mk({ title: 'A project at work', labels: ['front'], status: 'in_progress' });
  const task = mk({ title: 'Fix the tokenizer' });
  const b = store.ticketBoard({});
  assert.ok(openColumns(b).includes(task.key));
  assert.ok(!openColumns(b).includes(p.key) && !openColumns(b).includes(busy.key), 'no project in To do or In progress');
  assert.equal(b.counts.todo + b.counts.waiting + b.counts.inProgress, 1, 'counts follow the columns');
  assert.equal(b.project_label, 'front');
  assert.deepEqual(keys(b.projects).sort(), [p.key, busy.key].sort());
  assert.equal(store.getTicket(p.key).status, 'todo', 'not closed');
  store.updateTicket(p.key, { status: 'done' });
  const after = store.ticketBoard({});
  assert.ok(keys(after.columns.done).includes(p.key), 'a closed project shows in Done like any ticket');
  assert.ok(!keys(after.projects).includes(p.key), 'and leaves the projects');
});

test('attached tickets: sub-tickets and the <label>-id:<name> label; jobs are made by a sub-actor of a job actor', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Ship the app', labels: ['front', 'front-id:app'] });
  const other = mk({ title: 'Another project', labels: ['front', 'front-id:other'] });
  mk({ title: 'Sub-ticket', parent: p.key });
  mk({ title: 'Job by label', labels: ['front-id:app'] }, 'crew/job-7');
  const doneJob = mk({ title: 'Finished job', labels: ['front-id:app'] }, 'crew/job-8');
  store.updateTicket(doneJob.key, { status: 'done' }, { actor: 'crew/job-8' });
  mk({ title: 'By the job actor itself, not a job', labels: ['front-id:app'] }, 'crew');
  mk({ title: 'Elsewhere', labels: ['front-id:other'] }, 'crew/job-9');
  mk({ title: 'Unrelated' });
  const list = store.ticketBoard({}).projects;
  const app = list.find((x) => x.key === p.key);
  assert.equal(app.slug, 'app');
  assert.deepEqual(app.tickets, { total: 4, open: 3 });
  assert.deepEqual(app.jobs, { total: 2, open: 1 });
  assert.deepEqual(list.find((x) => x.key === other.key).jobs, { total: 1, open: 1 });
});

test('a project without its own id label only gathers its sub-tickets', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Loose project', labels: ['front'] });
  mk({ title: 'Labelled for nobody', labels: ['front-id:'] });
  mk({ title: 'Child', parent: p.key });
  const app = store.projectList().find((x) => x.key === p.key);
  assert.equal(app.slug, null);
  assert.deepEqual(app.tickets, { total: 1, open: 1 });
});

test('latest state: the last dated state comment wins over a later chat, else the last comment', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Stateful', labels: ['front'] });
  store.comment(p.key, 'State as of 01/10: parser done, tests green.', { actor: 'crew' });
  store.comment(p.key, '**État au 14/10** : la v2 tourne.', { actor: 'crew' });
  store.comment(p.key, 'thanks!', { actor: 'user' });
  let s = store.projectList().find((x) => x.key === p.key).state;
  assert.match(s.text, /État au 14\/10/);
  assert.equal(s.dated, true);
  assert.equal(s.actor, 'crew');
  const q = mk({ title: 'Chatty', labels: ['front'] });
  store.comment(q.key, 'first word', { actor: 'user' });
  store.comment(q.key, 'last word', { actor: 'user' });
  s = store.projectList().find((x) => x.key === q.key).state;
  assert.deepEqual([s.text, s.dated], ['last word', false]);
  const silent = mk({ title: 'Silent', labels: ['front'] });
  assert.equal(store.projectList().find((x) => x.key === silent.key).state, null);
});

test('what waits on the owner: the project itself, or an attached ticket in their lane', async () => {
  const { store, mk } = await board();
  const p = mk({ title: 'Needs me', labels: ['front', 'front-id:x'], status: 'waiting_on_user', assignee: 'user' });
  const ask = mk({ title: 'Pick a host', labels: ['front-id:x'], kind: 'decision', assignee: 'user' }, 'crew/job-1');
  mk({ title: 'Agent work', labels: ['front-id:x'], assignee: 'crew' });
  const b = store.ticketBoard({});
  const x = b.projects.find((y) => y.key === p.key);
  assert.deepEqual(x.gestures.map((g) => g.key), [p.key, ask.key]);
  assert.ok(!keys(b.columns.waiting).includes(p.key), 'the project is out of the lane; its gesture shows in Projects');
  assert.ok(keys(b.columns.waiting).includes(ask.key), 'an attached task stays a task');
});

test('the label is configurable, and can be turned off', async () => {
  assert.equal(normalizeProjectLabel(undefined), 'front');
  assert.equal(normalizeProjectLabel(' project '), 'project');
  for (const off of ['', 'none', 'OFF', '-']) assert.equal(normalizeProjectLabel(off), '');
  const custom = await board({ projectLabel: 'project' });
  const a = custom.mk({ title: 'Old style', labels: ['front'] });
  const b = custom.mk({ title: "It's a project", labels: ['project', 'project-id:it'] });
  custom.mk({ title: 'Child', labels: ['project-id:it'] });
  const cb = custom.store.ticketBoard({});
  assert.ok(openColumns(cb).includes(a.key) && !openColumns(cb).includes(b.key));
  assert.deepEqual(cb.projects.map((x) => [x.key, x.tickets.total]), [[b.key, 1]]);
  const off = await board({ projectLabel: 'none' });
  const c = off.mk({ title: 'Labelled', labels: ['front'] });
  const ob = off.store.ticketBoard({});
  assert.ok(openColumns(ob).includes(c.key));
  assert.deepEqual([ob.projects, ob.project_label], [[], null]);
});

test('page: the view is wired, and its helpers order and count as shipped', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  for (const s of ["'projects'", 'id="projectsView"', "p: 'projects'", "renderProjects(data, now)"]) assert.ok(page.includes(s), s);
  const from = page.indexOf('// ---- projects (0.5.17)');
  const to = page.indexOf('// ---- end of projects helpers ----');
  assert.ok(from > 0 && to > from);
  const { pjCount, pjOrder } = new Function(`${page.slice(from, to)}\nreturn { pjCount, pjOrder };`)();
  assert.equal(pjCount({ total: 0, open: 0 }, 'job', 'jobs'), 'no job');
  assert.equal(pjCount({ total: 3, open: 1 }, 'ticket', 'tickets'), '<b>3</b> tickets · 1 open');
  assert.equal(pjCount({ total: 1, open: 0 }, 'job', 'jobs'), '<b>1</b> job');
  const order = pjOrder([{ key: 'A', gestures: [] }, { key: 'B', gestures: [{}] }, { key: 'C' }, { key: 'D', gestures: [{}] }]);
  assert.deepEqual(order.map((p) => p.key), ['B', 'D', 'A', 'C'], 'waiting on you first, else the server order');
});
