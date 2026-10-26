# AGENTS.md

Instructions for coding agents (OpenAI Codex CLI, Claude Code, others) that use Alvearium's ticket
tools or work on this repository. `CLAUDE.md` imports this file, so Claude Code and Codex read the
same rules.

Alvearium is one live ticket board for every coding-agent session: what waits on the human, what is
in progress, what to do next. It has three parts: hooks (`hooks/report.mjs`) that turn each session
into a ticket, an MCP server (`mcp/server.mjs`, stdio) with the ticket tools, and an optional
self-hosted server (`server/server.mjs`) with the web page.

## Using the ticket tools

The human watches the board, not your terminal. A ticket is how something reaches them once the
conversation is off screen. The MCP server is named `alvearium` (in Codex the tools show up as
`mcp__alvearium__ticket_create` and so on). Keys look like `ALV-12`; `SB-12` from an older board
resolves to the same ticket.

| Tool | Use it to |
| :- | :- |
| `ticket_create` | file an action item for the human (`assignee: "user"`, the default), or a step of your own work (`assignee: "me"`) |
| `ticket_update` | change status, title, body, priority, labels, assignee, dependencies; add a comment in the same call |
| `ticket_next` | pick what to do: open, unblocked tickets of this repo by priority (`assignee: "me"` for yours) |
| `ticket_list` | list tickets: this session (default), `scope: "repo"` or `scope: "all"` |
| `ticket_comment` | a progress note or an answer (`to` names who it is for) |
| `ticket_message` | record that you messaged someone about the ticket outside the board (`channel`: slack, email, sms…; `peer`: who; optional short `excerpt`): it shows in the history, it sends nothing |
| `ticket_get` | one ticket with its history (`full: true` for every comment in full) |
| `ticket_attachment` | look at a picture attached to a comment (`ticket_get` lists them with their id): check them before you ask the human for a screenshot |
| `ticket_hold` | park a ticket until something happens (other tickets closed, a PR merged, a date, a reply) |
| `board_feedback` | report a bug, a friction or an improvement of the tools or the board itself |

`"me"` is you: `codex` under Codex, `claude` under Claude Code, or the id in `SESSION_BOARD_ACTOR`.

**Create a ticket when**

- the human must do something only they can do: add a secret, review a PR, decide between two
  options. Put the exact steps and links in `body`. If you cannot go on until it is done, use
  `status: "waiting_on_user"`;
- a task has several steps that will outlive one turn: one parent ticket, sub-tickets with
  `parent: "ALV-12"`, each with a `priority` (`P0` drop everything, `P1` next, `P2` normal, `P3`
  some day) and `blocked_by` for what must be done first;
- you notice something you will not do now (a bug, a follow-up): a `todo` ticket with a label.

**Do not** create tickets for steps you finish in the same turn, or to restate what the
conversation already shows. The session itself, its "ready for review" state and permission prompts
are ticketed by the hooks: never duplicate them.

**Keep the board true**

- Before starting work in a repo and after finishing a ticket, call `ticket_next`. Move what you
  take to `in_progress` and say which one you took.
- A rough ticket the human jotted down is yours to make precise: rewrite the title as an
  imperative, fill the body (plan, files, acceptance criteria), keep their wording in a comment.
- When you finish, `ticket_update` with `status: "done"` and a one-line comment. Abandoned:
  `cancelled` with the reason.
- Before ending a long piece of work, or when asked what is left, `ticket_list` and report what is
  still open.
- When a tool, an instruction or the board made you lose time, say so at once with
  `board_feedback` (`type`: `bug`, `friction` or `suggestion`), with what you tried and what it cost.

Titles are short imperatives the human can act on without context. Labels are lowercase words.

## Working on this repository

- Node.js 22.13 or later, **zero dependencies**, no build step: ES modules (`.mjs`) and the
  built-in `node:sqlite`, `node:test`. Do not add a package.
- Tests: `npm test` (all of `test/*.test.mjs`). Every change keeps them green and comes with tests
  for what it adds. A test that needs a temporary directory uses `mkdtempSync` under `os.tmpdir()`
  (cleaned up by `test/tmp-cleanup.mjs`).
- The hook script never blocks or fails a session: it always exits 0, swallows every error, and
  network calls time out. Keep it that way for Claude Code and for Codex.
- The board server and the hook payload (`POST /api/event`) are shared by every client already
  installed: a change there must keep existing clients working as they do today.
- The same `hooks/report.mjs` and `mcp/server.mjs` serve both agents. Codex-only behaviour sits
  behind the `--codex` flag that `scripts/codex-setup.mjs` writes; without it nothing changes.
- A release bumps the version in `package.json`, `.claude-plugin/plugin.json` and `VERSION` in
  `lib/core.mjs` (Claude Code caches a plugin by its version), adds the release notes at the top of
  `server/changelog.json` (3 to 5 short items written for users), and documents new behaviour in
  `README.md`. Commit subjects start with the version when they ship one: `0.7.0: …`.
- Everything in this repository is public and in English.
