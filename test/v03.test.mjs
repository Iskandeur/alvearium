// 0.3: realtime, dependencies, priority and "next", actors, threads, feedback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classify, normalizePriority, parseFilters, sanitizeEvent } from '../lib/core.mjs';
import { handleHook, localDbPath } from '../lib/runtime.mjs';
import { loadSqlite, openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const TOKEN = 'y'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function withServer(store, fn, opts = {}) {
  const server = createServer(createApp({ token: TOKEN, store, page: '<html></html>', ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** Read an SSE response until `until(events)` is true. Returns the parsed events and the raw comments. */
async function readStream(res, until, timeoutMs = 4000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  const comments = [];
  const deadline = Date.now() + timeoutMs;
  let pending = null;
  while (Date.now() < deadline && !until(events, comments)) {
    pending ??= reader.read();
    const r = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok(null), 200))]);
    if (!r) continue;
    pending = null;
    const { value, done } = r;
    if (done) break;
    if (!value) continue;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) comments.push(line.slice(1).trim());
        else if (line.startsWith('event: ')) ev.event = line.slice(7);
        else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
        else if (line.startsWith('id: ')) ev.id = line.slice(4);
      }
      if (ev.event) events.push(ev);
    }
  }
  reader.cancel().catch(() => {});
  return { events, comments };
}

test('priorities: P0-P3, 0.2 names and digits are mapped', () => {
  assert.equal(normalizePriority('high'), 'P1');
  assert.equal(normalizePriority('urgent'), 'P0');
  assert.equal(normalizePriority('p2'), 'P2');
  assert.equal(normalizePriority('3'), 'P3');
  assert.equal(normalizePriority(''), null);
  assert.equal(normalizePriority('soon'), undefined);
  assert.deepEqual(parseFilters({ priority: 'high,none' }).priority, ['P1', 'none']);
});

