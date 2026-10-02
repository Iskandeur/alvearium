# session-board

One ticket board for **all** your Claude Code work, terminal and claude.ai/code cloud alike: what is
**waiting on you**, what is **in progress**, what is left **to do**. Every ticket knows its session,
repository, branch and machine, so you can look at everything at once or at one repo, one session.

```
WAITING ON YOU (3)
  ⌨ SB-5 Approve Bash: npm run db:migrate -- --env staging · 6m · api@fix/token-refresh
  ⌨ SB-6 Add REFRESH_LOCK_TTL to the staging secrets · 38m · api@fix/token-refresh
  ☁ SB-7 Add a sliding-window rate limiter to the public API [review] · 22m · api@claude/rate-limit
      PR: https://github.com/acme/api/pull/412
      open: https://claude.ai/code/session_01…

IN PROGRESS (2)
  ⌨ SB-1 Fix the token refresh race in the auth middleware · 2h · api@fix/token-refresh
  ⌨ SB-17 Accessibility pass on the product page (WCAG AA) · 25m · web

TO DO (4)
  ⌨ SB-4 Add a regression test · 2h · api@fix/token-refresh
  …
```

## Tickets, sessions, and where tickets come from

A **ticket** is the unit of the board: key (`SB-12`), title, markdown body, status, kind, assignee
(`user` or `claude`), optional priority, labels, sub-tickets, links (PR, cloud session, file, URL),
and a history of every change and comment, with who made it. A **session** is a context: a session
has zero, one or many tickets, and you filter on it.

Statuses: `todo`, `in_progress`, `waiting_on_user`, `review`, `done`, `cancelled`, `failed`. The
board's columns are derived: **Waiting on you** = waiting on you, in review or failed, assigned to
you; **In progress**; **To do**; **Done** folded away. Done tickets older than 30 days leave the
default views (they are never deleted; *Show archived* brings them back).

Tickets come from three places:

1. **Hooks, automatically.** Each session gets one ticket that follows it (in progress while Claude
   works, *review* when the turn ends, *failed* on an API error, *done* when the session ends). A
   permission prompt or a question opens a *waiting on you* sub-ticket that closes by itself when the
   session moves on. One review ticket per session, not one per turn.

   | Hook event | Ticket |
   | :- | :- |
   | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | session ticket **in progress**; open questions close (tool calls throttled to one report per 20 s) |
   | `PermissionRequest`, `Elicitation`, `Notification` (`permission_prompt`, `elicitation_dialog`, `agent_needs_input`) | a **waiting on you** ticket (*Approve Bash: …*, or the question) |
   | `Stop`, `Notification` (`agent_completed`) | session ticket **review**, with the end of Claude's last message and the PR link |
   | `StopFailure` | session ticket **failed**, with the error |
   | `SessionEnd` | session ticket **done**; unanswered questions cancelled |
   | `TaskCreated`, `TaskCompleted` | Claude's own task list mirrored as `claude` tickets (`SESSION_BOARD_MIRROR_TASKS=0` to turn off) |

2. **Claude, through MCP tools.** The plugin ships a small MCP server (`ticket_create`,
   `ticket_update`, `ticket_list`, `ticket_comment`, `ticket_get`) and a skill telling Claude when to
   use them: an action item only you can do ("add the `STRIPE_KEY` secret", "review PR #412"), a long
   task split into sub-tickets, what is left at the end. Tickets attach to the current session and
   repo by themselves.
3. **You**, from the web page (create, edit title / status / labels / priority, comment, close,
   sub-tickets) or the terminal (`/ticket`).

The hook is one zero-dependency Node script. It never blocks or fails your session: network calls
time out after 2 s, every error is swallowed, it always exits 0, and hot-path events run `async`.

## Install

Requires Node.js 22.13 or later (the board is stored with the built-in `node:sqlite`).

```bash
claude plugin marketplace add Iskandeur/session-board
claude plugin install session-board@session-board
```

That's it for **local mode**: tickets live in `~/.claude/session-board/board.db` and cover every
session on this machine. Type `/board` (or `/session-board:board`).

