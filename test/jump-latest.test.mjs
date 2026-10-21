import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../server/page.html', import.meta.url), 'utf8');

// The page script, run for real against a small fake DOM: the panel body with its scroll metrics, its
// listeners and its children, and a ResizeObserver that records what it watches.
const slice = (from, to) => {
  const i = page.indexOf(from);
  const j = page.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} is in the page`);
  return page.slice(i, j);
};
const latestSrc = slice('function jumpToLatest() {', 'const isExpanded = () =>');
const closeSrc = slice('function closePanel(push = true) {', 'function highlight() {');

function fakeBody({ scrollHeight, clientHeight = 500, scrollTop = 0 }) {
  const btn = { hidden: true };
  const listeners = new Map();
  return {
    scrollHeight, clientHeight, scrollTop, btn, listeners,
    children: [{ name: 'form' }, { name: 'replyBar' }],
    querySelector: (sel) => (sel === '.pLatest' ? btn : null),
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
    scrollTo({ top }) { this.scrollTop = Math.min(top, this.scrollHeight - this.clientHeight); this.fire('scroll'); },
    fire(type) { for (const fn of listeners.get(type) || []) fn(); },
  };
}

function board() {
  const live = new Set();
  class ResizeObserver {
    constructor(cb) { this.cb = cb; this.targets = []; live.add(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.targets = []; live.delete(this); }
  }
  const panel = { body: null, hidden: false, querySelector: (sel) => (sel === '.pBody' ? panel.body : null) };
  const state = { ticket: '' };
  const env = { $: () => panel, window: { matchMedia: () => ({ matches: true }) }, ResizeObserver, state };
  const api = new Function(...Object.keys(env), `
    const noop = () => {};
    const mentionClose = noop, setExpanded = noop, writeUrl = noop, highlight = noop;
    let panelDirty = false;
    const scrim = { hidden: false };
    const $real = $; $ = (id) => (id === 'scrim' ? scrim : $real(id));
    ${latestSrc}
    ${closeSrc}
    return { watchLatest, jumpToLatest, closePanel };
  `)(...Object.values(env));
  // What renderPanel does: a new body, then watchLatest().
  const open = (key, metrics) => {
    state.ticket = key;
    panel.hidden = false;
    panel.body = fakeBody(metrics);
    api.watchLatest();
    return panel.body;
  };
  const resized = () => { for (const o of live) o.cb(); };
  return { ...api, open, resized, live, panel };
}

test('a long ticket shows the button; a short one does not', () => {
  const b = board();
  assert.equal(b.open('ALV-1', { scrollHeight: 2000 }).btn.hidden, false);
  assert.equal(b.open('ALV-2', { scrollHeight: 400 }).btn.hidden, true);
  assert.equal(b.open('ALV-3', { scrollHeight: 530 }).btn.hidden, true, 'within 48 px of the end counts as the end');
});

test('scrolled to the end, it hides; a new message below brings it back', () => {
  const b = board();
  const body = b.open('ALV-1', { scrollHeight: 2000 });
  body.scrollTop = 1500;
  body.fire('scroll');
  assert.equal(body.btn.hidden, true, 'at the end');
  body.scrollHeight = 2600; // a comment arrives and the content grows
  b.resized();
  assert.equal(body.btn.hidden, false, 'more below again');
});

test('a click scrolls to the end, and the button goes away', () => {
  const b = board();
  const body = b.open('ALV-1', { scrollHeight: 2000 });
  b.jumpToLatest();
  assert.equal(body.scrollTop, 1500);
  assert.equal(body.btn.hidden, true);
});

test('closing the panel stops watching: no observer, no scroll listener left', () => {
  const b = board();
  const body = b.open('ALV-1', { scrollHeight: 2000 });
  assert.equal(b.live.size, 1);
  assert.equal(body.listeners.get('scroll').length, 1);
  b.closePanel(false);
  assert.equal(b.panel.hidden, true);
  assert.equal(b.live.size, 0, 'observer disconnected at close');
  assert.equal(body.listeners.get('scroll').length, 0, 'scroll listener removed at close');
});

test('opening and closing ten tickets leaks nothing', () => {
  const b = board();
  const bodies = [];
  for (let i = 0; i < 10; i++) {
    bodies.push(b.open(`ALV-${i}`, { scrollHeight: 2000 }));
    if (i % 2) b.closePanel(false);
  }
  b.open('ALV-99', { scrollHeight: 2000 }); // a re-render without a close in between replaces the watcher
  assert.equal(b.live.size, 1, 'one observer: the open ticket');
  for (const body of bodies) assert.equal(body.listeners.get('scroll').length, 0);
  b.closePanel(false);
  assert.equal(b.live.size, 0);
});

test('the button lives in the scrolling body, not in the header', () => {
  const head = page.match(/<div class="pHead">.*<\/div><\/div>/)?.[0] ?? '';
  assert.ok(head.length > 0);
  assert.doesNotMatch(head, /jumpLatest/);
  assert.match(page, /<div class="pLatestWrap"><button type="button" class="pLatest" data-act="jumpLatest" hidden/);
  assert.match(page, /\.pLatestWrap \{ position: sticky; bottom: 10px;/);
  assert.match(page, /if \(act === 'jumpLatest'\) return jumpToLatest\(\);/);
  assert.match(page, /watchLatest\(\);\n      \}/, 'renderPanel ends by watching');
});

test('the button is translated', () => {
  assert.match(page, /'↓ Latest messages': '↓ Derniers messages'/);
  assert.match(page, /'Jump to the latest messages of this ticket':/);
});
