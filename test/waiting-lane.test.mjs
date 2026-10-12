// 0.5.8: the "Waiting on you" lane answers in one tap (a choice, yes/no, done, later, not for me)
// and is ordered by what each answer unblocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { columnOf, sanitizeTicketInput } from '../lib/core.mjs';
import { ANSWERS, askOf, compareWaiting, handbackOf, jobsWaiting, parseOptions, planAnswer, trustedActor } from '../lib/triage.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const DAY = 86400000;
const TOKEN = 'x'.repeat(32);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const T = (o) => ({ assignee: 'user', status: 'waiting_on_user', kind: 'decision', source: 'claude', title: 'Pick one', body: '', labels: [], ...o });

// ---- what a ticket accepts ------------------------------------------------------------------------

test('options: lettered lines, bullets only for a decision, never a lone letter, markers stripped', () => {
  const lettered = 'Which database?\n\nA) Keep SQLite\nB) Move to Postgres (recommended)\nC. Do nothing for now';
  assert.deepEqual(parseOptions(lettered), [
    { id: 'A', text: 'Keep SQLite', marked: false },
    { id: 'B', text: 'Move to Postgres', marked: true },
    { id: 'C', text: 'Do nothing for now', marked: false },
  ]);
  const bullets = '- ship it now\n- wait for the review';
  assert.deepEqual(parseOptions(bullets), [], 'bullets are context in an ordinary ticket');
  assert.equal(parseOptions(bullets, { loose: true }).length, 2);
  assert.deepEqual(parseOptions('Option A: left\nOption B: right').map((o) => o.id), ['A', 'B']);
  assert.deepEqual(parseOptions('B) a lone letter\nsomething else'), []);
  assert.deepEqual(parseOptions('A) one\nC) skipped a letter'), [], 'lettered lines must read A, B, C');
  assert.equal(parseOptions('A) one\nB) two\nC) three\nD) four\nE) five\nF) six').length, 5, 'capped');
  assert.deepEqual(parseOptions('```\nA) in code\nB) in code\n```'), []);
});

test('ask: a choice with its default, from a marker, a letter, a number or the text', () => {
  const body = (extra) => `A) Keep SQLite\nB) Move to Postgres\n${extra}`;
  assert.equal(askOf(T({ body: body('') })).default, null);
  assert.equal(askOf(T({ body: body('I recommend B.') })).default, 'B');
  assert.equal(askOf(T({ body: body('Default: A') })).default, 'A');
  assert.equal(askOf(T({ body: body('If you do not answer I will go with option 2.') })).default, 'B');
  assert.equal(askOf(T({ body: 'A) Keep SQLite (default)\nB) Move to Postgres' })).default, 'A');
  assert.equal(askOf(T({ body: body('By default I will move to Postgres.') })).default, 'B', 'by the option text');
  const a = askOf(T({ body: body('') }));
  assert.equal(a.type, 'choice');
  assert.deepEqual(a.options.map((o) => o.id), ['A', 'B']);
});

test('ask: yes/no, done, nothing; and never for a ticket answered in a session', () => {
  assert.deepEqual(askOf(T({ body: 'Shall I merge it?' })), { type: 'yesno', default: null });
  assert.equal(askOf(T({ body: 'No answer in 48 h: I will go ahead.' })).default, 'yes');
  assert.equal(askOf(T({ body: 'By default I will not touch it.' })).default, 'no');
  assert.equal(askOf(T({ body: 'If you do not answer by Friday I will go ahead.' })).default, 'yes', 'the condition is not the answer');
  assert.equal(askOf(T({ body: 'If you say nothing, I will skip it.' })).default, 'no');
  assert.equal(askOf(T({ kind: 'question', title: 'Should we rotate the key?' })).type, 'yesno');
  assert.equal(askOf(T({ kind: 'question', title: 'Which region do you want?' })).type, 'none', 'an open question has no button to answer it');
  assert.equal(askOf(T({ kind: 'action', title: 'Renew the certificate' })).type, 'done');
  assert.equal(askOf(T({ kind: 'task', title: 'Review the draft' })).type, 'done');
  assert.equal(askOf(T({ kind: 'permission', source: 'hook' })), null);
  assert.equal(askOf(T({ kind: 'question', source: 'hook' })), null);
  assert.equal(askOf(T({ kind: 'session' })), null);
  assert.equal(askOf(T({ assignee: 'claude' })), null);
  assert.equal(askOf(T({ status: 'done' })), null);
});

