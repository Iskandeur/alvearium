import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../mcp/server.mjs';

const ticket = (text) => ({
  key: 'ALV-1',
  title: 'T',
  status: 'todo',
  events: [{ at: Date.UTC(2026, 0, 1), actor: 'user', type: 'comment', text }],
});

test('ticket_get cuts a long comment by default and gives it whole with full', () => {
  const long = `${'word '.repeat(300)}THE-END`;
  assert.ok(!describe(ticket(long)).includes('THE-END'));
  assert.ok(describe(ticket(long), { full: true }).includes('THE-END'));
});

test('full keeps the whole history, the default keeps the last 15 entries', () => {
  const t = ticket('x');
  t.events = Array.from({ length: 20 }, (_, i) => ({ at: Date.UTC(2026, 0, 1, 0, i), actor: 'user', type: 'comment', text: `note-${i}` }));
  assert.ok(!describe(t).includes('note-0'));
  assert.ok(describe(t, { full: true }).includes('note-0'));
});

const many = (n, size) => {
  const t = ticket('x');
  t.body = 'body-start';
  t.events = Array.from({ length: n }, (_, i) => ({ at: Date.UTC(2026, 0, 1, 0, i), actor: 'user', type: 'comment', text: `note-${i} ${'w'.repeat(size)}` }));
  return t;
};

test('a history bigger than a page is paged, and says how to read the rest', () => {
  const t = many(40, 3000);
  const p1 = describe(t, { full: true, pageChars: 20000 });
  assert.ok(p1.length < 22000);
  assert.ok(p1.includes('body-start') && p1.includes('note-0'));
  assert.ok(!p1.includes('note-39'));
  const m = p1.match(/\d+ later entries NOT SHOWN \(entries (\d+)-40\): ticket_get key=ALV-1 full=true from=(\d+)/);
  assert.ok(m && m[1] === m[2]);
});

test('following pages cover every entry exactly once', () => {
  const t = many(40, 3000);
  const seen = [];
  let from = 1;
  for (let guard = 0; guard < 50 && from <= 40; guard++) {
    const page = describe(t, { full: true, from, pageChars: 20000 });
    const ids = [...page.matchAll(/ #(\d+) 2026-/g)].map((x) => Number(x[1]));
    assert.ok(ids.length > 0);
    seen.push(...ids);
    from = ids[ids.length - 1] + 1;
  }
  assert.deepEqual(seen, Array.from({ length: 40 }, (_, i) => i + 1));
});

test('limit caps a page; one huge entry still comes alone', () => {
  const t = many(10, 10);
  const p = describe(t, { from: 3, limit: 2 });
  assert.ok(p.includes('note-2') && p.includes('note-3') && !p.includes('note-4'));
  assert.match(p, /2 earlier entries NOT SHOWN/);
  assert.match(p, /6 later entries NOT SHOWN \(entries 5-10\)/);
  assert.ok(!p.includes('body-start'), 'the body only comes with the first page');
  assert.ok(describe(many(2, 5000), { full: true, pageChars: 100 }).includes('note-0'));
});

test('the default view announces what it hides', () => {
  const t = many(20, 400);
  t.body = 'b'.repeat(3000);
  const out = describe(t);
  assert.match(out, /5 earlier entries NOT SHOWN/);
  assert.match(out, /body cut at 1800 of 3000 characters/);
  assert.match(out, /15 comment\(s\) above cut at ~260 characters/);
  assert.ok(!describe(many(3, 5), {}).includes('NOT SHOWN'));
});
