// 0.5.10: a long comment or body is kept whole up to 64 000 characters, and refused (413, with a
// message) above, never cut. Until 0.5.9 a comment lost everything past 4 000 characters and a body
// past 8 000, without a word: the end of a pasted job offer, the end of a long reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_BODY_CHARS, MAX_COMMENT_CHARS, MAX_TEXT_CHARS, groupDigits, sanitizeTicketInput, textTooLong } from '../lib/core.mjs';
import { commentText, openStore } from '../lib/store.mjs';
import { MAX_TICKET_REQUEST, createApp } from '../server/server.mjs';
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
  assert.ok(MAX_TICKET_REQUEST >= 2 * MAX_TEXT_CHARS * 3, 'a body and a comment of 3-byte characters fit in one update');
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
  assert.equal(feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: 'lupi' }), 'lupi');
  assert.equal(feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: 'ops/triage' }), 'ops/triage');
  assert.throws(() => feedbackAssignee({ SESSION_BOARD_FEEDBACK_ASSIGNEE: 'not an id!' }), /SESSION_BOARD_FEEDBACK_ASSIGNEE="not an id!" is not an actor id.*Nothing was saved/);
  const sent = [];
  const backend = { create: async (body) => (sent.push(body), { key: 'ALV-9', title: body.title }) };
  const context = { actor: 'claude', machine: 'm', origin: 'terminal' };
  await callTool('board_feedback', { title: 'a', detail: 'b', type: 'bug' }, { backend, context, env: {} });
  await callTool('board_feedback', { title: 'a', detail: 'b', type: 'bug' }, { backend, context, env: { SESSION_BOARD_FEEDBACK_ASSIGNEE: 'lupi' } });
  assert.deepEqual(sent.map((b) => [b.kind, b.assignee]), [['feedback', 'user'], ['feedback', 'lupi']]);
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
