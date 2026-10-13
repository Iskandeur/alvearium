// 0.5.12: lane scores. An installation's agent posts a score and a reason per ticket of the "Waiting on
// you" lane, plus one line for the whole lane; the board orders the lane by score and shows "⚡ ROI".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ROI_ITEMS, MAX_ROI_NOTE, ROI_TTL_MS, formatRoi, oneLine, roiFresh, sanitizeRoiInput } from '../lib/roi.mjs';
import { compareWaiting } from '../lib/triage.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp, mayPostRoi } from '../server/server.mjs';
import { Accounts } from '../lib/accounts.mjs';
import { renderTicketsText } from '../lib/core.mjs';

const MAIN = 'm'.repeat(32);
const AGENT = 'a'.repeat(32);
const OTHER = 'o'.repeat(32);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

// ---- the input ------------------------------------------------------------------------------------

test('sanitize: keys, scores from 0 up, one-line notes, the last score of a key wins, summary optional', () => {
  const { value } = sanitizeRoiInput({
    summary: '  3 jobs\nwait on you  ',
    scores: [
      { key: 'ALV-1', score: 12.345, note: 'unblocks 2 jobs\n(~1 pt)' },
      { key: 'ALV-2', score: 0 },
      { key: 'alv-1', score: 7 },
    ],
  });
  assert.equal(value.summary, '3 jobs wait on you');
  assert.deepEqual(value.scores, [
    { key: 'alv-1', score: 7, note: null },
    { key: 'ALV-2', score: 0, note: null },
  ]);
  assert.equal(sanitizeRoiInput({ scores: [{ key: 'A-1', score: 1.26 }] }).value.scores[0].score, 1.3);
  assert.equal(sanitizeRoiInput({}).value.summary, null);
  assert.deepEqual(sanitizeRoiInput({}).value.scores, []);
  assert.equal(sanitizeRoiInput({ summary: '   ' }).value.summary, null);
});

test('sanitize: refuses what is not a snapshot', () => {
  for (const bad of [null, [], 'x', { scores: 'ALV-1' }, { scores: [null] }, { scores: [{ key: 'no spaces here', score: 1 }] }, { scores: [{ key: 'A-1', score: -1 }] }, { scores: [{ key: 'A-1', score: 'high' }] }, { scores: [{ key: 'A-1', score: null }] }, { scores: [{ key: 'A-1', score: true }] }, { scores: [{ key: 'A-1', score: Infinity }] }, { scores: [{ key: 'A-1' }] }])
    assert.ok(sanitizeRoiInput(bad).error, JSON.stringify(bad));
  const many = Array.from({ length: MAX_ROI_ITEMS + 1 }, (_, i) => ({ key: `A-${i}`, score: 1 }));
  assert.match(sanitizeRoiInput({ scores: many }).error, /at most/);
});

test('oneLine: control and bidi characters dropped, cut with an ellipsis', () => {
  assert.equal(oneLine('a‮b\u0007c', 50), 'a b c');
  const long = oneLine('x'.repeat(500), MAX_ROI_NOTE);
  assert.equal(long.length, MAX_ROI_NOTE);
  assert.ok(long.endsWith('…'));
});

test('freshness and format', () => {
  assert.equal(roiFresh(1000, 1000 + ROI_TTL_MS), true);
  assert.equal(roiFresh(1000, 1001 + ROI_TTL_MS), false);
  assert.equal(roiFresh(null, 1000), false);
  assert.deepEqual([formatRoi(42.4), formatRoi(9.94), formatRoi(0.25), formatRoi('x')], ['42', '9.9', '0.3', '']);
});

test('lane order: scored first, highest first; then the 0.5.8 order among the others', () => {
  const lane = [
    { key: 'unscored-unblocks', unlocks: 3, priority: 'P0', status_at: 1 },
    { key: 'low', roi: { score: 2 }, unlocks: 0, priority: 'P3', status_at: 5 },
    { key: 'high', roi: { score: 40 }, unlocks: 0, priority: null, status_at: 9 },
    { key: 'unscored-p1', unlocks: 0, priority: 'P1', status_at: 2 },
    { key: 'zero', roi: { score: 0 }, unlocks: 5, priority: 'P0', status_at: 1 },
  ];
  assert.deepEqual(lane.sort(compareWaiting).map((t) => t.key), ['high', 'low', 'zero', 'unscored-unblocks', 'unscored-p1']);
});

// ---- the store ------------------------------------------------------------------------------------

