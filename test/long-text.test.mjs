// 0.5.10: a long comment or body is kept whole up to 64 000 characters, and refused (413, with a
// message) above, never cut. Until 0.5.9 a comment lost everything past 4 000 characters and a body
// past 8 000, without a word: the end of a pasted job offer, the end of a long reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_BODY_CHARS, MAX_COMMENT_CHARS, MAX_TEXT_CHARS, groupDigits, parseFilters, sanitizeTicketInput, textTooLong } from '../lib/core.mjs';
import { commentText, openStore } from '../lib/store.mjs';
import { EventEmitter } from 'node:events';
import { DRAIN_AFTER_LIMIT, MAX_TICKET_REQUEST, bodyStats, createApp, readRaw } from '../server/server.mjs';
import { clean } from '../lib/triage.mjs';
import { callTool, feedbackAssignee } from '../mcp/server.mjs';

const TOKEN = 'y'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function withServer(store, fn) {
  const server = createServer(createApp({ token: TOKEN, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** A text of exactly n characters whose last words are recognisable. */
const textOf = (n, end = ' THE END') => 'a'.repeat(n - end.length) + end;

test('long text: the limit is 64 000 characters for comments and bodies, and the message says what to do', () => {
  assert.equal(MAX_TEXT_CHARS, 64000);
  assert.equal(MAX_COMMENT_CHARS, MAX_TEXT_CHARS);
  assert.equal(MAX_BODY_CHARS, MAX_TEXT_CHARS);
  assert.equal(groupDigits(70123), '70 123');
  assert.equal(groupDigits(999), '999');
  assert.equal(textTooLong('x'.repeat(64000), 64000, 'comment'), null);
  const msg = textTooLong('x'.repeat(70123), 64000, 'comment');
  assert.match(msg, /^comment too long: 70 123 characters, the limit is 64 000\. Nothing was saved/);
  assert.match(msg, /split it into several comments/);
});

test('long text: a comment is kept whole up to the limit, refused above, and trimmed before counting', async () => {
  const s = await openStore(':memory:');
  const t = s.createTicket({ title: 'Read the offer' });
  // The 0.5.9 bug: 5 190 characters became 4 000.
  const offer = textOf(5190);
  s.comment(t.key, offer);
  const full = textOf(MAX_COMMENT_CHARS);
  s.comment(t.key, `  \n${full}\n  `); // surrounding blanks do not count
  const events = s.getTicket(t.key).events.filter((e) => e.type === 'comment');
  assert.deepEqual(events.map((e) => e.text.length), [5190, MAX_COMMENT_CHARS]);
  assert.ok(events[0].text.endsWith('THE END') && events[1].text.endsWith('THE END'), 'the end is there');

  const over = textOf(MAX_COMMENT_CHARS + 1);
  assert.throws(() => s.comment(t.key, over), (e) => e.status === 413 && /comment too long: 64 001 characters, the limit is 64 000/.test(e.message));
  assert.equal(s.getTicket(t.key).comments_count, 2, 'nothing saved');
  assert.throws(() => s.comment(t.key, '   '), (e) => e.status === 400 && /empty comment/.test(e.message));
  assert.equal(commentText('  ok  '), 'ok');
  s.close();
});

test('long text: an update carrying a comment that is too long changes nothing at all', async () => {
  const s = await openStore(':memory:');
  const t = s.createTicket({ title: 'Ship it', status: 'todo' });
  assert.throws(() => s.updateTicket(t.key, { status: 'done', comment: textOf(MAX_COMMENT_CHARS + 10) }), (e) => e.status === 413 && /comment too long/.test(e.message));
  const after = s.getTicket(t.key);
  assert.equal(after.status, 'todo', 'the status did not move');
  assert.equal(after.comments_count, 0);
  // A whitespace-only comment riding along is still ignored, as before.
  assert.equal(s.updateTicket(t.key, { status: 'in_progress', comment: '  ' }).status, 'in_progress');
  s.close();
});

test('long text: a body is kept whole up to the limit and refused above, on create and on update', async () => {
  const s = await openStore(':memory:');
  const body = textOf(MAX_BODY_CHARS);
  const t = s.createTicket({ title: 'Long body', body });
  assert.equal(s.getTicket(t.key).body, body, 'until 0.5.9 only the first 8 000 characters stayed');
  assert.throws(() => s.createTicket({ title: 'Too long', body: textOf(MAX_BODY_CHARS + 1) }), (e) => e.status === 413 && /body too long: 64 001/.test(e.message));
  assert.throws(() => s.updateTicket(t.key, { body: textOf(MAX_BODY_CHARS + 1) }), (e) => e.status === 413);
  assert.equal(s.getTicket(t.key).body, body, 'unchanged');
  const v = sanitizeTicketInput({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }, { partial: true });
  assert.equal(v.status, 413);
  // Titles are one line: still shortened to 200 characters, visibly (an ellipsis), as before.
  assert.equal(sanitizeTicketInput({ title: 't'.repeat(300) }).value.title.length, 200);
  assert.ok(sanitizeTicketInput({ title: 't'.repeat(300) }).value.title.endsWith('…'));
  s.close();
});

test('long text: an import never cuts in silence (a cut, if ever needed, says so in the text)', async () => {
  const s = await openStore(':memory:');
  const r = s.importTickets({
    board: 'board-123456',
    machine: 'laptop',
    tickets: [{ id: 't_0000000000000001', title: 'Imported', body: 'b'.repeat(MAX_BODY_CHARS + 5), events: [{ type: 'comment', at: 1, actor: 'user', text: textOf(20000) }, { type: 'comment', at: 2, actor: 'user', text: 'c'.repeat(MAX_COMMENT_CHARS + 7) }] }],
  });
  assert.equal(r.imported, 1);
  const t = s.getTicket(r.results[0].key);
  assert.match(t.body, /\[cut at import: 5 more characters were not kept\]$/);
  const comments = t.events.filter((e) => e.type === 'comment');
  assert.ok(comments[0].text.endsWith('THE END'), 'a 20 000-character comment arrives whole (0.5.9 kept 4 000)');
  assert.match(comments[1].text, /\[cut at import: 7 more characters were not kept\]$/);
  s.close();
});

test('long text over HTTP: 64 000 accented characters go through, one more is a 413 with the message', async () => {
  // 64 000 "é" are 128 000 bytes of UTF-8: above the old 64 KiB request limit, which answered a bare "too large".
  assert.ok(MAX_TICKET_REQUEST >= 2 * MAX_TEXT_CHARS * 6, 'a body and a comment fit in one update even at 6 JSON bytes a character');
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const created = await (await post('/api/tickets', { title: 'Offer', body: 'é'.repeat(MAX_BODY_CHARS) })).json();
    assert.equal(created.body.length, MAX_BODY_CHARS);
    const ok = await post(`/api/tickets/${created.key}/comments`, { text: 'é'.repeat(MAX_COMMENT_CHARS) });
    assert.equal(ok.status, 201);
    const tooLong = await post(`/api/tickets/${created.key}/comments`, { text: 'é'.repeat(MAX_COMMENT_CHARS + 1) });
    assert.equal(tooLong.status, 413);
    assert.match((await tooLong.json()).error, /^comment too long: 64 001 characters, the limit is 64 000\. Nothing was saved/);
    const upd = await post(`/api/tickets/${created.key}`, { status: 'done', comment: 'x'.repeat(MAX_COMMENT_CHARS + 1) });
    assert.equal(upd.status, 413);
    const t = await (await fetch(`${base}/api/tickets/${created.key}`, { headers: auth })).json();
    assert.equal(t.status, 'todo');
    assert.equal(t.events.filter((e) => e.type === 'comment')[0].text.length, MAX_COMMENT_CHARS);
    // Other routes keep the small limit, and say it.
    const big = await post('/api/event', { pad: 'z'.repeat(70 * 1024) });
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /request too large \(max 64 KiB\)/);
  });
  store.close();
});

test('long text in MCP tools: refused before sending, with the tool name; the tools say the limit', async () => {
  const calls = [];
  const backend = {
    comment: async (key, text) => (calls.push(['comment', text.length]), { key, comments_count: 1 }),
    update: async (key, body) => (calls.push(['update', body]), { key, title: 't', status: 'todo' }),
    create: async (body) => (calls.push(['create', body]), { key: 'ALV-1', title: body.title, status: 'todo' }),
  };
  const context = { machine: 'm', origin: 'terminal' };
  await assert.rejects(callTool('ticket_comment', { key: 'ALV-1', text: textOf(MAX_COMMENT_CHARS + 1) }, { backend, context }), /^Error: ticket_comment: comment too long: 64 001 characters/);
  await assert.rejects(callTool('ticket_update', { key: 'ALV-1', comment: textOf(MAX_COMMENT_CHARS + 1) }, { backend, context }), /ticket_update: comment too long/);
  await assert.rejects(callTool('ticket_update', { key: 'ALV-1', body: textOf(MAX_BODY_CHARS + 1) }, { backend, context }), /ticket_update: body too long/);
  await assert.rejects(callTool('ticket_create', { title: 'x', body: textOf(MAX_BODY_CHARS + 1) }, { backend, context }), /ticket_create: body too long/);
  await assert.rejects(callTool('board_feedback', { title: 'x', detail: textOf(MAX_BODY_CHARS) }, { backend, context, env: {} }), /board_feedback: feedback detail \(with its context lines\) too long/);
  assert.deepEqual(calls, [], 'nothing was sent');
  assert.match(await callTool('ticket_comment', { key: 'ALV-1', text: `  ${textOf(MAX_COMMENT_CHARS)}  ` }, { backend, context }), /Commented on ALV-1/);
  assert.deepEqual(calls, [['comment', MAX_COMMENT_CHARS + 4]], 'the text goes as written; the board trims it');

  const { TOOLS } = await toolsList();
  const comment = TOOLS.find((t) => t.name === 'ticket_comment');
  assert.match(comment.description, /at most 64 000 characters; a longer text is refused, never cut/);
  assert.match(TOOLS.find((t) => t.name === 'ticket_create').inputSchema.properties.body.description, /64 000/);
});

async function toolsList() {
  const { handleMessage } = await import('../mcp/server.mjs');
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { mode: 'full' });
  return { TOOLS: r.result.tools };
}

