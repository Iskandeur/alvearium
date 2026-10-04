// session-board — I/O side: config, identity, local store, remote calls.
// Every function here is defensive: a hook must never fail or block the session.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import tls from 'node:tls';
import {
  applyTransition,
  classify,
  VERSION,
  compareVersions,
  normalizeActorId,
  normalizeThread,
  isExpired,
  parseFilters,
  renderTicketsText,
  repoFromRemote,
  sanitizeEvent,
  shouldSend,
} from './core.mjs';

// ---- the one HTTP client of the plugin (hooks, MCP server, /board, /ticket, import).
//
// Why not the global fetch: Node's fetch ignores HTTPS_PROXY / https_proxy unless the process was
// started with NODE_USE_ENV_PROXY=1 (or --use-env-proxy), which only recent Node versions know. In a
// claude.ai/code cloud session every request is meant to leave through the agent proxy named in
// HTTPS_PROXY: that proxy attaches the environment's API credential (SESSION_BOARD_TOKEN=proxy). A
// request that bypasses it reaches the board without credential; behind an auth gateway (Cloudflare
// Access…) it is redirected to a login page, which fetch followed and read as a 200 — every hook
// "sent", every ticket "Created undefined", nothing on the board (0.3.3 and before).
//
// So: zero dependencies, node:http + node:tls, CONNECT tunnel through the proxy when the environment
// names one (NO_PROXY respected), and redirects are never followed (a redirect from the board API is
// a gateway, not the board). The returned object has the subset of the fetch Response the plugin uses.
//
// It lives in this file, not in a file of its own: a cloud environment cached with 0.3.3 updates
// itself with the 0.3.3 refresh script, which fetches a fixed list of files; a new file would be
// missing there and break the copy (scripts/cloud-refresh.sh).

const MAX_BODY = 8 * 1024 * 1024;

const envOf = (env, name) => env[name.toLowerCase()] || env[name.toUpperCase()] || '';

/** NO_PROXY: `*`, host names (suffix match, leading `.` or `*.` optional), optional `:port`. */
export function bypassProxy(target, noProxy) {
  const list = String(noProxy || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const entry of list) {
    if (entry === '*') return true;
    let [h, p] = entry.startsWith('[') ? [entry.slice(1, entry.indexOf(']')), entry.split(']:')[1]] : entry.split(':');
    if (p && p !== port) continue;
    h = h.replace(/^\*?\./, '');
    if (host === h || host.endsWith('.' + h)) return true;
  }
  return false;
}

/** The proxy URL for a target, from the environment (lower case wins, like curl), or null. */
export function proxyFor(url, env = process.env) {
  const target = url instanceof URL ? url : new URL(url);
  const raw = target.protocol === 'https:' ? envOf(env, 'https_proxy') || envOf(env, 'all_proxy') : envOf(env, 'http_proxy') || envOf(env, 'all_proxy');
  if (!raw) return null;
  if (bypassProxy(target, envOf(env, 'no_proxy'))) return null;
  try {
    const p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p : null;
  } catch {
    return null;
  }
}

/** How a request to `url` leaves this machine, for messages: `direct` or `proxy host:port`. */
export function routeOf(url, env = process.env) {
  const p = proxyFor(url, env);
  return p ? `proxy ${p.hostname}:${p.port || (p.protocol === 'https:' ? 443 : 80)}` : 'direct';
}

const readPem = (path) => {
  try {
    return path ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

let caCache;
/**
 * Certificates to trust through a proxy. An intercepting proxy (the agent proxy adds a header to an
 * HTTPS request, so it terminates TLS) presents certificates signed by its own CA, installed in the
 * system store: curl trusts them, Node only trusts its bundled roots. Bundled + extra + system.
 */
export function trustedCAs(env = process.env) {
  if (caCache && caCache.env === env) return caCache.list;
  const list = [];
  try {
    list.push(...(tls.getCACertificates?.('default') ?? tls.rootCertificates));
  } catch {
    list.push(...tls.rootCertificates);
  }
  let system = [];
  try {
    system = tls.getCACertificates?.('system') ?? [];
  } catch {}
  list.push(...system);
  for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) {
    const pem = readPem(env[name]);
    if (pem) list.push(pem);
  }
  if (!system.length) for (const p of ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem']) {
    const pem = readPem(p);
    if (pem) {
      list.push(pem);
      break;
    }
  }
  caCache = { env, list };
  return list;
}

function basicAuth(u) {
  if (!u.username) return undefined;
  return 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
}

class HeadersView {
  constructor(raw) {
    this.raw = raw;
  }
  get(name) {
    const v = this.raw[String(name).toLowerCase()];
    return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v);
  }
}