test('plan: each button is a structured comment and a reversible move', () => {
  const choice = T({ created_by: 'planner', body: 'A) Keep SQLite\nB) Move to Postgres' });
  assert.deepEqual(planAnswer(choice, 'option', 'b'), { comment: 'Answer: B — Move to Postgres', fields: { status: 'in_progress', assignee: 'planner', snoozed_until: null } });
  assert.match(planAnswer(choice, 'option', 'Z').error, /unknown option/);
  assert.match(planAnswer(choice, 'yes').error, /yes\/no/);
  const yn = T({ created_by: 'user', body: 'Shall I merge it?' });
  assert.deepEqual(planAnswer(yn, 'no'), { comment: 'Answer: no', fields: { status: 'in_progress', assignee: 'claude', snoozed_until: null } }, 'a ticket he opened himself goes to Claude');
  assert.deepEqual(planAnswer(T({ kind: 'action', title: 'Renew it' }), 'done').fields, { status: 'done', snoozed_until: null });
  assert.match(planAnswer(T({ kind: 'action', title: 'Renew it' }), 'yes').error, /yes\/no/);
  const later = planAnswer(T({ created_by: 'planner' }), 'later', 7, { now: Date.UTC(2026, 0, 10) });
  assert.deepEqual(later, { comment: 'Later: not before 2026-01-17, no reminder until then', fields: { snoozed_until: Date.UTC(2026, 0, 17) } });
  for (const bad of [0, 91, 1.5, 'x']) assert.ok(planAnswer(T({}), 'later', bad).error, `days=${bad}`);
  assert.deepEqual(planAnswer(T({ created_by: 'planner' }), 'decline').fields, { assignee: 'planner', snoozed_until: null });
  assert.equal(handbackOf(T({ created_by: 'hook' }), 'user'), 'claude');
  assert.equal(handbackOf(T({ created_by: 'planner' }), 'planner'), 'claude', 'never back to the one who answers');
  assert.match(planAnswer(T({ kind: 'permission', source: 'hook' }), 'done').error, /not waiting/);
  assert.match(planAnswer(T({}), 'burn').error, new RegExp(ANSWERS[0]));
});

// ---- order ----------------------------------------------------------------------------------------

test('order: what the answer unblocks first, then P0 to P3, then the oldest wait', () => {
  const t = (seq, o) => ({ seq, priority: null, status_at: seq, unlocks: 0, ...o });
  const lane = [
    t(1, { priority: 'P0' }),
    t(2, { priority: 'P2', unlocks: 1 }),
    t(3, { priority: 'P3', unlocks: 3 }),
    t(4, { priority: 'P1' }),
    t(5, {}),
    t(6, { priority: 'P1', status_at: 0 }),
    t(7, { priority: 'P1', unlocks: 1 }),
  ];
  assert.deepEqual(lane.sort(compareWaiting).map((x) => x.seq), [3, 7, 2, 1, 6, 4, 5]);
});

test('jobs waiting: the label convention', () => {
  assert.equal(jobsWaiting(['blocks-job']), 1);
  assert.equal(jobsWaiting(['blocks-jobs:3', 'x']), 3);
  assert.equal(jobsWaiting(['blocks-jobs:3', 'blocks-job']), 4);
  assert.equal(jobsWaiting(['blocks-jobs:x', 'blocks-jobs:1000', null]), 0);
  assert.equal(jobsWaiting(['blocks-jobs:50']), 9, 'capped: a label cannot jump the queue');
  assert.equal(jobsWaiting(['blocks-jobs:8', 'blocks-job', 'blocks-job']), 9);
  assert.ok(trustedActor('ops', ['ops']) && trustedActor('ops/job-4', ['ops']));
  assert.ok(!trustedActor('opsy', ['ops']) && !trustedActor('x', []) && !trustedActor('x', undefined));
  assert.equal(jobsWaiting(undefined), 0);
});

