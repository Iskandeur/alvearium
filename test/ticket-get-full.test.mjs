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
