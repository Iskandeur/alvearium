# CLAUDE.md

The rules for agents live in [AGENTS.md](AGENTS.md), shared with OpenAI Codex CLI and other agents:

@AGENTS.md

Claude Code only:

- `claude plugin validate .` checks the plugin manifest and the hooks file.
- `SESSION_BOARD_DEBUG=1 claude` prints what each hook reports on stderr.
- `claude --plugin-dir .` loads this checkout as the plugin without installing it.
