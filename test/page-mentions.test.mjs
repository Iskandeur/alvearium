// Mention parsing on the board page: the core parser is a pure function, run here on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dirname, '..', 'server', 'page.html'), 'utf8');

// Extract by slicing between two function declarations: stable on indentation and regex literals.
const from = page.indexOf('function computeMention(text, caret, all) {');
const to = page.indexOf('function mentionUpdate(ta) {', from);
assert.ok(from > 0 && to > from, 'computeMention() is in the page');
const src = page.slice(from, to);
const computeMention = new Function(`${src}; return computeMention;`)();

test('mentions: @ at start and after whitespace opens', () => {
  const all = [
    { id: 'fern', name: 'Fern' },
    { id: 'rikki-tikki-tavi', name: 'Rikki' },
  ];
  const a = computeMention('hi @f', 'hi @f'.length, all);
  assert.ok(a);
  assert.equal(a.start, 3);
  assert.equal(a.end, 5);
  assert.equal(a.q, 'f');
  assert.equal(a.list[0].id, 'fern');
});

test('mentions: names first, one-off runs last, so « @lu » is not 20 runs of the same agent', () => {
  const runs = Array.from({ length: 25 }, (_, i) => ({ id: `lupi/job-${100 + i}`, name: `Job ${100 + i}`, ephemeral: 100 + i }));
  const all = [...runs, { id: 'lupi', name: 'Lupi', ephemeral: 0 }, { id: 'lupi/ruche-dev', name: 'Ferao', ephemeral: 0 }, { id: 'zed', name: 'Lucie', ephemeral: 0 }];
  const a = computeMention('@lu', 3, all);
  assert.deepEqual(a.list.slice(0, 3).map((x) => x.id), ['lupi', 'zed', 'lupi/ruche-dev']);
  assert.equal(a.list.length, 20);
  const f = computeMention('@fer', 4, all);
  assert.deepEqual(f.list.map((x) => x.id), ['lupi/ruche-dev'], 'found by its display name');
});

test('ephemeralActor: a sub-actor ending in a number is a one-off run, newest has the biggest number', () => {
  const i = page.indexOf('const ephemeralActor = (id) => {');
  const j = page.indexOf('};', i);
  assert.ok(i > 0 && j > i, 'ephemeralActor() is in the page');
  const ephemeralActor = new Function(`${page.slice(i, j + 2)}; return ephemeralActor;`)();
  assert.equal(ephemeralActor('lupi/job-1365'), 1365);
  assert.equal(ephemeralActor('lupi/wake-12'), 12);
  assert.equal(ephemeralActor('lupi/ruche-dev'), 0);
  assert.equal(ephemeralActor('lupi'), 0);
  assert.equal(ephemeralActor('ci-2'), 0, 'a top-level actor is never a run');
});

test('runRanker: a named sibling of numbered runs (bot/wake-news next to bot/wake-12) goes with the runs', () => {
  const i = page.indexOf('const ephemeralActor = (id) => {');
  const j = page.indexOf('const actorIdTitle = ', i);
  assert.ok(i > 0 && j > i && page.slice(i, j).includes('const runRanker = (ids) => {'), 'runRanker() is in the page');
  const runRanker = new Function(`${page.slice(i, j)}; return runRanker;`)();
  const ids = ['bot', 'bot/wake-12', 'bot/wake-news', 'bot/wake-disk-usage', 'bot/crew-dev', 'bot/crew-ops', 'bot/job-7', 'my-bot/wake-3', 'my-bot/wake-feed', 'wake-x'];
  const run = runRanker(ids);
  assert.equal(run('bot/wake-12'), 12, 'a numbered run keeps its number');
  assert.equal(run('bot/wake-news'), 0.5);
  assert.equal(run('bot/wake-disk-usage'), 0.5, 'a name with dashes is still in the family');
  assert.equal(run('my-bot/wake-feed'), 0.5, 'a parent with a dash');
  assert.equal(run('bot/crew-dev'), 0, 'no numbered crew-N: a lasting agent');
  assert.equal(run('bot'), 0);
  assert.equal(run('wake-x'), 0, 'a top-level actor is never a run');
  assert.ok(run('bot/wake-12') > run('bot/wake-news'), 'numbered runs before named ones');
  assert.equal(runRanker(['bot/crew-dev', 'bot/crew-ops'])('bot/crew-dev'), 0, 'siblings alone make no family');
});

test('mentions: @ inside a word is ignored', () => {
  const all = [{ id: 'fern', name: 'Fern' }];
  assert.equal(computeMention('x@f', 3, all), null);
});

test('mentions: invalid query closes', () => {
  const all = [{ id: 'fern', name: 'Fern' }];
  assert.equal(computeMention('hi @f_', 6, all), null);
});
