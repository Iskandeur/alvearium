#!/usr/bin/env node
// session-board MCP server: lets Claude create, update, list and comment tickets.
// Zero dependencies: JSON-RPC 2.0 over stdio, one JSON message per line (MCP stdio transport).
// Declared inline in .claude-plugin/plugin.json (`mcpServers.tickets`).
//
// Same backend as the CLI: the board server when SESSION_BOARD_URL/TOKEN (or the plugin options)
// are set, else the local SQLite store in ~/.claude/session-board/board.db.
//
// `--cloud-only`: the copy that `/session-board:install-cloud` vendors into a repository (declared in
// the repo's .mcp.json). Outside a claude.ai/code cloud session it offers no tool at all, so a machine
// that also has the plugin does not see every tool twice; in the cloud it needs the server (a local
// board would die with the VM).
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_TYPES, PRIORITIES, STATUSES, VERSION, actorDisplayName, markdownToTerminal, repoFromRemote, truncate } from '../lib/core.mjs';
import { CLOUD_SETUP_HINT, dataDir, loadConfig, openBackend, sessionForCwd } from '../lib/runtime.mjs';

export { VERSION };
const SERVER_INFO = { name: 'alvearium', version: VERSION };
const ASSIGNEE = { type: 'string', description: 'user = the human (default); claude = Claude; or any actor id (an agent, e.g. "ci-bot")' };
const PRIORITY = { type: 'string', enum: PRIORITIES, description: 'P0 = drop everything, P1 = next up, P2 = normal, P3 = some day' };
const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'ticket_create',
    description:
      'Create a ticket on the session board. Use it for an action item the human must do (assignee "user": create a secret, review a PR, decide something), ' +
      'or to split a long task into tracked steps (assignee "claude"). The ticket is attached to the current session and repo unless told otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Add the STRIPE_KEY secret to the staging env"' },
        body: { type: 'string', description: 'Markdown details: why, exact steps, links' },
        assignee: ASSIGNEE,
        status: { type: 'string', enum: STATUSES, description: 'Default: todo. Use waiting_on_user when the human must act before Claude can go on.' },
        kind: { type: 'string', description: 'action (default for the human), task, bug, question, note… any short slug' },
        priority: PRIORITY,
        labels: { type: 'array', items: { type: 'string' } },
        parent: { type: 'string', description: 'Key of the parent ticket (e.g. SB-12) to make this a sub-ticket' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Keys of tickets that must be done first (e.g. ["SB-3"]). Cycles are refused.' },
        links: { type: 'array', items: { type: 'string' }, description: 'https URLs (PR, docs) or repo-relative file paths' },
        session: { type: 'string', description: '"current" (default), "none" for a ticket outside any session, or a session id' },
      },
      required: ['title'],
    },
  },
  {
    name: 'ticket_update',
    description:
      'Change a ticket: status (todo, in_progress, waiting_on_user, review, done, cancelled, failed), title, body, labels, priority (P0-P3), assignee, ' +
      'dependencies (blocked_by_add / blocked_by_remove: keys of tickets that block this one); optionally add a comment in the same call.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Ticket key, e.g. SB-12' },
        status: { type: 'string', enum: STATUSES },
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: ASSIGNEE,
        priority: { type: 'string', enum: [...PRIORITIES, ''], description: 'P0…P3, or "" to clear' },
        labels: { type: 'array', items: { type: 'string' } },
        blocked_by_add: { type: 'array', items: { type: 'string' }, description: 'Keys of tickets that block this one (must be done first)' },
        blocked_by_remove: { type: 'array', items: { type: 'string' }, description: 'Keys of blockers to remove' },
        comment: { type: 'string', description: 'Optional note recorded in the ticket history' },
      },
      required: ['key'],
    },
  },
  {
    name: 'ticket_next',
    description:
      'What to work on now: open tickets that nothing blocks, most important first (P0…P3), then the manual order, then the oldest. ' +
      'Default: this repository. Use it before picking up work, and after finishing a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['repo', 'session', 'all'], description: 'Default: repo (falls back to all outside a git repo)' },
        assignee: { type: 'string', description: 'Only tickets held by this actor (user, claude, or an actor id); "me" = this agent' },
        label: { type: 'string' },
        limit: { type: 'number', description: 'Default 10' },
      },
    },
  },
  {
    name: 'board_feedback',
    description:
      'Report a problem or an improvement to the feedback inbox of the board: a bug, a suggestion, or a friction (a tool, an instruction or the board itself made you lose time). ' +
      'Context (session, repo, agent, plugin version) is attached automatically. Be specific: what you tried, what happened, what would have helped.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line, e.g. "ticket_list ignores the label filter"' },
        detail: { type: 'string', description: 'What happened, what you expected, how to reproduce, what it cost' },
        type: { type: 'string', enum: FEEDBACK_TYPES, description: 'bug: broken; suggestion: an improvement; friction: works but wastes time. Default: suggestion' },
        about: { type: 'string', description: 'What it is about: a tool name, a command, a doc, "board"…' },
        priority: PRIORITY,
      },
      required: ['title'],
    },
  },
  {
    name: 'ticket_list',
    description: 'List tickets. Default: the open tickets of the current session. Use scope "repo" for the whole repository, "all" for everything.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'repo', 'all'] },
        status: { type: 'string', description: 'Comma-separated statuses, or "open" (default) / "closed" / "any"' },
        assignee: ASSIGNEE,
        kind: { type: 'string', description: 'e.g. task, action, bug; "feedback" lists the feedback inbox (left out otherwise)' },
        priority: { type: 'string', description: 'P0, P1, P2, P3 (comma-separated), or "none"' },
        label: { type: 'string' },
        q: { type: 'string', description: 'Free text over title, body and comments' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'ticket_comment',
    description: 'Add a comment to a ticket (progress note, answer, what is left).',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, text: { type: 'string' }, to: { type: 'string', description: 'Optional: who the comment is for (user, claude, an actor id)' } },
      required: ['key', 'text'],
    },
  },
  {
    name: 'ticket_get',
    description: 'Show one ticket with its history and sub-tickets.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
];

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Where the MCP server runs: the project dir of the session that spawned it. */
export function currentContext(env = process.env, cwd = env.CLAUDE_PROJECT_DIR || process.cwd()) {
  const remembered = sessionForCwd(dataDir(env), cwd) || (cwd !== process.cwd() ? sessionForCwd(dataDir(env), process.cwd()) : null);
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  const fromEnv = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
  // A cloud VM runs one session: the id the hooks recorded for this directory is the hooks' own
  // `session_id`, so it wins there. Locally several sessions share a directory: the env wins.
  const sessionId = (cloud ? remembered?.sessionId || fromEnv : fromEnv || remembered?.sessionId) || null;
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const cfg = loadConfig(env);
  return {
    actor: cfg.actor || 'claude',
    session_id: sessionId && /^[\w.:-]{1,128}$/.test(sessionId) ? sessionId : null,
    ...(cloud && remembered?.sessionId ? { fromHooks: true } : {}),
    repo: repoFromRemote(git(cwd, ['remote', 'get-url', 'origin'])) || remembered?.repo || null,
    branch: branch || remembered?.branch || null,
    cwd,
    machine: cloud ? 'claude.ai/code' : hostname(),
    origin: cloud ? 'cloud' : 'terminal',
  };
}

