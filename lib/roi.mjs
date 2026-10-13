// Scores on the "Waiting on you" lane (0.5.12): an installation's agent, which knows what each of your
// answers lets its agents do next, posts a score and a one-line reason per ticket, plus one line for the
// whole lane ("what waits on you right now"). The board stores them as one snapshot, orders the lane by
// score and shows "⚡ ROI" with the reason. It never computes a score itself: how much an answer is
// worth is the installation's business (its jobs, its costs, its priorities), not the board's.
//
//   PUT /api/roi    { summary?, scores: [{ key, score, note? }] }   replaces the whole snapshot
//   GET /api/roi    { summary, at, actor, scores, stale }
//
// Who may post: the owner, or an agent named in BOARD_JOB_ACTORS (sub-actors included), the same
// trust as the `blocks-job` label: nobody else can climb the lane. A snapshot older than ROI_TTL_MS
// is ignored (an installation that stops posting must not leave old scores ordering the lane forever).
// Pure functions: the store keeps the rows, the server checks who is calling.

/** At most this many scored tickets in one snapshot. */
export const MAX_ROI_ITEMS = 500;
/** The reason shown with a score, one line. */
export const MAX_ROI_NOTE = 200;
/** The line shown at the head of the lane. */
export const MAX_ROI_SUMMARY = 300;
/** Highest score accepted. */
export const MAX_ROI_SCORE = 1_000_000;
/** A snapshot older than this is not shown and does not order the lane. */
export const ROI_TTL_MS = 6 * 3600 * 1000;

/** One line of plain text: control and bidi characters dropped, spaces collapsed, cut at `max`. */
export function oneLine(v, max) {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * Checks a snapshot. Returns { value: { summary, scores } } or { error }. A key seen twice keeps its
 * last score. `summary` null (or absent, or empty) means no line at the head of the lane.
 */
export function sanitizeRoiInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const list = body.scores ?? [];
  if (!Array.isArray(list)) return { error: 'scores must be a list' };
  if (list.length > MAX_ROI_ITEMS) return { error: `at most ${MAX_ROI_ITEMS} scores` };
  const byKey = new Map();
  for (const [i, raw] of list.entries()) {
    if (!raw || typeof raw !== 'object') return { error: `scores[${i}] must be an object` };
    const key = String(raw.key ?? '').trim();
    if (!/^[\w-]{1,64}$/.test(key)) return { error: `scores[${i}].key must be a ticket key` };
    const score = Number(raw.score);
    if (raw.score === null || raw.score === '' || typeof raw.score === 'boolean' || !Number.isFinite(score) || score < 0 || score > MAX_ROI_SCORE) return { error: `scores[${i}].score must be a number from 0 to ${MAX_ROI_SCORE}` };
    byKey.set(key.toUpperCase(), { key, score: Math.round(score * 10) / 10, note: oneLine(raw.note, MAX_ROI_NOTE) || null });
  }
  const summary = body.summary === undefined || body.summary === null ? null : oneLine(body.summary, MAX_ROI_SUMMARY) || null;
  return { value: { summary, scores: [...byKey.values()] } };
}

/** Is a snapshot taken at `at` still shown at `now`? */
export function roiFresh(at, now, ttl = ROI_TTL_MS) {
  return Number.isFinite(Number(at)) && Number(at) > 0 && now - Number(at) <= ttl;
}

/** How a score reads on a card: an integer from 10 up, one decimal below. */
export function formatRoi(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '';
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}
