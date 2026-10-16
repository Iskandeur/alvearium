// Install settings (0.5.16). server/settings.json lists the environment variables an installation sets for a
// feature to work. A setting shipped in a release but absent from an installation used to fail silently:
// 0.5.15 hands a ticket over when the owner comments, but only with BOARD_DEFAULT_ROUTER set, and an
// automatic deployment moved the server to 0.5.15 without anyone setting it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LEVELS = ['required', 'expected', 'optional'];

/** Reads and checks the manifest. Throws on a malformed one: a broken manifest should fail the tests, not hide. */
export function parseManifest(text) {
  const m = JSON.parse(text);
  if (m?.version !== 1 || !Array.isArray(m.settings)) throw new Error('settings manifest: version 1 and a settings list expected');
  const seen = new Set();
  for (const s of m.settings) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(String(s?.name))) throw new Error(`settings manifest: bad name ${JSON.stringify(s?.name)}`);
    if (seen.has(s.name)) throw new Error(`settings manifest: ${s.name} listed twice`);
    seen.add(s.name);
    if (!/^\d+\.\d+\.\d+$/.test(String(s.since))) throw new Error(`settings manifest: ${s.name} has no valid "since"`);
    if (!LEVELS.includes(s.level)) throw new Error(`settings manifest: ${s.name} has level ${JSON.stringify(s.level)}`);
    if (typeof s.effect !== 'string' || !s.effect.trim()) throw new Error(`settings manifest: ${s.name} has no "effect"`);
  }
  return m.settings.map(({ name, since, level, effect }) => ({ name, since, level, effect }));
}

export function loadManifest(serverDir) {
  try {
    return parseManifest(readFileSync(join(serverDir, 'settings.json'), 'utf8'));
  } catch (e) {
    console.error(`alvearium: install settings manifest unreadable (${e.message}); not checking them`);
    return [];
  }
}

/** The entries a required or expected setting says are missing from `env` (a blank value counts as missing). */
export function missingSettings(manifest, env = process.env) {
  return manifest.filter((s) => s.level !== 'optional' && !String(env[s.name] ?? '').trim());
}

/** The report served by /api/version and printed at startup. */
export function settingsReport(manifest, env = process.env) {
  return { missing: missingSettings(manifest, env) };
}

export function warnLines(report) {
  return report.missing.map((s) => `alvearium: ${s.name} is not set (${s.level}, since ${s.since}): ${s.effect}`);
}
