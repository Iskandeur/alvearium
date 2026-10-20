// 0.5.8-0.5.9: the "Waiting on you" lane answers in one tap (a choice, yes/no, done, later, not for me)
// and is ordered by what each answer unblocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { columnOf, sanitizeTicketInput } from '../lib/core.mjs';
import { ANSWERS, askComplete, askOf, askView, compareWaiting, effectivePriority, handbackOf, hasDueLabel, jobsWaiting, parseAskBlock, parseOptions, planAnswer, PROPOSAL_CAP, trustedActor } from '../lib/triage.mjs';
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

// ---- 0.5.9: the block "what we need from you" ----------------------------------------------------------

const BLOCK = `Some context the author wrote.

Ask: Pick the payment provider.
Options: A) Alder — lowest fees, no refunds API ; B) Birch — higher fees, full refunds API ; C) Cash only — nothing to build (default: B)
If no answer: I go with B on Friday at noon.

More context.`;

test('ask block: English, every field, the consequence split from the label, the default read', () => {
  assert.deepEqual(parseAskBlock(BLOCK), {
    question: 'Pick the payment provider.',
    options: [
      { id: 'A', text: 'Alder', consequence: 'lowest fees, no refunds API' },
      { id: 'B', text: 'Birch', consequence: 'higher fees, full refunds API' },
      { id: 'C', text: 'Cash only', consequence: 'nothing to build' },
    ],
    defaut: 'B',
    sansReponse: 'I go with B on Friday at noon.',
  });
});

test('ask block: French, spaces before the colon, any case, bold, a bullet, défaut without brackets', () => {
  const fr = parseAskBlock("Ce que j'attends de toi : valider le renouvellement\nOptions : A) oui — je lance ; B) non — on attend défaut : A\nSans réponse : je lance demain à 9 h");
  assert.deepEqual([fr.question, fr.options.map((o) => o.id), fr.defaut, fr.sansReponse], ['valider le renouvellement', ['A', 'B'], 'A', 'je lance demain à 9 h']);
  const loud = parseAskBlock('  - **ASK :**   ok to merge?\n  * IF NO ANSWER:  merge tomorrow');
  assert.deepEqual([loud.question, loud.options, loud.defaut, loud.sansReponse], ['ok to merge?', [], null, 'merge tomorrow']);
  assert.equal(parseAskBlock('**Options:** A) one ; B) two (défaut: B)').defaut, 'B');
  assert.equal(parseAskBlock("Ce que j’attends de toi: x").question, 'x', 'typographic apostrophe');
});

test('ask block: lettered lines on the lines after Options; the marker (default) on an option', () => {
  const b = parseAskBlock('Ask: which?\nOptions:\nA) first — cheap\nB) second (default) — dear\nIf no answer: A tomorrow');
  assert.deepEqual(b.options.map((o) => [o.id, o.text, o.consequence]), [['A', 'first', 'cheap'], ['B', 'second', 'dear']]);
  assert.equal(b.defaut, 'B');
});

test('ask block: nothing else of the body is interpreted, and prose is not an options line', () => {
  assert.equal(parseAskBlock(''), null);
  assert.equal(parseAskBlock(undefined), null);
  assert.equal(parseAskBlock('Just a body.\nA) one\nB) two'), null, 'lettered lines without the Options: line are not the block');
  assert.equal(parseAskBlock('Options: use X or Y'), null, 'not a lettered list');
  assert.equal(parseAskBlock('Options: A) only one'), null, 'two options at least');
  assert.equal(parseAskBlock('Options: A) one ; C) three'), null, 'A, B, C in order');
  assert.equal(parseAskBlock('```\nAsk: in code\nIf no answer: in code\n```'), null);
  assert.equal(parseAskBlock('My ask: not at the start of a line'), null);
  assert.equal(parseAskBlock('Task: not an ask\nAsking: neither'), null);
  const one = parseAskBlock('Ask: first\nAsk: second\nIf no answer: x');
  assert.equal(one.question, 'first', 'the first line of each kind counts');
  assert.equal(parseAskBlock('Ask: q\nOptions: A) a ; B) b (default: Z)').defaut, null, 'a default that is no option is dropped');
  assert.equal(parseAskBlock(`Ask: ${'x'.repeat(900)}`).question.length, 300);
});

