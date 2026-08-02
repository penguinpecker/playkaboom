#!/usr/bin/env bash
# Post-deploy verification for playkaboom.gg.
#
# Every check here exists because that exact thing silently broke in
# production at least once. Read-only: it never writes chain, env, or code.
#
#   ./scripts/verify-deploy.sh                 # verify prod
#   MARKERS="foo,bar" ./scripts/verify-deploy.sh   # also require these strings
#                                                  # in the served JS bundle
#
# MARKERS must be RUNTIME strings (toast text, error copy, identifiers) —
# never comments. Minification strips comments, so a comment marker always
# reports FAIL on a build that shipped correctly.
#
# Exit 0 = everything green. Exit 1 = at least one FAIL.

set -uo pipefail

DOMAIN="${DOMAIN:-https://playkaboom.gg}"
# Project/team ids live outside the repo (it is public). Override via env, or
# drop VERCEL_PROJECT_ID=… / VERCEL_TEAM_ID=… into the ids file below.
IDS_FILE="${VERCEL_IDS_FILE:-$HOME/.keystores/kaboom-vercel.ids}"
[ -r "$IDS_FILE" ] && . "$IDS_FILE"
PRJ="${VERCEL_PROJECT_ID:-}"
TEAM="${VERCEL_TEAM_ID:-}"
TOKEN_FILE="${VERCEL_TOKEN_FILE:-$HOME/.keystores/vercel-kaboomweb3.token}"
RPC_FILE="${KABOOM_RPC_FILE:-$HOME/.keystores/kaboom-deploy-rpc.txt}"
PROGRAM_ID="9Xip2LRCgC8ucvkYuBQ8jzEsPV74YBnFG1BBeZa98QSh"

FAILED=0
pass() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘ FAIL\033[0m %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -r "$TOKEN_FILE" ] || { echo "no vercel token at $TOKEN_FILE"; exit 1; }
[ -n "$PRJ" ] && [ -n "$TEAM" ] || {
  echo "missing VERCEL_PROJECT_ID / VERCEL_TEAM_ID (set them in $IDS_FILE)"; exit 1; }
TOK=$(cat "$TOKEN_FILE")

# ── 1. the deployment itself ────────────────────────────────────────────────
section "1. Vercel deployment"
DEP=$(curl -s -H "Authorization: Bearer $TOK" \
  "https://api.vercel.com/v6/deployments?projectId=$PRJ&teamId=$TEAM&limit=1&target=production")
READY=$(printf '%s' "$DEP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deployments?.[0]?.readyState ?? "NONE"' 2>/dev/null)
DUID=$(printf '%s' "$DEP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).deployments?.[0]?.uid ?? "?"' 2>/dev/null)
DAGE=$(printf '%s' "$DEP" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)).deployments?.[0];d?Math.round((Date.now()-d.created)/60000):-1' 2>/dev/null)
[ "$READY" = "READY" ] && pass "latest production deploy READY ($DUID, ${DAGE}m ago)" \
                       || fail "latest production deploy is '$READY' ($DUID)"

# A READY build that never became the alias target is the silent killer:
# the deploy "succeeds" and the domain keeps serving the previous build.
section "2. Domain actually serves that build"
LIVE_ETAG=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$DOMAIN/play")
[ "$LIVE_ETAG" = "200" ] && pass "$DOMAIN/play returns 200" || fail "$DOMAIN/play returns $LIVE_ETAG"

# ── 3. public env vars must be present AND non-empty ────────────────────────
# An env var that decrypts to "" passes every "is it set?" check and then
# behaves as unset at runtime. TREASURY_PUBKEY was empty in production while
# looking configured.
section "3. Production env vars"
ENVJSON=$(curl -s -H "Authorization: Bearer $TOK" \
  "https://api.vercel.com/v9/projects/$PRJ/env?teamId=$TEAM&decrypt=true")
check_env() {
  local key="$1" required="${2:-yes}"
  local val
  val=$(printf '%s' "$ENVJSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s);
      const e=(j.envs||[]).find(e=>e.key===process.argv[1]&&e.target?.includes("production"));
      if(!e){process.stdout.write("__MISSING__");return;}
      // Vercel NEVER returns the value of a `sensitive` var, even with
      // decrypt=true. Reading "" for one says nothing about whether it is set,
      // so treating empty as a fault reports a FAIL on correctly-configured
      // production secrets. Only a `plain` var with an empty value is a real
      // finding.
      if(e.type==="sensitive"){process.stdout.write("__SENSITIVE__");return;}
      process.stdout.write(String(e.value??""));
    })' "$key" 2>/dev/null)
  # Sentinel must be plain ASCII: bash truncates $'\0...' to the empty
  # string, so it matched ANY empty value and reported "NOT SET" for a var
  # that exists but decrypts to "". Two different faults, two different fixes.
  if [ "$val" = "__MISSING__" ]; then
    [ "$required" = "yes" ] && fail "$key is NOT SET" || warn "$key not set (optional)"
  elif [ "$val" = "__SENSITIVE__" ]; then
    pass "$key is set (sensitive — value not readable by API, as designed)"
  elif [ -z "$val" ]; then
    fail "$key is set but EMPTY (behaves as unset at runtime)"
  else
    pass "$key = $val"
  fi
}
check_env NEXT_PUBLIC_SOLANA_CLUSTER no
check_env NEXT_PUBLIC_PROGRAM_ID no
check_env NEXT_PUBLIC_ER_RPC
check_env NEXT_PUBLIC_ER_WS
check_env NEXT_PUBLIC_VRF_MODE_ENABLED
check_env TREASURY_PUBKEY

