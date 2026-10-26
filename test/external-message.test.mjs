// An external message: a ticket's history records that a message about it was sent (or received) on
// another channel (chat, mail, SMS…), with the channel, the direction, who it went to, when, and an
// optional short excerpt. It moves nothing on the ticket. Made-up tickets and people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_MESSAGE_EXCERPT, sanitizeExternalMessage } from '../lib/core.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';
import { callTool, describe as describeTicket } from '../mcp/server.mjs';

const T0 = Date.UTC(2026, 9, 22, 11, 5);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const messages = (t) => t.events.filter((e) => e.type === 'external_message');

async function board() {
  const clock = { t: T0 };
  const store = await openStore(':memory:', { now: () => clock.t, jobActors: [] });
  const tk = store.createTicket({ title: 'Ship the invoice export', assignee: 'claude' }, { actor: 'user' });
  return { store, clock, tk };
}

test('sanitize: channel, direction, peer, time and excerpt, with their defaults', () => {
  const { value } = sanitizeExternalMessage({ channel: ' Slack ', peer: 'Dana (design)' }, T0);
  assert.deepEqual(value, { channel: 'slack', direction: 'out', peer: 'Dana (design)', at: T0 });
  const full = sanitizeExternalMessage({ channel: 'email', direction: 'in', peer: 'ops list', at: '2026-10-22T09:00:00Z', excerpt: '  Shipped,\n\nthanks  ' }, T0).value;
  assert.deepEqual(full, { channel: 'email', direction: 'in', peer: 'ops list', at: Date.UTC(2026, 9, 22, 9), excerpt: 'Shipped, thanks' });
  assert.equal(sanitizeExternalMessage({ channel: 'sms', peer: 'x', at: T0 - 1000 }, T0).value.at, T0 - 1000, 'epoch milliseconds too');
  assert.equal(sanitizeExternalMessage({ channel: 'sms', peer: 'x', at: String(T0 - 1000) }, T0).value.at, T0 - 1000);
});

test('sanitize: the excerpt is bounded and its secrets masked; the peer is one bounded line', () => {
  const long = sanitizeExternalMessage({ channel: 'slack', peer: 'Dana', excerpt: 'word '.repeat(200) }, T0).value.excerpt;
  assert.equal(long.length, MAX_MESSAGE_EXCERPT);
  assert.ok(long.endsWith('…'));
  const secret = sanitizeExternalMessage({ channel: 'slack', peer: 'Dana', excerpt: 'the key is ghp_' + 'a'.repeat(36) }, T0).value.excerpt;
  assert.ok(!secret.includes('a'.repeat(36)), secret);
  const peer = sanitizeExternalMessage({ channel: 'slack', peer: 'a\nb ' + 'c'.repeat(200) }, T0).value.peer;
  assert.equal(peer.length, 80);
  assert.ok(!peer.includes('\n'));
  assert.equal(sanitizeExternalMessage({ channel: 'slack', peer: 'Dana', excerpt: '   ' }, T0).value.excerpt, undefined, 'a blank excerpt is none');
});

test('sanitize: refuses what is not a message', () => {
  const err = (m) => sanitizeExternalMessage(m, T0).error;
  assert.match(err(null), /must be an object/);
  assert.match(err([]), /must be an object/);
  assert.match(err({ peer: 'Dana' }), /channel/);
  assert.match(err({ channel: 'my channel!', peer: 'Dana' }), /channel/);
  assert.match(err({ channel: 'x'.repeat(33), peer: 'Dana' }), /channel/);
  assert.match(err({ channel: 'slack' }), /peer/);
  assert.match(err({ channel: 'slack', peer: '  ' }), /peer/);
  assert.match(err({ channel: 'slack', peer: 'Dana', direction: 'sideways' }), /direction/);
  assert.match(err({ channel: 'slack', peer: 'Dana', at: 'yesterday-ish' }), /at must be a date/);
  assert.match(err({ channel: 'slack', peer: 'Dana', at: T0 + 3_600_000 }), /future/);
  assert.match(err({ channel: 'slack', peer: 'Dana', excerpt: 42 }), /excerpt/);
});

