// The search bar's query language (0.10.0). Pure, no dependency, no database: parseQuery turns the
// text typed in the bar into a tree and a list of readable problems; compileQuery turns the tree into
// a SQL condition the store adds to its WHERE clause.
//
//   bug login                      every word, anywhere in the ticket (as before)
//   "exact phrase"                 the words side by side
//   status:todo p:P1 label:vigie   filters on a field
//   -label:noise  NOT type:session leave out
//   status:todo,review             any of these values
//   p:P0 OR label:urgent           either side; parentheses group: (a OR b) c
//   p:<=P1  updated:<7d  created:2026-10-01..2026-10-15   comparisons and ranges
//   is:open is:blocked  no:priority  has:pr  assignee:me  #vigie
//
// Plain words with nothing else keep the old search exactly (store.where's `q`): nobody has to learn
// anything. Errors never empty the board in silence: a filter that cannot be read is left out and
// named; an unknown field is searched as text and named, with the closest field when there is one.

import { CLOSED_STATUSES, GESTURE_KINDS, KINDS, OPEN_STATUSES, ORIGINS, PRIORITIES, SOURCES, STATUSES, normalizePriority } from './core.mjs';

export const MAX_QUERY_CHARS = 500;
const MAX_NODES = 60;
const DAY = 24 * 60 * 60 * 1000;

const STATUS_ALIASES = {
  open: OPEN_STATUSES,
  closed: CLOSED_STATUSES,
  progress: ['in_progress'],
  in_progress: ['in_progress'],
  doing: ['in_progress'],
  wip: ['in_progress'],
  waiting: ['waiting_on_user'],
  waiting_on_user: ['waiting_on_user'],
  hold: ['on_hold'],
  on_hold: ['on_hold'],
  canceled: ['cancelled'],
};
const KNOWN_KINDS = [...new Set([...KINDS, ...GESTURE_KINDS, 'decision'])];
const IS_VALUES = ['open', 'closed', 'blocked', 'unblocked', 'archived', ...STATUSES];
const HAS_VALUES = ['priority', 'label', 'repo', 'branch', 'parent', 'session', 'importance', 'pr', 'blocker', 'children'];
const HAS_ALIASES = { labels: 'label', priorities: 'priority', prio: 'priority', p: 'priority', blockers: 'blocker', blocked_by: 'blocker', child: 'children', subtickets: 'children', project: 'repo' };

/** The fields, their aliases (French ones too: the page is bilingual) and how a value is read. */
export const FIELDS = [
  { name: 'status', aliases: ['s', 'state', 'statut', 'etat'], type: 'status' },
  { name: 'priority', aliases: ['p', 'prio', 'priorite'], type: 'priority' },
  { name: 'assignee', aliases: ['assigned', 'to', 'assigne', 'pour'], type: 'actor', column: 't.assignee' },
  { name: 'author', aliases: ['by', 'created_by', 'creator', 'auteur', 'par'], type: 'actor', column: 't.created_by' },
  { name: 'actor', aliases: ['who', 'acteur'], type: 'actor' },
  { name: 'label', aliases: ['labels', 'tag', 'tags', 'l', 'etiquette'], type: 'label' },
  { name: 'type', aliases: ['kind'], type: 'kind' },
  { name: 'subtype', aliases: ['sous_type'], type: 'word', column: 't.subtype' },
  { name: 'importance', aliases: ['imp'], type: 'importance' },
  { name: 'repo', aliases: ['project', 'projet', 'depot'], type: 'repo' },
  { name: 'branch', aliases: ['br', 'branche'], type: 'word', column: 't.branch' },
  { name: 'machine', aliases: ['host'], type: 'word', column: 't.machine' },
  { name: 'session', aliases: [], type: 'word', column: 't.session_id' },
  { name: 'origin', aliases: [], type: 'origin' },
  { name: 'source', aliases: [], type: 'source' },
  { name: 'parent', aliases: [], type: 'key' },
  { name: 'key', aliases: ['id', 'cle'], type: 'key' },
  { name: 'title', aliases: ['titre'], type: 'contains', column: 't.title' },
  { name: 'body', aliases: ['description', 'corps'], type: 'contains', column: 't.body' },
  { name: 'created', aliases: ['cree', 'creee'], type: 'date', column: 't.created_at' },
  { name: 'updated', aliases: ['modified', 'maj', 'modifie'], type: 'date', column: 't.updated_at' },
  { name: 'closed', aliases: ['ferme', 'fermee'], type: 'date', column: 't.closed_at' },
  { name: 'is', aliases: ['est'], type: 'is' },
  { name: 'has', aliases: [], type: 'has' },
  { name: 'no', aliases: ['sans', 'missing'], type: 'no' },
];
const BY_NAME = new Map();
for (const f of FIELDS) for (const n of [f.name, ...f.aliases]) BY_NAME.set(n, f);

