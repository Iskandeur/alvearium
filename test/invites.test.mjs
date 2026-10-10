// 0.5: invitations. One use, expiring, revocable, stored hashed, rate limited, never cross-site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/server.mjs';
import { inviteRoutes } from '../server/invites.mjs';
import { Limiter } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { Accounts, hashToken } from '../lib/accounts.mjs';

const MAIN = 'm'.repeat(32);

async function setup({ now = () => Date.now(), inviteMax = 50 } = {}) {
  const store = await openStore(':memory:', { now });
  const accounts = new Accounts(store);
  const member = accounts.createMember({ name: 'Bo', role: 'member' }, 'user');
  const admin = accounts.createMember({ name: 'Ada', role: 'admin' }, 'user');
  const tok = { owner: MAIN, member: accounts.issueToken(member.id).token, admin: accounts.issueToken(admin.id).token };
  const server = createServer(createApp({ token: MAIN, store, accounts, page: '', extraRoutes: inviteRoutes({ limiter: new Limiter({ max: inviteMax, windowMs: 60000 }) }) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (who, method, path, body, extra = {}) => {
    const headers = { ...(who ? { authorization: `Bearer ${tok[who] ?? who}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra };
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, headers: res.headers };
  };
  return { store, accounts, call, ids: { member: member.id, admin: admin.id }, close: () => server.close() };
}

test('owner and admin invite; members, viewers and agents cannot', async () => {
  const s = await setup();
  try {
    assert.equal((await s.call('member', 'POST', '/api/invites', { role: 'viewer' })).status, 403);
    assert.equal((await s.call('member', 'GET', '/api/invites')).status, 403);
    assert.equal((await s.call(null, 'POST', '/api/invites', { role: 'viewer' })).status, 401);
    const a = await s.call('admin', 'POST', '/api/invites', { role: 'member' });
    assert.equal(a.status, 201);
    assert.match(a.body.token, /^alvi_/);
    assert.equal(a.body.path, `#invite=${a.body.token}`);
    assert.equal((await s.call('owner', 'POST', '/api/invites', { role: 'owner' })).status, 400, 'never an owner invitation');
    assert.equal((await s.call('owner', 'POST', '/api/invites', { role: 'member', days: 90 })).status, 400, 'at most 30 days');
    const list = (await s.call('owner', 'GET', '/api/invites')).body.invites;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'pending');
    assert.ok(!JSON.stringify(list).includes(a.body.token), 'the list never shows a secret');
  } finally {
    s.close();
  }
});

test('accept: creates the member with the invited role, a personal token and a page session; one use only', async () => {
  const s = await setup();
  try {
    const inv = (await s.call('owner', 'POST', '/api/invites', { role: 'viewer', days: 7 })).body;
    const check = await s.call(null, 'POST', '/api/invites/check', { token: inv.token });
    assert.equal(check.status, 200);
    assert.equal(check.body.role, 'viewer');
    const r = await s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name: 'Robin' });
    assert.equal(r.status, 201);
    assert.equal(r.body.member.role, 'viewer');
    const cookie = r.headers.get('set-cookie');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(flag), flag);
    // The personal token works, with the role of the invitation.
    const me = await s.call(r.body.token, 'GET', '/api/me');
    assert.deepEqual([me.body.name, me.body.role], ['Robin', 'viewer']);
    assert.equal((await s.call(r.body.token, 'POST', '/api/tickets', { title: 'x' })).status, 403, 'a viewer cannot write');
    // The cookie works too.
    assert.equal((await s.call(null, 'GET', '/api/me', undefined, { cookie: cookie.split(';')[0] })).body.id, r.body.member.id);
    // Second use, whatever the name: refused, no second member.
    const again = await s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name: 'Mallory' });
    assert.equal(again.status, 410);
    assert.equal((await s.call(null, 'POST', '/api/invites/check', { token: inv.token })).status, 410);
    assert.ok(!s.accounts.listMembers().some((m) => m.name === 'Mallory'));
    const audit = (await s.call('owner', 'GET', '/api/audit')).body.audit;
    assert.ok(audit.some((a) => a.action === 'invite.create' && a.actor === 'user'));
    assert.ok(audit.some((a) => a.action === 'invite.accept' && a.actor === r.body.member.id && JSON.parse(a.detail).by === 'user'), 'who invited whom');
  } finally {
    s.close();
  }
});

