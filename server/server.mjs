#!/usr/bin/env node
// session-board server: receives hook events, serves the board (JSON + one web page).
// Zero dependencies. Storage: one JSON file, written atomically.
//
// Env:
//   SESSION_BOARD_TOKEN       bearer token (or SESSION_BOARD_TOKEN_FILE: path to a file holding it)
//   SESSION_BOARD_DATA        directory for board.json            (default ./data)
//   PORT                      listen port                          (default 8793)
//   HOST                      listen address                       (default 0.0.0.0)
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTransition, buildBoard, isExpired, sanitizeEvent } from '../lib/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_SESSIONS = 1000;

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

export class BoardStore {
  constructor(file) {
    this.file = file;
    this.sessions = new Map();
    this.timer = null;
    if (file) {
      try {
        for (const r of JSON.parse(readFileSync(file, 'utf8')).sessions || []) this.sessions.set(r.sessionId, r);
      } catch {}
    }
  }
  apply(evt, now = Date.now()) {
    const id = evt.identity.sessionId;
    if (!this.sessions.has(id) && this.sessions.size >= MAX_SESSIONS) this.prune(now, true);
    const rec = applyTransition(this.sessions.get(id), evt.transition, evt.identity, now);
    this.sessions.set(id, rec);
    this.scheduleSave();
    return rec;
  }
  dismiss(id) {
    const rec = this.sessions.get(id);
    if (!rec) return false;
    rec.dismissed = true;
    this.scheduleSave();
    return true;
  }
  prune(now = Date.now(), force = false) {
    for (const [id, r] of this.sessions) if (isExpired(r, now)) this.sessions.delete(id);
    if (force && this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.sessions.delete(oldest.sessionId);
    }
  }
  board(now = Date.now()) {
    this.prune(now);
    return buildBoard([...this.sessions.values()], now);
  }
  scheduleSave() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 500);
  }
  saveNow() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, sessions: [...this.sessions.values()] }));
    renameSync(tmp, this.file);
  }
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp({ token, store, page }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });
      if (path === '/' && req.method === 'GET') {
        return send(res, 200, page, 'text/html; charset=utf-8');
      }
      if (!path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!bearerOk(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorized' });

      if (path === '/api/event' && req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          return send(res, e.status || 400, { error: 'bad body' });
        }
        const evt = sanitizeEvent(body);
        if (!evt) return send(res, 400, { error: 'invalid event' });
        const rec = store.apply(evt);
        return send(res, 202, { ok: true, state: rec.state });
      }
      if (path === '/api/board' && req.method === 'GET') return send(res, 200, store.board());
      if (path === '/api/dismiss' && req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: 'bad body' });
        }
        return send(res, store.dismiss(String(body?.sessionId ?? '')) ? 200 : 404, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'internal' });
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
  const store = new BoardStore(join(dataDir, 'board.json'));
  const page = readFileSync(join(HERE, 'page.html'), 'utf8');
  const server = createServer(createApp({ token, store, page }));
  const port = Number(process.env.PORT || 8793);
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`session-board listening on :${port}`));
  const stop = () => {
    store.saveNow();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
