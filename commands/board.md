---
description: Show the ticket board of every Claude Code session - waiting on you, in progress, to do
argument-hint: "[--here] [--repo <name>] [--q <text>] | sync | doctor [--ticket <title>]"
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" $ARGUMENTS`

Show the output above to the user exactly as printed, inside a code block. Do not add commentary,
do not summarize it, and do not take any action on the tickets it lists.
