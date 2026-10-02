---
description: Tickets on the session board - new, done, status, list, show, comment
allowed-tools: Bash(node:*)
argument-hint: "new <title> | done <KEY> | status <KEY> <status> | list [--all] [words] | show <KEY> | comment <KEY> <text>"
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/ticket.mjs" "$ARGUMENTS"`

Show the output above to the user exactly as printed, inside a code block. Do not add commentary
and do not act on the tickets it lists.
