// 0.5: named humans with roles. Every route checks the role on the server; each refusal is tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Limiter, createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { Accounts, can, cleanMemberName, hashToken } from '../lib/accounts.mjs';
import { makePng } from './helpers/png.mjs';

const MAIN = 'm'.repeat(32);
const AGENT = 'a'.repeat(32);
const agents = [{ actor: 'bot', token: AGENT }];

async function setup(opts = {}) {
  const store = opts.store || (await openStore(':memory:'));
  const accounts = new Accounts(store);
  const admin = accounts.createMember({ name: 'Ada', role: 'admin' }, 'user');
  const member = accounts.createMember({ name: 'Bo', role: 'member' }, 'user');
  const viewer = accounts.createMember({ name: 'Cy', role: 'viewer' }, 'user');
  const tok = {
    owner: MAIN,
    admin: accounts.issueToken(admin.id).token,
    member: accounts.issueToken(member.id).token,
    viewer: accounts.issueToken(viewer.id).token,
    agent: AGENT,
  };
  const server = createServer(createApp({ token: MAIN, agents, store, accounts, page: '<html></html>', limiter: opts.limiter }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (who, method, path, body, extra = {}) => {
    const headers = { ...(who ? { authorization: `Bearer ${tok[who] ?? who}` } : {}), ...extra };
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, headers: res.headers };
  };
  return { store, accounts, server, base, call, tok, ids: { admin: admin.id, member: member.id, viewer: viewer.id }, close: () => server.close() };
}

test('the role table: what each role may do', () => {
  const r = (role) => ({ role });
  assert.ok(can(r('owner'), 'manageMembers') && can(r('admin'), 'manageMembers'));
  assert.ok(!can(r('member'), 'manageMembers') && !can(r('viewer'), 'manageMembers') && !can(r('agent'), 'manageMembers'));
  assert.ok(can(r('member'), 'write') && can(r('agent'), 'write') && !can(r('viewer'), 'write'));
  assert.ok(can(r('viewer'), 'read'));
  assert.ok(!can(r('agent'), 'ownTokens') && can(r('viewer'), 'ownTokens'));
  assert.ok(!can(null, 'read') && !can(r('nope'), 'read'));
  assert.throws(() => cleanMemberName('You'), /reserved/);
  assert.throws(() => cleanMemberName('  '), /required/);
  assert.equal(cleanMemberName(' Dee‮  Dee '), 'Dee Dee');
});

test('every write verb, for every role: viewer refused everywhere, members and agents write tickets', async () => {
  const s = await setup();
  try {
    const t = await s.call('owner', 'POST', '/api/tickets', { title: 'Seed' });
    const key = t.body.key;
    const verbs = [
      ['POST', '/api/tickets', { title: 'x' }],
      ['PATCH', `/api/tickets/${key}`, { priority: 'P2' }],
      ['POST', `/api/tickets/${key}`, { labels: ['a'] }],
      ['POST', `/api/tickets/${key}/comments`, { text: 'hi' }],
      ['POST', `/api/tickets/${key}/move`, { after: null }],
      ['POST', '/api/dismiss', { sessionId: 'nope' }],
      ['POST', '/api/event', { v: 1, event: 'Stop', session_id: 's-1', cwd: '/tmp' }],
    ];
    for (const [m, p, b] of verbs) {
      assert.equal((await s.call('viewer', m, p, b)).status, 403, `viewer ${m} ${p}`);
      for (const who of ['owner', 'admin', 'member', 'agent']) assert.notEqual((await s.call(who, m, p, b)).status, 403, `${who} ${m} ${p}`);
    }
    // Reads stay open to every role.
    for (const who of ['owner', 'admin', 'member', 'viewer', 'agent']) {
      assert.equal((await s.call(who, 'GET', '/api/tickets')).status, 200, who);
      assert.equal((await s.call(who, 'GET', `/api/tickets/${key}`)).status, 200, who);
    }
  } finally {
    s.close();
  }
});

test('import and delete: owner and admin only', async () => {
  const s = await setup();
  try {
    for (const who of ['member', 'viewer', 'agent']) {
      assert.equal((await s.call(who, 'POST', '/api/import', { board: 'b', tickets: [] })).status, 403, who);
      assert.equal((await s.call(who, 'DELETE', '/api/sessions/s-1')).status, 403, who);
    }
    for (const who of ['owner', 'admin']) {
      assert.notEqual((await s.call(who, 'POST', '/api/import', { board: 'b', tickets: [] })).status, 403, who);
      assert.notEqual((await s.call(who, 'DELETE', '/api/sessions/s-1')).status, 403, who);
    }
  } finally {
    s.close();
  }
});

test('members: roles and revocation by owner/admin only; nobody touches the owner', async () => {
  const s = await setup();
  try {
    const { member, viewer, admin } = s.ids;
    for (const who of ['member', 'viewer', 'agent']) {
      assert.equal((await s.call(who, 'PATCH', `/api/members/${viewer}`, { role: 'member' })).status, 403, who);
      assert.equal((await s.call(who, 'DELETE', `/api/members/${viewer}`)).status, 403, who);
      assert.equal((await s.call(who, 'GET', '/api/audit')).status, 403, who);
    }
    assert.equal((await s.call('agent', 'GET', '/api/members')).status, 403);
    assert.equal((await s.call('viewer', 'GET', '/api/members')).status, 200, 'any human sees who is on the board');
    assert.equal((await s.call('viewer', 'GET', '/api/members')).body.members[0].tokens, undefined, 'but not their tokens');
    // The owner is untouchable, even by an admin.
    assert.equal((await s.call('admin', 'PATCH', '/api/members/user', { role: 'viewer' })).status, 403);
    assert.equal((await s.call('admin', 'DELETE', '/api/members/user')).status, 403);
    assert.equal((await s.call('admin', 'PATCH', '/api/members/user', { name: 'Mallory' })).status, 403);
    assert.equal((await s.call('owner', 'PATCH', `/api/members/${member}`, { role: 'owner' })).status, 400, 'owner is never granted');
    // An admin manages the others.
    assert.equal((await s.call('admin', 'PATCH', `/api/members/${viewer}`, { role: 'member' })).status, 200);
    assert.equal((await s.call('viewer', 'POST', '/api/tickets', { title: 'now I can' })).status, 201, 'a role change applies at once');
    assert.equal((await s.call('admin', 'PATCH', `/api/members/${viewer}`, { role: 'viewer' })).status, 200);
    assert.equal((await s.call('viewer', 'POST', '/api/tickets', { title: 'and now I cannot' })).status, 403);
    // Names: your own, never another's, never a duplicate.
    assert.equal((await s.call('member', 'PATCH', `/api/members/${member}`, { name: 'Bob' })).status, 200);
    assert.equal((await s.call('member', 'PATCH', `/api/members/${viewer}`, { name: 'X' })).status, 403);
    assert.equal((await s.call('viewer', 'PATCH', `/api/members/${viewer}`, { name: 'ada' })).status, 409);
    assert.equal((await s.call('admin', 'DELETE', `/api/members/${member}`)).status, 200);
    assert.equal((await s.call('member', 'GET', '/api/tickets')).status, 401, 'revoked: the token dies at once');
    const audit = (await s.call('admin', 'GET', '/api/audit')).body.audit.map((a) => a.action);
    for (const a of ['member.role', 'member.rename', 'member.revoke']) assert.ok(audit.includes(a), a);
    void admin;
  } finally {
    s.close();
  }
});

test('revocation cuts an open live stream', async () => {
  const s = await setup();
  try {
    const ctl = new AbortController();
    const res = await fetch(s.base + '/api/stream', { headers: { authorization: `Bearer ${s.tok.member}` }, signal: ctl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    await reader.read(); // hello
    assert.equal((await s.call('owner', 'DELETE', `/api/members/${s.ids.member}`)).status, 200);
    const end = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return 'closed';
        }
      })(),
      new Promise((r) => setTimeout(() => r('still open'), 2000)),
    ]);
    ctl.abort();
    assert.equal(end, 'closed');
  } finally {
    s.close();
  }
});

