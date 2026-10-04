#!/bin/bash
# session-board: setup script for a claude.ai/code cloud environment (paste the one-liner from the
# README into the environment's "Setup script" field). It makes the board work in every session of
# the environment, whatever the repository, without committing anything:
#   1. fetches session-board (a pinned ref: first argument, default main) into /opt/session-board;
#   2. sets git's init.templateDir, so every repository cloned in the VM gets a post-checkout hook;
#      git runs it right after the clone, before Claude Code starts, and it writes the cloud copy
#      (hooks, MCP server, skill, /board and /ticket) hidden from git (scripts/cloud-apply.mjs);
#   3. applies the copy at once to the repositories already cloned.
# The environment cache keeps /opt/session-board and the git config, so sessions that skip the setup
# script still get the hook at clone time. The hook also runs scripts/cloud-refresh.sh first: when the
# ref has a newer version than the cached copy, the copy is replaced before it is applied, so a cached
# environment follows the published version without editing the setup script (since 0.3.3).
# Never fails the session: every error is swallowed.
# Usage: bash cloud-setup.sh [ref]     (or: curl -fsSL <raw url> | bash; default ref: main)

REF="${1:-${SESSION_BOARD_REF:-main}}"
SB_HOME="${SESSION_BOARD_HOME:-/opt/session-board}"
REPO_URL="${SESSION_BOARD_REPO_URL:-https://github.com/Iskandeur/session-board}"
RAW="https://raw.githubusercontent.com/Iskandeur/session-board/$REF"
FILES="hooks/report.mjs lib/core.mjs lib/runtime.mjs lib/store.mjs mcp/server.mjs scripts/board.mjs scripts/ticket.mjs scripts/install-repo.mjs scripts/cloud-apply.mjs scripts/cloud-refresh.sh skills/tickets/SKILL.md"

log() { echo "session-board setup: $*"; }

fetch() { # $1 = target dir
  if git clone -q --depth 1 --branch "$REF" "$REPO_URL" "$1" 2>/dev/null; then return 0; fi
  # the GitHub proxy may refuse a repository not attached to the session: raw files are public
  rm -rf "$1"
  for f in $FILES; do
    mkdir -p "$1/$(dirname "$f")"
    curl -fsSL --max-time 20 "$RAW/$f" -o "$1/$f" || return 1
  done
}

main() {
  command -v node >/dev/null || { log "node not found, skipped"; return 0; }
  local tmp="$SB_HOME.new.$$"
  rm -rf "$tmp"
  if ! fetch "$tmp"; then rm -rf "$tmp"; log "could not fetch $REF, skipped"; return 0; fi
  rm -rf "$SB_HOME" && mv "$tmp" "$SB_HOME" || return 0
  date +%s >"$SB_HOME.checked" 2>/dev/null

  local tpl="$SB_HOME/git-template"
  mkdir -p "$tpl/hooks" "$tpl/info"
  [ -f /usr/share/git-core/templates/info/exclude ] && cp /usr/share/git-core/templates/info/exclude "$tpl/info/exclude"
  cat >"$tpl/hooks/post-checkout" <<EOF
#!/bin/sh
# session-board cloud setup: after a clone or a checkout, take the newer published version if there is
# one (scripts/cloud-refresh.sh: one 5 s check at most every 10 min), then (re)write the hidden copy.
if [ -f "$SB_HOME/scripts/cloud-refresh.sh" ]; then
  if command -v timeout >/dev/null; then SESSION_BOARD_HOME="$SB_HOME" timeout 30 bash "$SB_HOME/scripts/cloud-refresh.sh" "$REF" >/dev/null 2>&1
  else SESSION_BOARD_HOME="$SB_HOME" bash "$SB_HOME/scripts/cloud-refresh.sh" "$REF" >/dev/null 2>&1; fi
fi
node "$SB_HOME/scripts/cloud-apply.mjs" "\$(pwd)" --quiet >/dev/null 2>&1
exit 0
EOF
  chmod +x "$tpl/hooks/post-checkout"
  git config --system init.templateDir "$tpl" 2>/dev/null
  git config --global init.templateDir "$tpl" 2>/dev/null

  # repositories already cloned (if the clone ran before this script): apply now, and give them the hook
  local d
  for d in "$PWD" "$HOME"/* /home/user/*; do
    [ -d "$d/.git" ] || continue
    [ -e "$d/.git/hooks/post-checkout" ] || cp "$tpl/hooks/post-checkout" "$d/.git/hooks/post-checkout" 2>/dev/null
    node "$SB_HOME/scripts/cloud-apply.mjs" "$d"
  done
  log "$(node -e "import('$SB_HOME/lib/core.mjs').then(m=>console.log(m.VERSION))" 2>/dev/null) ($REF) ready in $SB_HOME"
}

main "$@" 2>&1 || true
exit 0
