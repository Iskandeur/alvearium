// server/routes.json est le contrat des routes de l'API : ce que le serveur sert, ce que la page appelle, et ce
// qu'un proxy d'authentification placé devant doit en laisser passer. Né du 15/10 : les actions d'alvéole
// (0.5.11) étaient livrées et déployées, mais le proxy d'une installation ne connaissait pas `/api/actions` ;
// la page lisait un 404, se croyait face à un vieux serveur et cachait ses boutons, quatre jours sans que
// personne le voie. Ici : une route ajoutée au serveur ou à la page sans une ligne du contrat fait échouer ce
// test, donc l'auteur doit dire en même temps si un proxy doit la laisser passer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SERVER = resolve(import.meta.dirname, '..', 'server');
const read = (f) => readFileSync(join(SERVER, f), 'utf8');
const contract = JSON.parse(read('routes.json'));
const routes = contract.routes;

const segs = (p) => p.split('/').filter(Boolean);
/** Un modèle `/api/tickets/:key` couvre-t-il ce chemin concret ? (`:x` = un segment quelconque) */
const covers = (template, concrete) => {
  const t = segs(template);
  const c = segs(concrete);
  return t.length === c.length && t.every((s, i) => s.startsWith(':') || s === c[i]);
};
const known = (path, method) => routes.some((r) => covers(r.path, path) && (!method || r.method === method));
/** `api/tickets/${encodeURIComponent(k)}/move?x=1` → `/api/tickets/x/move` */
const normalize = (raw) => '/' + raw.replace(/\$\{[^}]*\}/g, 'x').replace(/\?.*$/, '').replace(/^\/+|\/+$/g, '');

test('le contrat est bien formé', () => {
  assert.equal(contract.version, 1);
  const seen = new Set();
  for (const r of routes) {
    const id = `${r.method} ${r.path}`;
    assert.ok(!seen.has(id), `doublon : ${id}`);
    seen.add(id);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method), id);
    assert.ok(r.path.startsWith('/api/'), id);
    assert.ok([true, false, 'ingest'].includes(r.proxy), `${id} : proxy vaut true, false ou "ingest"`);
    assert.ok(Array.isArray(r.from) && r.from.length && r.from.every((f) => ['page', 'clients'].includes(f)), `${id} : from`);
    if (r.proxy !== true) assert.ok(typeof r.note === 'string' && r.note.length > 10, `${id} : une route que le proxy refuse dit pourquoi (note)`);
    if (r.path.includes(':')) {
      assert.ok(typeof r.example === 'string', `${id} : un chemin à paramètres porte un example`);
      assert.ok(covers(r.path, r.example), `${id} : example ne correspond pas au chemin`);
    }
  }
});

test('chaque appel de la page est dans le contrat', () => {
  const page = read('page.html');
  const calls = [];
  for (const m of page.matchAll(/\bapi\(\s*(['`])([^'`]+)\1/g)) calls.push({ path: m[2], method: null });
  for (const m of page.matchAll(/\bapiCall\(\s*'([A-Z]+)'\s*,\s*(['`])([^'`]+)\2/g)) calls.push({ path: m[3], method: m[1] });
  for (const m of page.matchAll(/\bfetch\(\s*(['`])api\/([^'`]+)\1(?:\s*,\s*\{\s*method:\s*'([A-Z]+)')?/g)) calls.push({ path: m[2], method: m[3] || null });
  // Un balayage devenu aveugle (la page change de forme d'appel) ne doit pas passer pour « rien à signaler ».
  assert.ok(calls.length >= 25, `${calls.length} appels vus seulement : le balayage ne lit plus la page`);
  const inconnus = calls.filter((c) => !known(normalize('api/' + c.path.replace(/^api\//, '')), c.method));
  assert.deepEqual(inconnus.map((c) => `${c.method || '*'} ${c.path}`), [], 'ajoute ces routes à server/routes.json (et dis si un proxy doit les laisser passer)');
});

test('chaque route du serveur est dans le contrat', () => {
  const lits = [];
  const familles = new Set();
  for (const f of ['server.mjs', 'actions.mjs', 'invites.mjs']) {
    const src = read(f);
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9_/-]+)'/g)) lits.push(m[1]);
    for (const m of src.matchAll(/\/\^\\\/api\\\/([a-z]+)/g)) familles.add(m[1]);
  }
  assert.ok(lits.length >= 20, `${lits.length} routes vues seulement : le balayage ne lit plus le serveur`);
  assert.deepEqual([...new Set(lits)].filter((p) => !known(p)), [], 'ajoute ces routes à server/routes.json');
  for (const fam of familles) assert.ok(routes.some((r) => segs(r.path)[1] === fam), `famille /api/${fam}/… absente du contrat`);
});