test('board_feedback: assignee from SESSION_BOARD_FEEDBACK_ASSIGNEE, else the board owner (user); a bad value fails loudly', async () => {
  assert.equal(feedbackAssignee({}), 'user');
  assert.equal(feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: '  ' }), 'user');
  assert.equal(feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: 'agent-a' }), 'agent-a');
  assert.equal(feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: 'triage-bot' }), 'triage-bot');
  assert.throws(() => feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: 'not an id!' }), /SESSION_BOARD_FEEDBACK_ASSIGNEE="not an id!" is not an actor id.*Nothing was saved/);
  const sent = [];
  const backend = { create: async (body) => (sent.push(body), { key: 'ALV-9', title: body.title }) };
  const context = { actor: 'claude', machine: 'm', origin: 'terminal' };
  await callTool('board_feedback', { title: 'a', detail: 'b', type: 'bug' }, { backend, context, env: {} });
  await callTool('board_feedback', { title: 'a', detail: 'b', type: 'bug' }, { backend, context, env: { SESSION_BOARD_FEEDBACK_ASSIGNEE: 'agent-a' } });
  assert.deepEqual(sent.map((b) => [b.kind, b.assignee]), [['feedback', 'user'], ['feedback', 'agent-a']]);
  await assert.rejects(callTool('board_feedback', { title: 'a' }, { backend, context, env: { SESSION_BOARD_FEEDBACK_ASSIGNEE: 'x y' } }), /not an actor id/);
  assert.equal(sent.length, 2);
});

