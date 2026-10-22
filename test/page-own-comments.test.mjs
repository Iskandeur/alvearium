// The owner's own comments in a ticket thread carry a tint, so they are easy to spot at a glance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

test('page: a comment whose actor is `user` gets the "mine" class, others do not', () => {
  assert.match(page, /class="ev comment\$\{e\.actor === 'user' \? ' mine' : ''\} mdHost"/);
});

test('page: the tint uses theme variables, so it reads in light and dark', () => {
  assert.match(page, /\.ev\.comment\.mine \.said \{[^}]*background: var\(--accent-soft\)[^}]*var\(--accent\)/);
});
