---
description: Copy session-board into this repository so claude.ai/code cloud sessions get the board - hooks, ticket tools, skill, /board and /ticket
argument-hint: "[--uninstall] [--no-local]"
---
Cloud sessions on claude.ai/code never install plugins, but they load what a repository commits:
the hooks of `.claude/settings.json`, the MCP servers of `.mcp.json`, `.claude/skills/` and
`.claude/commands/`. This command copies session-board there (`.claude/session-board/`, with its
version in `VERSION`). Everything it adds is silent outside a cloud session, and on this machine
the untracked `.claude/settings.local.json` turns the copy off: the plugin keeps doing the work.
Running it again updates the copy.

1. Run exactly this command from the project root:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-repo.mjs" "$(pwd)" $ARGUMENTS`
2. Show the user `git status --short .claude .mcp.json` and what the script printed.
3. Remind the user, in three short lines: commit and push `.claude/` and `.mcp.json` (never
   `.claude/settings.local.json`); in the cloud environment, set `SESSION_BOARD_URL` plus either an
   API credential for that host with `SESSION_BOARD_TOKEN=proxy`, or `SESSION_BOARD_TOKEN` itself;
   check in a new cloud session that a ticket created there shows up on the board. Point to the
   README section "Cloud sessions (claude.ai/code)" in `${CLAUDE_PLUGIN_ROOT}/README.md`. Do not
   commit anything yourself.
