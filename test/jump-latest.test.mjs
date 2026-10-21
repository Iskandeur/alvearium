import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../server/page.html', import.meta.url), 'utf8');

test('the open ticket has a "Latest messages" button that scrolls its body to the end', () => {
  assert.match(page, /data-act="jumpLatest"/);
  assert.match(page, /if \(act === 'jumpLatest'\) return jumpToLatest\(\);/);
  assert.match(page, /body\.scrollTo\(\{ top: body\.scrollHeight/);
});

test('the button is translated', () => {
  assert.match(page, /'↓ Latest messages': '↓ Derniers messages'/);
  assert.match(page, /'Jump to the latest messages of this ticket':/);
});
