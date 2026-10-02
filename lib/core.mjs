// session-board — pure logic shared by the hook, the CLI, the statusline and the server.
// Zero dependencies, no I/O in this file: everything here is unit-tested.

export const STATES = ['waiting', 'failed', 'working', 'stale', 'review', 'idle', 'closed'];

/** A `working` session with no heartbeat for this long is displayed as `stale`. */
export const STALE_MS = 30 * 60 * 1000;
/** At most one `working` heartbeat per session per this window (state changes always go out). */
export const THROTTLE_MS = 20 * 1000;
/** Closed sessions stay visible this long, then the server/local store drops them. */
export const CLOSED_TTL_MS = 2 * 60 * 60 * 1000;
/** Any session silent for this long is dropped. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_prompt',
  'agent_needs_input',
]);
const DONE_NOTIFICATIONS = new Set(['agent_completed']);

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Last GitHub / GitLab pull-request URL mentioned in a text, if any. */
export function findPrUrl(text) {
  if (typeof text !== 'string') return null;
  const re = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.com\/[\w./-]+\/-\/merge_requests\/\d+)/g;
  const all = text.match(re);
  return all ? all[all.length - 1] : null;
}

/** One-line summary of what a tool wants to do (shown on a permission ticket). */
export function describeTool(toolName, toolInput) {
  const name = typeof toolName === 'string' ? toolName : 'tool';
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const hint =
    input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.query ?? input.description;
  return hint ? `${name}: ${truncate(String(hint), 160)}` : name;
}

/**
 * Map one hook payload to a board transition.
 * Returns null when the event carries no state change worth reporting.
 * @param {string} event hook event name (argv of the hook script, falls back to hook_event_name)
 * @param {object} input the JSON Claude Code wrote on the hook's stdin
 * @param {object} [opts] { sendText: boolean } — when false, prompts/messages are never included
 */
export function classify(event, input = {}, opts = {}) {
  const sendText = opts.sendText !== false;
  const ev = event || input.hook_event_name;
  const text = (s, max) => (sendText ? truncate(s, max) : '');
  switch (ev) {
    case 'SessionStart':
      return { state: 'idle', detail: input.source ? `Session ${input.source}` : 'Session started' };
    case 'UserPromptSubmit':
      return { state: 'working', detail: text(input.prompt, 200), prompt: text(input.prompt, 200) };
    case 'PreToolUse':
    case 'PostToolUse':
      return { state: 'working', detail: describeTool(input.tool_name, sendText ? input.tool_input : {}), heartbeat: true };
    case 'PermissionRequest':
      return {
        state: 'waiting',
        kind: 'permission',
        detail: 'Permission: ' + describeTool(input.tool_name, sendText ? input.tool_input : {}),
      };
    case 'Elicitation':
      return {
        state: 'waiting',
        kind: 'question',
        detail: text(input.message ?? input.prompt ?? input.title, 280) || 'Input requested',
      };
    case 'Notification': {
      const type = input.notification_type;
      if (WAITING_NOTIFICATIONS.has(type)) {
        return {
          state: 'waiting',
          kind: type === 'permission_prompt' ? 'permission' : type === 'idle_prompt' ? 'idle' : 'question',
          detail: text(input.message, 280) || type,
        };
      }
      if (DONE_NOTIFICATIONS.has(type)) return { state: 'review', detail: text(input.message, 280) };
      return null;
    }
    case 'Stop': {
      const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
      return { state: 'review', detail: text(last, 400), pr: findPrUrl(last) };
    }
    case 'StopFailure': {
      // Hooks reference: `error_type` + `error_message` (older builds: `error` + `error_details`).
      const err = String(input.error_type ?? input.error ?? 'unknown');
      const raw = input.error_message ?? input.error_details;
      const details = typeof raw === 'string' ? raw : '';
      return { state: 'failed', detail: truncate(details ? `${err}: ${details}` : `Turn failed: ${err}`, 280) };
    }
    case 'SessionEnd':
      return { state: 'closed', detail: input.reason ? `Ended (${input.reason})` : 'Ended' };
    case 'TaskCreated':
    case 'TaskCompleted': {
      // Claude's native task list, mirrored as tickets. Field names differ between builds, so read
      // every documented spelling: task_id, task_title / task_name / task_subject, task_input.{…}.
      if (opts.mirrorTasks === false) return null;
      const ti = input.task_input && typeof input.task_input === 'object' ? input.task_input : {};
      const title = firstString(input.task_title, input.task_name, input.task_subject, ti.title, ti.subject);
      const id = firstString(input.task_id, ti.id, ti.task_id);
      if (!title && !id) return null;
      return {
        state: 'working',
        detail: '',
        task: {
          op: ev === 'TaskCreated' ? 'create' : 'complete',
          id: id || null,
          title: truncate(sendText ? title || `Task ${id}` : `Task ${id || ''}`.trim(), 200),
          description: text(firstString(input.task_description, ti.description), 600),
        },
      };
    }
    default:
      return null;
  }
}

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  for (const v of vals) if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Merge a transition into the stored record of a session (pure; returns a new record).
 * `idle_prompt` does not demote a `review` ticket: both mean "your turn", review carries more info.
 */