function responseOf(res, buf, url, route) {
  return {
    status: res.statusCode,
    statusText: res.statusMessage || '',
    ok: res.statusCode >= 200 && res.statusCode < 300,
    redirected: false,
    url,
    route,
    headers: new HeadersView(res.headers),
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const abortError = (signal) => {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
};

/** Open a socket to target through an HTTP(S) proxy (CONNECT), TLS on top for an https target. */
function tunnel(target, proxy, env, onRequest) {
  return new Promise((resolve, reject) => {
    const port = target.port || (target.protocol === 'https:' ? 443 : 80);
    const authority = `${target.hostname.includes(':') && !target.hostname.startsWith('[') ? `[${target.hostname}]` : target.hostname}:${port}`;
    const mod = proxy.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...(basicAuth(proxy) ? { 'proxy-authorization': basicAuth(proxy) } : {}) },
      agent: false,
      ...(proxy.protocol === 'https:' ? { ca: trustedCAs(env) } : {}),
    });
    onRequest(req);
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`the proxy ${proxy.hostname}:${proxy.port} refused the tunnel to ${authority}: ${res.statusCode} ${res.statusMessage || ''}`.trim()), { code: 'PROXY_CONNECT', status: res.statusCode }));
        return;
      }
      if (head?.length) socket.unshift(head);
      if (target.protocol !== 'https:') return resolve(socket);
      const secure = tls.connect({ socket, servername: target.hostname.replace(/^\[|\]$/g, ''), ca: trustedCAs(env), ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => resolve(secure));
      secure.once('error', reject);
    });
    req.once('error', (e) => reject(Object.assign(new Error(`proxy ${proxy.hostname}:${proxy.port}: ${e?.message || e?.code || e}`, { cause: e }), { code: e?.code })));
    req.end();
  });
}

/**
 * fetch-like request: `init` = { method, headers, body (string|Buffer), signal }. Never follows a
 * redirect (the response says 3xx and carries `location`). `env` picks the proxy (tests).
 */
export async function boardFetch(url, init = {}, { env = process.env } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`unsupported URL ${target.protocol}`);
  const signal = init.signal;
  if (signal?.aborted) throw abortError(signal);
  const proxy = proxyFor(target, env);
  const route = proxy ? `proxy ${proxy.hostname}:${proxy.port || (proxy.protocol === 'https:' ? 443 : 80)}` : 'direct';
  const body = init.body == null ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body));
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) if (v !== undefined) headers[k.toLowerCase()] = String(v);
  if (body && headers['content-length'] === undefined) headers['content-length'] = String(body.length);
  headers['accept-encoding'] = 'identity';

  let current; // the in-flight ClientRequest (CONNECT first, then the request itself)
  const onAbort = () => current?.destroy(abortError(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let options;
    const path = target.pathname + target.search;
    if (!proxy) {
      options = { mod: target.protocol === 'https:' ? https : http, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || undefined, path };
    } else if (target.protocol === 'http:') {
      // plain http through a proxy: absolute URI to the proxy, no tunnel
      const pa = basicAuth(proxy);
      if (pa) headers['proxy-authorization'] = pa;
      options = { mod: proxy.protocol === 'https:' ? https : http, host: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || undefined, path: target.href, hostHeader: target.host };
    } else {
      const socket = await tunnel(target, proxy, env, (r) => (current = r));
      if (signal?.aborted) {
        socket.destroy();
        throw abortError(signal);
      }
      options = { mod: http, host: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 443, path, createConnection: () => socket };
    }
    return await new Promise((resolve, reject) => {
      const req = options.mod.request({
        host: options.host,
        port: options.port,
        path: options.path,
        method: init.method || 'GET',
        headers: { host: options.hostHeader || target.host, ...headers },
        ...(options.createConnection ? { createConnection: options.createConnection } : { agent: false }),
      });
      current = req;
      req.once('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
        });
        res.once('end', () => {
          resolve(responseOf(res, Buffer.concat(chunks), target.href, route));
          req.socket?.destroy?.();
        });
        res.once('error', reject);
      });
      req.once('error', reject);
      req.end(body || undefined);
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * One line saying why a reply from the board API is not the board: a redirect (an auth gateway in
 * front of the server), 401/403, or a 2xx that is not JSON (a login page). '' when it looks fine.
 */
export function explainReply(res, text, { url = '', token = '', env = process.env } = {}) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'the board host';
    }
  })();
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  const route = routeOf(url || 'https://x.invalid', env);
  const credentialHint =
    token === 'proxy'
      ? cloud
        ? route === 'direct'
          ? `the request went out directly, not through the agent proxy (no HTTPS_PROXY in this process), so no API credential was attached for ${host}`
          : `the request went through the agent proxy (${route}) but came back without the credential: check that the environment's API credential lists the host ${host} exactly`
        : `SESSION_BOARD_TOKEN=proxy only works where a proxy adds the credential (claude.ai/code API credential for ${host}); here set the real token`
      : token
        ? 'the token was refused, or a gateway in front of the server wants its own credential'
        : 'no token is configured';
  const status = res.status;
  if (status >= 300 && status < 400) {
    const loc = res.headers?.get?.('location') || '';
    return `HTTP ${status} redirect to ${loc.slice(0, 120) || '(no location)'}: a gateway in front of the board (a login page${/cloudflareaccess|\/cdn-cgi\/access/.test(loc) ? ', Cloudflare Access' : ''}) stopped the request; ${credentialHint}.`;
  }
  if (status === 401 || status === 403) return `HTTP ${status} from ${host}: ${credentialHint}. ${String(text || '').replace(/\s+/g, ' ').slice(0, 120)}`.trim();
  if (status >= 200 && status < 300) {
    const t = String(text || '').trim();
    if (!t.startsWith('{') && !t.startsWith('[')) {
      const ct = res.headers?.get?.('content-type') || 'unknown type';
      return `HTTP ${status} from ${host} but not the board API (${ct}: ${t.replace(/\s+/g, ' ').slice(0, 80)}): a login or proxy page? ${credentialHint}.`;
    }
  }
  return '';
}

