// 0.5.14: the matrix view (important × urgent). The projection runs as shipped: the helpers are lifted
// out of server/page.html. Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const from = page.indexOf('// ---- matrix (0.5.14)');
const to = page.indexOf('// ---- end of matrix helpers ----');
assert.ok(from > 0 && to > from, 'matrix helpers found in page.html');
const roiNum = (n) => String(n);
const { mxDeadline, mxPlace, mxProject, MX_LEGEND, MX_QUADS } = new Function('roiNum', `${page.slice(from, to)}\nreturn { mxDeadline, mxPlace, mxProject, MX_LEGEND, MX_QUADS };`)(roiNum);

const H = 3600000;
const D = 24 * H;
// Local time, so the day boundaries hold in any time zone.
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
const endOf = (y, m, d) => new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
const ask = (sansReponse) => ({ question: 'Pick one', options: [], defaut: null, sansReponse });
let seq = 0;
const tk = (o = {}) => ({ key: `ALV-${++seq}`, title: 'A made-up ticket', status: 'todo', assignee: 'user', kind: 'action', column: 'todo', labels: [], status_at: NOW - H, ...o });

test('deadline: a due: label wins over the ask block', () => {
  assert.equal(mxDeadline(tk({ labels: ['due:2026-10-20'], ask: ask('I go with B on 15/10') }), NOW), endOf(2026, 10, 20));
  assert.equal(mxDeadline(tk({ labels: ['due:2026-02-31'] }), NOW), null, 'a date that does not exist is ignored');
});

test('deadline: dates in the "Without an answer" line', () => {
  const d = (s, o = {}) => mxDeadline(tk({ ask: ask(s), ...o }), NOW);
  assert.equal(d('I go with B on 2026-10-16, reversible'), endOf(2026, 10, 16));
  assert.equal(d('je pars sur B le 15/10, réversible'), endOf(2026, 10, 15), 'day first');
  assert.equal(d('closed on 03.11.2026'), endOf(2026, 11, 3));
  assert.equal(d('closed on 3/11/26'), endOf(2026, 11, 3));
  assert.equal(d('I go with A today'), endOf(2026, 10, 14));
  assert.equal(d('je relance demain'), endOf(2026, 10, 15));
  assert.equal(d('in 48 h I pick B', { status_at: NOW - 10 * H }), NOW + 38 * H, 'relative to the last status change');
  assert.equal(d('sous 2 jours, je tranche', { status_at: NOW }), NOW + 2 * D);
  assert.equal(d('nothing happens'), null);
  assert.equal(d('within 2.5 days I decide'), null, 'a decimal is not a date');
  assert.equal(d('I deploy v1.2 then'), null, 'a version is not a date');
  assert.equal(d('on 2026-02-31, or 20/10'), endOf(2026, 10, 20), 'an impossible ISO date lets the next form try');
  assert.equal(mxDeadline(tk(), NOW), null, 'no block, no label');
});

test('deadline: a day/month without a year lands on the closest year', () => {
  const lateDec = new Date(2026, 11, 30, 12).getTime();
  assert.equal(mxDeadline(tk({ ask: ask('on 02/01') }), lateDec), endOf(2027, 1, 2));
  assert.equal(mxDeadline(tk({ ask: ask('on 31/02') }), NOW), null);
});

test('urgency: two days to the deadline, or three days waiting, is the line', () => {
  assert.equal(mxPlace(tk({ labels: ['due:2026-10-15'] }), NOW).urgent, true);
  assert.equal(mxPlace(tk({ labels: ['due:2026-10-30'] }), NOW).urgent, false);
  const past = mxPlace(tk({ labels: ['due:2026-10-10'] }), NOW);
  assert.equal(past.u, 1);
  assert.match(past.why.join(' '), /due \d+ d ago/);
  assert.equal(mxPlace(tk({ column: 'waiting', status_at: NOW - 3 * D }), NOW).urgent, true);
  assert.equal(mxPlace(tk({ column: 'waiting', status_at: NOW - 2 * D }), NOW).urgent, false);
  assert.equal(mxPlace(tk({ column: 'todo', status_at: NOW - 20 * D }), NOW).urgent, false, 'age counts on your lane only');
  assert.equal(mxPlace(tk({ labels: ['due:2026-10-14'], snoozed_until: NOW + D }), NOW).urgent, false, 'put off = not urgent');
});