test('store: the message goes into the history and moves nothing else', async () => {
  const { store, clock, tk } = await board();
  clock.t += 60_000;
  const out = store.updateTicket(tk.key, { message: { channel: 'slack', peer: 'Dana', at: T0, excerpt: 'Export is live' } }, { actor: 'claude' });
  assert.deepEqual(out.message, { channel: 'slack', direction: 'out', peer: 'Dana', at: T0, excerpt: 'Export is live' }, 'the answer says it was recorded');
  assert.equal(out.status, tk.status);
  assert.equal(out.assignee, 'claude');
  assert.equal(out.comments_count, 0, 'not a comment');
  const t = store.getTicket(tk.key);
  assert.equal(t.updated_at, clock.t);
  const [e] = messages(t);
  assert.deepEqual(
    { actor: e.actor, at: e.at, text: e.text, message: e.message, meta: e.meta },
    { actor: 'claude', at: clock.t, text: 'Export is live', message: { channel: 'slack', direction: 'out', peer: 'Dana', at: T0 }, meta: undefined },
  );
  // Without an excerpt the event has no text; a plain update still answers without `message`.
  store.updateTicket(tk.key, { message: { channel: 'email', direction: 'in', peer: 'billing@example.com' } }, { actor: 'claude' });
  assert.equal(messages(store.getTicket(tk.key))[1].text, null);
  assert.equal(store.updateTicket(tk.key, { priority: 'P2' }, { actor: 'claude' }).message, undefined);
});

test('store: a bad message is refused whole, nothing else of the update is applied', async () => {
  const { store, tk } = await board();
  assert.throws(() => store.updateTicket(tk.key, { status: 'done', message: { channel: 'slack' } }, { actor: 'claude' }), (e) => e.status === 400 && /peer/.test(e.message));
  const t = store.getTicket(tk.key);
  assert.equal(t.status, 'todo');
  assert.equal(messages(t).length, 0);
});

test('store: a board from before external messages migrates without losing its history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alv-msg-'));
  const file = join(dir, 'board.sqlite');
  let store = await openStore(file, { jobActors: [] });
  const tk = store.createTicket({ title: 'An older ticket' }, { actor: 'user' });
  store.comment(tk.key, 'Written before the upgrade', { actor: 'claude' });
  store.close();
  // Back to the old schema: no `meta` column.
  const db = new DatabaseSync(file);
  db.exec('ALTER TABLE ticket_events DROP COLUMN meta');
  assert.ok(!db.prepare('PRAGMA table_info(ticket_events)').all().some((c) => c.name === 'meta'));
  db.close();
  store = await openStore(file, { jobActors: [] });
  const before = store.getTicket(tk.key);
  assert.deepEqual(before.events.map((e) => e.type), ['created', 'comment']);
  assert.equal(before.events[1].text, 'Written before the upgrade');
  assert.ok(!('message' in before.events[1]));
  store.updateTicket(tk.key, { message: { channel: 'teams', peer: 'Release crew' } }, { actor: 'claude' });
  assert.equal(messages(store.getTicket(tk.key))[0].message.channel, 'teams');
  store.close();
});

test('export and import keep the message; an import never brings back a bare one', async () => {
  const { store, tk } = await board();
  store.updateTicket(tk.key, { message: { channel: 'sms', peer: 'On-call', at: T0 - 5000, excerpt: 'Paging you' } }, { actor: 'claude' });
  const exported = store.exportForImport();
  const t = exported.tickets.find((x) => x.title === 'Ship the invoice export');
  const ev = t.events.find((e) => e.type === 'external_message');
  assert.deepEqual(ev.message, { channel: 'sms', direction: 'out', peer: 'On-call', at: T0 - 5000 });
  assert.ok(!('meta' in ev));
  t.events.push({ type: 'external_message', at: T0, actor: 'claude', text: 'no message attached' });
  const other = (await board()).store;
  const r = other.importTickets({ board: 'board-123456', machine: 'laptop', tickets: [t] });
  const imported = other.getTicket(r.results[0].key);
  const got = messages(imported);
  assert.equal(got.length, 1, 'the bare one is dropped');
  assert.deepEqual([got[0].text, got[0].message], ['Paging you', { channel: 'sms', direction: 'out', peer: 'On-call', at: T0 - 5000 }]);
});

