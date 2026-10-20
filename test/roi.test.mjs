// 0.5.12: lane scores. An installation's agent posts a score and a reason per ticket of the "Waiting on
// you" lane, plus one line for the whole lane; the board shows "⚡" with the reason. 0.9.5: the score no
// longer orders the lane (what a ticket is worth to the agents is not what it is worth to the owner), and
// an optional badge replaces the bare number on the card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ROI_BADGE, MAX_ROI_ITEMS, MAX_ROI_NOTE, ROI_TTL_MS, formatRoi, oneLine, roiFresh, sanitizeRoiInput } from '../lib/roi.mjs';
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
      { key: 'ALV-2', score: 0, badge: 'unblocks the agents\n~2 pts, and a very long tail after that' },
      { key: 'alv-1', score: 7 },
    ],
  });
  assert.equal(value.summary, '3 jobs wait on you');
  assert.ok(value.scores[1].badge.length <= MAX_ROI_BADGE && value.scores[1].badge.endsWith('…'));
  assert.ok(value.scores[1].badge.startsWith('unblocks the agents ~2 pts'));
  assert.deepEqual(value.scores.map((x) => [x.key, x.score, x.note]), [
    ['alv-1', 7, null],
    ['ALV-2', 0, null],
  ]);
  assert.equal(value.scores[0].badge, null);
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

test('format: never a bare 0; "<0.1" under 0.05, a decimal point, the integer from 10 up', () => {
  assert.deepEqual([0, 0.04, 0.049, 0.05, 0.1, 9.96, 10, 1_000_000].map(formatRoi), ['<0.1', '<0.1', '<0.1', '0.1', '0.1', '10', '10', '1000000']);
  for (const n of [0, 0.04, 0.3, 2.5, 12]) assert.doesNotMatch(formatRoi(n), /,|^0$|ROI/, String(n));
});

test('lane order (0.9.5): the score orders nothing; priority, then the oldest wait', () => {
  const lane = [
    { key: 'unscored-unblocks', unlocks: 3, priority: 'P0', status_at: 2 },
    { key: 'low', roi: { score: 2 }, unlocks: 0, priority: 'P3', status_at: 5 },
    { key: 'high', roi: { score: 40 }, unlocks: 0, priority: null, status_at: 9 },
    { key: 'unscored-p1', unlocks: 0, priority: 'P1', status_at: 2 },
    { key: 'zero', roi: { score: 0 }, unlocks: 5, priority: 'P0', status_at: 1 },
  ];
  assert.deepEqual(lane.sort(compareWaiting).map((t) => t.key), ['zero', 'unscored-unblocks', 'unscored-p1', 'low', 'high']);
});

// ---- the store ------------------------------------------------------------------------------------

async function laneStore(opts = {}) {
  let clock = 1_800_000_000_000;
  const store = await openStore(':memory:', { now: () => clock, jobActors: ['ops'], ...opts });
  const mk = (title, extra = {}) => store.createTicket({ title, assignee: 'user', status: 'waiting_on_user', kind: 'decision', ...extra }, { actor: 'ops' });
  return { store, mk, tick: (ms) => (clock += ms), now: () => clock };
}

test('store: a snapshot rides on the cards without ordering the lane; the lane line comes with the board', async () => {
  const { store, mk } = await laneStore();
  const a = mk('Approve the deploy', { priority: 'P3' });
  const b = mk('Pick a name');
  const c = mk('Read the draft');
  const out = store.setRoi({ summary: '~6 pts of agent work wait on you', scores: [{ key: b.key, score: 30, note: 'unblocks 3 jobs (~6 pts)', badge: 'unblocks the agents ~6 pts' }, { key: c.key, score: 4 }, { key: 'ALV-999', score: 99 }] }, { actor: 'ops/scorer' });
  assert.deepEqual([out.scored, out.unknown], [2, ['ALV-999']]);
  const board = store.ticketBoard({});
  assert.deepEqual(board.columns.waiting.map((t) => t.title), ['Approve the deploy', 'Pick a name', 'Read the draft']);
  assert.deepEqual(board.columns.waiting[1].roi, { score: 30, note: 'unblocks 3 jobs (~6 pts)', badge: 'unblocks the agents ~6 pts' });
  assert.equal(board.columns.waiting[0].roi, null);
  assert.equal(board.roi_summary.text, '~6 pts of agent work wait on you');
  assert.equal(board.roi_summary.actor, 'ops/scorer');
  assert.deepEqual(store.getTicket(b.key).roi, { score: 30, note: 'unblocks 3 jobs (~6 pts)', badge: 'unblocks the agents ~6 pts' });
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
  assert.deepEqual(lane.map((t) => [t.title, t.roi?.score ?? null]), [['one', null], ['two', 1]]);
  assert.equal(store.ticketBoard({}).roi_summary, null);
  assert.deepEqual(store.getRoi().scores.map((s) => s.key), [b.key]);
});