export function applyTransition(prev, t, identity = {}, now = Date.now()) {
  const rec = { ...(prev || {}), ...stripEmpty(identity) };
  rec.sessionId = identity.sessionId ?? rec.sessionId;
  rec.lastSeen = now;
  if (!rec.firstSeen) rec.firstSeen = now;
  if (t.prompt && !rec.title) rec.title = t.prompt;
  if (t.kind === 'idle' && (rec.state === 'review' || rec.state === 'failed')) return rec;
  if (rec.state !== t.state) rec.since = now;
  rec.state = t.state;
  rec.detail = t.detail ?? rec.detail ?? '';
  rec.kind = t.kind ?? null;
  if (t.state === 'review') rec.pr = t.pr ?? rec.pr ?? null;
  if (t.state === 'working') rec.dismissed = false;
  return rec;
}

function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/**
 * Throttle: decide whether a transition must be sent.
 * Every state change is sent; repeated `working` heartbeats at most once per THROTTLE_MS.
 */
export function shouldSend(lastSent, t, now = Date.now()) {
  if (!lastSent) return true;
  if (lastSent.state !== t.state) return true;
  if (!t.heartbeat) return true;
  return now - (lastSent.at ?? 0) >= THROTTLE_MS;
}

/** Display state: `working` without heartbeat for STALE_MS becomes `stale`. */
export function displayState(rec, now = Date.now()) {
  if (rec.state === 'working' && now - (rec.lastSeen ?? 0) > STALE_MS) return 'stale';
  return rec.state;
}

/** Should the record be dropped from storage? */
export function isExpired(rec, now = Date.now()) {
  const age = now - (rec.lastSeen ?? 0);
  if (rec.state === 'closed') return age > CLOSED_TTL_MS;
  return age > MAX_AGE_MS;
}

/**
 * Group sessions into the three board columns.
 * waiting (+failed) — oldest first: what has waited longest comes first.
 * inProgress (working + stale) — most recent first. review — most recent first, dismissed hidden.
 */
export function buildBoard(records, now = Date.now()) {
  const live = records.filter((r) => r && r.sessionId && !isExpired(r, now)).map((r) => ({ ...r, display: displayState(r, now) }));
  const by = (pred) => live.filter(pred);
  const oldest = (a, b) => (a.since ?? a.lastSeen) - (b.since ?? b.lastSeen);
  const newest = (a, b) => b.lastSeen - a.lastSeen;
  const waiting = by((r) => r.display === 'waiting' || r.display === 'failed').sort(oldest);
  const inProgress = by((r) => r.display === 'working' || r.display === 'stale').sort(newest);
  const review = by((r) => r.display === 'review' && !r.dismissed).sort(newest);
  const idle = by((r) => r.display === 'idle').sort(newest);
  return {
    now,
    counts: {
      waiting: waiting.length,
      working: inProgress.filter((r) => r.display === 'working').length,
      stale: inProgress.filter((r) => r.display === 'stale').length,
      review: review.length,
      idle: idle.length,
    },
    waiting,
    inProgress,
    review,
    idle,
  };
}

