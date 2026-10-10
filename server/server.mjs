#!/usr/bin/env node
// session-board server: receives hook events, stores tickets, serves the API and one web page.
// Zero dependencies. Storage: node:sqlite (Node ≥ 22.13), one file `board.db` in the data directory.
//
// Env:
//   SESSION_BOARD_TOKEN       bearer token (or SESSION_BOARD_TOKEN_FILE: path to a file holding it)
//   SESSION_BOARD_AGENT_TOKENS_FILE  agent tokens, one `<actor> <token>` per line
//                                    (default <SESSION_BOARD_DATA>/agent-tokens; absent = none)
//   SESSION_BOARD_DATA        directory for board.db                (default ./data)
//   PORT                      listen port                           (default 8793)
//   HOST                      listen address                        (default 0.0.0.0)
//   SESSION_BOARD_TRUST_PROXY=1  rate limits key on CF-Connecting-IP / X-Forwarded-For (only behind a proxy you run)
//
// Routes (all /api/* need `Authorization: Bearer <token>`, the main token or an agent token; a
// request made with an agent token acts as that agent and never as the user, see `authOf`):
//   POST /api/event                 hook event (v0.1 payload, still the only thing hooks send);
//                                   the reply carries `server_version` (vendored copies compare it)
//   GET  /api/version               { version } of this server
//   GET  /api/board                 v0.1 board (sessions in columns) + `tickets.counts`
//   POST /api/dismiss               v0.1: { sessionId } → the session's review ticket is done
//   GET  /api/tickets               list: ?session&repo&branch&machine&origin&status&assignee&kind
//                                   &label&source&priority&parent&q&created_after…&archived&sort&limit&offset
//   GET  /api/tickets/board         same filters, grouped in board columns
//   GET  /api/tickets/next          open, unblocked work, by priority → rank → age (same filters + actor)
//   POST /api/tickets/:key/move     { after | before }: manual order (drag and drop)
//   GET  /api/stream                Server-Sent Events: one `change` per change, `:` heartbeat every 15 s
//   GET  /api/actors                who acts on the board (humans, agents, subagents, system)
//   POST /api/tickets               create
//   GET  /api/tickets/:key          one ticket with history and sub-tickets
//   POST|PATCH /api/tickets/:key    update (status, title, body, labels, …, optional `comment`)
//   POST /api/tickets/:key/comments { text }
//   GET  /api/facets                values to filter on (repos, sessions, machines, labels, kinds)
//   GET  /api/sessions              sessions, most recent first (?repo)
//   POST /api/import                { board, machine, sessions, tickets }: a machine's local board.db,
//                                   idempotent per (board, ticket id); the plugin sends it once
//   DELETE /api/sessions/:id        a session and its tickets (cleanup, tests)
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, normalizeActorId, parseFilters, sanitizeEvent } from '../lib/core.mjs';
import { openStore } from '../lib/store.mjs';
import { AVATAR_MAX_BYTES, checkAvatar } from '../lib/avatar.mjs';
import { inviteRoutes } from './invites.mjs';
import { Accounts, GRANTABLE_ROLES, OWNER_ID, SESSION_TTL_MS, can } from '../lib/accounts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_IMPORT_BODY = 4 * 1024 * 1024;

export function readToken(env = process.env) {
  if (env.SESSION_BOARD_TOKEN) return env.SESSION_BOARD_TOKEN.trim();
  if (env.SESSION_BOARD_TOKEN_FILE) return readFileSync(env.SESSION_BOARD_TOKEN_FILE, 'utf8').trim();
  return '';
}

export function bearerOk(header, token) {
  if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7).trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Actor ids an agent token can never be bound to: they mean the person, or the hooks. */
const RESERVED_AGENT_ACTORS = ['user', 'hook'];

/**
 * Agent tokens, for agents and bots that run sessions unattended (a daemon, CI). One per line:
 * `<actor> <token>`; blank lines and `#` comments are skipped. The actor is the agent's root id:
 * what it writes is attributed to it, or to one of its sub-actors (`lupi` → `lupi/job-42`), never
 * to `user`. Throws on a line it cannot read: a typo must not leave an agent with the main token.
 */