export const NETWORK_TIMEOUT_MS = 2000;
const GIT_REFRESH_MS = 60 * 1000;
const FAILURE_BACKOFF_MS = 30 * 1000;

/** Where local state lives. Fixed path so hooks, /board and the statusline agree without plumbing. */
export function dataDir(env = process.env) {
  return env.SESSION_BOARD_DIR || join(homedir(), '.claude', 'session-board');
}

/**
 * Remote config, first match wins:
 *   1. SESSION_BOARD_URL / SESSION_BOARD_TOKEN environment variables
 *   2. the plugin's userConfig (exported to hooks as CLAUDE_PLUGIN_OPTION_SERVER_URL / _TOKEN)
 *   3. ~/.claude/session-board/config.json  ({ "url": "...", "token": "..." })
 * Token `proxy` means: send no Authorization header, a proxy adds it (claude.ai/code API credential).
 */
export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(dataDir(env), 'config.json'), 'utf8'));
  } catch {}
  const url = (env.SESSION_BOARD_URL || env.CLAUDE_PLUGIN_OPTION_SERVER_URL || file.url || '').trim().replace(/\/+$/, '');
  const token = (env.SESSION_BOARD_TOKEN || env.CLAUDE_PLUGIN_OPTION_TOKEN || file.token || '').trim();
  const sendText = (env.SESSION_BOARD_SEND_TEXT ?? String(file.sendText ?? '1')) !== '0';
  const mirrorTasks = (env.SESSION_BOARD_MIRROR_TASKS ?? String(file.mirrorTasks ?? '1')) !== '0';
  // Who acts, and how sessions group (all optional; nothing changes when they are unset):
  //   SESSION_BOARD_ACTOR          id of the agent running these sessions (e.g. `ci-bot`, `job-42`)
  //   SESSION_BOARD_ACTOR_NAME     its display name
  //   SESSION_BOARD_THREAD         one session ticket shared by every session with this value
  //   SESSION_BOARD_SESSION_TICKETS=0  no automatic session / question / task tickets
  //   SESSION_BOARD_STOP_STATUS=done   a finished turn closes the session ticket (done) instead of
  //                                    putting it in "Ready for review" (default `review`): for agents
  //                                    whose output is reviewed elsewhere (a chat, a CI log)
  const actor = normalizeActorId(env.SESSION_BOARD_ACTOR || file.actor || '');
  const actorName = String(env.SESSION_BOARD_ACTOR_NAME || file.actorName || '').trim().slice(0, 60);
  const thread = normalizeThread(env.SESSION_BOARD_THREAD || '');
  const sessionTickets = (env.SESSION_BOARD_SESSION_TICKETS ?? String(file.sessionTickets ?? '1')) !== '0';
  const stopStatus = String(env.SESSION_BOARD_STOP_STATUS ?? file.stopStatus ?? '').trim().toLowerCase() === 'done' ? 'done' : 'review';
  const cfg = { url, token, remote: Boolean(url && token), sendText, mirrorTasks, actor, actorName, thread, sessionTickets, stopStatus };
  // The environment it was read from (proxy variables, cloud marker), for error messages; not enumerable.
  Object.defineProperty(cfg, 'env', { value: env, enumerable: false });
  return cfg;
}

export function authHeaders(cfg) {
  return cfg.token && cfg.token !== 'proxy' ? { authorization: `Bearer ${cfg.token}` } : {};
}

