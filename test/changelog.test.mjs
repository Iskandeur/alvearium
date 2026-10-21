// 0.5.13: "What's new". The release notes (server/changelog.json), the route that serves them, the
// page's banner logic run as shipped (the helpers are lifted out of server/page.html), and the
// discoverability of the 0.5.10 tools: the grip, the copy and read-wide buttons, the help button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION, compareVersions } from '../lib/core.mjs';
import { cleanChangelog, createApp, loadChangelog } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const ROOT = join(import.meta.dirname, '..');
const page = readFileSync(join(ROOT, 'server', 'page.html'), 'utf8');
const raw = JSON.parse(readFileSync(join(ROOT, 'server', 'changelog.json'), 'utf8'));

const from = page.indexOf("// ---- what's new (0.5.13)");
const to = page.indexOf("// ---- end of what's new helpers ----");
assert.ok(from > 0 && to > from, "what's new helpers found in page.html");
const { whatsNew, changelogMarkdown, ticketMarkdown, cmpVersion, SEEN_KEY } = new Function(`${page.slice(from, to)}\nreturn { whatsNew, changelogMarkdown, ticketMarkdown, cmpVersion, SEEN_KEY };`)();

// The page's markdown renderer, to check that the history renders as lists.
const escLine = page.match(/^\s*const esc = .*$/m)[0];
const { md } = new Function(`${escLine}\nconst actors = new Map();\nconst actorName = (id) => String(id);\n${page.slice(page.indexOf('// ---- markdown'), page.indexOf('/** One line that says what a ticket needs from you. */'))}\nreturn { md };`)();

const REL = [
  { version: '0.5.13', date: '2026-10-14', items: ['a', 'b', 'c'] },
  { version: '0.5.12', date: '2026-10-14', items: ['d', 'e', 'f'] },
  { version: '0.5.11', date: '2026-10-13', items: ['g', 'h', 'i'] },
  { version: '0.5.10', date: '2026-10-12', items: ['j', 'k', 'l'] },
];

test('changelog.json: the current version first, every version since 0.5.10, 3 to 5 items each', () => {
  const list = raw.releases;
  assert.equal(list[0].version, VERSION, 'the version this server runs has its notes');
  for (const v of ['0.5.10', '0.5.11', '0.5.12', '0.5.13']) assert.ok(list.some((r) => r.version === v), v);
  for (let i = 1; i < list.length; i++) assert.ok(compareVersions(list[i - 1].version, list[i].version) > 0, 'newest first, no duplicate');
  for (const r of list) {
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.items.length >= 3 && r.items.length <= 5, `${r.version}: ${r.items.length} items`);
    for (const x of r.items) assert.ok(typeof x === 'string' && x.length >= 20 && x.length <= 160, `${r.version}: "${x}"`);
  }
  // Every entry survives the server's checks unchanged.
  assert.deepEqual(cleanChangelog(raw), list.map(({ version, date, items }) => ({ version, date, items })));
});