test('board: the lane is ordered by unlocks, and counts only open dependents and sub-tickets', async () => {
  const store = await openStore(':memory:', { jobActors: ['planner'] });
  const mk = (title, o = {}) => store.createTicket({ title, assignee: 'user', status: 'waiting_on_user', kind: 'decision', ...o }, { actor: 'planner' });
  const old = mk('old and quiet');
  const urgent = mk('urgent', { priority: 'P0' });
  const gate = mk('gate', { priority: 'P3' });
  const parent = mk('parent of two', { priority: 'P3' });
  const jobs = mk('answer feeds a job', { labels: ['blocks-job'], priority: 'P3' });
  const b1 = store.createTicket({ title: 'waits for the gate', assignee: 'claude', status: 'todo' }, { actor: 'planner' });
  const b2 = store.createTicket({ title: 'also waits', assignee: 'claude', status: 'todo' }, { actor: 'planner' });
  const closed = store.createTicket({ title: 'was waiting, now finished', assignee: 'claude', status: 'done' }, { actor: 'planner' });
  for (const b of [b1, b2, closed]) store.updateTicket(b.key, { blocked_by_add: [gate.key] });
  store.createTicket({ title: 'child 1', assignee: 'claude', status: 'todo', parent: parent.key }, { actor: 'planner' });
  store.createTicket({ title: 'child 2', assignee: 'claude', status: 'in_progress', parent: parent.key }, { actor: 'planner' });
  store.createTicket({ title: 'child 3', assignee: 'claude', status: 'done', parent: parent.key }, { actor: 'planner' });

  const lane = store.ticketBoard({}).columns.waiting;
  assert.deepEqual(lane.map((t) => [t.title, t.unlocks]), [
    ['gate', 2],
    ['parent of two', 2],
    ['answer feeds a job', 1],
    ['urgent', 0],
    ['old and quiet', 0],
  ]);
  assert.equal(lane[0].ask.type, 'yesno');
  assert.ok(lane.every((t) => t.column === 'waiting'));
  assert.equal(urgent.priority, 'P0');
  assert.equal(old.status, 'waiting_on_user');
  assert.equal(jobs.labels[0], 'blocks-job');
});

// ---- the answer, in the store --------------------------------------------------------------------

test('answer: a comment from him, a move, and what it was before; Later hides the ticket until its date', async () => {
  let at = Date.UTC(2026, 5, 1);
  const store = await openStore(':memory:', { now: () => at });
  const t = store.createTicket({ title: 'Database', kind: 'decision', status: 'waiting_on_user', assignee: 'user', body: 'A) Keep SQLite\nB) Move to Postgres\nDefault: A' }, { actor: 'planner' });
  const col = (name) => store.ticketBoard({}).columns[name].map((x) => x.key);

  assert.equal(store.ticketBoard({}).columns.waiting[0].ask.default, 'A');
  const r = store.answerTicket(t.key, { answer: 'option', choice: 'B' }, { actor: 'user' });
  assert.deepEqual(r.previous, { status: 'waiting_on_user', assignee: 'user', snoozed_until: null });
  assert.deepEqual([r.ticket.status, r.ticket.assignee, r.ticket.column], ['in_progress', 'planner', 'inProgress']);
  const ev = store.getTicket(t.key).events;
  assert.deepEqual(ev.filter((e) => e.type === 'comment').map((e) => [e.actor, e.text]), [['user', 'Answer: B — Move to Postgres']]);
  assert.ok(ev.some((e) => e.type === 'assigned'));
  assert.deepEqual(col('waiting'), []);

  // Undo goes through while nobody has touched the ticket since the click.
  const u = store.answerTicket(t.key, { answer: 'undo', previous: r.previous, expect: r.expect }, { actor: 'user' });
  assert.deepEqual([u.ticket.status, u.ticket.assignee], ['waiting_on_user', 'user']);
  assert.deepEqual(col('waiting'), [t.key]);

  // Later: out of the lane, into To do, back by itself on the date.
  const l = store.answerTicket(t.key, { answer: 'later', days: 7 }, { actor: 'user' });
  assert.equal(l.ticket.snoozed_until, at + 7 * DAY);
  assert.deepEqual([col('waiting'), col('todo')], [[], [t.key]]);
  assert.equal(l.ticket.column, 'todo');
  assert.equal(store.ticketBoard({}).counts.waiting, 0);
  at += 7 * DAY + 1;
  assert.deepEqual([col('waiting'), col('todo')], [[t.key], []]);
  assert.equal(store.getTicket(t.key).snoozed_until, null, 'a date in the past is not shown');

  // Not for me: the creator gets it back; status untouched.
  const d = store.answerTicket(t.key, { answer: 'decline' }, { actor: 'user' });
  assert.deepEqual([d.ticket.assignee, d.ticket.status], ['planner', 'waiting_on_user']);
  assert.equal(d.ticket.column, 'inProgress');

  assert.throws(() => store.answerTicket(t.key, { answer: 'option', choice: 'A' }), (e) => e.status === 400, 'no longer his: no direct answer');
  assert.throws(() => store.answerTicket('ALV-999', { answer: 'yes' }), (e) => e.status === 404);
});

