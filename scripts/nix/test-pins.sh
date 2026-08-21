#!/usr/bin/env bash
# Mutation battery for the two flake pin guards.
#
# A guard nobody has watched FAIL is a claim, not coverage. Each case below
# breaks one thing on purpose and asserts (a) the exit status and (b) that the
# SPECIFIC guard id fired -- and, where the guards are independently reachable,
# that the OTHER ids stayed silent. A red for the wrong reason is scored as a
# failure here, because a mutant that dies to a neighbouring guard proves
# nothing about the one under test.
#
# Everything runs against COPIES in a scratch dir, so this can never touch the
# working tree. Run it directly, or let `nix flake check` run it:
#
#     nix develop -c bash scripts/nix/test-pins.sh
#     nix flake check
#
# The python deps (pyyaml, node-semver) come from the flake's check environment.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../.." && pwd)}"

NODE_SCRIPT="${NODE_SCRIPT:-$HERE/check-node-pin.py}"
PRISMA_SCRIPT="${PRISMA_SCRIPT:-$HERE/check-prisma-pin.py}"
NVMRC="${NVMRC:-$REPO/.nvmrc}"
PACKAGE_JSON="${PACKAGE_JSON:-$REPO/package.json}"
LOCKFILE="${LOCKFILE:-$REPO/pnpm-lock.yaml}"

for f in "$NODE_SCRIPT" "$PRISMA_SCRIPT" "$NVMRC" "$PACKAGE_JSON" "$LOCKFILE"; do
  if [ ! -f "$f" ]; then
    echo "test-pins: input not found: $f" >&2
    exit 2
  fi
done

RUN="$(mktemp -d)"
trap 'rm -rf "$RUN"' EXIT

pass=0
fail=0

