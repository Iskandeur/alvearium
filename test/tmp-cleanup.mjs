// Préchargé par `npm test` (`node --import`) : tout répertoire créé par `mkdtempSync` sous le tmpdir pendant un fichier de
// test est supprimé à la sortie du processus. Les tests faisaient `mkdtempSync(join(tmpdir(), 'sb-…-'))` sans jamais rien
// retirer, et /tmp se remplissait (ALV-988).
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';

const made = [];
const real = fs.mkdtempSync;
fs.mkdtempSync = (prefix, options) => {
  const dir = real(prefix, options);
  if (typeof dir === 'string' && dir.startsWith(tmpdir())) made.push(dir);
  return dir;
};
syncBuiltinESMExports(); // les `import { mkdtempSync } from 'node:fs'` des tests voient la version enveloppée

process.on('exit', () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // un répertoire encore tenu par un enfant : le prochain passage de nettoyage de /tmp le prendra
    }
  }
});
