#!/usr/bin/env node
// session-board hook entry point: `node report.mjs <HookEventName>`, payload on stdin.
// Contract: never block the session, never fail. Always exit 0, swallow every error.
import { existsSync } from 'node:fs';
import { VERSION } from '../lib/core.mjs';
import { handleHook, staleCopyNotice } from '../lib/runtime.mjs';

const MAX_STDIN = 2 * 1024 * 1024;
const HARD_DEADLINE_MS = 4000;

setTimeout(() => process.exit(0), HARD_DEADLINE_MS).unref();

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (data.length < MAX_STDIN) data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 1500).unref();
  });
}

// `--cloud-only`: used by the copy committed into a repo's .claude/settings.json, so a machine that
// also has the plugin installed does not report the same session twice.
if (process.argv.includes('--cloud-only') && process.env.CLAUDE_CODE_REMOTE !== 'true') process.exit(0);

// `SESSION_BOARD=off claude`: keep one session off the board without touching the install.
if (['off', '0', 'false'].includes(String(process.env.SESSION_BOARD || '').toLowerCase())) process.exit(0);

try {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {}
  const event = process.argv[2] || input.hook_event_name;
  const started = Date.now();
  const out = {};
  const status = await handleHook(event, input, { out });
  if (process.env.SESSION_BOARD_DEBUG === '1') process.stderr.write(`session-board: ${event} → ${status}\n`);
  // Storage changes (local board left behind, server switched): at most once per start, never in the
  // cloud copy (which has no local board, and no lib/sync.mjs), never when the server is unreachable.
  // The cloud copy, instead: one line when the server is newer than the copy committed in the repo.
  if (event === 'SessionStart' && process.argv.includes('--cloud-only')) {
    // ENVIRONMENT: written next to the copy by scripts/cloud-apply.mjs (environment setup script, uncommitted)
    const fromEnvironment = existsSync(new URL('../ENVIRONMENT', import.meta.url));
    const text = staleCopyNotice(VERSION, out.serverVersion, process.env, { fromEnvironment });
    if (text) process.stdout.write(JSON.stringify({ systemMessage: text }) + '\n');
  }
  if (event === 'SessionStart' && !process.argv.includes('--cloud-only') && !['send-failed', 'backoff'].includes(status)) {
    try {
      const { sessionStartNotice } = await import('../lib/sync.mjs');
      const text = await sessionStartNotice({ deadlineMs: Math.max(800, 3500 - (Date.now() - started)) });
      if (text) process.stdout.write(JSON.stringify({ systemMessage: text }) + '\n');
    } catch (err) {
      if (process.env.SESSION_BOARD_DEBUG === '1') process.stderr.write(`session-board sync: ${err?.message || err}\n`);
    }
  }
} catch (err) {
  if (process.env.SESSION_BOARD_DEBUG === '1') process.stderr.write(`session-board: ${err?.message || err}\n`);
}
// No process.exit() here: on Windows, exiting while libuv handles (stdin pipe, fetch socket) are
// still closing aborts with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`
// (reported 02/10 on SessionEnd and Stop). Close what we opened and let the loop drain; the unref'd
// HARD_DEADLINE timer above stays as the last resort.
process.exitCode = 0;
process.stdin.destroy();
