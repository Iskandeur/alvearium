// session-board — ticket store on node:sqlite (Node ≥ 22.13). One code path for the server and for
// local mode: the same schema, the same queries, the same hook transitions.
//
// Tables: sessions (context), tickets (the unit of the board), ticket_events (history), tickets_fts
// (full-text search over title + body + comments; LIKE fallback when FTS5 is missing), meta.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ACTOR_TYPES,
  ARCHIVE_AFTER_MS,
  BUILTIN_ACTORS,
  CLOSED_STATUSES,
  FEEDBACK_TYPES,
  NOT_WORK_KINDS,
  OPEN_STATUSES,
  SOURCES,
  normalizeActorId,
  normalizePriority,
  subagentActor,
  STALE_MS,
  STATUSES,
  applyTransition,
  quietTransition,
  buildBoard,
  columnOf,
  GESTURE_KINDS,
  displayState,
  ftsQuery,
  normalizeLabels,
  redactSecrets,
  normalizeLinks,
  sanitizeTicketInput,
  ticketKey,
  normalizeKeyPrefix,
  LEGACY_TICKET_PREFIX,
  TICKET_PREFIX,
  truncate,
  MAX_BODY_CHARS,
  MAX_COMMENT_CHARS,
  groupDigits,
  textTooLong,
} from './core.mjs';
import { HOLD_MAX_BOUNCES, defaultNext, describeCondition, describeNext, fmtTime, sanitizeHold } from './hold.mjs';
import { askView, compareWaiting, jobsWaiting, planAnswer, trustedActor } from './triage.mjs';
import { ROI_TTL_MS, roiFresh, sanitizeRoiInput } from './roi.mjs';
import { ATTACHMENTS_PENDING_PER_ACTOR, ATTACHMENTS_PER_COMMENT, ATTACHMENTS_PER_TICKET, ATTACHMENT_PENDING_TTL_MS } from './attachment.mjs';

/**
 * A comment as stored: trimmed, not empty, at most MAX_COMMENT_CHARS. Too long is a 413 with a
 * message, never a silent cut (until 0.5.9 everything past 4 000 characters was dropped).
 */
export function commentText(text, { allowEmpty = false } = {}) {
  const t = String(text ?? '').trim();
  if (!t && !allowEmpty) throw Object.assign(new Error('empty comment'), { status: 400 });
  const tooLong = textTooLong(t, MAX_COMMENT_CHARS, 'comment');
  if (tooLong) throw Object.assign(new Error(tooLong), { status: 413 });
  return t;
}

/**
 * Text replayed by an import comes from a board that enforced the same limits, so this never cuts in
 * practice; if it ever must, the cut says so in the text itself instead of hiding it.
 */