const aName = (id, name) => (id === 'user' ? 'user' : id === 'claude' ? 'claude' : actorDisplayName(id, name));

const line = (t) => {
  const held =
    t.assignee === 'user' ? ', on user' : t.assignee && t.assignee !== 'claude' ? ', ' + aName(t.assignee, (t.actors || {})[t.assignee]?.name) : '';
  return (
    `${t.key}${t.priority ? ' ' + t.priority : ''} [${t.status}${held}${t.blocked ? ', blocked' : ''}] ${t.title}` +
    (t.repo ? ` · ${t.repo}${t.branch && t.branch !== 'HEAD' ? '@' + t.branch : ''}` : '') +
    (t.labels?.length ? ` · ${t.labels.map((l) => '#' + l).join(' ')}` : '')
  );
};

function describe(t) {
  const out = [line(t)];
  if (t.parent_key) out.push(`parent: ${t.parent_key} ${t.parent_title || ''}`.trim());
  if (t.blocked_by?.length) out.push(`blocked by: ${t.blocked_by.map((b) => `${b.key} [${b.status}]`).join(', ')}`);
  if (t.blocking?.length) out.push(`blocks: ${t.blocking.map((b) => `${b.key} [${b.status}]`).join(', ')}`);

  if (t.body) out.push('', markdownToTerminal(t.body, { ansi: true, max: 1800 }));

  for (const l of t.links || []) out.push(`link: ${l.url}`);
  if (t.children?.length) out.push('', 'sub-tickets:', ...t.children.map((c) => '  ' + line(c)));
  if (t.events?.length) {
    out.push('', 'history:');
    for (const e of t.events.slice(-15)) {
      const actor = aName(e.actor, (t.actors || {})[e.actor]?.name);
      const target = e.target ? aName(e.target, (t.actors || {})[e.target]?.name) : '';
      const ts = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
      const body = e.text ? markdownToTerminal(e.text, { ansi: true, max: 260 }) : '';
      const what =
        e.type === 'comment'
          ? `comment:\n${body}`
          : e.from_status || e.to_status
            ? `${e.type} ${e.from_status ?? ''}→${e.to_status ?? ''}${body ? '\n' + body : ''}`
            : `${e.type}${body ? '\n' + body : ''}`;
      out.push(`  ${ts} ${actor}${target ? ' → ' + target : ''}: ${what}`);
    }
  }
  return out.join('\n');
}

