// What "done" is worth (0.9.31): the counter-metric of closures. Counting closures rewards whoever closes fastest,
// so each actor's closures are always read with what happened to them afterwards, from the status history the board
// already keeps. Per actor and per week (ISO week, UTC, named by its Monday):
//
//   done    tickets the actor moved to done; the share reopened within 7 days (done → todo or in_progress);
//           closures made in bulk (5 or more by the same actor in one go) are counted apart, since a lot closed at
//           once is read differently from one ticket closed after its work (rule W42 of the installation)
//   review  tickets the actor moved to review; the share sent back (review → in_progress) once they left review
//
// Rules of the reading, kept in the output (`read_as`):
//   - a share always comes with its n, and `settled` says how many of the n can already be judged: a closure
//     younger than 7 days that was not reopened yet is not counted as "stayed closed", it is not judged at all;
//   - nothing here scores an actor: no rank, no grade, no threshold. The rows are sorted by week then by name,
//     never by a rate. Whoever collects is not whoever is measured (an auditor reads the rows, the board does not
//     judge).
//
// Pure functions: no I/O, the store hands over the events (Store.statusEvents) and the server serves the rows.

import { defineFigure } from './figures.mjs';

export const REOPEN_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** This many closures by one actor, each within BULK_GAP_MS of the previous one, make a bulk closure. */
export const BULK_MIN = 5;
export const BULK_GAP_MS = 5 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 3600 * 1000;
/** The statuses a closure is reopened into. */
const REOPEN_TO = new Set(['todo', 'in_progress']);

/**
 * The card of the closures view (lib/figures.mjs), served with GET /api/closures as `figure` and by the page's
 * registry for any number marked data-figure="closures". It lives next to the calculation it explains.
 */
export const CLOSURES_FIGURE = defineFigure({
  id: 'closures',
  title: 'Closures and what became of them',
  measures: 'For each actor and each ISO week, the tickets moved to done, the share reopened within 7 days, and the tickets moved to review with the share sent back to in progress. Every share comes with its n and the part of n that can already be judged.',
  clock: 'The week is the ISO week (UTC) of the status change, named by its Monday. A closure is judged 7 days after it, a review when it leaves review: before that it is counted, not judged.',
  blind: [
    'The quality of the work: a ticket closed and never reopened may be wrong, and nobody may have looked.',
    'A reopening that comes as a new ticket, or after 7 days: it is not linked to the closure.',
    'The size of the tickets: a big closure and a trivial one weigh the same, and closures made in bulk (5 or more at once) are only counted apart.',
  ],
  notFor: [
    'Grading or ranking an agent: no score is drawn from it, and the rows are never sorted by a rate.',
    'Comparing two agents: they do not get the same kind of tickets, nor the same reviewers.',
    'Reading a closure count alone: it is read with what became of the closures, and audited by someone other than the actor.',
  ],
  fr: {
    title: "Les fermetures et ce qu'elles sont devenues",
    measures: "Par acteur et par semaine ISO, les alvéoles passées à fait, la part rouverte sous 7 jours, et celles passées en relecture avec la part renvoyée en cours. Chaque part vient avec son n et la part du n déjà jugeable.",
    clock: 'La semaine est la semaine ISO (UTC) du changement de statut, nommée par son lundi. Une fermeture se juge 7 jours après, une relecture quand elle en sort : avant, elle est comptée, pas jugée.',
    blind: [
      "La qualité du travail : une alvéole fermée et jamais rouverte peut être fausse, sans que personne l'ait regardée.",
      "Une réouverture qui arrive comme une nouvelle alvéole, ou après 7 jours : elle n'est pas reliée à la fermeture.",
      "La taille des alvéoles : une grosse fermeture et une triviale pèsent pareil, et les fermetures en lot (5 ou plus d'un coup) sont seulement comptées à part.",
    ],
    notFor: [
      "Noter ou classer un agent : aucun score n'en sort, et les lignes ne sont jamais triées par un taux.",
      'Comparer deux agents : ils ne reçoivent ni les mêmes alvéoles ni les mêmes relecteurs.',
      "Lire un nombre de fermetures seul : il se lit avec ce qu'elles sont devenues, et un autre que l'acteur l'audite.",
    ],
  },
});

export const CLOSURES_READ_AS = [
  'Read each share with its n: a rate over a handful of tickets says little.',
  'A closure less than 7 days old and not reopened is not yet judged (it is outside "settled").',
  'Closures made in bulk are counted apart: they are not comparable with one ticket closed after its work.',
  'It counts what happened after a closure, not whether the work was good: a ticket nobody looks at again stays closed.',
  'No score, rank or threshold comes from these rows, and none must be built on them: a number used as a target stops measuring.',
];

/** The Monday (UTC) of the week of `at`, as YYYY-MM-DD. */
export function weekOf(at) {
  const d = new Date(Number(at));
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return new Date(monday).toISOString().slice(0, 10);
}