test('schema 1 → 2: priorities migrated, creators filled, nothing lost, a backup kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-mig-'));
  const file = join(dir, 'board.db');
  // A 0.2 database, written the way 0.2 wrote it.
  const { DatabaseSync } = await loadSqlite();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema', '1');
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, name TEXT, repo TEXT, branch TEXT, cwd TEXT, machine TEXT, origin TEXT NOT NULL DEFAULT 'terminal', url TEXT, state TEXT, detail TEXT, first_seen INTEGER, last_seen INTEGER, rec TEXT);
    CREATE TABLE tickets (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'action', assignee TEXT NOT NULL DEFAULT 'user', priority TEXT, labels TEXT NOT NULL DEFAULT '[]', parent_id TEXT, links TEXT NOT NULL DEFAULT '[]', session_id TEXT, repo TEXT, branch TEXT, cwd TEXT, machine TEXT, origin TEXT NOT NULL DEFAULT 'terminal', source TEXT NOT NULL DEFAULT 'user', external_id TEXT, title_locked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE ticket_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, from_status TEXT, to_status TEXT, text TEXT);`);
  const now = Date.now();
  const prios = ['urgent', 'high', 'medium', 'low', null];
  prios.forEach((p, i) => {
    old.prepare('INSERT INTO tickets (id, seq, title, status, priority, source, created_at, updated_at, status_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`t_${i}`, i + 1, `T${i}`, 'todo', p, i === 1 ? 'claude' : 'user', now, now, now);
    old.prepare('INSERT INTO ticket_events (ticket_id, at, actor, type) VALUES (?, ?, ?, ?)').run(`t_${i}`, now, i === 1 ? 'claude' : 'user', 'created');
  });
  old.close();

  const store = await openStore(file);
  assert.deepEqual(store.counts(), { sessions: 0, tickets: 5, events: 5 });
  const rows = store.db.prepare('SELECT seq, priority, created_by FROM tickets ORDER BY seq').all();
  assert.deepEqual(rows.map((r) => r.priority), ['P0', 'P1', 'P2', 'P3', null]);
  assert.deepEqual(rows.map((r) => r.created_by), ['user', 'claude', 'user', 'user', 'user']);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get().value, '2');
  const { readdirSync } = await import('node:fs');
  assert.ok(readdirSync(dir).some((f) => /^board\.db\.schema1-.*\.bak$/.test(f)), 'a copy of the 0.2 database is kept');
  store.close();
  const again = await openStore(file);
  assert.deepEqual(again.counts(), { sessions: 0, tickets: 5, events: 5 }, 'opening twice changes nothing');
  again.close();
});

test('dependencies: cycles refused, blocked tickets badged and out of next, unblocked when the last blocker is done', async () => {
  const s = await openStore(':memory:');
  const a = s.createTicket({ title: 'Design the schema', repo: 'acme/api' });
  const b = s.createTicket({ title: 'Write the migration', repo: 'acme/api', blocked_by: [a.key] });
  const c = s.createTicket({ title: 'Deploy', repo: 'acme/api', blocked_by: [b.key, a.key] });
  assert.equal(b.blocked, true);
  assert.deepEqual(b.blocked_by.map((x) => x.key), [a.key]);
  assert.deepEqual(s.getTicket(a.key).blocking.map((x) => x.key), [b.key, c.key]);

  assert.throws(() => s.updateTicket(a.key, { blocked_by_add: [c.key] }), /cycle/, 'C waits for A: A cannot wait for C');
  assert.throws(() => s.updateTicket(a.key, { blocked_by_add: [a.key] }), /cycle/);
  assert.throws(() => s.updateTicket(a.key, { blocked_by_add: ['SB-999'] }), /not found/);

  let next = s.nextTickets(parseFilters({ repo: 'acme/api' }));
  assert.deepEqual(next.tickets.map((t) => t.key), [a.key]);
  assert.equal(next.blocked, 2);

  s.updateTicket(a.key, { status: 'done' });
  const bNow = s.getTicket(b.key);
  assert.equal(bNow.blocked, false);
  assert.ok(bNow.events.some((e) => e.type === 'unblocked' && e.text.includes(a.key)), 'history says it was unblocked');
  assert.equal(s.getTicket(c.key).blocked, true, 'C still waits for B');
  assert.ok(!s.getTicket(c.key).events.some((e) => e.type === 'unblocked'));
  next = s.nextTickets(parseFilters({ repo: 'acme/api' }));
  assert.deepEqual(next.tickets.map((t) => t.key), [b.key]);

  s.updateTicket(b.key, { status: 'done' });
  assert.ok(s.getTicket(c.key).events.some((e) => e.type === 'unblocked' && e.text.includes(b.key)));
  s.updateTicket(c.key, { blocked_by_remove: [a.key] });
  assert.deepEqual(s.getTicket(c.key).blocked_by.map((x) => x.key), [b.key]);
  s.updateTicket(b.key, { status: 'todo' });
  assert.equal(s.getTicket(c.key).blocked, true, 'a reopened blocker blocks again');
  assert.ok(s.getTicket(c.key).events.some((e) => e.type === 'blocked'));
});

test('next: priority, then manual rank, then age; filters by repo, session and actor; move reorders', async () => {
  let clock = 1_000_000;
  const s = await openStore(':memory:', { now: () => (clock += 1000) });
  const mk = (title, extra = {}) => s.createTicket({ title, repo: 'acme/web', ...extra });
  const low = mk('Polish the footer', { priority: 'P3' });
  const none = mk('Rename a variable');
  const old1 = mk('Fix login', { priority: 'P1' });
  const new1 = mk('Fix signup', { priority: 'P1' });
  const top = mk('Hotfix the outage', { priority: 'P0' });
  mk('Elsewhere', { repo: 'acme/other', priority: 'P0' });
  s.createTicket({ title: 'Done already', repo: 'acme/web', priority: 'P0', status: 'done' });
  s.createTicket({ title: 'A question', repo: 'acme/web', kind: 'question', priority: 'P0' });
  const mine = s.createTicket({ title: 'Agent work', repo: 'acme/web', priority: 'P2' }, { actor: 'ci-bot' });

  const keys = (r) => r.tickets.map((t) => t.key);
  assert.deepEqual(keys(s.nextTickets(parseFilters({ repo: 'acme/web' }))), [top.key, old1.key, new1.key, mine.key, low.key, none.key]);

  s.moveTicket(new1.key, { before: old1.key });
  assert.deepEqual(keys(s.nextTickets(parseFilters({ repo: 'acme/web', priority: 'P1' }))), [new1.key, old1.key], 'dragged above');
  s.moveTicket(low.key, { after: old1.key });
  const moved = s.getTicket(low.key);
  assert.equal(moved.priority, 'P1', 'dropped among P1 tickets, it becomes P1');
  assert.deepEqual(keys(s.nextTickets(parseFilters({ repo: 'acme/web', priority: 'P1' }))), [new1.key, old1.key, low.key]);

  assert.deepEqual(keys(s.nextTickets(parseFilters({ repo: 'acme/web', actor: 'ci-bot' }))), [mine.key], 'actor = who holds it or opened it');
  assert.equal(s.getTicket(mine.key).created_by, 'ci-bot');
  const board = s.ticketBoard(parseFilters({ repo: 'acme/web' }));
  const work = board.columns.todo.filter((t) => t.kind !== 'question');
  assert.deepEqual(work.slice(0, 2).map((t) => t.key), [top.key, new1.key], 'the To do column uses the same order');
});

test('SSE: a client receives the change of a ticket made by another client; heartbeats flow', async () => {
  const store = await openStore(':memory:');
  await withServer(
    store,
    async (base) => {
      assert.equal((await fetch(`${base}/api/stream`)).status, 401);
      const res = await fetch(`${base}/api/stream`, { headers: { authorization: auth.authorization } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
      assert.match(res.headers.get('cache-control'), /no-cache/);
      setTimeout(async () => {
        const r = await fetch(`${base}/api/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Live one' }) });
        const t = await r.json();
        await fetch(`${base}/api/tickets/${t.key}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'in_progress', comment: 'go' }) });
      }, 100);
      const { events, comments } = await readStream(res, (ev, cm) => ev.filter((e) => e.event === 'change').length >= 3 && cm.some((c) => c.startsWith('hb')));
      assert.equal(events[0].event, 'hello');
      const changes = events.filter((e) => e.event === 'change').map((e) => e.data);
      assert.equal(changes[0].type, 'ticket');
      assert.equal(changes[0].op, 'created');
      assert.match(changes[0].key, /^SB-\d+$/);
      const upd = changes.find((c) => c.op === 'updated');
      assert.ok(upd.fields.includes('status'));
      assert.ok(changes.some((c) => c.type === 'comment'));
      assert.ok(changes.every((c, i) => i === 0 || c.version > changes[i - 1].version), 'versions only go up');
      assert.ok(comments.some((c) => c.startsWith('hb')), 'heartbeat comment');
    },
    { heartbeatMs: 150 },
  );
});

test('actors: a subagent payload makes a subagent actor; history says who handed work to whom', async () => {
  // Hooks reference: SubagentStart / SubagentStop carry agent_id and agent_type.
  assert.deepEqual(classify('SubagentStart', { agent_id: 'agent-abc123', agent_type: 'Explore' }).agent, { op: 'start', id: 'agent-abc123', type: 'Explore', detail: '' });
  assert.equal(classify('SubagentStop', { agent_id: 'x', agent_type: '' }), null, 'internal agents (empty type) are ignored');
  const stop = classify('SubagentStop', { agent_id: 'def456', agent_type: 'Explore', last_assistant_message: 'Found 3 call sites.' });
  assert.equal(stop.agent.detail, 'Found 3 call sites.');
  assert.ok(sanitizeEvent({ session: { sessionId: 's' }, transition: stop }).transition.agent);

  const dir = mkdtempSync(join(tmpdir(), 'sb-actors-'));
  const env = { SESSION_BOARD_DIR: dir, SESSION_BOARD_ACTOR: 'ci-bot', SESSION_BOARD_ACTOR_NAME: 'CI bot' };
  await handleHook('UserPromptSubmit', { session_id: 'act1', cwd: dir, prompt: 'audit the deps' }, { env });
  await handleHook('SubagentStart', { session_id: 'act1', cwd: dir, agent_id: 'a1', agent_type: 'Explore' }, { env });
  await handleHook('SubagentStop', { session_id: 'act1', cwd: dir, agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'Two outdated packages.' }, { env });
  const s = await openStore(localDbPath(env));
  const t = s.listTickets(parseFilters({ session: 'act1' })).tickets[0];
  assert.equal(t.assignee, 'ci-bot', 'the session ticket belongs to the session actor');
  assert.equal(t.created_by, 'ci-bot');
  const d = s.getTicket(t.key);
  const agentLines = d.events.filter((e) => e.type === 'agent');
  assert.deepEqual(agentLines.map((e) => [e.actor, e.target]), [
    ['ci-bot', 'ci-bot/Explore'],
    ['ci-bot/Explore', 'ci-bot'],
  ]);
  assert.match(agentLines[1].text, /Two outdated packages/);
  assert.equal(d.actors['ci-bot/Explore'].type, 'subagent');
  assert.equal(d.actors['ci-bot/Explore'].parent, 'ci-bot');
  assert.equal(d.actors['ci-bot'].name, 'CI bot');
  const ids = s.listActors().map((a) => a.id);
  assert.ok(ids.includes('ci-bot') && ids.includes('ci-bot/Explore') && ids.includes('user'));
  // A hand-over is its own line: "ci-bot → user".
  s.updateTicket(t.key, { assignee: 'user' }, { actor: 'ci-bot' });
  const handover = s.getTicket(t.key).events.find((e) => e.type === 'assigned');
  assert.deepEqual([handover.actor, handover.target], ['ci-bot', 'user']);
  s.close();
});

test('threads: sessions sharing SESSION_BOARD_THREAD make one session ticket; without it nothing changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-thread-'));
  const env = { SESSION_BOARD_DIR: dir, SESSION_BOARD_THREAD: 'chat-main' };
  for (const id of ['w1', 'w2', 'w3']) {
    await handleHook('SessionStart', { session_id: id, cwd: dir, source: 'startup' }, { env });
    await handleHook('UserPromptSubmit', { session_id: id, cwd: dir, prompt: `message for ${id}` }, { env });
    await handleHook('Stop', { session_id: id, cwd: dir, last_assistant_message: `answered ${id}` }, { env });
    await handleHook('SessionEnd', { session_id: id, cwd: dir, reason: 'other' }, { env });
  }
  // A plain session next to it keeps its own ticket.
  await handleHook('UserPromptSubmit', { session_id: 'solo', cwd: dir, prompt: 'alone' }, { env: { SESSION_BOARD_DIR: dir } });
  const s = await openStore(localDbPath(env));
  const sessionTickets = s.listTickets(parseFilters({ kind: 'session', archived: '1' })).tickets;
  assert.equal(sessionTickets.length, 2);
  const thread = sessionTickets.find((t) => t.title === 'Thread chat-main');
  assert.ok(thread, sessionTickets.map((t) => t.title).join(' | '));
  assert.equal(thread.session_id, 'w3', 'it follows the latest session');
  assert.equal(thread.status, 'review', 'SessionEnd does not close a thread');
  assert.equal(thread.body, 'answered w3');
  assert.ok(sessionTickets.some((t) => t.session_id === 'solo'));
  s.close();
});

test('SESSION_BOARD_SESSION_TICKETS=0: no automatic tickets, explicit tickets still attach to the session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-quiet-'));
  const env = { SESSION_BOARD_DIR: dir, SESSION_BOARD_SESSION_TICKETS: '0' };
  await handleHook('UserPromptSubmit', { session_id: 'q1', cwd: dir, prompt: 'routine' }, { env });
  await handleHook('PermissionRequest', { session_id: 'q1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' } }, { env });
  await handleHook('TaskCreated', { session_id: 'q1', cwd: dir, task_id: '1', task_title: 'step' }, { env });
  await handleHook('Stop', { session_id: 'q1', cwd: dir, last_assistant_message: 'ok' }, { env });
  const s = await openStore(localDbPath(env));
  assert.equal(s.counts().tickets, 0);
  assert.equal(s.counts().sessions, 1, 'the session is still known');
  const t = s.createTicket({ title: 'Explicit one', session_id: 'q1' }, { actor: 'claude' });
  assert.equal(t.session_id, 'q1');
  s.close();
});

test('SESSION_BOARD_STOP_STATUS=done: a finished turn closes the session ticket, the next turn reopens it, explicit tickets stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-stopdone-'));
  const env = { SESSION_BOARD_DIR: dir, SESSION_BOARD_ACTOR: 'bot', SESSION_BOARD_THREAD: 'chat-bot', SESSION_BOARD_STOP_STATUS: 'done' };
  await handleHook('UserPromptSubmit', { session_id: 'd1', cwd: dir, prompt: 'hello' }, { env });
  await handleHook('Stop', { session_id: 'd1', cwd: dir, last_assistant_message: 'answered in the chat' }, { env });
  const s = await openStore(localDbPath(env));
  const find = () => s.listTickets(parseFilters({ kind: 'session', archived: '1' })).tickets.find((t) => t.title === 'Thread chat-bot');
  let t = find();
  assert.equal(t.status, 'done');
  assert.equal(t.assignee, 'bot', 'not handed to the user');
  assert.equal(t.body, 'answered in the chat');
  assert.equal(s.ticketBoard(parseFilters({})).counts.waiting, 0, 'nothing waits on the user');
  assert.equal(s.listTickets(parseFilters({ assignee: 'bot', archived: '1' })).tickets.length, 1, 'still found by actor');
  // an explicit action item for the user still waits on them
  s.createTicket({ title: 'Approve the payment', assignee: 'user', status: 'waiting_on_user', session_id: 'd1' }, { actor: 'bot' });
  assert.equal(s.ticketBoard(parseFilters({})).counts.waiting, 1);
  s.close();
  // next turn: reopened, then closed again
  await handleHook('UserPromptSubmit', { session_id: 'd2', cwd: dir, prompt: 'again' }, { env });
  const s2 = await openStore(localDbPath(env));
  t = s2.listTickets(parseFilters({ kind: 'session', archived: '1' })).tickets.find((x) => x.title === 'Thread chat-bot');
  assert.equal(t.status, 'in_progress');
  s2.close();
  await handleHook('Stop', { session_id: 'd2', cwd: dir, last_assistant_message: 'done again' }, { env });
  const s3 = await openStore(localDbPath(env));
  assert.equal(s3.listTickets(parseFilters({ kind: 'session', archived: '1' })).tickets.find((x) => x.title === 'Thread chat-bot').status, 'done');
  s3.close();
  // the setting reaches the server; anything but `done` keeps the default
  const evt = (stopStatus) => sanitizeEvent({ session: { sessionId: 'x', stopStatus }, transition: { state: 'review' } }).identity.stopStatus;
  assert.equal(evt('done'), 'done');
  assert.equal(evt('review'), undefined);
  assert.equal(evt('rm -rf'), undefined);
});

test('SESSION_BOARD_STOP_STATUS unset: a finished turn still goes to review, for the user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-stopreview-'));
  const env = { SESSION_BOARD_DIR: dir };
  await handleHook('UserPromptSubmit', { session_id: 'r1', cwd: dir, prompt: 'hello' }, { env });
  await handleHook('Stop', { session_id: 'r1', cwd: dir, last_assistant_message: 'look at this' }, { env });
  const s = await openStore(localDbPath(env));
  const t = s.listTickets(parseFilters({ kind: 'session' })).tickets[0];
  assert.deepEqual([t.status, t.assignee], ['review', 'user']);
  s.close();
});

/** MCP stdio client (same as mcp.test.mjs). */
function mcp(env, cwd) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '..', 'mcp', 'server.mjs')], {
    env: { ...process.env, SESSION_BOARD_URL: '', SESSION_BOARD_TOKEN: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', SESSION_BOARD_ACTOR: '', ...env },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  return {
    call(name, args) {
      const mid = ++id;
      return new Promise((res, rej) => {
        waiting.set(mid, res);
        setTimeout(() => rej(new Error('timeout ' + name)), 5000).unref();
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
    },
  };
}

test('feedback via MCP stdio: board_feedback files a feedback ticket with its context; it stays out of the board', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-fb-'));
  const c = mcp({ SESSION_BOARD_DIR: dir, CLAUDE_CODE_SESSION_ID: 'fb-sess', SESSION_BOARD_ACTOR: 'job-42' }, resolve(import.meta.dirname, '..'));
  try {
    const r = await c.call('board_feedback', { title: 'ticket_list ignores the label filter', detail: 'Asked label=deploy, got everything.', type: 'bug', about: 'ticket_list' });
    assert.equal(r.result.isError, undefined, JSON.stringify(r));
    const key = r.result.content[0].text.match(/SB-\d+/)[0];
    const shown = (await c.call('ticket_get', { key })).result.content[0].text;
    assert.match(shown, /reported by: job-42/);
    assert.match(shown, /session: fb-sess/);
    assert.match(shown, /session-board plugin \d+\.\d+\.\d+/);
    assert.match(shown, /about: ticket_list/);
    const created = await c.call('ticket_create', { title: 'Ship it', priority: 'P1' });
    const k2 = created.result.content[0].text.match(/SB-\d+/)[0];
    const blocked = await c.call('ticket_create', { title: 'Announce it', blocked_by: [k2] });
    assert.match(blocked.result.content[0].text, /blocked/);
    const next = (await c.call('ticket_next', { scope: 'all' })).result.content[0].text;
    assert.match(next, new RegExp(`1\\. ${k2} P1`));
    assert.match(next, /1 more blocked/);
    assert.doesNotMatch(next, /label filter/, 'feedback is not work to pick up');
    const cyc = await c.call('ticket_update', { key: k2, blocked_by_add: [blocked.result.content[0].text.match(/SB-\d+/)[0]] });
    assert.equal(cyc.result.isError, true);
    assert.match(cyc.result.content[0].text, /cycle/);
  } finally {
    await c.close();
  }
  const s = await openStore(join(dir, 'board.db'));
  const fb = s.listTickets(parseFilters({ kind: 'feedback' })).tickets;
  assert.equal(fb.length, 1);
  assert.deepEqual([fb[0].subtype, fb[0].created_by, fb[0].status], ['bug', 'job-42', 'todo']);
  assert.equal(s.listTickets(parseFilters({})).tickets.filter((t) => t.kind === 'feedback').length, 0, 'not in the default list');
  assert.equal(s.facets().feedback.open, 1);
  s.updateTicket(fb[0].key, { status: 'done', comment: 'Fixed in 0.3.1' });
  assert.equal(s.facets().feedback.open, 0);
  assert.throws(() => s.updateTicket(fb[0].key, { subtype: 'nonsense' }), /feedback subtype/);
  s.close();
});

test('server: next, move, actors and the actor header', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    const post = (path, body, h = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, ...h }, body: JSON.stringify(body) }).then((r) => r.json());
    const a = await post('/api/tickets', { title: 'A', priority: 'P2', repo: 'x/y' }, { 'x-session-board-actor': 'ci-bot', 'x-session-board-actor-name': encodeURIComponent('CI bot') });
    const b = await post('/api/tickets', { title: 'B', priority: 'P2', repo: 'x/y' });
    assert.equal(a.created_by, 'ci-bot');
    assert.equal(b.created_by, 'user');
    let next = await (await fetch(`${base}/api/tickets/next?repo=x/y`, { headers: auth })).json();
    assert.deepEqual(next.tickets.map((t) => t.key), [a.key, b.key]);
    await post(`/api/tickets/${b.key}/move`, { before: a.key });
    next = await (await fetch(`${base}/api/tickets/next?repo=x/y`, { headers: auth })).json();
    assert.deepEqual(next.tickets.map((t) => t.key), [b.key, a.key]);
    const actors = await (await fetch(`${base}/api/actors`, { headers: auth })).json();
    assert.equal(actors.actors.find((x) => x.id === 'ci-bot').name, 'CI bot');
    const c = await post(`/api/tickets/${a.key}/comments`, { text: 'for you', to: 'user' }, { 'x-session-board-actor': 'ci-bot' });
    const ev = (await (await fetch(`${base}/api/tickets/${c.key}`, { headers: auth })).json()).events.find((e) => e.type === 'comment');
    assert.deepEqual([ev.actor, ev.target], ['ci-bot', 'user']);
    const bad = await fetch(`${base}/api/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'x', assignee: 'not valid!' }) });
    assert.equal(bad.status, 400);
  });
});
