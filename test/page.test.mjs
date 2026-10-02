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

test('page: columns in board order, waiting first', () => {
  const w = page.indexOf('id="col-waiting"');
  const p = page.indexOf('id="col-progress"');
  const r = page.indexOf('id="col-review"');
  assert.ok(w > 0 && w < p && p < r);
  assert.match(page, /Nothing waiting on you/);
});

test('page: light and dark themes, relative API paths (works under a sub-path)', () => {
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /fetch\('api\/board'/);
  assert.match(page, /fetch\('api\/dismiss'/);
  assert.doesNotMatch(page, /fetch\('\/api/);
});
