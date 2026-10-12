// The "Waiting on you" lane: which direct answer a ticket accepts (a choice, yes/no, done), how much
// of the board its answer unblocks, and the order the lane is shown in. Pure functions: the store
// and the tests use them as they are; the page only renders what they return.

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Later" offers these; the API accepts any whole number of days from 1 to MAX_SNOOZE_DAYS. */
export const SNOOZE_CHOICES = [1, 7, 30];
export const MAX_SNOOZE_DAYS = 90;
export const ANSWERS = ['option', 'yes', 'no', 'done', 'later', 'decline'];

/** Kinds answered in the session itself (a permission prompt, a mirrored session): no button here. */
const SESSION_KINDS = ['session', 'permission', 'feedback'];
const CLOSED = ['done', 'cancelled'];
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const MAX_OPTIONS = 5;
const OPTION_LEN = 140;

const clean = (s) =>
  String(s ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A marker an author puts on the option they recommend: `(default)`, `(recommended)`, `★`. */
const MARK = /\s*(?:\((?:default|recommended|suggested|par d[ée]faut|recommand[ée]e?)\)|[★⭐])\s*/gi;

/**
 * The options of a decision, read from its body: lettered lines (`A) …`, `B. …`, `Option C: …`) in any
 * ticket; plain bullets and numbered lines too when the ticket is a decision. Two options at least.
 * Returns [{ id: 'A', text, marked }] in the order written.
 */
export function parseOptions(body, { loose = false } = {}) {
  const text = String(body ?? '').replace(/```[\s\S]*?```/g, ' ');
  const out = [];
  for (const line of text.split('\n')) {
    const lettered = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:option\s+)?([A-Ea-e])(?:\*\*)?\s*[.):]\s+(.{2,})$/i.exec(line);
    const plain = loose ? /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.{3,})$/.exec(line) : null;
    if (!lettered && !plain) continue;
    if (out.length >= MAX_OPTIONS) break;
    const raw = lettered ? lettered[2] : plain[1];
    const marked = new RegExp(MARK.source, 'i').test(raw);
    const t = clean(raw.replace(MARK, ' ')).slice(0, OPTION_LEN);
    if (t) out.push({ id: lettered ? lettered[1].toUpperCase() : String.fromCharCode(65 + out.length), text: t, marked });
  }
  // Lettered lines must read A, B, C…: a stray "B." in a paragraph is not a list.
  if (out.length < 2) return [];
  if (out.some((o, i) => o.id !== String.fromCharCode(65 + i))) return [];
  return out;
}