test('long text in the page: the same limit as the server, and the UI never cuts with maxlength', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  assert.equal(Number(page.match(/const MAX_TEXT = (\d+);/)?.[1]), MAX_TEXT_CHARS, 'page.html MAX_TEXT = lib/core.mjs MAX_TEXT_CHARS');
  // A maxlength on a long text box would cut a paste in silence: the counter refuses instead.
  for (const id of ['comment', 'bodyEdit', 'resolution']) {
    const tag = page.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.doesNotMatch(tag, /maxlength/, id);
    assert.match(tag, /data-limit="(comment|body)"/, id);
  }
  assert.match(page, /<textarea name="body" data-limit="body" placeholder="Details \(markdown\)">/);
});

test('request limits: the byte bound never answers before the character limit, even for JSON-heavy text', async () => {
  // \n, " and \ take 2 bytes in JSON, a control character 6 (\u0001): 64 000 of them are legal.
  const heavy = ('line\n"quoted" back\\slash \u0001').repeat(Math.ceil(MAX_TEXT_CHARS / 30)).slice(0, MAX_TEXT_CHARS);
  const controls = '\u0001'.repeat(MAX_TEXT_CHARS);
  assert.ok(Buffer.byteLength(JSON.stringify({ body: controls, comment: controls })) <= MAX_TICKET_REQUEST);
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const t = await (await post('/api/tickets', { title: 'Escapes' })).json();
    assert.equal((await post(`/api/tickets/${t.key}/comments`, { text: heavy })).status, 201);
    // Body and comment of 64 000 control characters in one update: about 768 KB of JSON, legal.
    const upd = await post(`/api/tickets/${t.key}`, { body: controls, comment: `x${controls.slice(1)}` });
    assert.equal(upd.status, 200, await upd.clone().text().then((x) => x.slice(0, 200)));
    const got = await (await fetch(`${base}/api/tickets/${t.key}`, { headers: auth })).json();
    assert.equal(got.body, controls);
    assert.deepEqual(got.events.filter((e) => e.type === 'comment').map((e) => e.text.length), [heavy.trim().length, MAX_TEXT_CHARS]);
    // One character more is refused by the character limit, with its message, not by the byte bound.
    const over = await post(`/api/tickets/${t.key}/comments`, { text: `x${'\u0001'.repeat(MAX_TEXT_CHARS)}` });
    assert.equal(over.status, 413);
    assert.match((await over.json()).error, /^comment too long: 64 001 characters/);
  });
  store.close();
});

