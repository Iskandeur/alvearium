// The environment setup script (scripts/cloud-setup.sh) and the uncommitted copy it applies
// (scripts/cloud-apply.mjs): every repository cloned in the VM gets the board, git sees nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../lib/core.mjs';
import { staleCopyNotice } from '../lib/runtime.mjs';
import { EXCLUDE_TAG, mergeExclude, stripExclude } from '../scripts/cloud-apply.mjs';
import { MARKER } from '../scripts/install-repo.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const APPLY = join(ROOT, 'scripts', 'cloud-apply.mjs');
const SETUP = join(ROOT, 'scripts', 'cloud-setup.sh');
const tmp = () => mkdtempSync(join(tmpdir(), 'sb-setup-'));
// Never the user's git config: no global ignore, no template, no /etc/gitconfig.
const NO_XDG = tmp();
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: NO_XDG, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV });
const apply = (dir, ...flags) => execFileSync(process.execPath, [APPLY, dir, ...flags], { encoding: 'utf8', env: ENV }).trim();
const status = (dir) => git(dir, 'status', '--porcelain', '-uall');

/** A repository with a committed .claude/settings.json (one hook of its own) and a README. */
function project() {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, '.claude'));
  const own = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo own' }] }] } };
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(own, null, 2) + '\n');
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, own: readFileSync(join(dir, '.claude', 'settings.json'), 'utf8') };
}

test('exclude lines: added once under the tag, removed cleanly', () => {
  const a = mergeExclude('# git default\n*.log', ['.mcp.json', '.claude/session-board/']);
  assert.equal(a, `# git default\n*.log\n${EXCLUDE_TAG}\n/.mcp.json\n/.claude/session-board/\n`);
  assert.equal(mergeExclude(a, ['.mcp.json']), a);
  assert.equal(stripExclude(a, ['.mcp.json', '.claude/session-board/']), '# git default\n*.log\n');
});

test('cloud-apply: the copy is written, git status stays clean, a second run is a no-op', () => {
  const { dir, own } = project();
  assert.match(apply(dir), /: applied/);
  const settings = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8');
  assert.ok(settings.includes(MARKER), 'hooks merged');
  assert.ok(settings.includes('echo own'), 'the repo hook kept');
  for (const p of ['.mcp.json', '.claude/session-board/VERSION', '.claude/skills/session-board-tickets/SKILL.md', '.claude/commands/board.md', '.claude/commands/ticket.md'])
    assert.ok(existsSync(join(dir, p)), p);
  assert.equal(readFileSync(join(dir, '.claude/session-board/VERSION'), 'utf8').trim(), VERSION);
  assert.ok(existsSync(join(dir, '.claude/session-board/ENVIRONMENT')), 'the copy knows it came from the environment');
  assert.match(staleCopyNotice('0.3.2', '0.4.0', { SESSION_BOARD_DIR: tmp() }, { fromEnvironment: true }), /setup script installed version 0\.3\.2.*0\.4\.0/);
  assert.equal(status(dir), '', 'nothing for git to see');
  assert.match(git(dir, 'ls-files', '-v', '.claude/settings.json'), /^S /, 'tracked settings: skip-worktree');
  // `git add -A` + commit cannot pick the copy up
  git(dir, 'add', '-A');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '');
  assert.match(apply(dir), /: current/);
  const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split(EXCLUDE_TAG).length, 2, 'tag written once');
  // uninstall: back to the committed state
  assert.match(apply(dir, '--uninstall'), /: removed/);
  assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), own);
  assert.ok(!existsSync(join(dir, '.mcp.json')));
  assert.ok(!existsSync(join(dir, '.claude/session-board')));
  assert.equal(status(dir), '');
  assert.ok(!readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').includes(EXCLUDE_TAG));
});

