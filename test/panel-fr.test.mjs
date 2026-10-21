// 0.9.17 (control audit n°6): an open ticket reads French whole (ALV-3617), reaches touch size on a phone (ALV-3619),
// and its assignee menu stays short (ALV-2857).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const from = page.indexOf('// ---- i18n (0.9.9)');
const to = page.indexOf('// ---- end i18n');
const { makeTr, I18N_FR } = new Function(`${page.slice(from, to)}\nreturn { makeTr, I18N_FR };`)();
const between = (a, b) => {
  const s = page.indexOf(a);
  const e = page.indexOf(b, s);
  assert.ok(s > 0 && e > s, `${a} found`);
  return page.slice(s, e);
};
// The templates of the open ticket: its markdown buttons, the reading view, the panel itself.
const PANEL = [
  between('const mdActs = (what)', 'function mdSource'),
  between('function renderReader()', 'function cmpVersion'),
  between('function syncExpandButton()', 'const mdActs = (what)'),
  between('const resizeHandle = () =>', '\n      function'),
  between('const attachButton = (inputId)', '\n'),
  between('function depList(list, rel)', 'async function loadActions()'),
];

test('the open ticket writes no English by hand: every label, tooltip and placeholder goes through tr()', () => {
  const found = [];
  for (const code of PANEL) {
    for (const m of code.matchAll(/(?:aria-label|title|placeholder)="([A-Z][^"$]*)"/g)) found.push(m[1]);
    for (const m of code.matchAll(/>([A-Z][A-Za-z' ,.…:()?-]{2,})</g)) if (!['Markdown', 'Claude'].includes(m[1])) found.push(m[1]);
    for (const m of code.matchAll(/(?:aria-label|title)', '([A-Z][^']*)'/g)) found.push(m[1]);
    for (const m of code.matchAll(/\.title = '([A-Z][^']*)'/g)) found.push(m[1]);
  }
  assert.deepEqual(found, []);
});

test('every tr() key of the open ticket has its French', () => {
  const missing = new Set();
  for (const code of PANEL) {
    for (const m of code.matchAll(/tr\(\s*(['"])((?:(?!\1).)+)\1/g)) if (m[2] !== 'kind:' && !Object.hasOwn(I18N_FR, m[2])) missing.add(m[2]);
  }
  assert.deepEqual([...missing], []);
});

test('the hold form, the kind and the reading view read French', () => {
  const fr = makeTr('fr', 'fr-FR');
  assert.equal(fr('Lift the hold now'), 'Lever la suspension maintenant');
  assert.equal(fr('What it waits for'), 'Ce qu’il attend');
  assert.equal(fr('{c} characters · {w} words', { c: '1 200', w: '210' }), '1 200 caractères · 210 mots');
  assert.equal(fr('kind:task'), 'tâche');
  assert.match(page, /const kindLabel = \(k\) => \{ const v = tr\('kind:' \+ k\); return v\.startsWith\('kind:'\) \? String\(k \?\? ''\) : v; \};/);
  assert.match(page, /<span class="pkey">\$\{esc\(t\.key\)\} · \$\{esc\(kindLabel\(t\.kind\)\)\}<\/span>/);
});

test('on a phone the panel controls reach 36 px or more, and "Mark done" stays on one line', () => {
  const css = between('0.9.17 (audit n°6, ALV-3619)', '@media (prefers-reduced-motion: reduce) { .asks .ask');
  assert.match(css, /@media \(max-width: 900px\), \(pointer: coarse\)/);
  for (const sel of ['#panel .links a', '#panel .attachBtn', '#panel .fields select', '#panel .pAct', '#panel .clear', '#panel summary.sect', '#panel .dep .rm', '#panel .ctx .tag']) assert.ok(css.includes(sel), sel);
  assert.match(css, /#panel \.pHead \.pDone \{ flex: none; white-space: nowrap; \}/);
  assert.match(css, /#panel \.pHead \.x, #panel \.pHead \.pIcon \{ flex: none; min-width: 40px; \}/);
});

test('the assignee menu keeps the 10 newest runs, not 50', () => {
  const code = between('const ASSIGNEE_RUNS = 10;', '// 0.6.0: on hold');
  assert.match(code, /\.slice\(0, ASSIGNEE_RUNS\)/);
  assert.doesNotMatch(code, /\.slice\(0, 50\)/);
});
