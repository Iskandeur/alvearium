# Privacy policy: session-board

*Last updated: 2 October 2026*

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
  most), including a pull-request link if there is one.

Set `SESSION_BOARD_SEND_TEXT=0` to record states only, with no prompt, command or message text.

## Where it goes

- **Local mode** (the default, no configuration): everything stays in `~/.claude/session-board/` on
  your own machine. Nothing leaves it.
- **Server mode** (you set a server URL and token): the same records are sent over HTTPS to the
  server **you** run and configure. The server keeps them in one JSON file, drops closed sessions
  after 2 hours and any session silent for 7 days, and serves them only to requests that carry your
  token.

The authors of session-board never receive any of this data. The plugin makes no network request
other than to the server URL you configure.

## Contact

Open an issue at https://github.com/Iskandeur/session-board/issues.