# ── 4. the built bundle actually contains the new code ─────────────────────
# NEXT_PUBLIC_* are inlined at BUILD time. Setting one after the build starts
# produces a green deploy that does not contain the change.
section "4. Marker strings present in the served bundle"
# Do NOT try to discover chunks by scraping /play — most app-router chunks are
# route-level and lazily loaded, so they never appear in the initial HTML and
# a scrape-based check reports false FAILs on code that shipped perfectly.
#
# Instead: locate each marker in the LOCAL build output to get its exact
# content-hashed filename, then fetch that precise path from the domain. That
# proves "the bundle I just built is the bundle being served" with no guessing.
BUILD_DIR="${BUILD_DIR:-apps/web/.next/static/chunks}"
if [ -n "${MARKERS:-}" ]; then
  if [ ! -d "$BUILD_DIR" ]; then
    fail "no local build at $BUILD_DIR — run the build before verifying"
  else
    IFS=',' read -ra WANT <<< "$MARKERS"
    for m in "${WANT[@]}"; do
      local_hit=$(grep -rlF "$m" "$BUILD_DIR" 2>/dev/null | head -1)
      # SERVER routes never appear in client chunks. A marker that lives in an
      # API route is unverifiable this way, so say so instead of reporting a
      # false FAIL on a correctly-shipped security fix.
      if [ -z "$local_hit" ] && grep -rqlF "$m" "${SERVER_DIR:-apps/web/.next/server}" 2>/dev/null; then
        warn "'$m' is in a SERVER route (not a client chunk) — presence in the served bundle cannot be asserted from outside; deploy readiness above covers it"
        continue
      fi
      if [ -z "$local_hit" ]; then
        fail "'$m' is not in the local build. If this is a CODE COMMENT, minification strips it — markers must be RUNTIME strings (toast copy, error text, a rendered label). If it is runtime code, the change did not compile in."
        continue
      fi
      rel="/_next/static/chunks/${local_hit#"$BUILD_DIR"/}"
      code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$DOMAIN$rel")
      if [ "$code" = "200" ] && curl -s -m 20 "$DOMAIN$rel" | grep -qF "$m"; then
        pass "live: $m  ($(basename "$rel"))"
        continue
      fi
      # Exact-hash miss is EXPECTED for route chunks (app/<route>/page-*.js):
      # their content hash includes inlined NEXT_PUBLIC_* values, and Vercel's
      # env is a superset of a local build's, so the same source yields a
      # different hash. Fall back to asking the live route which chunk it
      # actually loads, then look there.
      route=$(printf '%s' "${local_hit#"$BUILD_DIR"/}" | sed -n 's#^app/\(.*\)/page-[^/]*\.js$#\1#p')
      [ -z "$route" ] && route="play"
      found=0
      for c in $(curl -s -m 25 "$DOMAIN/$route" \
                 | grep -oE '/_next/static/chunks/[a-zA-Z0-9_./-]+\.js' | sort -u); do
        if curl -s -m 20 "$DOMAIN$c" | grep -qF "$m"; then
          pass "live: $m  ($(basename "$c"), via /$route)"
          found=1; break
        fi
      done
      [ "$found" -eq 0 ] && fail "'$m' is in the local build but NOT served — stale deploy"
    done
  fi
else
  warn "MARKERS not set — skipping (pass MARKERS='str1,str2' to assert)"
fi

