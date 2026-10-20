// 0.5.19: the short date beside a ticket is its last update; the Done answer button is slim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const TOKEN = 'x'.repeat(32);
const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('page: every short date of a listed ticket is updated_at, with "Updated … · created …" on hover', () => {
  assert.equal(/ago\(t\.created_at/.test(page), false, 'no listed ticket shows its creation date');
  assert.equal(/ago\(t\.status_at/.test(page), false, 'nor its status date');
  assert.equal((page.match(/ago\(t\.updated_at, now\)\}<\/span>/g) || []).length, 4, 'card, Next, list, row');
  assert.match(page, /const updTitle = \(t\) => tr\('Updated \{u\} · created \{c\}', \{ u: when\(t\.updated_at\), c: when\(t\.created_at\) \}\)/);
});

test('page: the Done answer button has a hairline frame and a 30 px (40 px on touch) height', () => {
  assert.match(page, /\.asks \.ask\.quick \{ height: 30px;[^}]*border-color: var\(--line\)/);
  assert.match(page, /\.asks \.ask\.quick, \.asks\.at-card \.ask\.quick \{ height: 40px;/);
});

test('server: updated_at moves on a comment, a status change and a new assignee, and the default sort follows it', async () => {
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => (await fetch(base + path, { method, headers: auth, body: body ? JSON.stringify(body) : undefined })).json();
  const nap = () => new Promise((r) => setTimeout(r, 15));
  try {
    const a = await call('POST', '/api/tickets', { title: 'first', status: 'todo' });
    await nap();
    const b = await call('POST', '/api/tickets', { title: 'second', status: 'todo' });
    let last = (await call('GET', `/api/tickets/${a.key}`)).updated_at;
    const steps = [
      ['comment', () => call('POST', `/api/tickets/${a.key}/comments`, { text: 'hello' })],
      ['status', () => call('POST', `/api/tickets/${a.key}`, { status: 'in_progress' })],
      ['assignee', () => call('POST', `/api/tickets/${a.key}`, { assignee: 'claude' })],
    ];
    for (const [name, run] of steps) {
      await nap();
      await run();
      const now = (await call('GET', `/api/tickets/${a.key}`)).updated_at;
      assert.ok(now > last, `${name} moves updated_at`);
      last = now;
    }
    const list = await call('GET', '/api/tickets?sort=updated');
    const keys = (list.tickets || list).map((t) => t.key);
    assert.ok(keys.indexOf(a.key) < keys.indexOf(b.key), 'the recently touched ticket comes first');
  } finally {
    server.close();
  }
});