test('importance: P0 and P1; what a ticket unblocks for the agents does not count (0.9.5)', () => {
  for (const [p, want] of [['P0', true], ['P1', true], ['P2', false], ['P3', false], [null, false]]) assert.equal(mxPlace(tk({ priority: p }), NOW).important, want, String(p));
  assert.equal(mxPlace(tk({ unlocks: 9 }), NOW).important, false, 'unblocking agents is not importance');
  assert.equal(mxPlace(tk({ roi: { score: 999, badge: 'unblocks the agents ~9 pts' } }), NOW).important, false, 'nor is the ⚡ score');
});

test('importance: an agent proposal counts as P2 at most until confirmed, unless there is a deadline', () => {
  const proposed = tk({ priority: 'P0', priority_proposed: true, priority_by_name: 'Kaa' });
  const p = mxPlace(proposed, NOW);
  assert.equal(p.important, false);
  assert.match(p.why.join(' '), /P0 proposed, counted P2/);
  assert.equal(mxPlace(tk({ priority: 'P0', priority_proposed: false }), NOW).important, true, 'confirmed');
  assert.equal(mxPlace(tk({ priority: 'P1', priority_proposed: true, labels: ['due:2026-10-30'] }), NOW).important, true, 'a real deadline lifts the cap');
  assert.equal(mxPlace(tk({ priority: 'P3', priority_proposed: true }), NOW).i, 0.15, 'a low proposal keeps its level');
});

test('importance: the priority you gave the project lends itself to its tickets', () => {
  const proj = { key: 'ALV-1', title: 'Health', priority: 'P0' };
  const bare = mxPlace(tk({ project_priority: proj }), NOW);
  assert.equal(bare.important, true);
  assert.match(bare.why.join(' '), /project P0/);
  assert.equal(mxPlace(tk({ priority: 'P3', project_priority: proj }), NOW).important, false, 'your own priority on the ticket wins');
  assert.equal(mxPlace(tk({ priority: 'P3', priority_proposed: true, project_priority: proj }), NOW).important, true, 'a proposal does not');
});

test('projection: mine by default, all open on demand, quadrants ordered', () => {
  const cols = {
    waiting: [
      tk({ key: 'W1', column: 'waiting', priority: 'P0', labels: ['due:2026-10-15'] }),
      tk({ key: 'W2', column: 'waiting', priority: 'P3', status_at: NOW - 4 * D }),
      tk({ key: 'W3', column: 'waiting', roi: { score: 90 }, unlocks: 4 }),
      tk({ key: 'W4', column: 'waiting', priority: 'P1', priority_proposed: true }),
    ],
    inProgress: [tk({ key: 'P1', status: 'in_progress', column: 'inProgress', assignee: 'claude', priority: 'P1' }), tk({ key: 'S1', kind: 'session', status: 'in_progress', column: 'inProgress', assignee: 'claude' })],
    todo: [tk({ key: 'T1', priority: 'P1' }), tk({ key: 'T2', assignee: 'claude' })],
  };
  const keys = (q) => q.map((p) => p.t.key);
  const mine = mxProject(cols, NOW);
  assert.equal(mine.total, 5);
  assert.deepEqual(keys(mine.quads.do), ['W1']);
  assert.deepEqual(keys(mine.quads.quick), ['W2']);
  assert.deepEqual(keys(mine.quads.plan), ['T1'], 'a P1 of yours; a top score is not important');
  assert.deepEqual(keys(mine.quads.later), ['W4', 'W3'], 'a proposed P1 counts as P2, still above no priority');
  const all = mxProject(cols, NOW, true);
  assert.equal(all.total, 7, 'session traces stay out');
  assert.ok(keys(all.quads.plan).includes('P1') && keys(all.quads.later).includes('T2'));
  assert.equal(mxProject({}, NOW).total, 0);
});

test('legend and quadrants say what the code does', () => {
  assert.match(MX_LEGEND, /within 2 days/);
  assert.match(MX_LEGEND, /3 days or more/);
  assert.match(MX_LEGEND, /P0 or P1/);
  assert.match(MX_LEGEND, /proposal counts as P2/);
  assert.match(MX_LEGEND, /unblocks for the agents does not count/);
  assert.deepEqual(MX_QUADS.map((q) => q.id), ['do', 'plan', 'quick', 'later']);
});

test('the page wires the view: button, container, shortcut, help', () => {
  assert.match(page, /\['matrix', 'Matrix'\]/);
  assert.match(page, /<div id="matrixView" hidden><\/div>/);
  assert.match(page, /m: 'matrix'/);
  assert.match(page, /keys: 'm', desc: 'Matrix view/);
  assert.match(page, /const VIEWS = \[[^\]]*'matrix'/);
});
