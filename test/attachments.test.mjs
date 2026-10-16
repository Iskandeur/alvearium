// Files attached to tickets and comments (0.5.16 pictures, 0.5.18 any file): the type is read from the
// bytes, the name is cleaned, the size is bounded by the install setting; a file is claimed once by one
// comment (or one new ticket) of its own ticket; only a short list is shown in the browser, everything
// else (HTML and SVG first) is a download; a file still waiting is only its uploader's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';
import { ATTACHMENT_MAX_BYTES, attachmentMaxBytes, checkAttachment, cleanFileName, contentDisposition, sniffFile } from '../lib/attachment.mjs';
import { fakeJpegHeader, makePng } from './helpers/png.mjs';

const MAIN = 'm'.repeat(32);
const AGENT = 'a'.repeat(32);

async function withServer(fn, opts = {}) {
  const store = await openStore(':memory:');
  const server = createServer(createApp({ token: MAIN, agents: [{ token: AGENT, actor: 'bot' }], store, page: '<html>board</html>', ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
  }
}

const auth = { authorization: `Bearer ${MAIN}` };
const json = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const upload = (base, key, body, type = 'image/png', name = '', headers = auth) =>
  fetch(`${base}/api/${key ? `tickets/${key}/` : ''}attachments${name ? `?name=${encodeURIComponent(name)}` : ''}`, { method: 'POST', headers: { ...headers, 'content-type': type }, body });

test('checkAttachment: pictures are checked, every other file is accepted and typed by its bytes', () => {
  assert.equal(checkAttachment(makePng(20, 10)).mime, 'image/png');
  assert.equal(checkAttachment(fakeJpegHeader(4000, 3000)).mime, 'image/jpeg');
  assert.equal(checkAttachment(Buffer.from('%PDF-1.7\n%âãÏÓ\n'), { name: 'devis.pdf' }).mime, 'application/pdf');
  assert.equal(checkAttachment(Buffer.from('hello\nworld\n'), { name: 'notes.txt' }).mime, 'text/plain');
  assert.equal(checkAttachment(Buffer.from('a,b\n1,2\n'), { name: 'x.csv' }).mime, 'text/csv');
  assert.equal(checkAttachment(Buffer.from('PK\x03\x04rest', 'latin1'), { name: 'r.docx' }).mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(checkAttachment(Buffer.from('PK\x03\x04rest', 'latin1'), { name: 'a.zip' }).mime, 'application/zip');
  assert.equal(checkAttachment(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')).mime, 'image/gif');
  assert.equal(sniffFile(Buffer.from('\x00\x00\x00\x18ftypisom', 'latin1')), 'video/mp4');
  assert.equal(sniffFile(Buffer.from('ID3\x04\x00', 'latin1')), 'audio/mpeg');
  // markup is never typed as something a browser would render
  assert.equal(checkAttachment(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), { name: 'x.svg' }).mime, 'application/octet-stream');
  assert.equal(checkAttachment(Buffer.from('<!doctype html><script>alert(1)</script>'), { name: 'notes.txt' }).mime, 'application/octet-stream');
  assert.equal(checkAttachment(Buffer.from('plain words'), { name: 'page.html' }).mime, 'application/octet-stream');
  assert.equal(checkAttachment(Buffer.from([0, 1, 2, 3, 250, 251])).mime, 'application/octet-stream');
  assert.throws(() => checkAttachment(Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)), (e) => e.status === 413 && /25 MB/.test(e.message));
  assert.throws(() => checkAttachment(Buffer.alloc(11), { maxBytes: 10 }), (e) => e.status === 413);
  assert.throws(() => checkAttachment(makePng(13000, 2)), (e) => e.status === 422);
  assert.throws(() => checkAttachment(Buffer.alloc(0)), (e) => e.status === 400);
});

test('names are cleaned, headers carry them safely, the cap reads from the setting', () => {
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('C:\\Users\\me\\photo.jpg'), 'photo.jpg');
  assert.equal(cleanFileName('a"b<c>|d?.pdf'), 'abcd.pdf');
  assert.equal(cleanFileName('.htaccess'), 'htaccess');
  assert.equal(cleanFileName('evil\u202egnp.exe'), 'evilgnp.exe');
  assert.equal(cleanFileName(''), 'file');
  const long = cleanFileName('x'.repeat(300) + '.pdf');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.pdf'));
  assert.equal(contentDisposition('attachment', 'Devis été.pdf'), `attachment; filename="Devis ete.pdf"; filename*=UTF-8''Devis%20%C3%A9t%C3%A9.pdf`);
  assert.doesNotMatch(contentDisposition('inline', 'a\r\nSet-Cookie: x'), /[\r\n]/);
  assert.equal(attachmentMaxBytes(undefined), 25 * 1024 * 1024);
  assert.equal(attachmentMaxBytes('10'), 10 * 1024 * 1024);
  assert.equal(attachmentMaxBytes('abc'), 25 * 1024 * 1024);
  assert.equal(attachmentMaxBytes('0'), 25 * 1024 * 1024);
  assert.equal(attachmentMaxBytes('9999'), 200 * 1024 * 1024);
});

test('upload, comment with the picture, history lists it, served safely', async () => {
  await withServer(async (base, store) => {
    const t = store.createTicket({ title: 'photo' }, { actor: 'user' });
    const png = makePng(16, 16);
    const up = await upload(base, t.key, png, 'image/png', 'capture.png');
    assert.equal(up.status, 201);
    const pic = await up.json();
    assert.equal(pic.mime, 'image/png');
    assert.equal(pic.width, 16);
    assert.equal(pic.name, 'capture.png');

    const c = await json(base, `/api/tickets/${t.key}/comments`, { text: 'look', attachments: [pic.id] });
    assert.equal(c.status, 201);
    const full = await (await fetch(`${base}/api/tickets/${t.key}`, { headers: auth })).json();
    const ev = full.events.find((e) => e.type === 'comment');
    assert.equal(ev.attachments.length, 1);
    assert.equal(ev.attachments[0].id, pic.id);
    assert.equal(ev.attachments[0].name, 'capture.png');
    assert.equal(ev.id, undefined);
    assert.equal(full.events.find((e) => e.type === 'created').attachments, undefined);

    const r = await fetch(`${base}/api/attachments/${pic.id}`, { headers: auth });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.match(r.headers.get('content-disposition'), /^inline; filename="capture.png"/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/api/attachments/${pic.id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/attachments/999`, { headers: auth })).status, 404);
  });
});

test('any file: a PDF opens in the browser, HTML and SVG only download', async () => {
  await withServer(async (base, store) => {
    const t = store.createTicket({ title: 'docs' }, { actor: 'user' });
    const pdf = await (await upload(base, t.key, Buffer.from('%PDF-1.4\n1 0 obj\n'), 'application/pdf', 'facture mars.pdf')).json();
    const html = await (await upload(base, t.key, Buffer.from('<html><script>alert(document.cookie)</script></html>'), 'text/html', 'page.html')).json();
    const svg = await (await upload(base, t.key, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'logo.svg')).json();
    const zip = await (await upload(base, t.key, Buffer.from('PK\x03\x04data', 'latin1'), 'application/zip', 'logs.zip')).json();
    assert.equal(pdf.mime, 'application/pdf');
    assert.equal(html.mime, 'application/octet-stream');
    assert.equal(svg.mime, 'application/octet-stream');
    assert.equal((await json(base, `/api/tickets/${t.key}/comments`, { text: 'files', attachments: [pdf.id, html.id, svg.id, zip.id] })).status, 201);

    const p = await fetch(`${base}/api/attachments/${pdf.id}`, { headers: auth });
    assert.equal(p.headers.get('content-type'), 'application/pdf');
    assert.match(p.headers.get('content-disposition'), /^inline; /);
    for (const [id, name] of [[html.id, 'page.html'], [svg.id, 'logo.svg'], [zip.id, 'logs.zip']]) {
      const r = await fetch(`${base}/api/attachments/${id}`, { headers: auth });
      assert.equal(r.headers.get('content-type'), 'application/octet-stream', name);
      assert.equal(r.headers.get('content-disposition').split(';')[0], 'attachment', name);
      assert.match(r.headers.get('content-disposition'), new RegExp(`filename="${name.replace('.', '\\.')}"`));
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
  });
});

test('the cap comes from the install setting, with a clear refusal', async () => {
  await withServer(async (base, store) => {
    const t = store.createTicket({ title: 'big' }, { actor: 'user' });
    const v = await (await fetch(`${base}/api/version`, { headers: auth })).json();
    assert.equal(v.attachments.max_bytes, 1024 * 1024);
    const r = await upload(base, t.key, Buffer.alloc(1024 * 1024 + 1, 1), 'application/octet-stream', 'dump.bin');
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /file too large \(max 1 MB\)/);
    assert.equal((await upload(base, t.key, Buffer.alloc(1024 * 1024, 1), 'application/octet-stream', 'ok.bin')).status, 201);
  }, { attachmentMax: 1024 * 1024 });
});

test('new ticket form: files uploaded before the ticket join its creation, for their uploader only', async () => {
  await withServer(async (base, store) => {
    const doc = await (await upload(base, null, Buffer.from('%PDF-1.4\n'), 'application/pdf', 'plan.pdf')).json();
    const pic = await (await upload(base, null, makePng(8, 8), 'image/png', 'shot.png')).json();
    // waiting: the uploader reads it back, another actor cannot
    assert.equal((await fetch(`${base}/api/attachments/${doc.id}`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/api/attachments/${doc.id}`, { headers: { authorization: `Bearer ${AGENT}` } })).status, 404);
    // another actor cannot claim it on a ticket of their own
    const steal = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'mine', attachments: [doc.id] }) });
    assert.equal(steal.status, 400);
    const res = await json(base, '/api/tickets', { title: 'with files', attachments: [doc.id, pic.id] });
    assert.equal(res.status, 201);
    const t = await res.json();
    const full = await (await fetch(`${base}/api/tickets/${t.key}`, { headers: auth })).json();
    const created = full.events.find((e) => e.type === 'created');
    assert.deepEqual(created.attachments.map((a) => a.name), ['plan.pdf', 'shot.png']);
    assert.equal(full.title, 'with files');
    // claimed: every reader sees it now
    assert.equal((await fetch(`${base}/api/attachments/${doc.id}`, { headers: { authorization: `Bearer ${AGENT}` } })).status, 200);
    // a refused creation leaves no ticket behind
    const before = store.listTickets({}).length;
    assert.equal((await json(base, '/api/tickets', { title: 'again', attachments: [doc.id] })).status, 400);
    assert.equal(store.listTickets({}).length, before);
  });
});

