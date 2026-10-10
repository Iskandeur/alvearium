import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, columnOf, ftsQuery, parseFilters, sanitizeEvent, sanitizeTicketInput } from '../lib/core.mjs';
import { openStore } from '../lib/store.mjs';

const DAY = 86400000;

/** Drive a store with hook events, each one millisecond after the previous. */
function driver(store, identity = {}) {
  let at = Date.now() - 60_000;
  const id = { sessionId: 's1', repo: 'acme/api', branch: 'main', cwd: '/w/api', host: 'mac', surface: 'terminal', ...identity };
  const fire = (event, input = {}, when = ++at) => {
    const t = classify(event, input);
    if (!t) return null;
    return store.ingest(sanitizeEvent({ session: id, transition: t, at: when }));
  };
  return { fire, id, tick: () => ++at };
}

const sessionTicket = (store, sid = 's1') => store.present(store.findExternal(sid, 'session'));
const waits = (store) => store.listTickets(parseFilters({ kind: 'permission,question', archived: '1' })).tickets;

test('hooks: one session ticket follows the session; permission tickets open and close by themselves', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('SessionStart', { source: 'startup' });
  assert.equal(store.counts().tickets, 0, 'no ticket for a session that has not started working');
  fire('UserPromptSubmit', { prompt: 'fix the token refresh race' });
  let s = sessionTicket(store);
  assert.deepEqual([s.status, s.kind, s.assignee, s.source, s.title, s.repo, s.machine], ['in_progress', 'session', 'claude', 'hook', 'fix the token refresh race', 'acme/api', 'mac']);

  fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run migrate' } });
  fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  let w = waits(store);
  assert.equal(w.length, 1, 'PermissionRequest + its Notification = one ticket');
  assert.deepEqual([w[0].title, w[0].status, w[0].assignee, w[0].parent_key], ['Approve Bash: npm run migrate', 'waiting_on_user', 'user', s.key]);
  assert.equal(columnOf(w[0]), 'waiting');

  fire('PostToolUse', { tool_name: 'Bash', tool_input: {} });
  w = waits(store);
  assert.equal(w[0].status, 'done', 'closed when the session resumes');
  const hist = store.getTicket(w[0].key).events;
  assert.equal(hist.at(-1).actor, 'hook');
  assert.equal(hist.at(-1).text, 'Answered, the session resumed');

  fire('Stop', { last_assistant_message: 'Fixed. https://github.com/acme/api/pull/412' });
  s = sessionTicket(store);
  assert.deepEqual([s.status, s.assignee, s.column], ['review', 'user', 'waiting']);
  assert.equal(s.links.find((l) => l.type === 'pr').url, 'https://github.com/acme/api/pull/412');

  fire('UserPromptSubmit', { prompt: 'also add a test' });
  fire('Stop', { last_assistant_message: 'Test added.' });
  const all = store.listTickets(parseFilters({ kind: 'session' })).tickets;
  assert.equal(all.length, 1, 'one review ticket per session, not one per turn');
  assert.equal(all[0].body, 'Test added.');
  assert.equal(all[0].title, 'fix the token refresh race', 'title = first prompt');
  assert.equal(all[0].links.length, 1, 'the PR link is kept');

  fire('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.equal(sessionTicket(store).status, 'review', 'idle_prompt does not demote review');

  // A turn that ends on a question waits on its human; the question leads the body.
  fire('UserPromptSubmit', { prompt: 'and the docs' });
  fire('Stop', { last_assistant_message: 'Docs drafted.\n\nDo you want them in the README or in docs/?' });
  s = sessionTicket(store);
  assert.deepEqual([s.status, s.assignee], ['waiting_on_user', 'user']);
  assert.match(s.body, /^❓ Do you want them in the README or in docs\/\?/);
  fire('UserPromptSubmit', { prompt: 'docs/' });
  assert.equal(sessionTicket(store).status, 'in_progress', 'answered: back to work');

  fire('Elicitation', { message: 'Which environment?' });
  assert.equal(waits(store).filter((t) => t.status === 'waiting_on_user')[0].title, 'Which environment?');
  fire('SessionEnd', { reason: 'exit' });
  assert.equal(sessionTicket(store).status, 'done');
  assert.ok(waits(store).every((t) => t.status !== 'waiting_on_user'), 'open questions cancelled at session end');
});

