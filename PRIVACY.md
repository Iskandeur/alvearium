# Privacy policy: Alvearium (formerly session-board)

*Last updated: 3 October 2026*

session-board is a Claude Code plugin plus an optional self-hosted server. It has no central
service, no analytics, and no telemetry. Nobody but you receives anything it collects.

## What it records

For each Claude Code session, the plugin's hooks record:

- the session id, working directory, git repository name (from the `origin` remote) and branch,
  the machine's hostname, and whether it is a terminal or a claude.ai/code cloud session;
- the session's state (working, waiting on you, ready for review, failed, closed) and when it changed;
- short text excerpts that make a ticket readable: the first prompt of the session (200 characters
  at most), the tool and its main argument when Claude asks for a permission (for example the shell
  command), the question Claude is asking, and the end of Claude's last message (400 characters at
  most), including a pull-request link if there is one. Credentials found in these excerpts (an API
  key in a `curl` header, a `*_TOKEN=` assignment, a password in a URL…) are replaced by `[redacted]`
  before they are sent, and again by the server.

Set `SESSION_BOARD_SEND_TEXT=0` to record states only, with no prompt, command or message text.

It also records the tickets you or Claude create (title, description, labels, comments, links) and,
unless `SESSION_BOARD_MIRROR_TASKS=0`, the titles of the tasks in Claude's own task list.

Since 0.3 it also records who acted: the type of each subagent Claude starts (for example
`Explore`) and the end of the subagent's last message (280 characters at most, none with
`SESSION_BOARD_SEND_TEXT=0`), the actor id and name you may set with `SESSION_BOARD_ACTOR`, and the
feedback sessions file with `board_feedback` (its text, plus the session, repository, machine and
plugin version).

## Where it goes

- **Local mode** (the default, no configuration): everything stays in `~/.claude/session-board/`
  (one SQLite file, `board.db`) on your own machine. Nothing leaves it.
- **Server mode** (you set a server URL and token): the same records are sent over HTTPS to the
  server **you** run and configure. The server keeps them in one SQLite file and serves them only
  to requests that carry your token. Closed tickets leave the default views after 30 days; nothing
  is deleted automatically, so delete the file to erase the history.
- **Switching from local to server mode**: the tickets already in the local `board.db` are sent once
  to that same server, then the local file is renamed `board.db.uploaded-<date>` and kept on your
  machine (delete it yourself if you want). The plugin remembers the last server URL (not the
  token) in `~/.claude/session-board/storage.json` to tell you when the storage changes.

The authors of session-board never receive any of this data. The plugin makes no network request
other than to the server URL you configure.

## Contact

Open an issue at https://github.com/Iskandeur/alvearium/issues.