test('request limits: past the limit, at most DRAIN_AFTER_LIMIT more bytes are read, then the connection is cut', async () => {
  assert.equal(DRAIN_AFTER_LIMIT, 256 * 1024);
  const fake = () => Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; } });
  const feed = (req, total, chunk = 16 * 1024) => {
    let sent = 0;
    while (sent < total && !req.destroyed) {
      req.emit('data', Buffer.alloc(Math.min(chunk, total - sent)));
      sent += chunk;
    }
    if (!req.destroyed) req.emit('end');
    return Math.min(sent, total);
  };
  // A large import (4 MiB limit) sent 12 MiB over: reading stops 256 KiB past the limit, not 16 MiB.
  const max = 4 * 1024 * 1024;
  const big = fake();
  const p = readRaw(big, max);
  const read = feed(big, max + 12 * 1024 * 1024);
  await assert.rejects(p, (e) => e.status === 413);
  assert.equal(big.destroyed, true);
  assert.ok(read <= max + DRAIN_AFTER_LIMIT + 16 * 1024, `read ${read} bytes`);
  // Slightly over: the rest is drained, the connection stays usable for the 413.
  const small = fake();
  const q = readRaw(small, 64 * 1024);
  feed(small, 100 * 1024);
  await assert.rejects(q, (e) => e.status === 413);
  assert.equal(small.destroyed, false);
  // Over HTTP: slightly over gets its 413 and message; far over is cut, and the server keeps serving.
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const slight = await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: 'x'.repeat(64 * 1024 + 100 * 1024) });
    assert.equal(slight.status, 413);
    assert.match((await slight.json()).error, /request too large/);
    // Far over (4 MiB on a 64 KiB route): the server reads the limit plus the drain, then cuts.
    bodyStats.read = 0;
    const far = await fetch(`${base}/api/event`, { method: 'POST', headers: auth, body: 'x'.repeat(4 * 1024 * 1024) }).then((r) => r.status, () => 'cut');
    assert.ok(far === 413 || far === 'cut', String(far));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(bodyStats.read <= 64 * 1024 + DRAIN_AFTER_LIMIT + 64 * 1024, `the server read ${bodyStats.read} bytes`);
    assert.ok(bodyStats.read > 64 * 1024, 'it did read up to the limit');
    assert.equal((await fetch(`${base}/api/version`, { headers: auth })).status, 200);
  });
  store.close();
});

