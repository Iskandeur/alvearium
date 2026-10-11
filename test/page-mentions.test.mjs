// Mention parsing on the board page: the core parser is a pure function, run here on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

// Extract by slicing between two function declarations: stable on indentation and regex literals.
const from = page.indexOf('function computeMention(text, caret, all) {');
const to = page.indexOf('function mentionUpdate(ta) {', from);
assert.ok(from > 0 && to > from, 'computeMention() is in the page');
const src = page.slice(from, to);
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
