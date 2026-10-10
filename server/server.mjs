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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
export function actorOfAuth(req, store, auth = { kind: 'user' }) {
  const header = req.headers['x-session-board-actor'];
  let id;
  if (auth.kind === 'agent') id = scopeActor(header, auth.actor);
  else {
    id = normalizeActorId(header);
    if (!id || id === 'user') return 'user';
    if (id === 'claude' || id === 'hook') return id;
  }
  if (id === 'claude') return id;
  let name = null;
  try {
    name = agentDisplayName(decodeURIComponent(String(req.headers['x-session-board-actor-name'] || '')));
  } catch {}
  store.touchActor({ id, type: 'agent', name });
  return id;
}

/** An event sent with an agent token: its session belongs to that agent (or a sub-actor). */
function scopeEvent(evt, auth) {
  if (auth.kind !== 'agent') return evt;
  const actor = scopeActor(evt.identity.actor, auth.actor);
  return { ...evt, identity: { ...evt.identity, actor, actorName: agentDisplayName(evt.identity.actorName) ?? undefined } };
}

const forbidden = (res, what) => send(res, 403, { error: `an agent token cannot ${what}` });

export const HEARTBEAT_MS = 15000;

/**
 * GET /api/stream: Server-Sent Events, one `change` event per committed change (ticket created or
 * updated, comment, dependency, reorder, session activity) with a minimal payload, a `:` heartbeat
 * every 15 s, and headers that keep proxies from buffering. The client reloads what it shows.
 */
function stream(req, res, store, heartbeatMs) {
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
  const stop = () => {
    clearInterval(beat);
    off();
  };
  req.on('close', stop);
  res.on('error', stop);
}

export function createApp({ token, agents = [], store, page, heartbeatMs = HEARTBEAT_MS }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/' && req.method === 'GET') return send(res, 200, page, 'text/html; charset=utf-8');
      if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      const auth = authOf(req.headers.authorization, { token, agents });
      if (!auth) return send(res, 401, { error: 'unauthorized' });
      const actorOf = (r, s) => actorOfAuth(r, s, auth);
      const m = req.method;

      if (path === '/api/event' && m === 'POST') {
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
        if (auth.kind === 'agent') return forbidden(res, 'import a board');
        const body = await jsonBody(req, MAX_IMPORT_BODY);
        const out = store.importTickets(body);
        if (out.imported || out.sessions) console.log(`session-board: imported ${out.imported} ticket(s), ${out.sessions} session(s) from ${String(body.machine || 'a local board').slice(0, 80)}`);
        return send(res, 200, out);
      }
      if (path === '/api/board' && m === 'GET') return send(res, 200, store.legacyBoard());
      if (path === '/api/dismiss' && m === 'POST') {
        const body = await jsonBody(req);
        return send(res, store.dismissSession(String(body?.sessionId ?? ''), undefined, actorOf(req, store)) ? 200 : 404, { ok: true });
      }
      if (path === '/api/tickets' && m === 'GET') return send(res, 200, store.listTickets(parseFilters(url.searchParams)));
      if (path === '/api/stream' && m === 'GET') return stream(req, res, store, heartbeatMs);
      if (path === '/api/tickets/board' && m === 'GET') return send(res, 200, store.ticketBoard(parseFilters(url.searchParams)));
      if (path === '/api/tickets/next' && m === 'GET') {
        const f = parseFilters(url.searchParams);
        if (!url.searchParams.get('limit')) f.limit = 50;
        return send(res, 200, store.nextTickets(f));
      }
      if (path === '/api/tickets' && m === 'POST') return send(res, 201, store.createTicket(await jsonBody(req), { actor: actorOf(req, store) }));
      if (path === '/api/actors' && m === 'GET') return send(res, 200, { actors: store.listActors() });
      const am = path.match(/^\/api\/actors\/(.{1,200})$/);
      if (am && (m === 'PATCH' || m === 'POST')) {
        // Renaming is a user action; an agent may only rename itself or one of its sub-actors.
        let id;
        try {
          id = decodeURIComponent(am[1]);
        } catch {
          return send(res, 400, { error: 'bad actor id' });
        }
        if (auth.kind === 'agent' && !(id === auth.actor || id.startsWith(auth.actor + '/'))) return forbidden(res, 'rename this actor');
        const body = await jsonBody(req);
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
        if (auth.kind === 'agent') return forbidden(res, 'delete a session');
        const out = store.deleteSession(sm[1]);
        return send(res, out.session || out.tickets ? 200 : 404, out);
      }
      const tm = path.match(/^\/api\/tickets\/([\w-]{1,64})(\/comments|\/move)?$/);
      if (tm) {
        const key = tm[1];
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
  const server = createServer(createApp({ token, agents, store, page }));
  const port = Number(process.env.PORT || 8793);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`session-board listening on :${port}`));
  const stop = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