test('ask block: complete means a question, a way to answer and a fallback; the gesture follows the block', () => {
  const choice = T({ body: BLOCK });
  const v = askView(choice);
  assert.equal(v.ask.complete, true);
  assert.deepEqual(v.gesture, { type: 'choice', options: [{ id: 'A', text: 'Alder' }, { id: 'B', text: 'Birch' }, { id: 'C', text: 'Cash only' }], default: 'B' });
  const yn = askView(T({ title: 'Merge?', body: 'Ask: ok to merge the PR?\nIf no answer: I merge on Friday, I will go ahead.' }));
  assert.deepEqual([yn.gesture.type, yn.gesture.default, yn.ask.complete], ['yesno', 'yes', true]);
  const act = askView(T({ kind: 'action', title: 'Renew the certificate', body: 'Ask: renew it on the hosting panel\nIf no answer: it expires on the 21st' }));
  assert.deepEqual([act.gesture.type, act.ask.complete], ['done', true]);
  assert.equal(askView(T({ body: 'Ask: which?\nOptions: A) a ; B) b' })).ask.complete, false, 'no fallback');
  assert.equal(askView(T({ body: 'Options: A) a ; B) b\nIf no answer: A' })).ask.complete, false, 'no question');
  assert.equal(askView(T({ kind: 'question', title: 'Which region?', body: 'Ask: which region?\nIf no answer: eu' })).ask.complete, false, 'an open question has no button');
  assert.equal(askView(T({ body: 'Plain old body' })).ask, null);
  assert.equal(askView(T({ body: 'Plain old body' })).gesture.type, 'yesno', 'no block: the 0.5.8 inference holds');
  assert.equal(askComplete(null, { type: 'done' }), false);
  assert.equal(askView(T({ source: 'hook', kind: 'permission', body: BLOCK })).gesture, null);
});