test('hooks: async events out of order do not close a fresh question', async () => {
  const store = await openStore(':memory:');
  const { fire, tick } = driver(store);
  fire('UserPromptSubmit', { prompt: 'deploy' });
  const preAt = tick();
  const permAt = tick();
  fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make deploy' } }, permAt);
  fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'make deploy' } }, preAt); // arrives late
  assert.equal(waits(store)[0].status, 'waiting_on_user');
});

test('hooks: StopFailure → failed on you; a new prompt reopens; user edits survive hook updates', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('UserPromptSubmit', { prompt: 'long job' });
  fire('StopFailure', { error_type: 'rate_limit', error_message: 'Rate limit exceeded' });
  let s = sessionTicket(store);
  assert.deepEqual([s.status, s.column], ['failed', 'waiting']);
  assert.match(store.getTicket(s.key).events.at(-1).text, /rate_limit: Rate limit exceeded/);
  store.updateTicket(s.key, { title: 'Nightly export', labels: ['ops'] });
  fire('UserPromptSubmit', { prompt: 'retry' });
  s = sessionTicket(store);
  assert.deepEqual([s.status, s.title, s.labels], ['in_progress', 'Nightly export', ['ops']]);
  store.updateTicket(s.key, { status: 'done' });
  fire('PreToolUse', { tool_name: 'Read', tool_input: {} });
  const ev = store.getTicket(s.key).events.at(-1);
  assert.deepEqual([ev.type, ev.from_status, ev.to_status], ['reopened', 'done', 'in_progress']);
});

test('hooks: cloud sessions carry their link; tickets inherit repo/branch/origin', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store, { sessionId: 'c1', surface: 'cloud', host: 'claude.ai/code', url: 'https://claude.ai/code/session_01ABC' });
  fire('UserPromptSubmit', { prompt: 'cloud work' });
  const s = sessionTicket(store, 'c1');
  assert.equal(s.origin, 'cloud');
  assert.equal(s.links[0].type, 'session');
  assert.equal(s.session.url, 'https://claude.ai/code/session_01ABC');
});

test('tickets: create, sub-tickets, labels, update validation, history', async () => {
  const store = await openStore(':memory:');
  const parent = store.createTicket({ title: 'Release 2.0', labels: ['Release', 'release', ' big launch '], priority: 'high', repo: 'acme/api' });
  assert.deepEqual(parent.labels, ['release', 'big-launch']);
  const child = store.createTicket({ title: 'Changelog', parent: parent.key }, { actor: 'claude' });
  assert.equal(child.parent_key, parent.key);
  assert.equal(child.repo, 'acme/api', 'sub-ticket inherits the context');
  assert.equal(child.kind, 'task');
  assert.equal(store.getTicket(parent.key).children.length, 1);
  assert.throws(() => store.updateTicket(parent.key, { status: 'nope' }), /status must be/);
  assert.throws(() => store.updateTicket(parent.key, { parent: parent.key }), /own parent/);
  assert.throws(() => store.createTicket({ title: 'x', parent: 'ALV-999' }), /parent not found/);
  store.updateTicket(child.key, { status: 'done' }, { actor: 'claude' });
  const got = store.getTicket(child.key);
  assert.ok(got.closed_at);
  assert.deepEqual(got.events.map((e) => [e.actor, e.type]), [['claude', 'created'], ['claude', 'status']]);
  assert.equal(store.listTickets(parseFilters({ parent: parent.key })).total, 1);
  assert.equal(store.listTickets(parseFilters({ priority: 'high' })).total, 1);
  assert.equal(store.listTickets(parseFilters({ sort: 'priority' })).tickets[0].key, parent.key);
});

