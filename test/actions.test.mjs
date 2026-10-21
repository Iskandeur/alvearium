// 0.5.11: ticket actions. Declared by the installation, run by owner and admin only, the webhook gets
// the key and never the content, the link it answers is checked twice, one click at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/server.mjs';
import { ACTION_COOLDOWN_MS, actionRoutes, cleanMessage, loadActions, parseActions, plainHttpAllowed, safeOpenUrl } from '../server/actions.mjs';
import { openStore } from '../lib/store.mjs';
import { Accounts } from '../lib/accounts.mjs';

const MAIN = 'm'.repeat(32);
const HOOK_TOKEN = 'h'.repeat(40);
const ENV = { DEMO_HOOK_TOKEN: HOOK_TOKEN };
const ROOT = join(import.meta.dirname, '..');

// URLs with credentials, built so that no line reads like an e-mail address.
const AT = '@';
const conf = (o = {}) => ({ id: 'open-session', label: 'Open a coding session', icon: '🖥️', url: 'http://127.0.0.1:9/hook', token_env: 'DEMO_HOOK_TOKEN', allow_hosts: ['sessions.example.com'], ...o });

// ── configuration ──

test('parseActions: a valid file, the token read from the environment, never from the file', () => {
  const [a] = parseActions(JSON.stringify([conf({ timeout_ms: 40000, allow_hosts: ['Sessions.Example.com'] })]), ENV);
  assert.deepEqual(a, { id: 'open-session', label: 'Open a coding session', icon: '🖥️', url: 'http://127.0.0.1:9/hook', token: HOOK_TOKEN, allow_hosts: ['sessions.example.com'], timeout_ms: 40000 });
  assert.equal(parseActions('[]', ENV).length, 0);
});

