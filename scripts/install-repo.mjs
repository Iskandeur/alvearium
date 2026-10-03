#!/usr/bin/env node
// Commit-able cloud copy: claude.ai/code cloud sessions never install plugins, but they load what a
// repository commits (hooks in .claude/settings.json, .mcp.json, .claude/skills/, .claude/commands/).
// This vendors session-board into <repo>:
//   .claude/session-board/      hook script, MCP server, /board and /ticket scripts, their lib/, VERSION
//   .claude/settings.json       the hooks, `--cloud-only`
//   .mcp.json                   a `session-board` MCP server, `--cloud-only` (no tool outside the cloud)
//   .claude/skills/session-board-tickets/SKILL.md, .claude/commands/{board,ticket}.md
// and quiets the copy on THIS machine, which has the plugin, in the untracked .claude/settings.local.json.
// Running it again updates the copy. Usage: node install-repo.mjs <repoDir> [--uninstall] [--no-local]
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MARKER = '.claude/session-board/hooks/report.mjs';
export const MCP_NAME = 'session-board';
export const MCP_MARKER = '.claude/session-board/mcp/server.mjs';
export const SKILL_NAME = 'session-board-tickets';
export const COMMANDS = ['board', 'ticket'];
/** Written in every vendored command, so a later run knows the file is ours (and may replace it). */
export const COMMAND_TAG = '<!-- session-board cloud copy -->';
const FILES = [
  'hooks/report.mjs',
  'lib/core.mjs',
  'lib/runtime.mjs',
  'lib/store.mjs',
  'mcp/server.mjs',
  'scripts/board.mjs',
  'scripts/ticket.mjs',
];

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
  TaskCreated: true,
  TaskCompleted: true,
  SubagentStart: true,
  SubagentStop: true,
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

/** The .mcp.json entry. `${CLAUDE_PROJECT_DIR:-.}`: the variable is the server's, not Claude Code's (MCP docs). */
export function mcpEntry() {
  return { command: 'node', args: [`\${CLAUDE_PROJECT_DIR:-.}/${MCP_MARKER}`, '--cloud-only'] };
}

const isOurMcp = (entry) => Array.isArray(entry?.args) && entry.args.some((a) => typeof a === 'string' && a.includes(MCP_MARKER));

/**
 * Pure: .mcp.json with our server set (or removed), every other server kept as is.
 * Returns { config, conflict }: conflict = a different server already uses the name (left untouched).
 * config === null means "the file would be empty: delete it".
 */
export function mergeMcpJson(existing, { remove = false } = {}) {
  const out = { ...(existing || {}) };
  const servers = { ...(out.mcpServers || {}) };
  const current = servers[MCP_NAME];
  if (current && !isOurMcp(current)) return { config: existing || {}, conflict: true };
  delete servers[MCP_NAME];
  if (!remove) servers[MCP_NAME] = mcpEntry();
  out.mcpServers = servers;
  if (remove && !Object.keys(servers).length) {
    delete out.mcpServers;
    if (!Object.keys(out).length) return { config: null, conflict: false };
  }
  return { config: out, conflict: false };
}

/**
 * Pure: the untracked .claude/settings.local.json of a machine that has the plugin. The project
 * MCP server is rejected there (no approval prompt, no second process) and the vendored skill and
 * commands are hidden: the plugin already provides them. Cloud sessions never see this file.
 */
export function mergeLocalSettings(existing, { remove = false } = {}) {
  const out = { ...(existing || {}) };
  const disabled = (out.disabledMcpjsonServers || []).filter((n) => n !== MCP_NAME);
  if (!remove) disabled.push(MCP_NAME);
  if (disabled.length) out.disabledMcpjsonServers = disabled;
  else delete out.disabledMcpjsonServers;
  const overrides = { ...(out.skillOverrides || {}) };
  for (const name of [SKILL_NAME, ...COMMANDS]) {
    if (remove) {
      if (overrides[name] === 'off') delete overrides[name];
    } else if (!(name in overrides)) overrides[name] = 'off';
  }
  if (Object.keys(overrides).length) out.skillOverrides = overrides;
  else delete out.skillOverrides;
  return out;
}