**Updating from 0.1**: `claude plugin marketplace update session-board` then
`claude plugin update session-board@session-board`, and restart your sessions. Your existing sessions
are imported on first use (local `sessions/*.json`, or the server's `board.json`, which is kept as
`board.json.migrated`).

### Server mode (several machines, cloud sessions)

Run the server anywhere reachable over HTTPS:

```bash
git clone https://github.com/Iskandeur/session-board && cd session-board
openssl rand -hex 32 > token && chmod 600 token
docker compose up -d --build        # or: SESSION_BOARD_TOKEN=… node server/server.mjs
```

Then point your machines at it, in any of these ways (first match wins):

1. environment: `SESSION_BOARD_URL=https://board.example.com` and `SESSION_BOARD_TOKEN=…`
   (for example in the `env` block of `~/.claude/settings.json`);
2. the plugin's own settings, asked at install time and editable in `/config` (the token is kept in
   secure storage);
3. `~/.claude/session-board/config.json`: `{ "url": "…", "token": "…" }`.

The hooks, `/board`, `/ticket` and the MCP server all use the same setting.

### Storage and upgrades

Tickets live in one place at a time: the server when a URL and token are set, else
`~/.claude/session-board/board.db` on this machine. When that changes:

- **Local → server** (you set up a server, or 0.2.0 kept Claude's tickets local because its MCP
  server did not receive the plugin settings): at the next session start, the hook sends the local
  `board.db` to the server once (`POST /api/import`): tickets with their status, dates, labels, links,
  sub-tickets, comments and history, plus the sessions the server does not know. Keys are renumbered
  on the server (`SB-3` may become `SB-57`; the ticket history says which key it had). Each ticket is
  recorded with its origin, so a second import never creates a duplicate, and the session tickets the
  server already follows through the hooks are not copied twice. When everything is in, `board.db` is
  renamed to `board.db.uploaded-<date>` (never deleted) and the session shows one line:
  `session-board: 4 tickets from this machine's local board moved to the board on board.example.com`.
- **If it cannot finish** (server down, out of time, server older than 0.2.3): nothing is renamed,
  the start shows how many tickets are still local, once, and it retries at every start. To retry
  now: `/session-board:board sync`.
- **Server → local, or one server → another**: nothing is moved. The next start says where the
  tickets stayed.

The import needs the server to be 0.2.3 or later: update it (`git pull && docker compose up -d
--build`) before or with the plugin.

### API

Every `/api/*` route needs `Authorization: Bearer <token>`. `GET /` serves the web page (open it once
as `/#token=<token>`, the browser remembers it); `GET /healthz` answers without a token.

| Route | |
| :- | :- |
| `GET /api/tickets` | list, newest first, paginated (`limit` ≤ 500, `offset`) |
| `GET /api/tickets/board` | the same filters, grouped in board columns |
| `POST /api/tickets` | create `{ title, body, status, kind, assignee, priority, labels, parent, links, session_id, repo, branch }` |
| `GET /api/tickets/SB-12` | one ticket with its history and sub-tickets |
| `POST` or `PATCH /api/tickets/SB-12` | update any field, optional `comment` in the same call |
| `POST /api/tickets/SB-12/comments` | `{ text }` |
| `GET /api/facets` | repos, sessions, branches, machines, kinds and labels with counts |
| `GET /api/sessions` | sessions, most recent first (`?repo=`) |
| `DELETE /api/sessions/<id>` | remove a session and its tickets |
| `POST /api/import` | `{ board, machine, sessions, tickets }`: a local `board.db`, idempotent (used by the plugin) |
| `POST /api/event`, `GET /api/board`, `POST /api/dismiss` | v0.1 routes, still served (hooks and old clients) |

Filters, on the list and the board: `session`, `repo` (`owner/name`, or just `name`), `branch`,
`machine`, `origin` (`terminal`/`cloud`), `status` (also `open`, `closed`), `assignee`, `kind`,
`label`, `source` (`hook`/`claude`/`user`), `priority`, `parent`, `q` (full text over title, body,
labels and comments; a key like `SB-12` finds that ticket), `created_after`, `created_before`,
`updated_after`, `updated_before` (ISO or epoch ms), `archived=1|only`, `sort=updated|created|priority|key`.
Comma-separate several values: `?repo=acme/api&status=todo,in_progress&label=deploy`.

