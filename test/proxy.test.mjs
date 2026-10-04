// 0.3.4: cloud sessions write to the board through the agent proxy.
// The 0.3.3 failure (04/10): in claude.ai/code, curl went through HTTPS_PROXY (the agent proxy, which
// adds the environment's API credential) and reached the board; the plugin used Node's fetch, which
// ignores HTTPS_PROXY, left without credential, was redirected by the auth gateway in front of the
// board to a login page, followed it, and read the 200 HTML as success: hooks "sent", MCP "Created
// undefined [undefined] undefined", nothing on the board. These tests build that world:
//   board (plain http, needs a Bearer) ← agent proxy (CONNECT, terminates TLS with its own CA, adds
//   the Bearer) ← plugin with HTTPS_PROXY, SESSION_BOARD_TOKEN=proxy, SSL_CERT_FILE = the proxy CA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTlsHttpServer } from 'node:https';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardFetch, bypassProxy, explainReply, proxyFor } from '../lib/net.mjs';
import { HttpBackend, handleHook, loadConfig } from '../lib/runtime.mjs';
import { callTool, handleMessage } from '../mcp/server.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';
import { selfSigned } from './helpers/selfsigned.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN = 'p'.repeat(32);
const tmp = () => mkdtempSync(join(tmpdir(), 'sb-proxy-'));
const CLEAN = {
  SESSION_BOARD_URL: '', SESSION_BOARD_TOKEN: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CODE_REMOTE: '',
  CLAUDE_PLUGIN_OPTION_SERVER_URL: '', CLAUDE_PLUGIN_OPTION_TOKEN: '', SESSION_BOARD_ACTOR: '', SESSION_BOARD_THREAD: '',
  HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '',
  NODE_USE_ENV_PROXY: '', NODE_EXTRA_CA_CERTS: '',
};
const { cert, key } = selfSigned('board.test');