/** The plugin's `tickets` skill, renamed and fenced for the copy committed in a repository. */
export function vendoredSkill(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('skills/tickets/SKILL.md has no frontmatter');
  const desc = /^description:\s*(.*)$/m.exec(m[1])?.[1] || '';
  const front = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${desc} (Repository copy for claude.ai/code cloud sessions; where the session-board plugin's own tickets skill is listed, use that one.)`,
    '---',
  ].join('\n');
  const note =
    `\n\n> Copied into this repository by \`/session-board:install-cloud\` (session-board ${VERSION}). It is meant for\n` +
    "> claude.ai/code cloud sessions, where plugins are not installed. If the session-board MCP tools\n" +
    '> (`ticket_create`, `ticket_next`, …) are not available in this session, ignore this skill.\n';
  return front + note + text.slice(m[0].length).replace(/^(\s*\n)?/, '\n');
}

export function vendoredCommand(name) {
  const lines = {
    board: [
      '---',
      'description: Show the session board (cloud copy of session-board) - waiting on you, in progress, to do',
      'allowed-tools: Bash(node:*)',
      'argument-hint: "[--here] [--repo <name>] [--q <text>]"',
      '---',
      '!`node "${CLAUDE_PROJECT_DIR}/.claude/session-board/scripts/board.mjs" --cloud-only $ARGUMENTS`',
      '',
      'Show the output above to the user exactly as printed, inside a code block. Do not add commentary,',
      'do not summarize it, and do not take any action on the tickets it lists.',
    ],
    ticket: [
      '---',
      'description: Tickets on the session board (cloud copy of session-board) - new, next, done, status, priority, block, list, show, comment',
      'allowed-tools: Bash(node:*)',
      'argument-hint: "new <title> [--priority P1] [--blocked-by SB-3] | next | done <KEY> | status <KEY> <status> | list [--all] [words] | show <KEY> | comment <KEY> <text>"',
      '---',
      '!`node "${CLAUDE_PROJECT_DIR}/.claude/session-board/scripts/ticket.mjs" --cloud-only "$ARGUMENTS"`',
      '',
      'Show the output above to the user exactly as printed, inside a code block. Do not add commentary',
      'and do not act on the tickets it lists.',
    ],
  }[name];
  return lines.join('\n') + `\n\n${COMMAND_TAG}\n`;
}

const README = `# session-board (cloud copy)

Copied by the \`session-board\` Claude Code plugin (\`/session-board:install-cloud\`): claude.ai/code cloud
sessions do not install plugins, so this repository carries what they need.

- \`hooks/\`: session state on the board (registered in \`.claude/settings.json\`, \`--cloud-only\`)
- \`mcp/\`: the ticket tools for Claude (registered in \`.mcp.json\` as \`session-board\`, \`--cloud-only\`)
- \`scripts/\`: what \`/board\` and \`/ticket\` run (\`.claude/commands/\`); the skill is \`.claude/skills/${SKILL_NAME}/\`

Everything here is silent outside a cloud session (\`CLAUDE_CODE_REMOTE\` is not \`true\`): machines with
the plugin keep using the plugin. It reports to the server named by \`SESSION_BOARD_URL\` (with
\`SESSION_BOARD_TOKEN\`, or \`SESSION_BOARD_TOKEN=proxy\` and an API credential for that host).
\`VERSION\` is the version of this copy: run \`/session-board:install-cloud\` again to update it, or
\`/session-board:install-cloud --uninstall\` to remove it.
Source: https://github.com/Iskandeur/session-board
`;

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; fix it first, nothing was changed.`);
  }
}

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

/** Make sure git never commits .claude/settings.local.json (Claude Code usually ignores it already). */
function ignoreLocalSettings(repo) {
  try {
    execFileSync('git', ['-C', repo, 'check-ignore', '-q', '.claude/settings.local.json'], { stdio: 'ignore' });
    return 'ignored';
  } catch (e) {
    if (e.status !== 1) return 'no-git';
  }
  try {
    const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    const exclude = resolve(repo, gitDir, 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    appendFileSync(exclude, `${before && !before.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
    return 'excluded';
  } catch {
    return 'no-git';
  }
}

