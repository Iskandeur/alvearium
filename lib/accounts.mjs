// Accounts: named humans with a role, their personal tokens, and an audit log. Server only.
//
// Roles (checked by the server on every route, see `can`):
//   owner   everything. Exactly one, the actor `user`: whoever holds the server token
//           (SESSION_BOARD_TOKEN). Ownership moves by giving someone that token, never by API.
//   admin   everything except touching the owner: members, invitations, tokens, imports, deletions.
//   member  create, comment on and change tickets; its own name, picture and tokens.
//   viewer  read only; its own name, picture and tokens.
//   agent   an agent token (0.3.7): reads and writes tickets as its actor or a sub-actor, nothing else.
//
// Tokens are random (32 bytes), shown once, stored as SHA-256 only. `api` tokens are for the CLI and
// the plugin (Bearer); `session` tokens live in an httpOnly cookie for the page, with a CSRF token.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeActorId } from './core.mjs';

export const ROLES = ['owner', 'admin', 'member', 'viewer'];
/** Roles a member can be given (owner is the server token, never granted). */
export const GRANTABLE_ROLES = ['admin', 'member', 'viewer'];
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;
export const OWNER_ID = 'user';

const VERBS = {
  owner: ['read', 'write', 'import', 'deleteSession', 'manageMembers', 'editAnyActor', 'audit', 'ownTokens'],
  admin: ['read', 'write', 'import', 'deleteSession', 'manageMembers', 'editAnyActor', 'audit', 'ownTokens'],
  member: ['read', 'write', 'ownTokens'],
  viewer: ['read', 'ownTokens'],
  agent: ['read', 'write'],
};

/** May this caller do `verb`? `auth.role` is one of ROLES or `agent`. */
export function can(auth, verb) {
  return !!auth && (VERBS[auth.role] || []).includes(verb);
}

export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newSecret = (prefix) => prefix + randomBytes(32).toString('base64url');

const fail = (status, message) => Object.assign(new Error(message), { status });

