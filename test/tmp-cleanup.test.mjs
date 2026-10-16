import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ALV-988 : un processus qui crée un répertoire par mkdtempSync sous le tmpdir ne le laisse pas derrière lui.
test('tmp-cleanup : le répertoire créé par mkdtempSync disparaît à la sortie', () => {
  const pre = join(import.meta.dirname, 'tmp-cleanup.mjs');
  const code = "import { mkdtempSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; const d = mkdtempSync(join(tmpdir(), 'sb-clean-')); writeFileSync(join(d, 'x'), '1'); console.log(d);";
  const dir = execFileSync(process.execPath, ['--import', pre, '--input-type=module', '-e', code], { encoding: 'utf8' }).trim();
  assert.match(dir, /sb-clean-/);
  assert.equal(existsSync(dir), false);
});