test('history carries the real human; headers never impersonate a person', async () => {
  const s = await setup();
  try {
    const { member } = s.ids;
    const a = await s.call('member', 'POST', '/api/tickets', { title: 'Mine' }, { 'x-session-board-actor': 'user' });
    assert.equal(a.body.created_by, member, 'a member claiming `user` stays itself');
    const b = await s.call('member', 'POST', '/api/tickets', { title: 'By my Claude' }, { 'x-session-board-actor': 'claude' });
    assert.equal(b.body.created_by, `${member}/claude`);
    const c = await s.call('member', 'POST', '/api/tickets', { title: 'Steal' }, { 'x-session-board-actor': s.ids.admin });
    assert.equal(c.body.created_by, member, 'a member cannot write as another human');
    const d = await s.call('owner', 'POST', '/api/tickets', { title: 'Owner as Bo?' }, { 'x-session-board-actor': member });
    assert.equal(d.body.created_by, 'user', 'nor can the owner\'s token');
    await s.call('admin', 'PATCH', `/api/tickets/${a.body.key}`, { status: 'done', comment: 'closing' });
    const t = (await s.call('owner', 'GET', `/api/tickets/${a.body.key}`)).body;
    assert.ok(t.events.some((e) => e.actor === s.ids.admin), 'the admin who closed it is named');
    const actors = (await s.call('viewer', 'GET', '/api/actors')).body.actors;
    assert.equal(actors.find((x) => x.id === member).type, 'human');
    assert.equal(actors.find((x) => x.id === member).name, 'Bo');
  } finally {
    s.close();
  }
});