/** A write that came back without a ticket key did not happen: say so, never "Created undefined". */
function must(t, tool) {
  if (t && typeof t === 'object' && typeof t.key === 'string' && t.key) return t;
  const seen = t && typeof t === 'object' ? JSON.stringify(t).slice(0, 160) : String(t).slice(0, 160);
  throw new Error(
    `${tool}: the board answered without a ticket (${seen}). Nothing was saved. ` +
      'Is the request reaching the board API (proxy, credential)? Run: node .claude/session-board/scripts/doctor.mjs (cloud copy) or /alvearium:board doctor.'
  );
}

export async function callTool(name, args = {}, { backend, context }) {
  switch (name) {
    case 'ticket_create': {
      const body = { ...args };
      const where = body.session ?? 'current';
      delete body.session;
      const { actor: _actor, fromHooks: _fromHooks, ...ctx } = context;
      if (where === 'current') Object.assign(body, Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null)));
      else if (where !== 'none') Object.assign(body, { session_id: where, cwd: context.cwd, machine: context.machine, origin: context.origin });
      else Object.assign(body, { repo: context.repo, branch: context.branch, cwd: context.cwd, machine: context.machine, origin: context.origin });
      if (!body.assignee) body.assignee = 'user';
      if (!body.kind) body.kind = body.assignee === 'user' ? 'action' : 'task';
      const t = must(await backend.create(body), 'ticket_create');
      return `Created ${line(t)}`;
    }
    case 'ticket_update': {
      const { key, ...rest } = args;
      const t = must(await backend.update(String(key), rest), 'ticket_update');
      return `Updated ${line(t)}`;
    }
    case 'ticket_comment': {
      const t = must(await backend.comment(String(args.key), String(args.text ?? ''), args.to ? String(args.to) : undefined), 'ticket_comment');
      return `Commented on ${t.key} (${t.comments_count} comment${t.comments_count === 1 ? '' : 's'})`;
    }
    case 'ticket_get':
      return describe(await backend.get(String(args.key)));
    case 'ticket_next': {
      const scope = args.scope || 'repo';
      const params = { limit: Math.min(Number(args.limit) || 10, 50) };
      if (args.assignee) params.assignee = args.assignee === 'me' ? context.actor || 'claude' : String(args.assignee);
      if (args.label) params.label = String(args.label);
      let where = scope;
      if (scope === 'session') {
        if (!context.session_id) return 'No current session known yet. Use scope "repo" or "all".';
        params.session = context.session_id;
      } else if (scope === 'repo') {
        if (context.repo) params.repo = context.repo;
        else where = 'all';
      }
      const r = await backend.next(params);
      const blocked = r.blocked ? ` (${r.blocked} more blocked)` : '';
      if (!r.tickets.length) return `Nothing to pick up (${where})${blocked}.`;
      return [`Next (${where}), in order${blocked}:`, ...r.tickets.map((t, i) => `${i + 1}. ${line(t)}`), r.total > r.tickets.length ? `… ${r.total - r.tickets.length} more` : '']
        .filter(Boolean)
        .join('\n');
    }
    case 'board_feedback': {
      const type = FEEDBACK_TYPES.includes(args.type) ? args.type : 'suggestion';
      const ctx = [
        `- reported by: ${context.actor || 'claude'}`,
        context.session_id ? `- session: ${context.session_id}` : null,
        context.repo ? `- repo: ${context.repo}${context.branch && context.branch !== 'HEAD' ? '@' + context.branch : ''}` : null,
        `- machine: ${context.machine}`,
        args.about ? `- about: ${truncate(String(args.about), 120)}` : null,
        `- Alvearium plugin ${VERSION}`,
      ].filter(Boolean);
      const body = [String(args.detail || '').trim(), '', '---', ...ctx].join('\n').trim();
      const t = await backend.create({
        title: String(args.title || '').trim(),
        body,
        kind: 'feedback',
        subtype: type,
        assignee: 'user',
        priority: args.priority,
        labels: ['feedback', type],
        session_id: context.session_id,
        repo: context.repo,
        branch: context.branch,
        cwd: context.cwd,
        machine: context.machine,
        origin: context.origin,
      });
      must(t, 'board_feedback');
      return `Feedback recorded: ${t.key} (${type}). Thank you; it is in the board's feedback inbox.`;
    }
    case 'ticket_list': {
      const scope = args.scope || 'session';
      const params = { limit: Math.min(Number(args.limit) || 50, 200) };
      const status = args.status || 'open';
      if (status !== 'any') params.status = status;
      for (const k of ['assignee', 'kind', 'label', 'q', 'priority']) if (args[k]) params[k] = args[k];
      if (scope === 'session') {
        if (!context.session_id) return 'No current session known (the board has not seen this session yet). Use scope "repo" or "all".';
        params.session = context.session_id;
      } else if (scope === 'repo') {
        if (!context.repo) return 'This directory has no git remote; use scope "all".';
        params.repo = context.repo;
      }
      const r = await backend.list(params);
      if (!r.tickets.length) return `No ${status === 'any' ? '' : status + ' '}tickets (${scope}).`;
      return [`${r.total} ticket${r.total === 1 ? '' : 's'} (${scope}, ${status}):`, ...r.tickets.map(line), r.total > r.tickets.length ? `… ${r.total - r.tickets.length} more` : '']
        .filter(Boolean)
        .join('\n');
    }
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