/** "3 waiting · 5 working · 2 review" — empty string when nothing is open. */
export function statusText(counts) {
  const parts = [];
  if (counts.waiting) parts.push(`${counts.waiting} waiting`);
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.review) parts.push(`${counts.review} review`);
  return parts.join(' · ');
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Short label for a session: repo@branch, else the last path segment of cwd. */
export function label(rec) {
  const where = rec.repo || (rec.cwd ? rec.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || 'session';
  const branch = rec.branch && rec.branch !== 'HEAD' ? `@${rec.branch}` : '';
  return rec.name ? `${rec.name} (${where}${branch})` : `${where}${branch}`;
}

/** Plain-text board for `/board` and terminals. */
export function renderText(board) {
  const lines = [];
  const now = board.now;
  const line = (r) => {
    const where = r.surface === 'cloud' ? '☁' : '⌨';
    const badge = r.display === 'failed' ? ' [FAILED]' : r.display === 'stale' ? ' [stale]' : '';
    const out = [`  ${where} ${label(r)}${badge} · ${ago(r.since ?? r.lastSeen, now)}`];
    if (r.title) out.push(`      task: ${truncate(r.title, 100)}`);
    if (r.detail) out.push(`      ${truncate(r.detail, 160)}`);
    if (r.pr) out.push(`      PR: ${r.pr}`);
    if (r.url) out.push(`      open: ${r.url}`);
    return out.join('\n');
  };
  const section = (title, list) => {
    lines.push(`${title} (${list.length})`);
    lines.push(list.length ? list.map(line).join('\n') : '  —');
    lines.push('');
  };
  section('WAITING ON YOU', board.waiting);
  section('IN PROGRESS', board.inProgress);
  section('READY FOR REVIEW', board.review);
  if (board.idle.length) lines.push(`(${board.idle.length} idle session${board.idle.length > 1 ? 's' : ''} not shown)`);
  return lines.join('\n').trimEnd();
}

/** Normalize a git remote URL to "owner/repo". */
export function repoFromRemote(remote) {
  if (typeof remote !== 'string' || !remote.trim()) return null;
  const m = remote.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

/** Validate and normalize an event received by the server. Returns null if unusable. */
export function sanitizeEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const s = body.session;
  if (!s || typeof s.sessionId !== 'string' || !/^[\w.:-]{1,128}$/.test(s.sessionId)) return null;
  const t = body.transition;
  if (!t || !STATES.includes(t.state) || t.state === 'stale') return null;
  const str = (v, max) => (typeof v === 'string' ? truncate(v, max) : undefined);
  const url = (v) => (typeof v === 'string' && /^https:\/\/[^\s]{1,500}$/.test(v) ? v : undefined);
  return {
    identity: {
      sessionId: s.sessionId,
      name: str(s.name, 120),
      cwd: str(s.cwd, 300),
      repo: str(s.repo, 200),
      branch: str(s.branch, 200),
      host: str(s.host, 120),
      surface: s.surface === 'cloud' ? 'cloud' : 'terminal',
      url: url(s.url),
    },
    transition: {
      state: t.state,
      detail: str(t.detail, 400) ?? '',
      kind: str(t.kind, 40) ?? null,
      prompt: str(t.prompt, 200),
      pr: url(t.pr) ?? null,
      heartbeat: Boolean(t.heartbeat),
      task:
        t.task && typeof t.task === 'object' && (t.task.op === 'create' || t.task.op === 'complete')
          ? {
              op: t.task.op,
              id: str(t.task.id == null ? undefined : String(t.task.id), 128) || null,
              title: str(t.task.title, 200) ?? '',
              description: str(t.task.description, 600) ?? '',
            }
          : undefined,
    },
    at: Number.isFinite(body.at) ? body.at : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Tickets. A ticket is the unit of the board; a session is the context it came from (0..n tickets).

export const STATUSES = ['todo', 'in_progress', 'waiting_on_user', 'review', 'done', 'cancelled', 'failed'];
export const OPEN_STATUSES = ['todo', 'in_progress', 'waiting_on_user', 'review', 'failed'];
export const CLOSED_STATUSES = ['done', 'cancelled'];
export const ASSIGNEES = ['user', 'claude'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const ORIGINS = ['terminal', 'cloud'];
export const SOURCES = ['hook', 'claude', 'user'];
/** Known kinds; any short slug is accepted. */
export const KINDS = ['session', 'permission', 'question', 'task', 'action', 'bug', 'note'];
/** Closed tickets older than this leave the default views (never deleted; `archived=1` shows them). */
export const ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const TICKET_PREFIX = 'SB';

export const ticketKey = (seq) => `${TICKET_PREFIX}-${seq}`;

/** Which board column a ticket sits in. */
export function columnOf(t) {
  if (t.status === 'todo') return 'todo';
  if (CLOSED_STATUSES.includes(t.status)) return 'done';
  if (t.status === 'in_progress') return 'inProgress';
  // waiting_on_user, review, failed: on you when assigned to you, else still Claude's work.
  return t.assignee === 'claude' ? 'inProgress' : 'waiting';
}

const SLUG = /^[a-z][a-z0-9_-]{0,23}$/;

export function normalizeLabels(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const l = raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (l && !out.includes(l)) out.push(l);
    if (out.length >= 12) break;
  }
  return out;
}

/** Links: [{ type, url, title }]. https URLs only, plus repo-relative file paths. */
export function normalizeLinks(v) {
  const out = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const l = typeof raw === 'string' ? { url: raw } : raw;
    if (!l || typeof l !== 'object') continue;
    const url = typeof l.url === 'string' ? l.url.trim() : '';
    let type = typeof l.type === 'string' && SLUG.test(l.type) ? l.type : '';
    if (/^https:\/\/[^\s]{1,500}$/.test(url)) {
      if (!type) type = /\/(pull|merge_requests)\/\d+/.test(url) ? 'pr' : /claude\.ai\/code\/session_/.test(url) ? 'session' : 'url';
    } else if (/^[\w./@-][^\s]{0,299}$/.test(url) && !/^[a-z]+:/i.test(url)) {
      type = 'file';
    } else continue;
    const title = typeof l.title === 'string' ? truncate(l.title, 120) : '';
    if (!out.some((o) => o.url === url)) out.push(title ? { type, url, title } : { type, url });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Validate a ticket create/update body coming from the API, the MCP server or the CLI.
 * Returns { value, error }. `partial` for updates: only present fields are returned.
 */
export function sanitizeTicketInput(body, { partial = false } = {}) {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const v = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  if (has('title')) {
    const t = truncate(String(body.title ?? ''), 200);
    if (!t) return { error: 'title must not be empty' };
    v.title = t;
  } else if (!partial) return { error: 'title is required' };
  if (has('body')) v.body = String(body.body ?? '').slice(0, 8000);
  if (has('status')) {
    if (!STATUSES.includes(body.status)) return { error: `status must be one of ${STATUSES.join(', ')}` };
    v.status = body.status;
  }
  if (has('kind')) {
    const k = String(body.kind || '').toLowerCase();
    if (!SLUG.test(k)) return { error: 'kind must be a short slug' };
    v.kind = k;
  }
  if (has('assignee')) {
    if (!ASSIGNEES.includes(body.assignee)) return { error: 'assignee must be user or claude' };
    v.assignee = body.assignee;
  }
  if (has('priority')) {
    if (body.priority === null || body.priority === '') v.priority = null;
    else if (!PRIORITIES.includes(body.priority)) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    else v.priority = body.priority;
  }
  if (has('labels')) v.labels = normalizeLabels(body.labels);
  if (has('links')) v.links = normalizeLinks(body.links);
  if (has('parent')) v.parent = body.parent === null || body.parent === '' ? null : String(body.parent).slice(0, 64);
  const ctx = { session_id: 128, repo: 200, branch: 200, cwd: 300, machine: 120 };
  for (const [k, max] of Object.entries(ctx)) if (has(k)) v[k] = body[k] === null ? null : truncate(String(body[k]), max) || null;
  if (has('session_id') && v.session_id && !/^[\w.:-]{1,128}$/.test(v.session_id)) return { error: 'bad session_id' };
  if (has('origin')) v.origin = body.origin === 'cloud' ? 'cloud' : 'terminal';
  return { value: v };
}

const FILTER_KEYS = ['session', 'repo', 'branch', 'machine', 'origin', 'status', 'assignee', 'kind', 'label', 'source', 'priority', 'parent'];

/**
 * Parse list filters from a URLSearchParams / plain object. Multi-values: comma-separated or repeated.
 * Dates: ISO or epoch ms in created_after / created_before / updated_after / updated_before.
 */
export function parseFilters(input) {
  const get = (k) => {
    if (!input) return [];
    const raw = typeof input.getAll === 'function' ? input.getAll(k) : [input[k]].flat();
    return raw
      .filter((x) => x !== undefined && x !== null && x !== '')
      .flatMap((x) => String(x).split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const f = {};
  for (const k of FILTER_KEYS) {
    const vals = get(k);
    if (vals.length) f[k] = vals.slice(0, 20);
  }
  if (f.status) f.status = f.status.flatMap((s) => (s === 'open' ? OPEN_STATUSES : s === 'closed' ? CLOSED_STATUSES : [s])).filter((s) => STATUSES.includes(s));
  const q = get('q').join(' ').trim();
  if (q) f.q = q.slice(0, 200);
  for (const k of ['created_after', 'created_before', 'updated_after', 'updated_before']) {
    const raw = get(k)[0];
    if (!raw) continue;
    const ms = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (Number.isFinite(ms)) f[k] = ms;
  }
  const arch = get('archived')[0];
  if (arch === '1' || arch === 'true' || arch === 'include') f.archived = 'include';
  else if (arch === 'only') f.archived = 'only';
  const lim = Number(get('limit')[0]);
  f.limit = Number.isFinite(lim) && lim > 0 ? Math.min(Math.floor(lim), 500) : 100;
  const off = Number(get('offset')[0]);
  f.offset = Number.isFinite(off) && off > 0 ? Math.floor(off) : 0;
  const sort = get('sort')[0];
  f.sort = ['updated', 'created', 'priority', 'key'].includes(sort) ? sort : 'updated';
  return f;
}

/** Turn free text into a safe FTS5 query: every word must match, as a prefix. */
export function ftsQuery(q) {
  const words = String(q || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu);
  if (!words) return '';
  return words
    .slice(0, 12)
    .map((w) => `"${w}"*`)
    .join(' AND ');
}

/** Counts for a status line: "2 for you · 3 in progress · 5 to do". */
export function ticketStatusText(counts) {
  const parts = [];
  if (counts.waiting) parts.push(`${counts.waiting} for you`);
  if (counts.inProgress) parts.push(`${counts.inProgress} in progress`);
  if (counts.todo) parts.push(`${counts.todo} to do`);
  return parts.join(' · ');
}

/** Plain-text ticket board for `/board` and `/ticket list`. */
export function renderTicketsText(board, { now = board.now ?? Date.now() } = {}) {
  const out = [];
  const line = (t) => {
    const where = [t.repo ? t.repo.split('/').pop() : '', t.branch && t.branch !== 'HEAD' ? t.branch : ''].filter(Boolean).join('@');
    const flag = t.status === 'failed' ? ' [FAILED]' : t.status === 'review' ? ' [review]' : t.stale ? ' [stale]' : '';
    const rows = [`  ${t.origin === 'cloud' ? '☁' : '⌨'} ${t.key} ${truncate(t.title, 90)}${flag} · ${ago(t.status_at ?? t.updated_at, now)}${where ? ' · ' + where : ''}`];
    const pr = (t.links || []).find((l) => l.type === 'pr');
    if (pr) rows.push(`      PR: ${pr.url}`);
    const sess = (t.links || []).find((l) => l.type === 'session');
    if (sess) rows.push(`      open: ${sess.url}`);
    return rows.join('\n');
  };
  const section = (title, col) => {
    const list = board.columns?.[col] || [];
    const total = board.counts?.[col] ?? list.length;
    out.push(`${title} (${total})`);
    out.push(list.length ? list.map(line).join('\n') : '  —');
    if (total > list.length) out.push(`  … ${total - list.length} more`);
    out.push('');
  };
  section('WAITING ON YOU', 'waiting');
  section('IN PROGRESS', 'inProgress');
  section('TO DO', 'todo');
  if (board.counts?.done) out.push(`(${board.counts.done} done, not shown)`);
  return out.join('\n').trimEnd();
}
