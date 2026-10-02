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
      // Hooks reference: `error` (rate_limit, overloaded, …), optional `error_details`.
      const err = String(input.error ?? 'unknown');
      const details = typeof input.error_details === 'string' ? input.error_details : '';
      return { state: 'failed', detail: truncate(details ? `${err}: ${details}` : `Turn failed: ${err}`, 280) };
    }
    case 'SessionEnd':
      return { state: 'closed', detail: input.reason ? `Ended (${input.reason})` : 'Ended' };
    default:
      return null;
  }
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
    },
  };
}
