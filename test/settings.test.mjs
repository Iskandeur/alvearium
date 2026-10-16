// 0.5.16: install settings. server/settings.json says which environment variables an installation sets and what
// is lost without them; the server warns at startup and in /api/version. Born of 0.5.15 (BOARD_DEFAULT_ROUTER):
// the release was deployed automatically, the setting was never set, and the feature did nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION, compareVersions } from '../lib/core.mjs';
import { LEVELS, loadManifest, missingSettings, parseManifest, settingsReport, warnLines } from '../lib/settings.mjs';
import { createApp } from '../server/server.mjs';
import { openStore } from '../lib/store.mjs';

const ROOT = join(import.meta.dirname, '..');
const manifest = loadManifest(join(ROOT, 'server'));

test('the manifest parses, and no setting is introduced after this version', () => {
  assert.ok(manifest.length >= 3);
  for (const s of manifest) {
    assert.ok(LEVELS.includes(s.level), s.name);
    assert.ok(compareVersions(s.since, VERSION) <= 0, `${s.name} claims ${s.since}, ahead of ${VERSION}`);
  }
});

test('every environment variable the server and the store read is in the manifest', () => {
  const listed = new Set(manifest.map((s) => s.name));
  // Process-level variables (where to listen, where the data lives) are not "settings of a feature".
  const infra = new Set(['SESSION_BOARD_DATA', 'SESSION_BOARD_TRUST_PROXY', 'SESSION_BOARD_TOKEN_FILE', 'SESSION_BOARD_TOKEN', 'PORT', 'HOST']);
  const files = [join(ROOT, 'server', 'server.mjs'), ...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => join(ROOT, 'lib', f))];
  const unlisted = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.(BOARD_[A-Z0-9_]+)/g)) if (!listed.has(m[1]) && !infra.has(m[1])) unlisted.add(`${m[1]} (${f.replace(ROOT, '.')})`);
  }
  assert.deepEqual([...unlisted], [], 'add these to server/settings.json');
});

test('a required or expected setting that is blank or absent is missing; optional never is', () => {
  const m = parseManifest(JSON.stringify({ version: 1, settings: [
    { name: 'A_REQ', since: '0.1.0', level: 'required', effect: 'x' },
    { name: 'A_EXP', since: '0.2.0', level: 'expected', effect: 'y' },
    { name: 'A_OPT', since: '0.3.0', level: 'optional', effect: 'z' },
  ] }));
  assert.deepEqual(missingSettings(m, {}).map((s) => s.name), ['A_REQ', 'A_EXP']);
  assert.deepEqual(missingSettings(m, { A_REQ: 'v', A_EXP: '   ' }).map((s) => s.name), ['A_EXP']);
  assert.deepEqual(missingSettings(m, { A_REQ: 'v', A_EXP: 'v' }), []);
  assert.match(warnLines(settingsReport(m, {}))[0], /A_REQ is not set \(required, since 0\.1\.0\): x/);
});

test('a malformed manifest is refused', () => {
  const bad = (s) => assert.throws(() => parseManifest(JSON.stringify(s)));
  bad({ version: 2, settings: [] });
  bad({ version: 1, settings: [{ name: 'a', since: '0.1.0', level: 'optional', effect: 'x' }] });
  bad({ version: 1, settings: [{ name: 'A', since: '1', level: 'optional', effect: 'x' }] });
  bad({ version: 1, settings: [{ name: 'A', since: '0.1.0', level: 'maybe', effect: 'x' }] });
  bad({ version: 1, settings: [{ name: 'A', since: '0.1.0', level: 'optional', effect: '' }] });
  bad({ version: 1, settings: [{ name: 'A', since: '0.1.0', level: 'optional', effect: 'x' }, { name: 'A', since: '0.1.0', level: 'optional', effect: 'x' }] });
});

test('BOARD_DEFAULT_ROUTER is expected since 0.5.15, the case that started this', () => {
  const s = manifest.find((x) => x.name === 'BOARD_DEFAULT_ROUTER');
  assert.equal(s.level, 'expected');
  assert.equal(s.since, '0.5.15');
  assert.deepEqual(missingSettings(manifest, {}).map((x) => x.name), ['BOARD_DEFAULT_ROUTER']);
});

test('/api/version reports the missing settings, and none when everything is set', async () => {
  const store = await openStore(':memory:');
  const get = async (settings) => {
    const server = createServer(createApp({ token: 't'.repeat(32), store, page: '<html></html>', settings }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/version`, { headers: { authorization: `Bearer ${'t'.repeat(32)}` } });
      return await res.json();
    } finally {
      server.close();
    }
  };
  try {
    const out = await get(settingsReport(manifest, {}));
    assert.equal(out.version, VERSION);
    assert.deepEqual(out.settings.missing.map((x) => x.name), ['BOARD_DEFAULT_ROUTER']);
    assert.equal((await get(settingsReport(manifest, { BOARD_DEFAULT_ROUTER: 'lupi' }))).settings.missing.length, 0);
  } finally {
    store.close();
  }
});
