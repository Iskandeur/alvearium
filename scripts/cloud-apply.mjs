#!/usr/bin/env node
// Uncommitted cloud copy: what the environment setup script (scripts/cloud-setup.sh) applies to every
// repository cloned in a claude.ai/code cloud VM. Same files as /session-board:install-cloud, but
// hidden from git, so no session can commit them by mistake:
//   - files the repository does not track      → listed in .git/info/exclude
//   - files it tracks (.claude/settings.json, .mcp.json) → `git update-index --skip-worktree`
// A repository that commits its own copy (install-cloud) is left alone: the committed copy wins.
// Run by the git post-checkout hook of the cloud VM (after the clone, before Claude Code starts),
// so it must stay fast and silent. Usage: node cloud-apply.mjs [repoDir] [--uninstall] [--quiet]
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/core.mjs';
import { MARKER, install } from './install-repo.mjs';

export const EXCLUDE_TAG = '# session-board cloud setup (uncommitted copy)';
const COPY_VERSION = '.claude/session-board/VERSION';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (repo, ...args) => {
  try {
    return git(repo, ...args);
  } catch {
    return null;
  }
};
const tracked = (repo, path) => (tryGit(repo, 'ls-files', '--', path) || '').split('\n').filter(Boolean);

/** Pure: the exclude file with one `/path` line per path added once, under our tag. */
export function mergeExclude(text, paths) {
  const lines = (text || '').split('\n');
  const have = new Set(lines.map((l) => l.trim()));
  const add = paths.map((p) => `/${p}`).filter((p) => !have.has(p));
  if (!add.length) return text || '';
  const base = text && !text.endsWith('\n') ? text + '\n' : text || '';
  return base + (have.has(EXCLUDE_TAG) ? '' : EXCLUDE_TAG + '\n') + add.join('\n') + '\n';
}

/** Pure: the exclude file without our tag and our lines. */
export function stripExclude(text, paths) {
  const ours = new Set([EXCLUDE_TAG, ...paths.map((p) => `/${p}`)]);
  return (text || '')
    .split('\n')
    .filter((l) => !ours.has(l.trim()))
    .join('\n');
}

const ALL_PATHS = ['.claude/session-board/', '.claude/settings.json', '.claude/skills/session-board-tickets/', '.mcp.json', '.claude/commands/board.md', '.claude/commands/ticket.md'];

/**
 * Apply (or remove) the hidden copy in the repository containing dir.
 * Returns a short word for the log: applied, current, committed-copy, not-a-repo, removed, own-repo.
 */
export function cloudApply(dir, { remove = false } = {}) {
  const repo = tryGit(dir, 'rev-parse', '--show-toplevel');
  if (!repo) return 'not-a-repo';
  if (existsSync(join(repo, '.claude-plugin', 'plugin.json')) && existsSync(join(repo, 'scripts', 'cloud-apply.mjs'))) return 'own-repo';
  if (tracked(repo, COPY_VERSION).length) return 'committed-copy';
  const exclude = resolve(repo, git(repo, 'rev-parse', '--git-path', 'info/exclude'));

  if (remove) {
    for (const p of ALL_PATHS) for (const f of tracked(repo, p)) tryGit(repo, 'update-index', '--no-skip-worktree', '--', f);
    install(repo, { remove: true, local: false });
    // a tracked file we merged into goes back to its committed content
    for (const p of ['.claude/settings.json', '.mcp.json']) if (tracked(repo, p).length) tryGit(repo, 'checkout', '--', p);
    if (existsSync(exclude)) writeFileSync(exclude, stripExclude(readFileSync(exclude, 'utf8'), ALL_PATHS));
    return 'removed';
  }

  const current =
    existsSync(join(repo, COPY_VERSION)) &&
    readFileSync(join(repo, COPY_VERSION), 'utf8').trim() === VERSION &&
    existsSync(join(repo, '.claude', 'settings.json')) &&
    readFileSync(join(repo, '.claude', 'settings.json'), 'utf8').includes(MARKER);
  if (current) return 'current';

  const { paths } = install(repo, { local: false });
  // tells the copy's hook it came from the environment, not from a commit (stale-version notice)
  writeFileSync(join(repo, '.claude', 'session-board', 'ENVIRONMENT'), `cloud environment setup script, ${new Date().toISOString()}\n`);
  const hide = [];
  for (const p of paths) {
    const files = tracked(repo, p);
    if (files.length) for (const f of files) tryGit(repo, 'update-index', '--skip-worktree', '--', f);
    else hide.push(p);
  }
  mkdirSync(dirname(exclude), { recursive: true });
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const after = mergeExclude(before, hide);
  if (after !== before) appendFileSync(exclude, after.slice(before.length));
  return 'applied';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const dir = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  try {
    const result = cloudApply(dir, { remove: args.includes('--uninstall') });
    if (!quiet) console.log(`session-board ${VERSION}: ${result} (${dir})`);
  } catch (e) {
    if (!quiet) console.error(`session-board: ${e.message}`);
  }
}