test('cloud-apply: a repository that commits its own copy is left alone; a non-repo is skipped', () => {
  const { dir } = project();
  mkdirSync(join(dir, '.claude', 'session-board'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'session-board', 'VERSION'), '0.3.1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'committed copy');
  assert.match(apply(dir), /: committed-copy/);
  assert.equal(status(dir), '');
  assert.ok(!existsSync(join(dir, '.mcp.json')));
  assert.match(apply(tmp()), /: not-a-repo/);
});

test('cloud-setup.sh: fetches a pinned ref, every later clone gets the hidden copy, rerun is idempotent', () => {
  // the "GitHub" side: a repository with this working tree on a v-tag
  const source = tmp();
  cpSync(ROOT, source, { recursive: true, filter: (p) => !p.includes(`${ROOT}/.git`) && !p.includes('node_modules') });
  git(source, 'init', '-q', '-b', 'main');
  git(source, 'add', '-A');
  git(source, 'commit', '-q', '-m', 'release');
  git(source, 'tag', 'v-test');
  const { dir: upstream } = project();

  const home = tmp();
  const sbHome = join(home, 'sb');
  const gitGlobal = join(home, 'gitconfig');
  const gitSystem = join(home, 'gitconfig-system');
  writeFileSync(gitGlobal, '');
  writeFileSync(gitSystem, '');
  const env = { ...ENV, HOME: home, GIT_CONFIG_GLOBAL: gitGlobal, GIT_CONFIG_SYSTEM: gitSystem, GIT_CONFIG_NOSYSTEM: '', SESSION_BOARD_HOME: sbHome, SESSION_BOARD_REPO_URL: source };
  // a repository already cloned before the setup script ran (first, uncached session)
  const early = join(home, 'early');
  execFileSync('git', ['clone', '-q', upstream, early], { env });
  const run = () => execFileSync('bash', [SETUP, 'v-test'], { encoding: 'utf8', env, cwd: home });
  const out = run();
  assert.match(out, new RegExp(`${VERSION.replace(/\./g, '\\.')} \\(v-test\\) ready`));
  assert.ok(existsSync(join(sbHome, 'scripts', 'cloud-apply.mjs')));
  assert.equal(git(home, 'config', '--file', gitSystem, 'init.templateDir').trim(), join(sbHome, 'git-template'));
  assert.ok(readFileSync(join(early, '.claude', 'settings.json'), 'utf8').includes(MARKER), 'existing clone applied');
  assert.equal(execFileSync('git', ['-C', early, 'status', '--porcelain', '-uall'], { encoding: 'utf8', env }), '');

  // a cached session: no setup script, only the clone; the template hook does the work
  const later = join(home, 'later');
  execFileSync('git', ['clone', '-q', upstream, later], { env });
  assert.ok(readFileSync(join(later, '.claude', 'settings.json'), 'utf8').includes(MARKER), 'clone-time hook applied');
  assert.ok(existsSync(join(later, '.mcp.json')));
  assert.equal(execFileSync('git', ['-C', later, 'status', '--porcelain', '-uall'], { encoding: 'utf8', env }), '');
  // a branch switch keeps it, and a commit of everything carries none of it
  execFileSync('git', ['-C', later, 'checkout', '-q', '-b', 'claude/work'], { env });
  writeFileSync(join(later, 'feature.txt'), 'x\n');
  execFileSync('git', ['-C', later, 'add', '-A'], { env });
  assert.equal(execFileSync('git', ['-C', later, 'diff', '--cached', '--name-only'], { encoding: 'utf8', env }).trim(), 'feature.txt');

  // rerun (setup script changed, cache rebuilt): same state, nothing duplicated
  run();
  const tpl = readFileSync(join(sbHome, 'git-template', 'hooks', 'post-checkout'), 'utf8');
  assert.ok(tpl.includes('cloud-apply.mjs'));
  assert.equal(readFileSync(join(early, '.git', 'info', 'exclude'), 'utf8').split(EXCLUDE_TAG).length, 2);
});

test('cloud-setup.sh raw fallback lists every file the copy needs', () => {
  const listed = /^FILES="([^"]+)"/m.exec(readFileSync(SETUP, 'utf8'))[1].split(/\s+/);
  const install = readFileSync(join(ROOT, 'scripts', 'install-repo.mjs'), 'utf8');
  const vendored = [.../const FILES = \[([\s\S]*?)\];/.exec(install)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const f of [...vendored, 'scripts/install-repo.mjs', 'scripts/cloud-apply.mjs', 'skills/tickets/SKILL.md']) assert.ok(listed.includes(f), f);
});

test('cloud-setup.sh never fails the session, even when nothing can be fetched', () => {
  const home = tmp();
  const env = { ...ENV, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'g'), GIT_CONFIG_SYSTEM: join(home, 's'), SESSION_BOARD_HOME: join(home, 'sb'), SESSION_BOARD_REPO_URL: join(home, 'nothing-here') };
  // raw.githubusercontent.com fallback would hit the network: an unknown ref makes it fail fast either way
  const r = execFileSync('bash', ['-c', `bash "${SETUP}" no-such-ref-${Date.now()}; echo "exit=$?"`], { encoding: 'utf8', env, cwd: home });
  assert.match(r, /exit=0/);
  assert.match(r, /could not fetch|node not found/);
  assert.ok(!existsSync(join(home, 'sb')));
});