function sessionFile(dir, id) {
  return join(dir, 'sessions', `${id.replace(/[^\w.-]/g, '_')}.json`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Who is this session? Git info is cached per session and refreshed at most once a minute. */
export function identify(input, cached, env = process.env, now = Date.now(), cfg = loadConfig(env)) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  let gitInfo = cached?.git;
  if (!gitInfo || now - gitInfo.at > GIT_REFRESH_MS || gitInfo.cwd !== cwd) {
    gitInfo = {
      at: now,
      cwd,
      repo: repoFromRemote(git(cwd, ['remote', 'get-url', 'origin'])),
      branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    };
  }
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  // Documented link: https://claude.ai/code/${CLAUDE_CODE_REMOTE_SESSION_ID/#cse_/session_}
  const remoteId = (env.CLAUDE_CODE_REMOTE_SESSION_ID || '').replace(/^cse_/, 'session_');
  return {
    identity: {
      sessionId: String(input.session_id || 'unknown'),
      name: input.session_name || input.session_title || env.SESSION_BOARD_NAME || undefined,
      cwd,
      repo: gitInfo.repo,
      branch: gitInfo.branch,
      host: cloud ? 'claude.ai/code' : hostname(),
      surface: cloud ? 'cloud' : 'terminal',
      url: cloud && remoteId && /^[\w-]+$/.test(remoteId) ? `https://claude.ai/code/${remoteId}` : undefined,
      actor: cfg.actor || undefined,
      actorName: cfg.actor && cfg.actorName ? cfg.actorName : undefined,
      thread: cfg.thread || undefined,
      sessionTickets: cfg.sessionTickets ? undefined : false,
      stopStatus: cfg.stopStatus === 'done' ? 'done' : undefined,
    },
    git: gitInfo,
  };
}

/** Read the tail of the transcript to find the last assistant text (fallback for Stop). */
export function lastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return '';
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.slice(-400_000).split('\n').reverse();
  for (const l of lines) {
    if (!l.includes('"assistant"')) continue;
    try {
      const j = JSON.parse(l);
      const content = j.message?.content;
      if (j.type !== 'assistant' || !Array.isArray(content)) continue;
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) return text;
    } catch {}
  }
  return '';
}

export async function postEvent(cfg, payload, fetchImpl = boardFetch, timeoutMs = NETWORK_TIMEOUT_MS) {
  const res = await fetchImpl(`${cfg.url}/api/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(cfg), 'user-agent': 'session-board-hook/0.1' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Drain the body: an unread response keeps a handle open, and the hook must be able to exit
  // without process.exit() (see hooks/report.mjs, Windows libuv assertion).
  let body = null;
  let text = '';
  try {
    const buf = await res.arrayBuffer?.();
    if (buf) text = new TextDecoder().decode(buf);
    body = JSON.parse(text);
  } catch {}
  // A 2xx that is not the board's JSON (a login page behind a gateway) is a failure, not a delivery.
  const why = explainReply(res, text, { url: cfg.url, token: cfg.token, env: cfg.env || process.env });
  if (why) throw Object.assign(new Error(why), { status: res.status });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`.trim()), { status: res.status });
  if (!body || typeof body !== 'object') throw new Error(`HTTP ${res.status} without a JSON body: not the board API?`);
  return { status: res.status, body };
}

/**
 * Handle one hook invocation end to end. Returns a short status string (for tests / debugging).
 * Never throws for expected failures; the caller still wraps it. `out.serverVersion` is filled
 * when the server says its version (0.3.1+).
 */
export async function handleHook(event, input, { env = process.env, now = Date.now(), fetchImpl = boardFetch, out = {} } = {}) {
  const cfg = loadConfig(env);
  if (event === 'Stop' && typeof input.last_assistant_message !== 'string' && cfg.sendText) {
    input = { ...input, last_assistant_message: lastAssistantText(input.transcript_path) };
  }
  const t = classify(event, input, { sendText: cfg.sendText, mirrorTasks: cfg.mirrorTasks });
  if (!t || !input.session_id) return 'ignored';

  const dir = dataDir(env);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const path = sessionFile(dir, String(input.session_id));
  const stored = readJson(path) || {};
  if (!shouldSend(stored.lastSent, t, now)) return 'throttled';

  const { identity, git: gitInfo } = identify(input, stored, env, now, cfg);
  // `record` is kept for the throttle and older readers; tickets live in SQLite or on the server.
  const record = applyTransition(stored.record, t, identity, now);
  const next = { record, git: gitInfo, lastSent: stored.lastSent, failedAt: stored.failedAt, v: 2 };
  const payload = { v: 1, session: identity, transition: t, at: now };

  let status = 'local';
  if (cfg.remote) {
    if (stored.failedAt && now - stored.failedAt < FAILURE_BACKOFF_MS) {
      status = 'backoff';
    } else {
      try {
        // SessionEnd hooks share a 1.5 s budget (hooks reference), so that one gets a shorter fuse.
        const timeoutMs = event === 'SessionEnd' ? 1200 : NETWORK_TIMEOUT_MS;
        const reply = await postEvent(cfg, payload, fetchImpl, timeoutMs);
        // Servers from 0.3.1 on say their version: a copy vendored in a repo compares it (report.mjs).
        if (typeof reply?.body?.server_version === 'string') out.serverVersion = reply.body.server_version;
        next.failedAt = undefined;
        status = 'sent';
      } catch (err) {
        next.failedAt = now;
        status = 'send-failed';
        // SESSION_BOARD_DEBUG=1 prints it (hooks/report.mjs); also kept for /session-board:board doctor
        out.error = String(err?.cause?.message || err?.message || err);
        next.lastError = { at: now, error: out.error.slice(0, 300) };
      }
    }
  } else {
    const evt = sanitizeEvent(payload);
    let store;
    try {
      store = await openLocalStore(env);
      if (evt) store.ingest(evt, now);
      writeSummary(dir, store, now);
    } catch {
      status = 'local-failed';
    } finally {
      store?.close();
    }
  }
  // A mirrored task is not a state change of the session: it must not reset the throttle either.
  if (t.task || t.agent) next.record = stored.record ?? record;
  else if (status === 'sent' || status === 'local') next.lastSent = { state: t.state, at: now };
  writeJsonAtomic(path, next);
  rememberSessionCwd(dir, identity, now);
  if (t.state === 'closed') pruneLocal(dir, now);
  return status;
}

