// 0.6.0: "On hold" — a ticket that waits is woken by the event that unblocks it, not by someone's memory.
// Whoever puts a ticket on hold says what it waits for (the condition) and what happens then (the next step).
// The server runs the next step itself when the condition is met: a blocker closed, a pull request merged,
// a time reached, a reply from a given actor. Pure helpers here; the store keeps and fires the holds.
import { normalizeActorId, OPEN_STATUSES, truncate } from './core.mjs';

export const HOLD_CONDITIONS = ['blocked_by', 'pr_merged', 'time', 'reply', 'external'];
export const HOLD_NEXT = ['wake', 'assign', 'comment'];
/** A ticket woken this many times stops accepting a new hold: a loop goes to a human, not round again. */
export const HOLD_MAX_BOUNCES = 5;
/** Only the wakes of the last 7 days count toward that cap, and lifting a hold by hand starts the count again. */
export const HOLD_BOUNCE_WINDOW_MS = 7 * 86400_000;
/** The note a hold lifted by hand leaves in the history: the bounce count restarts after it. */
export const HOLD_LIFTED_TEXT = 'Hold lifted by hand';
/** A pull request "owner/repo#n" (a github.com pull URL is accepted and reduced to that form). */
const PR_RE = /^([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})$/;

export function normalizePr(v) {
  const s = String(v ?? '').trim();
  const url = s.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  const m = url ? [s, url[1], url[2], url[3]] : s.match(PR_RE);
  // "." and ".." are no owner or repo: interpolated in the API URL, they would point elsewhere, with the token.
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return `${m[1]}/${m[2]}#${Number(m[3])}`.toLowerCase();
}

/**
 * The pull request a ticket exists to merge, read from a title that starts with a merge verb ("Merge owner/repo#12",
 * "Fusionner owner/repo#12"), else null. Such a ticket cannot wait for that very merge: nobody else will do it.
 */
export function mergeTicketPr(title) {
  const m = String(title ?? '').match(/^\s*(?:merge|fusionner)\s+(?:(?:the|la)\s+)?(?:(?:pull request|PR)\s+)?(\S+)/i);
  return m ? normalizePr(m[1].replace(/[.,;:)]+$/, '')) : null;
}

const err = (error) => ({ error });

/** A next step { type: wake | assign | comment, … } checked; `field` names it in the error. */
function sanitizeNext(t, field) {
  if (typeof t !== 'object' || !HOLD_NEXT.includes(t.type)) return err(`${field}.type must be one of ${HOLD_NEXT.join(', ')}`);
  const text = typeof t.text === 'string' ? truncate(t.text.trim(), 2000) : '';
  if (t.type === 'wake') {
    const actor = normalizeActorId(t.actor);
    if (!actor || actor === 'user' || actor === 'hook') return err(`${field}.actor must be an agent id (to wake the owner, use assign to user)`);
    return { value: { type: 'wake', actor, ...(text ? { text } : {}) } };
  }
  if (t.type === 'assign') {
    const to = normalizeActorId(t.to);
    if (!to || to === 'hook') return err(`${field}.to must be an actor id`);
    const status = t.status ?? 'todo';
    // A hold brings a ticket back; it never closes one by itself (nor wakes the holds behind it in a chain).
    if (!OPEN_STATUSES.includes(status) || status === 'on_hold') return err(`${field}.status must be an open status other than on_hold`);
    return { value: { type: 'assign', to, status, ...(text ? { text } : {}) } };
  }
  if (!text) return err(`${field}.text must say what to post`);
  return { value: { type: 'comment', text } };
}


/**
 * Validate a hold: { condition: { type, … }, then?: { type, … }, note? }.
 * condition: blocked_by { keys? } · pr_merged { pr } · time { at (ms or ISO) } · reply { from }
 *   · external { what, deadline?, otherwise? } (0.8.0: a state of the world, lifted by POST …/hold/fire with a proof).
 * then: wake { actor, text? } · assign { to, status? } · comment { text } · absent = the default step.
 * external.otherwise: the step when the deadline passes unmet (same shapes as then; absent = then, else the default).
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
  } else if (c.type === 'external') {
    const what = typeof c.what === 'string' ? truncate(c.what.trim().replace(/\s+/g, ' '), 300) : '';
    if (!what) return err('condition.what must say, in words, the state it waits for');
    condition = { type: 'external', what };
    if (c.deadline !== undefined && c.deadline !== null && c.deadline !== '') {
      const at = typeof c.deadline === 'number' ? c.deadline : Date.parse(String(c.deadline));
      if (!Number.isFinite(at) || at <= 0) return err('condition.deadline must be a time (ms or ISO 8601)');
      if (at > now + 366 * 86400000) return err('condition.deadline must be within a year');
      condition.deadline = Math.round(at);
    }
    if (c.otherwise !== undefined && c.otherwise !== null) {
      const r = sanitizeNext(c.otherwise, 'condition.otherwise');
      if (r.error) return r;
      condition.otherwise = r.value;
    }
  } else {
    const from = normalizeActorId(c.from);
    if (!from) return err('condition.from must be an actor id');
    condition = { type: 'reply', from };
  }
  let then = null;
  if (input.then !== undefined && input.then !== null) {
    const r = sanitizeNext(input.then, 'then');
    if (r.error) return r;
    then = r.value;
  }
  const note = typeof input.note === 'string' ? truncate(input.note.trim(), 500) : '';
  return { value: { condition, then, note } };
}

export const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** "ALV-3 and ALV-4 are closed", "pull request o/r#5 is merged"… — what the condition waits for, in words. */
export function describeCondition(c, keys = c?.keys || []) {
  if (!c) return '';
  if (c.type === 'blocked_by') return keys.length ? `${keys.join(', ')} closed` : 'its blockers closed';
  if (c.type === 'pr_merged') return `pull request ${c.pr} merged`;
  if (c.type === 'time') return `${fmtTime(c.at)}`;
  if (c.type === 'reply') return `a reply from @${c.from}`;
  if (c.type === 'external') return c.deadline ? `${c.what} (until ${fmtTime(c.deadline)})` : c.what;
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

/**
 * GitHub's word for a pull request: merged, closed (without merge) or open; `{ unreadable: status }` when GitHub
 * refuses to show it (401, 404, or a 403 that is not a rate limit: a private repository without
 * BOARD_GITHUB_TOKEN, or a token that cannot see it); null when it cannot tell (network, rate limit).
 */
export async function prState(pr, { fetch: f = globalThis.fetch, token } = {}) {
  const m = String(pr).match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'alvearium' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const r = await f(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { headers, signal: AbortSignal.timeout(10000) });
    const limited = r.status === 403 && r.headers?.get?.('x-ratelimit-remaining') === '0';
    if ([401, 403, 404].includes(r.status) && !limited) return { unreadable: r.status };
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
          if (state?.unreadable) {
            // Said once on each waiting ticket, instead of a hold that silently never lifts.
            const told = store.notePrUnreadable(pr, state.unreadable, { token: Boolean(githubToken) });
            if (told.length) log(`cannot read ${pr} (HTTP ${state.unreadable}): told ${told.join(', ')}`);
          } else if (state && state !== 'open') {
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