test('avatars and names of others: only owner/admin; anyone their own', async () => {
  const s = await setup();
  try {
    s.store.touchActor({ id: 'bot', type: 'agent' });
    const png = makePng();
    const put = (who, id) => s.call(who, 'PUT', `/api/actors/${encodeURIComponent(id)}/avatar`, png, { 'content-type': 'image/png' });
    assert.equal((await put('member', s.ids.member)).status, 200);
    assert.equal((await put('viewer', s.ids.viewer)).status, 200, 'your own picture is not board content');
    assert.equal((await put('member', s.ids.viewer)).status, 403);
    assert.equal((await put('member', 'bot')).status, 403);
    assert.equal((await put('member', 'user')).status, 403);
    assert.equal((await put('viewer', 'bot')).status, 403);
    assert.equal((await put('agent', s.ids.member)).status, 403);
    assert.equal((await put('admin', s.ids.member)).status, 200);
    assert.equal((await put('admin', 'bot')).status, 200);
    assert.equal((await s.call('member', 'PATCH', '/api/actors/bot', { name: 'Bot!' })).status, 403);
    assert.equal((await s.call('member', 'PATCH', `/api/actors/${s.ids.viewer}`, { name: 'Z' })).status, 403);
    assert.equal((await s.call('member', 'DELETE', `/api/actors/${s.ids.viewer}/avatar`)).status, 403);
  } finally {
    s.close();
  }
});

test('personal tokens: shown once, stored hashed, revocable; admins never touch the owner\'s', async () => {
  const s = await setup();
  try {
    const n = await s.call('viewer', 'POST', '/api/tokens', { label: 'laptop' });
    assert.equal(n.status, 201);
    const secret = n.body.token;
    assert.match(secret, /^alvm_[\w-]{40,}$/);
    assert.equal((await s.call(secret, 'GET', '/api/me')).body.id, s.ids.viewer);
    const list = (await s.call('viewer', 'GET', '/api/tokens')).body.tokens;
    assert.ok(list.every((t) => !('hash' in t) && !('token' in t)));
    // Nothing in the database holds a secret in clear.
    const rows = s.store.db.prepare('SELECT * FROM member_tokens').all();
    assert.ok(rows.some((r) => r.hash === hashToken(secret)));
    assert.ok(!JSON.stringify(rows).includes(secret));
    assert.equal((await s.call('agent', 'POST', '/api/tokens', {})).status, 403);
    // Someone else's token: a member cannot revoke it, an admin can, except the owner's.
    assert.equal((await s.call('member', 'DELETE', `/api/tokens/${n.body.id}`)).status, 404);
    assert.equal((await s.call('admin', 'DELETE', `/api/tokens/${n.body.id}`)).status, 200);
    assert.equal((await s.call(secret, 'GET', '/api/me')).status, 401);
    const own = await s.call('owner', 'POST', '/api/tokens', { label: 'ci' });
    assert.equal((await s.call('admin', 'DELETE', `/api/tokens/${own.body.id}`)).status, 404);
    assert.equal((await s.call(own.body.token, 'GET', '/api/me')).body.role, 'owner');
  } finally {
    s.close();
  }
});

