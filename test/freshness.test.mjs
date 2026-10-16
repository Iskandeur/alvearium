// 0.5.20: every view says when its data was last confirmed, and flags it past BOARD_STALE_AFTER_SECONDS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STALE_AFTER_S, staleAfterSeconds } from '../server/server.mjs';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const from = page.indexOf('// ---- freshness');
const to = page.indexOf('// ---- end freshness');
assert.ok(from > 0 && to > from, 'freshness block found in page.html');
const freshness = new Function(`${page.slice(from, to)}\nreturn freshness;`)();

test('freshness: recent data reads "just now", then minutes, hours, days', () => {
  const now = Date.UTC(2026, 9, 16, 12, 0, 0);
  assert.equal(freshness(now - 10_000, now, 120).text, 'updated just now');
  assert.equal(freshness(now - 90_000, now, 120).text, 'updated 2 min ago');
  assert.equal(freshness(now - 3 * 3600_000, now, 99_999).text, 'updated 3 h ago');
  assert.equal(freshness(now - 2 * 86400_000, now, 999_999).text, 'updated 2 d ago');
  assert.match(freshness(now - 10_000, now, 120).title, /^Data as of /);
});

test('freshness: past the threshold it is stale and says so; no date shows nothing', () => {
  const now = 1_000_000_000_000;
  const f = freshness(now - 121_000, now, 120);
  assert.equal(f.stale, true);
  assert.equal(f.text, '⚠ updated 2 min ago');
  assert.match(f.title, /may be out of date/);
  assert.equal(freshness(now - 119_000, now, 120).stale, false);
  assert.deepEqual(freshness(0, now, 120), { text: '', title: '', stale: false });
  assert.deepEqual(freshness(NaN, now, 120), { text: '', title: '', stale: false });
});

test('BOARD_STALE_AFTER_SECONDS: whole seconds from 30 to 86400, anything else keeps 120', () => {
  assert.equal(STALE_AFTER_S, 120);
  for (const [raw, want] of [[undefined, 120], ['', 120], ['600', 600], [' 30 ', 30], ['29', 120], ['1.5', 120], ['abc', 120], ['86401', 120]]) {
    assert.equal(staleAfterSeconds(raw), want, String(raw));
  }
});

test('the page shows the stamp in the header and in an open ticket, and reads the threshold from /api/version', () => {
  assert.match(page, /<span class="fresh" id="fresh"/);
  assert.ok(page.includes('class="fresh" data-at="${now}"'));
  assert.ok(page.includes("api('version')"));
  assert.ok(page.includes('freshness?.stale_after_s'));
});
