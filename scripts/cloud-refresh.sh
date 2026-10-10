#!/bin/bash
# session-board: keep the cloud environment's copy current without touching the setup script.
# The environment cache keeps /opt/session-board as the setup script left it, and a cached environment
# skips the setup script: without this, the copy would stay at the version of the day it was cached.
# The git post-checkout hook written by scripts/cloud-setup.sh runs this before scripts/cloud-apply.mjs,
# at every clone (cached or not), so each new session gets the version published on its ref.
#   - at most one check every SESSION_BOARD_REFRESH_EVERY seconds (default 600): a branch switch
#     costs nothing;
#   - the check is one small request (lib/core.mjs on raw.githubusercontent.com, 5 s max);
#   - a newer VERSION is fetched into a new directory, then swapped in; any failure keeps the copy.
# Silent, idempotent, never fails. Usage: bash cloud-refresh.sh [ref]   (env: SESSION_BOARD_HOME)

REF="${1:-${SESSION_BOARD_REF:-main}}"
SB_HOME="${SESSION_BOARD_HOME:-/opt/session-board}"
RAW="${SESSION_BOARD_RAW_URL:-https://raw.githubusercontent.com/Iskandeur/alvearium}/$REF"
EVERY="${SESSION_BOARD_REFRESH_EVERY:-600}"
# keep in step with FILES in scripts/cloud-setup.sh (test/cloudsetup.test.mjs checks it)
FILES="hooks/report.mjs lib/core.mjs lib/runtime.mjs lib/store.mjs mcp/server.mjs scripts/board.mjs scripts/doctor.mjs scripts/ticket.mjs scripts/install-repo.mjs scripts/cloud-apply.mjs scripts/cloud-refresh.sh skills/tickets/SKILL.md"

version_of() { sed -n "s/^export const VERSION = '\([^']*\)';.*/\1/p" "$1" 2>/dev/null | head -n 1; }

main() {
  [ -f "$SB_HOME/lib/core.mjs" ] || return 0
  command -v curl >/dev/null || return 0
  local stamp="$SB_HOME.checked" now last
  now=$(date +%s)
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  case "$last" in '' | *[!0-9]*) last=0 ;; esac
  [ $((now - last)) -lt "$EVERY" ] && return 0
  echo "$now" >"$stamp" 2>/dev/null

  local tmp="$SB_HOME.new.$$" have want
  have=$(version_of "$SB_HOME/lib/core.mjs")
  rm -rf "$tmp"
  mkdir -p "$tmp/lib" || return 0
  curl -fsSL --max-time 5 "$RAW/lib/core.mjs" -o "$tmp/lib/core.mjs" 2>/dev/null || { rm -rf "$tmp"; return 0; }
  want=$(version_of "$tmp/lib/core.mjs")
  # same version: done, unless an older refresh script (its own fixed list) left a file of ours out
  local missing=0
  for f in $FILES; do [ -s "$SB_HOME/$f" ] || missing=1; done
  if [ -z "$want" ] || { [ "$want" = "$have" ] && [ "$missing" = 0 ]; }; then rm -rf "$tmp"; return 0; fi

  local f pids=""
  for f in $FILES; do
    [ "$f" = lib/core.mjs ] && continue
    mkdir -p "$tmp/$(dirname "$f")"
    curl -fsSL --max-time 10 "$RAW/$f" -o "$tmp/$f" 2>/dev/null &
    pids="$pids $!"
  done
  local ok=1 p
  for p in $pids; do wait "$p" || ok=0; done
  for f in $FILES; do [ -s "$tmp/$f" ] || ok=0; done
  [ "$ok" = 1 ] || { rm -rf "$tmp"; return 0; }

  # the git template (init.templateDir) lives in the copy: carry it over, then swap
  [ -d "$SB_HOME/git-template" ] && cp -a "$SB_HOME/git-template" "$tmp/git-template"
  local old="$SB_HOME.old.$$"
  mv "$SB_HOME" "$old" && mv "$tmp" "$SB_HOME" && rm -rf "$old" || { [ -d "$SB_HOME" ] || mv "$old" "$SB_HOME"; rm -rf "$tmp"; }
  echo "alvearium: cloud copy $have → $want"
}

main "$@" 2>/dev/null || true
exit 0