const share = (k, n) => (n > 0 ? Math.round((k / n) * 1000) / 1000 : null);

/**
 * Per-actor, per-week rows from status events `{ id?, ticket_id, at, actor, from_status, to_status }` (any order).
 * Options: `now` (ms), `weeks` (how many weeks back, the current one included; default 8), `bulkMin`, `bulkGapMs`.
 * Returns { window_days, bulk_min, bulk_gap_s, weeks, from, rows, read_as }; rows are newest week first, then by actor.
 */
export function closureRows(events, { now = Date.now(), weeks = 8, bulkMin = BULK_MIN, bulkGapMs = BULK_GAP_MS } = {}) {
  const nWeeks = Math.min(Math.max(Math.trunc(Number(weeks)) || 8, 1), 104);
  const from = weekOf(now - (nWeeks - 1) * WEEK_MS);
  const fromAt = Date.parse(`${from}T00:00:00Z`);
  const byTicket = new Map();
  for (const e of events ?? []) {
    if (!e || !Number.isFinite(Number(e.at))) continue;
    if (!byTicket.has(e.ticket_id)) byTicket.set(e.ticket_id, []);
    byTicket.get(e.ticket_id).push(e);
  }
  const closures = [];
  const reviews = [];
  for (const list of byTicket.values()) {
    list.sort((a, b) => a.at - b.at || (a.id ?? 0) - (b.id ?? 0));
    list.forEach((e, i) => {
      if (e.at < fromAt) return;
      const next = list[i + 1];
      if (e.to_status === 'done' && e.from_status !== 'done') {
        const reopened = !!next && next.from_status === 'done' && REOPEN_TO.has(next.to_status) && next.at - e.at <= REOPEN_WINDOW_MS;
        closures.push({ actor: e.actor, at: e.at, reopened, settled: reopened || e.at + REOPEN_WINDOW_MS <= now, bulk: false });
      } else if (e.to_status === 'review' && e.from_status !== 'review') {
        const out = list.slice(i + 1).find((x) => x.from_status === 'review');
        reviews.push({ actor: e.actor, at: e.at, settled: !!out, sentBack: !!out && out.to_status === 'in_progress' });
      }
    });
  }
  // Bulk: one actor's closures in a chain where each is within bulkGapMs of the one before; a chain of bulkMin or more.
  const byActor = new Map();
  for (const c of closures) {
    if (!byActor.has(c.actor)) byActor.set(c.actor, []);
    byActor.get(c.actor).push(c);
  }
  for (const list of byActor.values()) {
    list.sort((a, b) => a.at - b.at);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i === list.length || list[i].at - list[i - 1].at > bulkGapMs) {
        if (i - start >= bulkMin) for (let j = start; j < i; j++) list[j].bulk = true;
        start = i;
      }
    }
  }
  const rows = new Map();
  const row = (actor, at) => {
    const week = weekOf(at);
    const k = `${week}\u0000${actor}`;
    if (!rows.has(k)) {
      const part = () => ({ n: 0, settled: 0, reopened: 0 });
      rows.set(k, { actor, week, done: { ...part(), bulk: part(), regular: part() }, review: { n: 0, settled: 0, sent_back: 0 } });
    }
    return rows.get(k);
  };
  for (const c of closures) {
    const r = row(c.actor, c.at).done;
    for (const p of [r, c.bulk ? r.bulk : r.regular]) {
      p.n += 1;
      if (c.settled) p.settled += 1;
      if (c.reopened) p.reopened += 1;
    }
  }
  for (const v of reviews) {
    const r = row(v.actor, v.at).review;
    r.n += 1;
    if (v.settled) r.settled += 1;
    if (v.sentBack) r.sent_back += 1;
  }
  const out = [...rows.values()].map((r) => ({
    ...r,
    done: { ...r.done, reopened_share: share(r.done.reopened, r.done.settled) },
    review: { ...r.review, sent_back_share: share(r.review.sent_back, r.review.settled) },
  }));
  out.sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0));
  return { window_days: REOPEN_WINDOW_MS / 86400000, bulk_min: bulkMin, bulk_gap_s: bulkGapMs / 1000, weeks: nWeeks, from, rows: out, read_as: CLOSURES_READ_AS };
}

/** One row as one line, the closure count never alone: "claude, week of 2026-10-26: 9 done (5 in bulk), reopened 1 of 6 judged; review sent back 1 of 2". */
export function describeClosureRow(r) {
  const d = r.done;
  const pct = (k, n) => (n > 0 ? `${k} of ${n} judged` : 'none judged yet');
  const bulk = d.bulk.n ? ` (${d.bulk.n} in bulk)` : '';
  const rev = r.review.n ? `; review: sent back ${pct(r.review.sent_back, r.review.settled)} of ${r.review.n}` : '';
  return `${r.actor}, week of ${r.week}: ${d.n} done${bulk}, reopened ${pct(d.reopened, d.settled)}${rev}`;
}