export function parseAgentTokens(text) {
  const out = [];
  for (const [i, raw] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [actorRaw, token, extra] = line.split(/\s+/);
    const actor = normalizeActorId(actorRaw);
    if (!actor || !token || extra !== undefined) throw new Error(`agent tokens, line ${i + 1}: expected "<actor> <token>"`);
    if (RESERVED_AGENT_ACTORS.includes(actor)) throw new Error(`agent tokens, line ${i + 1}: "${actor}" cannot be an agent`);
    if (token.length < 24) throw new Error(`agent tokens, line ${i + 1}: the token must be at least 24 characters`);
    if (out.some((a) => a.token === token)) throw new Error(`agent tokens, line ${i + 1}: this token is already listed`);
    out.push({ actor, token });
  }
  return out;
}

/** The agent tokens file: SESSION_BOARD_AGENT_TOKENS_FILE, else `agent-tokens` in the data directory. */
export function readAgentTokens(env = process.env, dataDir = env.SESSION_BOARD_DATA || join(process.cwd(), 'data')) {
  const explicit = env.SESSION_BOARD_AGENT_TOKENS_FILE?.trim();
  const path = explicit || join(dataDir, 'agent-tokens');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (!explicit && e?.code === 'ENOENT') return [];
    throw new Error(`cannot read the agent tokens (${path}): ${e?.code || e?.message || e}`);
  }
  return parseAgentTokens(text);
}

/**
 * Who is calling: `{ kind: 'agent', actor }` for an agent token, `{ kind: 'user' }` for the main
 * token, null otherwise. Agent tokens are checked first: whatever the configuration, a request that
 * carries one is never the user.
 */
export function authOf(header, { token, agents = [] }) {
  for (const a of agents) if (bearerOk(header, a.token)) return { kind: 'agent', actor: a.actor };
  return bearerOk(header, token) ? { kind: 'user' } : null;
}

/** An actor id an agent may use: its root, or a sub-actor under it (`lupi/job-42`); else the root. */
export function scopeActor(requested, root) {
  const id = normalizeActorId(requested);
  return id && (id === root || id.startsWith(root + '/')) ? id : root;
}

/** A display name that reads as the person (`You`, `user`) is dropped: names never impersonate. */
export function agentDisplayName(name) {
  const n = String(name ?? '').trim();
  return n && !/^(you|user)$/i.test(n) ? n : null;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req, max = MAX_BODY) {
  return readRaw(req, max).then((b) => b.toString('utf8'));
}

function readRaw(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req, max) {
  try {
    const v = JSON.parse((await readBody(req, max)) || '{}');
    if (!v || typeof v !== 'object') throw new Error('bad');
    return v;
  } catch (e) {
    throw Object.assign(new Error(e.status === 413 ? 'too large' : 'bad body'), { status: e.status || 400 });
  }
}

/**
 * Who made a change. With the main token: the `x-session-board-actor` header (the MCP server sends
 * `claude`, or the SESSION_BOARD_ACTOR of its session), optionally named by
 * `x-session-board-actor-name`; the page, the CLI and anything without the header is the user.
 * With an agent token: the token's actor, or a sub-actor under it named by the header; never `user`,
 * `claude` or `hook`, whatever the header says.
 */
export function actorOfAuth(req, store, auth = { kind: 'user' }, accounts = null) {
  const header = req.headers['x-session-board-actor'];
  let id;
  if (auth.kind === 'agent') id = scopeActor(header, auth.actor);
  else if (auth.kind === 'member') {
    // A member's own Claude is `<member>/claude`; anything else it names stays under the member.
    const h = normalizeActorId(header);
    if (!h || h === 'user' || h === auth.member) return auth.member;
    id = h === 'claude' ? `${auth.member}/claude` : scopeActor(h, auth.member);
    if (id === auth.member) return auth.member;
    store.touchActor({ id, type: 'agent', name: h === 'claude' ? 'Claude' : null, parent: auth.member });
    return id;
  } else {
    id = normalizeActorId(header);
    if (!id || id === 'user') return 'user';
    if (id === 'claude' || id === 'hook') return id;
    // A header never names another human: what the owner's token does is the owner's.
    if (accounts?.getMember(id)) return 'user';
  }
  if (id === 'claude') return id;
  let name = null;
  try {
    name = agentDisplayName(decodeURIComponent(String(req.headers['x-session-board-actor-name'] || '')));
  } catch {}
  store.touchActor({ id, type: 'agent', name });
  return id;
}

