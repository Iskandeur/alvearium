// 0.9.0: the owner tags one Claude Code session from a ticket (@session/1a2b3c4d); the comment reaches
// that session at its next prompt, through the UserPromptSubmit hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, sanitizeEvent } from '../lib/core.mjs';
import { handleHook, localDbPath, mentionsContext } from '../lib/runtime.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const TOKEN = 'x'.repeat(32);
const SID = '1a2b3c4d-0000-4000-8000-000000000001';
const OTHER = '9f8e7d6c-0000-4000-8000-000000000002';

async function clocked(opts = {}) {
  let t = Date.now() - 600_000;
  const store = await openStore(':memory:', { now: () => (t += 1000), ...opts });
  return store;
}
function open(store, sessionId, prompt = 'fix the login page') {
  const id = { sessionId, repo: 'acme/api', branch: 'main', cwd: '/w/api', host: 'mac', surface: 'terminal' };
  return store.ingest(sanitizeEvent({ session: id, transition: classify('UserPromptSubmit', { prompt }), at: store.clock() }));
}

test('an owner comment tagging a session is queued once, then taken once', async () => {
  const store = await clocked();
  open(store, SID);
  open(store, OTHER);
  const t = store.createTicket({ title: 'Look at the logs', assignee: 'user' }, { actor: 'user' });
  store.comment(t.key, '@session/1a2b3c4d look at this, and again @session/1a2b3c4d', { actor: 'user' });
  const got = store.takeSessionMentions(SID);
  assert.equal(got.length, 1, 'one comment, one delivery, even when the handle appears twice');
  assert.equal(got[0].key, t.key);
  assert.equal(got[0].title, 'Look at the logs');
  assert.match(got[0].text, /look at this/);
  assert.deepEqual(store.takeSessionMentions(SID), [], 'delivered: not again');
  assert.deepEqual(store.takeSessionMentions(OTHER), [], 'the other session was not tagged');
});

test('only the owner can push a comment into a session; unknown or ambiguous handles are ignored', async () => {
  const store = await clocked();
  open(store, SID);
  open(store, '1a2b3c4d-ffff-4000-8000-000000000003');
  const t = store.createTicket({ title: 'X', assignee: 'crew' }, { actor: 'user' });
  store.comment(t.key, '@session/1a2b3c4d-0000 do it', { actor: 'crew' });
  assert.deepEqual(store.takeSessionMentions(SID), [], 'an agent cannot instruct a session');
  store.comment(t.key, '@session/1a2b3c4d do it', { actor: 'user' });
  assert.deepEqual(store.takeSessionMentions(SID), [], 'two sessions start with 1a2b3c4d: nobody gets it');
  store.comment(t.key, '@session/1a2b3c4d-0000 now', { actor: 'user' });
  assert.equal(store.takeSessionMentions(SID).length, 1, 'a longer prefix names one session');
  assert.equal(store.sessionByHandle('session/1a2b'), null, 'a prefix under 6 characters names nobody');
});

test('a comment addressed to a session only does not hand the ticket to the router', async () => {
  const store = await clocked({ defaultRouter: 'crew/router' });
  open(store, SID);
  const a = store.createTicket({ title: 'A', status: 'waiting_on_user', assignee: 'user' });
  assert.equal(store.comment(a.key, '@session/1a2b3c4d your call', { actor: 'user' }).assignee, 'user');
  const b = store.createTicket({ title: 'B', status: 'waiting_on_user', assignee: 'user' });
  assert.equal(store.comment(b.key, 'plain answer', { actor: 'user' }).assignee, 'crew/router', 'without a session tag, unchanged');
});

test('taggable sessions: recent and not closed, each with its handle', async () => {
  const store = await clocked();
  open(store, SID, 'refactor the parser');
  const list = store.taggableSessions(store.clock());
  assert.equal(list.length, 1);
  assert.equal(list[0].handle, 'session/1a2b3c4d');
  assert.equal(list[0].repo, 'acme/api');
  assert.deepEqual(store.taggableSessions(store.clock() + 3_600_000), [], 'quiet for an hour: not offered');
});

test('mentionsContext: the comment, its ticket and how to answer; nothing when empty', () => {
  assert.equal(mentionsContext([]), '');
  assert.equal(mentionsContext(null), '');
  const text = mentionsContext([{ key: 'ALV-7', title: 'Logs', text: 'look here', at: 1 }]);
  assert.match(text, /tagged this session in a comment/);
  assert.match(text, /- ALV-7 \(Logs\): look here/);
  assert.match(text, /ticket_comment/);
});

test('local board: the prompt hook takes the queued comments for its session', async () => {
  const env = { SESSION_BOARD_DIR: mkdtempSync(join(tmpdir(), 'sb-mention-')) };
  const base = { session_id: SID, cwd: '/w/api' };
  assert.equal(await handleHook('UserPromptSubmit', { ...base, prompt: 'start' }, { env }), 'local');
  const store = await openStore(localDbPath(env));
  const t = store.createTicket({ title: 'Check', assignee: 'user' }, { actor: 'user' });
  store.comment(t.key, '@session/1a2b3c4d please check', { actor: 'user' });
  store.close();
  const out = {};
  await handleHook('Stop', { ...base, last_assistant_message: 'done' }, { env, now: Date.now() + 1000, out });
  assert.equal(out.mentions, undefined, 'only a prompt takes them');
  await handleHook('UserPromptSubmit', { ...base, prompt: 'next' }, { env, now: Date.now() + 2000, out });
  assert.equal(out.mentions.length, 1);
  assert.match(out.mentions[0].text, /please check/);
});

test('over HTTP: the event reply carries the mentions only when asked, and lists taggable sessions', async () => {
  const store = await clocked();
  const server = createServer(createApp({ token: TOKEN, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const event = (extra = {}) =>
    fetch(`${base}/api/event`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ v: 1, session: { sessionId: SID, repo: 'acme/api' }, transition: classify('UserPromptSubmit', { prompt: 'go' }), at: Date.now(), ...extra }),
    }).then((r) => r.json());
  try {
    await event();
    const tag = await (await fetch(`${base}/api/sessions/taggable`, { headers: h })).json();
    assert.equal(tag.sessions[0].handle, 'session/1a2b3c4d');
    const t = store.createTicket({ title: 'T', assignee: 'user' }, { actor: 'user' });
    store.comment(t.key, '@session/1a2b3c4d hello', { actor: 'user' });
    assert.equal((await event()).mentions, undefined, 'an older hook does not ask: kept for later');
    const reply = await event({ mentions: true });
    assert.equal(reply.mentions.length, 1);
    assert.equal(reply.mentions[0].key, t.key);
    assert.deepEqual((await event({ mentions: true })).mentions, []);
  } finally {
    server.close();
    store.close();
  }
});
