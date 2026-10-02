# session-board

One ticket board for **all** your Claude Code sessions, terminal and claude.ai/code cloud alike.
At a glance: what is **waiting on you**, what is **in progress**, what is **ready for review**.

```
WAITING ON YOU (2)
  ☁ acme/api@claude/fix-auth · 4m
      task: fix the token refresh race
      Permission: Bash: npm run migrate
      open: https://claude.ai/code/session_01…
  ⌨ acme/web@main · 1m
      Claude needs your permission to use WebFetch

IN PROGRESS (1)
  ⌨ acme/infra@terraform · 12s
      Edit: modules/vpc/main.tf

READY FOR REVIEW (1)
  ☁ acme/api@claude/rate-limit · 9m
      Added a sliding-window limiter and tests. Opened the PR.
      PR: https://github.com/acme/api/pull/412
```

Agent view (`claude agents`) shows local background sessions; terminal tools such as tmux managers
show terminal sessions. None of them puts your cloud sessions on the same board. session-board does,
with plain Claude Code hooks and a tiny self-hosted server.

## How it works

Hooks report each session's state as it changes:

| Hook event | Board state |
| :- | :- |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | **working** (tool calls throttled to one report per 20 s) |
| `PermissionRequest`, `Elicitation`, `Notification` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `agent_needs_input`) | **waiting** on you, with the question or the tool asked for |
| `Stop`, `Notification` (`agent_completed`) | **review**, with the end of Claude's last message and the PR link if any |
| `StopFailure` | **failed** |
| `SessionEnd` | **closed** (hidden after 2 h) |
| `working` with no heartbeat for 30 min | shown as **stale** |

The hook is one zero-dependency Node script. It never blocks or fails your session: network calls
time out after 2 s, every error is swallowed, it always exits 0, and hot-path events run `async`.

## Install

```bash
claude plugin marketplace add Iskandeur/session-board
claude plugin install session-board@session-board
```

That's it for **local mode**: the board lives in `~/.claude/session-board/` and covers every session
on this machine. Type `/board` (or `/session-board:board`).

### Server mode (several machines, cloud sessions)

Run the server anywhere reachable over HTTPS:

```bash
git clone https://github.com/Iskandeur/session-board && cd session-board
openssl rand -hex 32 > token && chmod 600 token
docker compose up -d --build        # or: SESSION_BOARD_TOKEN=… node server/server.mjs
```

Endpoints: `POST /api/event` and `GET /api/board` (both `Authorization: Bearer <token>`),
`POST /api/dismiss`, `GET /` (the web page, auto-refreshing; open it once as `/#token=<token>` and the
browser remembers it), `GET /healthz`.

Then point your machines at it, in any of these ways (first match wins):

1. environment: `SESSION_BOARD_URL=https://board.example.com` and `SESSION_BOARD_TOKEN=…`
   (for example in the `env` block of `~/.claude/settings.json`);
2. the plugin's own settings, asked at install time and editable in `/config` (the token is kept in
   secure storage);
3. `~/.claude/session-board/config.json`: `{ "url": "…", "token": "…" }`.

### Cloud sessions (claude.ai/code)

Cloud sessions do not install plugins, but they run the hooks committed in a repository's
`.claude/settings.json` (see *What carries over from your setup* in the
[cloud environments docs](https://code.claude.com/docs/en/cloud-environments)). So, per repository:

1. In a local session inside the repo, run `/session-board:install-cloud`. It copies the hook script
   to `.claude/session-board/` and registers it in `.claude/settings.json` in `--cloud-only` mode (it
   stays silent on your machines, where the plugin already reports). Commit and push.
2. In the cloud environment the repo uses (claude.ai/code → environment → edit):
   - **Environment variables**: `SESSION_BOARD_URL=https://board.example.com` and
     `SESSION_BOARD_TOKEN=proxy`
   - **API credentials** (Pro and Max plans): add a Bearer credential for your board's host with the
     token as value. Anthropic's proxy adds it to each request, so the token never sits in the
     session, and that host becomes reachable even under the default *Trusted* network level.
   - Without API credentials (Team, Enterprise): set the network level to **Custom**, add your board's
     host to **Allowed domains** (tick *Also include default list…* to keep package registries), and
     put the real token in `SESSION_BOARD_TOKEN`. Anyone who can use the environment can read it.

Cloud tickets carry a direct link to the session (`https://claude.ai/code/session_…`).

## In the terminal

- **`/board`**: prints the board. With Claude Code 2.1.287 or later the plugin's *mod* answers it at
  once, with no Claude turn, even while Claude is working; on older versions the
  `/session-board:board` command prints it through Claude.
- **Status line under the prompt** (mod, 2.1.287+): `3 waiting · 5 working · 2 review`, refreshed
  every 20 s.
- **Your own statusline**: plugins cannot set `statusLine`, so add it yourself if you prefer it:
  copy `statusline/statusline.mjs` to `~/.claude/session-board/statusline.mjs` and set
  `"statusLine": { "type": "command", "command": "node ~/.claude/session-board/statusline.mjs" }`
  in `~/.claude/settings.json`. The script is self-contained, so the copy survives plugin updates.

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
