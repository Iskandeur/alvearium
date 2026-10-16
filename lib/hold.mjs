// 0.6.0: "On hold" — a ticket that waits is woken by the event that unblocks it, not by someone's memory.
// Whoever puts a ticket on hold says what it waits for (the condition) and what happens then (the next step).
// The server runs the next step itself when the condition is met: a blocker closed, a pull request merged,
// a time reached, a reply from a given actor. Pure helpers here; the store keeps and fires the holds.
import { normalizeActorId, STATUSES, truncate } from './core.mjs';

export const HOLD_CONDITIONS = ['blocked_by', 'pr_merged', 'time', 'reply'];
export const HOLD_NEXT = ['wake', 'assign', 'comment'];
/** A ticket woken this many times stops accepting a new hold: a loop goes to a human, not round again. */
export const HOLD_MAX_BOUNCES = 5;
/** A pull request "owner/repo#n" (a github.com pull URL is accepted and reduced to that form). */
const PR_RE = /^([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})$/;

export function normalizePr(v) {
  const s = String(v ?? '').trim();
  const url = s.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  const m = url ? [s, url[1], url[2], url[3]] : s.match(PR_RE);
  return m ? `${m[1]}/${m[2]}#${Number(m[3])}`.toLowerCase() : null;
}

const err = (error) => ({ error });

/**
 * Validate a hold: { condition: { type, … }, then?: { type, … }, note? }.
 * condition: blocked_by { keys? } · pr_merged { pr } · time { at (ms or ISO) } · reply { from }.
 * then: wake { actor, text? } · assign { to, status? } · comment { text } · absent = the default step.
 */
export function sanitizeHold(input, now = Date.now()) {
  if (!input || typeof input !== 'object') return err('hold must be an object with a condition');
  const c = input.condition;
  if (!c || typeof c !== 'object' || !HOLD_CONDITIONS.includes(c.type)) return err(`condition.type must be one of ${HOLD_CONDITIONS.join(', ')}`);
  let condition;
  if (c.type === 'blocked_by') {
    const raw = c.keys === undefined ? [] : Array.isArray(c.keys) ? c.keys : String(c.keys).split(',');
    const keys = raw.map((x) => String(x).trim()).filter(Boolean);
    if (keys.length > 50 || keys.some((k) => !/^[\w-]{1,64}$/.test(k))) return err('condition.keys must be a list of ticket keys');
    condition = { type: 'blocked_by', keys };
  } else if (c.type === 'pr_merged') {
    const pr = normalizePr(c.pr);
    if (!pr) return err('condition.pr must read owner/repo#number');
    condition = { type: 'pr_merged', pr };
  } else if (c.type === 'time') {
    const at = typeof c.at === 'number' ? c.at : Date.parse(String(c.at ?? ''));
    if (!Number.isFinite(at) || at <= 0) return err('condition.at must be a time (ms or ISO 8601)');
    if (at > now + 366 * 86400000) return err('condition.at must be within a year');
    condition = { type: 'time', at: Math.round(at) };
  } else {
    const from = normalizeActorId(c.from);
    if (!from) return err('condition.from must be an actor id');
    condition = { type: 'reply', from };
  }
  let then = null;
  const t = input.then;
  if (t !== undefined && t !== null) {
    if (typeof t !== 'object' || !HOLD_NEXT.includes(t.type)) return err(`then.type must be one of ${HOLD_NEXT.join(', ')}`);
    const text = typeof t.text === 'string' ? truncate(t.text.trim(), 2000) : '';
    if (t.type === 'wake') {
      const actor = normalizeActorId(t.actor);
      if (!actor || actor === 'user' || actor === 'hook') return err('then.actor must be an agent id (to wake the owner, use assign to user)');
      then = { type: 'wake', actor, ...(text ? { text } : {}) };
    } else if (t.type === 'assign') {
      const to = normalizeActorId(t.to);
      if (!to || to === 'hook') return err('then.to must be an actor id');
      const status = t.status ?? 'todo';
      if (!STATUSES.includes(status) || status === 'on_hold') return err('then.status must be a status other than on_hold');
      then = { type: 'assign', to, status, ...(text ? { text } : {}) };
    } else {
      if (!text) return err('then.text must say what to post');
      then = { type: 'comment', text };
    }
  }
  const note = typeof input.note === 'string' ? truncate(input.note.trim(), 500) : '';
  return { value: { condition, then, note } };
}

const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** "ALV-3 and ALV-4 are closed", "pull request o/r#5 is merged"… — what the condition waits for, in words. */
export function describeCondition(c, keys = c?.keys || []) {
  if (!c) return '';
  if (c.type === 'blocked_by') return keys.length ? `${keys.join(', ')} closed` : 'its blockers closed';
  if (c.type === 'pr_merged') return `pull request ${c.pr} merged`;
  if (c.type === 'time') return `${fmtTime(c.at)}`;
  if (c.type === 'reply') return `a reply from @${c.from}`;
  return c.type;
}

/** What happens once it is met, in words. */
export function describeNext(then, fallback) {
  const t = then || fallback;
  if (!t) return '';
  if (t.type === 'wake') return `wake @${t.actor}`;
  if (t.type === 'assign') return t.to === 'user' ? 'back to you' : `hand to @${t.to}`;
  if (t.type === 'comment') return 'post a comment';
  return t.type;
}

/** GitHub's word for a pull request: merged, closed (without merge) or open; null when it cannot tell. */
export async function prState(pr, { fetch: f = globalThis.fetch, token } = {}) {
  const m = String(pr).match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'alvearium' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const r = await f(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.merged_at ? 'merged' : j.state === 'closed' ? 'closed' : 'open';
  } catch {
    return null;
  }
}

/**
 * The clock of holds: every minute, the holds whose time came or whose blockers are gone; every
 * `pollSeconds` (BOARD_HOLD_POLL_SECONDS, 300 by default, 0 = never), the pull requests they wait on.
 * A webhook can say it sooner: POST /api/holds/pr.
 */
export function startHoldClock(store, { pollSeconds, githubToken, fetch: f, tickMs = 60000, log = () => {} } = {}) {
  const poll = pollSeconds === undefined || pollSeconds === '' ? 300 : Math.max(0, Number(pollSeconds) || 0);
  let lastPoll = 0;
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    try {
      const woken = store.tickHolds();
      if (woken.length) log(`woke ${woken.join(', ')} (hold met)`);
      if (poll && Date.now() - lastPoll >= poll * 1000) {
        lastPoll = Date.now();
        for (const pr of store.awaitedPrs()) {
          const state = await prState(pr, { fetch: f, token: githubToken });
          if (state && state !== 'open') {
            const r = store.signalPr(pr, state);
            if (r.woken.length) log(`woke ${r.woken.join(', ')} (${pr} ${state})`);
          }
        }
      }
    } catch (e) {
      log(`hold clock: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(round, tickMs);
  timer.unref?.();
  return { round, stop: () => clearInterval(timer) };
}

/**
 * The default next step: wake first the agent responsible (who put it on hold, else the previous assignee)
 * so it checks the ticket still makes sense; back to the owner only when nobody else holds it.
 */
export function defaultNext({ set_by, prev_assignee }) {
  const agent = [set_by, prev_assignee].find((a) => a && a !== 'user' && a !== 'hook');
  if (agent) return { type: 'wake', actor: agent, text: prev_assignee && prev_assignee !== agent ? `check it still makes sense, then hand it back to @${prev_assignee}` : 'check it still makes sense, then carry on' };
  return { type: 'assign', to: prev_assignee || 'user', status: 'todo' };
}
