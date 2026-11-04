#!/usr/bin/env bash
# Rebuild both programs before the diff tests (foreground; one build at a time).
#   ./build.sh          build anchor-ref + kaboom-p
#   ./build.sh test     build, then run every test file (--test-threads=2)
#   ./build.sh test smoke   build, then run only tests/smoke.rs
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
cargo-build-sbf --manifest-path "$here/../anchor-ref/programs/kaboom/Cargo.toml" 2>&1 | grep -v "^warning\|^ *|\|^ *=\|^ *-->\|^$" | tail -3
cargo-build-sbf --manifest-path "$here/../kaboom-p/Cargo.toml" 2>&1 | tail -3
ls -l "$here/../anchor-ref/target/deploy/kaboom.so" "$here/../kaboom-p/target/deploy/kaboom.so"
if [ "${1:-}" = test ]; then
  shift
  if [ $# -gt 0 ]; then
    cargo test --manifest-path "$here/Cargo.toml" --test "$1" -- --test-threads=2 "${@:2}"
  else
    cargo test --manifest-path "$here/Cargo.toml" -- --test-threads=2
  fi
fi