test('changelog.json: written for users (no code, file paths, routes, links or settings)', () => {
  const text = raw.releases.flatMap((r) => r.items).join('\n');
  assert.doesNotMatch(text, /`|\/api\/|\blib\/|server\/|\.mjs|\.json|SESSION_BOARD|BOARD_|\bPR\b|#\d+/);
  assert.doesNotMatch(JSON.stringify(raw), /\/home\/|\/root\/|\/srv\/|https?:\/\/|@/);
});

test('cleanChangelog: keeps well-formed releases only, newest first, at most 5 items', () => {
  const out = cleanChangelog({
    releases: [
      { version: '0.4.0', items: ['old'] },
      { version: 'next', items: ['no version'] },
      { version: '0.6.0', date: 'today', items: ['1', '2', '3', '4', '5', '6', 7, ' '] },
      { version: '0.5.0', items: [] },
      null,
    ],
  });
  assert.deepEqual(out, [
    { version: '0.6.0', date: null, items: ['1', '2', '3', '4', '5'] },
    { version: '0.4.0', date: null, items: ['old'] },
  ]);
  assert.deepEqual(cleanChangelog(null), []);
  assert.deepEqual(cleanChangelog({ releases: 'x' }), []);
});

test('loadChangelog: a missing or broken file gives no notes, never a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alv-changelog-'));
  assert.deepEqual(loadChangelog(join(dir, 'nope.json')), []);
  writeFileSync(join(dir, 'bad.json'), '{ not json');
  assert.deepEqual(loadChangelog(join(dir, 'bad.json')), []);
  assert.equal(loadChangelog()[0].version, VERSION, 'the default reads server/changelog.json');
});

test('GET /api/changelog: the server version and its notes, behind the token; the stream says its version', async () => {
  const store = await openStore(':memory:');
  const token = 'c'.repeat(32);
  const server = createServer(createApp({ token, store, page: '<html></html>', changelog: REL }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/changelog`)).status, 401);
    const res = await fetch(`${base}/api/changelog`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { version: VERSION, releases: REL });
    // The page compares this with what it loaded: a server restarted on another version offers a reload.
    const ctl = new AbortController();
    const s = await fetch(`${base}/api/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
    const rd = s.body.getReader();
    let buf = '';
    while (!/event: hello\ndata: .*\n/.test(buf)) buf += new TextDecoder().decode((await rd.read()).value);
    ctl.abort();
    assert.equal(JSON.parse(buf.match(/event: hello\ndata: (.*)\n/)[1]).server, VERSION);
  } finally {
    server.closeAllConnections?.();
    server.close();
    store.close();
  }
});

test("whatsNew: a new browser sees the current version only; a browser that saw it sees nothing", () => {
  assert.deepEqual(whatsNew('0.5.13', null, REL), { version: '0.5.13', items: ['a', 'b', 'c'], missed: [] });
  assert.deepEqual(whatsNew('0.5.13', 'garbage', REL), { version: '0.5.13', items: ['a', 'b', 'c'], missed: [] }, 'unreadable = new');
  assert.equal(whatsNew('0.5.13', '0.5.13', REL), null);
});

test('whatsNew: an older browser sees the current items and the versions it skipped, newest first', () => {
  assert.deepEqual(whatsNew('0.5.13', '0.5.12', REL), { version: '0.5.13', items: ['a', 'b', 'c'], missed: [] });
  assert.deepEqual(whatsNew('0.5.13', '0.5.10', REL), { version: '0.5.13', items: ['a', 'b', 'c'], missed: ['0.5.12', '0.5.11'] });
  assert.deepEqual(whatsNew('0.5.13', '0.4.9', REL).missed, ['0.5.12', '0.5.11', '0.5.10']);
});

test('whatsNew: nothing after a rollback, nothing without notes for the served version, at most 5 items', () => {
  assert.equal(whatsNew('0.5.12', '0.5.13', REL), null, 'the browser saw a newer version');
  assert.equal(whatsNew('0.5.14', null, REL), null, 'no notes for this version');
  assert.equal(whatsNew(null, null, REL), null);
  assert.equal(whatsNew('0.5.13', null, null), null);
  const many = [{ version: '1.0.0', items: ['1', '2', '3', '4', '5', '6', '', 7] }];
  assert.deepEqual(whatsNew('1.0.0', null, many).items, ['1', '2', '3', '4', '5']);
  assert.ok(cmpVersion('0.5.10', '0.5.9') > 0, 'numeric, not alphabetical');
});

test('changelogMarkdown: the whole history for the reading view, newest first, rendered as lists', () => {
  const text = changelogMarkdown([...REL].reverse(), '0.5.13');
  assert.ok(text.indexOf('## 0.5.13') < text.indexOf('## 0.5.12') && text.indexOf('## 0.5.11') < text.indexOf('## 0.5.10'));
  assert.match(text, /^## 0\.5\.13 · this version · 2026-10-14\n\n- a\n- b\n- c/);
  assert.doesNotMatch(text, /0\.5\.12 · this version/);
  const html = md(text);
  assert.match(html, /<h2>0\.5\.12 · 2026-10-14<\/h2>/);
  assert.match(html, /<ul><li>d<\/li><li>e<\/li><li>f<\/li><\/ul>/);
  assert.equal(changelogMarkdown([], '1.0.0'), 'No release notes on this server.');
  assert.match(changelogMarkdown(REL, '0.5.13', (d) => `on ${d}`), /## 0\.5\.10 · on 2026-10-12/);
});

test('ticketMarkdown: a whole ticket to read on a phone, title, description and every comment', () => {
  const t = { key: 'ALV-7', title: 'Fix the coupon', body: 'Steps:\n\n- one', events: [{ type: 'status', at: 1 }, { type: 'comment', actor: 'fern', text: 'On it.', at: 2 }, { type: 'comment', actor: 'user', text: 'Thanks', at: 3 }] };
  const text = ticketMarkdown(t, (id) => id.toUpperCase(), (ms) => `t${ms}`);
  assert.equal(text, '# Fix the coupon\n\nSteps:\n\n- one\n\n## 2 comments\n\n### FERN · t2\n\nOn it.\n\n### USER · t3\n\nThanks');
  assert.equal(ticketMarkdown({ key: 'ALV-8', title: '', events: [] }), '# ALV-8\n\n_No description._');
});

test('page: the banner is wired (loaded at start, dismissed for good, storage behind its guard)', () => {
  assert.equal(SEEN_KEY, 'alvearium.seen-version');
  assert.match(page, /<section class="news" id="news" hidden aria-labelledby="newsTitle"><\/section>/);
  assert.match(page, /loadActions\(\), loadChangelog\(\)\]\);/);
  assert.match(page, /const r = await api\('changelog'\);/);
  assert.match(page, /whatsNew\(served\.version, prefs\.get\(SEEN_KEY\), served\.releases\)/);
  assert.match(page, /if \(act === 'newsClose'\) \{ newsSeen\(\);/);
  assert.match(page, /if \(act === 'newsAll'\) \{ newsSeen\(\); return openChangelog\(\); \}/);
  assert.match(page, /if \(served\.version\) prefs\.set\(SEEN_KEY, served\.version\);/);
  assert.doesNotMatch(page, /localStorage\.\w+\(SEEN_KEY/);
  assert.match(page, /tr\("What's new in \{v\}", \{ v: n\.version \}\)/);
  assert.match(page, /if \(isVersion\(v\) && served\.version && v !== served\.version\) newsUpdate\(v\);/, 'a newer server offers a reload');
});

test('page: the 0.5.10 tools are visible at rest (grip, copy, read wide) and the help is one click away', () => {
  // The grip: three dots mid-height on the left edge, drawn at rest, accent when hovered or focused.
  assert.match(page, /\.pResize::before \{\n\s*content: ""; position: absolute; z-index: 1;[^}]*radial-gradient\(circle at 50% 50%, var\(--grip\)/);
  assert.match(page, /\.pResize:hover, \.pResize:focus-visible, body\.resizing \.pResize \{ --grip: var\(--accent\); \}/);
  assert.match(page, /title="Drag to widen · double-click to reset"/);
  // Copy and read wide: 0.45 at rest, full on hover or focus, full on touch; labelled and titled.
  assert.match(page, /\.mdActs \{ display: inline-flex; align-items: center; gap: 2px; opacity: 0\.45;/);
  assert.match(page, /\.mdHost:hover \.mdActs, \.mdHost:focus-within \.mdActs, \.mdActs:hover, \.mdActs:focus-within/);
  assert.match(page, /data-md="copy" aria-label="\$\{esc\(tr\('Copy the \{what\} as markdown', \{ what: tr\(what\) \}\)\)\}" title="\$\{tr\('Copy as markdown'\)\}"/);
  assert.match(page, /data-md="read" aria-label="\$\{esc\(tr\('Read the \{what\} in a wide view', \{ what: tr\(what\) \}\)\)\}" title="\$\{tr\('Read in a wide view'\)\}"/);
  // Narrow screens: the expand button exists and reads the whole ticket; the copy works without a read-only box.
  assert.match(page, /b\.setAttribute\('aria-label', tr\('Read the whole ticket in the reading view'\)\);/);
  assert.match(page, /const NARROW = window\.matchMedia\('\(max-width: 900px\)'\);/);
  assert.match(page, /ta\.setSelectionRange\(0, text\.length\)/);
  assert.doesNotMatch(page, /ta\.setAttribute\('readonly'/);
  // The help: a ? button in the header, keys plus buttons and gestures, with the version and the history.
  assert.match(page, /<button class="btn helpBtn" type="button" id="helpBtn" data-act="help" aria-label="Shortcuts and gestures" title="Shortcuts and gestures \(\?\)" data-i18n-attr="aria-label,title">\?<\/button>/);
  assert.match(page, /if \(act === 'help'\) return openHelp\(\);/);
  for (const s of ["<h4>${tr('Keyboard')}</h4>", "<h4>${tr('Buttons and gestures')}</h4>", 'double-click it to go back to the default width', 'Copy a description or a comment as markdown', 'Esc goes back']) assert.ok(page.includes(s), s);
  assert.match(page, /data-act="newsAll">\$\{tr\("What's new"\)\}<\/button>/);
});
