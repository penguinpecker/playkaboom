#!/usr/bin/env bash
# Deployment watcher for playkaboom.gg.
#
# Polls Vercel for the production deployment id. When it CHANGES, waits for it
# to reach READY, then runs the full verification and appends a verdict to the
# log. Nobody has to remember to check anything.
#
#   ./scripts/watch-deploy.sh                  # watch forever
#   ./scripts/watch-deploy.sh --once           # exit after the FIRST new deploy
#   INTERVAL=20 ./scripts/watch-deploy.sh      # poll every 20s (default 30)
#   LOG=/path/to/file ./scripts/watch-deploy.sh
#
# Exit codes (with --once): 0 = deploy verified clean, 1 = verification failed,
# 2 = the deployment never reached READY.

set -uo pipefail
cd "$(dirname "$0")/.."

# Project/team ids live outside the repo (it is public) — see verify-deploy.sh.
IDS_FILE="${VERCEL_IDS_FILE:-$HOME/.keystores/kaboom-vercel.ids}"
[ -r "$IDS_FILE" ] && . "$IDS_FILE"
PRJ="${VERCEL_PROJECT_ID:-}"
TEAM="${VERCEL_TEAM_ID:-}"
TOKEN_FILE="${VERCEL_TOKEN_FILE:-$HOME/.keystores/vercel-kaboomweb3.token}"
INTERVAL="${INTERVAL:-30}"
LOG="${LOG:-$PWD/deploy-watch.log}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

[ -r "$TOKEN_FILE" ] || { echo "no vercel token at $TOKEN_FILE"; exit 1; }
[ -n "$PRJ" ] && [ -n "$TEAM" ] || {
  echo "missing VERCEL_PROJECT_ID / VERCEL_TEAM_ID (set them in $IDS_FILE)"; exit 1; }
TOK=$(cat "$TOKEN_FILE")

say() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" | tee -a "$LOG"; }

latest() {
  curl -s -H "Authorization: Bearer $TOK" \
    "https://api.vercel.com/v6/deployments?projectId=$PRJ&teamId=$TEAM&limit=1&target=production" \
  | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)).deployments?.[0];d?`${d.uid} ${d.readyState}`:"none none"' 2>/dev/null
}

read -r SEEN _ <<< "$(latest)"
say "watching (baseline $SEEN, every ${INTERVAL}s) → $LOG"

while :; do
  sleep "$INTERVAL"
  # NOTE: never name this UID — bash treats UID as READONLY (the real user
  # id), so `read -r UID ...` fails, UID keeps its numeric value, and the
  # watcher reports a bogus "NEW DEPLOY 501" on its very first poll.
  read -r DEP_ID STATE <<< "$(latest)"
  [ "$DEP_ID" = "none" ] && continue
  [ "$DEP_ID" = "$SEEN" ] && continue

  say "NEW DEPLOY $DEP_ID ($STATE)"
  SEEN="$DEP_ID"

  # Wait for it to finish building. BUILDING/QUEUED/INITIALIZING are transient;
  # ERROR/CANCELED are terminal and worth reporting immediately.
  waited=0
  while [ "$STATE" != "READY" ] && [ "$waited" -lt 900 ]; do
    case "$STATE" in
      ERROR|CANCELED)
        say "❌ deploy $DEP_ID ended as $STATE — NOT verifying"
        [ "$ONCE" -eq 1 ] && exit 2
        break
        ;;
    esac
    sleep 10; waited=$((waited+10))
    read -r _ STATE <<< "$(latest)"
  done

  if [ "$STATE" != "READY" ]; then
    say "❌ deploy $DEP_ID never reached READY (last: $STATE, waited ${waited}s)"
    [ "$ONCE" -eq 1 ] && exit 2
    continue
  fi

  say "READY after ${waited}s — verifying…"
  # No MARKERS: the watcher cannot know what strings a future deploy should
  # contain, and a wrong marker produces a false FAIL. It asserts the things
  # that are always true — alias serving, env non-empty, API healthy, client
  # flag vs on-chain gate, CSP allows the rollup.
  if ./scripts/verify-deploy.sh >>"$LOG" 2>&1; then
    say "✅ $DEP_ID VERIFIED CLEAN"
    [ "$ONCE" -eq 1 ] && exit 0
  else
    say "❌ $DEP_ID VERIFICATION FAILED — see $LOG"
    [ "$ONCE" -eq 1 ] && exit 1
  fi
done