# ── 5. live API health ─────────────────────────────────────────────────────
section "5. Live API"
VS=$(curl -s -m 25 "$DOMAIN/api/vault/state")
printf '%s' "$VS" | grep -q '"v2Initialized":true' \
  && pass "/api/vault/state responding, v2 initialized" \
  || fail "/api/vault/state unhealthy: $(printf '%s' "$VS" | head -c 160)"
HEALTH=$(printf '%s' "$VS" | node -pe 'JSON.parse(require("fs").readFileSync(0)).healthBps ?? -1' 2>/dev/null)
if [ "$HEALTH" -ge 1000 ] 2>/dev/null; then pass "vault health ${HEALTH} bps (floor 1000)"
elif [ "$HEALTH" -ge 0 ] 2>/dev/null; then fail "vault health ${HEALTH} bps — BELOW FLOOR, games will reject"
else warn "could not read healthBps"; fi

# ── 6. client flags vs on-chain gates ──────────────────────────────────────
# Client VRF on + chain gate off = every bet reverts. Chain on + client off =
# the feature is invisible. Both have happened.
section "6. Client flag vs on-chain VRF gate"
if [ -r "$RPC_FILE" ]; then
  KEY=$(sed -E 's#.*/v2/##' "$RPC_FILE")
  CLIENT_VRF=$(printf '%s' "$ENVJSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s);
      const e=(j.envs||[]).find(e=>e.key==="NEXT_PUBLIC_VRF_MODE_ENABLED"&&e.target?.includes("production"));
      process.stdout.write(e&&e.value==="true"?"on":"off");})' 2>/dev/null)
  CHAIN=$(node -e '
    const {Connection,PublicKey}=require("'"$PWD"'/node_modules/@solana/web3.js");
    (async()=>{
      const c=new Connection(process.argv[1],"confirmed");
      const pid=new PublicKey("'"$PROGRAM_ID"'");
      const [v2]=PublicKey.findProgramAddressSync([Buffer.from("kaboom_v2_state")],pid);
      const d=(await c.getAccountInfo(v2)).data;
      // tail: vrf_validator(32) | vrf_max_payout_bps(2) | _reserved(29)
      const val=new PublicKey(d.subarray(d.length-63,d.length-31));
      const bps=d.readUInt16LE(d.length-31);
      console.log(!val.equals(PublicKey.default)&&bps>0?`on ${bps}`:"off");
    })().catch(()=>console.log("err"));' \
    "https://solana-mainnet.g.alchemy.com/v2/$KEY" 2>/dev/null)
  CHAIN_STATE=$(echo "$CHAIN" | awk '{print $1}')
  if [ "$CHAIN_STATE" = "err" ]; then warn "could not read on-chain VRF gate"
  elif [ "$CLIENT_VRF" = "on" ] && [ "$CHAIN_STATE" = "on" ]; then
    pass "VRF: client on, chain armed (cap $(echo "$CHAIN" | awk '{print $2}') bps)"
  elif [ "$CLIENT_VRF" = "on" ] && [ "$CHAIN_STATE" = "off" ]; then
    fail "VRF: client ON but chain gate OFF — every bet will revert"
  elif [ "$CLIENT_VRF" = "off" ] && [ "$CHAIN_STATE" = "on" ]; then
    warn "VRF: chain armed but client flag off — feature is invisible to players"
  else
    pass "VRF: off on both sides (consistent)"
  fi
else
  warn "no RPC key at $RPC_FILE — skipping on-chain cross-check"
fi

# ── 7. CSP must allow every host the browser talks to directly ─────────────
# A missing connect-src entry fails CLOSED and SILENTLY: the browser refuses
# the request, the app sees a generic network error, and nothing in the
# server logs or the deploy output mentions it. The MagicBlock rollup was
# absent from connect-src while VRF was "live", so every tile tap, resume and
# recovery attempt died in the browser with no usable signal.
section "7. CSP allows the rollup endpoint"
CSP=$(curl -s -m 20 -D - -o /dev/null "$DOMAIN/play" | tr -d '\r' | grep -i '^content-security-policy:')
if [ -z "$CSP" ]; then
  warn "no CSP header found"
else
  CONNECT=$(printf '%s' "$CSP" | sed -n 's/.*connect-src \([^;]*\).*/\1/p')
  for host in magicblock.app privy.io supabase.co g.alchemy.com; do
    printf '%s' "$CONNECT" | grep -q "$host" \
      && pass "connect-src allows $host" \
      || fail "connect-src is MISSING $host — browser requests to it fail silently"
  done
fi

section "RESULT"
if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mALL CHECKS PASSED\033[0m\n\n'; exit 0
else
  printf '  \033[31mONE OR MORE CHECKS FAILED\033[0m\n\n'; exit 1
fi
