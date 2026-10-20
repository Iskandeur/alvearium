#!/usr/bin/env node
// session-board MCP server: lets Claude create, update, list and comment tickets.
// Zero dependencies: JSON-RPC 2.0 over stdio, one JSON message per line (MCP stdio transport).
// Declared inline in .claude-plugin/plugin.json (`mcpServers.tickets`).
//
// Same backend as the CLI: the board server when SESSION_BOARD_URL/TOKEN (or the plugin options)
// are set, else the local SQLite store in ~/.claude/session-board/board.db.
//
// `--cloud-only`: the copy that `/alvearium:install-cloud` vendors into a repository (declared in
// the repo's .mcp.json). Outside a claude.ai/code cloud session it offers no tool at all, so a machine
// that also has the plugin does not see every tool twice; in the cloud it needs the server (a local
// board would die with the VM).
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_TYPES, MAX_BODY_CHARS, MAX_COMMENT_CHARS, PRIORITIES, STATUSES, VERSION, actorDisplayName, groupDigits, markdownToTerminal, normalizeActorId, repoFromRemote, textTooLong, truncate } from '../lib/core.mjs';
import { CLOUD_SETUP_HINT, applyAgentFlag, dataDir, loadConfig, openBackend, sessionForCwd } from '../lib/runtime.mjs';
import { isEntryPoint } from '../lib/core.mjs';

export { VERSION };
const SERVER_INFO = { name: 'alvearium', version: VERSION };
const ASSIGNEE = { type: 'string', description: 'user = the human (default); me = you, the agent calling this tool; claude = Claude; codex = Codex; or any actor id (an agent, e.g. "ci-bot")' };
const PRIORITY = { type: 'string', enum: PRIORITIES, description: 'P0 = drop everything, P1 = next up, P2 = normal, P3 = some day' };
const PROTOCOL = '2025-06-18';
const LIMIT = `at most ${groupDigits(MAX_COMMENT_CHARS)} characters; a longer text is refused, never cut`;