async function laneStore(opts = {}) {
  let clock = 1_800_000_000_000;
  const store = await openStore(':memory:', { now: () => clock, jobActors: ['ops'], ...opts });
  const mk = (title, extra = {}) => store.createTicket({ title, assignee: 'user', status: 'waiting_on_user', kind: 'decision', ...extra }, { actor: 'ops' });
  return { store, mk, tick: (ms) => (clock += ms), now: () => clock };
}

test('store: a snapshot orders the lane, carries the reason, and the lane line comes with the board', async () => {
  const { store, mk } = await laneStore();
  const a = mk('Approve the deploy', { priority: 'P0' });
  const b = mk('Pick a name');
  const c = mk('Read the draft');
  const out = store.setRoi({ summary: '~6 pts of agent work wait on you', scores: [{ key: b.key, score: 30, note: 'unblocks 3 jobs (~6 pts)' }, { key: c.key, score: 4 }, { key: 'ALV-999', score: 99 }] }, { actor: 'ops/ticketmaster' });
  assert.deepEqual([out.scored, out.unknown], [2, ['ALV-999']]);
  const board = store.ticketBoard({});
  assert.deepEqual(board.columns.waiting.map((t) => t.title), ['Pick a name', 'Read the draft', 'Approve the deploy']);
  assert.deepEqual(board.columns.waiting[0].roi, { score: 30, note: 'unblocks 3 jobs (~6 pts)' });
  assert.equal(board.columns.waiting[2].roi, null);
  assert.equal(board.roi_summary.text, '~6 pts of agent work wait on you');
  assert.equal(board.roi_summary.actor, 'ops/ticketmaster');
  assert.deepEqual(store.getTicket(b.key).roi, { score: 30, note: 'unblocks 3 jobs (~6 pts)' });
  assert.equal(store.getTicket(a.key).roi, null);
  // No ticket history for a score: it is a view, not an edit.
  assert.equal(store.getTicket(b.key).events.filter((e) => e.type !== 'created').length, 0);
});

test('store: a new snapshot replaces the old one entirely; an empty one clears the lane line', async () => {
  const { store, mk } = await laneStore();
  const a = mk('one');
  const b = mk('two');
  store.setRoi({ summary: 'first', scores: [{ key: a.key, score: 10 }, { key: b.key, score: 5 }] });
  store.setRoi({ scores: [{ key: b.key, score: 1 }] });
  const lane = store.ticketBoard({}).columns.waiting;
  assert.deepEqual(lane.map((t) => [t.title, t.roi?.score ?? null]), [['two', 1], ['one', null]]);
  assert.equal(store.ticketBoard({}).roi_summary, null);
  assert.deepEqual(store.getRoi().scores.map((s) => s.key), [b.key]);
});

test('store: a stale snapshot neither orders the lane nor shows, but GET says it is stale', async () => {
  const { store, mk, tick } = await laneStore({ roiTtlMs: 60_000 });
  mk('first in 0.5.8 order', { priority: 'P0' });
  const b = mk('scored');
  store.setRoi({ summary: 'line', scores: [{ key: b.key, score: 50 }] });
  assert.equal(store.ticketBoard({}).columns.waiting[0].title, 'scored');
  tick(60_001);
  const board = store.ticketBoard({});
  assert.equal(board.columns.waiting[0].title, 'first in 0.5.8 order');
  assert.equal(board.columns.waiting[1].roi, null);
  assert.equal(board.roi_summary, null);
  assert.equal(store.getTicket(b.key).roi, null);
  const g = store.getRoi();
  assert.equal(g.stale, true);
  assert.equal(g.summary, 'line');
});

test('store: the score orders the lane in SQL, before the 200-card cap', async () => {
  const { store, mk } = await laneStore();
  let last;
  for (let i = 0; i < 205; i++) last = mk(`t${i}`, { priority: 'P0' });
  store.setRoi({ scores: [{ key: last.key, score: 3 }] });
  const lane = store.ticketBoard({}).columns.waiting;
  assert.equal(lane.length, 200);
  assert.equal(lane[0].key, last.key);
});

test('store: a change event goes out, so open pages redraw', async () => {
  const { store, mk } = await laneStore();
  const a = mk('x');
  const seen = [];
  store.onChange((c) => seen.push(c.type));
  store.setRoi({ scores: [{ key: a.key, score: 1 }] });
  assert.deepEqual(seen, ['roi']);
});

// ---- who may post ---------------------------------------------------------------------------------