/** Local mode keeps every ticket in this SQLite file (same schema and queries as the server). */
export function localDbPath(env = process.env) {
  return join(dataDir(env), 'board.db');
}

/** Open the local store; on first use, import the v0.1 per-session JSON files (left in place). */
export async function openLocalStore(env = process.env) {
  const { openStore } = await import('./store.mjs');
  const store = await openStore(localDbPath(env));
  const done = store.q("SELECT value FROM meta WHERE key = 'legacy_local_import'").get();
  if (!done) {
    store.importLegacy(readLocalRecords(dataDir(env)));
    store.q("INSERT OR REPLACE INTO meta(key, value) VALUES ('legacy_local_import', ?)").run(String(Date.now()));
  }
  return store;
}

/**
 * Small summary next to the database, for readers that cannot open SQLite (the terminal mod, the
 * self-contained statusline): ticket counts and the text board.
 */
export function writeSummary(dir, store, now = Date.now()) {
  try {
    const board = store.ticketBoard({}, { perColumn: 12, doneShown: 0, now });
    writeJsonAtomic(join(dir, 'summary.json'), { at: now, counts: board.counts, text: renderTicketsText(board, { now }) });
  } catch {}
}

/** Last session seen in a directory: the MCP server gets no session id, it looks it up by cwd. */
function cwdFile(dir, cwd) {
  return join(dir, 'cwd', createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16) + '.json');
}

export function rememberSessionCwd(dir, identity, now = Date.now()) {
  if (!identity.cwd || !identity.sessionId || identity.sessionId === 'unknown') return;
  try {
    mkdirSync(join(dir, 'cwd'), { recursive: true });
    writeJsonAtomic(cwdFile(dir, identity.cwd), { sessionId: identity.sessionId, cwd: identity.cwd, repo: identity.repo, branch: identity.branch, at: now });
  } catch {}
}

export function sessionForCwd(dir, cwd) {
  return readJson(cwdFile(dir, cwd));
}

/** All locally known session records (v0.1 files, still written for the throttle). */
export function readLocalRecords(dir = dataDir()) {
  let names = [];
  try {
    names = readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJson(join(dir, 'sessions', n))?.record).filter(Boolean);
}

export function pruneLocal(dir = dataDir(), now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, 'sessions', n);
    const rec = readJson(p)?.record;
    if (!rec || isExpired(rec, now)) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }
}

// ---- one backend for the CLI, the MCP server and the mod: HTTP when configured, else SQLite ------

const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    for (const x of [v].flat()) u.append(k, String(x));
  }
  const s = u.toString();
  return s ? '?' + s : '';
};

