#!/usr/bin/env node
// Print the ticket board as text (used by the /board command).
// Flags: --json, --repo <owner/name|name>, --session <id>, --here (this repo only), --q <text>
import { renderTicketsText, ticketStatusText } from '../lib/core.mjs';
import { loadBoard } from '../lib/runtime.mjs';
import { currentContext } from '../mcp/server.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

try {
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
