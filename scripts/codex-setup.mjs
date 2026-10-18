#!/usr/bin/env node
// OpenAI Codex CLI setup (0.7.0): point Codex at this checkout of Alvearium.
//   $CODEX_HOME/config.toml   an `[mcp_servers.alvearium]` block (the ticket tools), between markers
//   $CODEX_HOME/hooks.json    Codex hooks that run hooks/report.mjs --codex (the session ticket)
//   $CODEX_HOME/skills/alvearium-tickets/SKILL.md   when to use the ticket tools
// $CODEX_HOME defaults to ~/.codex. Codex skips a new or changed hook until you trust it: open
// `codex`, type /hooks, review and trust the Alvearium hooks once.
// Running it again updates what it wrote; everything else in those files is kept as is.
// Usage: node scripts/codex-setup.mjs [--print] [--uninstall] [--codex-home <dir>] [--url <url> --token <token>]
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, isEntryPoint } from '../lib/core.mjs';
import { dataDir } from '../lib/runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MCP_NAME = 'alvearium';
export const SKILL_NAME = 'alvearium-tickets';
export const TOML_BEGIN = '# >>> alvearium (scripts/codex-setup.mjs) >>>';
export const TOML_END = '# <<< alvearium <<<';
/** Every hook command we write carries both: a later run knows the hook is ours. */
const HOOK_MARKER = '/hooks/report.mjs';
const FLAG = '--codex';
/** Variables the MCP server may read from the shell that starts `codex` (Codex passes a fixed few otherwise). */
export const MCP_ENV_VARS = [
  'SESSION_BOARD_URL',
  'SESSION_BOARD_TOKEN',
  'SESSION_BOARD_DIR',
  'SESSION_BOARD_ACTOR',
  'SESSION_BOARD_ACTOR_NAME',
  'SESSION_BOARD_FEEDBACK_ASSIGNEE',
];

// Codex hook event → async? Codex's events carry the payload fields the Claude Code hooks read
// (session_id, cwd, transcript_path, prompt, tool_name, tool_input, last_assistant_message,
// agent_id, agent_type, source, reason). Codex has no Notification, Elicitation, StopFailure,
// TaskCreated or TaskCompleted event: those rows of the board's hook table do not exist under Codex.
export const CODEX_EVENTS = {
  SessionStart: false,
  UserPromptSubmit: true,
  PreToolUse: true,
  PostToolUse: true,
  PermissionRequest: true,
  Stop: false,
  SubagentStart: true,
  SubagentStop: true,
  SessionEnd: false, // Codex always runs SessionEnd synchronously, 3 s at most
};

const q = (s) => JSON.stringify(s);
export const codexHome = (env = process.env) => env.CODEX_HOME || join(homedir(), '.codex');

/** The command Codex runs for one event. `node` from the PATH, like the Claude Code plugin's hooks. */
export function hookCommand(ev, root = ROOT) {
  return `node ${q(join(root, 'hooks', 'report.mjs'))} ${ev} ${FLAG}`;
}

const isOurs = (group) =>
  Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER) && h.command.includes(FLAG));