test('mayPostRoi: the owner, or an agent BOARD_JOB_ACTORS names (sub-actors too); nobody else', () => {
  assert.equal(mayPostRoi({ kind: 'user', role: 'owner' }, []), true);
  assert.equal(mayPostRoi({ kind: 'agent', actor: 'ops', role: 'agent' }, ['ops']), true);
  assert.equal(mayPostRoi({ kind: 'agent', actor: 'ops/ticketmaster', role: 'agent' }, ['ops']), true);
  assert.equal(mayPostRoi({ kind: 'agent', actor: 'bot', role: 'agent' }, ['ops']), false);
  assert.equal(mayPostRoi({ kind: 'agent', actor: 'ops', role: 'agent' }, []), false);
  for (const role of ['admin', 'member', 'viewer']) assert.equal(mayPostRoi({ kind: 'member', role }, ['ops']), false, role);
  assert.equal(mayPostRoi(null, ['ops']), false);
});

async function withApp(fn) {
  const store = await openStore(':memory:', { jobActors: ['ops'] });
  const accounts = new Accounts(store);
  const admin = accounts.createMember({ name: 'Ada', role: 'admin' }, 'user');
  const adminTok = accounts.issueToken(admin.id).token;
  const server = createServer(createApp({ token: MAIN, agents: [{ actor: 'ops', token: AGENT }, { actor: 'bot', token: OTHER }], store, accounts, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (tok, method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn({ store, call, adminTok });
  } finally {
    server.close();
  }
}

test('api: PUT /api/roi by the named agent, GET by anyone who reads; others get 403, bad bodies 400', async () => {
  await withApp(async ({ store, call, adminTok }) => {
    const t = store.createTicket({ title: 'Merge?', assignee: 'user', status: 'waiting_on_user', kind: 'decision' }, { actor: 'ops' });
    const body = { summary: 'Bottleneck: ~4 pts', scores: [{ key: t.key, score: 12, note: 'unblocks 1 job' }] };
    assert.equal((await call(null, 'PUT', '/api/roi', body)).status, 401);
    assert.equal((await call(OTHER, 'PUT', '/api/roi', body)).status, 403, 'an agent the deployment does not name');
    assert.equal((await call(adminTok, 'PUT', '/api/roi', body)).status, 403, 'an admin member');
    assert.equal((await call(AGENT, 'PUT', '/api/roi', { scores: [{ key: t.key, score: -3 }] })).status, 400);
    assert.equal((await call(AGENT, 'POST', '/api/roi', body)).status, 405);
    const ok = await call(AGENT, 'PUT', '/api/roi', body);
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.scored, ok.body.unknown], [1, []]);
    const g = await call(OTHER, 'GET', '/api/roi');
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.scores, [{ key: t.key, score: 12, note: 'unblocks 1 job' }]);
    assert.equal(g.body.actor, 'ops');
    const board = await call(MAIN, 'GET', '/api/tickets/board');
    assert.equal(board.body.roi_summary.text, 'Bottleneck: ~4 pts');
    assert.equal(board.body.columns.waiting[0].roi.score, 12);
    // The owner may post (and clear) too.
    assert.equal((await call(MAIN, 'PUT', '/api/roi', { scores: [] })).status, 200);
    assert.equal((await call(MAIN, 'GET', '/api/tickets/board')).body.roi_summary, null);
  });
});

// ---- the page -------------------------------------------------------------------------------------

test('page: the badge, the lane line and the ticket line are drawn, escaped, from the API fields', () => {
  assert.match(page, /id="roi-waiting"/);
  assert.match(page, /class="tag roi" title="\$\{esc\(t\.roi\.note/);
  assert.match(page, /setHtml\(rn, rs \? `<b>⚡<\/b>\$\{esc\(rs\.text\)\}`/);
  assert.match(page, /\$\{roiLine\(t\)\}/);
  assert.match(page, /--roi:/);
});

test('text board (/board): the lane line on top, the score and its reason under the card', async () => {
  const { store, mk } = await laneStore();
  const a = mk('Approve it');
  store.setRoi({ summary: '~2 pts wait on you', scores: [{ key: a.key, score: 12, note: 'unblocks 1 job' }] });
  const text = renderTicketsText(store.ticketBoard({}));
  assert.match(text, /^⚡ ~2 pts wait on you\nWAITING ON YOU \(1\)/);
  assert.match(text, /⚡ ROI 12 · unblocks 1 job/);
});
