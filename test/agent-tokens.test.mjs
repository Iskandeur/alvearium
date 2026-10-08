// 0.3.7: agent tokens. A request made with an agent token acts as that agent, never as the user,
// whatever its headers say. The main token keeps its old behaviour (no header = the user).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDisplayName, authOf, createApp, parseAgentTokens, readAgentTokens, scopeActor } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const MAIN = 'm'.repeat(32);
const AGENT = 'a'.repeat(32);
const OTHER = 'o'.repeat(32);
const agents = [
  { actor: 'lupi', token: AGENT },
  { actor: 'ci-bot', token: OTHER },
];

async function withServer(store, fn) {
  const server = createServer(createApp({ token: MAIN, agents, store, page: '<html>board</html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const h = (token, extra = {}) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });
const call = (base, method, path, body, headers) => fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (res) => ({ status: res.status, body: await res.json() });
const detail = async (base, key) => (await fetch(`${base}/api/tickets/${key}`, { headers: h(MAIN) })).json();
const authors = (t) => [t.created_by, ...t.events.map((e) => e.actor)];

test('agent token without an actor header: never attributed to the user', async () => {
  await withServer(await openStore(':memory:'), async (base) => {
    const { status, body } = await json(await call(base, 'POST', '/api/tickets', { title: 'Pay the invoice' }, h(AGENT)));
    assert.equal(status, 201);
    assert.equal(body.created_by, 'lupi');
    assert.equal(body.source, 'claude', 'a ticket opened by an agent is not a human ticket');
    await call(base, 'POST', `/api/tickets/${body.key}`, { status: 'done', comment: 'paid' }, h(AGENT));
    await call(base, 'POST', `/api/tickets/${body.key}/comments`, { text: 'receipt filed' }, h(AGENT));
    await call(base, 'POST', `/api/tickets/${body.key}/move`, { after: null }, h(AGENT));
    const t = await detail(base, body.key);
    assert.ok(t.events.length >= 4);
    assert.ok(!authors(t).includes('user'), `authors: ${authors(t).join(', ')}`);
    assert.ok(authors(t).every((a) => a === 'lupi'));
  });
});

test('agent token: the header can name a sub-actor, never someone else', async () => {
  await withServer(await openStore(':memory:'), async (base) => {
    const cases = [
      ['user', 'lupi'],
      ['USER', 'lupi'],
      ['claude', 'lupi'],
      ['hook', 'lupi'],
      ['ci-bot', 'lupi'],
      ['lupix', 'lupi'],
      ['lupi', 'lupi'],
      ['lupi/job-42', 'lupi/job-42'],
      ['lupi/job-42/Explore', 'lupi/job-42/Explore'],
      ['../user', 'lupi'],
      ['', 'lupi'],
    ];
    for (const [header, want] of cases) {
      const { body } = await json(await call(base, 'POST', '/api/tickets', { title: `as ${header || 'nothing'}` }, h(AGENT, { 'x-session-board-actor': header })));
      assert.equal(body.created_by, want, `header ${JSON.stringify(header)}`);
    }
    const ci = await json(await call(base, 'POST', '/api/tickets', { title: 'from CI' }, h(OTHER, { 'x-session-board-actor': 'lupi' })));
    assert.equal(ci.body.created_by, 'ci-bot', 'one agent cannot write as another');
  });
});

test('agent token: a display name that reads as the person is dropped', async () => {
  const store = await openStore(':memory:');
  await withServer(store, async (base) => {
    await call(base, 'POST', '/api/tickets', { title: 'x' }, h(AGENT, { 'x-session-board-actor-name': 'You' }));
    await call(base, 'POST', '/api/tickets', { title: 'y' }, h(AGENT, { 'x-session-board-actor': 'lupi/job-1', 'x-session-board-actor-name': 'Job 1' }));
    const actors = (await (await fetch(`${base}/api/actors`, { headers: h(MAIN) })).json()).actors;
    const lupi = actors.find((a) => a.id === 'lupi');
    assert.ok(lupi, 'the agent is known');
    assert.notEqual(String(lupi.name).toLowerCase(), 'you');
    assert.equal(actors.find((a) => a.id === 'lupi/job-1')?.name, 'Job 1');
  });
});

test('agent token: hook events belong to the agent, even when they claim the user', async () => {
  await withServer(await openStore(':memory:'), async (base) => {
    const evt = (state, extra = {}) => ({ v: 1, session: { sessionId: 'job-7', repo: 'acme/app', actor: 'user', actorName: 'You', ...extra }, transition: { state }, at: Date.now() });
    assert.equal((await call(base, 'POST', '/api/event', evt('working'), h(AGENT))).status, 202);
    assert.equal((await call(base, 'POST', '/api/event', evt('review'), h(AGENT))).status, 202);
    assert.equal((await call(base, 'POST', '/api/dismiss', { sessionId: 'job-7' }, h(AGENT))).status, 200);
    const list = (await (await fetch(`${base}/api/tickets?session=job-7&archived=1`, { headers: h(MAIN) })).json()).tickets;
    assert.ok(list.length >= 1);
    for (const t of list) assert.ok(!authors(await detail(base, t.key)).includes('user'), `${t.key} has a user-authored line`);
    const actors = (await (await fetch(`${base}/api/actors`, { headers: h(MAIN) })).json()).actors;
    assert.ok(actors.some((a) => a.id === 'lupi'), 'the session is the agent');
  });
});

test('agent token: no import, no session deletion (both replay or erase history)', async () => {
  await withServer(await openStore(':memory:'), async (base) => {
    const imp = { board: 'board-1', machine: 'laptop', sessions: [], tickets: [{ id: 1, seq: 1, title: 'forged', created_by: 'user', events: [{ at: 1, actor: 'user', type: 'created' }] }] };
    assert.equal((await call(base, 'POST', '/api/import', imp, h(AGENT))).status, 403);
    await call(base, 'POST', '/api/event', { v: 1, session: { sessionId: 's1' }, transition: { state: 'working' } }, h(MAIN));
    assert.equal((await call(base, 'DELETE', '/api/sessions/s1', undefined, h(AGENT))).status, 403);
    assert.equal((await call(base, 'DELETE', '/api/sessions/s1', undefined, h(MAIN))).status, 200, 'the main token still can');
    assert.equal((await call(base, 'POST', '/api/import', imp, h(MAIN))).status, 200, 'the main token still can');
  });
});

test('main token: unchanged (no header = the user, `claude` = Claude), reads open to agents', async () => {
  await withServer(await openStore(':memory:'), async (base) => {
    const mine = await json(await call(base, 'POST', '/api/tickets', { title: 'mine' }, h(MAIN)));
    assert.equal(mine.body.created_by, 'user');
    const cl = await json(await call(base, 'POST', '/api/tickets', { title: 'claude' }, h(MAIN, { 'x-session-board-actor': 'claude' })));
    assert.equal(cl.body.created_by, 'claude');
    assert.equal((await fetch(`${base}/api/tickets`, { headers: h(AGENT) })).status, 200);
    assert.equal((await fetch(`${base}/api/tickets`, { headers: h('z'.repeat(32)) })).status, 401);
  });
});

test('authOf: an agent token wins even if it equals the main token', () => {
  assert.deepEqual(authOf(`Bearer ${AGENT}`, { token: MAIN, agents }), { kind: 'agent', actor: 'lupi' });
  assert.deepEqual(authOf(`Bearer ${MAIN}`, { token: MAIN, agents }), { kind: 'user' });
  assert.equal(authOf(`Bearer nope`, { token: MAIN, agents }), null);
  assert.equal(authOf(undefined, { token: MAIN, agents }), null);
  assert.deepEqual(authOf(`Bearer ${MAIN}`, { token: MAIN, agents: [{ actor: 'x', token: MAIN }] }), { kind: 'agent', actor: 'x' });
});

test('scopeActor and agentDisplayName', () => {
  assert.equal(scopeActor('lupi/dream-3', 'lupi'), 'lupi/dream-3');
  assert.equal(scopeActor('lupi-evil', 'lupi'), 'lupi');
  assert.equal(scopeActor(undefined, 'lupi'), 'lupi');
  assert.equal(agentDisplayName('you'), null);
  assert.equal(agentDisplayName(' User '), null);
  assert.equal(agentDisplayName('Lupi'), 'Lupi');
});

test('parseAgentTokens: strict, refuses the user and the hooks', () => {
  assert.deepEqual(parseAgentTokens(`# agents\n\nlupi ${AGENT}\n  ci-bot   ${OTHER}  \n`), agents);
  assert.throws(() => parseAgentTokens(`user ${AGENT}`), /cannot be an agent/);
  assert.throws(() => parseAgentTokens(`hook ${AGENT}`), /cannot be an agent/);
  assert.throws(() => parseAgentTokens('lupi short'), /at least 24/);
  assert.throws(() => parseAgentTokens(`lupi ${AGENT} extra`), /expected/);
  assert.throws(() => parseAgentTokens(AGENT), /expected/);
  assert.throws(() => parseAgentTokens(`lupi ${AGENT}\nci ${AGENT}`), /already listed/);
  assert.throws(() => parseAgentTokens(`-bad ${AGENT}`), /expected/);
});

test('readAgentTokens: the default file is optional, an explicit one is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-agents-'));
  assert.deepEqual(readAgentTokens({}, dir), []);
  writeFileSync(join(dir, 'agent-tokens'), `lupi ${AGENT}\n`);
  assert.deepEqual(readAgentTokens({}, dir), [{ actor: 'lupi', token: AGENT }]);
  assert.throws(() => readAgentTokens({ SESSION_BOARD_AGENT_TOKENS_FILE: join(dir, 'missing') }, dir), /cannot read/);
});