test('page session: httpOnly Secure SameSite=Strict cookie, CSRF on every change, logout ends it', async () => {
  const s = await setup();
  try {
    const r = await s.call('member', 'POST', '/api/session');
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), flag);
    const value = cookie.split(';')[0];
    const csrf = r.body.csrf;
    assert.ok(csrf && csrf.length >= 24);
    const viaCookie = (m, p, b, extra = {}) => s.call(null, m, p, b, { cookie: value, ...extra });
    assert.equal((await viaCookie('GET', '/api/me')).body.id, s.ids.member);
    assert.equal((await viaCookie('POST', '/api/tickets', { title: 'no csrf' })).status, 403);
    assert.equal((await viaCookie('POST', '/api/tickets', { title: 'bad csrf' }, { 'x-csrf-token': 'x'.repeat(csrf.length) })).status, 403);
    assert.equal((await viaCookie('POST', '/api/tickets', { title: 'cross site' }, { 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await viaCookie('POST', '/api/tickets', { title: 'ok' }, { 'x-csrf-token': csrf, 'sec-fetch-site': 'same-origin' })).status, 201);
    // A cookie never carries an API token: only session tokens are read from it.
    assert.equal((await s.call(null, 'GET', '/api/me', undefined, { cookie: `alv_session=${s.tok.member}` })).status, 401);
    assert.equal((await viaCookie('POST', '/api/logout', undefined, { 'x-csrf-token': csrf })).status, 200);
    assert.equal((await viaCookie('GET', '/api/me')).status, 401);
    assert.equal((await s.call('agent', 'POST', '/api/session')).status, 403);
  } finally {
    s.close();
  }
});

test('failed attempts are rate limited; a valid token is never slowed down', async () => {
  const s = await setup({ limiter: new Limiter({ max: 3, windowMs: 60000 }) });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await s.call('z'.repeat(32), 'GET', '/api/me')).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    assert.equal((await s.call('member', 'GET', '/api/me')).status, 200);
  } finally {
    s.close();
  }
});

test('upgrade: an existing board keeps every ticket, the server token becomes the owner', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'alv-mig-')), 'board.db');
  const old = await openStore(file);
  // A board from before accounts: tickets by `user`, no members table.
  old.createTicket({ title: 'Old one' }, { actor: 'user' });
  old.createTicket({ title: 'Old two', assignee: 'claude' }, { actor: 'claude' });
  assert.equal(old.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'members'").get().n, 0);
  old.close();
  const store = await openStore(file);
  const server = createServer(createApp({ token: MAIN, store, page: '' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = { authorization: `Bearer ${MAIN}` };
    const me = await (await fetch(`${base}/api/me`, { headers: h })).json();
    assert.deepEqual([me.id, me.role, me.humans], ['user', 'owner', 1]);
    const list = await (await fetch(`${base}/api/tickets`, { headers: h })).json();
    assert.deepEqual(list.tickets.map((t) => t.title).sort(), ['Old one', 'Old two']);
    assert.equal(list.tickets.find((t) => t.title === 'Old one').created_by, 'user');
    const members = await (await fetch(`${base}/api/members`, { headers: h })).json();
    assert.deepEqual(members.members.map((m) => [m.id, m.role]), [['user', 'owner']]);
  } finally {
    server.close();
    store.close();
  }
});
