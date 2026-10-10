// session-board — pure logic shared by the hook, the CLI, the statusline and the server.
// Zero dependencies, no I/O in this file: everything here is unit-tested.

/** Version of the plugin, the server and every copy vendored into a repository (one source). */
export const VERSION = '0.5.1';

/** Display name of an actor: a stored name when present, else the last segment of its id. */
export function actorDisplayName(id, name) {
  const sid = String(id || '').trim();
  const n = typeof name === 'string' ? name.trim() : '';
  if (n && n !== sid) return n;
  const last = sid.split('/').filter(Boolean).pop() || '';
  return last || sid || '?';
}


/** Compare two `x.y.z` versions: < 0 when a is older, 0 when equal, > 0 when newer. Junk counts as 0. */
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

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

// ---- markdown (terminal) ---------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function mdInlineToText(s, { ansi = false } = {}) {
  let out = String(s || '');
  // Links: [label](url)
  out = out.replace(/\[([^\]]{1,200})\]\(([^)\s]{1,400})\)/g, (_, label, url) => {
    const u = String(url || '');
    if (/^(https?:\/\/|mailto:)/i.test(u)) return `${label} <${u}>`;
    return String(label);
  });
  // Bold.
  out = out.replace(/\*\*([^*\n]{1,400})\*\*/g, (_, inner) => (ansi ? `${ANSI.bold}${inner}${ANSI.reset}` : inner));
  // Italic (drop markers; italic ANSI is not reliable across terminals).
  out = out.replace(/(^|[\s(])_([^_\n]{1,400})_([\s).,!?;:]|$)/g, '$1$2$3');
  out = out.replace(/(^|[\s(])\*([^*\n]{1,400})\*([\s).,!?;:]|$)/g, '$1$2$3');
  // Inline code: keep backticks.
  // Strikethrough: drop markers.
  out = out.replace(/~([^~\n]{1,400})~/g, '$1');
  return out;
}

