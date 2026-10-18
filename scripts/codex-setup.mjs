#!/usr/bin/env node
// OpenAI Codex CLI setup (0.7.0): point Codex at this checkout of Alvearium.
//   $CODEX_HOME/config.toml   an `[mcp_servers.alvearium]` block (the ticket tools), between markers
//   $CODEX_HOME/hooks.json    Codex hooks that run hooks/report.mjs --codex (the session ticket)
//   $CODEX_HOME/skills/alvearium-tickets/SKILL.md   when to use the ticket tools
// $CODEX_HOME defaults to ~/.codex. Codex skips a new or changed hook until you trust it: open
// `codex`, type /hooks, review and trust the Alvearium hooks once.
// Running it again updates what it wrote; everything else in those files is kept as is.
// Usage: node scripts/codex-setup.mjs [--print] [--uninstall] [--codex-home <dir>] [--auto-approve-writes]
//        [--url <url>]   the token is read from SESSION_BOARD_TOKEN, or from stdin with `--token -`
//                        (a prompt when stdin is a terminal); `--token <token>` still works but is discouraged
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
// Either separator: on Windows, hookCommand writes `C:\\…\\hooks\\report.mjs` (JSON-escaped backslashes).
const HOOK_MARKER = /[\\/]hooks[\\/]+report\.mjs/;
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

/** Ticket tools that only read: approved without asking. The others (create, update, comment, hold, feedback) write. */
export const READ_TOOLS = ['ticket_get', 'ticket_list', 'ticket_next'];

const DESCRIPTION = 'Alvearium: report each Codex session to the ticket board';
const q = (s) => JSON.stringify(s);
export const codexHome = (env = process.env) => env.CODEX_HOME || join(homedir(), '.codex');

/** The command Codex runs for one event. `node` from the PATH, like the Claude Code plugin's hooks. */
export function hookCommand(ev, root = ROOT) {
  return `node ${q(join(root, 'hooks', 'report.mjs'))} ${ev} ${FLAG}`;
}

const isOurs = (group) =>
  Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && HOOK_MARKER.test(h.command) && h.command.includes(FLAG));

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
  if (!remove && !out.description) out.description = DESCRIPTION;
  if (remove && out.description === DESCRIPTION) delete out.description;
  return out;
}

/** The config.toml block. JSON strings are valid TOML basic strings (Windows backslashes included). */
export function mcpBlock(root = ROOT, { approveWrites = false } = {}) {
  return [
    TOML_BEGIN,
    `# Alvearium ${VERSION}: the ticket tools. Remove this block, or run codex-setup.mjs --uninstall, to take it out.`,
    `[mcp_servers.${MCP_NAME}]`,
    `command = "node"`,
    `args = [${q(join(root, 'mcp', 'server.mjs'))}, ${q(FLAG)}]`,
    `env_vars = [${MCP_ENV_VARS.map(q).join(', ')}]`,
    approveWrites
      ? '# --auto-approve-writes: every ticket tool runs without asking (what `codex exec` needs to create tickets).'
      : '# The read-only tools run without asking; the tools that write ask first. Rerun with --auto-approve-writes to skip that.',
    `default_tools_approval_mode = "${approveWrites ? 'approve' : 'prompt'}"`,
    ...(approveWrites ? [] : READ_TOOLS.flatMap((t) => ['', `[mcp_servers.${MCP_NAME}.tools.${t}]`, 'approval_mode = "approve"'])),
    TOML_END,
  ].join('\n');
}