/** An event sent with an agent or member token: its session belongs to that agent or member. */
function scopeEvent(evt, auth) {
  if (auth.kind === 'member') {
    const raw = normalizeActorId(evt.identity.actor);
    const actor = !raw || raw === 'claude' || raw === 'user' ? `${auth.member}/claude` : scopeActor(raw, auth.member);
    return { ...evt, identity: { ...evt.identity, actor, actorName: agentDisplayName(evt.identity.actorName) ?? (actor.endsWith('/claude') ? 'Claude' : undefined) } };
  }
  if (auth.kind !== 'agent') return evt;
  const actor = scopeActor(evt.identity.actor, auth.actor);
  return { ...evt, identity: { ...evt.identity, actor, actorName: agentDisplayName(evt.identity.actorName) ?? undefined } };
}

const forbidden = (res, what, auth) =>
  send(res, 403, { error: auth?.kind === 'agent' || !auth ? `an agent token cannot ${what}` : `the ${auth.role} role cannot ${what}` });

/**
 * Who may change an actor's name or picture: owner and admin any; an agent itself and its
 * sub-actors; any human itself and its sub-actors (its own Claude). Never another human.
 */
export function canEditActor(auth, id) {
  const sid = String(id);
  if (auth.kind === 'agent') return sid === auth.actor || sid.startsWith(auth.actor + '/');
  if (can(auth, 'editAnyActor')) return true;
  const self = auth.member || 'user';
  return sid === self || sid.startsWith(self + '/');
}

/** The role of a caller: the main token is the owner, an agent token is `agent`. */
export function withRole(auth) {
  if (!auth) return null;
  if (auth.role) return auth;
  if (auth.kind === 'agent') return { ...auth, role: 'agent' };
  return { ...auth, role: 'owner', member: OWNER_ID };
}

export const SESSION_COOKIE = 'alv_session';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(value, maxAgeS) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}

/**
 * Failed-attempt limiter, per client address: after `max` failures in `windowMs`, further failures
 * answer 429 instead of 401. A valid credential is never slowed down (nobody locks the owner out by
 * spamming wrong tokens from behind the same proxy); guessing a 32-byte token is hopeless anyway,
 * this only keeps the logs and the CPU quiet.
 */