/** Render a markdown-ish text as readable terminal text (ANSI optional). */
export function markdownToTerminal(text, { ansi = true, max = 2000 } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (/^```/.test(l.trim())) {
      inFence = !inFence;
      if (inFence) out.push('');
      continue;
    }
    if (inFence) {
      out.push('    ' + l);
      continue;
    }

    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const title = mdInlineToText(h[2], { ansi }).trim();
      if (title) out.push(ansi ? `${ANSI.bold}${title}${ANSI.reset}` : title);
      continue;
    }

    const b = l.match(/^\s*([-*+])\s+(.*)$/);
    if (b) {
      out.push('• ' + mdInlineToText(b[2], { ansi }).trim());
      continue;
    }

    const o = l.match(/^\s*(\d+)\.\s+(.*)$/);
    if (o) {
      out.push(`${o[1]}. ` + mdInlineToText(o[2], { ansi }).trim());
      continue;
    }

    const q = l.match(/^\s*>\s?(.*)$/);
    if (q) {
      out.push((ansi ? `${ANSI.dim}│ ${ANSI.reset}` : '│ ') + mdInlineToText(q[1], { ansi }).trim());
      continue;
    }

    // Tables: keep pipes but normalize spacing a bit.
    if (l.includes('|') && /^\s*\|?[^\n]*\|[^\n]*\|?\s*$/.test(l)) {
      const row = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => mdInlineToText(c.trim(), { ansi }));
      out.push(row.join(' | '));
      continue;
    }

    out.push(mdInlineToText(l, { ansi }));
  }

  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return joined.length > max ? joined.slice(0, Math.max(0, max - 1)) + '…' : joined;
}

/**
 * A session title from its first prompt, readable on a phone: attached files (`@"/path/x.pdf"` or
 * `@path/x.png`, as Claude Code writes uploads) become a short « 📎 name » at the end instead of a
 * long path at the start; an upload's hash prefix (`9a09b386-`) is dropped. Pure.
 */
export function promptTitle(prompt, max = 120) {
  if (typeof prompt !== 'string') return '';
  const files = [];
  const name = (p) => p.split('/').pop().replace(/^[0-9a-f]{8}-/i, '');
  let rest = prompt
    .replace(/@"([^"]+)"/g, (_, p) => (files.push(name(p)), ' '))
    .replace(/@((?:\/|~\/|\.\/)[^\s"]+\.[A-Za-z0-9]{1,8})(?=\s|$)/g, (_, p) => (files.push(name(p)), ' '))
    .replace(/\s+/g, ' ')
    .trim();
  // A capital only where a leading file was removed: an ordinary prompt keeps its exact wording.
  if (rest && files.length && /^\s*@/.test(prompt)) rest = rest[0].toUpperCase() + rest.slice(1);
  const clip = files.length ? `📎 ${files[0]}${files.length > 1 ? ` +${files.length - 1}` : ''}` : '';
  if (!rest) return truncate(clip, max);
  if (!clip) return truncate(rest, max);
  return `${truncate(rest, Math.max(20, max - clip.length - 3))} · ${clip}`;
}

/**
 * The question a final reply ends on, or '': the sentence holding the last « ? » of the reply's last
 * paragraph (code blocks and URLs aside). A turn that ends by asking waits on its human; a turn that
 * only reports does not. The ticket body keeps the reply's first 400 characters, so a question at the
 * end was invisible on the board. Pure.
 */
export function finalQuestion(text, max = 200) {
  if (typeof text !== 'string') return '';
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const paras = prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] ?? '';
  const i = last.lastIndexOf('?');
  if (i < 0) return '';
  const head = last.slice(0, i + 1);
  const start = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? ', i - 1), head.lastIndexOf('\n')) + 1;
  return truncate(head.slice(start).replace(/^[\s*_>#\-\d.)]+/, '').trim(), max);
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
  return hint ? `${name}: ${truncate(redactSecrets(String(hint)), 160)}` : name;
}

const R = '[redacted]';
// Names that say "this value is a credential", in headers, query strings, flags and variables.
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_-]*`;
const SECRET_PATTERNS = [
  // Authorization: Bearer xxx / X-Api-Key: xxx / Cookie: xxx (header values, quoted or not)
  [/\b((?:authorization|proxy-authorization|cookie|x-[a-z0-9-]*(?:key|token|secret|auth)[a-z0-9-]*|api-key)\s*:\s*)(?:(bearer|basic|token)\s+)?[^\s"'\\]+/gi, (_, h, scheme) => h + (scheme ? scheme + ' ' : '') + R],
  // Bearer xxx anywhere else
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_, b) => b + R],
  // ?key=xxx&token=xxx in URLs
  [new RegExp(String.raw`([?&](?:key|sig|signature|${SECRET_NAME})=)[^&\s"'#]+`, 'gi'), (_, k) => k + R],
  // NAME_TOKEN=xxx, export API_KEY="xxx" (a value that is a path or a $variable is left alone)
  [new RegExp(String.raw`\b(${SECRET_NAME}=)(["']?)(?![/$~.])[^\s"']{6,}\2`, 'gi'), (_, k, q) => k + q + R + q],
  // --token xxx / --password=xxx
  [new RegExp(String.raw`(--${SECRET_NAME}[= ])(["']?)(?![/$~.-])[^\s"']{6,}\2`, 'gi'), (_, k, q) => k + q + R + q],
  // https://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@/"']+@/gi, (_, u) => u + R + '@'],
  // Well-known token shapes: GitHub, OpenAI/Anthropic, Slack, AWS, GitLab, WAHA, JWT
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20}|key_[A-Za-z0-9]{24,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,})/g, () => R],
];

