// 0.9.14: a comment posted once is stored once. The same comment by the same actor on the same ticket
// within a few seconds (a double click, Enter pressed twice, a client that replays its request) answers
// like the first post and adds nothing; the page sends one comment at a time. Made-up tickets only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMENT_REPEAT_MS, openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const T0 = Date.UTC(2026, 9, 1);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const comments = (t) => t.events.filter((e) => e.type === 'comment').map((e) => `${e.actor}: ${e.text}`);

async function board() {
  const clock = { t: T0 };
  const store = await openStore(':memory:', { now: () => clock.t, jobActors: [] });
  const tk = store.createTicket({ title: 'A made-up ticket', assignee: 'claude' }, { actor: 'user' });
  return { store, clock, tk };
}

test('store: the same comment six times within the window is stored once', async () => {
  const { store, clock, tk } = await board();
  assert.equal(COMMENT_REPEAT_MS, 10_000);
  const first = store.comment(tk.key, 'Looks good to me', { actor: 'claude' });
  assert.equal(first.duplicate, undefined);
  for (let i = 0; i < 5; i++) {
    clock.t += 1500;
    const again = store.comment(tk.key, i % 2 ? '  Looks good to me\n' : 'Looks good to me', { actor: 'claude' });
    assert.equal(again.duplicate, true, 'flagged for the server');
    assert.ok(!('duplicate' in JSON.parse(JSON.stringify(again))), 'not in the JSON');
    assert.equal(again.key, tk.key);
    assert.equal(again.comments_count, 1);
  }
  assert.deepEqual(comments(store.getTicket(tk.key)), ['claude: Looks good to me']);
});

test('store: another actor, another text, another ticket, or past the window is a new comment', async () => {
  const { store, clock, tk } = await board();
  const other = store.createTicket({ title: 'Another' }, { actor: 'user' });
  store.comment(tk.key, 'ok', { actor: 'claude' });
  store.comment(tk.key, 'ok', { actor: 'user' });
  store.comment(tk.key, 'ok!', { actor: 'claude' });
  store.comment(other.key, 'ok', { actor: 'claude' });
  clock.t += COMMENT_REPEAT_MS + 1;
  store.comment(tk.key, 'ok', { actor: 'claude' });
  assert.deepEqual(comments(store.getTicket(tk.key)), ['claude: ok', 'user: ok', 'claude: ok!', 'claude: ok']);
  assert.deepEqual(comments(store.getTicket(other.key)), ['claude: ok']);
  assert.throws(() => store.comment(tk.key, '   ', { actor: 'claude' }), /empty comment/, 'an empty comment is still refused');
});

test('store: an update that carries the same comment again applies its fields but not a second comment', async () => {
  const { store, clock, tk } = await board();
  store.updateTicket(tk.key, { status: 'in_progress', comment: 'Starting now' }, { actor: 'claude' });
  clock.t += 2000;
  const t = store.updateTicket(tk.key, { priority: 'P1', comment: 'Starting now' }, { actor: 'claude' });
  assert.equal(t.priority, 'P1');
  clock.t += 2000;
  store.comment(tk.key, 'Starting now', { actor: 'claude' });
  assert.deepEqual(comments(store.getTicket(tk.key)), ['claude: Starting now']);
});

test('server: POST …/comments answers 201 the first time, 200 with the same payload on a replay, stores one', async () => {
  const { store, tk } = await board();
  const token = 'c'.repeat(32);
  const server = createServer(createApp({ token, store, page: '<html></html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/tickets/${tk.key}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const post = () => fetch(`${url}/comments`, { method: 'POST', headers, body: JSON.stringify({ text: 'Posted once' }) });
    const a = await post();
    assert.equal(a.status, 201);
    const first = await a.json();
    const rest = await Promise.all([post(), post(), post(), post(), post()]);
    for (const r of rest) {
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.deepEqual(Object.keys(body).sort(), Object.keys(first).sort(), 'same payload shape');
      assert.equal(body.key, first.key);
      assert.equal(body.comments_count, 1);
    }
    const t = await (await fetch(url, { headers })).json();
    assert.deepEqual(comments(t), ['user: Posted once']);
    // The update route with a comment: same rule.
    await fetch(url, { method: 'POST', headers, body: JSON.stringify({ comment: 'Posted once' }) });
    assert.equal(comments(await (await fetch(url, { headers })).json()).length, 1);
  } finally {
    server.closeAllConnections?.();
    server.close();
    store.close();
  }
});

test('page: the Send button is disabled while its post is in flight, Enter and Ctrl+Enter do nothing meanwhile', () => {
  const a = page.indexOf("if (act === 'comment' && t) {");
  const b = page.indexOf('document.addEventListener(\'change\'', a);
  assert.ok(a > 0 && b > a);
  const h = page.slice(a, b);
  assert.match(h, /^if \(act === 'comment' && t\) \{\n[^\n]*\n\s*if \(commentSending\) return;/, 'the guard comes first');
  assert.ok(h.indexOf('commentSending = true;') < h.indexOf('await api('), 'set before the request');
  assert.ok(h.indexOf('el.disabled = true;') < h.indexOf('await api('), 'button disabled before the request');
  assert.match(h, /finally \{\n\s*commentSending = false;\n\s*el\.disabled = false;\n\s*\}/, 're-enabled on success and on error');
  assert.match(page, /let commentSending = false;/);
  // Enter / Ctrl+Enter click the same button: a disabled button ignores click(), and the guard covers the rest.
  assert.match(page, /if \(a === 'sendComment'\) return document\.querySelector\('\[data-act="comment"\]'\)\?\.click\(\);/);
});

test('page: the fetch helper never replays a request (one fetch per call, no retry loop)', () => {
  const a = page.indexOf('async function apiCall(');
  const b = page.indexOf('// ---- state:', a);
  const body = page.slice(a, b);
  assert.equal((body.match(/fetch\(/g) || []).length, 1);
  assert.doesNotMatch(body, /retry|for \(|while \(/i);
});