/** Pure: a Codex hooks.json with our hooks removed, then (unless remove) added back. Other hooks are kept. */
export function mergeCodexHooks(existing, { remove = false, root = ROOT } = {}) {
  const out = { ...(existing || {}) };
  const hooks = { ...(out.hooks || {}) };
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].filter((g) => !isOurs(g));
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!remove) {
    for (const [ev, isAsync] of Object.entries(CODEX_EVENTS)) {
      const hook = { type: 'command', command: hookCommand(ev, root), timeout: ev === 'SessionEnd' ? 3 : 5 };
      if (isAsync) hook.async = true;
      const group = ['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(ev) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
      hooks[ev] = [...(hooks[ev] || []), group];
    }
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  if (!out.description && !remove) out.description = 'Alvearium: report each Codex session to the ticket board';
  return out;
}

/** The config.toml block. JSON strings are valid TOML basic strings (Windows backslashes included). */
export function mcpBlock(root = ROOT) {
  return [
    TOML_BEGIN,
    `# Alvearium ${VERSION}: the ticket tools. Remove this block, or run codex-setup.mjs --uninstall, to take it out.`,
    `[mcp_servers.${MCP_NAME}]`,
    `command = "node"`,
    `args = [${q(join(root, 'mcp', 'server.mjs'))}, ${q(FLAG)}]`,
    `env_vars = [${MCP_ENV_VARS.map(q).join(', ')}]`,
    '# The ticket tools only write to your board: no approval prompt for each call (needed by `codex exec`).',
    `default_tools_approval_mode = "approve"`,
    TOML_END,
  ].join('\n');
}

const tableRe = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${MCP_NAME}|"${MCP_NAME}")\s*\]`, 'm');

/**
 * Pure: config.toml with our block replaced, added at the end, or (remove) taken out.
 * conflict = an `[mcp_servers.alvearium]` table we did not write is already there (left untouched).
 */
export function mergeCodexConfig(text, { remove = false, root = ROOT } = {}) {
  const src = String(text || '');
  const begin = src.indexOf(TOML_BEGIN);
  const end = begin >= 0 ? src.indexOf(TOML_END, begin) : -1;
  let rest = src;
  if (begin >= 0 && end > begin) rest = src.slice(0, begin).replace(/\n+$/, '\n') + src.slice(end + TOML_END.length).replace(/^\n+/, '');
  if (rest.trim() === '') rest = '';
  if (tableRe.test(rest)) return { text: src, conflict: true };
  if (remove) return { text: rest, conflict: false };
  const sep = rest && !rest.endsWith('\n') ? '\n\n' : rest ? '\n' : '';
  return { text: rest + sep + mcpBlock(root) + '\n', conflict: false };
}

/** The plugin's `tickets` skill, renamed for Codex. */
export function codexSkill(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('skills/tickets/SKILL.md has no frontmatter');
  const desc = /^description:\s*(.*)$/m.exec(m[1])?.[1] || '';
  return ['---', `name: ${SKILL_NAME}`, `description: ${desc}`, '---', '', `<!-- Written by Alvearium ${VERSION} scripts/codex-setup.mjs; running it again replaces this file. -->`, text.slice(m[0].length)].join('\n');
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Writes (or, with print, only describes) the setup. Returns the lines to print. */
export function setup({ home = codexHome(), remove = false, print = false, url = '', token = '', env = process.env, root = ROOT } = {}) {
  const lines = [];
  const write = (path, text) => {
    if (print) {
      lines.push(`--- ${path}`, text.trimEnd(), '');
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  // 1. The MCP server, in config.toml.
  const configPath = join(home, 'config.toml');
  const config = mergeCodexConfig(readText(configPath) ?? '', { remove, root });
  if (config.conflict) lines.push(`${configPath}: an [mcp_servers.${MCP_NAME}] table is already there and was not written by this script; left as is. Compare it with:\n${mcpBlock(root)}`);
  else if (!remove || existsSync(configPath)) {
    write(configPath, config.text);
    if (!print) lines.push(`${remove ? 'removed the MCP server from' : 'MCP server set in'} ${configPath}`);
  }

  // 2. The hooks, in hooks.json.
  const hooksPath = join(home, 'hooks.json');
  const raw = readText(hooksPath);
  let current = {};
  if (raw != null && raw.trim()) {
    try {
      current = JSON.parse(raw);
    } catch {
      throw new Error(`${hooksPath} is not valid JSON; fix it (or move it away) and run this again. Nothing was written to it.`);
    }
  }
  const merged = mergeCodexHooks(current, { remove, root });
  const onlyDescription = remove && Object.keys(merged).every((k) => k === 'description');
  if (remove && onlyDescription && raw != null) {
    if (print) lines.push(`--- ${hooksPath}`, '(deleted: only Alvearium hooks were in it)', '');
    else rmSync(hooksPath, { force: true });
  } else if (!remove || raw != null) write(hooksPath, JSON.stringify(merged, null, 2) + '\n');
  if (!print) lines.push(`${remove ? 'removed the hooks from' : 'hooks set in'} ${hooksPath}`);

  // 3. The skill.
  const skillPath = join(home, 'skills', SKILL_NAME, 'SKILL.md');
  if (remove) {
    if (!print) rmSync(dirname(skillPath), { recursive: true, force: true });
  } else write(skillPath, codexSkill(readFileSync(join(root, 'skills', 'tickets', 'SKILL.md'), 'utf8')));

  // 4. Optional: the board server, in Alvearium's own config file (read by the hooks and the MCP server).
  if (!remove && (url || token)) {
    if (!url || !token) throw new Error('--url and --token go together.');
    const dir = dataDir(env);
    const path = join(dir, 'config.json');
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(path, 'utf8'));
    } catch {}
    const text = JSON.stringify({ ...cfg, url: url.replace(/\/+$/, ''), token }, null, 2) + '\n';
    if (print) lines.push(`--- ${path}`, text.replace(/"token": ".*"/, '"token": "…"').trimEnd(), '');
    else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {}
      lines.push(`board server set in ${path}`);
    }
  }

  if (!print && !remove) {
    lines.push(
      '',
      'Next: start `codex`, type /hooks and trust the Alvearium hooks (Codex skips a hook until you do;',
      'again after an update that changes them). The ticket tools work without that step.'
    );
  }
  return lines;
}

function parseArgs(argv) {
  const opts = { remove: argv.includes('--uninstall'), print: argv.includes('--print') };
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] || '' : '';
  };
  if (val('--codex-home')) opts.home = resolve(val('--codex-home'));
  opts.url = val('--url');
  opts.token = val('--token');
  return opts;
}

if (isEntryPoint(import.meta.url)) {
  try {
    for (const l of setup(parseArgs(process.argv.slice(2)))) console.log(l);
  } catch (e) {
    console.error(`alvearium codex-setup: ${e.message}`);
    process.exit(1);
  }
}
