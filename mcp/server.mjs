#!/usr/bin/env node
// session-board MCP server: lets Claude create, update, list and comment tickets.
// Zero dependencies: JSON-RPC 2.0 over stdio, one JSON message per line (MCP stdio transport).
// Declared inline in .claude-plugin/plugin.json (`mcpServers.tickets`).
//
// Same backend as the CLI: the board server when SESSION_BOARD_URL/TOKEN (or the plugin options)
// are set, else the local SQLite store in ~/.claude/session-board/board.db.
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ASSIGNEES, PRIORITIES, STATUSES, repoFromRemote, truncate } from '../lib/core.mjs';
import { dataDir, openBackend, sessionForCwd } from '../lib/runtime.mjs';

const SERVER_INFO = { name: 'session-board', version: '0.2.3' };
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
        assignee: { type: 'string', enum: ASSIGNEES, description: 'user = waits on the human (default); claude = work Claude tracks for itself' },
        status: { type: 'string', enum: STATUSES, description: 'Default: todo. Use waiting_on_user when the human must act before Claude can go on.' },
        kind: { type: 'string', description: 'action (default for the human), task, bug, question, note… any short slug' },
        priority: { type: 'string', enum: PRIORITIES },
        labels: { type: 'array', items: { type: 'string' } },
        parent: { type: 'string', description: 'Key of the parent ticket (e.g. SB-12) to make this a sub-ticket' },
        links: { type: 'array', items: { type: 'string' }, description: 'https URLs (PR, docs) or repo-relative file paths' },
        session: { type: 'string', description: '"current" (default), "none" for a ticket outside any session, or a session id' },
      },
      required: ['title'],
    },
  },
  {
    name: 'ticket_update',
    description: 'Change a ticket: status (todo, in_progress, waiting_on_user, review, done, cancelled, failed), title, body, labels, priority, assignee; optionally add a comment in the same call.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Ticket key, e.g. SB-12' },
        status: { type: 'string', enum: STATUSES },
        title: { type: 'string' },
        body: { type: 'string' },
        assignee: { type: 'string', enum: ASSIGNEES },
        priority: { type: 'string', enum: [...PRIORITIES, ''] },
        labels: { type: 'array', items: { type: 'string' } },
        comment: { type: 'string', description: 'Optional note recorded in the ticket history' },
      },
      required: ['key'],
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
        assignee: { type: 'string', enum: ASSIGNEES },
        kind: { type: 'string' },
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
      properties: { key: { type: 'string' }, text: { type: 'string' } },
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
export function currentContext(env = process.env, cwd = process.cwd()) {
  const remembered = sessionForCwd(dataDir(env), cwd);
  const sessionId = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || remembered?.sessionId || null;
  const cloud = env.CLAUDE_CODE_REMOTE === 'true';
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    session_id: sessionId && /^[\w.:-]{1,128}$/.test(sessionId) ? sessionId : null,
    repo: repoFromRemote(git(cwd, ['remote', 'get-url', 'origin'])) || remembered?.repo || null,
    branch: branch || remembered?.branch || null,
    cwd,
    machine: cloud ? 'claude.ai/code' : hostname(),
    origin: cloud ? 'cloud' : 'terminal',
  };
}

const line = (t) =>
  `${t.key} [${t.status}${t.assignee === 'user' ? ', on user' : ''}] ${t.title}` +
  (t.repo ? ` · ${t.repo}${t.branch && t.branch !== 'HEAD' ? '@' + t.branch : ''}` : '') +
  (t.labels?.length ? ` · ${t.labels.map((l) => '#' + l).join(' ')}` : '');

function describe(t) {
  const out = [line(t)];
  if (t.parent_key) out.push(`parent: ${t.parent_key} ${t.parent_title || ''}`.trim());
  if (t.body) out.push('', truncate(t.body, 1500));
  for (const l of t.links || []) out.push(`link: ${l.url}`);
  if (t.children?.length) out.push('', 'sub-tickets:', ...t.children.map((c) => '  ' + line(c)));
  if (t.events?.length) {
    out.push('', 'history:');
    for (const e of t.events.slice(-15)) {
      const what = e.type === 'comment' ? `comment: ${truncate(e.text, 200)}` : e.from_status || e.to_status ? `${e.type} ${e.from_status ?? ''}→${e.to_status ?? ''}${e.text ? ' (' + truncate(e.text, 120) + ')' : ''}` : `${e.type}${e.text ? ' ' + truncate(e.text, 120) : ''}`;
      out.push(`  ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} ${e.actor}: ${what}`);
    }
  }
  return out.join('\n');
}

export async function callTool(name, args = {}, { backend, context }) {
  switch (name) {
    case 'ticket_create': {
      const body = { ...args };
      const where = body.session ?? 'current';
      delete body.session;
      if (where === 'current') Object.assign(body, Object.fromEntries(Object.entries(context).filter(([, v]) => v != null)));
      else if (where !== 'none') Object.assign(body, { session_id: where, cwd: context.cwd, machine: context.machine, origin: context.origin });
      else Object.assign(body, { repo: context.repo, branch: context.branch, cwd: context.cwd, machine: context.machine, origin: context.origin });
      if (!body.assignee) body.assignee = 'user';
      if (!body.kind) body.kind = body.assignee === 'user' ? 'action' : 'task';
      const t = await backend.create(body);
      return `Created ${line(t)}`;
    }
    case 'ticket_update': {
      const { key, ...rest } = args;
      const t = await backend.update(String(key), rest);
      return `Updated ${line(t)}`;
    }
    case 'ticket_comment': {
      const t = await backend.comment(String(args.key), String(args.text ?? ''));
      return `Commented on ${t.key} (${t.comments_count} comment${t.comments_count === 1 ? '' : 's'})`;
    }
    case 'ticket_get':
      return describe(await backend.get(String(args.key)));
    case 'ticket_list': {
      const scope = args.scope || 'session';
      const params = { limit: Math.min(Number(args.limit) || 50, 200) };
      const status = args.status || 'open';
      if (status !== 'any') params.status = status;
      for (const k of ['assignee', 'kind', 'label', 'q']) if (args[k]) params[k] = args[k];
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

/** One JSON-RPC message in, zero or one out. */
export async function handleMessage(msg, deps) {
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
          instructions:
            'Tickets on the session board. Create one for every action item the human must do, and to track the steps of long work. Keys look like SB-12.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool ${name}`);
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
    backend: async () => (backend ??= await openBackend({ actor: 'claude' })),
    context: () => {
      // Re-read: the hooks may have recorded the session after the server started.
      if (!ctx || !ctx.session_id) ctx = currentContext();
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