function keepAtImport(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[cut at import: ${groupDigits(text.length - max)} more characters were not kept]`;
}

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

/** The project label (0.5.17): `front` by default, '' when switched off ('none', 'off', '-'). */
export function normalizeProjectLabel(v) {
  if (v === undefined || v === null) return 'front';
  const s = String(v).trim();
  return /^(?:|none|off|-)$/i.test(s) ? '' : s;
}
/** A comment that gives a project's state: "État au 16/10 …", "State as of …", "Status: …" (markdown emphasis allowed). */
const PROJECT_STATE_RE = /^[\s*_#>]*(?:état au|etat au|state as of|state at|status as of|status at|status:|état :|état:)/i;
const PROJECT_STATE_MAX = 600;

const SCHEMA_VERSION = 2;
const WAIT_KINDS = ['permission', 'question'];
const PRIORITY_RANK = "CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END";
/** Open, not blocked, most important first, then the manual rank, then the oldest. */
const NEXT_ORDER = `ORDER BY ${PRIORITY_RANK}, (t.rank IS NULL), t.rank, t.created_at ASC, t.seq ASC`;
const OPEN_SQL = `(${OPEN_STATUSES.map((s) => `'${s}'`).join(', ')})`;
const CLOSED_SQL = `(${CLOSED_STATUSES.map((s) => `'${s}'`).join(', ')})`;
/** A ticket is blocked while one of its blockers is still open. */
const BLOCKED_SQL = `EXISTS (SELECT 1 FROM ticket_deps d JOIN tickets b ON b.id = d.blocker_id WHERE d.blocked_id = t.id AND b.status NOT IN ${CLOSED_SQL})`;

/**
 * Tickets with a reply this reader has not read (three `?`: the reader). Mine = the reader's comments
 * and the ticket it created; other = the last comment by anyone else (the hooks excepted).
 */
const UNREAD_SQL = `SELECT x.ticket_id, x.other_at FROM (
    SELECT ticket_id,
      MAX(CASE WHEN type = 'comment' AND actor <> ? AND actor <> 'hook' THEN at END) AS other_at,
      MAX(CASE WHEN actor = ? AND type IN ('comment', 'created') THEN at END) AS mine_at
    FROM ticket_events GROUP BY ticket_id) x
  LEFT JOIN ticket_seen s ON s.ticket_id = x.ticket_id AND s.reader = ?
  WHERE x.mine_at IS NOT NULL AND x.other_at > x.mine_at AND x.other_at > COALESCE(s.at, 0)`;

/** Actor ids named in a text as @id or @parent/child (a mention, as the page renders it). */
export function mentionedIds(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/(^|[\s(])@([\p{L}0-9-]{1,64}(?:\/[\p{L}0-9-]{1,64})?)(?![\p{L}0-9/-])/gu)) out.push(m[2]);
  return out;
}

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
  constructor(DatabaseSync, file, { now = () => Date.now(), holdMaxBounces = HOLD_MAX_BOUNCES, keyPrefix, jobActors = [], roiTtlMs = ROI_TTL_MS, defaultRouter, projectLabel } = {}) {
    // 0.5.17: tickets carrying this label are projects, not tasks (BOARD_PROJECT_LABEL; '' or 'none' turns it off).
    this.projectLabel = normalizeProjectLabel(projectLabel);
    /** Agents whose `blocks-job` labels count in the lane order (humans always do), and who may post lane scores (0.5.12). */
    this.jobActors = jobActors;
    // 0.5.15: who gets a ticket the owner comments on without naming anyone (BOARD_DEFAULT_ROUTER).
    this.defaultRouter = normalizeActorId(defaultRouter) || null;
    /** A lane-score snapshot older than this is ignored (lib/roi.mjs). */
    this.roiTtlMs = roiTtlMs;
    /** A ticket woken this many times by holds refuses a new one (0.6.0, BOARD_HOLD_MAX_BOUNCES). */
    this.holdMaxBounces = Number(holdMaxBounces) >= 1 ? Math.floor(Number(holdMaxBounces)) : HOLD_MAX_BOUNCES;
    if (file && file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.file = file || ':memory:';
    this.clock = now;
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA busy_timeout = 3000');
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.stmts = new Map();
    this.listeners = new Set();
    this.pending = null;
    // Change versions only go up, also across restarts (a client compares them, never subtracts).
    this.version = Date.now() * 1000;
    this.migrate(keyPrefix);
  }

  // ---- change feed (server-sent events) ---------------------------------------------------------

  /** Subscribe to committed changes. Returns the unsubscribe function. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Record a change: `{ type, key?, id?, fields? }`. Inside a transaction it waits for the commit
   * (a rolled-back change is never announced); several changes to one ticket merge into one.
   */
  emit(change) {
    if (!this.listeners.size) return;
    if (this.pending) {
      const same = change.id && this.pending.find((c) => c.id === change.id && c.type === change.type);
      if (same) same.fields = [...new Set([...(same.fields || []), ...(change.fields || [])])];
      else this.pending.push({ ...change });
      return;
    }
    this.flush([change]);
  }

  flush(changes) {
    for (const c of changes) {
      const out = { ...c, version: ++this.version, at: this.clock() };
      if (!out.fields?.length) delete out.fields;
      for (const fn of this.listeners) {
        try {
          fn(out);
        } catch {}
      }
    }
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
    if (this.pending) return fn(); // already inside one
    this.db.exec('BEGIN IMMEDIATE');
    this.pending = [];
    try {
      const r = fn();
      this.db.exec('COMMIT');
      const changes = this.pending;
      this.pending = null;
      this.flush(changes);
      return r;
    } catch (e) {
      this.pending = null;
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
  }

  columns(table) {
    return new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  }

  migrate(keyPrefix) {
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
      CREATE TABLE IF NOT EXISTS ticket_imports (
        origin TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    this.fts = true;
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(ticket_id UNINDEXED, title, body, comments)');
    } catch {
      this.fts = false;
    }
    const v = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    const from = v ? Number(v.value) : 0;
    if (from && from < SCHEMA_VERSION) this.backupBefore(from);

    // ---- 0.3 (schema 2): dependencies, rank, actors, threads, feedback ----
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_deps (
        blocker_id TEXT NOT NULL,
        blocked_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
      );
      CREATE INDEX IF NOT EXISTS deps_blocked ON ticket_deps(blocked_id);
      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT,
        parent TEXT,
        first_seen INTEGER, last_seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS avatars (
        actor_id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        data BLOB NOT NULL,
        etag TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT
      );
    `);
    const tcols = this.columns('tickets');
    for (const [col, def] of [
      ['rank', 'REAL'],
      ['created_by', 'TEXT'],
      ['subtype', 'TEXT'],
      ['snoozed_until', 'INTEGER'],
    ])
      if (!tcols.has(col)) this.db.exec(`ALTER TABLE tickets ADD COLUMN ${col} ${def}`);
    if (!this.columns('ticket_events').has('target')) this.db.exec('ALTER TABLE ticket_events ADD COLUMN target TEXT');
    if (!this.columns('sessions').has('thread')) this.db.exec('ALTER TABLE sessions ADD COLUMN thread TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS tickets_kind ON tickets(kind, status)');
    const now = this.clock();
    for (const a of BUILTIN_ACTORS) this.db.prepare('INSERT OR IGNORE INTO actors (id, type, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)').run(a.id, a.type, a.name, now, now);

    if (from < 2) {
      // 0.2 priorities (low/medium/high/urgent) → P3…P0; creators of existing tickets from history.
      this.db.exec("UPDATE tickets SET priority = CASE priority WHEN 'urgent' THEN 'P0' WHEN 'high' THEN 'P1' WHEN 'medium' THEN 'P2' WHEN 'low' THEN 'P3' ELSE priority END WHERE priority IS NOT NULL");
      this.db.exec(`UPDATE tickets SET created_by = COALESCE((SELECT e.actor FROM ticket_events e WHERE e.ticket_id = tickets.id AND e.type = 'created' ORDER BY e.id LIMIT 1), CASE source WHEN 'hook' THEN 'hook' WHEN 'claude' THEN 'claude' ELSE 'user' END) WHERE created_by IS NULL`);
    }
    // Key prefix: kept in meta so it survives restarts. A board that already has tickets keeps SB (its
    // keys are in notes and links); BOARD_KEY_PREFIX switches it, and old keys still resolve (row()).
    const kp = this.db.prepare("SELECT value FROM meta WHERE key = 'key_prefix'").get();
    const hadTickets = !!this.db.prepare('SELECT 1 FROM tickets LIMIT 1').get();
    const wanted = normalizeKeyPrefix(keyPrefix) ?? normalizeKeyPrefix(kp?.value) ?? (hadTickets ? LEGACY_TICKET_PREFIX : TICKET_PREFIX);
    if (kp?.value !== wanted) this.db.prepare("INSERT INTO meta(key, value) VALUES ('key_prefix', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(wanted);
    this.prefix = wanted;
    // 0.5.12: lane scores posted by an installation (lib/roi.mjs). Additive, outside the schema number:
    // one row per scored ticket, the lane line in meta (`roi_summary`), replaced as one snapshot.
    // 0.5.16: pictures attached to comments. Additive. `event_id` stays NULL until a comment claims the picture.
    this.db.exec(`CREATE TABLE IF NOT EXISTS ticket_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      event_id INTEGER,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      etag TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER, height INTEGER,
      at INTEGER NOT NULL,
      by TEXT
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS attachments_ticket ON ticket_attachments(ticket_id, event_id)');
    // 0.5.18: any file, with its (cleaned) name. Additive. A file uploaded from the new ticket form waits
    // with ticket_id '' until the ticket it was picked for is created by the same actor.
    if (!this.db.prepare('PRAGMA table_info(ticket_attachments)').all().some((c) => c.name === 'name')) this.db.exec('ALTER TABLE ticket_attachments ADD COLUMN name TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS ticket_roi (ticket_id TEXT PRIMARY KEY, score REAL NOT NULL, note TEXT, at INTEGER NOT NULL)');
    // 0.5.15: when each reader last opened a ticket, so "someone answered you" follows them across devices.
    this.db.exec('CREATE TABLE IF NOT EXISTS ticket_seen (reader TEXT NOT NULL, ticket_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (reader, ticket_id))');
    // 0.9.0: the owner's comments that tag a session (@session/1a2b3c4d), until its next prompt hook takes them.
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_mentions (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ticket_id TEXT NOT NULL,
      event_id INTEGER, text TEXT NOT NULL, at INTEGER NOT NULL, delivered_at INTEGER)`);
    this.db.exec('CREATE INDEX IF NOT EXISTS session_mentions_pending ON session_mentions(session_id, delivered_at)');
    // 0.9.2: a session opened on a ticket (SESSION_BOARD_TICKET) and the last comment of that ticket it has seen.
    this.db.exec('CREATE TABLE IF NOT EXISTS session_links (session_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, cursor INTEGER NOT NULL, linked_at INTEGER NOT NULL)');
    // 0.6.0: what a ticket on hold waits for, and what happens then (lib/hold.mjs). One row per ticket on hold.
    // pr_state: the last state seen of the awaited pull request ('closed' = closed without merge: it cannot come).
    this.db.exec(`CREATE TABLE IF NOT EXISTS ticket_holds (
      ticket_id TEXT PRIMARY KEY, condition TEXT NOT NULL, next TEXT, note TEXT, set_by TEXT, set_at INTEGER NOT NULL,
      prev_assignee TEXT, prev_status TEXT, pr TEXT, pr_state TEXT, checked_at INTEGER)`);
    if (!v) this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    else if (from < SCHEMA_VERSION) this.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(SCHEMA_VERSION));
  }

  /** Before a schema upgrade of a file with tickets: a full copy next to it, never deleted. */
  backupBefore(from) {
    if (this.file === ':memory:') return;
    try {
      const n = Number(this.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n);
      if (!n) return;
      const stamp = new Date(this.clock()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      this.db.exec(`VACUUM INTO '${`${this.file}.schema${from}-${stamp}.bak`.replace(/'/g, "''")}'`);
    } catch {}
  }

  // ---- actors -----------------------------------------------------------------------------------

  /** Remember who acts (id, type, display name, parent for subagents). Returns the id. */
  touchActor(a, at = this.clock()) {
    const id = normalizeActorId(a?.id);
    if (!id) return null;
    const type = ACTOR_TYPES.includes(a.type) ? a.type : null;
    const name = typeof a.name === 'string' && a.name.trim() ? truncate(a.name, 60) : null;
    const parent = normalizeActorId(a.parent) || null;
    this.q(
      `INSERT INTO actors (id, type, name, parent, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = COALESCE(?, actors.type),
         -- A manual rename (actors.name) wins forever; we only fill it when missing.
         name = COALESCE(actors.name, excluded.name),
         parent = COALESCE(?, actors.parent), last_seen = MAX(actors.last_seen, excluded.last_seen)`,
    ).run(id, type || 'agent', name, parent, at, at, type, parent);
    return id;
  }

  countActors() {
    return Number(this.q('SELECT COUNT(*) AS n FROM actors').get().n);
  }

  listActors() {
    // Capped at 300, most recent first — but people and actors with a picture always make the list: on a busy
    // board, hundreds of short-lived job actors pushed the owner and long-lived agents past the cap, and the page
    // then drew initials for actors whose picture was stored.
    const cols = `a.*, v.etag AS avatar, (SELECT COUNT(*) FROM tickets t WHERE (t.assignee = a.id OR t.created_by = a.id) AND t.status IN ${OPEN_SQL}) AS open`;
    const recent = this.q(`SELECT ${cols} FROM actors a LEFT JOIN avatars v ON v.actor_id = a.id ORDER BY (a.type = 'system'), a.last_seen DESC LIMIT 300`).all();
    const seen = new Set(recent.map((a) => a.id));
    const kept = this.q(`SELECT ${cols} FROM actors a LEFT JOIN avatars v ON v.actor_id = a.id WHERE a.type = 'human' OR v.etag IS NOT NULL ORDER BY a.last_seen DESC LIMIT 500`)
      .all()
      .filter((a) => !seen.has(a.id));
    return [...recent, ...kept].map((a) => ({ id: a.id, type: a.type, name: a.name || null, parent: a.parent, last_seen: a.last_seen, open: Number(a.open), avatar: a.avatar || null }));
  }

  getActor(id) {
    const actor = normalizeActorId(id);
    return actor ? (this.q('SELECT id, type, name, parent, first_seen, last_seen FROM actors WHERE id = ?').get(actor) ?? null) : null;
  }

  /** Store an actor's picture (already checked by `checkAvatar`). Returns the new etag, or null if no such actor. */
  setAvatar(id, { mime, data }, by = null, now = this.clock()) {
    const actor = this.getActor(id);
    if (!actor) return null;
    const etag = createHash('sha256').update(data).digest('hex').slice(0, 16);
    this.q(
      `INSERT INTO avatars (actor_id, mime, data, etag, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(actor_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, etag = excluded.etag, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(actor.id, mime, data, etag, now, by);
    this.emit({ type: 'actor', id: actor.id, fields: ['avatar'] });
    return etag;
  }

  getAvatar(id) {
    const row = this.q('SELECT mime, data, etag, updated_at FROM avatars WHERE actor_id = ?').get(String(id));
    return row ? { mime: row.mime, data: Buffer.from(row.data), etag: row.etag, updated_at: row.updated_at } : null;
  }

  deleteAvatar(id) {
    const n = Number(this.q('DELETE FROM avatars WHERE actor_id = ?').run(String(id)).changes);
    if (n) this.emit({ type: 'actor', id: String(id), fields: ['avatar'] });
    return n > 0;
  }

  /**
   * Store a file (already checked by `checkAttachment`) for a ticket, or for no ticket yet (`idOrKey`
   * null: the new ticket form); it waits for a comment, or the ticket's creation, to claim it. Files
   * uploaded for no ticket and unclaimed within a day are dropped here.
   */
  addAttachment(idOrKey, { mime, data, width = null, height = null, name = null }, by = null, now = this.clock()) {
    this.q("DELETE FROM ticket_attachments WHERE event_id IS NULL AND ticket_id = '' AND at < ?").run(now - ATTACHMENT_PENDING_TTL_MS);
    let ticketId = '';
    if (idOrKey !== null && idOrKey !== undefined) {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      ticketId = row.id;
      const n = Number(this.q('SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = ?').get(ticketId).n);
      if (n >= ATTACHMENTS_PER_TICKET) throw Object.assign(new Error(`too many files on this ticket (max ${ATTACHMENTS_PER_TICKET})`), { status: 413 });
    } else {
      const n = Number(this.q("SELECT COUNT(*) AS n FROM ticket_attachments WHERE ticket_id = '' AND by IS ?").get(by).n);
      if (n >= ATTACHMENTS_PENDING_PER_ACTOR) throw Object.assign(new Error(`too many files waiting for a new ticket (max ${ATTACHMENTS_PENDING_PER_ACTOR})`), { status: 413 });
    }
    const etag = createHash('sha256').update(data).digest('hex').slice(0, 16);
    const r = this.q('INSERT INTO ticket_attachments (ticket_id, mime, data, etag, size, width, height, at, by, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ticketId, mime, data, etag, data.length, width, height, now, by, name);
    return { id: Number(r.lastInsertRowid), mime, name, size: data.length, width, height, etag };
  }

  /** One file with what serving it needs: whether a comment claimed it, and who uploaded it. */
  getAttachment(id) {
    const row = this.q('SELECT mime, data, etag, ticket_id, event_id, name, by FROM ticket_attachments WHERE id = ?').get(Number(id) || 0);
    return row ? { mime: row.mime, data: Buffer.from(row.data), etag: row.etag, ticket_id: row.ticket_id, claimed: row.event_id !== null, name: row.name, by: row.by } : null;
  }

  /**
   * Link waiting files to a comment (or a ticket's creation): files of this ticket, or files this actor
   * uploaded before the ticket existed. Any other id refuses the whole comment.
   */
  claimAttachments(ticketId, eventId, ids, actor = null) {
    if (ids === undefined || ids === null) return;
    if (!Array.isArray(ids)) throw Object.assign(new Error('attachments must be a list of file ids'), { status: 400 });
    if (!ids.length) return;
    const list = [...new Set(ids.map((x) => Number(x)))];
    if (list.length > ATTACHMENTS_PER_COMMENT || list.some((x) => !Number.isInteger(x) || x < 1)) {
      throw Object.assign(new Error(`a comment carries at most ${ATTACHMENTS_PER_COMMENT} files`), { status: 400 });
    }
    const upd = this.db.prepare("UPDATE ticket_attachments SET event_id = ?, ticket_id = ? WHERE id = ? AND event_id IS NULL AND (ticket_id = ? OR (ticket_id = '' AND by IS ?))");
    for (const id of list) {
      if (Number(upd.run(eventId, ticketId, id, ticketId, actor).changes) !== 1) throw Object.assign(new Error(`file ${id} is not available for this ticket`), { status: 400 });
    }
  }

  /** Rename one actor (UI/API convenience). name: null clears it. */
  renameActor(id, name, now = this.clock()) {
    const actor = normalizeActorId(id);
    if (!actor) throw Object.assign(new Error('bad actor id'), { status: 400 });
    if (['user', 'claude', 'hook'].includes(actor)) throw Object.assign(new Error('cannot rename a built-in actor'), { status: 400 });
    const n = typeof name === 'string' && name.trim() ? truncate(name, 60) : null;
    this.q('UPDATE actors SET name = ?, last_seen = MAX(last_seen, ?) WHERE id = ?').run(n, now, actor);
    return this.q('SELECT id, type, name, parent, first_seen, last_seen FROM actors WHERE id = ?').get(actor) ?? null;
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
      `INSERT INTO sessions (id, title, name, repo, branch, cwd, machine, origin, url, state, detail, first_seen, last_seen, rec, thread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, name = excluded.name, repo = excluded.repo,
         branch = excluded.branch, cwd = excluded.cwd, machine = excluded.machine, origin = excluded.origin,
         url = excluded.url, state = excluded.state, detail = excluded.detail, last_seen = excluded.last_seen,
         rec = excluded.rec, thread = excluded.thread`,
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
      rec.thread ?? null,
    );
    this.emit({ type: 'session', id: rec.sessionId });
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

  /** `ALV-12` (or this board's prefix). */
  key(seq) {
    return ticketKey(seq, this.prefix);
  }

  row(idOrKey) {
    if (!idOrKey) return null;
    const s = String(idOrKey);
    const m = s.match(/^[A-Za-z]+-(\d+)$/);
    if (m) return this.q('SELECT * FROM tickets WHERE seq = ?').get(Number(m[1])) ?? null;
    if (/^\d+$/.test(s)) return this.q('SELECT * FROM tickets WHERE seq = ?').get(Number(s)) ?? null;
    return this.q('SELECT * FROM tickets WHERE id = ?').get(s) ?? null;
  }

  addEvent(ticketId, at, actor, type, { from = null, to = null, text = null, target = null } = {}) {
    return Number(
      this.q('INSERT INTO ticket_events (ticket_id, at, actor, type, from_status, to_status, text, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        ticketId,
        at,
        actor,
        type,
        from,
        to,
        text,
        target && target !== actor ? target : null,
      ).lastInsertRowid,
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
         created_at, updated_at, status_at, closed_at, rank, created_by, subtype)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      seq,
      t.title,
      t.body ?? '',
      status,
      t.kind || 'action',
      t.assignee || 'user',
      normalizePriority(t.priority) ?? null,
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
      Number.isFinite(t.rank) ? t.rank : null,
      t.created_by || actor,
      t.subtype ?? null,
    );
    const assignee = t.assignee || 'user';
    this.addEvent(id, at, actor, 'created', { to: status, text: null, target: actor === 'hook' ? null : assignee });
    this.reindex(id);
    this.emit({ type: 'ticket', op: 'created', id, key: this.key(seq) });
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
    // A hand-over is its own history line, so "who gave it to whom" reads at a glance.
    if (changedKeys.includes('assignee') && actor !== 'hook') this.addEvent(row.id, at, actor, 'assigned', { text: fields.assignee, target: fields.assignee });
    const edited = changedKeys.filter((k) => ['title', 'body', 'labels', 'priority', 'kind', 'parent_id', 'links', 'subtype'].includes(k));
    if (edited.length && actor !== 'hook') this.addEvent(row.id, at, actor, 'edit', { text: edited.map((k) => (k === 'parent_id' ? 'parent' : k)).join(', ') });
    if (changedKeys.some((k) => k === 'title' || k === 'body' || k === 'labels')) this.reindex(row.id);
    this.emit({ type: 'ticket', op: 'updated', id: row.id, key: this.key(row.seq), fields: [...changedKeys, ...(moved ? ['status'] : []), ...(note ? ['history'] : [])] });
    if (moved) {
      const wasClosed = CLOSED_STATUSES.includes(row.status);
      const isClosed = CLOSED_STATUSES.includes(fields.status);
      if (wasClosed !== isClosed) this.blockerMoved(row, fields.status, isClosed, actor, at);
      if (row.status === 'on_hold') this.q('DELETE FROM ticket_holds WHERE ticket_id = ?').run(row.id);
    }
    return this.q('SELECT * FROM tickets WHERE id = ?').get(row.id);
  }

  // ---- 0.6.0: on hold — a ticket woken by the event that unblocks it (lib/hold.mjs) -------------

  /** The hold row of a ticket, parsed, or null. */
  holdOf(id) {
    const h = this.q('SELECT * FROM ticket_holds WHERE ticket_id = ?').get(id);
    return h ? { ...h, condition: parseJson(h.condition, null), next: parseJson(h.next, null) } : null;
  }

  /** How many times a hold woke this ticket: past the cap, a new hold is refused (no A↔B loop). */
  holdBounces(id) {
    return Number(this.q("SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ? AND type = 'resumed'").get(id).n);
  }

  /**
   * Put a ticket on hold: { condition, then?, note? } (sanitizeHold). Replaces the hold of a ticket already
   * on hold, keeping who had it before. 400 when there is nothing to wait for, 409 on a closed ticket or past the cap.
   */
  hold(idOrKey, input, { actor = 'user', now = this.clock() } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      this.holdRow(row, input, actor, now);
      return this.present(this.row(row.id), now);
    });
  }

  holdRow(row, input, actor, now) {
    const { value, error } = sanitizeHold(input, now);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    if (CLOSED_STATUSES.includes(row.status)) throw Object.assign(new Error('a closed ticket cannot be put on hold'), { status: 409 });
    const bounces = this.holdBounces(row.id);
    if (bounces >= this.holdMaxBounces) {
      throw Object.assign(new Error(`${this.key(row.seq)} was woken ${bounces} times already: it needs someone to decide, not another wait`), { status: 409 });
    }
    const { condition, then, note } = value;
    if (condition.type === 'blocked_by') {
      for (const k of condition.keys) this.addDep(row, k, actor, now);
      const open = this.openBlockers(row.id);
      if (!open.length) throw Object.assign(new Error('nothing open blocks it: name the open tickets it waits for'), { status: 400 });
      condition.keys = open.map((b) => this.key(b.seq));
    }
    if (condition.type === 'external' && condition.deadline && condition.deadline <= now) throw Object.assign(new Error('condition.deadline is already past'), { status: 400 });
    if (condition.type === 'time' && condition.at <= now) throw Object.assign(new Error('condition.at is already past'), { status: 400 });
    if (condition.type === 'reply' && condition.from === actor) throw Object.assign(new Error('a ticket cannot wait for a reply from whoever puts it on hold'), { status: 400 });
    const prev = this.holdOf(row.id);
    const prevAssignee = prev ? prev.prev_assignee : row.assignee;
    const prevStatus = prev ? prev.prev_status : row.status;
    this.q(
      `INSERT INTO ticket_holds (ticket_id, condition, next, note, set_by, set_at, prev_assignee, prev_status, pr, pr_state, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(ticket_id) DO UPDATE SET condition = excluded.condition, next = excluded.next, note = excluded.note, set_by = excluded.set_by,
         set_at = excluded.set_at, pr = excluded.pr, pr_state = NULL, checked_at = NULL`,
    ).run(row.id, JSON.stringify(condition), then ? JSON.stringify(then) : null, note || null, actor, now, prevAssignee, prevStatus, condition.pr || null);
    const next = then || defaultNext({ set_by: actor, prev_assignee: prevAssignee });
    const text = `On hold until ${describeCondition(condition)}, then ${describeNext(next)}${note ? ` (${note})` : ''}`;
    if (row.status === 'on_hold') {
      this.addEvent(row.id, now, actor, 'note', { text });
      this.q('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, row.id);
      this.emit({ type: 'ticket', op: 'updated', id: row.id, key: this.key(row.seq), fields: ['hold'] });
    } else {
      this.patchTicket(row, { status: 'on_hold', snoozed_until: row.snoozed_until ? null : undefined }, actor, now, text);
    }
  }

  /** Lift a hold by hand: the ticket goes back to whoever had it, as it was, and nothing else runs. */
  unhold(idOrKey, { actor = 'user', now = this.clock() } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      const h = this.holdOf(row.id);
      if (!h || row.status !== 'on_hold') throw Object.assign(new Error('this ticket is not on hold'), { status: 409 });
      this.q('DELETE FROM ticket_holds WHERE ticket_id = ?').run(row.id);
      const status = h.prev_status && h.prev_status !== 'on_hold' && !CLOSED_STATUSES.includes(h.prev_status) ? h.prev_status : 'todo';
      this.patchTicket(row, { status, assignee: h.prev_assignee || row.assignee }, actor, now, 'Hold lifted by hand');
      return this.present(this.row(row.id), now);
    });
  }

  /** Is the condition met? Returns the reason in words, or null. */
  holdMet(row, h, now) {
    const c = h.condition;
    if (!c) return null;
    if (c.type === 'blocked_by') {
      if (this.openBlockers(row.id).length) return null;
      const keys = this.deps(row.id).blocked_by.map((b) => b.key);
      if (!keys.length) return null;
      return keys.length === 1 ? `${keys[0]} is closed` : `${keys.join(', ')} are closed`;
    }
    if (c.type === 'pr_merged') return h.pr_state === 'merged' ? `pull request ${c.pr} is merged` : null;
    if (c.type === 'time') return now >= c.at ? 'the time it waited for has come' : null;
    if (c.type === 'reply') {
      const r = this.q("SELECT 1 AS hit FROM ticket_events WHERE ticket_id = ? AND type = 'comment' AND actor = ? AND at >= ? LIMIT 1").get(row.id, c.from, h.set_at);
      return r ? `@${c.from} replied` : null;
    }
    if (c.type === 'external') return c.fired ? `seen: ${c.what}${c.fired.proof ? ` (${c.fired.proof})` : ''}` : null;
    return null;
  }

  /** 0.8.0: an external hold whose deadline passed unmet; returns the reason in words, or null. */
  holdMissed(h, now) {
    const c = h.condition;
    if (c?.type !== 'external' || c.fired || !c.deadline || now < c.deadline) return null;
    return `not met: ${c.what} was not seen by ${fmtTime(c.deadline)}`;
  }

  /**
   * 0.8.0: what an external hold waits for is seen (a watcher, a script, a person): { proof } in words, kept in
   * the history. The hold's next step runs at once. 409 when the ticket does not wait for an external state.
   */
  fireHoldExternal(idOrKey, input, { actor = 'user', now = this.clock() } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      const h = this.holdOf(row.id);
      if (!h || row.status !== 'on_hold') throw Object.assign(new Error('this ticket is not on hold'), { status: 409 });
      if (h.condition?.type !== 'external') throw Object.assign(new Error('this hold does not wait for an external state'), { status: 409 });
      const proof = typeof input?.proof === 'string' ? truncate(input.proof.trim(), 2000) : '';
      if (!proof) throw Object.assign(new Error('proof must say, in words, what was seen'), { status: 400 });
      const condition = { ...h.condition, fired: { at: now, by: actor, proof } };
      this.q('UPDATE ticket_holds SET condition = ?, checked_at = ? WHERE ticket_id = ?').run(JSON.stringify(condition), now, row.id);
      this.fireHold(row, { ...h, condition }, this.holdMet(row, { ...h, condition }, now), now);
      return this.present(this.row(row.id), now);
    });
  }

  /** Check one ticket's hold and run its next step when the condition is met. Returns the key woken, or null. */
  checkHold(id, now = this.clock()) {
    return this.tx(() => {
      const row = this.q('SELECT * FROM tickets WHERE id = ?').get(id);
      const h = row && this.holdOf(row.id);
      if (!h) return null;
      if (row.status !== 'on_hold') {
        this.q('DELETE FROM ticket_holds WHERE ticket_id = ?').run(row.id);
        return null;
      }
      const reason = this.holdMet(row, h, now);
      if (reason) return this.fireHold(row, h, reason, now);
      const missed = this.holdMissed(h, now);
      return missed ? this.fireHold(row, h, missed, now, h.condition.otherwise) : null;
    });
  }

  /**
   * Run the next step of a met hold, once: the hold row is deleted first (a second event finds nothing),
   * the move and its reason are written in the history ("Back with @x: ALV-3 is closed").
   */
  fireHold(row, h, reason, now, override = null) {
    if (!this.q('DELETE FROM ticket_holds WHERE ticket_id = ?').run(row.id).changes) return null;
    const next = override || h.next || defaultNext(h);
    const by = 'board';
    let assignee = h.prev_assignee || row.assignee;
    let status = 'todo';
    if (next.type === 'wake') assignee = next.actor;
    if (next.type === 'assign') {
      assignee = next.to;
      status = next.status || 'todo';
    }
    const who = assignee === 'user' ? 'you' : `@${assignee}`;
    this.addEvent(row.id, now, by, 'resumed', { text: `Back with ${who}: ${reason}`, target: assignee });
    this.patchTicket(this.row(row.id), { status, assignee }, by, now, null);
    const fresh = this.row(row.id);
    if (next.type === 'wake') this.commentRow(fresh, `@${next.actor} ${reason}. ${next.text || 'Your turn.'}`, by, now, next.actor);
    else if (next.type === 'comment') this.commentRow(fresh, next.text, by, now, null);
    else if (next.text) this.commentRow(fresh, next.text, by, now, assignee === 'user' ? null : assignee);
    return this.key(row.seq);
  }

  /** Every ticket on hold whose condition is met now (time reached, blockers gone): the clock's round. */
  tickHolds(now = this.clock()) {
    const out = [];
    for (const h of this.q('SELECT ticket_id FROM ticket_holds').all()) {
      const k = this.checkHold(h.ticket_id, now);
      if (k) out.push(k);
    }
    return out;
  }

  /** The pull requests holds wait on, whose merge is not known yet (for a poller). */
  awaitedPrs() {
    return this.q("SELECT DISTINCT pr FROM ticket_holds WHERE pr IS NOT NULL AND COALESCE(pr_state, 'open') = 'open'").all().map((r) => r.pr);
  }

  /** A pull request moved (webhook or poll): `merged` wakes every hold on it; `closed` marks them stuck. */
  signalPr(pr, state, now = this.clock()) {
    if (!['open', 'merged', 'closed'].includes(state)) throw Object.assign(new Error('state must be open, merged or closed'), { status: 400 });
    return this.tx(() => {
      const holds = this.q('SELECT ticket_id FROM ticket_holds WHERE pr = ?').all(pr);
      this.q('UPDATE ticket_holds SET pr_state = ?, checked_at = ? WHERE pr = ?').run(state, now, pr);
      const woken = [];
      for (const h of holds) {
        const k = this.checkHold(h.ticket_id, now);
        if (k) woken.push(k);
        else {
          const t = this.q('SELECT seq FROM tickets WHERE id = ?').get(h.ticket_id);
          if (t) this.emit({ type: 'ticket', op: 'updated', id: h.ticket_id, key: this.key(t.seq), fields: ['hold'] });
        }
      }
      return { pr, state, tickets: holds.length, woken };
    });
  }

  /** A hold as the API shows it, with what can no longer happen (`stuck`). */
  holdView(row, now) {
    const h = this.holdOf(row.id);
    if (!h) return null;
    const next = h.next || defaultNext(h);
    let stuck = null;
    if (h.condition?.type === 'pr_merged' && h.pr_state === 'closed') stuck = `pull request ${h.condition.pr} was closed without being merged`;
    if (h.condition?.type === 'blocked_by' && !this.deps(row.id).blocked_by.length) stuck = 'it no longer has any blocker';
    if (h.condition?.type === 'reply' && h.condition.from !== 'user' && !this.q('SELECT 1 FROM actors WHERE id = ?').get(h.condition.from)) stuck = `@${h.condition.from} is not an actor of this board`;
    return {
      condition: h.condition,
      then: h.next,
      next,
      waits_for: describeCondition(h.condition),
      next_text: describeNext(next),
      note: h.note || null,
      set_by: h.set_by,
      set_at: Number(h.set_at),
      prev_assignee: h.prev_assignee,
      bounces: this.holdBounces(row.id),
      stuck,
      days: Math.floor((now - Number(h.set_at)) / 86400000),
    };
  }

  // ---- dependencies: "A blocks B" ---------------------------------------------------------------

  /** Open blockers of a ticket. */
  openBlockers(id) {
    return this.q(`SELECT b.* FROM ticket_deps d JOIN tickets b ON b.id = d.blocker_id WHERE d.blocked_id = ? AND b.status NOT IN ${CLOSED_SQL} ORDER BY b.seq`).all(id);
  }

  /**
   * A blocker was closed (or reopened): every open ticket it blocks whose last open blocker it was
   * gets an `unblocked` (or `blocked`) line in its history, and moves on the board.
   */
  blockerMoved(blocker, status, closed, actor, at) {
    const key = this.key(blocker.seq);
    const blocked = this.q(`SELECT t.* FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_id WHERE d.blocker_id = ? AND t.status IN ${OPEN_SQL}`).all(blocker.id);
    for (const t of blocked) {
      const others = this.openBlockers(t.id).filter((b) => b.id !== blocker.id);
      if (others.length) continue;
      this.addEvent(t.id, at, actor, closed ? 'unblocked' : 'blocked', {
        text: closed ? `${status === 'done' ? 'closed' : 'cancelled'} ${key}: nothing blocks it any more` : `reopened ${key}, which blocks it again`,
      });
      this.q('UPDATE tickets SET updated_at = ? WHERE id = ?').run(at, t.id);
      this.emit({ type: 'ticket', op: 'updated', id: t.id, key: this.key(t.seq), fields: ['blocked'] });
      if (closed && t.status === 'on_hold') this.checkHold(t.id, at);
    }
  }

  /** Would "blocker blocks blocked" close a loop? True when blocked already (transitively) blocks blocker. */
  wouldCycle(blockerId, blockedId) {
    if (blockerId === blockedId) return true;
    const r = this.q(
      `WITH RECURSIVE down(id) AS (
         SELECT blocked_id FROM ticket_deps WHERE blocker_id = ?
         UNION SELECT d.blocked_id FROM ticket_deps d JOIN down ON d.blocker_id = down.id
       ) SELECT 1 AS hit FROM down WHERE id = ? LIMIT 1`,
    ).get(blockedId, blockerId);
    return Boolean(r);
  }

  /** `blocker` blocks `row`. Throws 400 on an unknown key or a cycle; no-op when already there. */
  addDep(row, blockerKey, actor, at) {
    const b = this.row(blockerKey);
    if (!b) throw Object.assign(new Error(`ticket ${blockerKey} not found`), { status: 400 });
    if (this.q('SELECT 1 FROM ticket_deps WHERE blocker_id = ? AND blocked_id = ?').get(b.id, row.id)) return false;
    if (this.wouldCycle(b.id, row.id)) {
      throw Object.assign(new Error(`${this.key(b.seq)} cannot block ${this.key(row.seq)}: that would make a dependency cycle`), { status: 400 });
    }
    this.q('INSERT INTO ticket_deps (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(b.id, row.id, at);
    this.addEvent(row.id, at, actor, 'dependency', { text: `made it wait for ${this.key(b.seq)}` });
    this.addEvent(b.id, at, actor, 'dependency', { text: `made ${this.key(row.seq)} wait for it` });
    this.q('UPDATE tickets SET updated_at = ? WHERE id IN (?, ?)').run(at, row.id, b.id);
    this.emit({ type: 'dependency', op: 'added', id: row.id, key: this.key(row.seq), blocker: this.key(b.seq) });
    return true;
  }

  removeDep(row, blockerKey, actor, at) {
    const b = this.row(blockerKey);
    if (!b) return false;
    const n = Number(this.q('DELETE FROM ticket_deps WHERE blocker_id = ? AND blocked_id = ?').run(b.id, row.id).changes);
    if (!n) return false;
    this.addEvent(row.id, at, actor, 'dependency', { text: `removed the wait for ${this.key(b.seq)}` });
    this.addEvent(b.id, at, actor, 'dependency', { text: `removed the wait of ${this.key(row.seq)} on it` });
    this.q('UPDATE tickets SET updated_at = ? WHERE id IN (?, ?)').run(at, row.id, b.id);
    this.emit({ type: 'dependency', op: 'removed', id: row.id, key: this.key(row.seq), blocker: this.key(b.seq) });
    return true;
  }

  applyDeps(row, value, actor, at) {
    for (const k of value.blocked_by_remove || []) this.removeDep(row, k, actor, at);
    for (const k of [...(value.blocked_by || []), ...(value.blocked_by_add || [])]) this.addDep(row, k, actor, at);
  }

  /**
   * Manual order: put a ticket right after `after` (or right before `before`, or first when both are
   * empty) among the open tickets of the same priority. The ticket takes the priority of the
   * neighbour it is dropped next to, and that whole group is renumbered 10, 20, 30…
   */
  moveTicket(idOrKey, { after, before } = {}, { actor = 'user', now = this.clock() } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      const anchor = after ? this.row(after) : before ? this.row(before) : null;
      if ((after || before) && !anchor) throw Object.assign(new Error('neighbour not found'), { status: 400 });
      if (anchor && anchor.id === row.id) return this.present(row, now);
      const priority = anchor ? anchor.priority : row.priority;
      const group = this.db
        .prepare(`SELECT t.* FROM tickets t WHERE t.status IN ${OPEN_SQL} AND t.id <> ? AND ${priority ? 't.priority = ?' : 't.priority IS NULL'} ${NEXT_ORDER}`)
        .all(...[row.id, ...(priority ? [priority] : [])]);
      let at = 0;
      if (anchor) {
        const i = group.findIndex((g) => g.id === anchor.id);
        at = i < 0 ? group.length : after ? i + 1 : i;
      }
      group.splice(at, 0, row);
      const upd = this.q('UPDATE tickets SET rank = ? WHERE id = ?');
      group.forEach((g, i) => {
        if (g.id !== row.id && g.rank !== (i + 1) * 10) upd.run((i + 1) * 10, g.id);
      });
      const fields = { rank: (at + 1) * 10 };
      if ((priority ?? null) !== (row.priority ?? null)) fields.priority = priority;
      this.patchTicket(row, fields, actor, now);
      this.emit({ type: 'reorder', priority: priority ?? null });
      return this.present(this.row(row.id), now);
    });
  }

  // ---- public API: tickets ---------------------------------------------------------------------

  /** Create from API / MCP / CLI input. actor: 'user', 'claude' or any actor id. */
  createTicket(input, { actor = 'user', now = this.clock() } = {}) {
    // 0.5.18: files picked in the new ticket form, uploaded before the ticket existed, join its creation.
    const files = input?.attachments;
    if (files !== undefined && input && typeof input === 'object') input = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'attachments'));
    const { value, error, status } = sanitizeTicketInput(input);
    if (error) throw Object.assign(new Error(error), { status: status || 400 });
    const deps = { blocked_by: value.blocked_by, blocked_by_add: value.blocked_by_add };
    delete value.blocked_by;
    delete value.blocked_by_add;
    delete value.blocked_by_remove;
    const human = actor === 'user';
    if (value.kind === 'feedback') {
      value.subtype = FEEDBACK_TYPES.includes(value.subtype) ? value.subtype : 'suggestion';
      value.status = CLOSED_STATUSES.includes(value.status) ? value.status : 'todo';
    }
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
        kind: value.kind || (human ? 'action' : 'task'),
        assignee: value.assignee || 'user',
        parent_id: parent?.id ?? null,
        source: human ? 'user' : 'claude',
        title_locked: true,
      };
      const row = this.insertTicket(t, actor, now);
      this.applyDeps(row, deps, actor, now);
      if (Array.isArray(files) ? files.length : files != null) {
        const created = this.q("SELECT id FROM ticket_events WHERE ticket_id = ? AND type = 'created' ORDER BY id DESC LIMIT 1").get(row.id);
        this.claimAttachments(row.id, Number(created.id), files, actor);
      }
      return this.present(this.row(row.id), now);
    });
  }

  updateTicket(idOrKey, input, { actor = 'user', now = this.clock(), note } = {}) {
    const { value, error, status } = sanitizeTicketInput(input, { partial: true });
    if (error) throw Object.assign(new Error(error), { status: status || 400 });
    // A comment riding along is checked before anything moves: refused whole, never half applied.
    if (typeof input?.comment === 'string') commentText(input.comment, { allowEmpty: true });
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
      const deps = { blocked_by: fields.blocked_by, blocked_by_add: fields.blocked_by_add, blocked_by_remove: fields.blocked_by_remove };
      delete fields.blocked_by;
      delete fields.blocked_by_add;
      delete fields.blocked_by_remove;
      if (row.kind === 'feedback' && fields.subtype !== undefined && fields.subtype !== null && !FEEDBACK_TYPES.includes(fields.subtype)) {
        throw Object.assign(new Error(`feedback subtype must be one of ${FEEDBACK_TYPES.join(', ')}`), { status: 400 });
      }
      this.applyDeps(row, deps, actor, now);
      // 0.6.0: on hold always says what it waits for: the hold given, else its open blockers.
      const holding = fields.status === 'on_hold' && row.status !== 'on_hold';
      if (holding) delete fields.status;
      let out = this.patchTicket(this.row(row.id), fields, actor, now, note);
      if (holding) {
        this.holdRow(out, input.hold ?? { condition: { type: 'blocked_by' } }, actor, now);
        out = this.row(row.id);
      }
      if (typeof input?.comment === 'string' && input.comment.trim()) {
        this.commentRow(out, input.comment, actor, now, input.to);
        // A comment that rides with its own move (status or assignee) keeps that move.
        if (fields.status === undefined && fields.assignee === undefined) this.routeOwnerComment(this.row(row.id), input.comment, actor, now, input.to);
      }
      return this.present(this.row(row.id), now);
    });
  }

  commentRow(row, text, actor, now, to, attachments = []) {
    const t = commentText(text);
    const eventId = this.addEvent(row.id, now, actor, 'comment', { text: t, target: normalizeActorId(to) || null });
    this.claimAttachments(row.id, eventId, attachments, actor);
    this.q('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, row.id);
    this.reindex(row.id);
    this.emit({ type: 'comment', id: row.id, key: this.key(row.seq) });
    if (row.status === 'on_hold' && actor !== 'board') this.checkHold(row.id, now);
    if (actor === 'user') this.queueSessionMentions(row, t, eventId, now);
    return eventId;
  }

  comment(idOrKey, text, { actor = 'user', now = this.clock(), to, attachments = [] } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      this.commentRow(row, text, actor, now, to, attachments);
      this.routeOwnerComment(this.row(row.id), text, actor, now, to);
      return this.present(this.row(row.id), now);
    });
  }

  /** The session an `@session/<prefix>` handle names: one session whose id starts with it, else null. */
  sessionByHandle(handle) {
    const m = /^session\/([0-9a-z-]{6,64})$/i.exec(String(handle || ''));
    if (!m) return null;
    const rows = this.q("SELECT id FROM sessions WHERE lower(substr(id, 1, ?)) = lower(?) LIMIT 2").all(m[1].length, m[1]);
    return rows.length === 1 ? rows[0].id : null;
  }

  /**
   * The owner tagged one or more Claude Code sessions (`@session/1a2b3c4d`): each gets the comment in
   * its queue, delivered by its next UserPromptSubmit hook (takeSessionMentions). Only the owner's
   * comments are queued: text pushed into a running session is an instruction, nobody else may give it.
   */
  queueSessionMentions(row, text, eventId, now) {
    const seen = new Set();
    for (const handle of mentionedIds(text)) {
      const sid = this.sessionByHandle(handle);
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      this.q('INSERT INTO session_mentions (session_id, ticket_id, event_id, text, at) VALUES (?, ?, ?, ?, ?)').run(sid, row.id, eventId, text, now);
    }
    return seen.size;
  }

  /** The tagged comments waiting for this session, marked delivered: [{ key, title, text, at }]. */
  takeSessionMentions(sessionId, now = this.clock()) {
    if (!sessionId) return [];
    return this.tx(() => {
      const rows = this.q(
        `SELECT m.id, m.text, m.at, t.seq, t.title FROM session_mentions m JOIN tickets t ON t.id = m.ticket_id
         WHERE m.session_id = ? AND m.delivered_at IS NULL ORDER BY m.at, m.id LIMIT 20`,
      ).all(String(sessionId));
      for (const r of rows) this.q('UPDATE session_mentions SET delivered_at = ? WHERE id = ?').run(now, r.id);
      return rows.map((r) => ({ key: this.key(r.seq), title: r.title, text: r.text, at: r.at }));
    });
  }

  /**
   * Link a session to the ticket it was opened on (`SESSION_BOARD_TICKET`). From then on, its prompt hook
   * receives every new comment of that ticket (takeLinkedComments). The cursor starts at the ticket's last
   * event: what came before is the session's starting context. Linking again to the same ticket keeps the
   * cursor; another ticket replaces the link. Returns the ticket key, or null for an unknown ticket.
   */
  linkSession(sessionId, idOrKey, now = this.clock()) {
    if (!sessionId || !idOrKey) return null;
    const row = this.row(idOrKey);
    if (!row) return null;
    const cur = this.q('SELECT ticket_id FROM session_links WHERE session_id = ?').get(String(sessionId));
    if (cur?.ticket_id === row.id) return this.key(row.seq);
    const last = this.q('SELECT COALESCE(MAX(id), 0) AS id FROM ticket_events WHERE ticket_id = ?').get(row.id).id;
    this.q('INSERT OR REPLACE INTO session_links (session_id, ticket_id, cursor, linked_at) VALUES (?, ?, ?, ?)').run(String(sessionId), row.id, last, now);
    return this.key(row.seq);
  }

  /** The ticket a session is linked to, as a key, or null. */
  linkedTicket(sessionId) {
    const r = this.q('SELECT t.seq FROM session_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.session_id = ?').get(String(sessionId || ''));
    return r ? this.key(r.seq) : null;
  }

  /**
   * The comments posted on the session's linked ticket since it last asked, from every author except the
   * session's own actor (its own notes), and except those already delivered as an @session tag. Each is
   * delivered once: the cursor moves past what is returned. [{ key, title, actor, name, owner, text, at }],
   * `owner` true only for the board owner's comments (actor `user`).
   */
  takeLinkedComments(sessionId, now = this.clock(), limit = 50) {
    if (!sessionId) return [];
    const sid = String(sessionId);
    return this.tx(() => {
      const link = this.q('SELECT l.ticket_id, l.cursor, t.seq, t.title FROM session_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.session_id = ?').get(sid);
      if (!link) return [];
      const self = this.getSessionRec(sid)?.actor || null;
      const rows = this.q(
        `SELECT e.id, e.actor, e.text, e.at, a.name FROM ticket_events e LEFT JOIN actors a ON a.id = e.actor
         WHERE e.ticket_id = ? AND e.id > ? AND e.type = 'comment' ORDER BY e.id LIMIT ?`,
      ).all(link.ticket_id, link.cursor, limit);
      if (!rows.length) return [];
      this.q('UPDATE session_links SET cursor = ? WHERE session_id = ?').run(rows[rows.length - 1].id, sid);
      const tagged = new Set(this.q('SELECT event_id FROM session_mentions WHERE session_id = ? AND event_id IS NOT NULL').all(sid).map((r) => r.event_id));
      return rows
        .filter((r) => !tagged.has(r.id) && !(self && r.actor === self) && typeof r.text === 'string' && r.text.trim())
        .map((r) => ({ key: this.key(link.seq), title: link.title, actor: r.actor, name: r.name || null, owner: r.actor === 'user', text: r.text, at: r.at }));
    });
  }

  /** Sessions the owner can tag: seen in the last `withinMs`, not closed, newest first. */
  taggableSessions(now = this.clock(), withinMs = 30 * 60 * 1000) {
    return this.q("SELECT id, title, name, repo, branch, first_seen, last_seen, state FROM sessions WHERE last_seen >= ? AND COALESCE(state, '') != 'closed' ORDER BY last_seen DESC LIMIT 50")
      .all(now - withinMs)
      .map((s) => ({ handle: 'session/' + String(s.id).slice(0, 8).toLowerCase(), id: s.id, title: s.name || s.title || null, repo: s.repo, branch: s.branch, since: s.first_seen, last_seen: s.last_seen }));
  }

  /**
   * The owner spoke on a ticket: it leaves the owner's pile until someone hands it back. To the actor
   * the comment names (`to`, or the first known @mention), else to the default router of the
   * installation; without either, nothing moves. A ticket waiting on the owner goes back to To do.
   * Session tickets (kept by the hooks) and closed tickets stay where they are.
   */
  routeOwnerComment(row, text, actor, now, to) {
    if (actor !== 'user' || !row || CLOSED_STATUSES.includes(row.status) || row.source === 'hook' || row.kind === 'session') return null;
    const named = [normalizeActorId(to), ...mentionedIds(text)].find((id) => id && id !== 'user' && id !== 'hook' && this.q('SELECT 1 FROM actors WHERE id = ?').get(id));
    // A comment addressed to a session only (`@session/…`) goes to that session, not to the router.
    const toSession = !named && mentionedIds(text).some((id) => this.sessionByHandle(id));
    const target = named || (row.assignee === 'user' && !toSession ? this.defaultRouter : null);
    if (!target || (target === row.assignee && !['waiting_on_user', 'review', 'failed'].includes(row.status))) return null;
    const fields = { assignee: target };
    if (['waiting_on_user', 'review', 'failed'].includes(row.status)) fields.status = 'todo';
    if (row.snoozed_until) fields.snoozed_until = null;
    this.patchTicket(row, fields, actor, now, null);
    return target;
  }

  /** Mark a ticket read for one reader (the panel was opened). */
  markSeen(idOrKey, reader, now = this.clock()) {
    const row = this.row(idOrKey);
    if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
    const id = normalizeActorId(reader) || 'user';
    this.q('INSERT INTO ticket_seen (reader, ticket_id, at) VALUES (?, ?, ?) ON CONFLICT(reader, ticket_id) DO UPDATE SET at = MAX(at, excluded.at)').run(id, row.id, now);
    return { key: this.key(row.seq), seen_at: now };
  }

  /**
   * Tickets where someone answered this reader: the reader opened or commented on the ticket, the
   * last comment is someone else's, and it came after the reader's last comment and last visit.
   */
  unreadReplies(reader, { limit = 200 } = {}) {
    const id = normalizeActorId(reader) || 'user';
    return this.q(
      `SELECT t.seq, t.title, t.status, x.other_at AS at,
         (SELECT e.actor FROM ticket_events e WHERE e.ticket_id = t.id AND e.type = 'comment' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS by
       FROM (${UNREAD_SQL}) x JOIN tickets t ON t.id = x.ticket_id
       ORDER BY x.other_at DESC LIMIT ?`,
    )
      .all(id, id, id, limit)
      .map((r) => ({ key: this.key(r.seq), title: r.title, status: r.status, at: Number(r.at), by: r.by }));
  }

  /** One ticket with its history, children and session. */
  getTicket(idOrKey, now = this.clock()) {
    const row = this.row(idOrKey);
    if (!row) return null;
    const t = this.present(row, now);
    const evRows = this.q('SELECT id, at, actor, target, type, from_status, to_status, text FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(row.id);
    const pics = new Map();
    for (const a of this.q('SELECT id, event_id, mime, size, width, height, etag, name FROM ticket_attachments WHERE ticket_id = ? AND event_id IS NOT NULL ORDER BY id').all(row.id)) {
      if (!pics.has(a.event_id)) pics.set(a.event_id, []);
      pics.get(a.event_id).push({ id: Number(a.id), mime: a.mime, name: a.name || (a.mime.startsWith('image/') ? 'picture' : 'file'), size: Number(a.size), width: a.width, height: a.height, etag: a.etag });
    }
    t.events = evRows.map(({ id, ...e }) => (pics.has(id) ? { ...e, attachments: pics.get(id) } : { ...e }));
    t.children = this.q('SELECT * FROM tickets WHERE parent_id = ? ORDER BY seq').all(row.id).map((c) => this.present(c, now));
    // Every actor named in the history, so a client can say "CI bot → you" without another call.
    const ids = new Set([t.assignee, t.created_by, ...t.events.flatMap((e) => [e.actor, e.target])].filter(Boolean));
    t.actors = this.actorsById([...ids]);
    Object.assign(t, askView(t));
    t.roi = this.roiOf(row.id, now);
    return t;
  }

  actorsById(ids) {
    const out = {};
    for (const id of ids) {
      const a = this.q('SELECT id, type, name, parent FROM actors WHERE id = ?').get(id);
      out[id] = a ? { id: a.id, type: a.type, name: a.name || null, parent: a.parent } : { id, type: 'agent', name: null, parent: null };
    }
    return out;
  }

  deps(id) {
    const map = (r) => ({ key: this.key(r.seq), title: r.title, status: r.status });
    return {
      blocked_by: this.q('SELECT b.seq, b.title, b.status FROM ticket_deps d JOIN tickets b ON b.id = d.blocker_id WHERE d.blocked_id = ? ORDER BY b.seq').all(id).map(map),
      blocking: this.q('SELECT x.seq, x.title, x.status FROM ticket_deps d JOIN tickets x ON x.id = d.blocked_id WHERE d.blocker_id = ? ORDER BY x.seq').all(id).map(map),
    };
  }

  /** Row → API object (key, parsed JSON, session summary, stale flag). */
  present(row, now = this.clock()) {
    const s = row.session_id ? this.q('SELECT id, title, name, state, last_seen, url, rec FROM sessions WHERE id = ?').get(row.session_id) : null;
    const parent = row.parent_id ? this.q('SELECT seq, title FROM tickets WHERE id = ?').get(row.parent_id) : null;
    const counts = this.q(
      `SELECT (SELECT COUNT(*) FROM tickets c WHERE c.parent_id = ?) AS children, (SELECT COUNT(*) FROM tickets c WHERE c.parent_id = ? AND c.status NOT IN ${CLOSED_SQL}) AS children_open, (SELECT COUNT(*) FROM ticket_events e WHERE e.ticket_id = ? AND e.type = 'comment') AS comments`,
    ).get(row.id, row.id, row.id);
    const sessionRec = s ? parseJson(s.rec, null) : null;
    const stale = row.status === 'in_progress' && row.source === 'hook' && s && now - s.last_seen > STALE_MS;
    const { blocked_by, blocking } = this.deps(row.id);
    const openBlockers = blocked_by.filter((b) => !CLOSED_STATUSES.includes(b.status));
    return {
      id: row.id,
      key: this.key(row.seq),
      seq: row.seq,
      title: row.title,
      body: row.body,
      status: row.status,
      kind: row.kind,
      assignee: row.assignee,
      created_by: row.created_by || null,
      priority: row.priority,
      rank: row.rank ?? null,
      subtype: row.subtype || null,
      blocked: openBlockers.length > 0 && !CLOSED_STATUSES.includes(row.status),
      blocked_by,
      blocking,
      labels: parseJson(row.labels, []),
      links: parseJson(row.links, []),
      parent_id: row.parent_id,
      parent_key: parent ? this.key(parent.seq) : null,
      parent_title: parent?.title ?? null,
      session_id: row.session_id,
      session: s
        ? {
            id: s.id,
            title: s.name || s.title || null,
            activity: sessionRec ? sessionActivity(sessionRec, now) : s.state,
            last_seen: s.last_seen,
            url: s.url,
            thread: sessionRec?.thread || null,
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
      children_open: Number(counts.children_open),
      comments_count: Number(counts.comments),
      stale: Boolean(stale),
      snoozed_until: row.snoozed_until && row.snoozed_until > now ? row.snoozed_until : null,
      column: columnOf(row, now),
      hold: row.status === 'on_hold' ? this.holdView(row, now) : null,
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
    if (f.subtype) inList('t.subtype', f.subtype);
    if (f.created_by) inList('t.created_by', f.created_by);
    if (f.unread) {
      w.push(`t.id IN (SELECT ticket_id FROM (${UNREAD_SQL}))`);
      p.push(f.unread, f.unread, f.unread);
    }
    if (f.actor) {
      // An actor's tickets: the ones it holds and the ones it opened.
      const ph = f.actor.map(() => '?').join(', ');
      w.push(`(t.assignee IN (${ph}) OR t.created_by IN (${ph}))`);
      p.push(...f.actor, ...f.actor);
    }
    if (f.priority) {
      const real = f.priority.filter((x) => x !== 'none');
      const parts = [];
      if (real.length) {
        parts.push(`t.priority IN (${real.map(() => '?').join(', ')})`);
        p.push(...real);
      }
      if (f.priority.includes('none')) parts.push('t.priority IS NULL');
      w.push(parts.length ? `(${parts.join(' OR ')})` : '0');
    }
    if (f.blocked === true) w.push(BLOCKED_SQL);
    else if (f.blocked === false) w.push(`NOT ${BLOCKED_SQL}`);
    // The feedback inbox has its own view: feedback stays out of the board unless asked for by kind.
    if (!f.kind && !f.parent && !(f.q && /^\s*[A-Za-z]+-\d+\s*$/.test(f.q))) w.push("COALESCE(t.kind, 'action') <> 'feedback'");
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
      // A ticket key in the query finds that ticket too; so does the bare number (2617 for ALV-2617).
      const key = f.q.match(/^\s*(?:[A-Za-z]+-)?(\d+)\s*$/);
      if (key) {
        const last = w.pop();
        w.push(`(${last} OR t.seq = ?)`);
        p.push(Number(key[1]));
      }
    }
    const cutoff = now - ARCHIVE_AFTER_MS;
    const archived = `(t.status IN ('done', 'cancelled') AND t.closed_at IS NOT NULL AND t.closed_at < ${cutoff})`;
    // A ticket key typed in the search opens that ticket wherever it lives, archived or not.
    const byKey = !!(f.q && /^\s*(?:[A-Za-z]+-)?\d+\s*$/.test(f.q));
    if (f.archived === 'only') w.push(archived);
    else if (f.archived !== 'include' && !byKey) w.push(`NOT ${archived}`);
    return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
  }

  orderBy(sort) {
    if (sort === 'created') return 'ORDER BY t.created_at DESC, t.seq DESC';
    if (sort === 'priority') return `ORDER BY ${PRIORITY_RANK}, t.updated_at DESC`;
    if (sort === 'key') return 'ORDER BY t.seq DESC';
    if (sort === 'next') return NEXT_ORDER;
    return 'ORDER BY t.updated_at DESC, t.seq DESC';
  }

  /**
   * "What should be done now": open work (to do or in progress by default), not blocked, not a
   * session / question / feedback ticket, most important first (P0…P3, then none), then the manual
   * rank, then the oldest. Same filters as the list (repo, session, actor, assignee, label…).
   */
  nextTickets(f, now = this.clock()) {
    const status = f.status?.length ? f.status.filter((s) => OPEN_STATUSES.includes(s)) : ['todo', 'in_progress'];
    const kinds = f.kind ? undefined : NOT_WORK_KINDS;
    const { sql, params } = this.where({ ...f, status, blocked: false, sort: 'next' }, now);
    const and = sql ? `${sql} AND` : 'WHERE';
    const extra = kinds ? `t.kind NOT IN (${kinds.map(() => '?').join(', ')})` : '1';
    const p = [...params, ...(kinds || [])];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${and} ${extra}`).get(...p).n);
    const blockedCount = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${this.where({ ...f, status, blocked: true }, now).sql} AND ${extra}`).get(...this.where({ ...f, status, blocked: true }, now).params, ...(kinds || [])).n);
    const rows = this.db.prepare(`SELECT t.* FROM tickets t ${and} ${extra} ${NEXT_ORDER} LIMIT ? OFFSET ?`).all(...p, f.limit ?? 50, f.offset ?? 0);
    return { now, total, blocked: blockedCount, limit: f.limit ?? 50, offset: f.offset ?? 0, tickets: rows.map((r) => this.present(r, now)) };
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
    // A ticket he put off ("Later") sits in To do until its date, then comes back to his lane.
    const n = Number(now);
    const awake = `(t.snoozed_until IS NULL OR t.snoozed_until <= ${n})`;
    // His "to do" that ask a gesture of him (a decision, an action, a question) are in his lane too.
    const gesture = `(t.status = 'todo' AND t.assignee = 'user' AND COALESCE(t.source, '') <> 'hook' AND COALESCE(t.kind, 'action') IN (${GESTURE_KINDS.map((k) => `'${k}'`).join(', ')}))`;
    const col = {
      waiting: `((t.status IN ('waiting_on_user', 'review', 'failed') AND t.assignee = 'user') OR ${gesture}) AND ${awake}`,
      inProgress: `(t.status = 'in_progress' OR (t.status IN ('waiting_on_user', 'review', 'failed') AND t.assignee <> 'user'))`,
      todo: `((t.status = 'todo' AND NOT (${gesture} AND ${awake})) OR (t.status IN ('waiting_on_user', 'review', 'failed') AND t.assignee = 'user' AND t.snoozed_until > ${n}))`,
      done: `t.status IN ('done', 'cancelled')`,
      // 0.6.0: on hold, out of every lane (and of the lane order) until what it waits for happens.
      onHold: `t.status = 'on_hold'`,
    };
    // 0.5.17: a project is not a task; it leaves the open columns (it stays open) for the Projects view.
    // A project that waits on the owner (a wait, a review, a failure, a decision or a question) keeps its place in
    // their lane: a gesture is never hidden behind another page. The label is bound as a parameter (below).
    let projectParams = [];
    if (this.projectLabel) {
      const isProject = 'EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?)';
      col.waiting = `(${col.waiting}) AND NOT (${isProject} AND t.status = 'todo' AND COALESCE(t.kind, 'action') NOT IN ('decision', 'question'))`;
      for (const k of ['inProgress', 'todo']) col[k] = `(${col[k]}) AND NOT ${isProject}`;
      projectParams = [this.projectLabel];
    }
    const order = {
      // what the answer unblocks, most first, then priority, then the oldest wait (jobs waiting are added after the read)
      // 0.5.12: a fresh score posted by the installation comes first, highest first (lib/roi.mjs).
      waiting: `ORDER BY (r.score IS NOT NULL) DESC, r.score DESC, (COALESCE(u.n, 0) > 0) DESC, COALESCE(u.n, 0) DESC, ${PRIORITY_RANK}, t.status_at ASC, t.seq ASC`,
      inProgress: 'ORDER BY t.updated_at DESC',
      // Same order as "next": priority, manual rank (drag and drop), oldest first.
      todo: NEXT_ORDER,
      done: 'ORDER BY t.closed_at DESC',
      onHold: 'ORDER BY t.status_at ASC',
    };
    const columns = {};
    const counts = {};
    const allowed = f.status ? new Set(f.status) : null;
    for (const [name, cond] of Object.entries(col)) {
      let extra = '';
      const p = [...params, ...(name === 'done' || name === 'onHold' ? [] : projectParams)];
      if (allowed) {
        const st = [...allowed];
        extra = ` AND t.status IN (${st.map(() => '?').join(', ')})`;
        p.push(...st);
      }
      counts[name] = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tickets t ${and} ${cond}${extra}`).get(...p).n);
      const cap = name === 'done' ? doneShown : perColumn;
      if (name === 'waiting') {
        // One read: each ticket of his lane with what its answer unblocks (open tickets it blocks plus
        // open sub-tickets, grouped in the same statement), in order, capped like the other lanes.
        const rows = this.db
          .prepare(
            `SELECT t.*, COALESCE(u.n, 0) AS unlock_n, r.score AS roi_score, r.note AS roi_note FROM tickets t
               LEFT JOIN (SELECT id, COUNT(*) AS n FROM (
                 SELECT d.blocker_id AS id, x.id AS xid FROM ticket_deps d JOIN tickets x ON x.id = d.blocked_id WHERE x.status NOT IN ${CLOSED_SQL}
                 UNION SELECT c.parent_id, c.id FROM tickets c WHERE c.parent_id IS NOT NULL AND c.status NOT IN ${CLOSED_SQL}) GROUP BY id) u ON u.id = t.id
               LEFT JOIN ticket_roi r ON r.ticket_id = t.id AND r.at >= ${Math.trunc(n - this.roiTtlMs)}
               ${and} ${cond}${extra} ${order[name]} LIMIT ?`,
          )
          .all(...p, cap);
        const trusted = this.jobLabelTrust(rows.filter((r) => /blocks-jobs?\b/.test(r.labels || '')).map((r) => r.id));
        columns[name] = rows
          .map((r) => {
            const t = this.present(r, now);
            const labels = trusted.has(r.id) ? t.labels : [];
            const roi = r.roi_score === null || r.roi_score === undefined ? null : { score: Number(r.roi_score), note: r.roi_note ?? null };
            return { ...t, unlocks: Number(r.unlock_n) + jobsWaiting(labels), roi, ...askView(t) };
          })
          .sort(compareWaiting);
        continue;
      }
      columns[name] = this.db
        .prepare(`SELECT t.* FROM tickets t ${and} ${cond}${extra} ${order[name]} LIMIT ?`)
        .all(...p, cap)
        .map((r) => this.present(r, now));
    }
    const projects = this.projectList(now, f);
    return { now, counts, columns, roi_summary: this.roiSummary(now), project_label: this.projectLabel || null, projects };
  }

  /**
   * 0.5.17: the open projects (tickets carrying the project label), most recently touched first. For each:
   * its latest state (the last comment that opens with "État au" / "State as of" / "Status:", else the
   * last comment), the tickets attached to it (its sub-tickets, and tickets carrying `<label>-id:<slug>`
   * when the project carries the same), the jobs among them (created by a sub-actor of a job actor), and
   * the gestures awaited from the owner (the project itself when it waits on them, or an attached ticket in their lane).
   */
  projectList(now = this.clock(), f = {}, limit = 200) {
    const L = this.projectLabel;
    if (!L) return [];
    // The board's filters (search, repo, assignee…) narrow the projects too.
    const { sql, params } = this.where({ ...f, status: undefined }, now);
    const rows = this.q(
      `SELECT t.* FROM tickets t ${sql ? `${sql} AND` : 'WHERE'} t.status NOT IN ${CLOSED_SQL} AND EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?) ORDER BY t.updated_at DESC LIMIT ?`,
    ).all(...params, L, limit);
    const idPrefix = `${L}-id:`;
    const isJob = (r) => r.kind === 'job' || (r.created_by && (this.jobActors || []).some((id) => id && String(r.created_by).startsWith(id + '/')));
    const lite = (r) => ({ key: this.key(r.seq), title: r.title, status: r.status, priority: r.priority, kind: r.kind, assignee: r.assignee });
    return rows.map((r) => {
      const labels = parseJson(r.labels, []);
      const slug = labels.find((l) => typeof l === 'string' && l.startsWith(idPrefix))?.slice(idPrefix.length) || null;
      const attached = this.q(
        `SELECT t.* FROM tickets t WHERE t.id <> ? AND (t.parent_id = ? OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?))) ORDER BY t.updated_at DESC LIMIT 500`,
      ).all(r.id, r.id, slug, slug ? idPrefix + slug : null);
      const open = attached.filter((x) => !CLOSED_STATUSES.includes(x.status));
      const jobs = attached.filter(isJob);
      const comments = this.q(`SELECT at, actor, text FROM ticket_events WHERE ticket_id = ? AND type = 'comment' ORDER BY at DESC, id DESC LIMIT 50`).all(r.id);
      const st = comments.find((c) => PROJECT_STATE_RE.test(String(c.text || ''))) || comments[0] || null;
      const onOwner = (x) => columnOf(x, now) === 'waiting';
      // The project itself waits on the owner when it says so (a wait, a review, a failure, or a decision or
      // question to them), not because it is a plain "to do" in their name: a project is not a task.
      const projectAsks = onOwner(r) && (r.status !== 'todo' || ['decision', 'question'].includes(r.kind));
      const gestures = [...(projectAsks ? [r] : []), ...open.filter(onOwner)].slice(0, 5).map(lite);
      return {
        ...lite(r),
        slug,
        labels,
        updated_at: r.updated_at,
        state: st ? { at: st.at, actor: st.actor, text: String(st.text || '').slice(0, PROJECT_STATE_MAX), dated: PROJECT_STATE_RE.test(String(st.text || '')) } : null,
        tickets: { total: attached.length, open: open.length },
        jobs: { total: jobs.length, open: jobs.filter((x) => !CLOSED_STATUSES.includes(x.status)).length },
        gestures,
      };
    });
  }

  // ---- lane scores (0.5.12, lib/roi.mjs) ----------------------------------------------------------

  /** The lane line of a fresh snapshot: { text, at, actor }, or null (none posted, empty, or stale). */
  roiSummary(now = this.clock()) {
    const s = parseJson(this.db.prepare("SELECT value FROM meta WHERE key = 'roi_summary'").get()?.value, null);
    return s && s.text && roiFresh(s.at, now, this.roiTtlMs) ? { text: String(s.text), at: Number(s.at), actor: s.actor ?? null } : null;
  }

  /** The score of one ticket, when the snapshot is fresh: { score, note } or null. */
  roiOf(id, now = this.clock()) {
    const r = this.db.prepare('SELECT score, note, at FROM ticket_roi WHERE ticket_id = ?').get(id);
    return r && roiFresh(r.at, now, this.roiTtlMs) ? { score: Number(r.score), note: r.note ?? null } : null;
  }

  /**
   * Replace the whole snapshot (`input` checked by sanitizeRoiInput). Keys that name no ticket are
   * returned in `unknown`, never an error: a ticket may have been deleted between the agent's read and its post.
   * No ticket history is written: a score is a view the installation recomputes, not an edit of the ticket.
   */
  setRoi(input, { actor, now = this.clock() } = {}) {
    const { value, error } = sanitizeRoiInput(input);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    const unknown = [];
    let scored = 0;
    this.tx(() => {
      this.db.exec('DELETE FROM ticket_roi');
      const ins = this.db.prepare('INSERT OR REPLACE INTO ticket_roi (ticket_id, score, note, at) VALUES (?, ?, ?, ?)');
      for (const s of value.scores) {
        const row = this.row(s.key);
        if (!row) {
          unknown.push(s.key);
          continue;
        }
        ins.run(row.id, s.score, s.note, now);
        scored++;
      }
      const summary = value.summary ? JSON.stringify({ text: value.summary, at: now, actor: actor ?? null }) : null;
      if (summary) this.db.prepare("INSERT INTO meta(key, value) VALUES ('roi_summary', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(summary);
      else this.db.prepare("DELETE FROM meta WHERE key = 'roi_summary'").run();
      this.emit({ type: 'roi' });
    });
    return { ok: true, scored, unknown, summary: value.summary, at: now };
  }

  /** What GET /api/roi answers: the snapshot as stored, and whether it is still shown. */
  getRoi(now = this.clock()) {
    const raw = parseJson(this.db.prepare("SELECT value FROM meta WHERE key = 'roi_summary'").get()?.value, null);
    const rows = this.db.prepare('SELECT r.ticket_id, r.score, r.note, r.at, t.seq FROM ticket_roi r JOIN tickets t ON t.id = r.ticket_id ORDER BY r.score DESC').all();
    const at = rows[0]?.at ?? raw?.at ?? null;
    return {
      summary: raw?.text ?? null,
      actor: raw?.actor ?? null,
      at,
      stale: at === null ? false : !roiFresh(at, now, this.roiTtlMs),
      ttl_ms: this.roiTtlMs,
      scores: rows.map((r) => ({ key: this.key(r.seq), score: Number(r.score), note: r.note ?? null })),
    };
  }

  /**
   * Among these tickets, the ids whose labels were last set by someone who may say "a job waits on
   * this": a human, or an agent named in jobActors (BOARD_JOB_ACTORS). Any other writer's
   * `blocks-job` label is ignored.
   */
  jobLabelTrust(ids) {
    const out = new Set();
    if (!ids.length) return out;
    const last = new Map();
    const rows = this.db
      .prepare(`SELECT ticket_id, actor FROM ticket_events WHERE ticket_id IN (${ids.map(() => '?').join(', ')}) AND (type = 'created' OR (type = 'edit' AND text LIKE '%labels%')) ORDER BY id`)
      .all(...ids);
    for (const r of rows) last.set(r.ticket_id, r.actor);
    const humans = new Set(this.db.prepare("SELECT id FROM actors WHERE type = 'human'").all().map((a) => a.id));
    for (const [id, actor] of last) if (humans.has(actor) || trustedActor(actor, this.jobActors)) out.add(id);
    return out;
  }

  /**
   * One button of his lane: a structured comment from him, and a reversible move of the ticket
   * (status, assignee, or a date before which it does not come back). Returns the ticket and what
   * it was before, so a client can offer Undo.
   */
  answerTicket(idOrKey, { answer, choice, days, previous, expect } = {}, { actor = 'user', now = this.clock() } = {}) {
    return this.tx(() => {
      const row = this.row(idOrKey);
      if (!row) throw Object.assign(new Error('ticket not found'), { status: 404 });
      if (answer === 'undo') return this.undoAnswer(row, { previous, expect }, actor, now);
      const before = this.present(row, now);
      const plan = planAnswer(before, answer, answer === 'later' ? days : choice, { actor, now });
      if (plan.error) throw Object.assign(new Error(plan.error), { status: 400 });
      this.commentRow(row, plan.comment, actor, now);
      this.patchTicket(this.row(row.id), plan.fields, actor, now);
      const after = this.row(row.id);
      return {
        ticket: this.present(after, now),
        previous: { status: row.status, assignee: row.assignee, snoozed_until: row.snoozed_until ?? null },
        // what the ticket looks like right after the click: Undo only goes through while it is still so
        expect: { status: after.status, assignee: after.assignee, snoozed_until: after.snoozed_until ?? null, updated_at: after.updated_at },
      };
    });
  }

  /** Undo of a button: back to `previous`, but only when nobody has touched the ticket since (`expect`). */
  undoAnswer(row, { previous, expect }, actor, now) {
    const same = expect && row.status === expect.status && row.assignee === expect.assignee && (row.snoozed_until ?? null) === (expect.snoozed_until ?? null) && row.updated_at === expect.updated_at;
    if (!same) throw Object.assign(new Error('already taken over, nothing undone'), { status: 409 });
    const { value, error } = sanitizeTicketInput({ status: previous?.status, assignee: previous?.assignee, snoozed_until: previous?.snoozed_until ?? null }, { partial: true });
    if (error || !value.status || !value.assignee) throw Object.assign(new Error(error || 'previous state needed'), { status: 400 });
    this.commentRow(row, 'Previous answer withdrawn: the ticket is back in my lane.', actor, now);
    this.patchTicket(this.row(row.id), value, actor, now);
    return { ticket: this.present(this.row(row.id), now) };
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
    const feedback = this.db
      .prepare(`SELECT COALESCE(subtype, 'suggestion') AS value, COUNT(*) AS total, SUM(CASE WHEN ${open} THEN 1 ELSE 0 END) AS open FROM tickets WHERE kind = 'feedback' GROUP BY 1`)
      .all()
      .map((r) => ({ value: r.value, total: Number(r.total), open: Number(r.open) }));
    return {
      now,
      repos: group('repo'),
      branches: group('branch'),
      machines: group('machine'),
      kinds: group('kind'),
      labels,
      sessions,
      actors: this.listActors(),
      feedback: { open: feedback.reduce((n, x) => n + x.open, 0), total: feedback.reduce((n, x) => n + x.total, 0), types: feedback },
    };
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
    if (rec.thread) return truncate(rec.name || `Thread ${rec.thread}`, 200);
    return truncate(rec.name || rec.title || (where ? `Session in ${where}` : 'Claude Code session'), 200);
  }

  /** Who the session's agent is: SESSION_BOARD_ACTOR when set, else Claude. */
  sessionActor(rec) {
    return normalizeActorId(rec.actor) || 'claude';
  }

  /**
   * The ticket that follows a session's main thread. With SESSION_BOARD_THREAD, several sessions
   * share one: it is looked up by thread, whatever session last touched it.
   */
  sessionTicketOf(rec) {
    if (rec.thread) return this.q("SELECT * FROM tickets WHERE external_id = ? AND kind = 'session' ORDER BY seq DESC LIMIT 1").get('thread:' + rec.thread) ?? null;
    return this.findExternal(rec.sessionId, 'session');
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
    let t = this.sessionTicketOf(rec);
    if (!t) {
      const links = rec.url ? normalizeLinks([{ url: rec.url, type: 'session' }]) : [];
      return this.insertTicket(
        {
          title: this.sessionTitle(rec),
          status,
          kind: 'session',
          assignee: this.sessionActor(rec),
          created_by: this.sessionActor(rec),
          source: 'hook',
          external_id: rec.thread ? 'thread:' + rec.thread : 'session',
          links,
          ...this.ctxOf(rec),
        },
        'hook',
        at,
      );
    }
    // Keep the context and an auto title fresh (a user-edited title is never overwritten). A thread
    // ticket follows its latest session.
    const fields = { ...this.ctxOf(rec) };
    if (!rec.thread) delete fields.session_id;
    else if (rec.url) fields.links = normalizeLinks([...parseJson(t.links, []).filter((l) => l.type !== 'session'), { url: rec.url, type: 'session' }]);
    if (!t.title_locked) fields.title = this.sessionTitle(rec);
    return this.patchTicket(t, fields, 'hook', at);
  }

  /** SubagentStart / SubagentStop: a line in the session ticket's history, "Claude → Explore". */
  recordAgent(rec, agent, at) {
    const parent = this.sessionActor(rec);
    const sub = subagentActor(parent, agent.type);
    this.touchActor(sub, at);
    const s = this.ensureSessionTicket(rec, at, 'in_progress');
    if (agent.op === 'start') {
      this.addEvent(s.id, at, parent, 'agent', { text: 'started it', target: sub.id });
    } else {
      this.addEvent(s.id, at, sub.id, 'agent', { text: agent.detail ? `finished: ${agent.detail}` : 'finished', target: parent });
    }
    this.q('UPDATE tickets SET updated_at = ? WHERE id = ?').run(at, s.id);
    this.emit({ type: 'ticket', op: 'updated', id: s.id, key: this.key(s.seq), fields: ['history'] });
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
      // A task or subagent event says nothing about the session's state: only refresh its context.
      const sideEvent = t.task || t.agent;
      const identity = { ...evt.identity };
      // These are per-process settings: absent means off, never "keep the previous value".
      const rec = sideEvent && prev ? { ...prev, ...stripEmpty(identity), lastSeen: at } : applyTransition(prev, t, identity, at);
      for (const k of ['actor', 'actorName', 'thread', 'sessionTickets', 'stopStatus', 'ticket']) if (identity[k] === undefined) delete rec[k];
      this.saveSession(rec);
      if (rec.actor) this.touchActor({ id: rec.actor, type: 'agent', name: rec.actorName || null }, at);
      // A session opened on a ticket (SESSION_BOARD_TICKET): its new comments reach it at each prompt.
      if (evt.identity.ticket) this.linkSession(evt.identity.sessionId, evt.identity.ticket, at);

      // SESSION_BOARD_SESSION_TICKETS=0: the session is known (tickets created through MCP attach to
      // it), but the hooks open no ticket of their own.
      if (rec.sessionTickets === false) return rec;
      // A background task's report, and the turn it starts, leave the session ticket as it is.
      if (!sideEvent && quietTransition(prev, t)) return rec;
      if (t.agent) {
        this.recordAgent(rec, t.agent, at);
        return rec;
      }
      if (t.task) {
        this.mirrorTask(rec, t.task, at);
        return rec;
      }
      const agent = this.sessionActor(rec);
      switch (t.state) {
        case 'working': {
          this.closeWaits(rec, at, 'done', 'Answered, the session resumed');
          const s = this.ensureSessionTicket(rec, at, 'in_progress');
          if (s.status !== 'in_progress') {
            this.patchTicket(s, { status: 'in_progress', assignee: agent }, 'hook', at, t.prompt ? truncate(t.prompt, 200) : null);
          }
          break;
        }
        case 'waiting': {
          if (t.kind === 'idle') {
            // "Your turn" after a finished turn: the session ticket already says review. If the Stop was
            // missed, move an in-progress session ticket to review.
            const s = this.sessionTicketOf(rec);
            if (s && s.status === 'in_progress') {
              if (rec.stopStatus === 'done') this.patchTicket(s, { status: 'done' }, 'hook', at, t.detail || 'Turn finished');
              else this.patchTicket(s, { status: 'review', assignee: 'user' }, 'hook', at, t.detail || null);
            }
            break;
          }
          const kind = WAIT_KINDS.includes(t.kind) ? t.kind : 'question';
          const s = this.ensureSessionTicket(rec, at, 'in_progress');
          const generic = /^Claude (Code )?(needs your|is waiting for your)/i.test(t.detail || '');
          // A generic notification ("Claude is waiting for your input") is titled by the question it waits on.
          const byQuestion = generic && kind !== 'permission' && Boolean(t.asks);
          const title = waitTitle(kind, byQuestion ? t.asks : t.detail);
          const body = [t.detail || '', t.context || ''].filter(Boolean).join('\n\n');
          const open = this.openWaitTickets(rec.sessionId).find((w) => w.kind === kind);
          if (open) {
            if ((!generic || byQuestion) && open.title !== title) this.patchTicket(open, { title, body }, 'hook', at);
          } else {
            this.insertTicket(
              {
                title,
                body,
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
          // SESSION_BOARD_STOP_STATUS=done: the turn's output is reviewed elsewhere (a chat, a CI log).
          // The ticket closes and stays in the history and the actor filter; the next turn reopens it.
          const stop = rec.stopStatus === 'done' ? 'done' : 'review';
          const s = this.ensureSessionTicket(rec, at, stop);
          const links = normalizeLinks([...parseJson(s.links, []), ...(t.pr ? [{ url: t.pr, type: 'pr' }] : [])]);
          const assignee = stop === 'done' ? agent : 'user';
          // A turn that ends on a question waits on its human (the question leads the body); one that only
          // reports is review. SESSION_BOARD_STOP_STATUS=done still closes: the answer lives elsewhere.
          if (t.asks && stop === 'review') {
            const body = `❓ ${t.asks}${t.detail ? `\n\n${t.detail}` : ''}`;
            this.patchTicket(s, { status: 'waiting_on_user', assignee: 'user', body, links }, 'hook', at, `Asks: ${t.asks}`);
            break;
          }
          this.patchTicket(s, { status: stop, assignee, body: t.detail || s.body, links }, 'hook', at, stop === 'done' && s.status !== 'done' ? 'Turn finished' : null);
          break;
        }
        case 'failed': {
          const s = this.ensureSessionTicket(rec, at, 'failed');
          this.patchTicket(s, { status: 'failed', assignee: 'user', body: t.detail || s.body }, 'hook', at, t.detail || 'The turn failed');
          break;
        }
        case 'closed': {
          this.closeWaits(rec, at + 1, 'cancelled', 'The session ended');
          // A thread outlives its sessions: the next one picks the same ticket up.
          if (rec.thread) break;
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
    const parent = this.sessionTicketOf(rec);
    const agent = this.sessionActor(rec);
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
          assignee: agent,
          source: 'claude',
          external_id: task.id ? 'task:' + task.id : 'task-title:' + slug,
          parent_id: parent?.id ?? null,
          ...this.ctxOf(rec),
        },
        agent,
        at,
      );
      return;
    }
    if (existing) {
      if (existing.status !== 'done') this.patchTicket(existing, { status: 'done' }, agent, at, 'Task completed');
      return;
    }
    this.insertTicket(
      {
        title: task.title || `Task ${task.id}`,
        status: 'done',
        kind: 'task',
        assignee: agent,
        source: 'claude',
        external_id: task.id ? 'task:' + task.id : 'task-title:' + slug,
        parent_id: parent?.id ?? null,
        ...this.ctxOf(rec),
      },
      agent,
      at,
    );
  }

  /** Legacy `POST /api/dismiss {sessionId}`: the session's review ticket is done. */
  dismissSession(sessionId, now = this.clock(), actor = 'user') {
    return this.tx(() => {
      const rec = this.getSessionRec(sessionId);
      if (!rec) return false;
      rec.dismissed = true;
      this.saveSession(rec);
      const s = this.findExternal(sessionId, 'session');
      if (s && ['review', 'failed'].includes(s.status)) this.patchTicket(s, { status: 'done' }, actor, now, 'Dismissed');
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
        // An idle "your turn" asks nothing: it is a finished turn (review), never a question ticket
        // titled "Claude is waiting for your input" with nothing to say what it waits on.
        const status = rec.state === 'waiting' && rec.kind === 'idle' ? map.review : map[rec.state];
        if (!status) continue;
        if (status === 'waiting_on_user') {
          const s = this.ensureSessionTicket(rec, at, 'in_progress');
          const kind = WAIT_KINDS.includes(rec.kind) ? rec.kind : 'question';
          this.insertTicket(
            { title: waitTitle(kind, rec.detail), body: redactSecrets(rec.detail || ''), status, kind, assignee: 'user', source: 'hook', external_id: 'wait:' + kind, parent_id: s.id, ...this.ctxOf(rec) },
            'hook',
            at,
          );
        } else {
          const s = this.ensureSessionTicket(rec, at, status);
          const links = normalizeLinks([...(rec.url ? [{ url: rec.url, type: 'session' }] : []), ...(rec.pr ? [{ url: rec.pr, type: 'pr' }] : [])]);
          this.patchTicket(s, { body: rec.detail || '', links, assignee: ['review', 'failed'].includes(status) ? 'user' : this.sessionActor(rec) }, 'hook', at);
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

  /** This board's id for imports elsewhere (random, created on first use, kept in meta). */
  boardId() {
    const row = this.q("SELECT value FROM meta WHERE key = 'board_id'").get();
    if (row) return row.value;
    const id = 'b_' + randomBytes(8).toString('hex');
    this.q("INSERT INTO meta(key, value) VALUES ('board_id', ?)").run(id);
    return id;
  }

  /** Everything `importTickets` needs, parents before children. */
  exportForImport() {
    const sessions = this.q('SELECT * FROM sessions ORDER BY first_seen').all().map((s) => ({ ...s, rec: parseJson(s.rec, null) }));
    const rows = this.q('SELECT * FROM tickets ORDER BY seq').all().map((r) => ({ ...r }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = [];
    const seen = new Set();
    const visit = (r, depth = 0) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      const p = r.parent_id && byId.get(r.parent_id);
      if (p && depth < 50) visit(p, depth + 1);
      out.push({
        ...r,
        labels: parseJson(r.labels, []),
        links: parseJson(r.links, []),
        events: this.q('SELECT at, actor, target, type, from_status, to_status, text FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(r.id).map((e) => ({ ...e })),
        blocked_by: this.q('SELECT blocker_id FROM ticket_deps WHERE blocked_id = ?').all(r.id).map((d) => d.blocker_id),
      });
    };
    for (const r of rows) visit(r);
    return { sessions, tickets: out };
  }

  /**
   * Tickets of another board (a machine's local board.db) brought into this one: POST /api/import.
   * Idempotent: each ticket is recorded under `origin` = `<board id>:<ticket id>`, and a second
   * import of the same origin is skipped. A hook ticket this board already follows itself (same
   * session, same role) is not copied again. Keys are renumbered (ALV-3 there may be ALV-57 here);
   * dates, statuses, labels, links, parent links and the whole history are kept.
   * Parents must come before their children (the client sends them in that order).
   */
  importTickets({ board, machine, sessions = [], tickets = [] } = {}, { now = this.clock() } = {}) {
    if (typeof board !== 'string' || !/^[\w-]{6,64}$/.test(board)) throw Object.assign(new Error('bad board id'), { status: 400 });
    const from = truncate(String(machine || ''), 120) || 'another machine';
    const results = [];
    const num = (v, fallback) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);
    const str = (v, max) => (typeof v === 'string' && v ? truncate(v, max) : null);
    return this.tx(() => {
      let newSessions = 0;
      for (const s of Array.isArray(sessions) ? sessions : []) {
        if (!s || typeof s.id !== 'string' || !/^[\w.:-]{1,128}$/.test(s.id)) continue;
        if (this.q('SELECT 1 FROM sessions WHERE id = ?').get(s.id)) continue;
        const rec = s.rec && typeof s.rec === 'object' ? s.rec : { sessionId: s.id };
        this.q(
          `INSERT INTO sessions (id, title, name, repo, branch, cwd, machine, origin, url, state, detail, first_seen, last_seen, rec)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          s.id,
          str(s.title, 200),
          str(s.name, 200),
          str(s.repo, 200),
          str(s.branch, 200),
          str(s.cwd, 300),
          str(s.machine, 120),
          s.origin === 'cloud' ? 'cloud' : 'terminal',
          typeof s.url === 'string' && /^https:\/\//.test(s.url) ? truncate(s.url, 500) : null,
          str(s.state, 20),
          str(s.detail, 500),
          num(s.first_seen, num(s.last_seen, now)),
          num(s.last_seen, now),
          JSON.stringify({ ...rec, sessionId: s.id }),
        );
        newSessions++;
      }
      for (const t of Array.isArray(tickets) ? tickets : []) {
        const localId = typeof t?.id === 'string' && /^[\w-]{1,64}$/.test(t.id) ? t.id : null;
        if (!localId) {
          results.push({ id: null, status: 'invalid' });
          continue;
        }
        const origin = `${board}:${localId}`;
        const known = this.q('SELECT ticket_id FROM ticket_imports WHERE origin = ?').get(origin);
        if (known) {
          const row = this.row(known.ticket_id);
          results.push({ id: localId, status: 'skipped', key: row ? this.key(row.seq) : null });
          continue;
        }
        const title = str(t.title, 200);
        if (!title) {
          results.push({ id: localId, status: 'invalid' });
          continue;
        }
        const sessionId = typeof t.session_id === 'string' && /^[\w.:-]{1,128}$/.test(t.session_id) ? t.session_id : null;
        // The server follows its sessions through the hook events: never a second session or wait ticket.
        if (t.source === 'hook' && sessionId && typeof t.external_id === 'string') {
          const same = this.findExternal(sessionId, t.external_id);
          if (same) {
            this.q('INSERT INTO ticket_imports (origin, ticket_id, at) VALUES (?, ?, ?)').run(origin, same.id, now);
            results.push({ id: localId, status: 'duplicate', key: this.key(same.seq) });
            continue;
          }
        }
        const parentOrigin = typeof t.parent_id === 'string' ? `${board}:${t.parent_id}` : null;
        const parentId = parentOrigin ? (this.q('SELECT ticket_id FROM ticket_imports WHERE origin = ?').get(parentOrigin)?.ticket_id ?? null) : null;
        const id = /^t_[0-9a-f]{16}$/.test(localId) && !this.q('SELECT 1 FROM tickets WHERE id = ?').get(localId) ? localId : newId();
        const seq = this.nextSeq();
        const status = STATUSES.includes(t.status) ? t.status : 'todo';
        const created = num(t.created_at, now);
        const updated = Math.max(num(t.updated_at, created), created);
        const kind = typeof t.kind === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(t.kind) ? t.kind : 'action';
        this.q(
          `INSERT INTO tickets (id, seq, title, body, status, kind, assignee, priority, labels, parent_id, links,
             session_id, repo, branch, cwd, machine, origin, source, external_id, title_locked,
             created_at, updated_at, status_at, closed_at, rank, created_by, subtype)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          seq,
          title,
          typeof t.body === 'string' ? keepAtImport(t.body, MAX_BODY_CHARS) : '',
          status,
          kind,
          normalizeActorId(t.assignee) || 'user',
          normalizePriority(t.priority) || null,
          JSON.stringify(normalizeLabels(asList(t.labels))),
          parentId,
          JSON.stringify(normalizeLinks(asList(t.links))),
          sessionId,
          str(t.repo, 200),
          str(t.branch, 200),
          str(t.cwd, 300),
          str(t.machine, 120),
          t.origin === 'cloud' ? 'cloud' : 'terminal',
          SOURCES.includes(t.source) ? t.source : 'user',
          str(t.external_id, 120),
          t.title_locked ? 1 : 0,
          created,
          updated,
          num(t.status_at, updated),
          CLOSED_STATUSES.includes(status) ? num(t.closed_at, updated) : null,
          Number.isFinite(t.rank) ? t.rank : null,
          normalizeActorId(t.created_by) || (t.source === 'hook' ? 'hook' : t.source === 'claude' ? 'claude' : 'user'),
          typeof t.subtype === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(t.subtype) ? t.subtype : null,
        );
        for (const e of (Array.isArray(t.events) ? t.events : []).slice(0, 2000)) {
          if (!e || typeof e.type !== 'string' || !/^[a-z_]{1,20}$/.test(e.type)) continue;
          this.addEvent(id, num(e.at, created), normalizeActorId(e.actor) || 'user', e.type, {
            target: normalizeActorId(e.target) || null,
            from: STATUSES.includes(e.from_status) ? e.from_status : null,
            to: STATUSES.includes(e.to_status) ? e.to_status : null,
            text: typeof e.text === 'string' ? keepAtImport(e.text, MAX_COMMENT_CHARS) : null,
          });
        }
        const was = Number.isInteger(t.seq) ? ` (was ${this.key(t.seq)} there)` : '';
        this.addEvent(id, now, 'user', 'note', { text: `Imported from the local board of ${from}${was}` });
        this.q('INSERT INTO ticket_imports (origin, ticket_id, at) VALUES (?, ?, ?)').run(origin, id, now);
        this.reindex(id);
        results.push({ id: localId, status: 'imported', key: this.key(seq) });
      }
      // Dependencies, once every ticket of the batch has its id here.
      const local = (lid) => (typeof lid === 'string' ? (this.q('SELECT ticket_id FROM ticket_imports WHERE origin = ?').get(`${board}:${lid}`)?.ticket_id ?? null) : null);
      for (const t of Array.isArray(tickets) ? tickets : []) {
        const blocked = local(t?.id);
        if (!blocked || !Array.isArray(t.blocked_by)) continue;
        for (const lid of t.blocked_by.slice(0, 50)) {
          const blocker = local(lid);
          if (blocker && !this.wouldCycle(blocker, blocked)) this.q('INSERT OR IGNORE INTO ticket_deps (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(blocker, blocked, now);
        }
      }
      const count = (s) => results.filter((r) => r.status === s).length;
      return { imported: count('imported'), skipped: count('skipped'), duplicate: count('duplicate'), invalid: count('invalid'), sessions: newSessions, results };
    });
  }

  /** Remove a session and the tickets attached to it (with their history). Sub-tickets elsewhere are detached. */
  deleteSession(sessionId) {
    return this.tx(() => {
      const ids = this.q('SELECT id FROM tickets WHERE session_id = ?').all(sessionId).map((r) => r.id);
      for (const id of ids) {
        this.q('UPDATE tickets SET parent_id = NULL WHERE parent_id = ?').run(id);
        this.q('DELETE FROM ticket_events WHERE ticket_id = ?').run(id);
        this.q('DELETE FROM ticket_attachments WHERE ticket_id = ?').run(id);
        this.q('DELETE FROM ticket_imports WHERE ticket_id = ?').run(id);
        this.q('DELETE FROM ticket_deps WHERE blocker_id = ? OR blocked_id = ?').run(id, id);
        if (this.fts) this.q('DELETE FROM tickets_fts WHERE ticket_id = ?').run(id);
        this.q('DELETE FROM tickets WHERE id = ?').run(id);
      }
      const session = Number(this.q('DELETE FROM sessions WHERE id = ?').run(sessionId).changes);
      if (ids.length || session) this.emit({ type: 'session', op: 'deleted', id: sessionId });
      return { session, tickets: ids.length };
    });
  }

  counts() {
    return {
      sessions: Number(this.q('SELECT COUNT(*) AS n FROM sessions').get().n),
      tickets: Number(this.q('SELECT COUNT(*) AS n FROM tickets').get().n),
      events: Number(this.q('SELECT COUNT(*) AS n FROM ticket_events').get().n),
    };
  }
}

/** A list sent as an array, or kept as JSON text in a database column. */
function asList(v) {
  if (Array.isArray(v)) return v;
  const parsed = typeof v === 'string' ? parseJson(v, []) : [];
  return Array.isArray(parsed) ? parsed : [];
}

function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

export function waitTitle(kind, detail) {
  const d = redactSecrets(String(detail || '')).trim();
  if (kind === 'permission') {
    const body = d.replace(/^Permission:\s*/i, '');
    return truncate(body ? `Approve ${body}` : 'Approve a tool call', 200);
  }
  return truncate(d || 'Claude has a question', 200);
}