test('board_feedback: an assignee the board does not know is refused when the board can tell, never sent into the void', async () => {
  const { LocalBackend } = await import('../lib/runtime.mjs');
  const context = { actor: 'claude', machine: 'm', origin: 'terminal' };
  const env = { SESSION_BOARD_FEEDBACK_ASSIGNEE: 'triage-bot' };
  // Local mode: exact.
  const store = await openStore(':memory:');
  const local = new LocalBackend(store);
  await assert.rejects(callTool('board_feedback', { title: 'a', detail: 'b' }, { backend: local, context, env }), /SESSION_BOARD_FEEDBACK_ASSIGNEE="triage-bot" is not an actor of this board.*Nothing was saved/);
  assert.equal(store.listTickets(parseFilters({ kind: 'feedback' })).tickets.length, 0);
  store.touchActor({ id: 'triage-bot', type: 'agent' });
  assert.match(await callTool('board_feedback', { title: 'a', detail: 'b' }, { backend: local, context, env }), /Feedback recorded/);
  assert.equal(store.listTickets(parseFilters({ kind: 'feedback' })).tickets[0].assignee, 'triage-bot');
  // The default needs no check, even on an empty board.
  assert.match(await callTool('board_feedback', { title: 'c' }, { backend: local, context, env: {} }), /Feedback recorded/);
  store.close();
  // A server: its actors listing decides when it is not capped (300); otherwise, or on error, the feedback goes through.
  const sent = [];
  const remote = (list) => ({ actors: async () => (list instanceof Error ? Promise.reject(list) : { actors: list }), create: async (b) => (sent.push(b.assignee), { key: 'ALV-1' }) });
  await assert.rejects(callTool('board_feedback', { title: 'a' }, { backend: remote([{ id: 'user' }, { id: 'agent-a' }]), context, env }), /not an actor of this board/);
  await callTool('board_feedback', { title: 'a' }, { backend: remote([{ id: 'triage-bot' }]), context, env });
  // A server older than 0.5.10 does not say whether its listing is complete: only a short one (< 100) is trusted.
  await callTool('board_feedback', { title: 'a' }, { backend: remote(Array.from({ length: 100 }, (_, i) => ({ id: `job-${i}` }))), context, env });
  await callTool('board_feedback', { title: 'a' }, { backend: remote(new Error('HTTP 404')), context, env });
  assert.deepEqual(sent, ['triage-bot', 'triage-bot', 'triage-bot']);
  // A 0.5.10 server says it: `complete` decides, whatever the length.
  const flagged = (list, complete) => ({ actors: async () => ({ actors: list, complete }), create: async (b) => (sent.push(b.assignee), { key: 'ALV-2' }) });
  await assert.rejects(callTool('board_feedback', { title: 'a' }, { backend: flagged(Array.from({ length: 250 }, (_, i) => ({ id: `job-${i}` })), true), context, env }), /not an actor of this board/);
  await callTool('board_feedback', { title: 'a' }, { backend: flagged([{ id: 'user' }], false), context, env });
  assert.equal(sent.length, 4);
});

