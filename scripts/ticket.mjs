#!/usr/bin/env node
// Tickets from the terminal (the /ticket command). The human is the actor.
//   ticket new <title> [--body text] [--label a,b] [--priority P1] [--assignee claude] [--parent SB-3] [--no-session]
//   ticket done <KEY> [comment…]          ticket status <KEY> <status>
//   ticket list [--repo|--all] [--closed] [words…]   (default: open tickets of this repo)
//   ticket show <KEY>                     ticket comment <KEY> <text…>
//   ticket next [--all]                   ticket priority <KEY> <P0…P3>
//   ticket block <KEY> --by <KEY,…>       ticket unblock <KEY> --by <KEY,…>
import { STATUSES } from '../lib/core.mjs';
import { openBackend } from '../lib/runtime.mjs';
import { callTool, currentContext } from '../mcp/server.mjs';

const USAGE =
  'usage: /ticket new <title> [--priority P1] [--blocked-by SB-3] | next [--all] | done <KEY> | status <KEY> <status> | priority <KEY> <P0-P3> | ' +
  'block <KEY> --by <KEY> | unblock <KEY> --by <KEY> | list [--all] [words] | show <KEY> | comment <KEY> <text>';

/** Split "$ARGUMENTS" (one string from the slash command) or argv into words, honouring quotes. */
export function splitArgs(argv) {
  const joined = argv.length === 1 ? argv[0] : null;
  if (joined === null) return argv;
  return [...joined.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

export function parse(words) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('--')) {
      const name = w.slice(2);
      const boolean = ['all', 'repo', 'closed', 'no-session', 'json'].includes(name);
      flags[name] = boolean ? true : words[++i];
    } else rest.push(w);
  }
  return { cmd: rest[0], rest: rest.slice(1), flags };
}

export async function run(words, { backend, context }) {
  const { cmd, rest, flags } = parse(words);
  const actorTool = (name, args) => callTool(name, args, { backend, context });
  switch (cmd) {
    case 'new':
    case 'add': {
      const title = rest.join(' ').trim();
      if (!title) return USAGE;
      return actorTool('ticket_create', {
        title,
        body: flags.body,
        labels: flags.label ? String(flags.label).split(',') : undefined,
        priority: flags.priority,
        assignee: flags.assignee || 'user',
        parent: flags.parent,
        blocked_by: flags['blocked-by'] ? String(flags['blocked-by']).split(',') : undefined,
        kind: flags.kind,
        session: flags['no-session'] ? 'none' : 'current',
      });
    }
    case 'done':
    case 'close':
    case 'cancel': {
      if (!rest[0]) return USAGE;
      const comment = rest.slice(1).join(' ') || undefined;
      return actorTool('ticket_update', { key: rest[0], status: cmd === 'cancel' ? 'cancelled' : 'done', comment });
    }
    case 'status': {
      if (!rest[0] || !STATUSES.includes(rest[1])) return `usage: /ticket status <KEY> <${STATUSES.join('|')}>`;
      return actorTool('ticket_update', { key: rest[0], status: rest[1] });
    }
    case 'next':
      return actorTool('ticket_next', { scope: flags.all ? 'all' : flags.session ? 'session' : 'repo', label: flags.label, limit: 15 });
    case 'block':
    case 'unblock': {
      // ticket block SB-5 --by SB-3,SB-4   (SB-5 waits for SB-3 and SB-4)
      const by = flags.by ? String(flags.by).split(',') : rest.slice(1);
      if (!rest[0] || !by.length) return 'usage: /ticket block <KEY> --by <KEY>[,<KEY>]   (or unblock)';
      return actorTool('ticket_update', { key: rest[0], [cmd === 'block' ? 'blocked_by_add' : 'blocked_by_remove']: by });
    }
    case 'priority':
      if (!rest[0] || !rest[1]) return 'usage: /ticket priority <KEY> <P0|P1|P2|P3|none>';
      return actorTool('ticket_update', { key: rest[0], priority: rest[1] === 'none' ? '' : rest[1] });
    case 'show':
      return rest[0] ? actorTool('ticket_get', { key: rest[0] }) : USAGE;
    case 'comment':
      return rest[0] && rest[1] ? actorTool('ticket_comment', { key: rest[0], text: rest.slice(1).join(' ') }) : USAGE;
    case 'list':
    case 'ls':
    case undefined: {
      const scope = flags.all ? 'all' : flags.session ? 'session' : context.repo ? 'repo' : 'all';
      return actorTool('ticket_list', { scope, status: flags.closed ? 'closed' : 'open', q: rest.join(' ') || undefined, limit: 60 });
    }
    default:
      return USAGE;
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  let backend;
  try {
    backend = await openBackend({ actor: 'user' });
    console.log(await run(splitArgs(process.argv.slice(2)), { backend, context: currentContext() }));
  } catch (err) {
    console.log(`session-board: ${err?.message || err}`);
  } finally {
    backend?.close();
  }
}