/**
 * MCP tool annotations (hints, spec 2025-06-18): what reads, what writes. Nothing here deletes or
 * reaches outside the board. Clients may use them to decide what to ask before (OpenAI Codex CLI
 * shows them); the tools behave the same either way.
 */
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: 'ticket_create',
    annotations: WRITES,
    description:
      'Create a ticket on the Alvearium board. Use it for an action item the human must do (assignee "user": create a secret, review a PR, decide something), ' +
      'or to split a long task into tracked steps (assignee "me"). The ticket is attached to the current session and repo unless told otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative title, e.g. "Add the STRIPE_KEY secret to the staging env"' },
        body: { type: 'string', description: `Markdown details: why, exact steps, links (${LIMIT})` },
        assignee: ASSIGNEE,
        status: { type: 'string', enum: STATUSES, description: 'Default: todo. Use waiting_on_user when the human must act before Claude can go on.' },
        kind: { type: 'string', description: 'action (default for the human), task, bug, question, note… any short slug' },
        priority: PRIORITY,
        labels: { type: 'array', items: { type: 'string' } },
        parent: { type: 'string', description: 'Key of the parent ticket (e.g. ALV-12) to make this a sub-ticket' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Keys of tickets that must be done first (e.g. ["ALV-3"]). Cycles are refused.' },
        links: { type: 'array', items: { type: 'string' }, description: 'https URLs (PR, docs) or repo-relative file paths' },
        session: { type: 'string', description: '"current" (default), "none" for a ticket outside any session, or a session id' },
      },
      required: ['title'],
    },
  },
  {
    name: 'ticket_update',
    annotations: WRITES,
    description:
      'Change a ticket: status (todo, in_progress, waiting_on_user, review, done, cancelled, failed, on_hold: prefer ticket_hold to say what it waits for), title, body, labels, priority (P0-P3), assignee, ' +
      'dependencies (blocked_by_add / blocked_by_remove: keys of tickets that block this one); optionally add a comment in the same call.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Ticket key, e.g. ALV-12' },
        status: { type: 'string', enum: STATUSES },
        title: { type: 'string' },
        body: { type: 'string', description: `Markdown (${LIMIT})` },
        assignee: ASSIGNEE,
        priority: { type: 'string', enum: [...PRIORITIES, ''], description: 'P0…P3, or "" to clear' },
        labels: { type: 'array', items: { type: 'string' }, description: 'REPLACES the whole list of labels: any label you leave out is removed. To change some, use labels_add / labels_remove.' },
        labels_add: { type: 'array', items: { type: 'string' }, description: 'Labels to add, the others kept' },
        labels_remove: { type: 'array', items: { type: 'string' }, description: 'Labels to remove, the others kept' },
        blocked_by_add:{ type: 'array', items: { type: 'string' }, description: 'Keys of tickets that block this one (must be done first)' },
        blocked_by_remove: { type: 'array', items: { type: 'string' }, description: 'Keys of blockers to remove' },
        comment: { type: 'string', description: `Optional note recorded in the ticket history (${LIMIT})` },
      },
      required: ['key'],
    },
  },
  {
    name: 'ticket_next',
    annotations: READS,
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
    annotations: WRITES,
    description:
      'Report a problem or an improvement to the feedback inbox of the board: a bug, a suggestion, or a friction (a tool, an instruction or the board itself made you lose time). ' +
      'Context (session, repo, agent, plugin version) is attached automatically. Be specific: what you tried, what happened, what would have helped.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line, e.g. "ticket_list ignores the label filter"' },
        detail: { type: 'string', description: `What happened, what you expected, how to reproduce, what it cost. The context lines added below it count too: detail and context together hold ${LIMIT}` },
        type: { type: 'string', enum: FEEDBACK_TYPES, description: 'bug: broken; suggestion: an improvement; friction: works but wastes time. Default: suggestion' },
        about: { type: 'string', description: 'What it is about: a tool name, a command, a doc, "board"…' },
        priority: PRIORITY,
      },
      required: ['title'],
    },
  },
  {
    name: 'ticket_list',
    annotations: READS,
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
    annotations: WRITES,
    description: `Add a comment to a ticket (progress note, answer, what is left). Markdown, ${LIMIT}: split a longer text into several comments.`,
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, text: { type: 'string' }, to: { type: 'string', description: 'Optional: who the comment is for (user, claude, an actor id)' } },
      required: ['key', 'text'],
    },
  },
  {
    name: 'ticket_hold',
    annotations: WRITES,
    description:
      'Put a ticket on hold until something happens, instead of leaving it in To do: it leaves every lane and comes back by itself. ' +
      'condition: {type:"blocked_by", keys?:["ALV-3"]} (all closed) | {type:"pr_merged", pr:"owner/repo#12"} | {type:"time", at:"2026-11-02T09:00:00Z"} | {type:"reply", from:"actor-id"} | ' +
      '{type:"external", what:"the motion sensor sees someone come in", deadline?:"…Z", otherwise?:{…then…}} (a state of the world: a watcher or a script lifts it with fire_proof; past the deadline, otherwise runs with "not met"). ' +
      'then (optional): {type:"wake", actor, text?} (mention an agent and hand it the ticket) | {type:"assign", to, status?, text?} | {type:"comment", text}. ' +
      'Without then, the agent that put it on hold is woken first to check it still makes sense. lift=true lifts the hold by hand. ' +
      'fire_proof="what was seen" says an external hold is met: its next step runs now.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        condition: { type: 'object', description: 'What it waits for: type blocked_by | pr_merged | time | reply | external' },
        then: { type: 'object', description: 'Optional: what happens then: type wake | assign | comment' },
        note: { type: 'string', description: 'Optional: why it waits, one line' },
        lift: { type: 'boolean', description: 'true: lift the hold now, back to who had it' },
        fire_proof: { type: 'string', description: 'For an external hold: what was seen, in words (the proof). Its next step runs now' },
      },
      required: ['key'],
    },
  },
  {
    name: 'ticket_get',
    annotations: READS,
    description: 'Show one ticket with its history and sub-tickets. Long comments are shortened in the history; pass full=true to get the whole body and every comment, complete. When you take up a ticket (a session opened on it, a ticket handed to you), read it with full=true first: the default view hides older comments.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        full: { type: 'boolean', description: 'Default false: the last 15 history entries, comments cut at ~260 characters. true: the whole body and the whole history, every comment in full.' },
      },
      required: ['key'],
    },
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