test('store: a stale snapshot does not show, but GET says it is stale', async () => {
  const { store, mk, tick } = await laneStore({ roiTtlMs: 60_000 });
  mk('first by priority', { priority: 'P0' });
  const b = mk('scored');
  store.setRoi({ summary: 'line', scores: [{ key: b.key, score: 50 }] });
  assert.equal(store.ticketBoard({}).columns.waiting[0].title, 'first by priority');
  assert.equal(store.ticketBoard({}).columns.waiting[1].roi.score, 50);
  tick(60_001);
  const board = store.ticketBoard({});
  assert.equal(board.columns.waiting[0].title, 'first by priority');
  assert.equal(board.columns.waiting[1].roi, null);
  assert.equal(board.roi_summary, null);
  assert.equal(store.getTicket(b.key).roi, null);
  const g = store.getRoi();
  assert.equal(g.stale, true);
  assert.equal(g.summary, 'line');
});

test('store: the board says when the snapshot was posted, and that it is stale rather than nothing', async () => {
  const { store, mk, tick, now } = await laneStore({ roiTtlMs: 60_000 });
  const a = mk('scored');
  assert.equal(store.ticketBoard({}).roi_snapshot, null, 'nothing posted yet');
  const at = now();
  store.setRoi({ summary: 'line', scores: [{ key: a.key, score: 3 }] }, { actor: 'ops/scorer' });
  assert.deepEqual(store.ticketBoard({}).roi_snapshot, { at, actor: 'ops/scorer', scores: 1, summary: true, stale: false });
  tick(60_001);
  const board = store.ticketBoard({});
  assert.equal(board.columns.waiting[0].roi, null, 'the stale score still does not show');
  assert.deepEqual(board.roi_snapshot, { at, actor: 'ops/scorer', scores: 1, summary: true, stale: true });
  // Scores without a lane line: the time is known, the poster is not (it is kept with the line).
  store.setRoi({ scores: [{ key: a.key, score: 3 }] });
  assert.deepEqual(store.ticketBoard({}).roi_snapshot, { at: now(), actor: null, scores: 1, summary: false, stale: false });
  store.setRoi({ scores: [] });
  assert.equal(store.ticketBoard({}).roi_snapshot, null, 'an empty snapshot clears it');
});