# run_case <name> <expected-rc> <must-contain,...> <must-NOT-contain,...> -- cmd...
run_case() {
  local name="$1" want_rc="$2" want="$3" nowant="$4"
  shift 4
  [ "$1" = "--" ] && shift
  local out rc ok=1 tok
  out="$("$@" 2>&1)"
  rc=$?
  [ "$rc" != "$want_rc" ] && ok=0
  # `grep -a`: these are tool logs, and grep returns NOTHING on a stream it
  # decides is binary -- which reads identically to "no match".
  if [ -n "$want" ]; then
    for tok in ${want//,/ }; do
      grep -qa -- "$tok" <<<"$out" || ok=0
    done
  fi
  if [ -n "$nowant" ]; then
    for tok in ${nowant//,/ }; do
      grep -qa -- "$tok" <<<"$out" && ok=0
    done
  fi
  if [ "$ok" = 1 ]; then
    printf 'PASS  %-48s rc=%s\n' "$name" "$rc"
    pass=$((pass + 1))
  else
    printf 'FAIL  %-48s rc=%s (wanted rc=%s, contains[%s], not[%s])\n' \
      "$name" "$rc" "$want_rc" "$want" "$nowant"
    printf '%s\n' "$out" | sed 's/^/        | /'
    fail=$((fail + 1))
  fi
}

# ---------------------------------------------------------------- fixtures ---
mkdir -p "$RUN/base"
cp "$NVMRC" "$RUN/base/.nvmrc"
cp "$PACKAGE_JSON" "$RUN/base/package.json"
cp "$LOCKFILE" "$RUN/base/pnpm-lock.yaml"

# .nvmrc moved one patch. Doubles as the positive control that the script READS
# .nvmrc rather than comparing two constants that happen to agree.
mkdir -p "$RUN/nvmrc-moved"
cp "$PACKAGE_JSON" "$RUN/nvmrc-moved/package.json"
printf '24.20.0\n' >"$RUN/nvmrc-moved/.nvmrc"

# engines.node raised past the flake's node, .nvmrc untouched -- reaches N1
# without reaching N2.
mkdir -p "$RUN/engines-26"
cp "$NVMRC" "$RUN/engines-26/.nvmrc"
python3 - "$PACKAGE_JSON" "$RUN/engines-26/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['engines']['node'] = '>=26.0.0 <27'
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY

# packageManager moved to a different pnpm MAJOR.
mkdir -p "$RUN/pm-11"
cp "$NVMRC" "$RUN/pm-11/.nvmrc"
python3 - "$PACKAGE_JSON" "$RUN/pm-11/package.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d['packageManager'] = 'pnpm@11.0.0'
json.dump(d, open(sys.argv[2], 'w'), indent=2)
PY

# The realistic prisma mutation: `@prisma/client` is declared as a CARET range,
# so a routine lockfile refresh can move the resolved client -- and with it the
# engine commit -- while flake.nix stays where it is. Both the client and the
# CLI move together, which is what a real refresh does.
mkdir -p "$RUN/lock-refreshed"
cp "$PACKAGE_JSON" "$RUN/lock-refreshed/package.json"
python3 - "$LOCKFILE" "$RUN/lock-refreshed/pnpm-lock.yaml" <<'PY'
import sys, yaml
d = yaml.load(open(sys.argv[1]), Loader=yaml.CSafeLoader)
root = d['importers']['.']
root['dependencies']['@prisma/client']['version'] = '6.19.3(prisma@6.19.3(typescript@5.9.2))(typescript@5.9.2)'
root['devDependencies']['prisma']['version'] = '6.19.3(typescript@5.9.2)'
yaml.dump(d, open(sys.argv[2], 'w'), Dumper=yaml.CSafeDumper)
PY

# Only the CLI moves -- reaches P3 without reaching P1 or P2.
mkdir -p "$RUN/lock-cli-skew"
cp "$PACKAGE_JSON" "$RUN/lock-cli-skew/package.json"
python3 - "$LOCKFILE" "$RUN/lock-cli-skew/pnpm-lock.yaml" <<'PY'
import sys, yaml
d = yaml.load(open(sys.argv[1]), Loader=yaml.CSafeLoader)
d['importers']['.']['devDependencies']['prisma']['version'] = '6.19.3(typescript@5.9.2)'
yaml.dump(d, open(sys.argv[2], 'w'), Dumper=yaml.CSafeDumper)
PY

# The snapshot the engine commit is derived from is gone. This must report that
# the guard STOPPED MEASURING, not quietly pass.
mkdir -p "$RUN/lock-no-engines"
cp "$PACKAGE_JSON" "$RUN/lock-no-engines/package.json"
python3 - "$LOCKFILE" "$RUN/lock-no-engines/pnpm-lock.yaml" <<'PY'
import sys, yaml
d = yaml.load(open(sys.argv[1]), Loader=yaml.CSafeLoader)
d['snapshots'] = {k: v for k, v in d['snapshots'].items() if not k.startswith('@prisma/engines@')}
yaml.dump(d, open(sys.argv[2], 'w'), Dumper=yaml.CSafeDumper)
PY

node_check() { # <dir> <flake-node> <flake-pnpm>
  python3 "$NODE_SCRIPT" --nvmrc "$1/.nvmrc" --package-json "$1/package.json" \
    --flake-node "$2" --flake-pnpm "$3"
}
prisma_check() { # <dir> <flake-prisma-version> <flake-engine-commit>
  python3 "$PRISMA_SCRIPT" --package-json "$1/package.json" --lockfile "$1/pnpm-lock.yaml" \
    --flake-prisma-version "$2" --flake-engine-commit "$3"
}

# The values the flake currently supplies. Kept as literals rather than read
# back out of flake.nix on purpose: a test that derives its expectation from the
# thing under test cannot fail.
REAL_NODE=24.19.0
REAL_PNPM=10.34.5
REAL_PRISMA=6.13.0
REAL_COMMIT=361e86d0ea4987e9f53a565309b3eed797a6bcbd

echo "=== node/pnpm guard ==="
run_case "baseline (current flake) is GREEN" 0 "OK:" "N1:,N2:,N3:" -- \
  node_check "$RUN/base" "$REAL_NODE" "$REAL_PNPM"

run_case "N1 alone: engines raised past the flake's node" 1 "N1:" "N2:,N3:" -- \
  node_check "$RUN/engines-26" "$REAL_NODE" "$REAL_PNPM"

run_case "N2 alone: nixpkgs moves node one patch" 1 "N2:" "N1:,N3:" -- \
  node_check "$RUN/base" 24.20.0 "$REAL_PNPM"

run_case "N2 alone: .nvmrc moves, the flake does not" 1 "N2:" "N1:,N3:" -- \
  node_check "$RUN/nvmrc-moved" "$REAL_NODE" "$REAL_PNPM"

# 11.21.0 is not hypothetical: it is what the UNVERSIONED `pkgs.pnpm` resolves
# to at the nixpkgs rev this flake now locks. Using `pnpm_10` is what prevents it.
run_case "N3 alone: unversioned pkgs.pnpm would give 11.21.0" 1 "N3:" "N1:,N2:" -- \
  node_check "$RUN/base" "$REAL_NODE" 11.21.0

run_case "N3 alone: packageManager moves to pnpm 11" 1 "N3:" "N1:,N2:" -- \
  node_check "$RUN/pm-11" "$REAL_NODE" "$REAL_PNPM"

# The state this branch fixed: the flake shipped nodejs_22 (22.22.2) against
# engines.node ">=24.0.0 <25". Red here, green at the top of this file.
run_case "PRE-CHANGE flake (nodejs_22) is red on N1 and N2" 1 "N1:,N2:" "N3:" -- \
  node_check "$RUN/base" 22.22.2 10.33.0

echo
echo "=== prisma guard ==="
run_case "baseline (current flake) is GREEN" 0 "OK:" "P1:,P2:,P3:" -- \
  prisma_check "$RUN/base" "$REAL_PRISMA" "$REAL_COMMIT"

run_case "P1 alone: flake pins a client the lock does not" 1 "P1:" "P2:,P3:" -- \
  prisma_check "$RUN/base" 6.14.0 "$REAL_COMMIT"

run_case "P2 alone: engine commit wrong in the flake" 1 "P2:" "P1:,P3:" -- \
  prisma_check "$RUN/base" "$REAL_PRISMA" 0000000000000000000000000000000000000000

run_case "P3 alone: lockfile CLI/client skew" 1 "P3:" "P1:,P2:" -- \
  prisma_check "$RUN/lock-cli-skew" "$REAL_PRISMA" "$REAL_COMMIT"

# P3 must stay SILENT: client and CLI moved together, so there is no skew.
run_case "lockfile refresh moves client 6.13.0 -> 6.19.3" 1 "P1:,P2:" "P3:" -- \
  prisma_check "$RUN/lock-refreshed" "$REAL_PRISMA" "$REAL_COMMIT"

run_case "engines snapshot gone -> says it stopped measuring" 1 "P2:,no longer measuring" "" -- \
  prisma_check "$RUN/lock-no-engines" "$REAL_PRISMA" "$REAL_COMMIT"

echo
echo "=== controls: the scripts read the FILES, and cannot pass vacuously ==="
run_case "reported .nvmrc value MOVES with the file" 1 "24.20.0" "" -- \
  node_check "$RUN/nvmrc-moved" "$REAL_NODE" "$REAL_PNPM"

run_case "reported locked client MOVES with the lockfile" 1 "6.19.3" "" -- \
  prisma_check "$RUN/lock-refreshed" "$REAL_PRISMA" "$REAL_COMMIT"

run_case "a missing input is an ERROR, never a silent OK" 1 "FileNotFoundError" "OK:" -- \
  node_check "$RUN/does-not-exist" "$REAL_NODE" "$REAL_PNPM"

echo
echo "TOTAL: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
