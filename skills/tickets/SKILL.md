---
name: tickets
description: Track action items and work steps as tickets on the Alvearium board (Alvearium MCP tools ticket_create, ticket_update, ticket_next, ticket_list, ticket_comment, ticket_get, board_feedback). Use when the user must do something outside this conversation, when a task is long enough to split into steps (with priorities and dependencies), to pick what to do next, when asked what is left, and to report anything that wastes your time.
---

# Tickets on the Alvearium board

The user watches one board for all their Claude Code sessions and agents, live. A ticket is how
something reaches them when the conversation is not on screen. Keys look like `ALV-12` (a board made before 0.5.3 may use `SB-12`; both forms resolve).

## When to create a ticket

- **An action item for the user** (`assignee: "user"`, `kind: "action"`): something only they can
  do, and that would otherwise be lost at the end of a long reply. Examples: "Add the `STRIPE_KEY`
  secret to the staging environment", "Review and merge PR #412", "Decide between option A and B",
  "Rotate the leaked token". Put the exact steps and links in `body`. If you cannot continue until
  it is done, use `status: "waiting_on_user"`; otherwise leave the default `todo`.
- **Splitting long work** (`assignee: "claude"`, `kind: "task"`): when a task has several steps that
  will outlive one turn, create a parent ticket and sub-tickets (`parent: "ALV-12"`). Move each to
  `in_progress` when you start it and `done` when it is finished.
- **Something you noticed but will not do now** (bug, follow-up): a `todo` ticket with a label.

Do not create tickets for every small step of a short task, for things you finish in the same turn,
or to restate what the conversation already shows. Permission prompts, questions and "ready for
review" are already ticketed automatically by the plugin's hooks: never duplicate them.

## Priorities and dependencies: set them when you split work

Whenever you create more than one ticket for a piece of work, give each one a **priority** and
declare **what blocks what**, so the board's *Next* view (and `ticket_next`) gives the right order:

- `priority`: `P0` drop everything (outage, data loss, a blocker for others), `P1` next up, `P2`
  normal (default for planned work), `P3` some day. Most tickets are P2; P0 is rare.
- `blocked_by: ["ALV-3"]` on `ticket_create`, or `blocked_by_add` / `blocked_by_remove` on
  `ticket_update`: this ticket cannot start before ALV-3 is done ("write the migration" is blocked by
  "design the schema"; "deploy" is blocked by both). A blocked ticket is badged and stays out of
  *Next*; when its last blocker is done it is unblocked by itself. Cycles are refused.
- A user action that gates your work (a secret, an approval) is a blocker too: block your task on
  their ticket instead of writing "waiting for X" in a comment.

## Picking what to do

- Before starting work in a repo, and after finishing a ticket, call `ticket_next` (default: this
  repository; `scope: "all"` for everything, `assignee: "me"` for what is yours). It returns open,
  unblocked tickets by priority, then the user's manual order, then age. Take the first one that is
  yours to do, move it to `in_progress`, and say which one you took.
- When the user asks you to look at the board, also check `ticket_list` for open `todo` tickets of
  this session or repo that nobody has started.

## Tickets the user wrote: take them and make them precise

The user often jots a ticket down fast (`source: "user"`): a few words, typos, no detail. That is
on purpose: they write it rough so you can finish it. When you pick one up, **own it without
asking**:

- Rewrite the title into a clear imperative and fill `body` with what you understood, the plan, the
  files involved and the acceptance criteria (`ticket_update`). Keep their original wording in a
  `comment` (`"Original: …"`) so nothing they wrote is lost.
- Add labels, a priority, links, dependencies, and split it into sub-tickets if it holds several
  steps.
- Move it to `in_progress` when you start, `done` with a one-line comment when finished.
- Only if their intent is truly ambiguous, write your best interpretation in the ticket anyway and
  ask one short question in the conversation. Never leave a rough ticket untouched for fear of
  overwriting it: enriching it is the expected behaviour.

## The feedback inbox: say what wastes your time

`board_feedback` files a ticket in the board's **Feedback** inbox, which the user (or an agent they
task with it) reviews regularly. Use it **as soon as** one of these happens, without waiting for the
end of the task and without asking:

- a tool, a command, an MCP server or the board itself **does not work** as documented (`type: "bug"`);
- an instruction, a skill, a convention or a missing permission **made you lose time**: a retry, a
  workaround, a wrong turn you had to undo (`type: "friction"`);
- you see a concrete **improvement** to a tool, a prompt, a workflow or this board (`type: "suggestion"`).

Make it actionable: a one-line `title`, then in `detail` what you tried, what happened, what you
expected, and what it cost (minutes, tokens, a wrong result). Name the thing in `about`. Session,
repo, agent and plugin version are attached by themselves. One report per problem; do not file the
same one twice in a session, and do not use it for the user's own tasks (those are tickets).

## Keeping the board true

- When you finish something a ticket tracks, close it (`ticket_update` with `status: "done"`, and a
  one-line `comment` saying what was done). Cancelled work: `status: "cancelled"` with the reason.
- Handing something over? Change the `assignee` (to `user`, `claude`, or another agent's id): the
  history shows who gave it to whom. `ticket_comment` takes an optional `to` for the same reason.
- Before ending a long piece of work, or when the user asks "what's left?", call `ticket_list`
  (default scope: this session; `scope: "repo"` for the whole repository) and report what is open.
- Write titles as short imperatives the user can act on without context. Labels are lowercase words
  (`deploy`, `security`, `docs`).