/**
 * Hide credentials that a tool call or a prompt carries, before the text leaves the machine.
 * Approval tickets show the command being approved; a curl with an API key in its header would put
 * that key on the board, in every session that lists tickets.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [re, fn] of SECRET_PATTERNS) out = out.replace(re, fn);
  return out;
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
  const text = (s, max) => (sendText ? truncate(redactSecrets(s), max) : '');
  switch (ev) {
    case 'SessionStart':
      return { state: 'idle', detail: input.source ? `Session ${input.source}` : 'Session started' };
    case 'UserPromptSubmit':
      return { state: 'working', detail: text(input.prompt, 200), prompt: text(input.prompt, 200), title: sendText ? promptTitle(redactSecrets(input.prompt)) : '' };
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
      return { state: 'review', detail: text(last, 400), pr: findPrUrl(last), asks: text(finalQuestion(last), 200) };
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
    case 'SubagentStart':
    case 'SubagentStop': {
      // Who talks to whom: the session hands work to a subagent, the subagent answers. Hooks
      // reference: `agent_id` + `agent_type` on both, `last_assistant_message` on SubagentStop.
      // An empty agent_type is one of Claude Code's own internal agents (prompt suggestions, /btw).
      const type = firstString(input.agent_type);
      if (!type) return null;
      return {
        state: 'working',
        detail: '',
        agent: {
          op: ev === 'SubagentStart' ? 'start' : 'stop',
          id: truncate(firstString(input.agent_id), 80) || null,
          type: truncate(type, 60),
          detail: ev === 'SubagentStop' ? text(input.last_assistant_message, 280) : '',
        },
      };
    }
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
  if ((t.title || t.prompt) && !rec.title) rec.title = t.title || t.prompt;
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
  // Free text from the hook: a client older than 0.4.2 sends it unredacted.
  const said = (v, max) => (typeof v === 'string' ? truncate(redactSecrets(v), max) : undefined);
  const url = (v) => (typeof v === 'string' && /^https:\/\/[^\s]{1,500}$/.test(v) ? v : undefined);
  const actor = normalizeActorId(s.actor);
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
      actor: actor || undefined,
      actorName: actor ? str(s.actorName, 60) : undefined,
      thread: normalizeThread(s.thread) || undefined,
      sessionTickets: s.sessionTickets === false ? false : undefined,
      stopStatus: s.stopStatus === 'done' ? 'done' : undefined,
    },
    transition: {
      state: t.state,
      detail: said(t.detail, 400) ?? '',
      kind: str(t.kind, 40) ?? null,
      prompt: said(t.prompt, 200),
      pr: url(t.pr) ?? null,
      asks: said(t.asks, 200) || undefined,
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
      agent:
        t.agent && typeof t.agent === 'object' && (t.agent.op === 'start' || t.agent.op === 'stop') && typeof t.agent.type === 'string' && t.agent.type.trim()
          ? {
              op: t.agent.op,
              id: str(t.agent.id == null ? undefined : String(t.agent.id), 80) || null,
              type: str(t.agent.type, 60),
              detail: str(t.agent.detail, 280) ?? '',
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
/** The two built-in assignees. Any actor id is accepted too (`ci-bot`, `job-42`, `claude/Explore`). */
export const ASSIGNEES = ['user', 'claude'];
/** P0 = drop everything, P3 = some day. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
/** 0.2 priorities and common spellings, mapped once by the migration and on every input. */
export const PRIORITY_ALIASES = { urgent: 'P0', critical: 'P0', high: 'P1', medium: 'P2', normal: 'P2', low: 'P3' };
export const FEEDBACK_TYPES = ['bug', 'suggestion', 'friction'];
export const ACTOR_TYPES = ['human', 'agent', 'subagent', 'system'];
/** Actors every board knows: the human, Claude, the hooks. */
export const BUILTIN_ACTORS = [
  { id: 'user', type: 'human', name: 'You' },
  { id: 'claude', type: 'agent', name: 'Claude' },
  { id: 'hook', type: 'system', name: 'Session' },
];

/** `P1`, `p1`, `high`, `1` → `P1`; empty → null; anything else → undefined (invalid). */
export function normalizePriority(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^[pP][0-3]$/.test(s)) return s.toUpperCase();
  if (/^[0-3]$/.test(s)) return 'P' + s;
  return PRIORITY_ALIASES[s.toLowerCase()];
}

const ACTOR_ID = /^[A-Za-z0-9][\w.:@/-]{0,63}$/;
/** An actor id as given by SESSION_BOARD_ACTOR, a header or an API body; '' when unusable. */
export function normalizeActorId(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return ACTOR_ID.test(s) ? s : '';
}

/** SESSION_BOARD_THREAD: a stable name for a conversation that lives across several sessions. */
export function normalizeThread(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return /^[\w.:@/-]{1,100}$/.test(s) ? s : '';
}

/** Actor of a subagent spawned by `parent`: one id per (parent, agent type), readable in the history. */
export function subagentActor(parent, agentType) {
  const type = String(agentType || '').replace(/[^\w.:@-]/g, '-').slice(0, 40) || 'agent';
  const base = normalizeActorId(parent) || 'claude';
  return { id: `${base}/${type}`.slice(0, 64), type: 'subagent', name: agentType, parent: base };
}
export const ORIGINS = ['terminal', 'cloud'];
export const SOURCES = ['hook', 'claude', 'user'];
/** Known kinds; any short slug is accepted. */
export const KINDS = ['session', 'permission', 'question', 'task', 'action', 'bug', 'note', 'feedback'];
/** Kinds that are not work to pick up: they never show in "next". */
export const NOT_WORK_KINDS = ['session', 'permission', 'question', 'feedback'];
/** Closed tickets older than this leave the default views (never deleted; `archived=1` shows them). */
export const ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const TICKET_PREFIX = 'SB';

