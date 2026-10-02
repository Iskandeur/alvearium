#!/usr/bin/env node
// Print the board as text (used by the /board command). Flags: --json
import { renderText, statusText } from '../lib/core.mjs';
import { loadBoard } from '../lib/runtime.mjs';

try {
  const { source, board } = await loadBoard();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(board, null, 2));
  } else {
    const summary = statusText(board.counts) || 'no open sessions';
    console.log(`Session board — ${summary} — source: ${source === 'local' ? 'this machine (local mode)' : 'server'}\n`);
    console.log(renderText(board));
  }
} catch (err) {
  console.log(`session-board: could not load the board (${err?.message || err}).`);
}
