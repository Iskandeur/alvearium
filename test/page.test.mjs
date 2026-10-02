import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

test('page: one self-contained file, nothing loaded from elsewhere', () => {
  assert.doesNotMatch(page, /<script[^>]+src=/i);
  assert.doesNotMatch(page, /<link[^>]+rel=["']?stylesheet/i);
  assert.doesNotMatch(page, /@import|url\(\s*["']?https?:/i);
  assert.doesNotMatch(page, /fonts\.googleapis|cdn\.|unpkg|jsdelivr/i);
});

test('page: columns in board order, waiting on you first', () => {
  const w = page.indexOf('id="col-waiting"');
  const p = page.indexOf('id="col-inProgress"');
  const t = page.indexOf('id="col-todo"');
  assert.ok(w > 0 && w < p && p < t);
  assert.match(page, /Nothing waiting on you/);
});

test('page: light and dark themes, relative API paths (works under a sub-path)', () => {
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /fetch\('api\/' \+ path/);
  assert.doesNotMatch(page, /fetch\('\/api/);
  for (const route of ["'tickets/board'", "'facets'", "'tickets'", '`tickets/${'] ) assert.ok(page.includes(route), route);
});

test('page: filters live in the URL (shareable, back button)', () => {
  assert.match(page, /history\.pushState/);
  assert.match(page, /addEventListener\('popstate'/);
  for (const k of ['repo', 'session', 'status', 'assignee', 'kind', 'label', 'origin', 'machine']) assert.ok(page.includes(`'${k}'`), k);
});
