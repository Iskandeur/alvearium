---
name: tickets
description: Track action items and work steps as tickets on the session board (session-board MCP tools ticket_create, ticket_update, ticket_list, ticket_comment, ticket_get). Use when the user must do something outside this conversation, when a task is long enough to split into steps, or when asked what is left.
---

# Tickets on the session board

The user watches one board for all their Claude Code sessions. A ticket is how something reaches
them when the conversation is not on screen. Keys look like `SB-12`.

## When to create a ticket

- **An action item for the user** (`assignee: "user"`, `kind: "action"`): something only they can
  do, and that would otherwise be lost at the end of a long reply. Examples: "Add the `STRIPE_KEY`
  secret to the staging environment", "Review and merge PR #412", "Decide between option A and B",
  "Rotate the leaked token". Put the exact steps and links in `body`. If you cannot continue until
  it is done, use `status: "waiting_on_user"`; otherwise leave the default `todo`.
- **Splitting long work** (`assignee: "claude"`, `kind: "task"`): when a task has several
  independent steps that will outlive one turn, create a parent ticket and sub-tickets
  (`parent: "SB-12"`). Move each to `in_progress` when you start it and `done` when it is finished.
- **Something you noticed but will not do now** (bug, follow-up): a `todo` ticket with a label.

Do not create tickets for every small step of a short task, for things you finish in the same turn,
or to restate what the conversation already shows. Permission prompts, questions and "ready for
review" are already ticketed automatically by the plugin's hooks: never duplicate them.

## Tickets the user wrote: take them and make them precise

The user often jots a ticket down fast (`source: "user"`): a few words, typos, no detail. That is
on purpose: they write it rough so you can finish it. When you pick one up, **own it without
asking**:

- Rewrite the title into a clear imperative and fill `body` with what you understood, the plan, the
  files involved and the acceptance criteria (`ticket_update`). Keep their original wording in a
  `comment` (`"Original: …"`) so nothing they wrote is lost.
- Add labels, a priority, links, and split it into sub-tickets if it holds several steps.
- Move it to `in_progress` when you start, `done` with a one-line comment when finished.
- Only if their intent is truly ambiguous, write your best interpretation in the ticket anyway and
  ask one short question in the conversation. Never leave a rough ticket untouched for fear of
  overwriting it: enriching it is the expected behaviour.

When the user asks you to look at the board, or at the start of work in a repo, check
`ticket_list` for open `todo` tickets of this session or repo that nobody has started.

## Keeping the board true

- When you finish something a ticket tracks, close it (`ticket_update` with `status: "done"`, and a
  one-line `comment` saying what was done). Cancelled work: `status: "cancelled"` with the reason.
- Before ending a long piece of work, or when the user asks "what's left?", call `ticket_list`
  (default scope: this session; `scope: "repo"` for the whole repository) and report what is open.
- Write titles as short imperatives the user can act on without context. Labels are lowercase words
  (`deploy`, `security`, `docs`).