/** Lower case, no accents, "-" read as "_": "Priorité" → "priorite", "in-progress" → "in_progress". */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/-/g, '_');
}

/** Edit distance where swapping two neighbours counts one (the commonest typo: "stauts"), small strings only. */
export function distance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[m][n];
}

/** The closest of `names` to `word`, or null when none is close enough to be a typo. */
export function closest(word, names) {
  const w = fold(word);
  if (!w) return null;
  let best = null;
  let bestD = Infinity;
  for (const n of names) {
    const d = n.startsWith(w) && w.length >= 3 ? 0.5 : distance(w, n);
    if (d < bestD) (best = n), (bestD = d);
  }
  const max = w.length <= 3 ? 1 : w.length <= 6 ? 2 : 3;
  return bestD <= max ? best : null;
}

const FIELD_NAMES = FIELDS.map((f) => f.name);

// ---- tokens --------------------------------------------------------------------------------------

/**
 * Tokens: ( ) OR AND NOT, and terms. A term keeps where it sits in the text (start, end), a leading
 * "-" (neg), and the parts of `name:value` when it has the form, with value quoted or not.
 */
function tokenize(text, errors) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      out.push({ t: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    const start = i;
    let neg = false;
    // A minus before a letter, a quote, # or ( excludes; before a digit it stays a word (-5, -1.5).
    if ((c === '-' || c === '!') && i + 1 < n && /[\p{L}"#(_]/u.test(text[i + 1])) {
      neg = true;
      i++;
      if (text[i] === '(') {
        out.push({ t: 'NOT', start, end: i });
        continue;
      }
    }
    // A term: runs until a space or a parenthesis outside quotes. "..." anywhere inside is one piece.
    let raw = '';
    let quoted = false;
    let quotedAt = -1;
    while (i < n && !/\s/.test(text[i]) && text[i] !== '(' && text[i] !== ')') {
      if (text[i] === '"') {
        const close = text.indexOf('"', i + 1);
        if (quotedAt < 0) quotedAt = raw.length;
        quoted = true;
        if (close < 0) {
          errors.push({ code: 'unclosed_quote', start: i, end: n });
          raw += text.slice(i + 1);
          i = n;
          break;
        }
        raw += text.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      raw += text[i];
      i++;
    }
    const end = i;
    if (!quoted && !neg && (raw === 'OR' || raw === '|' || raw === '||')) out.push({ t: 'OR', start, end });
    else if (!quoted && !neg && (raw === 'AND' || raw === '&&')) out.push({ t: 'AND', start, end });
    else if (!quoted && !neg && raw === 'NOT') out.push({ t: 'NOT', start, end });
    else if (raw || quoted) out.push({ t: 'term', raw, neg, quoted, quotedAt, start, end });
  }
  return out;
}

// ---- tree ----------------------------------------------------------------------------------------

/**
 * Parse a query. `{ node, text, errors, plain, archived, kinds }`:
 * - plain: true when the query is only words (the old search runs on it, unchanged);
 * - text: the plain words at the top level (kept for the old search: ticket keys, prefix match);
 * - node: the rest as a tree (and / or / not / text / field), or null;
 * - errors: `{ code, start, end, field?, value?, suggestion?, fix? }`, in the order of the text;
 * - fix: the whole query with every suggestion applied, when each error has one.
 */
export function parseQuery(input) {
  const text = String(input ?? '').slice(0, MAX_QUERY_CHARS);
  const errors = [];
  const tokens = tokenize(text, errors);
  let pos = 0;
  let count = 0;
  const peek = () => tokens[pos];

  // Precedence as in Gmail: OR joins the two terms beside it, before the implicit AND of the spaces.
  // `status:todo label:a OR label:b` = status:todo AND (label:a OR label:b). Parentheses for the rest.
  function parseAnd(depth) {
    const items = [];
    for (;;) {
      const tk = peek();
      if (!tk) break;
      if (tk.t === ')') {
        if (depth > 0) break;
        errors.push({ code: 'unmatched_paren', start: tk.start, end: tk.end });
        pos++;
        continue;
      }
      if (tk.t === 'AND') {
        pos++;
        continue;
      }
      if (tk.t === 'OR') {
        // An OR with nothing on its left.
        errors.push({ code: 'dangling_or', start: tk.start, end: tk.end });
        pos++;
        continue;
      }
      const u = parseOr(depth);
      if (u) items.push(u);
    }
    if (!items.length) return null;
    return items.length === 1 ? items[0] : { type: 'and', items };
  }

  function parseOr(depth) {
    const first = parseUnary(depth);
    const items = first ? [first] : [];
    while (peek()?.t === 'OR') {
      const tk = tokens[pos++];
      const nx = peek();
      const next = nx && nx.t !== ')' && nx.t !== 'OR' && nx.t !== 'AND' ? parseUnary(depth) : null;
      if (!next || !items.length) errors.push({ code: 'dangling_or', start: tk.start, end: tk.end });
      if (next) items.push(next);
    }
    if (!items.length) return null;
    return items.length === 1 ? items[0] : { type: 'or', items };
  }

  function parseUnary(depth) {
    const tk = peek();
    if (!tk) return null;
    if (tk.t === 'NOT') {
      pos++;
      const inner = parseUnary(depth);
      return inner ? { type: 'not', item: inner } : null;
    }
    if (tk.t === '(') {
      pos++;
      const inner = parseAnd(depth + 1);
      if (peek()?.t === ')') pos++;
      else errors.push({ code: 'unmatched_paren', start: tk.start, end: tk.end });
      return inner;
    }
    pos++;
    const node = term(tk);
    if (!node) return null;
    if (++count > MAX_NODES) {
      if (count === MAX_NODES + 1) errors.push({ code: 'too_many', start: tk.start, end: text.length });
      return null;
    }
    return tk.neg ? { type: 'not', item: node } : node;
  }

  function term(tk) {
    const raw = tk.raw;
    // A phrase in quotes, from its first character: text, side by side.
    if (tk.quoted && tk.quotedAt === 0) return { type: 'text', value: raw, phrase: true };
    // #label
    if (!tk.quoted && /^#[\p{L}_]/u.test(raw)) return field(tk, BY_NAME.get('label'), raw.slice(1), false, 'label');
    const m = /^([\p{L}_][\p{L}\p{N}_-]*):(.*)$/su.exec(raw);
    // A quote opened before the colon, a URL (http://…) or a time (10:30) are text.
    if (!m || (tk.quoted && tk.quotedAt <= m[1].length) || /^\/\//.test(m[2])) return words(raw);
    const name = fold(m[1]);
    const def = BY_NAME.get(name);
    if (!def) {
      const suggestion = closest(name, [...BY_NAME.keys()]);
      const canonical = suggestion ? BY_NAME.get(suggestion).name : null;
      errors.push({
        code: 'unknown_field',
        start: tk.start + (tk.neg ? 1 : 0),
        end: tk.start + (tk.neg ? 1 : 0) + m[1].length,
        field: m[1],
        suggestion: canonical,
        replace: canonical,
      });
      return words(raw);
    }
    return field(tk, def, m[2], tk.quoted, m[1]);
  }

  function words(raw) {
    return raw.match(/[\p{L}\p{N}_]+/gu) ? { type: 'text', value: raw, phrase: false } : null;
  }

  function bad(tk, code, extra) {
    errors.push({ code, start: tk.start, end: tk.end, ...extra });
    return null;
  }

  /** One `name:value[,value…]` term → a field node, or null (and an error) when it cannot be read. */
  function field(tk, def, value, quoted, typed) {
    if (!value && !quoted) return bad(tk, 'empty_value', { field: def.name });
    const parts = quoted ? [value] : value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return bad(tk, 'empty_value', { field: def.name });
    const values = [];
    for (const part of parts) {
      const v = readValue(def, part, quoted, tk, typed);
      if (v === null) return null;
      values.push(...[v].flat());
    }
    return { type: 'field', field: def.name, values };
  }

  /** Suggest a value: replaces `wrong` by `right` in the term, for the "Did you mean" fix. */
  function badValue(tk, def, wrong, allowed, typed) {
    const suggestion = allowed ? closest(wrong, allowed) : null;
    return bad(tk, 'bad_value', { field: def.name, value: wrong, suggestion, allowed: allowed?.slice(0, 12), typed, replaceValue: suggestion ? [wrong, suggestion] : null });
  }

  function readValue(def, part, quoted, tk, typed) {
    const cmp = quoted ? null : /^(<=|>=|<|>|=)(.*)$/.exec(part);
    const op = cmp ? (cmp[1] === '=' ? 'eq' : cmp[1]) : 'eq';
    const body = cmp ? cmp[2] : part;
    const range = quoted ? null : /^(.+?)\.\.(.+)$/.exec(body);
    const ordered = def.type === 'priority' || def.type === 'date' || def.type === 'key';
    if ((op !== 'eq' || range) && !ordered) return bad(tk, 'bad_operator', { field: def.name, op: range ? '..' : cmp[1] });
    if (!body) return bad(tk, 'empty_value', { field: def.name });
    const f = fold(body);
    switch (def.type) {
      case 'status': {
        const list = STATUS_ALIASES[f] || (STATUSES.includes(f) ? [f] : null);
        return list ? { op: 'in', value: f, list } : badValue(tk, def, body, [...STATUSES, 'open', 'closed'], typed);
      }
      case 'priority': {
        const one = (s) => (fold(s) === 'none' ? 'none' : normalizePriority(s));
        if (range) {
          const a = one(range[1]);
          const b = one(range[2]);
          if (!a || !b || a === 'none' || b === 'none') return badValue(tk, def, !a || a === 'none' ? range[1] : range[2], PRIORITIES.map((p) => p.toLowerCase()), typed);
          return { op: 'in', value: body, list: priorityRange(a, b) };
        }
        const p = one(body);
        if (!p) return badValue(tk, def, body, [...PRIORITIES.map((x) => x.toLowerCase()), 'none'], typed);
        if (p === 'none') return op === 'eq' ? { op: 'in', value: 'none', list: ['none'] } : bad(tk, 'bad_operator', { field: def.name, op: cmp[1] });
        return { op: 'in', value: body, list: priorityCompare(p, op) };
      }
      case 'importance': {
        const v = f === 'none' ? 'none' : ['high', 'medium', 'low'].includes(f) ? f : null;
        return v ? { op: 'eq', value: v } : badValue(tk, def, body, ['high', 'medium', 'low', 'none'], typed);
      }
      case 'origin': {
        const v = f === 'local' ? 'terminal' : f === 'web' ? 'cloud' : f;
        return ORIGINS.includes(v) ? { op: 'eq', value: v } : badValue(tk, def, body, ORIGINS, typed);
      }
      case 'source':
        return SOURCES.includes(f) ? { op: 'eq', value: f } : badValue(tk, def, body, SOURCES, typed);
      case 'kind': {
        const v = body.toLowerCase();
        // Any short slug is a kind (a client may invent its own); a typo of a known one is named.
        // Not left out: it may be a kind of their own, so the filter runs and the hint says so.
        if (!KNOWN_KINDS.includes(v)) {
          const near = closest(v, KNOWN_KINDS);
          if (near) errors.push({ code: 'unknown_kind', start: tk.start, end: tk.end, field: def.name, value: body, suggestion: near, replaceValue: [body, near] });
        }
        return { op: 'eq', value: v };
      }
      case 'actor':
        if (f === 'me' || f === 'moi') return { op: 'me', value: 'me' };
        return { op: body.endsWith('*') ? 'prefix' : 'eq', value: body.replace(/\*$/, '') };
      case 'label':
        return { op: body.endsWith('*') ? 'prefix' : 'eq', value: body.toLowerCase().replace(/\*$/, '') };
      case 'repo':
      case 'word':
        if (f === 'none') return { op: 'none', value: 'none' };
        return { op: body.endsWith('*') ? 'prefix' : 'eq', value: body.replace(/\*$/, '') };
      case 'contains':
        return { op: 'contains', value: body };
      case 'key': {
        const num = (s) => {
          const k = /^(?:[A-Za-z]+-)?(\d{1,9})$/.exec(s.trim());
          return k ? Number(k[1]) : null;
        };
        if (range) {
          const a = num(range[1]);
          const b = num(range[2]);
          if (a === null || b === null) return bad(tk, 'bad_value', { field: def.name, value: body, example: 'ALV-12' });
          return { op: 'between', value: body, from: Math.min(a, b), to: Math.max(a, b) };
        }
        const k = num(body);
        if (k === null) return bad(tk, 'bad_value', { field: def.name, value: body, example: 'ALV-12' });
        return { op, value: k };
      }
      case 'date': {
        if (range) {
          const a = readDate(range[1]);
          const b = readDate(range[2]);
          if (!a || !b || a.rel || b.rel) return bad(tk, 'bad_date', { field: def.name, value: body });
          return { op: 'between', value: body, from: a, to: b };
        }
        const d = readDate(body);
        if (!d) return bad(tk, 'bad_date', { field: def.name, value: body });
        return { op, value: body, date: d };
      }
      case 'is': {
        // The status aliases (waiting, doing, wip, hold, canceled…) read as with status:.
        const alias = STATUS_ALIASES[f];
        const v = alias?.length === 1 ? alias[0] : f;
        return IS_VALUES.includes(v) ? { op: 'is', value: v } : badValue(tk, def, body, IS_VALUES, typed);
      }
      case 'has':
      case 'no': {
        const v = HAS_ALIASES[f] || f;
        return HAS_VALUES.includes(v) ? { op: def.type, value: v } : badValue(tk, def, body, HAS_VALUES, typed);
      }
    }
    return null;
  }

  const node = parseAnd(0);
  // Anything left (a stray ")" at the top) was reported by parseAnd.
  const top = node?.type === 'and' ? node.items : node ? [node] : [];
  const plainWord = (x) => x.type === 'text' && !x.phrase;
  // No syntax at all (even "!!" or "--", which hold no word): the old search, as it always ran.
  const plain = !errors.length && top.every(plainWord) && !tokens.some((t) => t.t !== 'term' || t.neg || t.quoted);
  const textWords = top.filter(plainWord).map((x) => x.value);
  const rest = top.filter((x) => !plainWord(x));
  const tree = rest.length === 0 ? null : rest.length === 1 ? rest[0] : { type: 'and', items: rest };
  errors.sort((a, b) => a.start - b.start);
  return {
    plain,
    text: textWords.join(' '),
    node: plain ? null : tree,
    errors: errors.map(({ replace, replaceValue, typed, ...e }) => e),
    fix: fixOf(text, errors),
    // A type: or is:archived asked for (not under a NOT) lifts the default cut of feedback / archived tickets;
    // `-type:session` keeps it.
    archived: asks(tree, (n) => n.field === 'is' && n.values.some((v) => v.value === 'archived')),
    kinds: asks(tree, (n) => n.field === 'type'),
  };
}

/** True when a field node matching `match` sits in the tree outside any negation. */
function asks(node, match) {
  if (!node || node.type === 'not' || node.type === 'text') return false;
  if (node.type === 'field') return match(node);
  return node.items.some((x) => asks(x, match));
}

/** The query with every suggestion applied, when every problem has one; else null. */
function fixOf(text, errors) {
  if (!errors.length || errors.some((e) => !e.replace && !e.replaceValue)) return null;
  let out = text;
  for (const e of [...errors].sort((a, b) => b.start - a.start)) {
    if (e.replace) out = out.slice(0, e.start) + e.replace + out.slice(e.end);
    else {
      const [wrong, right] = e.replaceValue;
      const seg = out.slice(e.start, e.end);
      const at = seg.lastIndexOf(wrong);
      if (at < 0) return null;
      out = out.slice(0, e.start) + seg.slice(0, at) + right + seg.slice(at + wrong.length) + out.slice(e.end);
    }
  }
  return out === text ? null : out;
}

const rank = (p) => PRIORITIES.indexOf(p);

/** p:<P2 is more urgent than P2 (P0, P1): a lower number comes first, as everywhere on the board. */
function priorityCompare(p, op) {
  const r = rank(p);
  if (op === 'eq') return [p];
  return PRIORITIES.filter((x) => (op === '<' ? rank(x) < r : op === '<=' ? rank(x) <= r : op === '>' ? rank(x) > r : rank(x) >= r));
}

function priorityRange(a, b) {
  const [lo, hi] = [rank(a), rank(b)].sort((x, y) => x - y);
  return PRIORITIES.slice(lo, hi + 1);
}

/**
 * A date: an ISO day (2026-10-01), an ISO date-time, today / yesterday, or an age (30m, 12h, 7d, 2w,
 * 3mo, 1y). `{ day: ms }` for a day (the whole day counts), `{ at: ms }` for an instant,
 * `{ rel: ms }` for an age.
 */
export function readDate(s) {
  const v = fold(s);
  if (v === 'today' || v === 'aujourdhui') return { today: 0 };
  if (v === 'yesterday' || v === 'hier') return { today: -1 };
  const age = /^(\d{1,4})(m|min|h|d|j|w|sem|mo|mois|y|an)$/.exec(v);
  if (age) {
    const n = Number(age[1]);
    const unit = { m: 60e3, min: 60e3, h: 3600e3, d: DAY, j: DAY, w: 7 * DAY, sem: 7 * DAY, mo: 30 * DAY, mois: 30 * DAY, y: 365 * DAY, an: 365 * DAY }[age[2]];
    return { rel: n * unit };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(ms) ? { day: ms } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? { at: ms } : null;
  }
  return null;
}

/** [from, to) in ms for a date value, `now` for ages and today. */
function span(d, now) {
  if (d.rel !== undefined) return [now - d.rel, now - d.rel];
  if (d.today !== undefined) {
    const start = Math.floor(now / DAY) * DAY + d.today * DAY;
    return [start, start + DAY];
  }
  if (d.day !== undefined) return [d.day, d.day + DAY];
  return [d.at, d.at];
}

// ---- SQL -----------------------------------------------------------------------------------------

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * Compile a tree from parseQuery into `{ sql, params }`. The context brings what the store knows:
 * `now`, `me` (who "me" is), `fts` (full-text index present), `ftsQuery(words)`, `blockedSql`, `archivedSql`.
 */
export function compileQuery(node, ctx) {
  const params = [];
  const sql = walk(node);
  return { sql, params };

  function walk(n) {
    if (n.type === 'and') return '(' + n.items.map(walk).join(' AND ') + ')';
    if (n.type === 'or') return '(' + n.items.map(walk).join(' OR ') + ')';
    if (n.type === 'not') return `NOT ${walk(n.item)}`;
    if (n.type === 'text') return text(n);
    return field(n);
  }

  function text(n) {
    if (ctx.fts) {
      const words = n.value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
      const q = n.phrase ? `"${words.join(' ')}"` : ctx.ftsQuery(n.value);
      if (q && words.length) {
        params.push(q);
        return 't.id IN (SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH ?)';
      }
    }
    // Without the index: the phrase (or each word) anywhere in the title, body, labels or a comment.
    const parts = n.phrase ? [n.value] : n.value.match(/[\p{L}\p{N}_]+/gu) || [n.value];
    return (
      '(' +
      parts
        .map((p) => {
          const like = `%${likeEscape(p)}%`;
          params.push(like, like, like, like);
          return "(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR t.labels LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ticket_events e WHERE e.ticket_id = t.id AND e.type = 'comment' AND e.text LIKE ? ESCAPE '\\'))";
        })
        .join(' AND ') +
      ')'
    );
  }

  function any(list) {
    return list.length === 1 ? list[0] : '(' + list.join(' OR ') + ')';
  }

  function eqOrPrefix(col, v, nocase = true) {
    if (v.op === 'none') return `(${col} IS NULL OR ${col} = '')`;
    if (v.op === 'prefix') {
      params.push(likeEscape(v.value) + '%');
      return `${col} LIKE ? ESCAPE '\\'`;
    }
    params.push(v.value);
    return nocase ? `${col} = ? COLLATE NOCASE` : `${col} = ?`;
  }

  function field(n) {
    const def = FIELDS.find((f) => f.name === n.field);
    return any(n.values.map((v) => one(def, v)));
  }

  function one(def, v) {
    switch (def.type) {
      case 'status': {
        params.push(...v.list);
        return `t.status IN (${v.list.map(() => '?').join(', ')})`;
      }
      case 'priority': {
        const real = v.list.filter((x) => x !== 'none');
        const parts = [];
        if (real.length) {
          params.push(...real);
          parts.push(`t.priority IN (${real.map(() => '?').join(', ')})`);
        }
        if (v.list.includes('none')) parts.push('t.priority IS NULL');
        return parts.length ? any(parts) : '0';
      }
      case 'importance':
        if (v.value === 'none') return 't.importance IS NULL';
        params.push(v.value);
        return 't.importance = ?';
      case 'origin':
        params.push(v.value);
        return 't.origin = ?';
      case 'source':
        params.push(v.value);
        return 't.source = ?';
      case 'kind':
        params.push(v.value);
        return "COALESCE(t.kind, 'action') = ?";
      case 'actor': {
        const val = v.op === 'me' ? { op: 'eq', value: ctx.me || 'user' } : v;
        if (def.column) return eqOrPrefix(def.column, val);
        // An actor's tickets: the ones it holds and the ones it opened (as the Actor filter).
        return '(' + eqOrPrefix('t.assignee', val) + ' OR ' + eqOrPrefix('t.created_by', val) + ')';
      }
      case 'label':
        if (v.op === 'prefix') {
          params.push(likeEscape(v.value) + '%');
          return "EXISTS (SELECT 1 FROM json_each(t.labels) WHERE lower(value) LIKE ? ESCAPE '\\')";
        }
        params.push(v.value);
        return 'EXISTS (SELECT 1 FROM json_each(t.labels) WHERE lower(value) = ?)';
      case 'repo':
        if (v.op === 'none' || v.op === 'prefix' || v.value.includes('/')) return eqOrPrefix('t.repo', v);
        // "api" is the repo name under any owner, as the Repo filter.
        params.push(v.value, '%/' + likeEscape(v.value));
        return "(t.repo = ? COLLATE NOCASE OR t.repo LIKE ? ESCAPE '\\')";
      case 'word':
        return eqOrPrefix(def.column, v);
      case 'contains':
        params.push(`%${likeEscape(v.value)}%`);
        return `${def.column} LIKE ? ESCAPE '\\'`;
      case 'key': {
        const col = def.name === 'parent' ? '(SELECT p.seq FROM tickets p WHERE p.id = t.parent_id)' : 't.seq';
        if (v.op === 'between') {
          params.push(v.from, v.to);
          return `${col} BETWEEN ? AND ?`;
        }
        params.push(v.value);
        return `${col} ${v.op === 'eq' ? '=' : v.op} ?`;
      }
      case 'date':
        return dateSql(def.column, v);
      case 'is':
        if (v.value === 'open') return `t.status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(', ')})`;
        if (v.value === 'closed') return `t.status IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(', ')})`;
        if (v.value === 'blocked') return ctx.blockedSql;
        if (v.value === 'unblocked') return `NOT ${ctx.blockedSql}`;
        if (v.value === 'archived') return ctx.archivedSql;
        params.push(v.value);
        return 't.status = ?';
      case 'has':
      case 'no': {
        const sql = hasSql(v.value);
        return v.op === 'no' ? `NOT ${sql}` : sql;
      }
    }
    return '1';
  }

  function hasSql(what) {
    if (what === 'priority') return '(t.priority IS NOT NULL)';
    if (what === 'label') return "(json_array_length(COALESCE(t.labels, '[]')) > 0)";
    if (what === 'repo') return "(t.repo IS NOT NULL AND t.repo <> '')";
    if (what === 'branch') return "(t.branch IS NOT NULL AND t.branch <> '')";
    if (what === 'parent') return '(t.parent_id IS NOT NULL)';
    if (what === 'session') return '(t.session_id IS NOT NULL)';
    if (what === 'importance') return '(t.importance IS NOT NULL)';
    if (what === 'pr') return "EXISTS (SELECT 1 FROM json_each(COALESCE(t.links, '[]')) WHERE json_extract(value, '$.type') = 'pr')";
    if (what === 'blocker') return 'EXISTS (SELECT 1 FROM ticket_deps d WHERE d.blocked_id = t.id)';
    if (what === 'children') return 'EXISTS (SELECT 1 FROM tickets c WHERE c.parent_id = t.id)';
    return '1';
  }

  /**
   * Dates. A day or today: `created:2026-10-01` is that whole day, `>` after it, `<` before it.
   * An age: `updated:7d` and `updated:<7d` are "less than 7 days ago", `updated:>7d` "more than 7 days ago".
   */
  function dateSql(col, v) {
    const now = ctx.now;
    if (v.op === 'between') {
      const [a] = span(v.from, now);
      const [, b] = span(v.to, now);
      params.push(Math.min(a, b), Math.max(a, b));
      return `(${col} >= ? AND ${col} < ?)`;
    }
    const d = v.date;
    const [from, to] = span(d, now);
    if (d.rel !== undefined) {
      params.push(from);
      if (v.op === 'eq' || v.op === '<' || v.op === '<=') return `${col} >= ?`;
      return `${col} < ?`;
    }
    if (v.op === 'eq') {
      if (from === to) {
        params.push(from);
        return `${col} = ?`;
      }
      params.push(from, to);
      return `(${col} >= ? AND ${col} < ?)`;
    }
    const bound = v.op === '>' ? to : v.op === '>=' ? from : v.op === '<' ? from : to;
    params.push(bound);
    return `${col} ${v.op === '>' || v.op === '>=' ? '>=' : '<'} ?`;
  }
}

export const QUERY_FIELDS = FIELD_NAMES;
