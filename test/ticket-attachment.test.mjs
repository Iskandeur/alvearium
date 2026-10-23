import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, describe } from '../mcp/server.mjs';
import { HttpBackend } from '../lib/runtime.mjs';

const context = { machine: 'm', origin: 'terminal' };
const T = Date.UTC(2026, 9, 22, 21, 14);
// A 1x1 PNG (signature + IHDR + padding past 12 bytes is all the sniffer needs).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000d49484452', 'hex'), Buffer.alloc(40)]);
const pic = (id) => ({ id, mime: 'image/png', name: `capture-${id}.png`, size: 120_000, width: 1170, height: 2532, etag: `e${id}` });
// A comment of the owner that is only a mark and three pictures; another that is only a picture, no text at all.
const ticket = {
  key: 'ALV-3748',
  title: 'T',
  status: 'todo',
  events: [
    { at: T, actor: 'user', type: 'comment', text: '📎', attachments: [pic(84), pic(85), pic(86)] },
    { at: T + 1000, actor: 'user', type: 'comment', text: '', attachments: [pic(40)] },
  ],
};

test('ticket_get lists the pictures of a comment, with the id that ticket_attachment takes', () => {
  const out = describe(ticket);
  for (const id of [84, 85, 86, 40]) assert.match(out, new RegExp(`attached: #${id} capture-${id}\\.png \\(image/png, 117 KB, 1170x2532\\), read it with ticket_attachment`));
});

test('a comment with no picture lists none', () => {
  const t = { ...ticket, events: [{ at: T, actor: 'user', type: 'comment', text: 'hello' }] };
  assert.doesNotMatch(describe(t), /attached:/);
});

test('ticket_attachment returns the picture as an MCP image block', async () => {
  const seen = [];
  const backend = { source: 'local', attachment: async (id, o) => (seen.push([id, o.maxBytes]), { mime: 'image/png', data: PNG, size: PNG.length }) };
  const out = await callTool('ticket_attachment', { id: 84 }, { backend, context });
  assert.equal(out.content[0].type, 'image');
  assert.equal(out.content[0].mimeType, 'image/png');
  assert.equal(Buffer.from(out.content[0].data, 'base64').equals(PNG), true);
  assert.deepEqual(seen, [[84, 5 * 1024 * 1024]]);
});

test('the kind comes from the bytes: a declared image that is text is not shown as one', async () => {
  const backend = { attachment: async () => ({ mime: 'image/png', data: Buffer.from('<html>not a picture at all</html>'), size: 33 }) };
  const out = await callTool('ticket_attachment', { id: 5 }, { backend, context });
  assert.equal(typeof out, 'string');
  assert.match(out, /not a picture/);
});

test('a file above max_bytes is described, not sent', async () => {
  const backend = { attachment: async (id, { maxBytes }) => ({ mime: 'image/png', data: null, size: maxBytes + 1 }) };
  const out = await callTool('ticket_attachment', { id: 5, max_bytes: 1024 }, { backend, context });
  assert.match(out, /above max_bytes/);
});

test('a missing file names the board; a bad id is refused before any request', async () => {
  const backend = { source: 'local', attachment: async () => { throw Object.assign(new Error('no such file'), { status: 404 }); } };
  await assert.rejects(callTool('ticket_attachment', { id: 9 }, { backend, context }), /file #9 is not on the local board/);
  await assert.rejects(callTool('ticket_attachment', { id: 'x' }, { backend: {}, context }), /id must be a file id/);
});

test('HttpBackend.attachment reads the raw bytes with the board credential and honours the size cap', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers['x-session-board-actor']]);
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  };
  const b = new HttpBackend({ url: 'http://board.test', token: 'tok-tok-tok-tok-tok-tok-tok' }, { actor: 'lupi/job-1', fetchImpl });
  const f = await b.attachment(84, { maxBytes: 1_000_000 });
  assert.equal(f.mime, 'image/png');
  assert.equal(f.data.equals(PNG), true);
  assert.deepEqual(calls, [['http://board.test/api/attachments/84', 'lupi/job-1']]);
  const big = await b.attachment(84, { maxBytes: 10 });
  assert.equal(big.data, null);
  const missing = new HttpBackend({ url: 'http://board.test', token: 'tok-tok-tok-tok-tok-tok-tok' }, { fetchImpl: async () => new Response('{"error":"no file"}', { status: 404 }) });
  await assert.rejects(missing.attachment(1), (e) => e.status === 404);
});
