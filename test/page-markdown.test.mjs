// The page's markdown renderer, run as shipped: the functions are lifted out of server/page.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const escLine = page.match(/^\s*const esc = .*$/m)[0];
const from = page.indexOf('// ---- markdown');
const to = page.indexOf('/** One line that says what a ticket needs from you. */');
assert.ok(from > 0 && to > from, 'markdown block found in page.html');
const { md, plain } = new Function(`${escLine}\n${page.slice(from, to)}\nreturn { md, plain };`)();

test('md: headings, emphasis, code, lists, quotes, tables', () => {
  const h = md('### Title\n\n**bold** and _it_ and `x < y`\n\n- a\n- b\n\n1. one\n\n> quote\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(h, /<h3>Title<\/h3>/);
  assert.match(h, /<strong>bold<\/strong> and <em>it<\/em> and <code>x &lt; y<\/code>/);
  assert.match(h, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(h, /<ol><li>one<\/li><\/ol>/);
  assert.match(h, /<blockquote>quote<\/blockquote>/);
  assert.match(h, /<th>A<\/th><th>B<\/th>.*<td>1<\/td><td>2<\/td>/);
  assert.doesNotMatch(h, /###/);
});

test('md: a markdown link and a bare URL each become exactly one anchor', () => {
  const h = md('[Example](https://example.com/a?b=1&c=2) and https://x.test/p.');
  assert.equal(h.match(/<a /g).length, 2);
  assert.match(h, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener">Example<\/a>/);
  assert.match(h, /<a href="https:\/\/x\.test\/p"[^>]*>https:\/\/x\.test\/p<\/a>\.<\/p>$/);
  assert.doesNotMatch(h, /&amp;amp;|target=&quot;/);
  const mail = ['a.b', 'ex.test'].join('@'); // built at run time: no address in a shipped file
  assert.ok(md('mail me: ' + mail).includes(`<a href="mailto:${mail}" target="_blank" rel="noopener">${mail}</a>`));
});

test('md: nothing inside code is reinterpreted', () => {
  const h = md('`**no** https://x.test`');
  assert.equal(h, '<p><code>**no** https://x.test</code></p>');
  assert.match(md('```\n<b>x</b> **y**\n```'), /<pre><code>&lt;b&gt;x&lt;\/b&gt; \*\*y\*\*<\/code><\/pre>/);
});

test('md: no XSS (script, handlers, javascript: and data: links)', () => {
  const inputs = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](https://ok.test" onmouseover="alert(1))',
    '**<svg onload=alert(1)>**',
    '| <script>a</script> | b |\n|---|---|\n| c | d |',
    '> <iframe src=javascript:alert(1)>',
    '### <img src=x onerror=alert(1)>',
    'https://ok.test/"><script>alert(1)</script>',
    '\u00000\u0000 [y](https://ok.test)',
  ];
  for (const input of inputs) {
    const h = md(input);
    assert.doesNotMatch(h, /<(script|img|svg|iframe)/i, input);
    assert.doesNotMatch(h, /href="(?!https?:|mailto:)/i, input);
    assert.doesNotMatch(h, /<[^>]+\son\w+=/i, input);
  }
});

test('md: a line no block takes never hangs the page', () => {
  assert.equal(md('```js title\nok'), '<p>```js title</p><p>ok</p>');
  assert.match(md('#nospace\n|just a pipe'), /#nospace/);
});

test('page: every displayed title goes through plain(), the edit box keeps the raw text', () => {
  assert.doesNotMatch(page.replace(/<textarea class="pTitle"[^\n]*/, ''), /esc\(\w+\.title\)/);
  assert.match(page, /<textarea class="pTitle"[^>]*>\$\{esc\(t\.title\)\}/);
});

test('plain: previews never show markers', () => {
  assert.equal(plain('### Title\n**bold** _it_ `code`\n- item\n> quote'), 'Title bold it code · item quote');
  assert.equal(plain('[label](https://x.test) keeps snake_case and 2 * 3'), 'label keeps snake_case and 2 * 3');
  assert.equal(plain('```\nhidden\n```\nshown'), 'shown');
  assert.equal(plain('| A | B |\n|---|---|\n| 1 | 2 |'), '| A | B | | 1 | 2 |');
});
