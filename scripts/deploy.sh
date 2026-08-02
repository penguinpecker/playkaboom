#!/usr/bin/env bash
# Deploy playkaboom.gg to production, then verify it — as ONE step.
#
# The point is that you cannot deploy without verifying. Every incident today
# came from a deploy that reported success while something downstream was
# wrong: a green build that predated an env var, a READY deployment the domain
# never aliased to, an env var that decrypted to "".
#
#   ./scripts/deploy.sh
#   ./scripts/deploy.sh "Session key for this game is missing,more bankroll"
#     ^ optional: strings that MUST appear in the served bundle afterwards.
#       Use them to prove the change you just made actually shipped.
#
# Exit 0 only if the deploy is READY, aliased, and every verification passes.

set -uo pipefail
cd "$(dirname "$0")/.."

MARKERS_ARG="${1:-}"
TOKEN_FILE="${VERCEL_TOKEN_FILE:-$HOME/.keystores/vercel-kaboomweb3.token}"
LOG="${TMPDIR:-/tmp}/playkaboom-deploy-$$.log"

[ -r "$TOKEN_FILE" ] || { echo "no vercel token at $TOKEN_FILE"; exit 1; }

printf '\n\033[1m── 1/3  Local build (fail fast, before touching production)\033[0m\n'
# Build locally first with the SAME public env the deploy will use. A type
# error or a prerender crash costs 3 minutes of Vercel build time otherwise,
# and a broken build that still deploys leaves the old bundle silently live.
if ! npm run build --workspace=@playkaboom/web > "$LOG" 2>&1; then
  printf '\033[31m  local build FAILED — not deploying\033[0m\n'
  grep -E "Type error|Failed to compile|error" "$LOG" | head -20
  exit 1
fi
printf '  \033[32m✔\033[0m local build clean\n'

printf '\n\033[1m── 2/3  Deploying to production\033[0m\n'
if ! npx vercel deploy --prod --yes --token "$(cat "$TOKEN_FILE")" >> "$LOG" 2>&1; then
  printf '\033[31m  vercel deploy FAILED\033[0m\n'; tail -25 "$LOG"; exit 1
fi
grep -E '"readyState"|Aliased' "$LOG" | tail -2 | sed 's/^/  /'

printf '\n\033[1m── 3/3  Verifying what is actually live\033[0m\n'
MARKERS="$MARKERS_ARG" ./scripts/verify-deploy.sh
RC=$?
[ "$RC" -ne 0 ] && printf '\033[31m  deploy landed but verification FAILED — investigate before calling it done\033[0m\n'
echo "  full log: $LOG"
exit $RC