const DEFAULT_SENTENCE = /\b(?:by default|default(?: is| choice)?|i(?:'ll| will) (?:go with|assume|pick|do)|i (?:recommend|suggest|propose|would pick)|recommended|i(?:'ll| will) go ahead|no (?:answer|reply|response)|if you say nothing|if you (?:do not|don't) (?:answer|reply|say anything)|sans r[ée]ponse|par d[ée]faut|je (?:propose|recommande|pars sur|ferai|ferais))\b/i;

/** The sentence of the body that says what happens by default, or ''. */
function defaultSentence(body) {
  const text = String(body ?? '').replace(/```[\s\S]*?```/g, ' ');
  for (const s of text.split(/(?<=[.!?…])\s+|\n+/)) if (DEFAULT_SENTENCE.test(s)) return clean(s);
  return '';
}

/** Which option the default sentence points at: a marked option, a letter, a number, or a quoted text. */
function defaultOption(options, body) {
  const marked = options.find((o) => o.marked);
  if (marked) return marked.id;
  const s = defaultSentence(body);
  if (!s) return null;
  // The letter must be an upper-case token ("recommend a new…" does not point at A).
  const upper = (x) => x && x === x.toUpperCase() && options.some((o) => o.id === x);
  for (const m of s.matchAll(/\b(?:option|choice|go with|pick|choose|take|recommend(?:ed)?|suggest|propose|default(?: is| choice)?|prends|choisis|sur|d[ée]faut(?: est)?)\b[\s:=]*\(?([A-Ea-e])\b/gi)) if (upper(m[1])) return m[1];
  const after = /\b([A-E])\)?\s*(?:by default|par d[ée]faut)\b/.exec(s);
  if (after && upper(after[1])) return after[1];
  const num = /\boption\s+(\d)\b/i.exec(s);
  if (num && options[Number(num[1]) - 1]) return options[Number(num[1]) - 1].id;
  const low = s.toLowerCase();
  const byText = options.filter((o) => o.text.length >= 4 && low.includes(o.text.toLowerCase().slice(0, 24)));
  return byText.length === 1 ? byText[0].id : null;
}

// ---- the "what we need from you" block ---------------------------------------------------------------
// A shared format: an author (an agent, a harness) writes up to three recognised lines in the body of a
// ticket, in English or in French. Nothing else of the body is interpreted.
//   Ask: one sentence                        | Ce que j'attends de toi : une phrase
//   Options: A) … — consequence ; B) … — consequence (default: B)      | Options : … (défaut : B)
//   If no answer: what happens, and when     | Sans réponse : ce qui se passe, et quand

const LINE_LABELS = {
  question: /(?:ask|ce que j['’]attends de toi)/,
  options: /options?/,
  fallback: /(?:if no (?:answer|reply|response)|sans r[ée]ponse)/,
};
const labelLine = (key) => new RegExp(`^\\s*(?:[-*>•]\\s+)?[*_]{0,2}\\s*${LINE_LABELS[key].source}\\s*:\\s*[*_]{0,2}\\s*(.*)$`, 'i');
const LINE_RE = Object.fromEntries(Object.keys(LINE_LABELS).map((k) => [k, labelLine(k)]));
const DEFAULT_TAIL = /\(?\s*(?:default|d[ée]faut|par d[ée]faut)\s*:\s*([A-Ea-e])\s*\)?\s*[.;]?\s*$/i;
const OPT_ITEM = /^\s*(?:\*\*)?([A-Ea-e])(?:\*\*)?\s*[.)]\s*(.+)$/;
const ASK_TEXT = 300;
const CONSEQUENCE_SPLIT = /\s+[—–]\s+|\s+-\s+/;

/** "Provider B — slightly higher fees (recommended)" → { text, consequence }. Spaced dashes only. */
function splitOption(raw) {
  const t = clean(raw);
  const m = CONSEQUENCE_SPLIT.exec(t);
  if (!m) return { text: t.slice(0, OPTION_LEN), consequence: '' };
  return { text: t.slice(0, m.index).slice(0, OPTION_LEN), consequence: t.slice(m.index + m[0].length).slice(0, OPTION_LEN * 2) };
}

/**
 * Reads the block out of a ticket body. Case, spaces before the colon, bold markers and a leading
 * bullet are tolerated; a code fence is skipped; the first line of each kind counts.
 * Returns { question, options: [{ id, text, consequence }], defaut: 'B' | null, sansReponse } or null
 * when the body holds none of it (options is [] when the line is absent or is not a lettered list).
 */
export function parseAskBlock(body) {
  const lines = String(body ?? '').replace(/```[\s\S]*?```/g, '\n').split('\n');
  let question = '';
  let optionsLine = null;
  let optionsAt = -1;
  let sansReponse = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!question && (m = LINE_RE.question.exec(line))) question = clean(m[1]).slice(0, ASK_TEXT);
    else if (optionsLine === null && (m = LINE_RE.options.exec(line))) { optionsLine = m[1]; optionsAt = i; }
    else if (!sansReponse && (m = LINE_RE.fallback.exec(line))) sansReponse = clean(m[1]).slice(0, ASK_TEXT);
  }
  let options = [];
  let defaut = null;
  if (optionsLine !== null) {
    // The options may sit on the line itself ("A) … ; B) …") or on the lettered lines that follow it.
    let text = optionsLine;
    for (let j = optionsAt + 1; j < lines.length && OPT_ITEM.test(lines[j]); j++) text += ` ; ${lines[j].trim()}`;
    const tail = DEFAULT_TAIL.exec(text);
    if (tail) { defaut = tail[1].toUpperCase(); text = text.slice(0, tail.index); }
    const parts = text.split(/\s*;\s*(?=(?:\*\*)?[A-Ea-e](?:\*\*)?\s*[.)]\s)/);
    for (const part of parts.slice(0, MAX_OPTIONS)) {
      const m = OPT_ITEM.exec(part);
      if (!m) continue;
      const inner = DEFAULT_TAIL.exec(m[2]);
      if (inner) { defaut = defaut || inner[1].toUpperCase(); }
      const marked = new RegExp(MARK.source, 'i').test(m[2]);
      const o = splitOption(m[2].replace(DEFAULT_TAIL, '').replace(MARK, ' '));
      if (!o.text) continue;
      options.push({ id: m[1].toUpperCase(), ...o });
      if (marked && !defaut) defaut = m[1].toUpperCase();
    }
    // Lettered A, B, C… in order, two at least: otherwise the line is prose, not a list of options.
    if (options.length < 2 || options.some((o, i) => o.id !== String.fromCharCode(65 + i))) options = [];
    if (!options.some((o) => o.id === defaut)) defaut = null;
  }
  if (!question && !options.length && !sansReponse) return null;
  return { question, options, defaut, sansReponse };
}

