// 0.8.1: the board render reached a missing element (`n-onHold`) and threw on every refresh, since 0.6.0. The Done
// drawer stayed hidden, and boot() stopped before opening the ticket of a `?ticket=` link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** The source of a top-level page function, from its declaration to the closing brace at its indent. */
function fnSource(name) {
  const start = page.search(new RegExp(`\\n( *)(async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} not found`);
  const indent = page.slice(start + 1).match(/^ */)[0];
  const end = page.indexOf(`\n${indent}}\n`, start + 1);
  return page.slice(start, end);
}

test('board render: every element renderBoard reaches by id is in the markup', () => {
  const src = fnSource('renderBoard');
  const literal = [...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = literal.filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
  // Lanes are reached as `col-<name>`, counters by the id passed to col().
  for (const [, name, counter] of src.matchAll(/col\('(\w+)', [^\n]*?(?:, '([\w-]+)')?\);/g)) {
    assert.ok(ids.has(`col-${name}`), `col-${name}`);
    if (counter) assert.ok(ids.has(counter), counter);
  }
  assert.doesNotMatch(src, /\$\('n-' \+/, 'a counter id built from the lane name reaches lanes that have none');
});

test('boot opens the ticket of a link even when a first load fails', () => {
  const src = fnSource('boot');
  const settled = src.indexOf('Promise.allSettled([loadFacets(), refresh()');
  const open = src.indexOf('if (state.ticket) openPanel(state.ticket, false);');
  assert.ok(settled > 0 && open > settled, 'boot waits with allSettled, then opens the ticket');
  assert.doesNotMatch(src, /await Promise\.all\(\[/);
});
