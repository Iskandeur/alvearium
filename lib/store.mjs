// session-board — ticket store on node:sqlite (Node ≥ 22.13). One code path for the server and for
// local mode: the same schema, the same queries, the same hook transitions.
//
// Tables: sessions (context), tickets (the unit of the board), ticket_events (history), tickets_fts
// (full-text search over title + body + comments; LIKE fallback when FTS5 is missing), meta.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ARCHIVE_AFTER_MS,
  CLOSED_STATUSES,
  OPEN_STATUSES,
  STALE_MS,
  applyTransition,
  buildBoard,
  columnOf,
  displayState,
  ftsQuery,
  normalizeLinks,
  sanitizeTicketInput,
  ticketKey,
  truncate,
} from './core.mjs';

/** node:sqlite prints an ExperimentalWarning on load; hooks and the MCP stdio must stay quiet. */
let sqliteModule;
export async function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (String(w?.message ?? w).includes('SQLite')) return;
    return emit.call(process, w, ...rest);
  };
  try {
    sqliteModule = await import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
  return sqliteModule;
}

export async function openStore(file, opts = {}) {
  const { DatabaseSync } = await loadSqlite();
  return new TicketStore(DatabaseSync, file, opts);
}

const SCHEMA_VERSION = 1;
const WAIT_KINDS = ['permission', 'question'];
const PRIORITY_RANK = "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

const newId = () => 't_' + randomBytes(8).toString('hex');
const parseJson = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

/** Legacy session state (7 values) → the session's current activity shown on the new board. */
export function sessionActivity(rec, now = Date.now()) {
  const d = displayState(rec, now);
  if (d === 'waiting') return 'waiting';
  if (d === 'working') return 'working';
  if (d === 'closed') return 'closed';
  return 'idle';
}

