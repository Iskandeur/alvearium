// 0.9.30: figure cards. Every figure the page marks with data-figure="<id>" has a card (what it measures, its clock,
// what it does not see, what not to use it for), written next to the figure's code and registered with defineFigure.
// The test fails for a marked figure without a card, so a future number cannot ship without its sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIGURES_SLOT, defineFigure, figureCards, figuresForPage, markedFigures, missingFigures } from '../lib/figures.mjs';
import { ROI_FIGURE } from '../lib/roi.mjs';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server/server.mjs';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const MAIN = 'm'.repeat(32);

test('every figure the page marks has a card, and every card has its four parts', () => {
  const ids = markedFigures(page);
  assert.ok(ids.includes('roi'), 'the ⚡ badge carries the mark');
  assert.deepEqual(missingFigures(page), [], 'a marked figure without a card');
  const cards = figureCards();
  for (const id of Object.keys(cards)) {
    const c = cards[id];
    for (const part of [c.measures, c.clock, ...c.blind, ...c.notFor, c.fr?.measures, ...(c.fr?.notFor ?? [])]) assert.ok(part === undefined || part.length > 10, `${id} has no empty part`);
    assert.ok(c.blind.length >= 1 && c.notFor.length >= 1);
  }
});

test('the check fails for a marked figure that has no card', () => {
  const html = '<span data-figure="roi"></span><b data-figure="week-total"></b><i data-figure="week-total"></i>';
  assert.deepEqual(markedFigures(html), ['roi', 'week-total']);
  assert.deepEqual(missingFigures(html), ['week-total'], 'week-total has no card');
  assert.deepEqual(missingFigures(html, { ...figureCards(), 'week-total': {} }), []);
});

test('the badge card says what the ticket asks: measure, clock, blind spots, and not for adding, comparing weeks, choosing a move', () => {
  assert.equal(ROI_FIGURE.id, 'roi');
  assert.match(ROI_FIGURE.clock, /last post/);
  const notFor = ROI_FIGURE.notFor.join(' ');
  assert.match(notFor, /Adding/);
  assert.match(notFor, /Comparing two weeks/);
  assert.match(notFor, /Choosing your next move/);
  assert.match(ROI_FIGURE.fr.notFor.join(' '), /Additionner.*Comparer deux semaines.*Choisir ton prochain geste/);
});

test('defineFigure refuses a bad id, a missing part, a second card with the same id', () => {
  const ok = { id: 'zz-test', title: 't', measures: 'm', clock: 'c', blind: ['b'], notFor: ['n'] };
  assert.throws(() => defineFigure({ ...ok, id: 'Bad Id' }), /bad id/);
  assert.throws(() => defineFigure({ ...ok, notFor: [] }), /notFor/);
  assert.throws(() => defineFigure({ ...ok, clock: '' }), /clock/);
  assert.throws(() => defineFigure({ ...ok, fr: { ...ok, blind: 'x' } }), /blind/);
  assert.throws(() => defineFigure({ ...ok, id: 'roi' }), /defined twice/);
  assert.equal(figureCards()['zz-test'], undefined, 'a refused card is not registered');
});

test('the page gets the cards from the server, safe inside a script', async () => {
  assert.ok(page.includes(`const FIGURES = ${FIGURES_SLOT};`), 'the slot is in the page');
  const json = figuresForPage({ x: { measures: '</script><b>' } });
  assert.doesNotMatch(json, /</);
  assert.equal(JSON.parse(json).x.measures, '</script><b>');
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: MAIN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { authorization: `Bearer ${MAIN}` } });
    const html = await r.text();
    assert.ok(!html.includes(FIGURES_SLOT), 'the slot is filled');
    const injected = html.match(/const FIGURES = \/\*FIGURES\*\/(\{.*\});/)?.[1];
    assert.ok(injected, 'the cards are in the served page');
    assert.deepEqual(Object.keys(JSON.parse(injected)).includes('roi'), true);
  } finally {
    server.close();
    store.close();
  }
});

test('page: the badge and the ticket line carry the mark, the tap shows the card, French reads French', () => {
  const cut = (a, b) => page.slice(page.indexOf(a), page.indexOf(b, page.indexOf(a)));
  const src = [page.match(/^\s*const esc = .*$/m)[0], cut('function freshness(', '// ---- end freshness'), cut('// ---- roi helpers', '// ---- end of roi helpers ----'), cut('// ---- i18n (0.9.9)', '// ---- end i18n')].join('\n');
  const make = (lang) => new Function('isOpen', 'FIGURES_JSON', `${src.replace('const FIGURES = /*FIGURES*/{};', 'const FIGURES = JSON.parse(FIGURES_JSON);')}\nconst tr = makeTr('${lang}', '${lang}');\nreturn { figHtml, roiBadge, roiLine, roiTap };`)(() => true, JSON.stringify(figureCards()));
  const t = { key: 'ALV-7', column: 'waiting', status: 'waiting_on_user', roi: { score: 16, note: 'unblocks 2 jobs' } };
  const en = make('en');
  assert.match(en.roiBadge(t), /data-figure="roi"/);
  assert.match(en.roiLine(t), /data-figure="roi"/);
  const tap = en.roiTap(t);
  assert.match(tap, /<div class="figCard"/);
  assert.match(tap, /Not for<\/dt><dd><ul><li>Adding the points up/);
  assert.equal(en.figHtml('nope'), '');
  assert.equal(en.figHtml('constructor'), '', 'an inherited name is not a figure');
  const fr = make('fr').figHtml('roi');
  assert.match(fr, /À ne pas utiliser pour/);
  assert.match(fr, /Additionner les points/);
});
