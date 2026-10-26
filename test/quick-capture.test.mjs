// 0.9.19: Quick capture, one round button and one focused text box that files a ticket with the note as typed.
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

test('page: a round button opens a single text box, focused in the same tick as the tap', () => {
  assert.match(page, /<button class="qcFab" id="qcFab" type="button"/);
  assert.equal((page.match(/<textarea id="qcText"/g) || []).length, 1, 'one text box and nothing else to fill in');
  assert.match(page, /function openCapture\(\) \{[\s\S]*?\$\('qc'\)\.hidden = false;[\s\S]*?box\.focus\(\);\s*\}/);
  // The focus must not wait for a timer or a fetch: a phone raises its keyboard only inside the user's gesture.
  const open = page.slice(page.indexOf('function openCapture()'), page.indexOf('function closeCapture()'));
  assert.equal(/setTimeout|await |\.then\(/.test(open), false);
  assert.match(page, /\.qc textarea \{[^}]*font: inherit; font-size: 16px/, '16 px keeps iOS from zooming the page on focus');
});

test('page: the note is sent as the body, the title is its first line, the label is capture', () => {
  const from = page.indexOf('const captureTitle');
  const to = page.indexOf('let captureAssignee');
  const captureTitle = new Function(`${page.slice(from, to)}\nreturn captureTitle;`)();
  assert.equal(captureTitle('Call the plumber\nabout the leak'), 'Call the plumber');
  assert.equal(captureTitle('\n\n  spaced  \n'), 'spaced');
  assert.equal(captureTitle(''), '');
  const long = captureTitle('word '.repeat(60));
  assert.ok(long.length <= 81 && long.endsWith('…') && !long.includes('  '), long);
  assert.match(page, /api\('tickets', \{ title: captureTitle\(text\) \|\| tr\('Pasted image'\), body: text, status: 'todo', assignee: captureAssignee, labels: \['capture'\], \.\.\.\(pics\.length \? \{ attachments: pics \} : \{\}\) \}\)/);
});

test('page: a picture pasted or dropped into the capture box is uploaded and sent with the ticket', () => {
  assert.match(page, /<div class="pend" id="qcPics"><\/div>/);
  assert.match(page, /const pendTarget = \(\) => \(\$\('qc'\)\.hidden \? [^;]*: 'qc'\);/);
  assert.match(page, /const inCapture = !\$\('qc'\)\.hidden;/, 'paste in the capture box is handled');
  assert.match(page, /closest\?\.\('\.compose, #cform, #qc'\)/, 'drop on the capture box is handled');
  assert.match(page, /target && target !== 'qc' \? `api\/tickets/, 'a capture has no ticket yet: the file goes to /api/attachments');
  assert.match(page, /if \(!text && !pics\.length\)/, 'text alone, picture alone, or both');
});

test('server: a ticket created with an uploaded picture owns it, text-only still works', async () => {
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: TOKEN, store, page }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await (await fetch(`${base}/api/attachments?name=pasted.png`, { method: 'POST', headers: { authorization: auth.authorization, 'content-type': 'image/png' }, body: png })).json();
    assert.ok(up.id);
    const t = await (await fetch(`${base}/api/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Pasted image', body: '', status: 'todo', assignee: 'claude', labels: ['capture'], attachments: [up.id] }) })).json();
    assert.equal(t.labels[0], 'capture');
    const got = await (await fetch(`${base}/api/tickets/${t.key}`, { headers: auth })).json();
    assert.ok(JSON.stringify(got).includes('pasted.png') || JSON.stringify(got).includes(String(up.id)), 'the picture is on the ticket');
    const plain = await fetch(`${base}/api/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'idea', body: 'idea', status: 'todo', labels: ['capture'] }) });
    assert.equal(plain.status, 201);
  } finally {
    server.close();
  }
});

test('page: Escape closes, Ctrl or Cmd+Enter sends, and an unsent note is kept', () => {
  assert.match(page, /e\.key === 'Escape'[\s\S]*?closeCapture\(\)/);
  assert.match(page, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)[\s\S]*?requestSubmit\(\)/);
  assert.match(page, /localStorage\.setItem\(QC_DRAFT/);
  assert.match(page, /localStorage\.removeItem\(QC_DRAFT\)/);
  assert.match(page, /:root\[data-role="viewer"\] \.qcFab \{ display: none/);
});

test('server: /api/version names who gets a capture, claude unless the board says otherwise', async () => {
  for (const [opts, want] of [[{}, 'claude'], [{ captureAssignee: 'triage-bot' }, 'triage-bot']]) {
    const store = await openStore(':memory:');
    const server = createServer(createApp({ token: TOKEN, store, page, ...opts }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const v = await (await fetch(`http://127.0.0.1:${server.address().port}/api/version`, { headers: auth })).json();
      assert.equal(v.capture.assignee, want);
      const t = await (await fetch(`http://127.0.0.1:${server.address().port}/api/tickets`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'idea', body: 'idea\nmore', status: 'todo', assignee: v.capture.assignee, labels: ['capture'] }) })).json();
      assert.equal(t.assignee, want);
      assert.deepEqual(t.labels, ['capture']);
      assert.equal(t.body, 'idea\nmore');
    } finally {
      server.close();
    }
  }
});

test('0.9.27: a pasted picture is previewed big and paste works with the capture open wherever the focus is', () => {
  assert.match(page, /const inCapture = !\$\('qc'\)\.hidden;/, 'an open capture takes the paste, whatever has the focus');
  assert.match(page, /\.filter\(\(i\) => i\.kind === 'file'\)\.map\(\(i\) => i\.getAsFile\(\)\)/, 'a picture offered as an item, not a file, is read too');
  assert.match(page, /\.qc \.fchip img \{ width: 152px; height: 110px;/, 'the preview is not a 22 px speck');
});
