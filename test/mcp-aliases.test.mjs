import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../mcp/server.mjs';

const context = { machine: 'm', origin: 'terminal' };
const notFound = () => Object.assign(new Error('ticket not found'), { status: 404 });

test('ticket_comment accepts `body` as an alias of `text`', async () => {
  const sent = [];
  const backend = { comment: async (key, text) => (sent.push(text), { key, comments_count: 1 }) };
  assert.match(await callTool('ticket_comment', { key: 'ALV-1', body: 'hello' }, { backend, context }), /Commented on ALV-1/);
  assert.match(await callTool('ticket_comment', { key: 'ALV-1', text: 'a', body: 'b' }, { backend, context }), /Commented/);
  assert.deepEqual(sent, ['hello', 'a'], '`text` wins when both are given');
});

test('ticket_comment without any text still refuses, from the board', async () => {
  const backend = { comment: async () => { throw Object.assign(new Error('empty comment (HTTP 400)'), { status: 400 }); } };
  await assert.rejects(callTool('ticket_comment', { key: 'ALV-1' }, { backend, context }), /empty comment/);
});

test('ticket_get 404 names the board it read (local board vs server)', async () => {
  const local = { source: 'local', get: async () => { throw notFound(); } };
  await assert.rejects(callTool('ticket_get', { key: 'ALV-9' }, { backend: local, context }), /ALV-9 is not on the local board \(no server configured in this process\)/);
  const remote = { source: 'http://127.0.0.1:8793', get: async () => { throw notFound(); } };
  await assert.rejects(callTool('ticket_get', { key: 'ALV-9' }, { backend: remote, context }), /not on the board at http:\/\/127\.0\.0\.1:8793/);
});

test('ticket_list says which board answered when it is empty', async () => {
  const backend = { source: 'local', list: async () => ({ tickets: [], total: 0 }) };
  assert.match(await callTool('ticket_list', { scope: 'all' }, { backend, context }), /No open tickets \(all\) on the local board/);
});
