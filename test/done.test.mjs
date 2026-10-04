// 0.3.6: one-click done from the page, with Undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const TOKEN = 'x'.repeat(32);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

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
// The page sends no actor header: everything it does is "You".
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const post = async (base, path, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (base, path) => (await fetch(`${base}${path}`, { headers: auth })).json();

test('done: the ✓ sends status done, Undo puts the status back, the history keeps both, by You', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const t = (await post(base, '/api/tickets', { title: 'Add the STRIPE_KEY secret', status: 'waiting_on_user' })).body;
    assert.equal(t.column, 'waiting');

    const done = await post(base, `/api/tickets/${t.key}`, { status: 'done' });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
    assert.equal(done.body.column, 'done');
    assert.equal(done.body.children_open, 0);
    let board = await get(base, '/api/tickets/board');
    assert.deepEqual([board.counts.waiting, board.counts.done], [0, 1]);

    const back = await post(base, `/api/tickets/${t.key}`, { status: 'waiting_on_user' });
    assert.equal(back.body.status, 'waiting_on_user');
    assert.equal(back.body.closed_at, null);
    board = await get(base, '/api/tickets/board');
    assert.deepEqual([board.counts.waiting, board.counts.done], [1, 0]);

    const detail = await get(base, `/api/tickets/${t.key}`);
    const moves = detail.events.filter((e) => e.type === 'status' || e.type === 'reopened');
    assert.deepEqual(
      moves.map((e) => [e.type, e.from_status, e.to_status, e.actor]),
      [
        ['status', 'waiting_on_user', 'done', 'user'],
        ['reopened', 'done', 'waiting_on_user', 'user'],
      ],
    );
  });
});

test('done: a parent closes even with open sub-tickets, and says how many are still open', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const parent = (await post(base, '/api/tickets', { title: 'Ship 0.3.6', status: 'in_progress' })).body;
    const kids = [];
    for (const title of ['Tests', 'Screenshots', 'README']) kids.push((await post(base, '/api/tickets', { title, parent: parent.key })).body);
    await post(base, `/api/tickets/${kids[0].key}`, { status: 'done' });

    const before = await get(base, `/api/tickets/${parent.key}`);
    assert.deepEqual([before.children_count, before.children_open], [3, 2]);

    const done = await post(base, `/api/tickets/${parent.key}`, { status: 'done' });
    assert.equal(done.status, 200, 'no blocking on open sub-tickets');
    assert.equal(done.body.status, 'done');
    assert.equal(done.body.children_open, 2, 'the toast reads "2 sub-tickets still open" from here');
    // Sub-tickets are left as they were.
    for (const k of kids.slice(1)) assert.equal((await get(base, `/api/tickets/${k.key}`)).status, 'todo');
  });
});

test('done: a waiting ticket a hook opened (permission prompt) can be closed by hand', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const at = Date.now();
    const ev = (state, extra = {}, dt = 0) => ({ v: 1, session: { sessionId: 's1', repo: 'acme/app', branch: 'main', host: 'mac', surface: 'terminal' }, transition: { state, ...extra }, at: at + dt });
    await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: JSON.stringify(ev('working', { prompt: 'deploy' })) });
    await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: JSON.stringify(ev('waiting', { kind: 'permission', detail: 'Permission: Bash: npm run deploy' }, 1)) });
    const list = await get(base, '/api/tickets?status=waiting_on_user');
    const perm = list.tickets.find((x) => x.kind === 'permission');
    assert.ok(perm, 'the hook opened a waiting ticket');
    assert.equal(perm.source, 'hook');

    const done = await post(base, `/api/tickets/${perm.key}`, { status: 'done' });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
  });
});

test('page: a round ✓ on open cards, rows and the panel, a toast with Undo, the d shortcut', () => {
  assert.match(page, /class="doneBtn" data-done="\$\{esc\(t\.key\)\}" data-from="\$\{esc\(t\.status\)\}" aria-label="Mark \$\{esc\(t\.key\)\} as done"/, 'one button per open ticket, labelled');
  assert.match(page, /\$\{prio\(t\.priority\)\}<span class="key">\$\{esc\(t\.key\)\}<\/span>\$\{doneBtn\(t\)\}/, 'on board cards');
  assert.equal((page.match(/<span class="dn">\$\{doneBtn\(t\)\}<\/span>/g) || []).length, 2, 'on list rows and Next rows');
  assert.match(page, /class="pDone" data-done=/, 'in the detail panel header');
  assert.match(page, /const isOpen = \(t\) => t\.status !== 'done' && t\.status !== 'cancelled'/, 'closed tickets get no button');
  // One click: no confirm, and the click does not open the card underneath.
  assert.doesNotMatch(page, /confirm\(/);
  assert.match(page, /if \(el\.dataset\.done\) \{[\s\S]{0,160}e\.stopPropagation\(\);[\s\S]{0,40}return markDone\(el\.dataset\.done, el\.dataset\.from\)/);
  assert.ok(page.indexOf("closest('[data-done],") > 0, 'the ✓ wins over the card it sits in');
  // Undo for ~6 s, back to the status it had.
  assert.match(page, /ms: 6000, action: prev \? \{ label: 'Undo', run: \(\) => undoDone\(key, prev\) \}/);
  assert.match(page, /api\(`tickets\/\$\{encodeURIComponent\(key\)\}`, \{ status: prev \}\)/);
  assert.match(page, /sub-ticket\$\{n === 1 \? '' : 's'\} still open/);
  // Visible on hover with a mouse, always on touch; 32 px target; visible focus.
  assert.match(page, /\.doneBtn \{[^}]*width: 32px; height: 32px;[^}]*opacity: 0;/);
  assert.match(page, /@media \(hover: none\), \(pointer: coarse\) \{ \.doneBtn \{ opacity: 1; \}/);
  assert.match(page, /\.doneBtn:focus-visible \{ outline: 2px solid var\(--accent\)/);
  // Keyboard: d, never while typing.
  assert.match(page, /e\.key === 'd' \|\| e\.key === 'D'\) && !e\.ctrlKey && !e\.metaKey && !e\.altKey && !e\.target\.closest\?\.\('input, textarea, select, \[contenteditable\]'\)/);
  assert.match(page, /role', 'status'/, 'the toast is announced');
});