test('limits: 40 files per ticket, 10 per comment, attachments must be a list', async () => {
  await withServer(async (base, store) => {
    const t = store.createTicket({ title: 'lots' }, { actor: 'user' });
    const png = makePng(4, 4);
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push((await (await upload(base, t.key, png)).json()).id);
    assert.equal((await upload(base, t.key, png)).status, 413);
    assert.equal((await json(base, `/api/tickets/${t.key}/comments`, { text: 'eleven', attachments: ids.slice(0, 11) })).status, 400);
    assert.equal((await json(base, `/api/tickets/${t.key}/comments`, { text: 'obj', attachments: { a: 1 } })).status, 400);
    assert.equal((await json(base, `/api/tickets/${t.key}/comments`, { text: 'ten', attachments: ids.slice(0, 10) })).status, 201);
  });
});

test('refusals: empty file, unknown ticket, file reused or from another ticket', async () => {
  await withServer(async (base, store) => {
    const a = store.createTicket({ title: 'a' }, { actor: 'user' });
    const b = store.createTicket({ title: 'b' }, { actor: 'user' });
    assert.equal((await upload(base, a.key, Buffer.alloc(0), 'text/plain')).status, 400);
    assert.equal((await upload(base, 'ALV-999', makePng())).status, 404);
    const pic = await (await upload(base, a.key, makePng())).json();
    // another ticket cannot claim it, and the refused comment leaves nothing behind
    const bad = await json(base, `/api/tickets/${b.key}/comments`, { text: 'steal', attachments: [pic.id] });
    assert.equal(bad.status, 400);
    const bFull = await (await fetch(`${base}/api/tickets/${b.key}`, { headers: auth })).json();
    assert.equal(bFull.events.filter((e) => e.type === 'comment').length, 0);
    // the right ticket claims it once; a second claim is refused
    assert.equal((await json(base, `/api/tickets/${a.key}/comments`, { text: 'ok', attachments: [pic.id] })).status, 201);
    assert.equal((await json(base, `/api/tickets/${a.key}/comments`, { text: 'again', attachments: [pic.id] })).status, 400);
    assert.equal((await json(base, `/api/tickets/${a.key}/comments`, { text: 'junk', attachments: ['x'] })).status, 400);
  });
});

test('a file uploaded for no ticket and never claimed is dropped after a day', async () => {
  const store = await openStore(':memory:');
  const t = store.createTicket({ title: 'old' }, { actor: 'user' });
  const now = Date.now();
  const kept = store.addAttachment(t.key, { mime: 'text/plain', data: Buffer.from('k'), name: 'k.txt' }, 'user', now - 2 * 24 * 3600 * 1000);
  const old = store.addAttachment(null, { mime: 'text/plain', data: Buffer.from('x'), name: 'a.txt' }, 'user', now - 2 * 24 * 3600 * 1000);
  store.addAttachment(null, { mime: 'text/plain', data: Buffer.from('y'), name: 'b.txt' }, 'user', now);
  assert.equal(store.getAttachment(old.id), null);
  assert.ok(store.getAttachment(kept.id), 'a file waiting on an open ticket panel stays');
});
