#!/usr/bin/env node
// session-board doctor: one command that says whether this session can write to the board, and if
// not, what to fix. Uses the plugin's own HTTP client (lib/runtime.mjs), not curl: curl honours the
// proxy variables, Node's fetch does not, and that difference is what hid the 0.3.3 cloud failure.
//
//   node .claude/session-board/scripts/doctor.mjs              cloud copy (in a claude.ai/code session)
//   /board doctor (cloud copy), /alvearium:board doctor        the same through the /board command
//   … --ticket "test cloud"                                    also create a ticket (origin, repo, session
//                                                              as the MCP tool would) and print its key
//   … --json                                                   the report as JSON
// Never prints a token. Exit code 0 when the board answers as the board, 1 otherwise.
import { fileURLToPath } from 'node:url';
import { doctorMain } from '../lib/runtime.mjs';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await doctorMain(process.argv.slice(2).filter((a) => a !== '--cloud-only' && a !== 'doctor'));