test('page helpers match core: digit grouping, and the near-limit count derived from the limit', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  const line = page.match(/const groupDigits = \(n\) => .*;$/m)?.[0];
  assert.ok(line, 'groupDigits is in the page');
  const pageGroup = new Function(`${line}; return groupDigits;`)();
  for (const n of [0, 7, 999, 1000, 56000, 64000, 64001, 1234567]) assert.equal(pageGroup(n).replace(/ /g, ' '), groupDigits(n), String(n));
  assert.match(page, /const NEAR_TEXT = MAX_TEXT - 8000;/);
  // The reading view gives its text the focus explicitly (an autofocus attribute set by innerHTML does nothing).
  assert.match(page, /\$\('help'\)\.querySelector\('\.readerBody'\)\?\.focus\(\{ preventScroll: true \}\);/);
  assert.doesNotMatch(page, /class="readerBody"[^>]*autofocus/);
});

test('a server says whether its actors listing is complete', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const get = async () => (await fetch(`${base}/api/actors`, { headers: auth })).json();
    const r = await get();
    assert.equal(r.complete, true);
    for (let i = 0; i < 305; i++) store.touchActor({ id: `job-${i}`, type: 'agent' });
    const big = await get();
    assert.equal(big.complete, false, 'the listing is capped: an absence proves nothing');
  });
  store.close();
});

test('request limits: authentication and CSRF are settled before any body is read', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const t = await (await fetch(`${base}/api/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'x' }) })).json();
    const big = JSON.stringify({ text: 'z'.repeat(800 * 1024) });
    // No credential: refused, nothing read by the app, and the connection is not kept to drain it.
    bodyStats.read = 0;
    const anon = await fetch(`${base}/api/tickets/${t.key}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }).then((r) => r.status, () => 'cut');
    assert.ok(anon === 401 || anon === 'cut', String(anon));
    const bad = await fetch(`${base}/api/tickets/${t.key}`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: big }).then((r) => r.status, () => 'cut');
    assert.ok(bad === 401 || bad === 'cut', String(bad));
    // A page session without its CSRF token: refused before reading too.
    const sess = await fetch(`${base}/api/session`, { method: 'POST', headers: auth });
    const cookie = sess.headers.get('set-cookie').split(';')[0];
    const csrfLess = await fetch(`${base}/api/tickets/${t.key}/comments`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: big }).then((r) => r.status, () => 'cut');
    assert.ok(csrfLess === 403 || csrfLess === 'cut', String(csrfLess));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bodyStats.read, 0, 'no route read a byte of these bodies');
    // A small refused request still gets its answer.
    const small = await fetch(`${base}/api/tickets/${t.key}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
    assert.equal(small.status, 401);
  });
  store.close();
});

test('markdown cleaning is linear: a hostile 50 000-character line is handled in under 50 ms', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
  const escLine = page.match(/^\s*const esc = .*$/m)[0];
  const { plain } = new Function(`${escLine}\nconst actors = new Map(); const actorName = (i) => i;\n${page.slice(page.indexOf('// ---- markdown'), page.indexOf('/** One line that says what a ticket needs from you. */'))}\nreturn { plain };`)();
  for (const unit of ['_ ', '_a ', '* ', '*a ', '** ', '**a ', '__a ', '~~a ', '[', '[a](', '*a_ ']) {
    const line = unit.repeat(Math.ceil(50000 / unit.length)).slice(0, 50000);
    for (const [name, fn] of [['triage clean', clean], ['page plain', plain]]) {
      fn(line); // warm up
      const t0 = performance.now();
      fn(line);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${name} on ${JSON.stringify(unit)} x ${line.length}: ${ms.toFixed(1)} ms`);
    }
  }
  // What already worked still works.
  assert.equal(clean('drop the *cache_v2* table'), 'drop the cache_v2 table');
  assert.equal(clean('set REFRESH_LOCK_TTL to 5'), 'set REFRESH_LOCK_TTL to 5');
  assert.equal(clean('_italique_ et __gras__ et **bold** et [lien](https://x.test)'), 'italique et gras et bold et lien');
  assert.equal(clean('2 * 3 and a_b'), '2 * 3 and a_b');
});
