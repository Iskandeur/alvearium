#!/usr/bin/env node
// Print the ticket board as text (used by the /board command).
// Flags: --json, --repo <owner/name|name>, --session <id>, --here (this repo only), --q <text>
// `board.mjs sync`: send this machine's local board.db to the server (see lib/sync.mjs).
import { renderTicketsText, ticketStatusText } from '../lib/core.mjs';
import { loadBoard } from '../lib/runtime.mjs';
import { currentContext } from '../mcp/server.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv[0] === 'sync') {
  // Send this machine's local board.db to the server now (the SessionStart hook does it too).
  const { describeSync, syncLocalToServer } = await import('../lib/sync.mjs');
  const r = await syncLocalToServer({ deadlineMs: 120_000, requestTimeoutMs: 20_000 });
  if (r.status === 'local-mode') console.log('session-board: local mode (no server URL and token set), nothing to send.');
  else if (r.status === 'none') console.log(`session-board: no local board on this machine, nothing to send to ${r.server}.`);
  else
    console.log(
      describeSync(r) ||
        `session-board: the ${r.total} local ticket${r.total === 1 ? ' was' : 's were'} already on ${r.server}` +
          (r.file ? `; the local file is now ${r.file}.` : r.renameError ? `; could not rename board.db (${r.renameError}), close the other Claude Code sessions and retry.` : '.'),
    );
  process.exitCode = 0;
} else try {
  const params = {};
  for (const k of ['repo', 'session', 'q', 'label', 'machine']) if (opt('--' + k)) params[k] = opt('--' + k);
  if (argv.includes('--here')) {
    const ctx = currentContext();
    if (ctx.repo) params.repo = ctx.repo;
  }
  const { source, board } = await loadBoard({ params });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(board, null, 2));
  } else {
    const summary = ticketStatusText(board.counts) || 'nothing open';
    const scope = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`Session board — ${summary}${scope ? ` — ${scope}` : ''} — source: ${source === 'local' ? 'this machine (local mode)' : 'server'}\n`);
    console.log(renderTicketsText(board));
  }
} catch (err) {
  console.log(`session-board: could not load the board (${err?.message || err}).`);
}