### The web page

Search box, filter chips (click a repo, a session or a label on any card to filter on it), Board and
List views (the list is grouped by session), a side panel with the ticket's fields, description,
sub-tickets, links and history, and a comment box. Every filter lives in the URL: share it, bookmark
it, use the back button. Light and dark follow your system (`?theme=light|dark` forces one).

### Cloud sessions (claude.ai/code)

Cloud sessions do not install plugins, but they run the hooks committed in a repository's
`.claude/settings.json` (see *What carries over from your setup* in the
[cloud environments docs](https://code.claude.com/docs/en/cloud-environments)). So, per repository:

1. In a local session inside the repo, run `/session-board:install-cloud`. It copies the hook script
   to `.claude/session-board/` and registers it in `.claude/settings.json` in `--cloud-only` mode (it
   stays silent on your machines, where the plugin already reports). Commit and push. Repos set up
   with 0.1 keep working; run it again to pick up the task mirror.
2. In the cloud environment the repo uses (claude.ai/code → environment → edit):
   - **Environment variables**: `SESSION_BOARD_URL=https://board.example.com` and
     `SESSION_BOARD_TOKEN=proxy`
   - **API credentials** (Pro and Max plans): add a Bearer credential for your board's host with the
     token as value. Anthropic's proxy adds it to each request, so the token never sits in the
     session, and that host becomes reachable even under the default *Trusted* network level.
   - Without API credentials (Team, Enterprise): set the network level to **Custom**, add your board's
     host to **Allowed domains** (tick *Also include default list…* to keep package registries), and
     put the real token in `SESSION_BOARD_TOKEN`. Anyone who can use the environment can read it.

Cloud tickets carry a direct link to the session (`https://claude.ai/code/session_…`). The MCP tools
are not available in cloud sessions (they come with the plugin); hooks are.

## In the terminal

- **`/board`**: prints the board (`--here` for this repo, `--repo <name>`, `--q <text>`). With Claude
  Code 2.1.287 or later the plugin's *mod* answers it at once, with no Claude turn, even while
  Claude is working; on older versions `/session-board:board` prints it through Claude.
- **`/ticket`**: `new <title> [--label a,b] [--priority high] [--parent SB-3]`, `done <KEY> [note]`,
  `status <KEY> <status>`, `list [--all] [words]` (default: open tickets of this repo), `show <KEY>`,
  `comment <KEY> <text>`.
- **Status line under the prompt** (mod, 2.1.287+): `2 for you · 3 in progress · 5 to do`,
  refreshed every 20 s.
- **Your own statusline**: plugins cannot set `statusLine`, so add it yourself if you prefer it:
  copy `statusline/statusline.mjs` to `~/.claude/session-board/statusline.mjs` and set
  `"statusLine": { "type": "command", "command": "node ~/.claude/session-board/statusline.mjs" }`
  in `~/.claude/settings.json`. The script is self-contained, so the copy survives plugin updates.

## Which sessions report

- **Machine-wide** (default): `claude plugin install` uses user scope, so every session on that
  machine, in every repo, shows up.
- **One repo off**: `claude plugin disable session-board@session-board --scope local` inside the repo.
- **One repo only**: install with `--scope project` (or `local`) instead of the default user scope.
- **One session off**: start it with `SESSION_BOARD=off claude`.
- **Cloud sessions**: per repo, only where `/session-board:install-cloud` was committed.

## Privacy

Prompts, commands and messages are trimmed to short excerpts; `SESSION_BOARD_SEND_TEXT=0` sends
states only. Data goes nowhere but your machine or **your** server. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm test                      # node --test, no dependencies
SESSION_BOARD_DEBUG=1 claude  # hooks print what they report on stderr
claude plugin validate .
```

MIT licensed.