export class Limiter {
  constructor({ max = 30, windowMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  hit(key) {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      e = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.n++;
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    return e.n > this.max;
  }
  blocked(key) {
    const e = this.hits.get(key);
    return !!e && e.reset > this.now() && e.n >= this.max;
  }
}

export function clientKey(req, trustProxy = false) {
  if (trustProxy) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h.slice(0, 64);
  }
  return req.socket?.remoteAddress || '?';
}

/**
 * An avatar, as stored: its own sniffed type, never sniffed again by the browser, no script ever
 * (CSP sandbox), cached by etag (the page asks with `?v=<etag>`, so a new picture is a new URL).
 */
function sendAvatar(req, res, av) {
  if (!av) return send(res, 404, { error: 'no avatar' });
  const etag = `"${av.etag}"`;
  const headers = {
    'content-type': av.mime,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'inline; filename="avatar"',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=86400',
    etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-length': av.data.length });
  res.end(req.method === 'HEAD' ? undefined : av.data);
}

/** What the page and the CLI need to know about the caller. */
function meOf(auth, accounts) {
  if (auth.kind === 'agent') return { id: auth.actor, kind: 'agent', role: 'agent', name: accounts.displayName(auth.actor) };
  const id = auth.member || OWNER_ID;
  return { id, kind: 'human', role: auth.role, name: accounts.displayName(id), via: auth.via || 'token', humans: accounts.activeHumans(), ...(auth.via === 'cookie' ? { csrf: auth.csrf } : {}) };
}

/**
 * Accounts routes: who am I, the page session, members, personal tokens, the audit log.
 * Returns true when it answered.
 */
async function accountRoutes(req, res, url, { store, accounts, auth, cutStreams }) {
  const path = url.pathname;
  const m = req.method;
  const by = auth.kind === 'agent' ? auth.actor : auth.member || OWNER_ID;
  const human = auth.kind !== 'agent';

  if (path === '/api/me' && m === 'GET') return send(res, 200, meOf(auth, accounts)), true;

  if (path === '/api/session' && m === 'POST') {
    // Trade a token for an httpOnly cookie, so the page never keeps a token in its storage.
    if (!human) return forbidden(res, 'open a page session', auth), true;
    if (auth.via !== 'bearer' && auth.via !== 'token') return send(res, 400, { error: 'send the token as a Bearer header' }), true;
    const s = accounts.issueToken(auth.member || OWNER_ID, { kind: 'session', ttlMs: SESSION_TTL_MS });
    res.setHeader('set-cookie', sessionCookie(s.token, Math.floor(SESSION_TTL_MS / 1000)));
    return send(res, 200, { ...meOf({ ...auth, via: 'cookie', csrf: s.csrf }, accounts) }), true;
  }
  if (path === '/api/logout' && m === 'POST') {
    if (auth.tokenKind === 'session') {
      accounts.revokeToken(auth.tokenId, by);
      cutStreams((a) => a.tokenId === auth.tokenId);
    }
    res.setHeader('set-cookie', sessionCookie('', 0));
    return send(res, 200, { ok: true }), true;
  }

  if (path === '/api/members' && m === 'GET') {
    if (!human) return forbidden(res, 'list members', auth), true;
    return send(res, 200, { members: accounts.listMembers({ withTokens: can(auth, 'manageMembers') }), roles: GRANTABLE_ROLES, me: meOf(auth, accounts) }), true;
  }
  const mm = path.match(/^\/api\/members\/([\w-]{1,64})$/);
  if (mm) {
    const id = mm[1];
    const target = accounts.getMember(id);
    if (!target || target.revoked_at) return send(res, 404, { error: 'member not found' }), true;
    if (m === 'PATCH' || m === 'POST') {
      if (!human) return forbidden(res, 'change members', auth), true;
      const body = await jsonBody(req);
      const self = id === (auth.member || OWNER_ID);
      if (body.role !== undefined) {
        if (!can(auth, 'manageMembers')) return forbidden(res, 'change roles', auth), true;
        if (target.role === 'owner') return forbidden(res, "change the owner's role", auth), true;
        accounts.setRole(id, String(body.role), by);
      }
      if (body.name !== undefined) {
        if (!self && !can(auth, 'manageMembers')) return forbidden(res, "rename someone else", auth), true;
        if (target.role === 'owner' && auth.role !== 'owner') return forbidden(res, 'rename the owner', auth), true;
        accounts.renameMember(id, body.name, by);
      }
      return send(res, 200, { member: accounts.listMembers({ withTokens: can(auth, 'manageMembers') }).find((x) => x.id === id) }), true;
    }
    if (m === 'DELETE') {
      if (!can(auth, 'manageMembers')) return forbidden(res, 'revoke members', auth), true;
      if (target.role === 'owner') return forbidden(res, 'revoke the owner', auth), true;
      accounts.revokeMember(id, by);
      cutStreams((a) => a.member === id);
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 405, { error: 'method not allowed' }), true;
  }

  if (path === '/api/tokens') {
    if (!can(auth, 'ownTokens')) return forbidden(res, 'manage personal tokens', auth), true;
    const me = auth.member || OWNER_ID;
    if (m === 'GET') return send(res, 200, { tokens: accounts.listTokens(me).map((t) => ({ ...t, current: t.id === auth.tokenId })) }), true;
    if (m === 'POST') {
      const body = await jsonBody(req);
      if (accounts.listTokens(me).filter((t) => t.kind === 'api').length >= 20) return send(res, 409, { error: 'at most 20 personal tokens: revoke one first' }), true;
      const t = accounts.issueToken(me, { kind: 'api', label: body.label ?? null });
      return send(res, 201, { id: t.id, token: t.token, label: t.label, note: 'shown once: copy it now' }), true;
    }
    return send(res, 405, { error: 'method not allowed' }), true;
  }
  const tkm = path.match(/^\/api\/tokens\/(tk_[a-f0-9]{1,32})$/);
  if (tkm) {
    if (m !== 'DELETE') return send(res, 405, { error: 'method not allowed' }), true;
    if (!human) return forbidden(res, 'revoke tokens', auth), true;
    const t = accounts.getToken(tkm[1]);
    const mine = t && t.member_id === (auth.member || OWNER_ID);
    // Someone else's token: an admin may revoke it, except the owner's.
    const owners = t && t.member_id === OWNER_ID;
    if (!t || t.revoked_at || (!mine && !(can(auth, 'manageMembers') && (!owners || auth.role === 'owner')))) return send(res, 404, { error: 'token not found' }), true;
    accounts.revokeToken(t.id, by);
    cutStreams((a) => a.tokenId === t.id);
    if (t.id === auth.tokenId && auth.via === 'cookie') res.setHeader('set-cookie', sessionCookie('', 0));
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/audit' && m === 'GET') {
    if (!can(auth, 'audit')) return forbidden(res, 'read the audit log', auth), true;
    return send(res, 200, { audit: accounts.listAudit(url.searchParams.get('limit')) }), true;
  }
  return false;
}

export const HEARTBEAT_MS = 15000;

/**
 * GET /api/stream: Server-Sent Events, one `change` event per committed change (ticket created or
 * updated, comment, dependency, reorder, session activity) with a minimal payload, a `:` heartbeat
 * every 15 s, and headers that keep proxies from buffering. The client reloads what it shows.
 */
function stream(req, res, store, heartbeatMs, streams, auth) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  res.flushHeaders?.();
  // 2 KB of comment first: some proxies hold the first bytes of a response until they have enough.
  res.write(`: ${' '.repeat(2048)}\nretry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ version: store.version, at: Date.now() })}\n\n`);
  const off = store.onChange((c) => res.write(`id: ${c.version}\nevent: change\ndata: ${JSON.stringify(c)}\n\n`));
  const beat = setInterval(() => res.write(`: hb ${Date.now()}\n\n`), heartbeatMs);
  const entry = { auth, res };
  streams?.add(entry);
  const stop = () => {
    clearInterval(beat);
    off();
    streams?.delete(entry);
  };
  req.on('close', stop);
  res.on('error', stop);
}

export function createApp({ token, agents = [], store, page, heartbeatMs = HEARTBEAT_MS, accounts = new Accounts(store), limiter = new Limiter(), trustProxy = false, extraRoutes = inviteRoutes() }) {
  const streams = new Set();
  /** End the live streams of whoever matches (a revoked member, a revoked session). */
  const cutStreams = (match) => {
    for (const s of [...streams]) {
      if (!match(s.auth)) continue;
      streams.delete(s);
      try {
        s.res.end();
      } catch {}
    }
  };

  /** Bearer first (main token, agent token, personal token); else the page's session cookie. */
  function resolveAuth(req) {
    const header = req.headers.authorization;
    if (header) {
      const legacy = authOf(header, { token, agents });
      if (legacy) return { ...withRole(legacy), via: 'token' };
      if (!header.startsWith('Bearer ')) return null;
      const l = accounts.lookup(header.slice(7).trim(), 'api') || accounts.lookup(header.slice(7).trim(), 'session');
      return l ? memberAuth(l, 'bearer') : null;
    }
    const c = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (c) {
      const l = accounts.lookup(c, 'session');
      if (l) return memberAuth(l, 'cookie');
    }
    return null;
  }
  function memberAuth(l, via) {
    const owner = l.member === OWNER_ID;
    return { kind: owner ? 'user' : 'member', role: owner ? 'owner' : l.role, member: l.member, tokenId: l.tokenId, tokenKind: l.tokenKind, via, csrf: l.csrf };
  }

  const ctx = { store, accounts, limiter, cutStreams, send, jsonBody, forbidden, trustProxy, sessionCookie, actorOfAuth };

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/' && req.method === 'GET') {
        // Not framed by another site: Members has buttons worth clickjacking (revoke, invite).
        res.setHeader('content-security-policy', "frame-ancestors 'self'");
        res.setHeader('x-frame-options', 'SAMEORIGIN');
        return send(res, 200, page, 'text/html; charset=utf-8');
      }
      if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      const m = req.method;
      // Routes that run before authentication (accepting an invitation).
      if (extraRoutes?.public && (await extraRoutes.public(req, res, url, ctx))) return;
      const key = clientKey(req, trustProxy);
      const auth = resolveAuth(req);
      if (!auth) {
        const over = limiter.hit(key);
        return send(res, over ? 429 : 401, { error: over ? 'too many failed attempts, wait a few minutes' : 'unauthorized' });
      }
      // The cookie rides along with any request the browser makes: a change needs the CSRF token
      // too, and a cross-site request is refused outright. Bearer requests are not exposed.
      if (auth.via === 'cookie' && m !== 'GET' && m !== 'HEAD') {
        const site = req.headers['sec-fetch-site'];
        if ((site && site !== 'same-origin') || !accounts.csrfOk(auth.csrf, req.headers['x-csrf-token'])) return send(res, 403, { error: 'missing or bad CSRF token' });
      }
      const actorOf = (r, s) => actorOfAuth(r, s, auth, accounts);
      const mustWrite = () => (can(auth, 'write') ? false : (forbidden(res, 'change the board', auth), true));
      if (extraRoutes?.private && (await extraRoutes.private(req, res, url, { ...ctx, auth, actorOf }))) return;
      if ((await accountRoutes(req, res, url, { ...ctx, auth, streams }))) return;