/** board + agent proxy. `proxyAuth`: the proxy wants this Proxy-Authorization (from the URL's userinfo). */
async function world(fn, { proxyAuth = 'Basic ' + Buffer.from('sess:pw').toString('base64') } = {}) {
  const store = await openStore(join(tmp(), 'board.db'));
  const board = createServer(createApp({ token: TOKEN, store, page: '<html></html>' }));
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  const boardBase = `http://127.0.0.1:${board.address().port}`;
  const seen = { connects: [], forwarded: [] };
  // The TLS end of the proxy: what the session's TLS talks to inside the tunnel. Adds the credential.
  const mitm = createTlsHttpServer({ cert, key }, async (req, res) => {
    seen.forwarded.push({ method: req.method, url: req.url, host: req.headers.host, hadAuth: Boolean(req.headers.authorization) });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { ...req.headers, authorization: `Bearer ${TOKEN}` };
    delete headers.host;
    delete headers['content-length'];
    const r = await fetch(boardBase + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  const proxy = createServer((req, res) => res.writeHead(405).end());
  proxy.on('connect', (req, socket) => {
    seen.connects.push({ target: req.url, auth: req.headers['proxy-authorization'] || null });
    if (proxyAuth && req.headers['proxy-authorization'] !== proxyAuth) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    mitm.emit('connection', socket);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const dir = tmp();
  const caFile = join(dir, 'proxy-ca.pem');
  writeFileSync(caFile, cert);
  const env = {
    ...CLEAN,
    CLAUDE_CODE_REMOTE: 'true',
    SESSION_BOARD_URL: 'https://board.test',
    SESSION_BOARD_TOKEN: 'proxy',
    SESSION_BOARD_DIR: dir,
    HTTPS_PROXY: `http://sess:pw@127.0.0.1:${proxy.address().port}`,
    SSL_CERT_FILE: caFile,
  };
  try {
    await fn({ env, store, seen, boardBase, proxyPort: proxy.address().port });
  } finally {
    proxy.close();
    mitm.close();
    board.close();
    store.close();
  }
}

/** A child process, asynchronously: the proxy and the board live in this test's event loop. */
function run(args, { input = '', env = {}, cwd } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (status) => res({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** The MCP server as Claude Code runs it: a child process, JSON-RPC over stdio. */
function mcp(args, env, cwd) {
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), ...args], { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
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
    call(name, a) {
      const mid = ++id;
      return new Promise((res, rej) => {
        waiting.set(mid, res);
        setTimeout(() => rej(new Error('mcp timeout')), 8000).unref();
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method: 'tools/call', params: { name, arguments: a } }) + '\n');
      });
    },
    close: () => new Promise((r) => (child.on('exit', r), child.stdin.end())),
  };
}

test('proxy selection: HTTPS_PROXY / https_proxy, NO_PROXY, plain host:port', () => {
  assert.equal(proxyFor('https://board.test/x', {}), null);
  assert.equal(proxyFor('https://board.test/x', { HTTPS_PROXY: 'http://p:3128' }).host, 'p:3128');
  assert.equal(proxyFor('https://board.test/x', { https_proxy: '10.0.0.1:8080' }).host, '10.0.0.1:8080', 'scheme-less proxy');
  assert.equal(proxyFor('http://board.test/x', { HTTPS_PROXY: 'http://p:1' }), null, 'http target needs HTTP_PROXY');
  assert.equal(proxyFor('http://board.test/x', { http_proxy: 'http://p:1' }).host, 'p:1');
  assert.equal(proxyFor('https://board.test', { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost,.test' }), null);
  assert.ok(bypassProxy(new URL('https://a.b.example.com'), 'example.com'));
  assert.ok(bypassProxy(new URL('https://example.com'), '*.example.com'));
  assert.ok(!bypassProxy(new URL('https://notexample.com'), 'example.com'));
  assert.ok(bypassProxy(new URL('https://x'), '*'));
  assert.ok(!bypassProxy(new URL('https://h:8443'), 'h:443'), 'port must match when given');
  assert.ok(bypassProxy(new URL('https://h:8443'), 'h:8443'));
});

test('through the agent proxy: CONNECT with proxy auth, TLS to the proxy CA, the credential added there', async () => {
  await world(async ({ env, seen, proxyPort }) => {
    const res = await boardFetch('https://board.test/api/version', { headers: { 'user-agent': 't' } }, { env });
    assert.equal(res.status, 200);
    assert.equal(res.route, `proxy 127.0.0.1:${proxyPort}`);
    assert.match((await res.json()).version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(seen.connects[0], { target: 'board.test:443', auth: 'Basic ' + Buffer.from('sess:pw').toString('base64') });
    assert.equal(seen.forwarded[0].hadAuth, false, 'the session sent no credential (token `proxy`)');
    assert.equal(seen.forwarded[0].host, 'board.test');
  });
});

test('hooks and the MCP server, as processes, write to the board through the proxy (origin cloud)', async () => {
  await world(async ({ env, store, seen }) => {
    const cwd = tmp();
    const hook = await run([join(ROOT, 'hooks', 'report.mjs'), 'SessionStart'], {
      input: JSON.stringify({ session_id: 'cloud-1', cwd, source: 'startup' }),
      env: { ...env, SESSION_BOARD_DEBUG: '1' },
    });
    assert.match(hook.stderr, /SessionStart → sent · https:\/\/board\.test via proxy 127\.0\.0\.1:\d+/);
    const c = mcp([], env, cwd);
    try {
      const r = await c.call('ticket_create', { title: 'test cloud' });
      assert.ok(!r.result.isError, r.result.content[0].text);
      assert.match(r.result.content[0].text, /^Created SB-\d+ \[todo, on user\] test cloud/);
    } finally {
      await c.close();
    }
    const t = store.listTickets({ q: 'test cloud' }).tickets[0];
    assert.equal(t.origin, 'cloud');
    assert.equal(t.session_id, 'cloud-1', 'attached to the session the hooks recorded');
    assert.ok(seen.connects.length >= 2);
  });
});

test('a proxy that refuses the tunnel gives a readable error, not a silent success', async () => {
  await world(
    async ({ env }) => {
      const bad = { ...env, HTTPS_PROXY: env.HTTPS_PROXY.replace('sess:pw@', '') };
      await assert.rejects(boardFetch('https://board.test/api/version', {}, { env: bad }), /refused the tunnel to board\.test:443: 407/);
      const out = {};
      const status = await handleHook('SessionStart', { session_id: 's407', cwd: tmp(), source: 'startup' }, { env: bad, fetchImpl: (u, i) => boardFetch(u, i, { env: bad }), out });
      assert.equal(status, 'send-failed');
      assert.match(out.error, /407/);
    },
  );
});

test('the proxy CA must be trusted: without it, a TLS error (and the doctor names the fix)', async () => {
  await world(async ({ env }) => {
    const noCa = { ...env, SSL_CERT_FILE: '' };
    // the system store does not hold this test CA
    await assert.rejects(boardFetch('https://board.test/api/version', {}, { env: noCa }), /certificate|self.signed|issuer/i);
  });
});

/** An auth gateway (Cloudflare Access style) in front of the board: no credential → 302 to a login page. */
async function gateway(fn) {
  const srv = createServer((req, res) => {
    if (req.url === '/login' || req.url.startsWith('/cdn-cgi/access/login')) return res.writeHead(200, { 'content-type': 'text/html' }).end('<!DOCTYPE html><title>Sign in</title>');
    if (req.url.startsWith('/deny')) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
    res.writeHead(302, { location: '/cdn-cgi/access/login/board?redirect_url=%2Flogin' }).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${srv.address().port}`);
  } finally {
    srv.close();
  }
}

test('0.3.3 regression: a login redirect is an error everywhere, never "Created undefined"', async () => {
  await gateway(async (base) => {
    const env = { ...CLEAN, CLAUDE_CODE_REMOTE: 'true', SESSION_BOARD_URL: base, SESSION_BOARD_TOKEN: 'proxy', SESSION_BOARD_DIR: tmp() };
    const cfg = loadConfig(env);
    const fetchImpl = (u, i) => boardFetch(u, i, { env });
    // boardFetch does not follow the redirect
    const raw = await fetchImpl(`${base}/api/tickets`, { method: 'POST', body: '{}' });
    assert.equal(raw.status, 302);
    // the MCP tool says what happened
    const backend = new HttpBackend(cfg, { fetchImpl });
    const msg = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ticket_create', arguments: { title: 'x' } } },
      { mode: 'full', backend: async () => backend, context: () => ({ origin: 'cloud', machine: 'claude.ai/code', cwd: '/w' }) },
    );
    assert.equal(msg.result.isError, true);
    const text = msg.result.content[0].text;
    assert.doesNotMatch(text, /undefined/);
    assert.match(text, /HTTP 302 redirect to \/cdn-cgi\/access\/login.*Cloudflare Access/);
    assert.match(text, /went out directly, not through the agent proxy/);
    // the hook does not count it as sent
    const out = {};
    assert.equal(await handleHook('SessionStart', { session_id: 'g1', cwd: tmp(), source: 'startup' }, { env, fetchImpl, out }), 'send-failed');
    assert.match(out.error, /302/);
  });
});

test('a 2xx login page (redirect already followed, the global fetch) and a 401 are explained', async () => {
  await gateway(async (base) => {
    const env = { ...CLEAN, SESSION_BOARD_URL: base, SESSION_BOARD_TOKEN: 'proxy', SESSION_BOARD_DIR: tmp(), CLAUDE_CODE_REMOTE: 'true' };
    const cfg = loadConfig(env);
    // the global fetch follows redirects: what 0.3.3 saw
    const following = new HttpBackend(cfg, { fetchImpl: fetch });
    await assert.rejects(following.create({ title: 'x' }), /HTTP 200 .* not the board API \(text\/html/);
    const deny = new HttpBackend({ ...cfg, url: base + '/deny' }, { fetchImpl: (u, i) => boardFetch(u, i, { env }) });
    await assert.rejects(deny.list({}), /HTTP 401/);
    // a reply without a key never becomes "Created undefined"
    const empty = { create: async () => ({}) };
    await assert.rejects(callTool('ticket_create', { title: 'x' }, { backend: empty, context: { cwd: '/w' } }), /answered without a ticket.*Nothing was saved/);
  });
  assert.equal(explainReply({ status: 200, headers: { get: () => 'application/json' } }, '{"key":"SB-1"}', {}), '');
});

test('direct path (no proxy variables): plain http and https with the real token', async () => {
  const store = await openStore(join(tmp(), 'board.db'));
  const board = createServer(createApp({ token: TOKEN, store, page: '' }));
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${board.address().port}`;
  try {
    const env = { ...CLEAN, SESSION_BOARD_URL: base, SESSION_BOARD_TOKEN: TOKEN, SESSION_BOARD_DIR: tmp() };
    const backend = new HttpBackend(loadConfig(env), { fetchImpl: (u, i) => boardFetch(u, i, { env }) });
    const t = await backend.create({ title: 'direct one' });
    assert.match(t.key, /^SB-\d+$/);
    const res = await boardFetch(`${base}/api/version`, {}, { env });
    assert.equal(res.route, 'direct');
    // NO_PROXY keeps a local board direct even when a proxy is set
    const res2 = await boardFetch(`${base}/api/version`, { headers: { authorization: `Bearer ${TOKEN}` } }, { env: { ...env, HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1' } });
    assert.equal(res2.status, 200);
  } finally {
    board.close();
    store.close();
  }
  // https direct, to a TLS server whose CA is given by NODE_EXTRA_CA_CERTS-style env
  const srv = createTlsHttpServer({ cert, key }, (q, r) => r.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"1.2.3"}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await boardFetch(`https://127.0.0.1:${srv.address().port}/api/version`, {}, { env: {} }).catch((e) => e);
    // direct https keeps Node's default trust: the test CA is unknown there
    assert.ok(res instanceof Error);
  } finally {
    srv.close();
  }
});

test('timeouts abort the request', async () => {
  const srv = createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(boardFetch(`http://127.0.0.1:${srv.address().port}/`, { signal: AbortSignal.timeout(150) }, { env: {} }), (e) => e.name === 'TimeoutError' || e.name === 'AbortError');
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('doctor: through the proxy it reads, creates the test ticket, and says ok; behind a gateway it says why', async () => {
  await world(async ({ env, store }) => {
    const r = await run([join(ROOT, 'scripts', 'doctor.mjs'), '--ticket', 'test cloud'], { env, cwd: tmp() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /the board answers as the board/);
    assert.match(r.stdout, /ok  route: proxy 127\.0\.0\.1/);
    assert.match(r.stdout, /ok  ticket_create: Created SB-\d+/);
    assert.doesNotMatch(r.stdout, /pw|sess:/, 'proxy credentials are not printed');
    assert.equal(store.listTickets({ q: 'test cloud' }).tickets[0].origin, 'cloud');
  });
  await gateway(async (base) => {
    const env = { ...CLEAN, CLAUDE_CODE_REMOTE: 'true', SESSION_BOARD_URL: base, SESSION_BOARD_TOKEN: 'proxy', SESSION_BOARD_DIR: tmp() };
    const r = await run([join(ROOT, 'scripts', 'board.mjs'), 'doctor', '--cloud-only'], { env });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /BAD route: direct/);
    assert.match(r.stdout, /BAD GET \/api\/version: HTTP 302 redirect/);
    assert.match(r.stdout, /To fix:/);
  });
});