test('parseActions: every mistake stops with a message that names it', () => {
  const bad = [
    ['not json', /not valid JSON/],
    ['{}', /JSON array/],
    [JSON.stringify(Array.from({ length: 9 }, (_, i) => conf({ id: `a${i}` }))), /at most 8/],
    [JSON.stringify([conf(), conf()]), /used twice/],
    [JSON.stringify([conf({ id: 'Bad Id' })]), /"id"/],
    [JSON.stringify([conf({ label: '' })]), /"label"/],
    [JSON.stringify([conf({ label: 'x'.repeat(41) })]), /"label"/],
    [JSON.stringify([conf({ icon: '<b>' })]), /"icon"/],
    [JSON.stringify([conf({ url: 'ftp://h/x' })]), /http or https/],
    [JSON.stringify([conf({ url: 'http://hooks.example.com/x' })]), /plain http on hooks\.example\.com: use https/],
    [JSON.stringify([conf({ url: 'http://203.0.113.9/x' })]), /plain http/],
    [JSON.stringify([conf({ url: 'nope' })]), /not a URL/],
    [JSON.stringify([conf({ url: `https://user:pw${AT}hooks.example.com/x` })]), /no credentials/],
    [JSON.stringify([conf({ token_env: 'lower' })]), /"token_env"/],
    [JSON.stringify([conf({ token_env: 'MISSING_TOKEN' })]), /MISSING_TOKEN must hold/],
    [JSON.stringify([conf({ allow_hosts: 'sessions.example.com' })]), /"allow_hosts" must be a list/],
    [JSON.stringify([conf({ allow_hosts: ['https://sessions.example.com'] })]), /not a host name/],
    [JSON.stringify([conf({ allow_hosts: ['sessions.example.com:8443'] })]), /not a host name/],
    [JSON.stringify([conf({ timeout_ms: 500 })]), /"timeout_ms"/],
    [JSON.stringify([conf({ token: 'inline' })]), /unknown field/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseActions(text, ENV), re, text.slice(0, 60));
});

test('plain http only on this machine or a private network; https anywhere', () => {
  for (const h of ['localhost', '127.0.0.1', '127.8.9.10', '[::1]', 'host.docker.internal', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20']) assert.equal(plainHttpAllowed(h), true, h);
  for (const h of ['example.com', '203.0.113.9', 'localhost.example.com', '127.0.0.1.nip.io', '']) assert.equal(plainHttpAllowed(h), false, h);
  assert.equal(plainHttpAllowed(`10.0.0.${256}`), false, 'an octet above 255 is not an address');
  // Just outside each private range: 172.15 and 172.32, 192.169, 11.
  for (const [a, b] of [[172, 15], [172, 32], [192, 169], [11, 0]]) assert.equal(plainHttpAllowed(`${a}.${b}.0.1`), false, `${a}.${b}.0.1`);
  for (const url of ['http://localhost:8080/h', 'http://[::1]:9/h', 'http://host.docker.internal:8787/h', 'http://192.168.1.2/h', 'https://hooks.example.com/h']) assert.equal(parseActions(JSON.stringify([conf({ url })]), ENV)[0].url.length > 0, true, url);
});

test('loadActions: none without the variable; a file that cannot be read is an error, not an empty list', () => {
  assert.deepEqual(loadActions({}), []);
  const dir = mkdtempSync(join(tmpdir(), 'alv-actions-'));
  try {
    assert.throws(() => loadActions({ SESSION_BOARD_ACTIONS_FILE: join(dir, 'absent.json') }), /cannot read/);
    const f = join(dir, 'actions.json');
    writeFileSync(f, JSON.stringify([conf()]));
    assert.equal(loadActions({ SESSION_BOARD_ACTIONS_FILE: f, ...ENV })[0].id, 'open-session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the server refuses to start on a bad actions file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alv-actions-start-'));
  try {
    const f = join(dir, 'actions.json');
    writeFileSync(f, JSON.stringify([conf({ token_env: 'NOT_SET_ANYWHERE' })]));
    const g = join(dir, 'public-http.json');
    writeFileSync(g, JSON.stringify([conf({ url: 'http://hooks.example.com/x' })]));
    const p = spawnSync(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
      env: { PATH: process.env.PATH, SESSION_BOARD_TOKEN: MAIN, SESSION_BOARD_DATA: dir, SESSION_BOARD_ACTIONS_FILE: g, PORT: '0', HOST: '127.0.0.1', ...ENV },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(p.status, 1);
    assert.match(p.stderr, /plain http on hooks\.example\.com: use https, or http only for localhost/);
    const r = spawnSync(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
      env: { PATH: process.env.PATH, SESSION_BOARD_TOKEN: MAIN, SESSION_BOARD_DATA: dir, SESSION_BOARD_ACTIONS_FILE: f, PORT: '0', HOST: '127.0.0.1' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ticket actions: action 1 \(open-session\): the variable NOT_SET_ANYWHERE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safeOpenUrl and cleanMessage: https on a listed host only; plain short text', () => {
  const hosts = ['sessions.example.com'];
  assert.equal(safeOpenUrl('https://sessions.example.com/s/123?x=1', hosts), 'https://sessions.example.com/s/123?x=1');
  for (const u of ['http://sessions.example.com/s', 'https://evil.example.net/s', 'https://sessions.example.com.evil.net/', `https://u:p${AT}sessions.example.com/`, 'https://sessions.example.com:8443/', 'javascript:alert(1)', 'data:text/html,x', '//sessions.example.com/x', 42, null])
    assert.equal(safeOpenUrl(u, hosts), null, String(u));
  assert.equal(safeOpenUrl('https://sessions.example.com/', []), null);
  assert.equal(cleanMessage('  line one\n\tline\u0007two '), 'line one line two');
  assert.equal(cleanMessage('x'.repeat(400)).length, 300);
  assert.equal(cleanMessage(42), undefined);
});

// ── routes ──

async function setup({ reply = { status: 200, body: { open_url: 'https://sessions.example.com/s/1', message: 'Session ready' } }, delayMs = 0, actions, cooldownMs = ACTION_COOLDOWN_MS, now } = {}) {
  const received = [];
  const hook = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: b, url: req.url });
      setTimeout(() => {
        const r = typeof reply === 'function' ? reply(received.length) : reply;
        if (r.stall) {
          // Headers and the start of a body, then nothing: the timeout must fire while reading.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"open_url": "https://sessions.example.com/s/1", ');
          return;
        }
        if (r.cut) {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
          res.write('{"message": "half');
          return setTimeout(() => res.socket.destroy(), 20);
        }
        if (r.redirect) {
          res.writeHead(302, { location: r.redirect });
          return res.end();
        }
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      }, delayMs);
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
  const store = await openStore(':memory:');
  const accounts = new Accounts(store);
  const member = accounts.createMember({ name: 'Bo', role: 'member' }, 'user');
  const admin = accounts.createMember({ name: 'Ada', role: 'admin' }, 'user');
  const viewer = accounts.createMember({ name: 'Vi', role: 'viewer' }, 'user');
  const agentTok = 'a'.repeat(32);
  const tok = { owner: MAIN, member: accounts.issueToken(member.id).token, admin: accounts.issueToken(admin.id).token, viewer: accounts.issueToken(viewer.id).token, agent: agentTok };
  const list = parseActions(JSON.stringify(actions ?? [conf({ url: hookUrl, timeout_ms: 1500 }), conf({ id: 'ping', label: 'Ping', icon: '', url: hookUrl, allow_hosts: [] })]), ENV);
  const ticketActions = actionRoutes({ actions: list, cooldownMs, ...(now ? { now } : {}) });
  const server = createServer(createApp({ token: MAIN, agents: [{ actor: 'bot', token: agentTok }], store, accounts, page: '', ticketActions }));
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
  const t = store.createTicket({ title: 'Secret plans for the launch', body: 'The confidential body.' }, { actor: 'user' });
  const key = (t.ticket ?? t).key;
  return { store, accounts, call, key, received, ids: { member: member.id, admin: admin.id }, close: () => (server.close(), hook.close()) };
}

test('GET /api/actions: id, label, icon and allowed hosts, for owner and admin only; an empty list for the others', async () => {
  const s = await setup();
  try {
    const o = await s.call('owner', 'GET', '/api/actions');
    assert.equal(o.status, 200);
    assert.deepEqual(o.body.actions[0], { id: 'open-session', label: 'Open a coding session', icon: '🖥️', allow_hosts: ['sessions.example.com'] });
    assert.equal(o.body.can_run, true);
    const text = JSON.stringify(o.body);
    assert.ok(!text.includes('127.0.0.1') && !text.includes('DEMO_HOOK_TOKEN') && !text.includes(HOOK_TOKEN), 'no URL, no token, no variable name');
    assert.equal((await s.call('admin', 'GET', '/api/actions')).body.actions.length, 2);
    for (const who of ['member', 'viewer', 'agent']) assert.deepEqual((await s.call(who, 'GET', '/api/actions')).body, { actions: [], can_run: false }, who);
    assert.equal((await s.call(null, 'GET', '/api/actions')).status, 401);
  } finally {
    s.close();
  }
});

test('POST: owner runs it; the webhook gets the key, the actor and the action, with its bearer token, never the content', async () => {
  const s = await setup();
  try {
    const r = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { open_url: 'https://sessions.example.com/s/1', message: 'Session ready' });
    assert.equal(s.received.length, 1);
    const got = s.received[0];
    assert.deepEqual(JSON.parse(got.body), { ticket: s.key, actor: 'user', action: 'open-session' });
    assert.equal(got.headers.authorization, `Bearer ${HOOK_TOKEN}`);
    assert.match(got.headers['user-agent'], /^alvearium\/\d+\.\d+\.\d+$/);
    assert.ok(!got.body.includes('Secret plans') && !got.body.includes('confidential'), 'the ticket content stays on the board');
    const audit = s.accounts.listAudit();
    assert.ok(audit.some((a) => a.action === 'action.run' && a.actor === 'user' && a.target === s.key && JSON.parse(a.detail).outcome === 'ok' && JSON.parse(a.detail).host === 'sessions.example.com'));
  } finally {
    s.close();
  }
});

test('POST: admin may, member, viewer and agent may not, and nobody unauthenticated', async () => {
  const s = await setup({ cooldownMs: 0 });
  try {
    assert.equal((await s.call('admin', 'POST', `/api/tickets/${s.key}/actions/open-session`)).status, 200);
    assert.equal(JSON.parse(s.received[0].body).actor, s.ids.admin);
    for (const who of ['member', 'viewer', 'agent']) assert.equal((await s.call(who, 'POST', `/api/tickets/${s.key}/actions/open-session`)).status, 403, who);
    assert.equal((await s.call(null, 'POST', `/api/tickets/${s.key}/actions/open-session`)).status, 401);
    assert.equal(s.received.length, 1, 'no refused call reached the webhook');
    assert.equal((await s.call('owner', 'GET', `/api/tickets/${s.key}/actions/open-session`)).status, 405);
    assert.equal((await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/nope`)).status, 404);
    assert.equal((await s.call('owner', 'POST', `/api/tickets/ALV-999/actions/open-session`)).status, 404);
  } finally {
    s.close();
  }
});

test('POST from the page: the cookie session needs its CSRF token, a cross-site request is refused', async () => {
  const s = await setup({ cooldownMs: 0 });
  try {
    const sess = s.accounts.issueToken('user', { kind: 'session', ttlMs: 60000 });
    const cookie = { cookie: `alv_session=${sess.token}` };
    assert.equal((await s.call(null, 'POST', `/api/tickets/${s.key}/actions/open-session`, undefined, cookie)).status, 403);
    assert.equal((await s.call(null, 'POST', `/api/tickets/${s.key}/actions/open-session`, undefined, { ...cookie, 'x-csrf-token': sess.csrf, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(s.received.length, 0);
    assert.equal((await s.call(null, 'POST', `/api/tickets/${s.key}/actions/open-session`, undefined, { ...cookie, 'x-csrf-token': sess.csrf, 'sec-fetch-site': 'same-origin' })).status, 200);
  } finally {
    s.close();
  }
});

test('the link is checked: not https, or a host outside allow_hosts, and nothing is opened', async () => {
  for (const open_url of ['http://sessions.example.com/s/1', 'https://elsewhere.example.net/s/1', 'javascript:alert(1)']) {
    const s = await setup({ reply: { status: 200, body: { open_url } } });
    try {
      const r = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
      assert.equal(r.status, 502, open_url);
      assert.equal(r.body.open_url, undefined);
      assert.match(r.body.error, /outside its allowed hosts/);
      assert.ok(s.accounts.listAudit().some((a) => a.action === 'action.run' && JSON.parse(a.detail).outcome === 'ko' && JSON.parse(a.detail).reason === 'refused_url'));
    } finally {
      s.close();
    }
  }
  // An action with no allowed host opens nothing: a message only.
  const s = await setup({ reply: { status: 200, body: { message: 'pong' } } });
  try {
    assert.deepEqual((await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/ping`)).body, { message: 'pong' });
  } finally {
    s.close();
  }
});

test('a failing webhook: its message is relayed (plain text), the status says it failed; a redirect is not followed', async () => {
  const s = await setup({ reply: (n) => (n === 1 ? { status: 409, body: { error: 'A session is already open on this ticket.\u0007' } } : n === 2 ? { status: 500, body: 'oops' } : { redirect: 'https://sessions.example.com/x' }), cooldownMs: 0 });
  try {
    const a = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.equal(a.status, 502);
    assert.equal(a.body.error, 'A session is already open on this ticket.');
    const b = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.deepEqual([b.status, b.body.error], [502, 'the action failed (HTTP 500)']);
    const c = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.equal(c.status, 502);
    assert.equal(c.body.error, 'the action could not be reached');
  } finally {
    s.close();
  }
});

test('timeout: 504 after timeout_ms, and the audit says so', async () => {
  const s = await setup({ delayMs: 2500 });
  try {
    const r = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.equal(r.status, 504);
    assert.match(r.body.error, /did not answer within 2 s/);
    assert.ok(s.accounts.listAudit().some((a) => a.action === 'action.run' && JSON.parse(a.detail).outcome === 'ko' && JSON.parse(a.detail).reason === 'timeout'));
  } finally {
    s.close();
  }
});

test('one click at a time per actor (429 with Retry-After), one action at a time per ticket (409)', async () => {
  let t = 1_000_000;
  const s = await setup({ now: () => t, delayMs: 800 });
  try {
    assert.equal((await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`)).status, 200);
    t += 3000;
    const again = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.equal(again.status, 429);
    assert.equal(again.headers.get('retry-after'), '7');
    t += ACTION_COOLDOWN_MS;
    // Two people on the same ticket at the same moment: the second waits for the first. The second
    // click leaves once the first has reached the webhook (held 800 ms there), not after a fixed delay
    // that a loaded machine can outrun.
    const before = s.received.length;
    const firstReached = async () => {
      for (let i = 0; i < 500 && s.received.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(s.received.length, before + 1, 'the first click never reached the webhook within 5 s');
    };
    const [x, y] = await Promise.all([
      s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`),
      firstReached().then(() => s.call('admin', 'POST', `/api/tickets/${s.key}/actions/open-session`)),
    ]);
    assert.deepEqual([x.status, y.status], [200, 409]);
    assert.equal(s.received.length, 2);
  } finally {
    s.close();
  }
});

test('an installation without actions: an empty list, and the route answers 404', async () => {
  const s = await setup({ actions: [] });
  try {
    assert.deepEqual((await s.call('owner', 'GET', '/api/actions')).body, { actions: [], can_run: true });
    assert.equal((await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`)).status, 404);
  } finally {
    s.close();
  }
});

// ── the page ──

const page = readFileSync(join(ROOT, 'server', 'page.html'), 'utf8');
const from = page.indexOf('function actionUrl(url, hosts) {');
const to = page.indexOf('function actionMsg(', from);
const actionUrl = new Function(`${page.slice(from, to)}; return actionUrl;`)();

test('page: the same link check as the server, on its own', () => {
  const hosts = ['sessions.example.com'];
  assert.equal(actionUrl('https://sessions.example.com/s/1', hosts), 'https://sessions.example.com/s/1');
  for (const u of ['http://sessions.example.com/s', 'https://evil.example.net/', 'https://sessions.example.com:444/', `https://a:b${AT}sessions.example.com/`, 'javascript:alert(1)', 7]) assert.equal(actionUrl(u, hosts), null, String(u));
});

test('page: buttons in the ticket detail for owner and admin, the tab opened inside the click, a link when it is blocked', () => {
  assert.match(page, /\$\{askBox\(t\)\}\n\s*\$\{actionBar\(t\)\}/);
  assert.match(page, /if \(!ticketActions\.canRun \|\| !ticketActions\.list\.length\) return '';/);
  assert.match(page, /class="pAct" data-action="\$\{esc\(a\.id\)\}"/);
  // window.open runs before the first await of runAction: still inside the user's gesture.
  const run = page.slice(page.indexOf('async function runAction(btn) {'), page.indexOf("document.addEventListener('click', (e) => {\n        const btn = e.target.closest?.('[data-action]');"));
  assert.ok(run.indexOf("window.open('about:blank', '_blank')") > 0 && run.indexOf("window.open('about:blank', '_blank')") < run.indexOf('await '));
  assert.match(run, /win\.opener = null;/);
  assert.match(run, /win\.location\.replace\(url\)/);
  assert.match(run, /The browser blocked the new tab:/);
  assert.match(run, /rel="noopener noreferrer"/);
  assert.match(run, /if \(win && !win\.closed\) win\.close\(\);/);
  // 0.8.1: allSettled, so one failed load does not stop the others (test/board-render.test.mjs).
  assert.match(page, /await Promise\.allSettled\(\[loadFacets\(\), refresh\(\), loadActions\(\)[^\]]*\]\);/);
  assert.match(page, /\.pAct:hover \{ border-color: var\(--accent\)/);
});

test('a webhook that stalls in the middle of its answer: 504 and an audit ko, never a 200', async () => {
  const s = await setup({ reply: { stall: true } });
  try {
    const r = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.equal(r.status, 504);
    assert.equal(r.body.open_url, undefined);
    const audit = s.accounts.listAudit().filter((a) => a.action === 'action.run').map((a) => JSON.parse(a.detail));
    assert.deepEqual(audit.map((d) => [d.outcome, d.reason]), [['ko', 'timeout']]);
  } finally {
    s.close();
  }
});

test('an answer cut while reading, or larger than 16 KiB: 502 and an audit ko', async () => {
  const s = await setup({ reply: (n) => (n === 1 ? { cut: true } : { status: 200, body: { message: 'x'.repeat(20_000) } }), cooldownMs: 0 });
  try {
    const a = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.deepEqual([a.status, a.body.error], [502, 'the answer of the action could not be read']);
    const b = await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/open-session`);
    assert.deepEqual([b.status, b.body.error], [502, 'the action answered with more than 16 KiB']);
    const audit = s.accounts.listAudit().filter((x) => x.action === 'action.run').map((x) => JSON.parse(x.detail));
    assert.ok(audit.every((d) => d.outcome === 'ko'));
    assert.deepEqual(audit.map((d) => d.reason).sort(), ['read_error', 'reply_too_large']);
  } finally {
    s.close();
  }
});

test('a 2xx answer speaks through message only: its error field is not shown', async () => {
  const s = await setup({ reply: { status: 200, body: { error: 'should not appear' } } });
  try {
    assert.deepEqual((await s.call('owner', 'POST', `/api/tickets/${s.key}/actions/ping`)).body, {});
  } finally {
    s.close();
  }
});

test('page: a precise selector for the buttons, and no Referer on the way to the link', () => {
  assert.match(page, /e\.target\.closest\?\.\('\.pAct\[data-action\]'\)/);
  assert.equal(page.match(/data-action=/g).length, 1, 'data-action is carried by the action buttons alone');
  assert.match(page, /meta\.name = 'referrer';\n\s*meta\.content = 'no-referrer';/);
  assert.match(page, /referrerpolicy="no-referrer"/);
});