test('ask block: a hostile 100 KB body is read in well under 50 ms, whatever its shape; one parse per body', () => {
  const K = 100 * 1024;
  const hostile = {
    spaces: ' '.repeat(K),
    longLines: (' '.repeat(3990) + 'x\n').repeat(25),
    brackets: 'Ask: ' + '['.repeat(K),
    manyBrackets: ('Ask: ' + '['.repeat(3900) + '\n').repeat(25),
    askLines: 'Ask:\n'.repeat(K / 5),
    optionLines: 'Options:\nA) x\n'.repeat(K / 15),
    semicolons: 'Options: ' + 'A) x ; '.repeat(K / 7),
    semicolonsAndBlanks: 'Options: A) x ;' + ' '.repeat(K) + ';',
    fences: '```\n'.repeat(K / 4),
    openFence: 'a ```' + 'b'.repeat(K),
    dashes: 'Ask: ' + ' - '.repeat(K / 3),
    defaults: 'Options: A) a ; B) b ' + '(default: '.repeat(K / 10),
    stars: '**'.repeat(K / 2) + 'Ask: x',
    sentences: 'by default. '.repeat(K / 12),
    tabsAndLabels: ('\t' + ' '.repeat(3000) + 'ask' + ' '.repeat(3000) + '\n').repeat(15),
  };
  for (const [name, body] of Object.entries(hostile)) {
    for (const kind of ['decision', 'action']) {
      const t0 = performance.now();
      askView(T({ kind, body: `${body}` }));
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${name} / ${kind}: ${ms.toFixed(1)} ms`);
    }
  }
  // the same body is parsed once: the second read is the very same object
  assert.equal(parseAskBlock(BLOCK), parseAskBlock(BLOCK));
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

test('order (0.9.5): P0 to P3 as they count for you, then the oldest wait; what an answer unblocks orders nothing', () => {
  const t = (seq, o) => ({ seq, priority: null, status_at: seq, unlocks: 0, ...o });
  const lane = [
    t(1, { priority: 'P0' }),
    t(2, { priority: 'P2', unlocks: 1 }),
    t(3, { priority: 'P3', unlocks: 3 }),
    t(4, { priority: 'P1' }),
    t(5, {}),
    t(6, { priority: 'P1', status_at: 0 }),
    t(7, { priority: 'P1', unlocks: 1 }),
    t(8, { priority: 'P0', priority_proposed: true }),
    t(9, { priority: 'P0', priority_proposed: true, labels: ['due:2026-11-02'] }),
    t(10, { project_priority: { key: 'ALV-1', priority: 'P1' } }),
  ];
  assert.deepEqual(lane.sort(compareWaiting).map((x) => x.seq), [1, 9, 6, 4, 7, 10, 2, 8, 3, 5]);
});

test('effectivePriority: yours, an agent proposal capped at P2 unless due, your project when higher', () => {
  assert.equal(PROPOSAL_CAP, 'P2');
  assert.equal(effectivePriority({ priority: 'P0' }), 'P0');
  assert.equal(effectivePriority({ priority: 'P0', priority_proposed: true }), 'P2');
  assert.equal(effectivePriority({ priority: 'P0', priority_proposed: true }, { deadline: true }), 'P0');
  assert.equal(effectivePriority({ priority: 'P3', priority_proposed: true }), 'P3');
  assert.equal(effectivePriority({ priority: null, project_priority: { priority: 'P0' } }), 'P0');
  assert.equal(effectivePriority({ priority: 'P3', project_priority: { priority: 'P0' } }), 'P3', 'your own wins');
  assert.equal(effectivePriority({ priority: 'P1', priority_proposed: true, project_priority: { priority: 'P0' } }), 'P0');
  assert.equal(effectivePriority({ priority: 'P0', priority_proposed: true, project_priority: { priority: 'P3' } }), 'P2');
  assert.equal(effectivePriority({}), null);
  assert.equal(hasDueLabel({ labels: ['due:2026-11-02'] }), true);
  assert.equal(hasDueLabel({ labels: ['due:soon'] }), false);
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

test('board: the lane shows unlocks without being ordered by them, and counts only open dependents and sub-tickets', async () => {
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
  // 'urgent' is the planner's P0 on your ticket: a proposal, counted as P2 until you confirm it.
  assert.deepEqual(lane.map((t) => [t.title, t.unlocks]), [
    ['urgent', 0],
    ['gate', 2],
    ['parent of two', 2],
    ['answer feeds a job', 1],
    ['old and quiet', 0],
  ]);
  assert.equal(lane[0].priority_proposed, true);
  assert.equal(lane[0].gesture.type, 'yesno');
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

  assert.equal(store.ticketBoard({}).columns.waiting[0].gesture.default, 'A');
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

test('api: cards and the open ticket carry the block (ask) and the gesture the buttons take', async () => {
  const store = await openStore(':memory:');
  const full = store.createTicket({ title: 'Provider', kind: 'decision', status: 'waiting_on_user', assignee: 'user', body: BLOCK }, { actor: 'planner' });
  const plain = store.createTicket({ title: 'Old style', kind: 'decision', status: 'waiting_on_user', assignee: 'user', body: 'A) Keep\nB) Move\nI recommend B.' }, { actor: 'planner' });
  await withServer(store, async (base) => {
    const board = await (await fetch(`${base}/api/tickets/board`, { headers: auth })).json();
    const by = (k) => board.columns.waiting.find((t) => t.key === k);
    assert.deepEqual(by(full.key).ask, { ...parseAskBlock(BLOCK), complete: true });
    assert.equal(by(full.key).gesture.default, 'B');
    assert.equal(by(plain.key).ask, null, 'no block, no ask: the card shows a Reply link, the buttons are in the ticket');
    assert.equal(by(plain.key).gesture.default, 'B', 'the 0.5.8 inference still feeds the reply bar');
    const one = await (await fetch(`${base}/api/tickets/${full.key}`, { headers: auth })).json();
    assert.equal(one.ask.question, 'Pick the payment provider.');
    assert.equal(one.gesture.type, 'choice');
    // answering through the block's options posts the label
    const r = await post(base, `/api/tickets/${full.key}/answer`, { answer: 'option', choice: 'C' });
    assert.equal(r.status, 200);
    const ev = (await (await fetch(`${base}/api/tickets/${full.key}`, { headers: auth })).json()).events.find((e) => e.type === 'comment');
    assert.equal(ev.text, 'Answer: C — Cash only');
  });
});

// ---- the page -------------------------------------------------------------------------------------

test('page: the buttons render with a default marked, labelled, and the CSP is untouched', () => {
  const from = page.indexOf('const LATER = ');
  const to = page.indexOf('const rerenderBoard');
  assert.ok(from > 0 && to > from, 'asks() is in the page');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const i18n = page.slice(page.indexOf('// ---- i18n (0.9.9)'), page.indexOf('// ---- end i18n'));
  const make = new Function('esc', 'plain', 'isOpen', '$', `${i18n}\nconst tr = makeTr('en', 'en');\n${page.slice(from, to)}; return { asks, askBusy, replyBar, askBox, bodyRest, open: (k) => { askMenu = k; } };`);
  const { asks, askBusy, replyBar, askBox, bodyRest, open } = make(esc, (x) => String(x), () => true, () => null);
  const gesture = { type: 'choice', default: 'B', options: [{ id: 'A', text: 'Keep <SQLite>' }, { id: 'B', text: 'Move' }] };
  const block = { question: 'Which database?', options: [{ id: 'A', text: 'Keep <SQLite>', consequence: 'nothing to migrate' }, { id: 'B', text: 'Move', consequence: 'one night of work' }], defaut: 'B', sansReponse: 'I keep SQLite on Friday.', complete: true };
  const t = { key: 'ALV-7', title: 'Database', column: 'waiting', gesture, ask: block };
  const html = asks(t);
  assert.match(html, /role="group" aria-label="Answer ALV-7"/);
  assert.equal((html.match(/data-ask="option"/g) || []).length, 2);
  assert.match(html, /Keep &lt;SQLite&gt;/, 'option text is escaped');
  assert.match(html, /ask opt def" data-ask="option" data-key="ALV-7" data-choice="B"[^>]*aria-label="Option B: Move \(default\)"/);
  assert.equal((html.match(/ def"/g) || []).length, 1);
  assert.match(html, /data-ask="laterMenu"[\s\S]*data-ask="decline"/);
  assert.equal(asks({ ...t, column: 'todo' }), '', 'only on the lane');
  assert.equal(asks({ ...t, gesture: null }), '');
  // the card carries buttons only when the block is complete; the open ticket always does
  assert.equal(asks({ ...t, ask: null }), '', 'no block: no button on the card');
  assert.equal(asks({ ...t, ask: { ...block, complete: false } }), '');
  assert.match(asks({ ...t, ask: null }, 'bar'), /data-ask="option"/, 'but the reply bar has them');
  const yn = { ...t, gesture: { type: 'yesno', default: 'yes' } };
  assert.match(asks(yn), /data-ask="yes"[^>]*aria-label="Yes \(default\)"[\s\S]*data-ask="no"/);
  assert.match(asks({ ...t, gesture: { type: 'done' } }), /data-ask="done"/);
  assert.doesNotMatch(asks({ ...t, gesture: { type: 'none' } }, 'bar'), /data-ask="(yes|no|done|option)"/);
  assert.match(asks({ ...t, gesture: { type: 'none' } }, 'bar'), /data-ask="comment"/);
  askBusy.add('ALV-7');
  assert.match(asks(t), /data-ask="option"[^>]* disabled/);
  open('ALV-7');
  const menu = asks(t);
  assert.deepEqual([...menu.matchAll(/data-days="(\d+)"/g)].map((m) => m[1]), ['1', '7', '30']);
  assert.doesNotMatch(menu, /data-ask="decline"/);
  open(null);
  // the bar says what it answers; the box above the details lays the options and the fallback out
  assert.match(replyBar(t), /class="replyBar"[\s\S]*Which database\?[\s\S]*class="asks at-bar"/);
  assert.match(replyBar({ ...t, ask: null }), /rbQ" title="Database"/, 'no block: the title is the context');
  assert.equal(replyBar({ ...t, column: 'todo' }), '');
  const box = askBox(t);
  assert.match(box, /Which database\?/);
  assert.match(box, /<li class="def"><b[^>]*>B<\/b><span>Move<i>default<\/i><em>one night of work<\/em>/);
  assert.match(box, /If no answer:<\/b> I keep SQLite on Friday\./);
  assert.match(box, /Keep &lt;SQLite&gt;/);
  assert.equal(askBox({ ...t, ask: null }), '');
  // the box replaces exactly the lines it shows, nothing else of the body
  const raw = 'Context.\n\nAsk: Which?\nOptions:\nA) a — x\nB) b — y\nIf no answer: A.\n\nMore context.';
  const view = (body, extra = {}) => ({ ...t, body, ...askView(T({ body })), ...extra });
  assert.equal(bodyRest(view(raw)), 'Context.\n\nMore context.');
  assert.equal(bodyRest({ ...t, ask: null, ask_lines: [], body: raw }), raw, 'no block read: the body is shown as written');
  // partial blocks: only what the box shows leaves the description
  const prose = 'Ask: Which?\nOptions: use X or Y, whichever is cheaper\nIf no answer: X';
  assert.equal(bodyRest(view(prose)), 'Options: use X or Y, whichever is cheaper', 'prose options are not shown, so they stay');
  const gap = 'Ask: Which?\nOptions: A) a ; C) c\nIf no answer: A';
  assert.equal(bodyRest(view(gap)), 'Options: A) a ; C) c', 'letters out of order: not a list, not shown, kept');
  const fenced = '```\nAsk: in code\nIf no answer: in code\n```\nAsk: the real one\nIf no answer: tomorrow';
  assert.equal(bodyRest(view(fenced)), '```\nAsk: in code\nIf no answer: in code\n```', 'a code fence keeps its lines, the real block goes');
  assert.equal(bodyRest(view('Ask: ' + 'x'.repeat(500) + '\nIf no answer: A')), 'Ask: ' + 'x'.repeat(500), 'a question cut to 300 characters is not fully shown, so it stays');
  assert.equal(bodyRest(view('Ask: q\nOptions: A) a ; B) b (default: E)\nIf no answer: A')), 'Options: A) a ; B) b (default: E)', 'a default that is no option is dropped from the box, so the line stays');
  assert.equal(bodyRest(view('Ask: q\nIf no answer: A\nAsk: a second ask stays\nOptions: just text')), 'Ask: a second ask stays\nOptions: just text');
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
  assert.equal(board().columns.waiting.find((t) => t.key === decision.key).gesture.type, 'choice');
  assert.equal(board().columns.waiting.find((t) => t.key === action.key).gesture.type, 'done');
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

test('ask block: snake_case and a lone * keep their characters; only paired emphasis is stripped (0.5.10)', () => {
  const a = parseAskBlock('Ask: Add `REFRESH_LOCK_TTL=5000` to the **staging** secrets, 2 * 3 = 6\nIf no answer: I keep _the_ default');
  assert.equal(a.question, 'Add REFRESH_LOCK_TTL=5000 to the staging secrets, 2 * 3 = 6');
  assert.equal(a.sansReponse, 'I keep the default');
});

test('answers stay compatible with 0.5.9 clients: an option is matched by its letter, never by its cleaned text (0.5.10)', () => {
  // The 0.5.10 clean() keeps snake_case (0.5.9 dropped every _ and *), so option texts changed form.
  // An answer still goes through: the page, the API and the MCP tools of 0.5.9 send the letter.
  const t = { assignee: 'user', status: 'todo', kind: 'decision', source: 'claude', created_by: 'planner', body: 'Options:\nA) keep REFRESH_LOCK_TTL — no change\nB) drop the *cache_v2* table — frees 2 GB\nI recommend drop the cache_v2 table.' };
  const ask = askOf(t);
  assert.deepEqual(ask.options.map((o) => o.text), ['keep REFRESH_LOCK_TTL', 'drop the cache_v2 table']);
  assert.equal(ask.default, 'B', 'the default found by text: body and options are cleaned the same way');
  for (const choice of ['B', 'b']) assert.equal(planAnswer(t, 'option', choice).comment, 'Answer: B — drop the cache_v2 table');
  // A stored answer is history, never re-parsed: an old "Answer: B — drop the cachev2 table" comment changes nothing.
  assert.match(planAnswer(t, 'option', 'drop the cachev2 table').error, /unknown option/, 'a text was never a valid choice, before or now');
});