test('answer: done closes the ticket and it reopens on Undo; snoozed_until validates', async () => {
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'Renew the certificate', kind: 'action', status: 'waiting_on_user', assignee: 'user' }, { actor: 'planner' });
  const r = store.answerTicket(t.key, { answer: 'done' }, { actor: 'user' });
  assert.deepEqual([r.ticket.status, r.ticket.assignee, r.ticket.column], ['done', 'user', 'done']);
  assert.equal(store.answerTicket(t.key, { answer: 'undo', previous: r.previous, expect: r.expect }).ticket.status, 'waiting_on_user');
  assert.deepEqual(sanitizeTicketInput({ snoozed_until: null }, { partial: true }).value, { snoozed_until: null });
  assert.ok(sanitizeTicketInput({ snoozed_until: 'soon' }, { partial: true }).error);
  assert.equal(columnOf({ status: 'waiting_on_user', assignee: 'user', snoozed_until: 2000 }, 1000), 'todo');
  assert.equal(columnOf({ status: 'waiting_on_user', assignee: 'user', snoozed_until: 2000 }, 3000), 'waiting');
  assert.equal(columnOf({ status: 'waiting_on_user', assignee: 'claude', snoozed_until: 2000 }, 1000), 'inProgress');
});

// ---- the API --------------------------------------------------------------------------------------

async function withServer(store, fn) {
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const post = async (base, path, body, headers = auth) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('api: POST /api/tickets/:key/answer, the page sends no actor so the comment is his', async () => {
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'Merge it?', kind: 'decision', status: 'waiting_on_user', assignee: 'user' }, { actor: 'planner' });
  await withServer(store, async (base) => {
    assert.equal((await post(base, `/api/tickets/${t.key}/answer`, { answer: 'yes' }, {})).status, 401);
    assert.equal((await post(base, `/api/tickets/${t.key}/answer`, { answer: 'maybe' })).status, 400);
    assert.equal((await post(base, `/api/tickets/${t.key}/answer`, { answer: 'option', choice: 'A' })).status, 400);
    const ok = await post(base, `/api/tickets/${t.key}/answer`, { answer: 'yes' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.ticket.status, ok.body.ticket.assignee, ok.body.previous.status], ['in_progress', 'planner', 'waiting_on_user']);
    const board = await (await fetch(`${base}/api/tickets/board`, { headers: auth })).json();
    assert.equal(board.counts.waiting, 0);
    const full = await (await fetch(`${base}/api/tickets/${t.key}`, { headers: auth })).json();
    const c = full.events.find((e) => e.type === 'comment');
    assert.deepEqual([c.actor, c.text], ['user', 'Answer: yes']);
    assert.equal((await fetch(`${base}/api/tickets/${t.key}/answer`, { headers: auth })).status, 405);
    // Undo: refused (409) once the agent has moved on, allowed before.
    await post(base, `/api/tickets/${t.key}`, { comment: 'on it' }, { ...auth, 'x-session-board-actor': 'planner' });
    const late = await post(base, `/api/tickets/${t.key}/answer`, { answer: 'undo', previous: ok.body.previous, expect: ok.body.expect });
    assert.deepEqual([late.status, late.body.error], [409, 'already taken over, nothing undone']);
    const t2 = store.createTicket({ title: 'Ship it?', kind: 'decision', status: 'waiting_on_user', assignee: 'user' }, { actor: 'planner' });
    const r2 = await post(base, `/api/tickets/${t2.key}/answer`, { answer: 'no' });
    const back = await post(base, `/api/tickets/${t2.key}/answer`, { answer: 'undo', previous: r2.body.previous, expect: r2.body.expect });
    assert.deepEqual([back.status, back.body.ticket.status, back.body.ticket.assignee], [200, 'waiting_on_user', 'user']);
  });
});