export class HttpBackend {
  constructor(cfg, { actor = 'user', actorName = '', fetchImpl = boardFetch, timeoutMs = 5000 } = {}) {
    this.cfg = cfg;
    this.actor = actor;
    this.actorName = actorName;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.source = cfg.url;
  }
  async call(method, path, body) {
    const res = await this.fetch(`${this.cfg.url}${path}`, {
      method,
      headers: {
        ...authHeaders(this.cfg),
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-session-board-actor': this.actor,
        ...(this.actorName ? { 'x-session-board-actor-name': encodeURIComponent(this.actorName) } : {}),
        'user-agent': 'session-board-client/0.3',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    // Never read a redirect, a login page or a proxy page as an answer ("Created undefined", 0.3.3).
    const why = explainReply(res, text, { url: this.cfg.url, token: this.cfg.token, env: this.cfg.env || process.env });
    if (why) throw Object.assign(new Error(why), { status: res.status });
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}` };
    }
    if (!res.ok) throw Object.assign(new Error(data?.error ? `${data.error} (HTTP ${res.status})` : `HTTP ${res.status}`), { status: res.status });
    if (!data || typeof data !== 'object') throw Object.assign(new Error(`HTTP ${res.status}: the reply is not a JSON object (not the board API?)`), { status: res.status });
    return data;
  }
  list(params) {
    return this.call('GET', '/api/tickets' + qs(params));
  }
  board(params) {
    return this.call('GET', '/api/tickets/board' + qs(params));
  }
  get(key) {
    return this.call('GET', '/api/tickets/' + encodeURIComponent(key));
  }
  create(body) {
    return this.call('POST', '/api/tickets', body);
  }
  update(key, body) {
    return this.call('POST', '/api/tickets/' + encodeURIComponent(key), body);
  }
  comment(key, text, to) {
    return this.call('POST', '/api/tickets/' + encodeURIComponent(key) + '/comments', to ? { text, to } : { text });
  }
  next(params) {
    return this.call('GET', '/api/tickets/next' + qs(params));
  }
  move(key, body) {
    return this.call('POST', '/api/tickets/' + encodeURIComponent(key) + '/move', body);
  }
  facets() {
    return this.call('GET', '/api/facets');
  }
  close() {}
}

export class LocalBackend {
  constructor(store, { actor = 'user', actorName = '' } = {}) {
    this.store = store;
    this.actor = actor;
    this.source = 'local';
    if (actor !== 'user') store.touchActor({ id: actor, type: 'agent', name: actorName || null });
  }
  async list(params) {
    return this.store.listTickets(parseFilters(params));
  }
  async board(params) {
    return this.store.ticketBoard(parseFilters(params));
  }
  async get(key) {
    const t = this.store.getTicket(key);
    if (!t) throw Object.assign(new Error('ticket not found'), { status: 404 });
    return t;
  }
  async create(body) {
    return this.store.createTicket(body, { actor: this.actor });
  }
  async update(key, body) {
    return this.store.updateTicket(key, body, { actor: this.actor });
  }
  async comment(key, text, to) {
    return this.store.comment(key, text, { actor: this.actor, to });
  }
  async next(params) {
    return this.store.nextTickets(parseFilters({ limit: 50, ...params }));
  }
  async move(key, body) {
    return this.store.moveTicket(key, body, { actor: this.actor });
  }
  async facets() {
    return this.store.facets();
  }
  close() {
    this.store.close();
  }
}

/**
 * `actor: 'agent'` = whoever runs this process: SESSION_BOARD_ACTOR when set, else `claude`
 * (the MCP server). The /ticket CLI stays `user`: a human types it.
 */
export async function openBackend({ env = process.env, actor = 'user', fetchImpl = boardFetch } = {}) {
  const cfg = loadConfig(env);
  const id = actor === 'agent' ? cfg.actor || 'claude' : actor;
  const actorName = actor === 'agent' && cfg.actor ? cfg.actorName : '';
  if (cfg.remote) return new HttpBackend(cfg, { actor: id, actorName, fetchImpl });
  return new LocalBackend(await openLocalStore(env), { actor: id, actorName });
}

/** Ticket board from the server when configured, else from the local store. */
export async function loadBoard({ env = process.env, fetchImpl = boardFetch, params = {} } = {}) {
  const backend = await openBackend({ env, fetchImpl });
  try {
    return { source: backend.source, board: await backend.board(params) };
  } finally {
    backend.close();
  }
}

export const CLOUD_SETUP_HINT =
  'session-board is not configured in this cloud environment. In the environment settings on claude.ai/code, set SESSION_BOARD_URL ' +
  '(your board server) and either an API credential for that host with SESSION_BOARD_TOKEN=proxy, or SESSION_BOARD_TOKEN itself; then start a new session.';

/**
 * Guard for the scripts of the copy vendored into a repository (run with `--cloud-only`): '' when
 * they may run, else the line to print instead. Off the cloud the plugin is the tool to use.
 */
export function cloudCopyGuard(command, env = process.env) {
  if (env.CLAUDE_CODE_REMOTE !== 'true')
    return `session-board: /${command} here is the repository's copy for claude.ai/code cloud sessions; on this machine use /session-board:${command} (the plugin).`;
  return loadConfig(env).remote ? '' : CLOUD_SETUP_HINT;
}

/**
 * A copy vendored into a repository (`/session-board:install-cloud`) does not update itself. At a
 * cloud SessionStart, when the server is newer than the copy, say so once per machine (a cloud VM
 * lives for one session) and per server version. Returns the message, or '' to stay quiet.
 */
export function staleCopyNotice(copyVersion, serverVersion, env = process.env, { fromEnvironment = false } = {}) {
  if (!serverVersion || compareVersions(copyVersion, serverVersion) >= 0) return '';
  const flag = join(dataDir(env), 'stale-copy-notice.json');
  if (readJson(flag)?.serverVersion === serverVersion) return '';
  try {
    mkdirSync(dataDir(env), { recursive: true });
    writeJsonAtomic(flag, { serverVersion, copyVersion, at: Date.now() });
  } catch {}
  if (fromEnvironment)
    return (
      `session-board: this cloud environment's setup script installed version ${copyVersion}, the board server runs ${serverVersion}. ` +
      'Point the Setup script at the newer version (claude.ai/code → environment → edit); the next new session picks it up.'
    );
  return (
    `session-board: this repository carries version ${copyVersion} of the cloud copy (.claude/session-board/), ` +
    `the board server runs ${serverVersion}. On a machine with the plugin, update it and run /session-board:install-cloud again, then commit .claude/ and .mcp.json.`
  );
}

/**
 * The installed plugin (terminal) is older than the board server. A third-party marketplace does not
 * update its plugins unless the user turns auto-update on for it, once, in /plugin (Claude Code docs,
 * "Plugins update automatically when the marketplace they came from has auto-update turned on";
 * third-party marketplaces are "Off by default"). Say so once per machine and server version.
 */
export function pluginUpdateNotice(pluginVersion, serverVersion, env = process.env) {
  if (!serverVersion || compareVersions(pluginVersion, serverVersion) >= 0) return '';
  const flag = join(dataDir(env), 'plugin-update-notice.json');
  if (readJson(flag)?.serverVersion === serverVersion) return '';
  try {
    mkdirSync(dataDir(env), { recursive: true });
    writeJsonAtomic(flag, { serverVersion, pluginVersion, at: Date.now() });
  } catch {}
  return (
    `session-board: this machine runs the plugin ${pluginVersion}, the board server runs ${serverVersion}. ` +
    'To get every update without a command, turn auto-update on once: /plugin → Marketplaces → session-board → Enable auto-update. ' +
    'Right now: claude plugin marketplace update session-board && claude plugin update session-board@session-board, then /reload-plugins.'
  );
}

export { sanitizeEvent };

// ---- doctor: can this session write to the board? (scripts/doctor.mjs, `/board doctor`) -------------
// Here rather than in scripts/doctor.mjs for the same reason as the HTTP client above: `/board doctor`
// must work in a copy that a 0.3.3 refresh script updated without the new file.

const redact = (u) => {
  try {
    const x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`);
    return `${x.protocol}//${x.username ? '***@' : ''}${x.host}`;
  } catch {
    return '(unparsable)';
  }
};


/** Last hook failure recorded on this machine (lib/runtime.mjs handleHook), if any. */
function lastHookError(env) {
  let best = null;
  try {
    const dir = join(dataDir(env), 'sessions');
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      try {
        const e = JSON.parse(readFileSync(join(dir, n), 'utf8')).lastError;
        if (e && (!best || e.at > best.at)) best = e;
      } catch {}
    }
  } catch {}
  return best;
}

export async function runDoctor({ ticket, env = process.env } = {}) {
  const pick = (n) => env[n.toLowerCase()] || env[n.toUpperCase()] || '';
  const r = { version: VERSION, node: process.version, cloud: env.CLAUDE_CODE_REMOTE === 'true', checks: [], fixes: [] };
  const ok = (name, detail) => r.checks.push({ name, ok: true, detail });
  const bad = (name, detail, fix) => {
    r.checks.push({ name, ok: false, detail });
    if (fix) r.fixes.push(fix);
  };
  const info = (name, detail) => r.checks.push({ name, ok: null, detail });

  info('environment', `${r.cloud ? 'claude.ai/code cloud session' : 'terminal'} · node ${process.version} · session-board ${VERSION}`);
  const cfg = loadConfig(env);
  if (!cfg.url) {
    bad('server URL', 'not set: local mode (this machine only)', r.cloud ? 'Set SESSION_BOARD_URL in the cloud environment (claude.ai/code → environment → edit), then start a new session.' : null);
  } else ok('server URL', cfg.url);
  const tokenKind = !cfg.token ? 'not set' : cfg.token === 'proxy' ? '`proxy` (no header sent; a proxy must add the credential)' : `set (${cfg.token.length} characters, not shown)`;
  if (cfg.url && !cfg.token)
    bad('token', tokenKind, 'Set SESSION_BOARD_TOKEN: the board token, or `proxy` with an API credential for the board host on the cloud environment.');
  else if (cfg.url) (cfg.token === 'proxy' && !r.cloud ? bad : ok)('token', tokenKind, cfg.token === 'proxy' && !r.cloud ? 'SESSION_BOARD_TOKEN=proxy only works in claude.ai/code with an API credential; on this machine use the real token.' : null);

  const proxyVar = pick('https_proxy') || pick('all_proxy');
  const noProxy = pick('no_proxy');
  if (proxyVar) info('proxy variables', `HTTPS_PROXY=${redact(proxyVar)}${noProxy ? ` · NO_PROXY=${noProxy.slice(0, 120)}` : ''}`);
  else info('proxy variables', 'none (HTTPS_PROXY / https_proxy unset)');
  if (cfg.url) {
    const route = routeOf(cfg.url, env);
    const proxied = Boolean(proxyFor(cfg.url, env));
    if (r.cloud && cfg.token === 'proxy' && !proxied)
      bad('route', `${route}: the agent proxy will not see these requests, so it cannot attach the credential`, proxyVar ? `NO_PROXY covers ${new URL(cfg.url).host}: remove it from NO_PROXY in the environment.` : 'No HTTPS_PROXY in this process: the credential cannot be added. Check the environment\'s network access, or put the real token in SESSION_BOARD_TOKEN.');
    else ok('route', `${route} (plugin requests, boardFetch)`);
    info('node fetch', env.NODE_USE_ENV_PROXY === '1' ? 'NODE_USE_ENV_PROXY=1 (global fetch also uses the proxy)' : 'the global fetch ignores the proxy variables here; session-board does not use it (0.3.4+)');
  }

  if (cfg.url && cfg.token) {
    // 1. reachability + identity of the thing that answers
    try {
      const res = await boardFetch(`${cfg.url}/api/version`, { headers: { ...authHeaders(cfg), 'user-agent': `session-board-doctor/${VERSION}` }, signal: AbortSignal.timeout(8000) }, { env });
      const text = await res.text();
      const why = explainReply(res, text, { url: cfg.url, token: cfg.token, env });
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      if (why) bad('GET /api/version', why, 'The request reached a gateway or a login page, not the board: see the line above.');
      else if (!res.ok || typeof body?.version !== 'string') bad('GET /api/version', `HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`, 'Is SESSION_BOARD_URL the board base URL (the page you open, without /api)?');
      else ok('GET /api/version', `HTTP ${res.status}, server ${body.version}${body.version !== VERSION ? ` (this copy: ${VERSION})` : ''}`);
    } catch (e) {
      bad('GET /api/version', `${e?.name === 'TimeoutError' ? 'timed out after 8 s' : e?.message || e}${e?.cause ? ` (${e.cause.message || e.cause})` : ''}`, /certificate|self.signed|UNABLE_TO|CERT_/i.test(String(e?.message || e?.code)) ? 'TLS: the proxy certificate is not trusted by Node; set NODE_EXTRA_CA_CERTS to the system bundle (e.g. /etc/ssl/certs/ca-certificates.crt).' : 'The server cannot be reached from here: URL, network access level of the environment, proxy.');
    }
    // 2. an authenticated read through the backend the MCP tools use
    const backend = new HttpBackend(cfg, { actor: cfg.actor || 'claude', timeoutMs: 8000 });
    let authed = false;
    try {
      const list = await backend.list({ limit: 1 });
      if (!Array.isArray(list?.tickets)) throw new Error(`unexpected reply ${JSON.stringify(list).slice(0, 120)}`);
      authed = true;
      ok('authenticated read', `GET /api/tickets: ${list.total ?? list.tickets.length} ticket(s) visible`);
    } catch (e) {
      bad('authenticated read', e?.message || String(e), e?.status === 401 || e?.status === 403 ? 'The board refused the credential: check SESSION_BOARD_TOKEN, or the API credential value and its host.' : null);
    }
    // 3. optional write, exactly as ticket_create does it
    if (ticket && authed) {
      try {
        const { callTool, currentContext } = await import('../mcp/server.mjs');
        const text = await callTool('ticket_create', { title: String(ticket), assignee: 'user', kind: 'note', body: `Created by session-board doctor ${VERSION} (${r.cloud ? 'cloud' : 'terminal'}).` }, { backend, context: currentContext(env) });
        ok('ticket_create', text);
        r.ticket = text;
      } catch (e) {
        bad('ticket_create', e?.message || String(e));
      }
    } else if (ticket) info('ticket_create', 'skipped: the authenticated read failed');
  }

  const last = lastHookError(env);
  if (last) info('last hook failure', `${new Date(last.at).toISOString().slice(0, 19).replace('T', ' ')} UTC: ${last.error}`);
  r.ok = r.checks.every((c) => c.ok !== false);
  return r;
}

export function renderDoctor(r) {
  const mark = (c) => (c.ok === true ? 'ok ' : c.ok === false ? 'BAD' : ' · ');
  const out = [`session-board doctor — ${r.ok ? 'the board answers as the board' : 'problem found'}`, ''];
  for (const c of r.checks) out.push(`${mark(c)} ${c.name}: ${c.detail}`);
  if (r.fixes.length) out.push('', 'To fix:', ...[...new Set(r.fixes)].map((f) => `- ${f}`));
  return out.join('\n');
}

/** CLI: `[--ticket <title>] [--json]`; prints the report, exit code 0 only when the board answers. */
export async function doctorMain(args = [], env = process.env) {
  const i = args.indexOf('--ticket');
  const r = await runDoctor({ ticket: i >= 0 ? args[i + 1] : undefined, env });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : renderDoctor(r));
  process.exitCode = r.ok ? 0 : 1;
}
