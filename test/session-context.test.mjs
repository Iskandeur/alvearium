// 0.5.4: background-task reports leave the session ticket alone; a waiting alert says what it waits on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, isTaskNotification, parseFilters, quietTransition, sanitizeEvent, waitContext } from '../lib/core.mjs';
import { firstUserPrompt, handleHook, localDbPath } from '../lib/runtime.mjs';
import { openStore } from '../lib/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'sb-ctx-'));

function driver(store) {
  let at = Date.now() - 600_000;
  const id = { sessionId: 's1', repo: 'acme/api', branch: 'main', cwd: '/w/api', host: 'mac', surface: 'terminal' };
  const fire = (event, input = {}) => {
    const t = classify(event, input);
    if (!t) return null;
    return store.ingest(sanitizeEvent({ session: id, transition: t, at: (at += 5000) }));
  };
  return { fire };
}

const sessionTicket = (store) => store.getTicket(store.present(store.findExternal('s1', 'session')).key);
const progress = (n) => `<task-notification>\n<task-id>bx${n}</task-id>\n<status>running</status>\n<summary>render ${n * 10}%</summary>\n</task-notification>`;

test('task notifications: recognised, and only them', () => {
  assert.ok(isTaskNotification(progress(1)));
  assert.ok(isTaskNotification('  <task-notification>x</task-notification>'));
  assert.ok(!isTaskNotification('what does <task-notification> mean?'));
  assert.ok(!isTaskNotification(undefined));
  const t = classify('UserPromptSubmit', { prompt: progress(1) });
  assert.deepEqual([t.state, t.background, t.prompt, t.title], ['working', true, undefined, undefined], 'the report is never the session title');
});

test('Monitor progress every 5 s: the session ticket stays in review, its history does not grow', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('UserPromptSubmit', { prompt: 'render the intro video' });
  fire('Stop', { last_assistant_message: 'Render started in the background, I will watch it.' });
  let s = sessionTicket(store);
  assert.equal(s.status, 'review');
  const before = s.events.length;
  for (let n = 1; n <= 10; n++) {
    fire('UserPromptSubmit', { prompt: progress(n) });
    fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'tail render.log' } });
    fire('Stop', { last_assistant_message: `Still rendering, ${n * 10}%.` });
  }
  s = sessionTicket(store);
  assert.equal(s.status, 'review', 'no review → in_progress → review flip');
  assert.equal(s.events.length, before, 'not one history entry for ten reports');
  assert.equal(s.body, 'Render started in the background, I will watch it.', 'the last real reply stays on the ticket');

  // A report whose turn ends on a question is the human's business.
  fire('UserPromptSubmit', { prompt: progress(11) });
  fire('Stop', { last_assistant_message: 'The render failed at 80%. Should I retry with a lower bitrate?' });
  s = sessionTicket(store);
  assert.equal(s.status, 'waiting_on_user');
  assert.match(s.body, /^❓ Should I retry with a lower bitrate\?/);

  // The human comes back: a real prompt moves the ticket as before.
  fire('UserPromptSubmit', { prompt: 'ship it' });
  assert.equal(sessionTicket(store).status, 'in_progress');
  fire('Stop', { last_assistant_message: 'Shipped.' });
  s = sessionTicket(store);
  assert.deepEqual([s.status, s.body], ['review', 'Shipped.']);
});

test('a background turn that needs the human is not hidden; one that starts mid-turn changes nothing', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('UserPromptSubmit', { prompt: 'deploy' });
  fire('Stop', { last_assistant_message: 'Deploy queued.' });
  fire('UserPromptSubmit', { prompt: progress(1) });
  fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'kubectl rollout restart' } });
  const waits = store.listTickets(parseFilters({ kind: 'permission' })).tickets;
  assert.equal(waits.length, 1, 'the permission the report led to is a ticket');
  fire('PostToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(sessionTicket(store).status, 'in_progress', 'past a question, the turn is visible');
  assert.equal(store.listTickets(parseFilters({ kind: 'permission', archived: '1' })).tickets[0].status, 'done');

  // While the session works, a report is just activity.
  assert.equal(quietTransition({ state: 'working' }, { state: 'working', background: true }), false);
  fire('UserPromptSubmit', { prompt: progress(2) });
  assert.equal(sessionTicket(store).status, 'in_progress');
});

