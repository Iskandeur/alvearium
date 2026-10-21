import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../server/page.html', import.meta.url), 'utf8');

test('the "Latest messages" button lives in the scrolling body, not in the header', () => {
  const head = page.match(/<div class="pHead">.*<\/div><\/div>/)?.[0] ?? '';
  assert.ok(head.length > 0);
  assert.doesNotMatch(head, /jumpLatest/);
  assert.match(page, /<div class="pLatestWrap"><button type="button" class="pLatest" data-act="jumpLatest" hidden/);
  assert.match(page, /\.pLatestWrap \{ position: sticky; bottom: 10px;/);
});

test('it is shown only when the ticket overflows and the reader is not at the end', () => {
  assert.match(page, /btn\.hidden = body\.scrollHeight - body\.scrollTop - body\.clientHeight <= 48;/);
  assert.match(page, /addEventListener\('scroll', syncLatest/);
  assert.match(page, /new ResizeObserver\(syncLatest\)/);
  assert.match(page, /watchLatest\(\);\n      \}/);
});

test('a click scrolls the body to the end', () => {
  assert.match(page, /if \(act === 'jumpLatest'\) return jumpToLatest\(\);/);
  assert.match(page, /body\.scrollTo\(\{ top: body\.scrollHeight/);
});

test('the button is translated', () => {
  assert.match(page, /'↓ Latest messages': '↓ Derniers messages'/);
  assert.match(page, /'Jump to the latest messages of this ticket':/);
});
