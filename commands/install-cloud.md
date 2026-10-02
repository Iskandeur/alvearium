---
description: Add session-board's reporting hooks to this repository so claude.ai/code cloud sessions show up on your board
allowed-tools: Bash(node:*), Bash(git status:*), Bash(git diff:*)
argument-hint: "[--uninstall]"
---
Cloud sessions on claude.ai/code do not install plugins, but they do run the hooks committed in a
repository's `.claude/settings.json`. This command copies session-board's hook script into the
current project and registers it there, in `--cloud-only` mode (it stays silent on machines that
already have the plugin, so nothing is reported twice).

1. Run exactly this command from the project root:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-repo.mjs" "$(pwd)" $ARGUMENTS`
2. Show the user `git status --short .claude` and what the script printed.
3. Remind the user, in two short lines, that they must commit and push these files, and that the
   cloud environment needs `SESSION_BOARD_URL` plus either an API credential for that host
   (with `SESSION_BOARD_TOKEN=proxy`) or `SESSION_BOARD_TOKEN` itself. Point to the README section
   "Cloud sessions" in `${CLAUDE_PLUGIN_ROOT}/README.md` for details. Do not commit anything yourself.