const tableRe = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${MCP_NAME}|"${MCP_NAME}")\s*\]`, 'm');

/**
 * Pure: config.toml with our block replaced, added at the end, or (remove) taken out.
 * conflict = an `[mcp_servers.alvearium]` table we did not write is already there (left untouched).
 */
export function mergeCodexConfig(text, { remove = false, root = ROOT, approveWrites = false } = {}) {
  const src = String(text || '');
  const begin = src.indexOf(TOML_BEGIN);
  const end = begin >= 0 ? src.indexOf(TOML_END, begin) : -1;
  let rest = src;
  if (begin >= 0 && end > begin) rest = src.slice(0, begin).replace(/\n+$/, '\n') + src.slice(end + TOML_END.length).replace(/^\n+/, '');
  else if (begin >= 0) {
    // A block cut short by hand (no end marker): ours is the begin marker and the lines after it that we write
    // (comments, our tables and their keys); a blank line belongs to it only when one of our lines follows.
    const lines = src.slice(begin).split('\n');
    const ours = (l) => /^#/.test(l) || /^\[mcp_servers\.alvearium(\.tools\.[a-z_]+)?\]\s*$/.test(l) || /^(command|args|env_vars|default_tools_approval_mode|approval_mode)\s*=/.test(l);
    let n = 1;
    for (let i = 1; i < lines.length; i++) {
      if (ours(lines[i])) n = i + 1;
      else if (lines[i].trim() !== '') break;
    }
    rest = src.slice(0, begin).replace(/\n+$/, '\n') + lines.slice(n).join('\n').replace(/^\n+/, '');
  }
  if (rest.trim() === '') rest = '';
  if (tableRe.test(rest)) return { text: src, conflict: true };
  if (remove) return { text: rest, conflict: false };
  const sep = rest && !rest.endsWith('\n') ? '\n\n' : rest ? '\n' : '';
  return { text: rest + sep + mcpBlock(root, { approveWrites }) + '\n', conflict: false };
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
export function setup({ home = codexHome(), remove = false, print = false, url = '', token = '', approveWrites = false, env = process.env, root = ROOT } = {}) {
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
  const config = mergeCodexConfig(readText(configPath) ?? '', { remove, root, approveWrites });
  if (config.conflict) lines.push(`${configPath}: an [mcp_servers.${MCP_NAME}] table is already there and was not written by this script; left as is. Compare it with:\n${mcpBlock(root, { approveWrites })}`);
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
  if (!print && (!remove || raw != null)) lines.push(`${remove ? 'removed the hooks from' : 'hooks set in'} ${hooksPath}`);

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

export function parseArgs(argv) {
  const opts = { remove: argv.includes('--uninstall'), print: argv.includes('--print'), approveWrites: argv.includes('--auto-approve-writes') };
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] || '' : '';
  };
  if (val('--codex-home')) opts.home = resolve(val('--codex-home'));
  opts.url = val('--url');
  opts.token = val('--token');
  return opts;
}

/** Reads all of stdin (a piped token), or one line typed without echo when stdin is a terminal. */
async function readToken(stdin = process.stdin) {
  if (stdin.isTTY) {
    process.stderr.write('Board token (input hidden): ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return await new Promise((done) => {
      let buf = '';
      stdin.on('data', function onData(c) {
        for (const ch of c) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off('data', onData);
            process.stderr.write('\n');
            return done(buf.trim());
          }
          if (ch === '\u0003') {
            stdin.setRawMode(false);
            process.stderr.write('\n');
            process.exit(130);
          }
          buf = ch === '\u007f' ? buf.slice(0, -1) : buf + ch;
        }
      });
    });
  }
  let buf = '';
  stdin.setEncoding('utf8');
  for await (const c of stdin) buf += c;
  return buf.trim();
}

/**
 * The token for --url: SESSION_BOARD_TOKEN, or stdin with `--token -` (a prompt on a terminal).
 * `--token <token>` on the command line is still accepted, with a warning: it shows in the shell history and in `ps`.
 */
export async function resolveToken(opts, { env = process.env, read = readToken, warn = (m) => console.error(m) } = {}) {
  if (opts.remove || !opts.url) return opts;
  if (opts.token === '-') return { ...opts, token: await read() };
  if (opts.token) {
    warn('alvearium codex-setup: warning: --token <token> exposes the token in your shell history and in the process list; prefer SESSION_BOARD_TOKEN or `--token -` (stdin).');
    return opts;
  }
  if (env.SESSION_BOARD_TOKEN) return { ...opts, token: env.SESSION_BOARD_TOKEN };
  return { ...opts, token: await read() };
}

if (isEntryPoint(import.meta.url)) {
  try {
    for (const l of setup(await resolveToken(parseArgs(process.argv.slice(2))))) console.log(l);
  } catch (e) {
    console.error(`alvearium codex-setup: ${e.message}`);
    process.exit(1);
  }
}