test('server: POST /api/tickets/:key with { message } records it; a bad one answers 400', async () => {
  const { store, tk } = await board();
  const token = 'm'.repeat(32);
  const server = createServer(createApp({ token, store, page: '<html></html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/tickets/${tk.key}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const ok = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: { channel: 'discord', peer: '#releases', excerpt: 'v2 is out' } }) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).message.channel, 'discord');
    const bad = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: { channel: 'discord' } }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /peer/);
    const t = await (await fetch(url, { headers })).json();
    assert.deepEqual(messages(t).map((e) => [e.text, e.message.peer]), [['v2 is out', '#releases']]);
  } finally {
    server.close();
  }
});

test('mcp: ticket_message sends { message } through update and says what it recorded', async () => {
  const sent = [];
  const backend = { update: async (key, body) => (sent.push([key, body]), { key, message: { channel: 'slack', direction: 'out', peer: 'Dana', at: T0 } }) };
  const out = await callTool('ticket_message', { key: 'ALV-7', channel: 'slack', peer: 'Dana', excerpt: 'hi' }, { backend, context: { machine: 'm' } });
  assert.deepEqual(sent, [['ALV-7', { message: { channel: 'slack', peer: 'Dana', excerpt: 'hi' } }]]);
  assert.equal(out, 'Recorded on ALV-7: message to Dana on slack, 2026-10-22 11:05');
});

test('mcp: ticket_message against a board that ignores `message` says nothing was saved', async () => {
  const backend = { update: async (key) => ({ key, status: 'todo' }) };
  await assert.rejects(callTool('ticket_message', { key: 'ALV-7', channel: 'slack', peer: 'Dana' }, { backend, context: { machine: 'm' } }), /without recording the message/);
});

test('mcp: ticket_get shows the message in the history', async () => {
  const { store, tk } = await board();
  store.updateTicket(tk.key, { message: { channel: 'email', direction: 'in', peer: 'Sam', at: T0, excerpt: 'Got it' } }, { actor: 'claude' });
  const text = describeTicket(store.getTicket(tk.key), { full: true });
  assert.match(text, /message from Sam on email, 2026-10-22 11:05\n.*Got it/);
});

test('page: an icon per known channel, a neutral one otherwise, and the line in both languages', () => {
  const from = page.indexOf('// ---- external messages');
  const to = page.indexOf('// ---- end external messages');
  assert.ok(from > 0 && to > from, 'external messages block found in page.html');
  const { messageIcon } = new Function(`${page.slice(from, to)}\nreturn { messageIcon };`)();
  assert.equal(messageIcon('email'), '✉️');
  assert.equal(messageIcon('slack'), '💬');
  assert.equal(messageIcon('sms'), '📱');
  assert.equal(messageIcon('carrier-pigeon'), '📨');
  assert.equal(messageIcon('toString'), '📨', 'never a property of Object');
  assert.match(page, /e\.type === 'external_message' && e\.message/);
  assert.match(page, /'\{by\} sent a message to \{peer\} on \{channel\}': '\{by\} a envoyé un message à \{peer\} sur \{channel\}'/);
  // Peer, channel and excerpt are escaped: they come from agents.
  const line = page.slice(page.indexOf("if (e.type === 'external_message'"), page.indexOf("return `<div class=\"ev ${esc(e.type)}\">"));
  assert.match(line, /esc\(m\.peer\)/);
  assert.match(line, /esc\(m\.channel\)/);
  assert.match(line, /esc\(e\.text\)/);
});
