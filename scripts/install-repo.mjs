#!/usr/bin/env node
// Commit-able cloud reporting: copy the hook script into <repo>/.claude/session-board/ and register
// it in <repo>/.claude/settings.json. Usage: node install-repo.mjs <repoDir> [--uninstall]
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '.claude/session-board/hooks/report.mjs';
const FILES = ['hooks/report.mjs', 'lib/core.mjs', 'lib/runtime.mjs'];

// event → async? (same choices as the plugin's hooks/hooks.json)
export const EVENTS = {
  SessionStart: false,
  UserPromptSubmit: true,
  PreToolUse: true,
  PostToolUse: true,
  PermissionRequest: true,
  Notification: true,
  Elicitation: true,
  Stop: false,
  StopFailure: false,
  SessionEnd: false,
};

const isOurs = (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER));

/** Pure: return settings with session-board's repo hooks removed, then (unless remove) added back. */
export function mergeRepoHooks(settings, { remove = false } = {}) {
  const out = { ...(settings || {}) };
  const hooks = { ...(out.hooks || {}) };
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).filter((g) => !isOurs(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!remove) {
    for (const [ev, isAsync] of Object.entries(EVENTS)) {
      const hook = {
        type: 'command',
        command: `node "$CLAUDE_PROJECT_DIR/${MARKER}" ${ev} --cloud-only`,
        timeout: ev === 'SessionEnd' ? 2 : 5,
      };
      if (isAsync) hook.async = true;
      const matcher = ['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(ev) ? '*' : '';
      hooks[ev] = [...(hooks[ev] || []), { matcher, hooks: [hook] }];
    }
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--uninstall');
  const repo = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  const claudeDir = join(repo, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      console.error(`session-board: ${settingsPath} is not valid JSON; fix it first, nothing was changed.`);
      process.exit(1);
    }
  }
  mkdirSync(claudeDir, { recursive: true });
  const target = join(claudeDir, 'session-board');
  if (remove) {
    rmSync(target, { recursive: true, force: true });
  } else {
    for (const f of FILES) {
      mkdirSync(dirname(join(target, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(target, f));
    }
    writeFileSync(
      join(target, 'README.md'),
      '# session-board (cloud reporting)\n\nCopied by the `session-board` Claude Code plugin (`/session-board:install-cloud`).\n' +
        'These hooks only run in claude.ai/code cloud sessions (`--cloud-only`) and report session state to\n' +
        'the board server named by `SESSION_BOARD_URL`. Remove with `/session-board:install-cloud --uninstall`.\n' +
        'Source: https://github.com/Iskandeur/session-board\n',
    );
  }
  writeFileSync(settingsPath, JSON.stringify(mergeRepoHooks(settings, { remove }), null, 2) + '\n');
  console.log(remove ? `session-board: removed from ${repo}` : `session-board: cloud hooks written to ${target} and ${settingsPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
