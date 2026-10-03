---
description: Tickets on the session board - new, next, done, status, priority, block, list, show, comment
allowed-tools: Bash(node:*)
argument-hint: "new <title> [--priority P1] [--blocked-by SB-3] | next | done <KEY> | status <KEY> <status> | priority <KEY> <P0-P3> | block <KEY> --by <KEY> | list [--all] [words] | show <KEY> | comment <KEY> <text>"
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ticket.mjs" "$ARGUMENTS"`

Show the output above to the user exactly as printed, inside a code block. Do not add commentary
and do not act on the tickets it lists.