test('waiting alert: the question, the folder and how to resume, on the ticket', async () => {
  const input = {
    session_id: 'a1b2c3d4-0000',
    cwd: '/home/dev/my project',
    notification_type: 'agent_needs_input',
    message: 'Claude is waiting for your input',
    last_assistant_message: 'I found two configs.\n\nShould I keep the staging one or the prod one?',
  };
  const ctx = waitContext(input);
  assert.match(ctx, /^❓ Should I keep the staging one or the prod one\?$/m);
  assert.match(ctx, /^📁 \/home\/dev\/my project$/m);
  assert.match(ctx, /^↩︎ cd '\/home\/dev\/my project' && claude --resume a1b2c3d4-0000$/m);
  assert.match(waitContext({ ...input, cwd: "/w/it's $HOME!" }), /cd '\/w\/it'\\''s \$HOME!' && claude/, 'nothing expands in the copied line');
  assert.doesNotMatch(waitContext({ ...input, last_assistant_message: 'x?' }, { sendText: false }), /❓/, 'SESSION_BOARD_SEND_TEXT=0 keeps the text home');
  assert.match(waitContext({ ...input, last_assistant_message: 'Done with the scan.' }), /^💬 Done with the scan\.$/m, 'no question: the reply it follows');

  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('Notification', input);
  const [w] = store.listTickets(parseFilters({ kind: 'question' })).tickets;
  assert.equal(w.title, 'Should I keep the staging one or the prod one?', 'a generic notification is titled by its question');
  assert.match(w.body, /^Claude is waiting for your input\n\n❓ Should I keep/);
  assert.match(w.body, /claude --resume a1b2c3d4-0000/);
});

test('session title from the transcript when its first prompt never reached the board', async () => {
  const dir = tmp();
  const transcript = join(dir, 's.jsonl');
  const line = (o) => JSON.stringify(o);
  writeFileSync(
    transcript,
    [
      line({ type: 'summary', summary: 'x' }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' } }),
      line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'migrate the billing tables to the new schema' }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Which database, staging or prod?' }] } }),
      line({ type: 'user', message: { role: 'user', content: 'later prompt' } }),
    ].join('\n') + '\n',
  );
  assert.equal(firstUserPrompt(transcript), 'migrate the billing tables to the new schema');
  assert.equal(firstUserPrompt(join(dir, 'missing.jsonl')), '');

  const cwd = join(dir, 'proj');
  const env = { SESSION_BOARD_DIR: tmp() };
  const base = { session_id: 'sess-1', cwd, transcript_path: transcript };
  assert.equal(await handleHook('Notification', { ...base, notification_type: 'agent_needs_input', message: 'Claude is waiting for your input' }, { env, now: Date.now() }), 'local');
  const store = await openStore(localDbPath(env));
  try {
    const s = store.present(store.findExternal('sess-1', 'session'));
    assert.equal(s.title, 'migrate the billing tables to the new schema', 'not "Session in proj"');
    const [w] = store.listTickets(parseFilters({ kind: 'question' })).tickets;
    assert.equal(w.title, 'Which database, staging or prod?', 'the last question, read from the transcript');
    assert.match(w.body, new RegExp(`📁 ${cwd.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(w.body, /claude --resume sess-1/);
  } finally {
    store.close();
  }
});

test('a generic permission notification never renames the approval ticket, question or not', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('UserPromptSubmit', { prompt: 'migrate' });
  fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run migrate' } });
  fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', last_assistant_message: 'Shall I run the migration?' });
  const [w] = store.listTickets(parseFilters({ kind: 'permission' })).tickets;
  assert.equal(w.title, 'Approve Bash: npm run migrate');
});

test('a report that arrives while a question waits does not keep the question open after the answer', async () => {
  const store = await openStore(':memory:');
  const { fire } = driver(store);
  fire('UserPromptSubmit', { prompt: 'clean up' });
  fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -r build' } });
  fire('UserPromptSubmit', { prompt: progress(1) });
  fire('PostToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(store.listTickets(parseFilters({ kind: 'permission', archived: '1' })).tickets[0].status, 'done');
  assert.equal(sessionTicket(store).status, 'in_progress');
});

test('legacy import: an idle "your turn" is a review, not a context-free question ticket', async () => {
  const store = await openStore(':memory:');
  store.importLegacy([{ sessionId: 'old', state: 'waiting', kind: 'idle', detail: 'Claude is waiting for your input', cwd: '/w/x', lastSeen: Date.now() }]);
  assert.equal(store.listTickets(parseFilters({ kind: 'question', archived: '1' })).tickets.length, 0);
  assert.equal(store.present(store.findExternal('old', 'session')).status, 'review');
});