/** What the API gives a ticket: the block read from its body (+ `complete`) and the gesture its buttons take. */
export function askView(t) {
  const gesture = askOf(t);
  const block = parseAskBlock(t?.body);
  return { gesture, ask: block ? { ...block, complete: askComplete(block, gesture) } : null };
}

/**
 * May the card of the lane carry the answer buttons? Only when the block is complete: a question, a way
 * to answer (options, or a yes/no or an action to mark done) and what happens when nobody answers.
 * Otherwise the card has one discreet "Reply" link and the buttons live in the open ticket.
 */
export function askComplete(ask, gesture) {
  if (!ask || !gesture || !ask.question || !ask.sansReponse) return false;
  if (gesture.type === 'choice') return gesture.options.length >= 2;
  return gesture.type === 'yesno' || gesture.type === 'done';
}

const YES_NO_TITLE = /^\s*(?:do|does|did|is|are|was|were|can|could|should|shall|will|would|may|might|must|have|has|ok to|okay to|ok if|go ahead|shall we|should we|est-ce|peut-on|doit-on|faut-il|veux-tu|tu veux|on peut|on y va|je peux|ok pour|d'accord)\b/i;

/** Does the ticket ask for a yes or a no? A decision with no listed options does; a question that reads like one. */
function isYesNo(t) {
  if (t.kind === 'decision') return true;
  return /\?\s*$/.test(String(t.title ?? '').trim()) && YES_NO_TITLE.test(String(t.title ?? ''));
}

function yesNoDefault(body) {
  const s = defaultSentence(body);
  if (!s) return null;
  // What happens, not the condition ("no answer in 48 h:", "if you do not reply,").
  const will = /\b(?:i(?:'ll| will| would)|je)\b.*$/i.exec(s);
  const act = will ? will[0] : s.replace(/^(?:if|when|unless|faute de|sans)\b[^,:;]*[,:;]?/i, '').replace(/\bno (?:answer|reply|response)\b[^,:;]*[,:;]?/i, '') || s;
  if (/\b(?:no|non|not|don't|do not|skip|reject|decline|pas)\b/i.test(act)) return 'no';
  if (/\b(?:yes|oui|go ahead|proceed|approve|ok|okay|do it|d'accord)\b/i.test(act)) return 'yes';
  return null;
}

/**
 * What a ticket on the "Waiting on you" lane accepts, or null when it has to be answered somewhere
 * else (a session prompt, a ticket that is not his):
 *   { type: 'choice', options: [{ id, text }], default: 'B' | null }
 *   { type: 'yesno', default: 'yes' | 'no' | null }
 *   { type: 'done' }
 * "Later" and "Not for me" are always offered next to these.
 */
export function askOf(t) {
  if (!t || t.assignee !== 'user' || CLOSED.includes(t.status)) return null;
  if (t.source === 'hook' || SESSION_KINDS.includes(t.kind)) return null;
  // The block's own options win over what is inferred from the body.
  const block = parseAskBlock(t.body);
  if (block?.options.length) return { type: 'choice', options: block.options.map(({ id, text }) => ({ id, text })), default: block.defaut || defaultOption(block.options.map((o) => ({ ...o, marked: false })), t.body) };
  const options = parseOptions(t.body, { loose: t.kind === 'decision' });
  if (options.length) return { type: 'choice', options: options.map(({ id, text }) => ({ id, text })), default: defaultOption(options, t.body) };
  if (isYesNo(t)) return { type: 'yesno', default: yesNoDefault(t.body) || (block?.sansReponse ? yesNoDefault(block.sansReponse) : null) };
  if (t.kind === 'question') return { type: 'none' };
  return { type: 'done' };
}

/** A ticket never claims more than this many waiting jobs: the label is a hint, not a way to jump the queue. */
export const MAX_JOBS_WAITING = 9;

/** Labels a job-waiting convention: `blocks-job` (one job waits on this ticket) or `blocks-jobs:3`. At most MAX_JOBS_WAITING. */
export function jobsWaiting(labels) {
  let n = 0;
  for (const l of Array.isArray(labels) ? labels : []) {
    if (l === 'blocks-job') n += 1;
    const m = /^blocks-jobs:(\d{1,3})$/.exec(String(l));
    if (m) n += Number(m[1]);
  }
  return Math.min(n, MAX_JOBS_WAITING);
}

/** Is `actor` one of the configured trusted ids, or a sub-actor under one (`id/job-42`)? */
export function trustedActor(actor, ids) {
  return (ids || []).some((id) => id && (actor === id || String(actor).startsWith(id + '/')));
}

/** Lane order: what the answer unblocks first (most first), then P0 → P3, then the oldest wait. */
export function compareWaiting(a, b) {
  const ua = a.unlocks || 0;
  const ub = b.unlocks || 0;
  if (Boolean(ua) !== Boolean(ub)) return ua ? -1 : 1;
  if (ua !== ub) return ub - ua;
  const pa = PRIORITY_RANK[a.priority] ?? 4;
  const pb = PRIORITY_RANK[b.priority] ?? 4;
  if (pa !== pb) return pa - pb;
  return (a.status_at ?? 0) - (b.status_at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);
}

/** Who gets the ticket back: its creator when that is another actor, else Claude. */
export function handbackOf(t, actor) {
  const c = t?.created_by;
  return c && c !== 'user' && c !== 'hook' && c !== actor ? c : 'claude';
}

/**
 * What one button does to a ticket: the comment he is deemed to have typed, and the fields it moves.
 * Every move is reversible (nothing is deleted or closed for good: "Done" is a status you can reopen).
 * `answer` is one of ANSWERS; `arg` is the option id for 'option', the number of days for 'later'.
 * Returns { comment, fields } or { error }.
 */
export function planAnswer(t, answer, arg, { actor = 'user', now = Date.now() } = {}) {
  if (!ANSWERS.includes(answer)) return { error: `answer must be one of ${ANSWERS.join(', ')}` };
  const ask = askOf(t);
  if (!ask) return { error: 'this ticket is not waiting on a direct answer' };
  const back = handbackOf(t, actor);
  const answered = { status: 'in_progress', assignee: back, snoozed_until: null };
  if (answer === 'option') {
    const o = ask.type === 'choice' ? ask.options.find((x) => x.id === String(arg).toUpperCase()) : null;
    if (!o) return { error: 'unknown option' };
    return { comment: `Answer: ${o.id} — ${o.text}`, fields: answered };
  }
  if (answer === 'yes' || answer === 'no') {
    if (ask.type !== 'yesno') return { error: 'this ticket is not a yes/no question' };
    return { comment: `Answer: ${answer}`, fields: answered };
  }
  if (answer === 'done') {
    if (ask.type !== 'done') return { error: 'this ticket is not an action to mark done' };
    return { comment: 'Answer: done', fields: { status: 'done', snoozed_until: null } };
  }
  if (answer === 'later') {
    const days = Number(arg);
    if (!Number.isInteger(days) || days < 1 || days > MAX_SNOOZE_DAYS) return { error: `days must be a whole number from 1 to ${MAX_SNOOZE_DAYS}` };
    const until = now + days * DAY_MS;
    return { comment: `Later: not before ${new Date(until).toISOString().slice(0, 10)}, no reminder until then`, fields: { snoozed_until: until } };
  }
  return { comment: `Not for me: handed back to ${back}`, fields: { assignee: back, snoozed_until: null } };
}