export class TicketStore {
  constructor(DatabaseSync, file, { now = () => Date.now() } = {}) {
    if (file && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.file = file || ':memory:';
    this.clock = now;
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA busy_timeout = 3000');
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.stmts = new Map();
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT, name TEXT, repo TEXT, branch TEXT, cwd TEXT, machine TEXT,
        origin TEXT NOT NULL DEFAULT 'terminal', url TEXT,
        state TEXT, detail TEXT,
        first_seen INTEGER, last_seen INTEGER,
        rec TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_repo ON sessions(repo);
      CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen);
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'action',
        assignee TEXT NOT NULL DEFAULT 'user',
        priority TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        parent_id TEXT,
        links TEXT NOT NULL DEFAULT '[]',
        session_id TEXT, repo TEXT, branch TEXT, cwd TEXT, machine TEXT,
        origin TEXT NOT NULL DEFAULT 'terminal',
        source TEXT NOT NULL DEFAULT 'user',
        external_id TEXT,
        title_locked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        status_at INTEGER NOT NULL, closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tickets_repo ON tickets(repo, updated_at);
      CREATE INDEX IF NOT EXISTS tickets_session ON tickets(session_id, updated_at);
      CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, updated_at);
      CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at);
      CREATE INDEX IF NOT EXISTS tickets_parent ON tickets(parent_id);
      CREATE INDEX IF NOT EXISTS tickets_external ON tickets(session_id, external_id);
      CREATE TABLE IF NOT EXISTS ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        from_status TEXT, to_status TEXT,
        text TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ticket ON ticket_events(ticket_id, at);
    `);
    this.fts = true;
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(ticket_id UNINDEXED, title, body, comments)');
    } catch {
      this.fts = false;
    }
    const v = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (!v) this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  }

  // ---- time -------------------------------------------------------------------------------------

  /** Hook time when plausible (keeps the order of async hooks), else the store clock. */
  effectiveTime(at, now = this.clock()) {
    if (Number.isFinite(at) && at > now - 10 * 60 * 1000 && at < now + 60 * 1000) return at;
    return now;
  }

  // ---- sessions ---------------------------------------------------------------------------------

  getSessionRec(id) {
    const row = this.q('SELECT rec FROM sessions WHERE id = ?').get(id);
    return row ? parseJson(row.rec, null) : null;
  }

  saveSession(rec) {
    this.q(
      `INSERT INTO sessions (id, title, name, repo, branch, cwd, machine, origin, url, state, detail, first_seen, last_seen, rec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, name = excluded.name, repo = excluded.repo,
         branch = excluded.branch, cwd = excluded.cwd, machine = excluded.machine, origin = excluded.origin,
         url = excluded.url, state = excluded.state, detail = excluded.detail, last_seen = excluded.last_seen,
         rec = excluded.rec`,
    ).run(
      rec.sessionId,
      rec.title ?? null,
      rec.name ?? null,
      rec.repo ?? null,
      rec.branch ?? null,
      rec.cwd ?? null,
      rec.host ?? null,
      rec.surface === 'cloud' ? 'cloud' : 'terminal',
      rec.url ?? null,
      rec.state ?? null,
      rec.detail ?? null,
      rec.firstSeen ?? rec.lastSeen ?? this.clock(),
      rec.lastSeen ?? this.clock(),
      JSON.stringify(rec),
    );
  }

  sessionContext(sessionId) {
    const s = sessionId ? this.q('SELECT * FROM sessions WHERE id = ?').get(sessionId) : null;
    return s
      ? { session_id: s.id, repo: s.repo, branch: s.branch, cwd: s.cwd, machine: s.machine, origin: s.origin }
      : { session_id: sessionId || null };
  }

  // ---- ticket primitives ------------------------------------------------------------------------

  nextSeq() {
    const r = this.q('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tickets').get();
    return Number(r.n);
  }

  row(idOrKey) {
    if (!idOrKey) return null;
    const s = String(idOrKey);
    const m = s.match(/^[A-Za-z]+-(\d+)$/);
    if (m) return this.q('SELECT * FROM tickets WHERE seq = ?').get(Number(m[1])) ?? null;
    if (/^\d+$/.test(s)) return this.q('SELECT * FROM tickets WHERE seq = ?').get(Number(s)) ?? null;
    return this.q('SELECT * FROM tickets WHERE id = ?').get(s) ?? null;
  }

  addEvent(ticketId, at, actor, type, { from = null, to = null, text = null } = {}) {
    this.q('INSERT INTO ticket_events (ticket_id, at, actor, type, from_status, to_status, text) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      ticketId,
      at,
      actor,
      type,
      from,
      to,
      text,
    );
  }

  reindex(id) {
    const t = this.q('SELECT title, body, labels FROM tickets WHERE id = ?').get(id);
    if (!this.fts || !t) return;
    // Labels are searchable as words, next to the comments.
    const comments = [parseJson(t.labels, []).join(' '), this.q("SELECT group_concat(text, ' ') AS c FROM ticket_events WHERE ticket_id = ? AND type = 'comment'").get(id)?.c || ''].join(' ');
    this.q('DELETE FROM tickets_fts WHERE ticket_id = ?').run(id);
    this.q('INSERT INTO tickets_fts (ticket_id, title, body, comments) VALUES (?, ?, ?, ?)').run(id, t.title, t.body, comments);
  }

  /** Low-level insert. `t` is already validated. Returns the row. */
  insertTicket(t, actor, at) {
    const id = newId();
    const seq = this.nextSeq();
    const status = t.status || 'todo';
    const closed = CLOSED_STATUSES.includes(status) ? at : null;
    this.q(
      `INSERT INTO tickets (id, seq, title, body, status, kind, assignee, priority, labels, parent_id, links,
         session_id, repo, branch, cwd, machine, origin, source, external_id, title_locked,
         created_at, updated_at, status_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      seq,
      t.title,
      t.body ?? '',
      status,
      t.kind || 'action',
      t.assignee || 'user',
      t.priority ?? null,
      JSON.stringify(t.labels || []),
      t.parent_id ?? null,
      JSON.stringify(t.links || []),
      t.session_id ?? null,
      t.repo ?? null,
      t.branch ?? null,
      t.cwd ?? null,
      t.machine ?? null,
      t.origin === 'cloud' ? 'cloud' : 'terminal',
      t.source || 'user',
      t.external_id ?? null,
      t.title_locked ? 1 : 0,
      at,
      at,
      at,
      closed,
    );
    this.addEvent(id, at, actor, 'created', { to: status, text: null });
    this.reindex(id);
    return this.q('SELECT * FROM tickets WHERE id = ?').get(id);
  }

  /** Low-level update: only the fields given. Records a status event when the status moves. */
  patchTicket(row, fields, actor, at, note) {
    const sets = [];
    const vals = [];
    const put = (col, v) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    let changed = false;
    const changedKeys = [];
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'status' || v === undefined) continue;
      const cur = row[k];
      const next = k === 'labels' || k === 'links' ? JSON.stringify(v) : v;
      if (cur === next || (cur == null && next == null)) continue;
      put(k, next);
      changedKeys.push(k);
      changed = true;
    }
    const moved = fields.status && fields.status !== row.status;
    if (moved) {
      put('status', fields.status);
      put('status_at', at);
      put('closed_at', CLOSED_STATUSES.includes(fields.status) ? at : null);
      changed = true;
    }
    if (!changed && !note) return row;
    put('updated_at', at);
    vals.push(row.id);
    this.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (moved) {
      const reopened = CLOSED_STATUSES.includes(row.status) && !CLOSED_STATUSES.includes(fields.status);
      this.addEvent(row.id, at, actor, reopened ? 'reopened' : 'status', { from: row.status, to: fields.status, text: note || null });
    } else if (note) {
      this.addEvent(row.id, at, actor, 'note', { text: note });
    }
    const edited = changedKeys.filter((k) => ['title', 'body', 'labels', 'priority', 'assignee', 'kind', 'parent_id', 'links'].includes(k));
    if (edited.length && actor !== 'hook') this.addEvent(row.id, at, actor, 'edit', { text: edited.map((k) => (k === 'parent_id' ? 'parent' : k)).join(', ') });
    if (changedKeys.some((k) => k === 'title' || k === 'body' || k === 'labels')) this.reindex(row.id);
    return this.q('SELECT * FROM tickets WHERE id = ?').get(row.id);
  }

  // ---- public API: tickets ---------------------------------------------------------------------

  /** Create from API / MCP / CLI input. actor: 'user' | 'claude'. */
  createTicket(input, { actor = 'user', now = this.clock() } = {}) {
    const { value, error } = sanitizeTicketInput(input);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    return this.tx(() => {
      let parent = null;
      if (value.parent) {
        parent = this.row(value.parent);
        if (!parent) throw Object.assign(new Error('parent not found'), { status: 400 });
      }
      const ctx = { ...this.sessionContext(value.session_id ?? parent?.session_id) };
      if (parent && !value.session_id) Object.assign(ctx, { repo: parent.repo, branch: parent.branch, cwd: parent.cwd, machine: parent.machine, origin: parent.origin });
      const t = {
        ...value,
        ...Object.fromEntries(Object.entries(ctx).filter(([k, v]) => v != null && value[k] == null)),
        status: value.status || 'todo',
        kind: value.kind || (actor === 'claude' ? 'task' : 'action'),
        assignee: value.assignee || (actor === 'claude' ? 'user' : 'user'),
        parent_id: parent?.id ?? null,
        source: actor === 'claude' ? 'claude' : 'user',
        title_locked: true,
      };
      const row = this.insertTicket(t, actor, now);
      return this.present(row, now);
    });
  }

  updateTicket(idOrKey, input, { actor = 'user', now = this.clock(), note } = {}) {
    const { value, error } = sanitizeTicketInput(input, { partial: true });
    if (error) throw Object.assign(new Error(error), { status: 400 });
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      const fields = { ...value };
      if ('parent' in fields) {
        const p = fields.parent ? this.row(fields.parent) : null;
        if (fields.parent && !p) throw Object.assign(new Error('parent not found'), { status: 400 });
        if (p && p.id === row.id) throw Object.assign(new Error('a ticket cannot be its own parent'), { status: 400 });
        fields.parent_id = p ? p.id : null;
        delete fields.parent;
      }
      if (fields.title) fields.title_locked = 1;
      const out = this.patchTicket(row, fields, actor, now, note);
      if (typeof input?.comment === 'string' && input.comment.trim()) this.commentRow(out, input.comment, actor, now);
      return this.present(this.row(row.id), now);
    });
  }

  commentRow(row, text, actor, now) {
    const t = String(text).trim().slice(0, 4000);
    if (!t) throw Object.assign(new Error('empty comment'), { status: 400 });
    this.addEvent(row.id, now, actor, 'comment', { text: t });
    this.q('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, row.id);
    this.reindex(row.id);
  }

  comment(idOrKey, text, { actor = 'user', now = this.clock() } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      this.commentRow(row, text, actor, now);
      return this.present(this.row(row.id), now);
    });
  }

  /** One ticket with its history, children and session. */
  getTicket(idOrKey, now = this.clock()) {
    const row = this.row(idOrKey);
    if (!row) return null;
    const t = this.present(row, now);
    t.events = this.q('SELECT at, actor, type, from_status, to_status, text FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(row.id).map((e) => ({ ...e }));
    t.children = this.q('SELECT * FROM tickets WHERE parent_id = ? ORDER BY seq').all(row.id).map((c) => this.present(c, now));
    return t;
  }

  /** Row → API object (key, parsed JSON, session summary, stale flag). */
  present(row, now = this.clock()) {
    const s = row.session_id ? this.q('SELECT id, title, name, state, last_seen, url, rec FROM sessions WHERE id = ?').get(row.session_id) : null;
    const parent = row.parent_id ? this.q('SELECT seq, title FROM tickets WHERE id = ?').get(row.parent_id) : null;
    const counts = this.q(
      "SELECT (SELECT COUNT(*) FROM tickets c WHERE c.parent_id = ?) AS children, (SELECT COUNT(*) FROM ticket_events e WHERE e.ticket_id = ? AND e.type = 'comment') AS comments",
    ).get(row.id, row.id);
    const sessionRec = s ? parseJson(s.rec, null) : null;
    const stale = row.status === 'in_progress' && row.source === 'hook' && s && now - s.last_seen > STALE_MS;
    return {
      id: row.id,
      key: ticketKey(row.seq),
      seq: row.seq,
      title: row.title,
      body: row.body,
      status: row.status,
      kind: row.kind,
      assignee: row.assignee,
      priority: row.priority,
      labels: parseJson(row.labels, []),
      links: parseJson(row.links, []),
      parent_id: row.parent_id,
      parent_key: parent ? ticketKey(parent.seq) : null,
      parent_title: parent?.title ?? null,
      session_id: row.session_id,
      session: s
        ? {
            id: s.id,
            title: s.name || s.title || null,
            activity: sessionRec ? sessionActivity(sessionRec, now) : s.state,
            last_seen: s.last_seen,
            url: s.url,
          }
        : null,
      repo: row.repo,
      branch: row.branch,
      cwd: row.cwd,
      machine: row.machine,
      origin: row.origin,
      source: row.source,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status_at: row.status_at,
      closed_at: row.closed_at,
      children_count: Number(counts.children),
      comments_count: Number(counts.comments),
      stale: Boolean(stale),
      column: columnOf(row),
    };
  }

  // ---- queries ----------------------------------------------------------------------------------

  /** WHERE clause for parsed filters (see core.parseFilters). */
  where(f, now = this.clock()) {
    const w = [];
    const p = [];
    const inList = (col, vals) => {
      w.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
      p.push(...vals);
    };
    if (f.session) inList('t.session_id', f.session);
    if (f.repo) {
      // "acme/api" matches exactly; a bare "api" matches the repo name under any owner.
      const parts = [];
      for (const r of f.repo) {
        if (r === '(none)') parts.push('t.repo IS NULL');
        else if (r.includes('/')) {
          parts.push('t.repo = ?');
          p.push(r);
        } else {
          parts.push("(t.repo = ? OR t.repo LIKE '%/' || ?)");
          p.push(r, r);
        }
      }
      w.push(`(${parts.join(' OR ')})`);
    }
    if (f.branch) inList('t.branch', f.branch);
    if (f.machine) inList('t.machine', f.machine);
    if (f.origin) inList('t.origin', f.origin);
    if (f.status) {
      if (!f.status.length) w.push('0');
      else inList('t.status', f.status);
    }
    if (f.assignee) inList('t.assignee', f.assignee);
    if (f.kind) inList('t.kind', f.kind);
    if (f.source) inList('t.source', f.source);
    if (f.priority) inList('t.priority', f.priority);
    if (f.parent) {
      const ids = f.parent.map((k) => this.row(k)?.id).filter(Boolean);
      if (!ids.length) w.push('0');
      else inList('t.parent_id', ids);
    }
    if (f.label) {
      for (const l of f.label) {
        w.push('EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?)');
        p.push(l);
      }
    }
    if (f.created_after) w.push('t.created_at >= ?'), p.push(f.created_after);
    if (f.created_before) w.push('t.created_at < ?'), p.push(f.created_before);
    if (f.updated_after) w.push('t.updated_at >= ?'), p.push(f.updated_after);
    if (f.updated_before) w.push('t.updated_at < ?'), p.push(f.updated_before);
    if (f.q) {
      const fq = this.fts ? ftsQuery(f.q) : '';
      if (fq) {
        w.push('t.id IN (SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH ?)');
        p.push(fq);
      } else {
        const like = `%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
        w.push(
          "(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.labels LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.type = 'comment' AND e.text LIKE ? ESCAPE '\\'))",
        );
        p.push(like, like, like, like);
      }
      // A ticket key in the query finds that ticket too.
      const key = f.q.match(/^\s*[A-Za-z]+-(\d+)\s*$/);
      if (key) {
        const last = w.pop();
        w.push(`(${last} OR t.seq = ?)`);
        p.push(Number(key[1]));
      }
    }
    const cutoff = now - ARCHIVE_AFTER_MS;
    const archived = `(t.status IN ('done', 'cancelled') AND t.closed_at IS NOT NULL AND t.closed_at < ${cutoff})`;
    if (f.archived === 'only') w.push(archived);
    else if (f.archived !== 'include') w.push(`NOT ${archived}`);
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
  }

  orderBy(sort) {
    if (sort === 'created') return 'ORDER BY t.created_at DESC, t.seq DESC';
    if (sort === 'priority') return `ORDER BY ${PRIORITY_RANK}, t.updated_at DESC`;
    if (sort === 'key') return 'ORDER BY t.seq DESC';
    return 'ORDER BY t.updated_at DESC, t.seq DESC';
  }

  listTickets(f, now = this.clock()) {
    const { sql, params } = this.where(f, now);
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${sql}`).get(...params).n);
    const rows = this.db.prepare(`SELECT t.* FROM tickets t ${sql} ${this.orderBy(f.sort)} LIMIT ? OFFSET ?`).all(...params, f.limit ?? 100, f.offset ?? 0);
    return { now, total, limit: f.limit ?? 100, offset: f.offset ?? 0, tickets: rows.map((r) => this.present(r, now)) };
  }

  /** Columns for the board view. Each column is capped; counts are exact. */
  ticketBoard(f, { perColumn = 200, doneShown = 30, now = this.clock() } = {}) {
    const { sql, params } = this.where({ ...f, status: undefined }, now);
    const and = sql ? `${sql} AND` : 'WHERE';
    const col = {
      waiting: `t.status IN ('waiting_on_user', 'review', 'failed') AND t.assignee = 'user'`,
      inProgress: `(t.status = 'in_progress' OR (t.status IN ('waiting_on_user', 'review', 'failed') AND t.assignee <> 'user'))`,
      todo: `t.status = 'todo'`,
      done: `t.status IN ('done', 'cancelled')`,
    };
    const order = {
      waiting: 'ORDER BY t.status_at ASC, t.seq ASC',
      inProgress: 'ORDER BY t.updated_at DESC',
      todo: `ORDER BY ${PRIORITY_RANK}, t.created_at DESC`,
      done: 'ORDER BY t.closed_at DESC',
    };
    const columns = {};
    const counts = {};
    const allowed = f.status ? new Set(f.status) : null;
    for (const [name, cond] of Object.entries(col)) {
      let extra = '';
      const p = [...params];
      if (allowed) {
        const st = [...allowed];
        extra = ` AND t.status IN (${st.map(() => '?').join(', ')})`;
        p.push(...st);
      }
      counts[name] = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${and} ${cond}${extra}`).get(...p).n);
      const cap = name === 'done' ? doneShown : perColumn;
      columns[name] = this.db
        .prepare(`SELECT t.* FROM tickets t ${and} ${cond}${extra} ${order[name]} LIMIT ?`)
        .all(...p, cap)
        .map((r) => this.present(r, now));
    }
    return { now, counts, columns };
  }

  /** Values to filter on, with open-ticket counts (for the filter chips and the MCP). */
  facets(now = this.clock()) {
    const open = `status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(', ')})`;
    const group = (col) =>
      this.db
        .prepare(`SELECT ${col} AS value, COUNT(*) AS total, SUM(CASE WHEN ${open} THEN 1 ELSE 0 END) AS open FROM tickets WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY open DESC, total DESC LIMIT 200`)
        .all()
        .map((r) => ({ value: r.value, total: Number(r.total), open: Number(r.open) }));
    const labels = this.db
      .prepare(`SELECT j.value AS value, COUNT(*) AS total FROM tickets, json_each(tickets.labels) j GROUP BY j.value ORDER BY total DESC LIMIT 200`)
      .all()
      .map((r) => ({ value: r.value, total: Number(r.total) }));
    const sessions = this.listSessions({ limit: 200 }, now).sessions;
    return { now, repos: group('repo'), branches: group('branch'), machines: group('machine'), kinds: group('kind'), labels, sessions };
  }

  listSessions({ repo, limit = 100, offset = 0 } = {}, now = this.clock()) {
    const p = [];
    let w = '';
    if (repo) {
      w = 'WHERE s.repo = ?';
      p.push(repo);
    }
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM tickets t WHERE t.session_id = s.id) AS tickets,
           (SELECT COUNT(*) FROM tickets t WHERE t.session_id = s.id AND t.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(', ')})) AS open
         FROM sessions s ${w} ORDER BY s.last_seen DESC LIMIT ? OFFSET ?`,
      )
      .all(...p, limit, offset);
    return {
      now,
      sessions: rows.map((s) => {
        const rec = parseJson(s.rec, {});
        return {
          id: s.id,
          title: s.name || s.title || null,
          repo: s.repo,
          branch: s.branch,
          machine: s.machine,
          origin: s.origin,
          url: s.url,
          activity: sessionActivity(rec, now),
          detail: s.detail,
          first_seen: s.first_seen,
          last_seen: s.last_seen,
          tickets: Number(s.tickets),
          open: Number(s.open),
        };
      }),
    };
  }

  /** The old `/api/board` shape (sessions in columns), plus ticket counts for new clients. */
  legacyBoard(now = this.clock()) {
    const recs = this.db
      .prepare('SELECT rec FROM sessions WHERE last_seen > ?')
      .all(now - 7 * 24 * 60 * 60 * 1000)
      .map((r) => parseJson(r.rec, null))
      .filter(Boolean);
    const board = buildBoard(recs, now);
    const tb = this.ticketBoard({}, { perColumn: 0, doneShown: 0, now });
    board.tickets = { counts: tb.counts };
    return board;
  }

  // ---- hooks ------------------------------------------------------------------------------------

  findExternal(sessionId, externalId) {
    return this.q('SELECT * FROM tickets WHERE session_id = ? AND external_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId, externalId) ?? null;
  }

  openWaitTickets(sessionId) {
    return this.q(
      `SELECT * FROM tickets WHERE session_id = ? AND source = 'hook' AND status = 'waiting_on_user' AND kind IN (${WAIT_KINDS.map(() => '?').join(', ')})`,
    ).all(sessionId, ...WAIT_KINDS);
  }

  sessionTitle(rec) {
    const where = rec.repo ? rec.repo.split('/').pop() : rec.cwd ? rec.cwd.split(/[\\/]/).filter(Boolean).pop() : '';
    return truncate(rec.name || rec.title || (where ? `Session in ${where}` : 'Claude Code session'), 200);
  }

  ctxOf(rec) {
    return {
      session_id: rec.sessionId,
      repo: rec.repo ?? null,
      branch: rec.branch ?? null,
      cwd: rec.cwd ?? null,
      machine: rec.host ?? null,
      origin: rec.surface === 'cloud' ? 'cloud' : 'terminal',
    };
  }

  /** The one ticket that follows a session's main thread (in progress → review → done). */
  ensureSessionTicket(rec, at, status) {
    let t = this.findExternal(rec.sessionId, 'session');
    if (!t) {
      const links = rec.url ? normalizeLinks([{ url: rec.url, type: 'session' }]) : [];
      return this.insertTicket(
        { title: this.sessionTitle(rec), status, kind: 'session', assignee: 'claude', source: 'hook', external_id: 'session', links, ...this.ctxOf(rec) },
        'hook',
        at,
      );
    }
    // Keep the context and an auto title fresh (a user-edited title is never overwritten).
    const fields = { ...this.ctxOf(rec) };
    delete fields.session_id;
    if (!t.title_locked) fields.title = this.sessionTitle(rec);
    return this.patchTicket(t, fields, 'hook', at);
  }

  closeWaits(rec, at, status, note) {
    for (const w of this.openWaitTickets(rec.sessionId)) {
      // Async hooks can arrive out of order: only an event that happened after the question closes it.
      if (at <= w.created_at) continue;
      this.patchTicket(w, { status }, 'hook', at, note);
    }
  }

  /**
   * Apply one hook event (the payload of POST /api/event, sanitized) to sessions and tickets.
   * Returns the session record (legacy shape).
   */
  ingest(evt, serverNow = this.clock()) {
    const at = this.effectiveTime(evt.at, serverNow);
    const t = evt.transition;
    return this.tx(() => {
      const prev = this.getSessionRec(evt.identity.sessionId);
      // A task event says nothing about the session's state: only refresh its context and last_seen.
      const rec = t.task && prev ? { ...prev, ...stripEmpty(evt.identity), lastSeen: at } : applyTransition(prev, t, evt.identity, at);
      this.saveSession(rec);

      if (t.task) {
        this.mirrorTask(rec, t.task, at);
        return rec;
      }
      switch (t.state) {
        case 'working': {
          this.closeWaits(rec, at, 'done', 'Answered, the session resumed');
          const s = this.ensureSessionTicket(rec, at, 'in_progress');
          if (s.status !== 'in_progress') {
            this.patchTicket(s, { status: 'in_progress', assignee: 'claude' }, 'hook', at, t.prompt ? truncate(t.prompt, 200) : null);
          }
          break;
        }
        case 'waiting': {
          if (t.kind === 'idle') {
            // "Your turn" after a finished turn: the session ticket already says review. If the Stop was
            // missed, move an in-progress session ticket to review.
            const s = this.findExternal(rec.sessionId, 'session');
            if (s && s.status === 'in_progress') this.patchTicket(s, { status: 'review', assignee: 'user' }, 'hook', at, t.detail || null);
            break;
          }
          const kind = WAIT_KINDS.includes(t.kind) ? t.kind : 'question';
          const s = this.ensureSessionTicket(rec, at, 'in_progress');
          const title = waitTitle(kind, t.detail);
          const open = this.openWaitTickets(rec.sessionId).find((w) => w.kind === kind);
          const generic = /^Claude (Code )?needs your/i.test(t.detail || '');
          if (open) {
            if (!generic && open.title !== title) this.patchTicket(open, { title, body: t.detail || '' }, 'hook', at);
          } else {
            this.insertTicket(
              {
                title,
                body: t.detail || '',
                status: 'waiting_on_user',
                kind,
                assignee: 'user',
                source: 'hook',
                external_id: 'wait:' + kind,
                parent_id: s.id,
                links: rec.url ? normalizeLinks([{ url: rec.url, type: 'session' }]) : [],
                ...this.ctxOf(rec),
              },
              'hook',
              at,
            );
          }
          break;
        }
        case 'review': {
          this.closeWaits(rec, at, 'done', 'Answered, the turn ended');
          const s = this.ensureSessionTicket(rec, at, 'review');
          const links = normalizeLinks([...parseJson(s.links, []), ...(t.pr ? [{ url: t.pr, type: 'pr' }] : [])]);
          this.patchTicket(s, { status: 'review', assignee: 'user', body: t.detail || s.body, links }, 'hook', at);
          break;
        }
        case 'failed': {
          const s = this.ensureSessionTicket(rec, at, 'failed');
          this.patchTicket(s, { status: 'failed', assignee: 'user', body: t.detail || s.body }, 'hook', at, t.detail || 'The turn failed');
          break;
        }
        case 'closed': {
          this.closeWaits(rec, at + 1, 'cancelled', 'The session ended');
          const s = this.findExternal(rec.sessionId, 'session');
          if (s && !CLOSED_STATUSES.includes(s.status)) {
            this.patchTicket(s, { status: s.status === 'failed' ? 'cancelled' : 'done' }, 'hook', at, t.detail || 'Session ended');
          }
          break;
        }
        default:
          break;
      }
      return rec;
    });
  }

  /** Claude's native task list (TaskCreated / TaskCompleted hooks) mirrored as tickets. */
  mirrorTask(rec, task, at) {
    const slug = (task.title || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
    const byId = task.id ? this.findExternal(rec.sessionId, 'task:' + task.id) : null;
    const byTitle = slug ? this.findExternal(rec.sessionId, 'task-title:' + slug) : null;
    const existing = byId || byTitle;
    const parent = this.findExternal(rec.sessionId, 'session');
    if (task.op === 'create') {
      if (existing) {
        if (CLOSED_STATUSES.includes(existing.status)) this.patchTicket(existing, { status: 'todo' }, 'hook', at, 'Task created again');
        return;
      }
      this.insertTicket(
        {
          title: task.title || `Task ${task.id}`,
          body: task.description || '',
          status: 'todo',
          kind: 'task',
          assignee: 'claude',
          source: 'claude',
          external_id: task.id ? 'task:' + task.id : 'task-title:' + slug,
          parent_id: parent?.id ?? null,
          ...this.ctxOf(rec),
        },
        'claude',
        at,
      );
      return;
    }
    if (existing) {
      if (existing.status !== 'done') this.patchTicket(existing, { status: 'done' }, 'claude', at, 'Task completed');
      return;
    }
    this.insertTicket(
      {
        title: task.title || `Task ${task.id}`,
        status: 'done',
        kind: 'task',
        assignee: 'claude',
        source: 'claude',
        external_id: task.id ? 'task:' + task.id : 'task-title:' + slug,
        parent_id: parent?.id ?? null,
        ...this.ctxOf(rec),
      },
      'claude',
      at,
    );
  }

  /** Legacy `POST /api/dismiss {sessionId}`: the session's review ticket is done. */
  dismissSession(sessionId, now = this.clock()) {
    return this.tx(() => {
      const rec = this.getSessionRec(sessionId);
      if (!rec) return false;
      rec.dismissed = true;
      this.saveSession(rec);
      const s = this.findExternal(sessionId, 'session');
      if (s && ['review', 'failed'].includes(s.status)) this.patchTicket(s, { status: 'done' }, 'user', now, 'Dismissed');
      return true;
    });
  }

  // ---- migration --------------------------------------------------------------------------------

  /**
   * Import the sessions of a v0.1 board.json (server) or of ~/.claude/session-board/sessions/*.json
   * (local): one session row each, plus one ticket for its current state. Idempotent.
   */
  importLegacy(records, now = this.clock()) {
    let imported = 0;
    this.tx(() => {
      for (const rec of records) {
        if (!rec || typeof rec.sessionId !== 'string') continue;
        if (this.getSessionRec(rec.sessionId)) continue;
        this.saveSession(rec);
        imported++;
        const at = rec.since ?? rec.lastSeen ?? now;
        const map = { working: 'in_progress', waiting: 'waiting_on_user', review: rec.dismissed ? 'done' : 'review', failed: 'failed', closed: 'done' };
        const status = map[rec.state];
        if (!status) continue;
        if (status === 'waiting_on_user') {
          const s = this.ensureSessionTicket(rec, at, 'in_progress');
          const kind = WAIT_KINDS.includes(rec.kind) ? rec.kind : 'question';
          this.insertTicket(
            { title: waitTitle(kind, rec.detail), body: rec.detail || '', status, kind, assignee: 'user', source: 'hook', external_id: 'wait:' + kind, parent_id: s.id, ...this.ctxOf(rec) },
            'hook',
            at,
          );
        } else {
          const s = this.ensureSessionTicket(rec, at, status);
          const links = normalizeLinks([...(rec.url ? [{ url: rec.url, type: 'session' }] : []), ...(rec.pr ? [{ url: rec.pr, type: 'pr' }] : [])]);
          this.patchTicket(s, { body: rec.detail || '', links, assignee: ['review', 'failed'].includes(status) ? 'user' : 'claude' }, 'hook', at);
        }
      }
    });
    return imported;
  }

  /** Server start: board.json (v0.1) → SQLite, then board.json is renamed, never deleted. */
  migrateBoardJson(jsonPath) {
    let data;
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch {
      return 0;
    }
    const n = this.importLegacy(Array.isArray(data.sessions) ? data.sessions : []);
    try {
      renameSync(jsonPath, `${jsonPath}.migrated`);
    } catch {}
    return n;
  }

  counts() {
    return {
      sessions: Number(this.q('SELECT COUNT(*) AS n FROM sessions').get().n),
      tickets: Number(this.q('SELECT COUNT(*) AS n FROM tickets').get().n),
      events: Number(this.q('SELECT COUNT(*) AS n FROM ticket_events').get().n),
    };
  }
}

function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

export function waitTitle(kind, detail) {
  const d = String(detail || '').trim();
  if (kind === 'permission') {
    const body = d.replace(/^Permission:\s*/i, '');
    return truncate(body ? `Approve ${body}` : 'Approve a tool call', 200);
  }
  return truncate(d || 'Claude has a question', 200);
}
