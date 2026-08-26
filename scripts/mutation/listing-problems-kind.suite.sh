#!/usr/bin/env bash
# Run every suite that covers the KIND dimension of the listing-completeness advisory,
# in ONE vitest invocation, and COUNT the result rather than reading an exit code.
#
# 🔴 THE TEST PATHS ARE PASSED LITERALLY, never through an unquoted variable. Under zsh
# an unquoted `$FILES` does NOT word-split, so vitest receives one bogus filter, matches
# nothing, and prints "No test files found" with a nonzero status — which reads exactly
# like a real failure and cost a debugging round the first time.
#
# Usage: scripts/mutation/listing-problems-kind.suite.sh <output-log-path>
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Guard the VALUE, not just the cd: `cd ""` is a no-op returning 0 on bash <= 5.2.
[ -n "$ROOT" ] && [ -d "$ROOT" ] || { echo "cannot resolve repo root" >&2; exit 9; }
OUT="${1:?usage: $0 <output-log-path>}"
cd "$ROOT" || exit 9

pnpm vitest run --project unit \
  src/server/services/blocks/__tests__/listing-problems.test.ts \
  src/server/services/blocks/__tests__/listing-problems.kind.test.ts \
  src/server/services/blocks/__tests__/app-access.my-app-listings-kind-problems.test.ts \
  src/server/services/blocks/__tests__/app-listing-assets.scan-batch.test.ts \
  src/server/services/__tests__/block-registry.marketplace-meta.test.ts \
  src/server/routers/__tests__/blocks.router.listMyPublishRequests.test.ts \
  src/server/services/blocks/__tests__/offsite-listing.edit.service.test.ts \
  > "$OUT" 2>&1
rc=$?

plain=$(sed 's/\x1b\[[0-9;]*m//g' "$OUT")
total_line=$(printf '%s\n' "$plain" | grep -aE '^ *Tests +' | tail -1)
echo "rc=$rc | $total_line"
# Emit the failing test NAMES so a mutant's verdict can be attributed to a specific
# guard rather than to "something went red".
printf '%s\n' "$plain" | grep -aE '^ *× ' | sed 's/^ *//;s/ [0-9]*ms$//'