test('store: a score does not lift a ticket over the 200-card cap; priority does', async () => {
  const { store, mk } = await laneStore();
  let last;
  for (let i = 0; i < 205; i++) last = mk(`t${i}`, { priority: 'P2' });
  store.setRoi({ scores: [{ key: last.key, score: 300 }] });
  let lane = store.ticketBoard({}).columns.waiting;
  assert.equal(lane.length, 200);
  assert.ok(!lane.some((t) => t.key === last.key));
  store.updateTicket(last.key, { priority: 'P1' }, { actor: 'user' });
  lane = store.ticketBoard({}).columns.waiting;
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
  assert.equal(mayPostRoi({ kind: 'agent', actor: 'ops/scorer', role: 'agent' }, ['ops']), true);
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
    const body = { summary: 'Bottleneck: ~4 pts', scores: [{ key: t.key, score: 12, note: 'unblocks 1 job', badge: 'unblocks ~4 pts' }] };
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
    assert.deepEqual(g.body.scores, [{ key: t.key, score: 12, note: 'unblocks 1 job', badge: 'unblocks ~4 pts' }]);
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
  // The card's badge is a button (a tap shows the reason), its reason box follows the tags.
  assert.match(page, /if \(t\.column === 'waiting' && t\.roi\) out\.push\(roiBadge\(t\)\)/);
  assert.match(page, /<div class="tags">\$\{tags\(t, now\)\}<\/div>\$\{roiTap\(t\)\}/);
  assert.match(page, /if \(act === 'roiNote'\) \{/);
  // 0.9.5: the badge when the installation sent one, and the title says it orders nothing.
  assert.match(page, /function roiText\(t\) \{ return t\.roi\?\.badge \|\|/);
  assert.match(page, /it does not order your lane/);
  assert.match(page, /const rh = roiHead\(b\.roi_summary, b\.roi_snapshot,/);
  assert.match(page, /\$\{roiLine\(t\)\}/);
  assert.match(page, /--roi:/);
});

// The helpers run as shipped: lifted out of server/page.html, with the page's own esc and freshness.
function pageRoi() {
  const cut = (a, b) => {
    const from = page.indexOf(a);
    const to = page.indexOf(b, from);
    assert.ok(from > 0 && to > from, `${a} found in page.html`);
    return page.slice(from, to);
  };
  const src = [page.match(/^\s*const esc = .*$/m)[0], cut('function freshness(', '// ---- end freshness'), cut('// ---- roi helpers', '// ---- end of roi helpers ----'), cut('function ago(ms, now)', 'const when = (ms)')].join('\n');
  return new Function('isOpen', `${src}\nreturn { roiNum, roiText, roiTitle, roiBadge, roiTap, roiHead, roiOpen, agoPhrase, ROI_DEFINITION };`)((t) => t.status !== 'done' && t.status !== 'cancelled');
}

test('page: the badge is the badge as sent, else the bare score; never "ROI", never a bare 0', () => {
  const { roiNum, roiText, roiBadge } = pageRoi();
  assert.deepEqual([0, 0.04, 0.05, 0.25, 2.5, 9.96, 12.4].map(roiNum), [0, 0.04, 0.05, 0.25, 2.5, 9.96, 12.4].map(formatRoi), 'the same rule as lib/roi.mjs');
  const card = (roi) => ({ key: 'ALV-7', column: 'waiting', status: 'waiting_on_user', roi });
  assert.equal(roiText(card({ score: 12.4 })), '12');
  assert.equal(roiText(card({ score: 0.03 })), '<0.1');
  assert.equal(roiText(card({ score: 0 })), '<0.1');
  assert.equal(roiText(card({ score: 2.5, badge: 'unblocks the agents ~0.1 pt' })), 'unblocks the agents ~0.1 pt', 'a badge shows as sent');
  const html = roiBadge(card({ score: 0.03, note: 'unblocks <1 job' }));
  assert.match(html, /^<button type="button" class="tag roi" data-act="roiNote" data-key="ALV-7" aria-expanded="false"/);
  assert.match(html, />⚡ &lt;0\.1<\/button>$/);
  assert.doesNotMatch(html, /ROI \d|⚡ 0</);
  assert.match(html, /unblocks &lt;1 job/, 'the reason is escaped');
});

test('page: the tooltip says what pt is, in the README\'s words; a tap opens the reason', () => {
  const { roiTitle, roiTap, roiOpen, ROI_DEFINITION } = pageRoi();
  assert.match(ROI_DEFINITION, /installation posted, in its own points \(pt\)/);
  assert.match(ROI_DEFINITION, /The board never computes it/);
  assert.match(roiTitle({ roi: { score: 1, note: 'unblocks 1 job' } }), /^unblocks 1 job\. ⚡ is a score/);
  const t = { key: 'ALV-7', column: 'waiting', status: 'waiting_on_user', roi: { score: 1, note: 'unblocks 1 job' } };
  assert.match(roiTap(t), /^<div class="roiTap" id="roiTap-ALV-7" hidden>unblocks 1 job<small>/);
  roiOpen.add('ALV-7');
  assert.match(roiTap(t), /^<div class="roiTap" id="roiTap-ALV-7">/, 'stays open across redraws');
  assert.equal(roiTap({ ...t, column: 'todo' }), '', 'only on the lane');
  assert.equal(roiTap({ ...t, roi: null }), '');
});

test('page: the lane head says when the scores were posted, and says they are out of date', () => {
  const { roiHead } = pageRoi();
  const NOW = 1_800_000_000_000;
  const rs = { text: '~2 pts wait on you', at: NOW - 12 * 60_000, actor: 'ops' };
  const fresh = roiHead(rs, { at: rs.at, actor: 'ops', scores: 3, summary: true, stale: false }, true, NOW);
  assert.equal(fresh.stale, false);
  assert.match(fresh.html, /^<b>⚡<\/b>~2 pts wait on you<span class="roiWhen" id="roi-when" data-at="\d+">updated 12 min ago<\/span>$/);
  assert.match(fresh.title, /^Posted by ops, /);
  const now = roiHead({ ...rs, at: NOW - 20_000 }, { at: NOW - 20_000, scores: 1, summary: true, stale: false }, true, NOW);
  assert.match(now.html, /updated just now/);
  assert.doesNotMatch(now.html, /now ago/);
  // Scores without a lane line still say when they were posted.
  assert.match(roiHead(null, { at: NOW - 2 * 3600_000, actor: null, scores: 2, summary: false, stale: false }, true, NOW).html, /updated 2 h ago/);
  // Past 6 h the scores are gone from the cards, and the lane says so instead of nothing.
  const stale = roiHead(null, { at: NOW - 7 * 3600_000, actor: 'ops', scores: 3, summary: true, stale: true }, false, NOW);
  assert.equal(stale.stale, true);
  assert.equal(stale.html, '<b>⚡</b>Scores out of date: last posted 7 h ago. They come back when the installation posts again.');
  assert.match(stale.title, /^Last posted by ops, /);
  assert.equal(roiHead(null, null, false, NOW), null, 'nothing posted, nothing shown');
  assert.equal(roiHead(null, { at: NOW - 60_000, scores: 0, summary: false, stale: false }, false, NOW), null, 'an empty snapshot');
  // An older server sends no roi_snapshot: the lane line's own time.
  assert.match(roiHead(rs, undefined, false, NOW).html, /updated 12 min ago/);
});

test('page: "ago" in a sentence never reads "now ago"', () => {
  const { agoPhrase } = pageRoi();
  const NOW = 1_800_000_000_000;
  assert.equal(agoPhrase(NOW - 10_000, NOW), 'just now');
  assert.equal(agoPhrase(NOW - 5 * 60_000, NOW), '5m ago');
  assert.equal(agoPhrase(NOW - 3 * 86400_000, NOW), '3d ago');
  assert.match(agoPhrase(NOW - 90 * 86400_000, NOW), /^on \S/);
});

test('text board (/board): the lane line on top, the score and its reason under the card', async () => {
  const { store, mk } = await laneStore();
  const a = mk('Approve it');
  store.setRoi({ summary: '~2 pts wait on you', scores: [{ key: a.key, score: 12, note: 'unblocks 1 job' }] });
  const text = renderTicketsText(store.ticketBoard({}));
  assert.match(text, /^⚡ ~2 pts wait on you\nWAITING ON YOU \(1\)/);
  assert.match(text, /⚡ 12 · unblocks 1 job/);
  store.setRoi({ scores: [{ key: a.key, score: 0.04, note: 'unblocks a little' }] });
  assert.match(renderTicketsText(store.ticketBoard({})), /⚡ <0\.1 · unblocks a little/, 'never a bare 0');
  store.setRoi({ scores: [{ key: a.key, score: 12, note: 'unblocks 1 job', badge: 'unblocks the agents ~2 pts' }] });
  assert.match(renderTicketsText(store.ticketBoard({})), /⚡ unblocks the agents ~2 pts · unblocks 1 job/);
});
