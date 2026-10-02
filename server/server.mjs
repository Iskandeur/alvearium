#!/usr/bin/env node
// session-board server: receives hook events, stores tickets, serves the API and one web page.
// Zero dependencies. Storage: node:sqlite (Node ≥ 22.13), one file `board.db` in the data directory.
//
// Env:
//   SESSION_BOARD_TOKEN       bearer token (or SESSION_BOARD_TOKEN_FILE: path to a file holding it)
//   SESSION_BOARD_DATA        directory for board.db                (default ./data)
//   PORT                      listen port                           (default 8793)
//   HOST                      listen address                        (default 0.0.0.0)
//
// Routes (all /api/* need `Authorization: Bearer <token>`):
//   POST /api/event                 hook event (v0.1 payload, still the only thing hooks send)
//   GET  /api/board                 v0.1 board (sessions in columns) + `tickets.counts`
//   POST /api/dismiss               v0.1: { sessionId } → the session's review ticket is done
//   GET  /api/tickets               list: ?session&repo&branch&machine&origin&status&assignee&kind
//                                   &label&source&priority&parent&q&created_after…&archived&sort&limit&offset
//   GET  /api/tickets/board         same filters, grouped in board columns
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
import { parseFilters, sanitizeEvent } from '../lib/core.mjs';
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

/** Who made a change: the MCP server says `claude`; the page, the CLI and anything else is the user. */
const actorOf = (req) => (req.headers['x-session-board-actor'] === 'claude' ? 'claude' : 'user');

export function createApp({ token, store, page }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/' && req.method === 'GET') return send(res, 200, page, 'text/html; charset=utf-8');
      if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!bearerOk(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorized' });
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
        const rec = store.ingest(evt);
        return send(res, 202, { ok: true, state: rec.state });
      }
      if (path === '/api/import' && m === 'POST') {
        const body = await jsonBody(req, MAX_IMPORT_BODY);
        const out = store.importTickets(body);
        if (out.imported || out.sessions) console.log(`session-board: imported ${out.imported} ticket(s), ${out.sessions} session(s) from ${String(body.machine || 'a local board').slice(0, 80)}`);
        return send(res, 200, out);
      }
      if (path === '/api/board' && m === 'GET') return send(res, 200, store.legacyBoard());
      if (path === '/api/dismiss' && m === 'POST') {
        const body = await jsonBody(req);
        return send(res, store.dismissSession(String(body?.sessionId ?? '')) ? 200 : 404, { ok: true });
      }
      if (path === '/api/tickets' && m === 'GET') return send(res, 200, store.listTickets(parseFilters(url.searchParams)));
      if (path === '/api/tickets/board' && m === 'GET') return send(res, 200, store.ticketBoard(parseFilters(url.searchParams)));
      if (path === '/api/tickets' && m === 'POST') return send(res, 201, store.createTicket(await jsonBody(req), { actor: actorOf(req) }));
      if (path === '/api/facets' && m === 'GET') return send(res, 200, store.facets());
      if (path === '/api/sessions' && m === 'GET') {
        const lim = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        return send(res, 200, store.listSessions({ repo: url.searchParams.get('repo') || undefined, limit: lim }));
      }
      const sm = path.match(/^\/api\/sessions\/([\w.:-]{1,128})$/);
      if (sm && m === 'DELETE') {
        const out = store.deleteSession(sm[1]);
        return send(res, out.session || out.tickets ? 200 : 404, out);
      }
      const tm = path.match(/^\/api\/tickets\/([\w-]{1,64})(\/comments)?$/);
      if (tm) {
        const key = tm[1];
        if (tm[2]) {
          if (m !== 'POST') return send(res, 405, { error: 'method not allowed' });
          const body = await jsonBody(req);
          return send(res, 201, store.comment(key, String(body.text ?? ''), { actor: actorOf(req) }));
        }
        if (m === 'GET') {
          const t = store.getTicket(key);
          return t ? send(res, 200, t) : send(res, 404, { error: 'ticket not found' });
        }
        if (m === 'POST' || m === 'PATCH') return send(res, 200, store.updateTicket(key, await jsonBody(req), { actor: actorOf(req) }));
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
  const store = await openStore(join(dataDir, 'board.db'));
  const migrated = store.migrateBoardJson(join(dataDir, 'board.json'));
  if (migrated) console.log(`session-board: imported ${migrated} session(s) from board.json (kept as board.json.migrated)`);
  const page = readFileSync(join(HERE, 'page.html'), 'utf8');
  const server = createServer(createApp({ token, store, page }));
  const port = Number(process.env.PORT || 8793);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`session-board listening on :${port}`));
  const stop = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