// ---- the page -------------------------------------------------------------------------------------

test('page: the buttons render with a default marked, labelled, and the CSP is untouched', () => {
  const from = page.indexOf('const LATER = ');
  const to = page.indexOf('const rerenderBoard');
  assert.ok(from > 0 && to > from, 'asks() is in the page');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const make = new Function('esc', `${page.slice(from, to)}; return { asks, askBusy, open: (k) => { askMenu = k; } };`);
  const { asks, askBusy, open } = make(esc);
  const t = { key: 'ALV-7', column: 'waiting', ask: { type: 'choice', default: 'B', options: [{ id: 'A', text: 'Keep <SQLite>' }, { id: 'B', text: 'Move' }] } };
  const html = asks(t);
  assert.match(html, /role="group" aria-label="Answer ALV-7"/);
  assert.equal((html.match(/data-ask="option"/g) || []).length, 2);
  assert.match(html, /Keep &lt;SQLite&gt;/, 'option text is escaped');
  assert.match(html, /ask opt def" data-ask="option" data-key="ALV-7" data-choice="B"[^>]*aria-label="Option B: Move \(default\)"/);
  assert.equal((html.match(/ def"/g) || []).length, 1);
  assert.match(html, /data-ask="laterMenu"[\s\S]*data-ask="decline"/);
  assert.equal(asks({ ...t, column: 'todo' }), '', 'only on the lane');
  assert.equal(asks({ ...t, ask: null }), '');
  assert.match(asks({ ...t, ask: { type: 'yesno', default: 'yes' } }), /data-ask="yes"[^>]*aria-label="Yes \(default\)"[\s\S]*data-ask="no"/);
  assert.match(asks({ ...t, ask: { type: 'done' } }), /data-ask="done"/);
  assert.doesNotMatch(asks({ ...t, ask: { type: 'none' } }), /data-ask="(yes|no|done|option)"/);
  askBusy.add('ALV-7');
  assert.match(asks(t), /data-ask="option"[^>]* disabled/);
  open('ALV-7');
  const menu = asks(t);
  assert.deepEqual([...menu.matchAll(/data-days="(\d+)"/g)].map((m) => m[1]), ['1', '7', '30']);
  assert.doesNotMatch(menu, /data-ask="decline"/);
});

test('page: no external dependency, no inline handler, same CSP', () => {
  assert.doesNotMatch(page, /<script[^>]+src=|<link[^>]+href="https?:/i);
  assert.doesNotMatch(page, /\son(click|change|submit)=/i);
  const server = readFileSync(join(import.meta.dirname, '..', 'server', 'server.mjs'), 'utf8');
  assert.match(server, /'content-security-policy': "default-src 'none'; sandbox"/);
});

test('lane: his "to do" that ask a gesture are in it too; traces, sessions and other people\'s work are not', async () => {
  let at = Date.UTC(2026, 5, 1);
  const store = await openStore(':memory:', { now: () => (at += 1000) });
  const mk = (title, o = {}) => store.createTicket({ title, assignee: 'user', status: 'todo', ...o }, { actor: 'planner' });
  const decision = mk('Pick a name', { kind: 'decision', body: 'A) Fern\nB) Moss' });
  const action = mk('Call the plumber', { kind: 'action' });
  const question = mk('Should we move the launch?', { kind: 'question' });
  const note = mk('Meeting notes', { kind: 'note' });
  const task = mk('Refactor the importer', { kind: 'task' });
  const agentsAction = store.createTicket({ title: 'Agent action', kind: 'action', assignee: 'claude', status: 'todo' }, { actor: 'planner' });
  const session = store.createTicket({ title: 'Session mirror', kind: 'session', assignee: 'user', status: 'todo' }, { actor: 'planner' });
  const hooked = store.createTicket({ title: 'Hook question', kind: 'question', assignee: 'user', status: 'todo' }, { actor: 'planner' });
  store.q('UPDATE tickets SET source = ? WHERE id = ?').run('hook', hooked.id);
  const board = () => store.ticketBoard({});
  const keys = (name) => board().columns[name].map((t) => t.key).sort();
  const gestures = [decision, action, question].map((t) => t.key).sort();
  assert.deepEqual(keys('waiting'), gestures);
  assert.equal(board().counts.waiting, 3);
  assert.deepEqual(keys('todo'), [note, task, agentsAction, session, hooked].map((t) => t.key).sort());
  assert.ok(!keys('waiting').includes(hooked.key) && !keys('waiting').includes(session.key));
  assert.equal(board().columns.waiting.find((t) => t.key === decision.key).ask.type, 'choice');
  assert.equal(board().columns.waiting.find((t) => t.key === action.key).ask.type, 'done');
  assert.equal(columnOf({ status: 'todo', assignee: 'user', kind: 'action' }), 'waiting');
  assert.equal(columnOf({ status: 'todo', assignee: 'user', kind: 'task' }), 'todo');
  assert.equal(columnOf({ status: 'todo', assignee: 'user', kind: 'action', source: 'hook' }), 'todo');
  for (const t of board().columns.waiting) assert.equal(t.column, 'waiting', 'the card agrees with its lane');

  // Done from the lane closes it; Later parks it in To do until its date; counts follow.
  store.answerTicket(action.key, { answer: 'done' }, { actor: 'user' });
  assert.equal(board().counts.waiting, 2);
  store.answerTicket(question.key, { answer: 'later', days: 1 }, { actor: 'user' });
  assert.deepEqual([board().counts.waiting, keys('todo').includes(question.key)], [1, true]);
  at += 2 * DAY;
  assert.deepEqual(keys('waiting'), [decision.key, question.key].sort());
  // Answering a decision hands it over and it leaves the lane.
  store.answerTicket(decision.key, { answer: 'option', choice: 'B' }, { actor: 'user' });
  assert.ok(!keys('waiting').includes(decision.key));
});

test('undo: refused when the ticket moved since the click, whoever moved it', async () => {
  let at = Date.UTC(2026, 5, 1);
  const store = await openStore(':memory:', { now: () => (at += 1000) });
  const mk = () => store.createTicket({ title: 'Merge it?', kind: 'decision', status: 'waiting_on_user', assignee: 'user' }, { actor: 'planner' });
  const refused = (key, r) => assert.throws(() => store.answerTicket(key, { answer: 'undo', previous: r.previous, expect: r.expect }), (e) => e.status === 409 && /already taken over, nothing undone/.test(e.message));

  const a = mk();
  const ra = store.answerTicket(a.key, { answer: 'yes' }, { actor: 'user' });
  store.updateTicket(a.key, { status: 'done' }, { actor: 'planner' }); // the agent finished it
  refused(a.key, ra);
  assert.equal(store.getTicket(a.key).status, 'done', 'left as the agent had it');

  const b = mk();
  const rb = store.answerTicket(b.key, { answer: 'yes' }, { actor: 'user' });
  store.comment(b.key, 'on it', { actor: 'planner' }); // a comment moves updated_at
  refused(b.key, rb);

  const c = mk();
  const rc = store.answerTicket(c.key, { answer: 'decline' }, { actor: 'user' });
  store.updateTicket(c.key, { assignee: 'claude' }, { actor: 'planner' });
  refused(c.key, rc);

  const d = mk();
  const rd = store.answerTicket(d.key, { answer: 'later', days: 1 }, { actor: 'user' });
  store.updateTicket(d.key, { snoozed_until: null }, { actor: 'user' });
  refused(d.key, rd);

  assert.throws(() => store.answerTicket(mk().key, { answer: 'undo' }, { actor: 'user' }), (e) => e.status === 409, 'no proof of the click, no undo');
  const e = mk();
  const re = store.answerTicket(e.key, { answer: 'yes' }, { actor: 'user' });
  assert.throws(() => store.answerTicket(e.key, { answer: 'undo', previous: { status: 'bogus', assignee: 'user' }, expect: re.expect }, { actor: 'user' }), (x) => x.status === 400);
});

test('lane: rows with a NULL kind or source (old rows, imports) still count as gestures', async () => {
  assert.equal(columnOf({ status: 'todo', assignee: 'user', kind: null, source: null }), 'waiting');
  assert.equal(columnOf({ status: 'todo', assignee: 'user', kind: undefined }), 'waiting');
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'Imported long ago', status: 'todo', assignee: 'user' }, { actor: 'planner' });
  // The schema says NOT NULL: rebuild the two columns as nullable, as a row from before it would have them.
  store.db.exec('PRAGMA foreign_keys = OFF');
  const cols = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tickets'").get().sql;
  const loose = cols.replace(/kind TEXT NOT NULL DEFAULT 'action'/, 'kind TEXT').replace(/source TEXT NOT NULL DEFAULT 'user'/, 'source TEXT').replace('CREATE TABLE tickets', 'CREATE TABLE tickets_loose');
  assert.notEqual(loose, cols, 'the schema was rewritten');
  store.db.exec(loose);
  store.db.exec('INSERT INTO tickets_loose SELECT * FROM tickets');
  store.db.exec('DROP TABLE tickets; ALTER TABLE tickets_loose RENAME TO tickets');
  store.db.exec('UPDATE tickets SET kind = NULL, source = NULL');
  store.db.exec('PRAGMA foreign_keys = ON');
  const board = store.ticketBoard({});
  assert.deepEqual([board.counts.waiting, board.counts.todo], [1, 0], 'in the lane, and not lost from To do either');
  assert.equal(board.columns.waiting[0].key, t.key);
});

test('lane: capped like the others, and the most unblocking tickets survive the cap', async () => {
  const store = await openStore(':memory:');
  const mk = (title, o = {}) => store.createTicket({ title, assignee: 'user', status: 'waiting_on_user', kind: 'decision', ...o }, { actor: 'planner' });
  for (let i = 0; i < 230; i++) mk('filler ' + i);
  const last = mk('the late one that unblocks two', { priority: 'P3' });
  for (const n of ['w1', 'w2']) store.updateTicket(store.createTicket({ title: n, assignee: 'claude', status: 'todo' }, { actor: 'planner' }).key, { blocked_by_add: [last.key] });
  const b = store.ticketBoard({});
  assert.equal(b.counts.waiting, 231);
  assert.equal(b.columns.waiting.length, 200);
  assert.deepEqual([b.columns.waiting[0].key, b.columns.waiting[0].unlocks], [last.key, 2]);
  // Unlocks come from one grouped read: the same statement text whatever the size of the lane.
  const texts = new Set();
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => (texts.add(sql.replace(/\s+/g, ' ')), prepare(sql));
  store.ticketBoard({});
  assert.ok([...texts].some((q) => /LEFT JOIN \(SELECT id, COUNT\(\*\)/.test(q)));
  assert.equal([...texts].filter((q) => /FROM ticket_deps d JOIN tickets x ON x.id = d.blocked_id WHERE d.blocker_id = \?/.test(q)).length, 0, 'no count per card');
});

test('jobs waiting: only a human, or an agent the deployment names, can claim them; capped', async () => {
  const store = await openStore(':memory:', { jobActors: ['ops'] });
  const mk = (title, actor, labels) => store.createTicket({ title, assignee: 'user', status: 'waiting_on_user', kind: 'decision', labels }, { actor });
  mk('by a human', 'user', ['blocks-job']);
  mk('by the named agent', 'ops', ['blocks-jobs:3']);
  mk('by its sub-actor', 'ops/job-9', ['blocks-job']);
  mk('by any other writer', 'stranger', ['blocks-jobs:9']);
  const edited = mk('edited in by a stranger', 'user', []);
  store.updateTicket(edited.key, { labels: ['blocks-job'] }, { actor: 'stranger' });
  const flood = mk('a flood', 'user', ['blocks-jobs:99']);
  const lane = Object.fromEntries(store.ticketBoard({}).columns.waiting.map((t) => [t.title, t.unlocks]));
  assert.deepEqual(lane, { 'by a human': 1, 'by the named agent': 3, 'by its sub-actor': 1, 'by any other writer': 0, 'edited in by a stranger': 0, 'a flood': 9 });
  assert.equal(flood.labels[0], 'blocks-jobs:99');
  // With nobody named, only humans count.
  const bare = await openStore(':memory:');
  bare.createTicket({ title: 'agent', assignee: 'user', status: 'waiting_on_user', kind: 'decision', labels: ['blocks-job'] }, { actor: 'ops' });
  assert.equal(bare.ticketBoard({}).columns.waiting[0].unlocks, 0);
});
