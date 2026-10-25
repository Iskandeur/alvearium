// 0.10.0: the page side of the query language: the syntax help at the end of the search bar, the line
// under it that says what the board could not read, and every sentence of both in French.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const from = page.indexOf('// ---- i18n (0.9.9)');
const to = page.indexOf('// ---- end i18n');
const { I18N_FR } = new Function(`${page.slice(from, to)}\nreturn { I18N_FR };`)();

test('page: the search bar has its syntax help and a line for what the query could not say', () => {
  assert.match(page, /<button type="button" class="qHelpBtn" data-act="queryHelp" aria-label="Search syntax"/);
  assert.match(page, /<div class="wrap qErr" id="qErr" role="status" hidden><\/div>/);
  assert.match(page, /aria-describedby="qErr"/);
  assert.match(page, /renderQueryErrors\(data\.query\);/, 'every view shows the problems the server returns');
  assert.match(page, /if \(act === 'queryHelp'\) return openHelp\(renderQueryHelp/);
  assert.match(page, /if \(act === 'queryTry'\)/);
  assert.match(page, /data-act="queryHelp">\$\{tr\('Search syntax'\)\}<\/button>/, 'the shortcuts help links to it too');
});

test('page: every sentence of the query help and of its problems reads French', () => {
  const start = page.indexOf("// ---- the search bar's query language");
  const end = page.indexOf('function activeOpenNodes');
  assert.ok(start > 0 && end > start);
  const block = page.slice(start, end);
  const strings = new Set();
  // tr('…') calls, the problems table and the help rows: [example, 'sentence']
  for (const m of block.matchAll(/tr\('((?:[^'\\]|\\.)+)'/g)) strings.add(m[1]);
  for (const m of block.matchAll(/^\s+\w+: '((?:[^'\\]|\\.)+)',$/gm)) strings.add(m[1]);
  for (const m of block.matchAll(/\['[^']*', '((?:[^'\\]|\\.)+)'\]/g)) strings.add(m[1]);
  assert.ok(strings.size >= 30, `found ${strings.size} sentences`);
  for (const s of strings) assert.ok(I18N_FR[s], `French for: ${s}`);
  assert.ok(I18N_FR['Search, or status:todo p:P1 -label:x…'], 'and the placeholder');
});
