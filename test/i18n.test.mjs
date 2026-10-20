// 0.9.9: the page in English or French (navigator.language, ?lang=, localStorage); ticket content is never translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseActions, publicAction } from '../server/actions.mjs';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');
const from = page.indexOf('// ---- i18n (0.9.9)');
const to = page.indexOf('// ---- end i18n');
assert.ok(from > 0 && to > from, 'i18n block found in page.html');
const { pickLang, dateLocale, makeTr, I18N_FR } = new Function(`${page.slice(from, to)}\nreturn { pickLang, dateLocale, makeTr, I18N_FR };`)();

test('i18n: the language comes from ?lang=, then the stored choice, then navigator.language', () => {
  assert.equal(pickLang('', null, 'fr-FR'), 'fr');
  assert.equal(pickLang('', null, 'fr'), 'fr');
  assert.equal(pickLang('', null, 'fr-CA'), 'fr');
  assert.equal(pickLang('', null, 'en-GB'), 'en');
  assert.equal(pickLang('', null, 'de-DE'), 'en');
  assert.equal(pickLang('', null, ''), 'en');
  assert.equal(pickLang('', 'fr', 'en-US'), 'fr', 'a stored choice beats the browser');
  assert.equal(pickLang('?lang=en', 'fr', 'fr-FR'), 'en', 'the address beats both');
  assert.equal(pickLang('?lang=fr&theme=dark', null, 'en-US'), 'fr');
  assert.equal(pickLang('?lang=xx', 'yy', 'fr-BE'), 'fr', 'an unknown value is ignored');
});

test('i18n: the audited strings read French, English stays as written, plurals and placeholders', () => {
  const fr = makeTr('fr', 'fr-FR');
  const en = makeTr('en', 'en');
  assert.equal(fr('Needs your answer'), 'Attend ta réponse');
  assert.equal(fr('If no answer:'), 'Sans réponse :');
  assert.equal(fr('Not for me'), 'Pas pour moi');
  assert.equal(fr('{n} done', { n: 2460 }), '2460 terminés');
  assert.equal(fr('{n} done', { n: 1 }), '1 terminé');
  assert.equal(fr('{n} on hold, back by themselves', { n: 29 }), '29 en suspens, reviennent tout seuls');
  assert.equal(en('{n} done', { n: 2460 }), '2460 done');
  assert.equal(en('Needs your answer'), 'Needs your answer');
  assert.equal(fr('a text nobody translated'), 'a text nobody translated');
  for (const [k, v] of Object.entries(I18N_FR)) {
    const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const one of [].concat(v)) assert.equal(holes(one), holes(k), `same placeholders: ${k}`);
  }
});

test('i18n: dates follow the language through Intl', () => {
  const at = Date.UTC(2026, 9, 15, 10, 46);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  assert.equal(new Date(at).toLocaleDateString(dateLocale('fr', 'en-US'), opts), '15 oct.');
  assert.equal(new Date(at).toLocaleDateString(dateLocale('en', 'fr-FR'), opts), 'Oct 15');
  assert.equal(dateLocale('en', 'en-GB'), 'en-GB', 'an English browser keeps its own date order');
  assert.equal(dateLocale('en', 'de-DE'), 'en');
});

test('i18n: the page translates its labels, never the ticket text, and keeps ?lang= in the address', () => {
  assert.match(page, /<span class="askK">\$\{tr\('Needs your answer'\)\}<\/span>\$\{a\.question \? `<div class="askQ">\$\{esc\(a\.question\)\}/);
  assert.match(page, /\$\{tr\('Not for me'\)\}<\/button>/);
  assert.match(page, /tr\('\{n\} done', \{ n: c\.done \|\| 0 \}\)/);
  assert.match(page, /<h2 id="h-waiting" data-i18n>Waiting on you<\/h2>/);
  assert.doesNotMatch(page, /toLocale(Date|Time)?String\((undefined|\[\])?[,)]/, 'every date names the locale');
  assert.match(page, /if \(lang\) p\.set\('lang', lang\);/);
  assert.match(page, /document\.documentElement\.lang = LANG;/);
});

test('ticket actions: a label per language reaches the page; a plain label still works', () => {
  const env = { HOOK_TOKEN: 'x'.repeat(20) };
  const base = { id: 'open', url: 'https://hooks.example.com/a', token_env: 'HOOK_TOKEN', allow_hosts: [] };
  const [a] = parseActions(JSON.stringify([{ ...base, label: { en: 'Continue in Claude Code', fr: 'Continuer dans Claude Code' } }]), env);
  assert.equal(a.label, 'Continue in Claude Code');
  assert.deepEqual(publicAction(a).labels, { en: 'Continue in Claude Code', fr: 'Continuer dans Claude Code' });
  const [b] = parseActions(JSON.stringify([{ ...base, label: 'Deploy' }]), env);
  assert.equal(b.label, 'Deploy');
  assert.equal('labels' in publicAction(b), false);
  assert.throws(() => parseActions(JSON.stringify([{ ...base, label: { english: 'x' } }]), env), /two-letter language/);
  assert.throws(() => parseActions(JSON.stringify([{ ...base, label: {} }]), env), /"label"/);
  assert.match(page, /const actionLabel = \(a\) => \(a\.labels && typeof a\.labels\[tr\.lang\] === 'string' \? a\.labels\[tr\.lang\] : a\.label\);/);
});