/**
 * Write (or, with remove, delete) the cloud copy in repo. Returns { notes, paths }: paths are the
 * repo-relative files and directories this copy owns (the ones cloud-apply.mjs hides from git).
 */
export function install(repo, { remove = false, local = true } = {}) {
  const claudeDir = join(repo, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const mcpPath = join(repo, '.mcp.json');
  const localPath = join(claudeDir, 'settings.local.json');
  const settings = readJsonFile(settingsPath);
  const mcp = readJsonFile(mcpPath);
  const localSettings = local ? readJsonFile(localPath) : null;
  const notes = [];
  const paths = ['.claude/session-board/', '.claude/settings.json', `.claude/skills/${SKILL_NAME}/`];

  mkdirSync(claudeDir, { recursive: true });
  const target = join(claudeDir, 'session-board');
  rmSync(target, { recursive: true, force: true }); // an update must not keep files a newer version dropped
  if (!remove) {
    for (const f of FILES) {
      mkdirSync(dirname(join(target, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(target, f));
    }
    writeFileSync(join(target, 'VERSION'), VERSION + '\n');
    writeFileSync(join(target, 'README.md'), README);
  }
  writeJson(settingsPath, mergeRepoHooks(settings, { remove }));

  const merged = mergeMcpJson(mcp, { remove });
  if (merged.conflict) notes.push(`.mcp.json already has a different "${MCP_NAME}" server: left as is, so the ticket tools are NOT installed.`);
  else if (merged.config === null) rmSync(mcpPath, { force: true });
  else {
    writeJson(mcpPath, merged.config);
    paths.push('.mcp.json');
  }

  const skillDir = join(claudeDir, 'skills', SKILL_NAME);
  if (remove) rmSync(skillDir, { recursive: true, force: true });
  else {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), vendoredSkill(readFileSync(join(ROOT, 'skills', 'tickets', 'SKILL.md'), 'utf8')));
  }

  for (const name of COMMANDS) {
    const path = join(claudeDir, 'commands', `${name}.md`);
    const ours = existsSync(path) && readFileSync(path, 'utf8').includes(COMMAND_TAG);
    if (existsSync(path) && !ours) {
      if (!remove) notes.push(`.claude/commands/${name}.md exists and is not session-board's: left as is, /${name} is not installed.`);
      continue;
    }
    if (remove) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, vendoredCommand(name));
      paths.push(`.claude/commands/${name}.md`);
    }
  }

  if (local) {
    const next = mergeLocalSettings(localSettings, { remove });
    if (Object.keys(next).length) {
      writeJson(localPath, next);
      if (!remove && ignoreLocalSettings(repo) === 'excluded') notes.push('added .claude/settings.local.json to .git/info/exclude (it must never be committed).');
    } else rmSync(localPath, { force: true });
  }

  return { notes, paths };
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--uninstall');
  const local = !args.includes('--no-local');
  const repo = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  let notes;
  try {
    ({ notes } = install(repo, { remove, local }));
  } catch (e) {
    console.error(`session-board: ${e.message}`);
    process.exit(1);
  }
  console.log(
    remove
      ? `session-board: cloud copy removed from ${repo}`
      : `session-board ${VERSION}: cloud copy written to ${repo} (.claude/session-board/, .claude/settings.json, .mcp.json, ` +
          `.claude/skills/${SKILL_NAME}/, .claude/commands/)` +
          (local ? '; on this machine the copy stays quiet (.claude/settings.local.json), the plugin does the work.' : '.'),
  );
  for (const n of notes) console.log(`session-board: ${n}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