test('two browsers racing on one link: one member', async () => {
  const s = await setup();
  try {
    const inv = (await s.call('owner', 'POST', '/api/invites', { role: 'member' })).body;
    const rs = await Promise.all(['Eve', 'Fay', 'Gus'].map((name) => s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 410, 410]);
    assert.equal(s.accounts.listMembers().filter((m) => ['Eve', 'Fay', 'Gus'].includes(m.name)).length, 1);
  } finally {
    s.close();
  }
});

test('expired and revoked invitations are refused; a taken name leaves the invitation usable', async () => {
  let t = Date.now();
  const s = await setup({ now: () => t });
  try {
    const inv = (await s.call('owner', 'POST', '/api/invites', { role: 'member', days: 1 })).body;
    const name = await s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name: 'bo' });
    assert.equal(name.status, 409, 'a name already taken');
    t += 25 * 3600 * 1000;
    assert.equal((await s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name: 'Hal' })).status, 410);
    assert.equal((await s.call('owner', 'GET', '/api/invites')).body.invites[0].status, 'expired');
    const inv2 = (await s.call('owner', 'POST', '/api/invites', { role: 'member' })).body;
    assert.equal((await s.call('member', 'DELETE', `/api/invites/${inv2.id}`)).status, 403);
    assert.equal((await s.call('admin', 'DELETE', `/api/invites/${inv2.id}`)).status, 200);
    assert.equal((await s.call(null, 'POST', '/api/invites/accept', { token: inv2.token, name: 'Ivy' })).status, 410);
    assert.equal((await s.call('admin', 'DELETE', `/api/invites/${inv2.id}`)).status, 404, 'already revoked');
    assert.equal((await s.call(null, 'POST', '/api/invites/accept', { token: 'alvi_' + 'x'.repeat(43), name: 'Jo' })).status, 404);
    assert.equal((await s.call(null, 'POST', '/api/invites/accept', { token: 'nope', name: 'Jo' })).status, 404);
  } finally {
    s.close();
  }
});

test('stored hashed: the database never holds an invitation secret', async () => {
  const s = await setup();
  try {
    const inv = (await s.call('owner', 'POST', '/api/invites', { role: 'member' })).body;
    const rows = s.store.db.prepare('SELECT * FROM invites').all();
    assert.equal(rows[0].hash, hashToken(inv.token));
    assert.ok(!JSON.stringify(rows).includes(inv.token));
    const audit = s.store.db.prepare('SELECT * FROM audit').all();
    assert.ok(!JSON.stringify(audit).includes(inv.token));
  } finally {
    s.close();
  }
});

test('accepting is rate limited, and cross-site requests are refused', async () => {
  const s = await setup({ inviteMax: 4 });
  try {
    const inv = (await s.call('owner', 'POST', '/api/invites', { role: 'member' })).body;
    assert.equal((await s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name: 'Kim' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await s.call(null, 'POST', '/api/invites/check', { token: 'alvi_' + String(i).repeat(43) })).status);
    assert.deepEqual(codes, [404, 404, 404, 429], 'every attempt counts');
    assert.equal((await s.call(null, 'POST', '/api/invites/accept', { token: inv.token, name: 'Kim' })).status, 429);
    assert.equal((await s.call(null, 'GET', '/api/invites/check')).status, 405);
  } finally {
    s.close();
  }
});

test('the page: the invitation secret stays in the fragment, is dropped from the address bar, sent only by POST', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../server/page.html', import.meta.url), 'utf8');
  assert.match(page, /location\.hash\.match\(\/invite=/);
  assert.match(page, /if \(invHash\) history\.replaceState/);
  assert.match(page, /fetch\('api\/invites\/' \+ path, \{ method: 'POST'/);
  assert.doesNotMatch(page, /invites\/check\?/);
});

test('the page cannot be framed by another site (Members has buttons worth clickjacking)', async () => {
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: MAIN, store, page: '<html></html>' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
  } finally {
    server.close();
  }
});