export function describe(t, { full = false } = {}) {
  const out = [line(t)];
  if (t.parent_key) out.push(`parent: ${t.parent_key} ${t.parent_title || ''}`.trim());
  if (t.blocked_by?.length) out.push(`blocked by: ${t.blocked_by.map((b) => `${b.key} [${b.status}]`).join(', ')}`);
  if (t.blocking?.length) out.push(`blocks: ${t.blocking.map((b) => `${b.key} [${b.status}]`).join(', ')}`);

  if (t.body) out.push('', markdownToTerminal(t.body, { ansi: true, max: full ? MAX_BODY_CHARS : 1800 }));

  for (const l of t.links || []) out.push(`link: ${l.url}`);
  if (t.children?.length) out.push('', 'sub-tickets:', ...t.children.map((c) => '  ' + line(c)));
  if (t.events?.length) {
    out.push('', 'history:');
    for (const e of full ? t.events : t.events.slice(-15)) {
      const actor = aName(e.actor, (t.actors || {})[e.actor]?.name);
      const target = e.target ? aName(e.target, (t.actors || {})[e.target]?.name) : '';
      const ts = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
      const body = e.text ? markdownToTerminal(e.text, { ansi: true, max: full ? MAX_COMMENT_CHARS : 260 }) : '';
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

/**
 * Who a `board_feedback` ticket goes to: SESSION_BOARD_FEEDBACK_ASSIGNEE, else `user`, the owner of the
 * board (the inbox is kept out of the lanes, so this files nothing in anyone's "Waiting on you").
 * A value that is not an actor id fails loudly rather than sending feedback somewhere else.
 */
export function feedbackAssignee(env = process.env) {
  const raw = String(env.SESSION_BOARD_FEEDBACK_ASSIGNEE ?? '').trim();
  if (!raw) return 'user';
  const id = normalizeActorId(raw);
  if (!id) throw new Error(`SESSION_BOARD_FEEDBACK_ASSIGNEE=${JSON.stringify(raw.slice(0, 80))} is not an actor id (user, claude, or letters, digits, . _ - : @ /). Nothing was saved.`);
  return id;
}

/**
 * A server without the `complete` flag on its actors listing (before 0.5.10) caps it somewhere we do
 * not know: a listing is taken as complete only well below any plausible cap.
 */
const ACTORS_SURELY_COMPLETE = 100;
/**
 * A feedback assignee set by SESSION_BOARD_FEEDBACK_ASSIGNEE must be an actor the board knows, or the
 * feedback would go to nobody. Checked when it is cheap and certain: exactly in local mode; from the
 * actors listing of a server when it says it is complete (or, from an older server, when it is short).
 * If the board cannot say, the feedback goes through.
 */
async function assertFeedbackAssignee(backend, id) {
  if (id === 'user' || id === 'claude') return;
  let known;
  try {
    if (typeof backend.actorKnown === 'function') known = await backend.actorKnown(id);
    else if (typeof backend.actors === 'function') {
      const r = await backend.actors();
      const list = r?.actors;
      if (Array.isArray(list)) {
        const found = list.some((a) => a?.id === id);
        const complete = typeof r.complete === 'boolean' ? r.complete : list.length < ACTORS_SURELY_COMPLETE;
        if (found || complete) known = found;
      }
    }
  } catch {
    return; // the board could not tell: do not lose the feedback over a check
  }
  if (known === false) {
    throw new Error(`SESSION_BOARD_FEEDBACK_ASSIGNEE=${JSON.stringify(id)} is not an actor of this board (it has never acted on it). Nothing was saved: fix the variable, or unset it to send feedback to the board owner.`);
  }
}

/** The same limits as the board, checked before sending: a clear refusal, with the tool's name, and no round trip. */
function mustFit(tool, text, max, what, { trim = false } = {}) {
  if (typeof text !== 'string') return;
  const tooLong = textTooLong(trim ? text.trim() : text, max, what);
  if (tooLong) throw new Error(`${tool}: ${tooLong}`);
}

/** Which board a backend reads, for messages: the server URL, or "the local board" (this machine's own store). */
const boardWhere = (backend) => (backend?.source && backend.source !== 'local' ? `the board at ${backend.source}` : 'the local board (no server configured in this process)');

/** `me` = the agent calling the tool (SESSION_BOARD_ACTOR, `codex` under Codex, else `claude`). */
const who = (value, context) => (value === 'me' ? context.actor || 'claude' : value);

export async function callTool(name, args = {}, { backend, context, env = process.env }) {
  if (args && typeof args === 'object' && args.assignee === 'me') args = { ...args, assignee: who('me', context) };
  switch (name) {
    case 'ticket_create': {
      mustFit('ticket_create', args.body, MAX_BODY_CHARS, 'body');
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
      mustFit('ticket_update', args.body, MAX_BODY_CHARS, 'body');
      mustFit('ticket_update', args.comment, MAX_COMMENT_CHARS, 'comment', { trim: true });
      const { key, ...rest } = args;
      // `labels` replaces the list: say which labels it dropped (two sessions once erased each other's labels).
      let before = null;
      if (Array.isArray(rest.labels)) {
        try {
          before = (await backend.get(String(key)))?.labels;
        } catch {} // the warning is a courtesy: never lose the update over it
      }
      const t = must(await backend.update(String(key), rest), 'ticket_update');
      const dropped = Array.isArray(before) ? before.filter((l) => !(t.labels || []).includes(l)) : [];
      const warn = dropped.length ? `\nWarning: labels replaced the whole list; removed ${dropped.map((l) => '#' + l).join(' ')}. Use labels_add / labels_remove to change some without replacing the rest.` : '';
      return `Updated ${line(t)}${warn}`;
    }
    case 'ticket_comment': {
      // `body` is how ticket_create names its text; accept it here too instead of an "empty comment" error.
      const text = String(args.text ?? args.body ?? '');
      // `@/path` reads a file in some CLIs; here it would be posted as it is. Refuse a text that is only such a path.
      if (/^@(?:\/|~\/|\.{1,2}\/)\S*$/.test(text.trim())) {
        throw new Error(`ticket_comment: the text is only a file path (${text.trim()}) and this tool does not read files, so it would be posted as is. Put the text itself in "text".`);
      }
      mustFit('ticket_comment', text, MAX_COMMENT_CHARS, 'comment', { trim: true });
      const t = must(await backend.comment(String(args.key), text, args.to ? String(args.to) : undefined), 'ticket_comment');
      return `Commented on ${t.key} (${t.comments_count} comment${t.comments_count === 1 ? '' : 's'})`;
    }
    case 'ticket_hold': {
      if (typeof args.fire_proof === 'string' && args.fire_proof.trim()) {
        const f = must(await backend.fireHold(String(args.key), args.fire_proof), 'ticket_hold');
        return `${f.key} is back: ${f.status}, ${f.assignee}`;
      }
      const body = args.lift === true ? null : { condition: args.condition, then: args.then, note: args.note };
      const t = must(await backend.hold(String(args.key), body), 'ticket_hold');
      return t.hold ? `${t.key} on hold until ${t.hold.waits_for}, then ${t.hold.next_text}` : `${t.key} is back: ${t.status}, ${t.assignee}`;
    }
    case 'ticket_get':
      try {
        return describe(await backend.get(String(args.key)), { full: args.full === true });
      } catch (e) {
        // A 404 is ambiguous: the key may not exist, or this process may be reading another board than
        // the one the key lives on (no SESSION_BOARD_URL / token here: an empty local board).
        if (e?.status === 404) {
          throw Object.assign(new Error(`${e.message}: ${args.key} is not on ${boardWhere(backend)}. If it exists on your server, this process is not reading that board.`), { status: 404 });
        }
        throw e;
      }
    case 'ticket_next': {
      const scope = args.scope || 'repo';
      const params = { limit: Math.min(Number(args.limit) || 10, 50) };
      if (args.assignee) params.assignee = String(args.assignee);
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
      mustFit('board_feedback', body, MAX_BODY_CHARS, 'feedback detail (with its context lines)');
      const assignee = feedbackAssignee(env);
      await assertFeedbackAssignee(backend, assignee);
      const t = await backend.create({
        title: String(args.title || '').trim(),
        body,
        kind: 'feedback',
        subtype: type,
        assignee,
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
      if (!r.tickets.length) return `No ${status === 'any' ? '' : status + ' '}tickets (${scope}) on ${boardWhere(backend)}.`;
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
            'Tickets on the Alvearium board. Create one for every action item the human must do, and to track the steps of long work (with priorities P0-P3 and blocked_by dependencies). ' +
            'Use ticket_next to pick what to do. Report anything that wastes your time, or an improvement, with board_feedback. Keys look like ALV-12 (an older board may use SB-12; both forms resolve).' +
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
  // `--codex`: started by OpenAI Codex CLI (scripts/codex-setup.mjs): tickets are written as `codex`.
  applyAgentFlag(process.argv, process.env);
  const codex = process.argv.includes('--codex');
  let backend;
  let ctx;
  const deps = {
    mode: mode({ cloudOnly: process.argv.includes('--cloud-only') }),
    backend: async () => (backend ??= await openBackend({ actor: 'agent' })),
    context: () => {
      // Re-read: the hooks may have recorded the session after the server started (in the cloud,
      // where their record wins over the env, until they have).
      // Under Codex, every call: one Codex process can start several sessions (/new), and the hooks
      // record the current one for this directory.
      if (codex || !ctx || !ctx.session_id || (ctx.origin === 'cloud' && !ctx.fromHooks)) ctx = currentContext();
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

if (isEntryPoint(import.meta.url)) main();