/**
 * What this process offers. `cloudOnly` (the vendored copy): nothing outside the cloud, and in the
 * cloud an actionable error instead of a local board when the server is not configured.
 */
export function mode({ cloudOnly = false, env = process.env } = {}) {
  if (!cloudOnly) return 'full';
  if (env.CLAUDE_CODE_REMOTE !== 'true') return 'off';
  return loadConfig(env).remote ? 'full' : 'unconfigured';
}

/** One JSON-RPC message in, zero or one out. */
export async function handleMessage(msg, deps) {
  const offered = deps.mode || 'full';
  const { id, method, params } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return id === undefined ? null : fail(-32600, 'invalid request');
  const isNotification = id === undefined;
  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          ...(offered === 'off' ? {} : { instructions:
            'Tickets on the session board. Create one for every action item the human must do, and to track the steps of long work (with priorities P0-P3 and blocked_by dependencies). ' +
            'Use ticket_next to pick what to do. Report anything that wastes your time, or an improvement, with board_feedback. Keys look like SB-12.' +
            (offered === 'unconfigured' ? ' ' + CLOUD_SETUP_HINT : ''),
          }),
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: offered === 'off' ? [] : TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (offered === 'off' || !TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool ${name}`);
        if (offered === 'unconfigured') return reply({ content: [{ type: 'text', text: `Error: ${CLOUD_SETUP_HINT}` }], isError: true });
        try {
          const backend = await deps.backend();
          const text = await callTool(name, params?.arguments || {}, { backend, context: deps.context() });
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true });
        }
      }
      default:
        if (isNotification) return null;
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    return isNotification ? null : fail(-32603, String(e?.message || e));
  }
}

async function main() {
  let backend;
  let ctx;
  const deps = {
    mode: mode({ cloudOnly: process.argv.includes('--cloud-only') }),
    backend: async () => (backend ??= await openBackend({ actor: 'agent' })),
    context: () => {
      // Re-read: the hooks may have recorded the session after the server started (in the cloud,
      // where their record wins over the env, until they have).
      if (!ctx || !ctx.session_id || (ctx.origin === 'cloud' && !ctx.fromHooks)) ctx = currentContext();
      return ctx;
    },
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const pending = new Set();
  rl.on('line', (raw) => {
    if (!raw.trim()) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      const p = handleMessage(m, deps).then((out) => out && write(out));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    backend?.close();
    process.exit(0);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