      if (path === '/api/event' && m === 'POST') {
        if (mustWrite()) return;
        let body;
        try {
          body = await jsonBody(req);
        } catch (e) {
          return send(res, e.status, { error: e.message });
        }
        const evt = sanitizeEvent(body);
        if (!evt) return send(res, 400, { error: 'invalid event' });
        const rec = store.ingest(scopeEvent(evt, auth));
        return send(res, 202, { ok: true, state: rec.state, server_version: VERSION });
      }
      if (path === '/api/version' && m === 'GET') return send(res, 200, { version: VERSION });
      if (path === '/api/import' && m === 'POST') {
        // An import replays a history with its own authors: only the main token may write one.
        if (!can(auth, 'import')) return forbidden(res, 'import a board', auth);
        const body = await jsonBody(req, MAX_IMPORT_BODY);
        const out = store.importTickets(body);
        if (out.imported || out.sessions) console.log(`session-board: imported ${out.imported} ticket(s), ${out.sessions} session(s) from ${String(body.machine || 'a local board').slice(0, 80)}`);
        return send(res, 200, out);
      }
      if (path === '/api/board' && m === 'GET') return send(res, 200, store.legacyBoard());
      if (path === '/api/dismiss' && m === 'POST') {
        if (mustWrite()) return;
        const body = await jsonBody(req);
        return send(res, store.dismissSession(String(body?.sessionId ?? ''), undefined, actorOf(req, store)) ? 200 : 404, { ok: true });
      }
      if (path === '/api/tickets' && m === 'GET') return send(res, 200, store.listTickets(parseFilters(url.searchParams)));
      if (path === '/api/stream' && m === 'GET') return stream(req, res, store, heartbeatMs, streams, auth);
      if (path === '/api/tickets/board' && m === 'GET') return send(res, 200, store.ticketBoard(parseFilters(url.searchParams)));
      if (path === '/api/tickets/next' && m === 'GET') {
        const f = parseFilters(url.searchParams);
        if (!url.searchParams.get('limit')) f.limit = 50;
        return send(res, 200, store.nextTickets(f));
      }
      if (path === '/api/tickets' && m === 'POST') return mustWrite() || send(res, 201, store.createTicket(await jsonBody(req), { actor: actorOf(req, store) }));
      if (path === '/api/actors' && m === 'GET') return send(res, 200, { actors: store.listActors() });
      const avm = path.match(/^\/api\/actors\/(.{1,200})\/avatar$/);
      if (avm) {
        let id;
        try {
          id = decodeURIComponent(avm[1]);
        } catch {
          return send(res, 400, { error: 'bad actor id' });
        }
        if (m === 'GET' || m === 'HEAD') return sendAvatar(req, res, store.getAvatar(id));
        if (m !== 'PUT' && m !== 'DELETE') return send(res, 405, { error: 'method not allowed' });
        if (!canEditActor(auth, id)) return forbidden(res, "change another actor's picture", auth);
        if (!store.getActor(id)) return send(res, 404, { error: 'actor not found' });
        if (m === 'DELETE') {
          store.deleteAvatar(id);
          return send(res, 200, { ok: true, avatar: null });
        }
        if (Number(req.headers['content-length']) > AVATAR_MAX_BYTES) {
          res.setHeader('connection', 'close');
          return send(res, 413, { error: `image too large (max ${AVATAR_MAX_BYTES / 1024} KiB)` });
        }
        let img;
        try {
          img = await readRaw(req, AVATAR_MAX_BYTES);
        } catch (e) {
          return send(res, e.status || 400, { error: e.status === 413 ? `image too large (max ${AVATAR_MAX_BYTES / 1024} KiB)` : 'bad body' });
        }
        const info = checkAvatar(img);
        const etag = store.setAvatar(id, { mime: info.mime, data: img }, actorOf(req, store));
        return send(res, 200, { ok: true, avatar: etag, mime: info.mime, width: info.width, height: info.height });
      }
      const am = path.match(/^\/api\/actors\/(.{1,200})$/);
      if (am && (m === 'PATCH' || m === 'POST')) {
        // Renaming is a user action; an agent may only rename itself or one of its sub-actors.
        let id;
        try {
          id = decodeURIComponent(am[1]);
        } catch {
          return send(res, 400, { error: 'bad actor id' });
        }
        if (!canEditActor(auth, id)) return forbidden(res, 'rename this actor', auth);
        const body = await jsonBody(req);
        if (accounts.getMember(id)) {
          // A person's name: the same checks as the Members page (unique, never "You").
          const out = accounts.renameMember(id, body?.name, auth.member || OWNER_ID);
          return send(res, 200, { actor: { ...store.getActor(id), name: out.name } });
        }
        const out = store.renameActor(id, body?.name ?? null, store.clock());
        return send(res, out ? 200 : 404, { actor: out });
      }
      if (path === '/api/facets' && m === 'GET') return send(res, 200, store.facets());
      if (path === '/api/sessions' && m === 'GET') {
        const lim = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        return send(res, 200, store.listSessions({ repo: url.searchParams.get('repo') || undefined, limit: lim }));
      }
      const sm = path.match(/^\/api\/sessions\/([\w.:-]{1,128})$/);
      if (sm && m === 'DELETE') {
        if (!can(auth, 'deleteSession')) return forbidden(res, 'delete a session', auth);
        const out = store.deleteSession(sm[1]);
        return send(res, out.session || out.tickets ? 200 : 404, out);
      }
      const tm = path.match(/^\/api\/tickets\/([\w-]{1,64})(\/comments|\/move)?$/);
      if (tm) {
        const key = tm[1];
        if (m !== 'GET' && mustWrite()) return;
        if (tm[2] === '/move') {
          if (m !== 'POST') return send(res, 405, { error: 'method not allowed' });
          const body = await jsonBody(req);
          return send(res, 200, store.moveTicket(key, { after: body.after || null, before: body.before || null }, { actor: actorOf(req, store) }));
        }
        if (tm[2]) {
          if (m !== 'POST') return send(res, 405, { error: 'method not allowed' });
          const body = await jsonBody(req);
          return send(res, 201, store.comment(key, String(body.text ?? ''), { actor: actorOf(req, store), to: body.to }));
        }
        if (m === 'GET') {
          const t = store.getTicket(key);
          return t ? send(res, 200, t) : send(res, 404, { error: 'ticket not found' });
        }
        if (m === 'POST' || m === 'PATCH') return send(res, 200, store.updateTicket(key, await jsonBody(req), { actor: actorOf(req, store) }));
        return send(res, 405, { error: 'method not allowed' });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) return;
      if (e && e.status && e.status < 500) return send(res, e.status, { error: e.message });
      send(res, 500, { error: 'internal' });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = readToken();
  if (token.length < 24) {
    console.error('session-board: set SESSION_BOARD_TOKEN (or SESSION_BOARD_TOKEN_FILE), at least 24 characters.');
    process.exit(1);
  }
  const dataDir = process.env.SESSION_BOARD_DATA || join(process.cwd(), 'data');
  let agents;
  try {
    agents = readAgentTokens(process.env, dataDir);
  } catch (e) {
    console.error(`session-board: ${e.message}`);
    process.exit(1);
  }
  if (agents.some((a) => a.token === token)) {
    console.error('session-board: an agent token must differ from SESSION_BOARD_TOKEN.');
    process.exit(1);
  }
  if (agents.length) console.log(`session-board: ${agents.length} agent token(s): ${agents.map((a) => a.actor).join(', ')}`);
  const store = await openStore(join(dataDir, 'board.db'));
  const migrated = store.migrateBoardJson(join(dataDir, 'board.json'));
  if (migrated) console.log(`session-board: imported ${migrated} session(s) from board.json (kept as board.json.migrated)`);
  const page = readFileSync(join(HERE, 'page.html'), 'utf8');
  const server = createServer(createApp({ token, agents, store, page, trustProxy: process.env.SESSION_BOARD_TRUST_PROXY === '1' }));
  const port = Number(process.env.PORT || 8793);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`session-board listening on :${port}`));
  const stop = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
