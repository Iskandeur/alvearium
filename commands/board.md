---
description: Show every Claude Code session - waiting on you, in progress, ready for review
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs"`

Show the board above to the user exactly as printed, inside a code block. Do not add commentary,
do not summarize it, and do not take any action on the sessions it lists.