export const ticketKey = (seq) => `${TICKET_PREFIX}-${seq}`;

/** Which board column a ticket sits in. */
export function columnOf(t) {
  if (t.status === 'todo') return 'todo';
  if (CLOSED_STATUSES.includes(t.status)) return 'done';
  if (t.status === 'in_progress') return 'inProgress';
  // waiting_on_user, review, failed: on you when assigned to you, else still an agent's work.
  return t.assignee === 'user' ? 'waiting' : 'inProgress';
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
    const a = normalizeActorId(body.assignee);
    if (!a) return { error: 'assignee must be user, claude or an actor id (letters, digits, . _ - : @ /)' };
    v.assignee = a;
  }
  if (has('priority')) {
    const p = normalizePriority(body.priority);
    if (p === undefined) return { error: `priority must be one of ${PRIORITIES.join(', ')}` };
    v.priority = p;
  }
  if (has('rank')) {
    if (body.rank === null || body.rank === '') v.rank = null;
    else if (!Number.isFinite(Number(body.rank))) return { error: 'rank must be a number' };
    else v.rank = Number(body.rank);
  }
  if (has('subtype')) {
    if (body.subtype === null || body.subtype === '') v.subtype = null;
    else {
      const s = String(body.subtype).toLowerCase();
      if (!SLUG.test(s)) return { error: 'subtype must be a short slug' };
      v.subtype = s;
    }
  }
  for (const k of ['blocked_by', 'blocked_by_add', 'blocked_by_remove']) {
    if (!has(k)) continue;
    const list = (Array.isArray(body[k]) ? body[k] : String(body[k]).split(',')).map((x) => String(x).trim()).filter(Boolean);
    if (list.length > 50 || list.some((x) => !/^[\w-]{1,64}$/.test(x))) return { error: `${k} must be a list of ticket keys` };
    v[k] = list;
  }
  if (has('labels')) v.labels = normalizeLabels(body.labels);
  if (has('links')) v.links = normalizeLinks(body.links);
  if (has('parent')) v.parent = body.parent === null || body.parent === '' ? null : String(body.parent).slice(0, 64);
  const ctx = { session_id: 128, repo: 200, branch: 200, cwd: 300, machine: 120 };
  for (const [k, max] of Object.entries(ctx)) if (has(k)) v[k] = body[k] === null ? null : truncate(String(body[k]), max) || null;
  if (has('session_id') && v.session_id && !/^[\w.:-]{1,128}$/.test(v.session_id)) return { error: 'bad session_id' };
  if (has('origin')) v.origin = body.origin === 'cloud' ? 'cloud' : 'terminal';
  if (v.kind === 'feedback' && v.subtype !== undefined && v.subtype !== null && !FEEDBACK_TYPES.includes(v.subtype)) return { error: `feedback subtype must be one of ${FEEDBACK_TYPES.join(', ')}` };
  return { value: v };
}

const FILTER_KEYS = ['session', 'repo', 'branch', 'machine', 'origin', 'status', 'assignee', 'kind', 'label', 'source', 'priority', 'parent', 'actor', 'subtype', 'created_by'];

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
  if (f.priority) f.priority = f.priority.map((p) => (p === 'none' ? 'none' : normalizePriority(p))).filter(Boolean);
  const blocked = get('blocked')[0];
  if (blocked === '1' || blocked === 'true') f.blocked = true;
  else if (blocked === '0' || blocked === 'false') f.blocked = false;
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
  f.sort = ['updated', 'created', 'priority', 'key', 'next'].includes(sort) ? sort : 'updated';
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
    const flag = (t.status === 'failed' ? ' [FAILED]' : t.status === 'review' ? ' [review]' : t.stale ? ' [stale]' : '') + (t.blocked ? ' [blocked]' : '');
    const rows = [`  ${t.origin === 'cloud' ? '☁' : '⌨'} ${t.key}${t.priority ? ' ' + t.priority : ''} ${truncate(t.title, 90)}${flag} · ${ago(t.status_at ?? t.updated_at, now)}${where ? ' · ' + where : ''}`];
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
