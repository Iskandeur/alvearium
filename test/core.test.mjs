import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTransition,
  buildBoard,
  classify,
  describeTool,
  displayState,
  findPrUrl,
  isExpired,
  promptTitle,
  label,
  renderText,
  repoFromRemote,
  sanitizeEvent,
  shouldSend,
  statusText,
  STALE_MS,
  THROTTLE_MS,
  CLOSED_TTL_MS,
  markdownToTerminal,
} from '../lib/core.mjs';

test('mapping: prompts and tool calls mean working', () => {
  assert.equal(classify('UserPromptSubmit', { prompt: 'fix the login bug' }).state, 'working');
  assert.equal(classify('UserPromptSubmit', { prompt: 'fix the login bug' }).prompt, 'fix the login bug');
  const pre = classify('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.deepEqual([pre.state, pre.detail, pre.heartbeat], ['working', 'Bash: npm test', true]);
  assert.equal(classify('PostToolUse', { tool_name: 'Edit' }).state, 'working');
});

test('mapping: everything that needs the human means waiting', () => {
  const perm = classify('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.equal(perm.state, 'waiting');
  assert.equal(perm.kind, 'permission');
  assert.match(perm.detail, /Permission: Bash: rm -rf build/);
  for (const type of ['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'agent_needs_input']) {
    const t = classify('Notification', { notification_type: type, message: 'Claude needs your input' });
    assert.equal(t.state, 'waiting', type);
    assert.equal(t.detail, 'Claude needs your input');
  }
  assert.equal(classify('Elicitation', { message: 'Pick a region' }).detail, 'Pick a region');
});

test('mapping: stop is review with PR link, failure and end', () => {
  const stop = classify('Stop', { last_assistant_message: 'Done. Opened https://github.com/acme/app/pull/42 for you.' });
  assert.equal(stop.state, 'review');
  assert.equal(stop.pr, 'https://github.com/acme/app/pull/42');
  assert.equal(classify('Notification', { notification_type: 'agent_completed' }).state, 'review');
  assert.equal(classify('StopFailure', { error: 'rate_limit' }).state, 'failed');
  assert.equal(classify('SessionEnd', { reason: 'logout' }).state, 'closed');
  assert.equal(classify('SessionStart', { source: 'startup' }).state, 'idle');
});

test('mapping: unknown events and notifications are ignored', () => {
  assert.equal(classify('SubagentStop', {}), null);
  assert.equal(classify('Notification', { notification_type: 'auth_success' }), null);
  assert.equal(classify('Bogus', {}), null);
});

test('mapping: event name falls back to hook_event_name', () => {
  assert.equal(classify(undefined, { hook_event_name: 'Stop' }).state, 'review');
});

test('privacy: sendText=false strips prompts, tool input and messages', () => {
  const p = classify('UserPromptSubmit', { prompt: 'secret plan' }, { sendText: false });
  assert.equal(p.detail, '');
  assert.equal(p.prompt, '');
  assert.equal(classify('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat .env' } }, { sendText: false }).detail, 'Bash');
  assert.equal(classify('Stop', { last_assistant_message: 'private' }, { sendText: false }).detail, '');
});

test('throttle: state changes always go, working heartbeats at most every 20 s', () => {
  const work = { state: 'working', heartbeat: true };
  assert.equal(shouldSend(undefined, work, 0), true);
  assert.equal(shouldSend({ state: 'working', at: 0 }, work, THROTTLE_MS - 1), false);
  assert.equal(shouldSend({ state: 'working', at: 0 }, work, THROTTLE_MS), true);
  assert.equal(shouldSend({ state: 'waiting', at: 0 }, work, 1), true, 'waiting → working is never throttled');
  assert.equal(shouldSend({ state: 'working', at: 0 }, { state: 'working' }, 1), true, 'a new prompt is not a heartbeat');
});

test('stale: working without heartbeat for 30 min', () => {
  const rec = { state: 'working', lastSeen: 0 };
  assert.equal(displayState(rec, STALE_MS), 'working');
  assert.equal(displayState(rec, STALE_MS + 1), 'stale');
  assert.equal(displayState({ state: 'waiting', lastSeen: 0 }, STALE_MS * 10), 'waiting', 'waiting never goes stale');
});

test('applyTransition: keeps first prompt as title, tracks since, idle does not demote review', () => {
  let r = applyTransition(null, classify('UserPromptSubmit', { prompt: 'first task' }), { sessionId: 's1', repo: 'a/b' }, 100);
  assert.equal(r.title, 'first task');
  assert.equal(r.since, 100);
  r = applyTransition(r, classify('UserPromptSubmit', { prompt: 'second' }), { sessionId: 's1' }, 200);
  assert.equal(r.title, 'first task');
  assert.equal(r.since, 100, 'working → working keeps since');
  r = applyTransition(r, classify('Stop', { last_assistant_message: 'all good' }), { sessionId: 's1' }, 300);
  assert.equal(r.state, 'review');
  r = applyTransition(r, classify('Notification', { notification_type: 'idle_prompt', message: 'waiting' }), { sessionId: 's1' }, 400);
  assert.equal(r.state, 'review', 'idle_prompt keeps the richer review ticket');
  assert.equal(r.lastSeen, 400);
  r = applyTransition(r, classify('Notification', { notification_type: 'permission_prompt', message: 'Allow?' }), { sessionId: 's1' }, 500);
  assert.equal(r.state, 'waiting', 'a real question still moves it to waiting');
  assert.equal(r.repo, 'a/b', 'identity survives partial updates');
});

test('board: columns, ordering, stale, dismissed and expiry', () => {
  const now = 10 * 60 * 60 * 1000;
  const recs = [
    { sessionId: 'w1', state: 'waiting', since: now - 5000, lastSeen: now - 5000 },
    { sessionId: 'w2', state: 'waiting', since: now - 9000, lastSeen: now - 9000 },
    { sessionId: 'f1', state: 'failed', since: now - 1000, lastSeen: now - 1000 },
    { sessionId: 'k1', state: 'working', lastSeen: now - 1000 },
    { sessionId: 'k2', state: 'working', lastSeen: now - STALE_MS - 1 },
    { sessionId: 'r1', state: 'review', lastSeen: now - 100 },
    { sessionId: 'r2', state: 'review', lastSeen: now - 100, dismissed: true },
    { sessionId: 'c1', state: 'closed', lastSeen: now - CLOSED_TTL_MS - 1 },
    { sessionId: 'i1', state: 'idle', lastSeen: now },
  ];
  const b = buildBoard(recs, now);
  assert.deepEqual(b.waiting.map((r) => r.sessionId), ['w2', 'w1', 'f1'], 'longest wait first');
  assert.deepEqual(b.inProgress.map((r) => [r.sessionId, r.display]), [['k1', 'working'], ['k2', 'stale']]);
  assert.deepEqual(b.review.map((r) => r.sessionId), ['r1']);
  assert.deepEqual(b.counts, { waiting: 3, working: 1, stale: 1, review: 1, idle: 1 });
  assert.equal(isExpired(recs[7], now), true);
  assert.equal(statusText(b.counts), '3 waiting · 1 working · 1 review');
  const text = renderText(b);
  assert.match(text, /WAITING ON YOU \(3\)/);
  assert.match(text, /\[stale\]/);
});

test('helpers: repo, label, PR, tool description', () => {
  assert.equal(repoFromRemote('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repoFromRemote('https://github.com/acme/app'), 'acme/app');
  assert.equal(repoFromRemote('http://local_proxy@127.0.0.1:1234/git/acme/app'), 'acme/app');
  assert.equal(repoFromRemote(''), null);
  assert.equal(label({ repo: 'acme/app', branch: 'feat/x' }), 'acme/app@feat/x');
  assert.equal(label({ cwd: '/work/proj', branch: 'HEAD' }), 'proj');
  assert.equal(findPrUrl('see https://github.com/a/b/pull/1 then https://github.com/a/b/pull/2'), 'https://github.com/a/b/pull/2');
  assert.equal(findPrUrl('nothing'), null);
  assert.equal(describeTool('Read', { file_path: '/x/y.ts' }), 'Read: /x/y.ts');
  assert.equal(describeTool('Task', {}), 'Task');
});

test('sanitizeEvent: rejects junk, clamps strings, keeps only https links', () => {
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent({ session: { sessionId: '../etc' }, transition: { state: 'working' } }), null);
  assert.equal(sanitizeEvent({ session: { sessionId: 'abc' }, transition: { state: 'stale' } }), null);
  const e = sanitizeEvent({
    session: { sessionId: 'abc-123', surface: 'cloud', url: 'javascript:alert(1)', repo: 'x'.repeat(500) },
    transition: { state: 'review', detail: 'ok', pr: 'https://github.com/a/b/pull/3' },
  });
  assert.equal(e.identity.surface, 'cloud');
  assert.equal(e.identity.url, undefined);
  assert.equal(e.identity.repo.length, 200);
  assert.equal(e.transition.pr, 'https://github.com/a/b/pull/3');
});

test('promptTitle: an attached upload becomes a short « 📎 name » at the end, not a path at the start', () => {
  assert.equal(
    promptTitle('@"/root/.claude/uploads/71689423-d907-5604-b583-8c8bc30f43c6/9a09b386-AgenticSOCGuideFRpdf.pdf" capitalise, lis et dis-moi ce que tu en penses'),
    'Capitalise, lis et dis-moi ce que tu en penses · 📎 AgenticSOCGuideFRpdf.pdf',
  );
  assert.equal(promptTitle('@"/root/.claude/uploads/a/b/1234abcd-photo.png"'), '📎 photo.png');
  assert.equal(promptTitle('compare @./a/x.md et @./b/y.md'), 'compare et · 📎 x.md +1');
  assert.equal(promptTitle('plain prompt, no file'), 'plain prompt, no file');
  assert.ok(promptTitle('x '.repeat(200) + '@"/u/12345678-long-name.pdf"').length <= 120);
  assert.equal(promptTitle('send to me@example.com please'), 'send to me@example.com please');
});

test('the session title comes from the cleaned prompt', () => {
  const t = classify('UserPromptSubmit', { prompt: '@"/root/.claude/uploads/u/9a09b386-Guide.pdf" lis' });
  const rec = applyTransition(null, t, { sessionId: 's' });
  assert.equal(rec.title, 'Lis · 📎 Guide.pdf');
});
