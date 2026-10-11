// Mention parsing on the board page: the core parser is a pure function, run here on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

// Extract by following function boundary: avoid brittle brace counting (regex literals contain `{0,64}`).
const src = page.match(/function computeMention\(text, caret, all\) \{[\s\S]*?\n {6}\}\n(?= {6}function mentionUpdate\()/)?.[0];
assert.ok(src, 'computeMention() is in the page');
const computeMention = new Function(`${src}; return computeMention;`)();

test('mentions: @ at start and after whitespace opens', () => {
  const all = [
    { id: 'ferao', name: 'Ferao' },
    { id: 'rikki-tikki-tavi', name: 'Rikki' },
  ];
  const a = computeMention('hi @f', 'hi @f'.length, all);
  assert.ok(a);
  assert.equal(a.start, 3);
  assert.equal(a.end, 5);
  assert.equal(a.q, 'f');
  assert.equal(a.list[0].id, 'ferao');
});

test('mentions: @ inside a word is ignored', () => {
  const all = [{ id: 'ferao', name: 'Ferao' }];
  assert.equal(computeMention('x@f', 3, all), null);
});

test('mentions: invalid query closes', () => {
  const all = [{ id: 'ferao', name: 'Ferao' }];
  assert.equal(computeMention('hi @f_', 6, all), null);
});
