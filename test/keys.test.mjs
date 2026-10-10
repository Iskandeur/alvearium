// Keyboard shortcuts on the board page: the dispatch is a pure function, run here on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const src = page.match(/function shortcut\(e, ctx\) \{[\s\S]*?\n {6}\}\n/)?.[0];
assert.ok(src, 'shortcut() is in the page');
const shortcut = new Function(`${src}; return shortcut;`)();

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
const idle = { helpOpen: false, panelOpen: false, typing: false, targetId: '', formId: '', onTicket: false };
const at = (over) => ({ ...idle, ...over });

test('keys: Ctrl+Enter and Cmd+Enter send the comment being typed', () => {
  const inComment = at({ panelOpen: true, typing: true, targetId: 'comment', formId: 'tform' });
  assert.equal(shortcut(key('Enter', { ctrlKey: true }), inComment), 'sendComment');
  assert.equal(shortcut(key('Enter', { metaKey: true }), inComment), 'sendComment');
  // Enter alone and Shift+Enter stay a new line.
  assert.equal(shortcut(key('Enter'), inComment), null);
  assert.equal(shortcut(key('Enter', { shiftKey: true }), inComment), null);
  assert.equal(shortcut(key('Enter', { ctrlKey: true, shiftKey: true }), inComment), null);
});

test('keys: Ctrl+Enter in the title or description saves the ticket, or creates the new one', () => {
  assert.equal(shortcut(key('Enter', { ctrlKey: true }), at({ panelOpen: true, typing: true, formId: 'tform' })), 'submitForm');
  assert.equal(shortcut(key('Enter', { metaKey: true }), at({ panelOpen: true, typing: true, formId: 'cform' })), 'submitForm');
  assert.equal(shortcut(key('Enter', { ctrlKey: true }), at({ typing: true, targetId: 'q' })), null, 'not in the search box');
});

test('keys: single letters act only when nothing is being typed', () => {
  const want = { '/': 'search', '?': 'help', n: 'new', j: 'next', k: 'prev', b: 'board', l: 'list' };
  for (const [k, a] of Object.entries(want)) {
    assert.equal(shortcut(key(k), idle), a, k);
    assert.equal(shortcut(key(k), at({ typing: true })), null, `${k} while typing`);
  }
  assert.equal(shortcut(key('N', { shiftKey: true }), idle), 'new', 'caps lock or shift');
  assert.equal(shortcut(key('d'), idle), 'done');
  assert.equal(shortcut(key('d'), at({ typing: true })), null);
});

test('keys: no shortcut steals a browser or screen-reader key', () => {
  for (const k of ['n', 'j', 'k', 'l', 'd', 'c', 'b', 'o', '/']) {
    for (const m of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(shortcut(key(k, { [m]: true }), at({ panelOpen: true, onTicket: true })), null, `${m}+${k}`);
  }
  assert.equal(shortcut(key('Tab'), idle), null);
  assert.equal(shortcut(key('ArrowDown'), idle), null);
  assert.equal(shortcut(key('Escape'), idle), null, 'Esc with nothing open is the browser\'s');
});

test('keys: Enter or o opens the focused ticket, c needs an open ticket', () => {
  assert.equal(shortcut(key('Enter'), at({ onTicket: true })), 'open');
  assert.equal(shortcut(key('o'), at({ onTicket: true })), 'open');
  assert.equal(shortcut(key('Enter'), idle), null, 'Enter on a button stays a click');
  assert.equal(shortcut(key('o'), idle), null);
  assert.equal(shortcut(key('c'), idle), null);
  assert.equal(shortcut(key('c'), at({ panelOpen: true })), 'comment');
});

test('keys: Esc closes the help, then the panel; the help swallows other keys', () => {
  assert.equal(shortcut(key('Escape'), at({ helpOpen: true, panelOpen: true })), 'closeHelp');
  assert.equal(shortcut(key('Escape'), at({ panelOpen: true, typing: true })), 'closePanel');
  assert.equal(shortcut(key('?'), at({ helpOpen: true })), 'closeHelp');
  assert.equal(shortcut(key('n'), at({ helpOpen: true })), null);
});

test('keys: Enter in a dependency box adds the ticket', () => {
  assert.equal(shortcut(key('Enter'), at({ panelOpen: true, typing: true, targetId: 'addBlocker' })), 'addDep');
  assert.equal(shortcut(key('Enter'), at({ panelOpen: true, typing: true, targetId: 'addBlocked' })), 'addDep');
});

test('page: a hint under the comment box, the help lists every key, focus is visible', () => {
  assert.match(page, /<div class="hint" id="commentHint">\$\{esc\(sendHint\('send'\)\)\}<\/div>/);
  assert.match(page, /const modLabel = \(\) => \(IS_MAC \? '⌘' : 'Ctrl'\)/);
  for (const k of ["'/'", "'n'", "'j'", "'k'", "'Enter'", "'o'", "'d'", "'c'", "'b'", "'l'", "'?'", "'Esc'"]) assert.ok(page.includes(`{ keys: ${k},`), k);
  assert.match(page, /role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"/);
  for (const c of ['card', 'row', 'nrow']) assert.match(page, new RegExp(`\\.${c}:focus-visible \\{ outline: 2px solid var\\(--accent\\)`));
});