/** A person's display name: 1–60 visible characters, never one that reads as someone else. */
export function cleanMemberName(v) {
  const n = String(v ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (!n) throw fail(400, 'a name is required');
  if (n.length > 60) throw fail(400, 'a name has at most 60 characters');
  if (/^(you|user|owner|admin|claude|hook|system)$/i.test(n)) throw fail(400, `"${n}" is reserved`);
  return n;
}

export class Accounts {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.migrate();
  }

  q(sql) {
    return this.store.q(sql);
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        name TEXT,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        revoked_at INTEGER,
        revoked_by TEXT
      );
      CREATE TABLE IF NOT EXISTS member_tokens (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        label TEXT,
        csrf TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS member_tokens_member ON member_tokens(member_id);
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        note TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER, used_by TEXT,
        revoked_at INTEGER, revoked_by TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
    `);
    // The owner exists on every board, old or new: it is the `user` of the whole history.
    this.q('INSERT OR IGNORE INTO members (id, name, role, created_at) VALUES (?, NULL, ?, ?)').run(OWNER_ID, 'owner', this.store.clock());
  }

  now() {
    return this.store.clock();
  }

  audit(actor, action, target = null, detail = null) {
    this.q('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(this.now(), actor, action, target, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  listAudit(limit = 200) {
    return this.q('SELECT at, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, Number(limit) || 200), 1000));
  }

  // ---- members ---------------------------------------------------------------------------------

  getMember(id) {
    const m = this.q('SELECT * FROM members WHERE id = ?').get(String(id ?? ''));
    return m ? { ...m } : null;
  }

  /** An active human: a member that exists and is not revoked. */
  isHuman(id) {
    const m = this.getMember(id);
    return !!m && !m.revoked_at;
  }

  displayName(id) {
    const a = this.store.getActor(id);
    return a?.name || null;
  }

  listMembers({ withTokens = false } = {}) {
    const rows = this.q('SELECT * FROM members ORDER BY (role = \'owner\') DESC, revoked_at IS NOT NULL, created_at').all();
    return rows.map((m) => {
      const out = { id: m.id, name: this.displayName(m.id), role: m.role, created_at: m.created_at, created_by: m.created_by, revoked_at: m.revoked_at };
      if (withTokens) {
        const t = this.q('SELECT COUNT(*) AS n, MAX(last_used_at) AS last FROM member_tokens WHERE member_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)').get(m.id, this.now());
        out.tokens = Number(t.n);
        out.last_used_at = t.last ?? null;
      }
      return out;
    });
  }

  activeHumans() {
    return Number(this.q('SELECT COUNT(*) AS n FROM members WHERE revoked_at IS NULL').get().n);
  }

  /** A name nobody else active carries (case-insensitive): a name never impersonates. */
  assertNameFree(name, exceptId = null) {
    for (const m of this.q('SELECT id FROM members WHERE revoked_at IS NULL').all()) {
      if (m.id === exceptId) continue;
      const other = this.displayName(m.id);
      if (other && other.toLowerCase() === name.toLowerCase()) throw fail(409, `"${name}" is already someone's name`);
    }
  }

  createMember({ name, role }, by) {
    if (!GRANTABLE_ROLES.includes(role)) throw fail(400, `role must be one of ${GRANTABLE_ROLES.join(', ')}`);
    const n = cleanMemberName(name);
    return this.store.tx(() => {
      this.assertNameFree(n);
      const id = 'h-' + randomBytes(5).toString('hex');
      const at = this.now();
      this.q('INSERT INTO members (id, name, role, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(id, n, role, at, by);
      this.store.touchActor({ id, type: 'human', name: n }, at);
      this.q('UPDATE actors SET type = \'human\', name = ? WHERE id = ?').run(n, id);
      this.audit(by, 'member.create', id, { name: n, role });
      this.store.emit({ type: 'actor', id, fields: ['member'] });
      return this.getMember(id);
    });
  }

  renameMember(id, name, by) {
    const m = this.getMember(id);
    if (!m || m.revoked_at) throw fail(404, 'member not found');
    const n = cleanMemberName(name);
    this.assertNameFree(n, id);
    this.q('UPDATE members SET name = ? WHERE id = ?').run(n, id);
    this.q('UPDATE actors SET name = ?, type = \'human\' WHERE id = ?').run(n, id);
    this.audit(by, 'member.rename', id, { name: n });
    this.store.emit({ type: 'actor', id, fields: ['name'] });
    return { ...this.getMember(id), name: n };
  }

  setRole(id, role, by) {
    if (!GRANTABLE_ROLES.includes(role)) throw fail(400, `role must be one of ${GRANTABLE_ROLES.join(', ')}`);
    const m = this.getMember(id);
    if (!m || m.revoked_at) throw fail(404, 'member not found');
    if (m.role === 'owner') throw fail(403, 'the owner keeps its role');
    this.q('UPDATE members SET role = ? WHERE id = ?').run(role, id);
    this.audit(by, 'member.role', id, { from: m.role, to: role });
    this.store.emit({ type: 'actor', id, fields: ['role'] });
    return this.getMember(id);
  }

  /** Revoke a member: every token and session dies with it, now. */
  revokeMember(id, by) {
    const m = this.getMember(id);
    if (!m || m.revoked_at) throw fail(404, 'member not found');
    if (m.role === 'owner') throw fail(403, 'the owner cannot be revoked');
    const at = this.now();
    this.store.tx(() => {
      this.q('UPDATE members SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(at, by, id);
      this.q('UPDATE member_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, id);
      this.audit(by, 'member.revoke', id, { role: m.role });
    });
    this.store.emit({ type: 'actor', id, fields: ['revoked'] });
    return this.getMember(id);
  }

  // ---- invitations -----------------------------------------------------------------------------

  /** A one-time link: the secret is returned once, only its hash is kept. */
  createInvite({ role = 'member', days = INVITE_DEFAULT_DAYS, note = null } = {}, by) {
    if (!GRANTABLE_ROLES.includes(role)) throw fail(400, `role must be one of ${GRANTABLE_ROLES.join(', ')}`);
    const d = Number(days);
    if (!Number.isFinite(d) || d < 1 / 24 || d > INVITE_MAX_DAYS) throw fail(400, `an invitation lasts from 1 hour to ${INVITE_MAX_DAYS} days`);
    const secret = newSecret('alvi_');
    const id = 'inv_' + randomBytes(6).toString('hex');
    const at = this.now();
    const expires = at + Math.round(d * 24 * 3600 * 1000);
    const n = note == null ? null : String(note).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || null;
    this.q('INSERT INTO invites (id, hash, role, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, hashToken(secret), role, n, by, at, expires);
    this.audit(by, 'invite.create', id, { role, expires_at: expires, note: n });
    return { id, token: secret, role, note: n, expires_at: expires };
  }

  inviteStatus(row, now = this.now()) {
    if (row.used_at) return 'used';
    if (row.revoked_at) return 'revoked';
    if (row.expires_at <= now) return 'expired';
    return 'pending';
  }

  listInvites() {
    const now = this.now();
    return this.q('SELECT id, role, note, created_by, created_at, expires_at, used_at, used_by, revoked_at, revoked_by FROM invites ORDER BY created_at DESC LIMIT 100')
      .all()
      .map((r) => ({ ...r, status: this.inviteStatus(r, now) }));
  }

  revokeInvite(id, by) {
    const r = this.q('SELECT * FROM invites WHERE id = ?').get(String(id ?? ''));
    if (!r || this.inviteStatus(r) !== 'pending') return null;
    this.q('UPDATE invites SET revoked_at = ?, revoked_by = ? WHERE id = ?').run(this.now(), by, r.id);
    this.audit(by, 'invite.revoke', r.id, { role: r.role });
    return r.id;
  }

  /** The invitation behind a secret, if it can still be accepted; else throws 410 (or 404). */
  usableInvite(secret) {
    if (typeof secret !== 'string' || !/^alvi_[\w-]{20,80}$/.test(secret)) throw fail(404, 'invalid invitation');
    const r = this.q('SELECT * FROM invites WHERE hash = ?').get(hashToken(secret));
    if (!r) throw fail(404, 'invalid invitation');
    const st = this.inviteStatus(r);
    if (st !== 'pending') throw fail(410, `this invitation was ${st === 'used' ? 'already used' : st}`);
    return r;
  }

  /** What the invitee sees before choosing a name. */
  previewInvite(secret) {
    const r = this.usableInvite(secret);
    return { role: r.role, expires_at: r.expires_at, invited_by: this.displayName(r.created_by) || (r.created_by === OWNER_ID ? 'the owner' : null) };
  }

  /**
   * Accept: one transaction marks the invitation used and creates the member, so two browsers
   * racing on one link end with one member. Returns the member, an API token and a page session.
   */
  acceptInvite(secret, name) {
    const n = cleanMemberName(name);
    return this.store.tx(() => {
      const r = this.usableInvite(secret);
      const member = this.createMember({ name: n, role: r.role }, r.created_by);
      const used = this.q('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(this.now(), member.id, r.id);
      if (Number(used.changes) !== 1) throw fail(410, 'this invitation was already used');
      this.audit(member.id, 'invite.accept', r.id, { by: r.created_by, role: r.role });
      const api = this.issueToken(member.id, { kind: 'api', label: 'from invitation' }, member.id);
      const session = this.issueToken(member.id, { kind: 'session', ttlMs: SESSION_TTL_MS }, member.id);
      return { member: { id: member.id, name: n, role: r.role }, api, session };
    });
  }

  // ---- tokens ----------------------------------------------------------------------------------

  /** A new token for a member; the secret is returned once and only its hash is kept. */
  issueToken(memberId, { kind = 'api', label = null, ttlMs = null } = {}, by = memberId) {
    const m = this.getMember(memberId);
    if (!m || m.revoked_at) throw fail(404, 'member not found');
    if (kind !== 'api' && kind !== 'session') throw fail(400, 'bad token kind');
    const secret = newSecret(kind === 'session' ? 'alvs_' : 'alvm_');
    const id = 'tk_' + randomBytes(6).toString('hex');
    const at = this.now();
    const csrf = kind === 'session' ? randomBytes(24).toString('base64url') : null;
    const lbl = label == null ? null : String(label).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || null;
    this.q('INSERT INTO member_tokens (id, member_id, hash, kind, label, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, memberId, hashToken(secret), kind, lbl, csrf, at, ttlMs ? at + ttlMs : null);
    if (kind === 'api') this.audit(by, 'token.create', memberId, { id, label: lbl });
    return { id, token: secret, kind, label: lbl, csrf, expires_at: ttlMs ? at + ttlMs : null };
  }

  /**
   * The member behind a secret, or null: unknown, revoked, expired, or its member revoked.
   * `kind` restricts the token kind (the cookie only accepts session tokens).
   */
  lookup(secret, kind = null) {
    if (typeof secret !== 'string' || secret.length < 24 || secret.length > 200) return null;
    const row = this.q(
      `SELECT t.id, t.member_id, t.kind, t.csrf, t.expires_at, t.revoked_at, t.last_used_at, m.role, m.revoked_at AS m_revoked
       FROM member_tokens t JOIN members m ON m.id = t.member_id WHERE t.hash = ?`,
    ).get(hashToken(secret));
    if (!row || row.revoked_at || row.m_revoked) return null;
    if (kind && row.kind !== kind) return null;
    const now = this.now();
    if (row.expires_at && row.expires_at <= now) return null;
    // Write the last use at most once a minute: a busy page should not write on every request.
    if (!row.last_used_at || now - row.last_used_at > 60000) this.q('UPDATE member_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
    return { tokenId: row.id, member: row.member_id, role: row.role, tokenKind: row.kind, csrf: row.csrf };
  }

  csrfOk(expected, given) {
    if (!expected || typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  listTokens(memberId) {
    return this.q('SELECT id, kind, label, created_at, last_used_at, expires_at FROM member_tokens WHERE member_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC').all(memberId, this.now());
  }

  getToken(id) {
    return this.q('SELECT id, member_id, kind, revoked_at FROM member_tokens WHERE id = ?').get(String(id ?? '')) ?? null;
  }

  revokeToken(id, by) {
    const t = this.getToken(id);
    if (!t || t.revoked_at) return null;
    this.q('UPDATE member_tokens SET revoked_at = ? WHERE id = ?').run(this.now(), id);
    if (t.kind === 'api') this.audit(by, 'token.revoke', t.member_id, { id });
    return t;
  }
}

/** The member id a header may name: `user`, a known human, or null for an agent id. */
export function humanIdOf(accounts, id) {
  const a = normalizeActorId(id);
  return a && accounts.getMember(a) ? a : null;
}