test('filters: status groups, assignee, origin, machine, dates, search fallbacks', async () => {
  const store = await openStore(':memory:');
  const now = Date.now();
  store.createTicket({ title: 'Rotate the token', machine: 'mac', origin: 'terminal' }, { now: now - 3 * DAY });
  store.createTicket({ title: 'Review PR 12', status: 'review', assignee: 'user', origin: 'cloud' }, { now: now - DAY });
  const c = store.createTicket({ title: 'Profile the parser', assignee: 'claude', status: 'in_progress' }, { now });
  store.comment(c.key, 'flamegraph shows the tokenizer');
  const n = (q) => store.listTickets(parseFilters(q)).total;
  assert.equal(n({ status: 'open' }), 3);
  assert.equal(n({ status: 'closed' }), 0);
  assert.equal(n({ assignee: 'claude' }), 1);
  assert.equal(n({ origin: 'cloud' }), 1);
  assert.equal(n({ machine: 'mac' }), 1);
  assert.equal(n({ created_after: String(now - 2 * DAY) }), 2);
  assert.equal(n({ created_before: new Date(now - 2 * DAY).toISOString() }), 1);
  assert.equal(n({ q: 'flamegra' }), 1, 'prefix search in comments');
  store.updateTicket(c.key, { labels: ['perf'] });
  assert.equal(n({ q: 'perf' }), 1, 'labels are searchable');
  assert.equal(n({ q: 'ROTATE token' }), 1, 'every word, any case');
  assert.equal(n({ q: '"); DROP TABLE tickets; --' }), 0, 'hostile input is just words');
  assert.equal(ftsQuery('a-b c'), '"a"* AND "b"* AND "c"*');
  store.fts = false; // LIKE fallback, same answers
  assert.equal(n({ q: 'flamegraph' }), 1);
  assert.equal(n({ q: 'perf' }), 1);
  assert.equal(n({ q: '100%' }), 0);
});

test('archive: done tickets older than 30 days leave the default views, never the database', async () => {
  const store = await openStore(':memory:');
  const now = Date.now();
  const old = store.createTicket({ title: 'Old thing' }, { now: now - 40 * DAY });
  store.updateTicket(old.key, { status: 'done' }, { now: now - 35 * DAY });
  const recent = store.createTicket({ title: 'Recent thing' });
  store.updateTicket(recent.key, { status: 'done' });
  assert.equal(store.listTickets(parseFilters({})).total, 1);
  assert.equal(store.listTickets(parseFilters({ archived: '1' })).total, 2);
  assert.equal(store.listTickets(parseFilters({ archived: 'only' })).tickets[0].key, old.key);
  assert.equal(store.ticketBoard(parseFilters({})).counts.done, 1);
  assert.ok(store.getTicket(old.key), 'still reachable by key');
});

test('validation: sanitizeTicketInput and links', () => {
  assert.match(sanitizeTicketInput({}).error, /title/);
  assert.deepEqual(sanitizeTicketInput({ status: 'done' }, { partial: true }).value, { status: 'done' });
  const { value } = sanitizeTicketInput({ title: 't', links: ['https://github.com/a/b/pull/1', 'src/app.ts', 'javascript:alert(1)', 'http://x.test'] });
  assert.deepEqual(value.links.map((l) => l.type), ['pr', 'file']);
  assert.match(sanitizeTicketInput({ title: 't', session_id: 'bad id!' }).error, /session_id/);
});

test('volume: 3 000 tickets stay fast to filter, search and group', async () => {
  const store = await openStore(':memory:');
  const repos = ['acme/api', 'acme/web', 'acme/infra'];
  const statuses = ['todo', 'in_progress', 'waiting_on_user', 'review', 'done'];
  store.tx(() => {
    for (let i = 0; i < 3000; i++) {
      const at = Date.now() - i * 60_000;
      store.insertTicket(
        { title: `Ticket ${i} about ${i % 7 === 0 ? 'billing' : 'search'}`, status: statuses[i % 5], repo: repos[i % 3], session_id: 'sess' + (i % 40), labels: [i % 2 ? 'odd' : 'even'], source: 'user' },
        'user',
        at,
      );
    }
  });
  const t0 = performance.now();
  const page = store.listTickets(parseFilters({ repo: 'acme/web', status: 'open', limit: '50' }));
  const found = store.listTickets(parseFilters({ q: 'billing', label: 'odd' }));
  const board = store.ticketBoard(parseFilters({ session: 'sess7' }));
  const ms = performance.now() - t0;
  assert.equal(page.tickets.length, 50);
  assert.equal(page.total, 800);
  assert.ok(found.total > 100);
  assert.equal(board.columns.todo.length + board.columns.inProgress.length + board.columns.waiting.length + board.counts.done, 75);
  assert.ok(ms < 1500, `queries took ${ms.toFixed(0)} ms`);
});
