// Figure cards (0.9.30): a number the board shows is read as the answer to a question it does not ask. Each figure
// that carries the mark `data-figure="<id>"` in server/page.html has a short card: what it measures, where its clock
// starts, what it does not see, and what it must not be used for. The card is written NEXT TO the code that
// computes or formats the figure (lib/roi.mjs for the ⚡ badge) and registered here with defineFigure: one source,
// the page gets the registry injected when it is served. A future figure adds its card the same way, and
// test/figures.test.mjs fails for any marked figure without one.
//
//   defineFigure({ id, title, measures, clock, blind: [..], notFor: [..], fr?: { same fields } })
//
// Pure functions: no I/O.

const FIELDS = ['title', 'measures', 'clock'];
const LISTS = ['blind', 'notFor'];
const MAX_TEXT = 400;
const REGISTRY = new Map();

function checkText(card, where) {
  for (const f of FIELDS) {
    const v = card[f];
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_TEXT) throw new Error(`figure ${where}: "${f}" must be a short text`);
  }
  for (const f of LISTS) {
    const v = card[f];
    if (!Array.isArray(v) || !v.length || v.some((s) => typeof s !== 'string' || !s.trim() || s.length > MAX_TEXT)) throw new Error(`figure ${where}: "${f}" must be a non-empty list of short texts`);
  }
}

/** Checks a card and registers it. Throws on a missing field, a bad id or a second card with the same id. */
export function defineFigure(card) {
  if (!card || typeof card !== 'object') throw new Error('figure: a card is an object');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(String(card.id))) throw new Error(`figure: bad id ${JSON.stringify(card.id)}`);
  if (REGISTRY.has(card.id)) throw new Error(`figure ${card.id}: defined twice`);
  checkText(card, card.id);
  if (card.fr) checkText(card.fr, `${card.id} (fr)`);
  REGISTRY.set(card.id, Object.freeze(card));
  return card;
}

/** Every registered card, by id. */
export function figureCards() {
  return Object.fromEntries(REGISTRY);
}

/** The ids of the figures a page marks (`data-figure="roi"`), without duplicates. */
export function markedFigures(html) {
  return [...new Set([...String(html).matchAll(/data-figure="([a-z][a-z0-9-]*)"/g)].map((m) => m[1]))];
}

/** The marked figures that have no card in `cards` (an object keyed by id). */
export function missingFigures(html, cards = figureCards()) {
  return markedFigures(html).filter((id) => !Object.hasOwn(cards, id));
}

/** The registry as the page reads it: JSON that is safe inside a <script> (no "</script>", no line separators). */
export function figuresForPage(cards = figureCards()) {
  const esc = (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  return JSON.stringify(cards).replace(new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g'), esc);
}

/** Where server/page.html receives the registry. */
export const FIGURES_SLOT = '/*FIGURES*/{}';
