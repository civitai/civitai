#!/usr/bin/env bash
# ============================================================================
# mutants-app-capture.sh — MUTATION BATTERY for .claude/skills/app-capture,
# driven through .claude/skills/app-capture/tests/run-tests-app-capture.sh.
#
# WHY THIS EXISTS SEPARATELY FROM THE SUITE. The suite proves the runner does
# what it says on the cases it names. This proves the SUITE would NOTICE if the
# runner stopped doing it. A green suite is a claim; a suite that survives no
# mutation is a claim about nothing.
#
# 🔴 SIX THINGS EVERY MUTANT IS CHECKED FOR BEFORE ITS VERDICT IS READ. Numbers
# 1-4 are the guards the infra repo's mutants-skill-size.sh carries, each of which has
# silently manufactured a fake kill somewhere in this repo. Number 0 is about
# this battery's own instrument and it comes first for a reason:
#   0. 🔴 THE INSTRUMENT IS ALIVE — re-proven against the PRISTINE file at EVERY
#      POINT A NEGATIVE VERDICT IS DRAWN (each parse-check failure branch, and a
#      non-zero suite exit). Every validation below reads a tool's verdict, and a
#      dead tool answers "fail" to all of them. Measured 2026-08-19: a sweep reported
#      EIGHT CONSECUTIVE mutants (M46, M47, M48, M49, M49b, M50, M51, M52 —
#      positions 47-54) as "mutant does not compile". They compile. `python3`
#      here resolves through direnv to a SHARED clone's `.venv/bin/python3`,
#      another session rebuilt it mid-run, and the interpreter died
#      (`ModuleNotFoundError: No module named 'encodings'`, observed directly).
#      A CONTIGUOUS block failing at the interpreter level with one identical
#      message is a TIME-WINDOW signature, not a code one — but the battery
#      spelled it as a fact about the mutants, which sent a reviewer hunting a
#      defect that did not exist and produced a confident, wrong claim that 11
#      mutants were inert on a pull request when only 3 were.
#      So: every time a tool says no about a mutant, the SAME tool is asked the
#      SAME question about the PRISTINE copy of the SAME file BEFORE that no is
#      interpreted — inside the failure branch, not ahead of the check, because
#      an interpreter that dies in the gap between the two is the case (proven
#      by control, see apply_mutant). If the pristine one fails, this run can
#      measure NOTHING — the battery EXITS 3 and says so, instead of
#      spending that failure on a mutant. An instrument failure and a mutant
#      failure are now different words and different exit codes, which is the
#      repo's own "validate the instrument before you read its verdict" rule
#      applied to the instrument that validates everything else.
#   1. THE TARGET EXISTS, EXACTLY ONCE. A `sed` that matches nothing leaves the
#      file pristine; the suite then passes and that reads as "SURVIVED" — or
#      the edit lands somewhere unintended and reads as a kill.
#   2. `sed` ITSELF SUCCEEDED. A malformed expression exits non-zero having
#      written NOTHING, but the redirection has already truncated the mutant to
#      ZERO BYTES — which `cmp -s` reads as "changed" and a parse check on an
#      empty file reads as "valid". Every case then fails and a mutation that
#      never happened is recorded as an emphatic kill. Pinned by
#      self_test_broken_sed() below, which runs on every invocation.
#   3. THE MUTANT ACTUALLY DIFFERS. A no-op substitution is indistinguishable
#      from a mutation the suite failed to catch.
#   4. THE MUTANT STILL PARSES (`py_compile`). A syntax error makes EVERY gate
#      fail, which reads as an emphatic kill and proves nothing at all.
#   5. 🔴 THE KILL IS FOR *THIS* MUTANT'S REASON. Every mutant declares the gate
#      that must be the one to catch it, and a kill by some OTHER gate is
#      reported as MISATTRIBUTED, not counted. Without this, redundant coverage
#      lets a mutant die to its neighbour and the battery records coverage that
#      does not exist.
#
# 🔴 SEMANTIC, NOT DELETION-ONLY. Deleting a line is the easiest mutation to
# catch and the least informative. This battery leans on branch inversions,
# operand swaps, boundary off-by-ones, scope widenings and default flips — the
# shapes a wrong EDIT takes, as opposed to a missing one.
#
# The mutants never touch the working tree: the whole scripts/ directory is
# copied to a temp dir per mutant and the suite is pointed at the copy with
# APP_CAPTURE_SCRIPTS. (the infra repo's tests/README.md, "The mutation-testing trap".)
#
# Run:  ./tests/mutants-app-capture.sh
#       exit 0 = every mutant killed, by its own gate
#       exit 1 = a VERDICT: a survivor, a misattribution, or a BROKEN mutant
#       exit 3 = NOT a verdict: the battery could not measure at all (the
#                interpreter died, or the pristine tree does not parse)
# ============================================================================
set -u

# Colocated layout: this battery lives INSIDE the skill it mutates, so both the
# source under test and the suite that grades it are siblings rather than paths
# reached through a repo root. See the same note in run-tests-app-capture.sh.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SKILL_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
SRC="${SKILL_DIR}/scripts"
SUITE="${SCRIPT_DIR}/run-tests-app-capture.sh"

WORK="$(mktemp -d -t app-capture-mutants-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# ── THE INSTRUMENT (validation 0 of the header) ─────────────────────────────
# 🔴 `python3` IS NOT A CONSTANT HERE. On this box it resolves through direnv to
# the SHARED primary clone's `.venv/bin/python3`, which another session can
# rebuild underneath a running sweep. So the interpreter is NAMED in the log
# (path + version) and re-identified at every failure, because a shared-venv swap
# is otherwise invisible in a transcript that only records verdicts.
# MUTANTS_PYTHON exists so the self-test below can point this at a dead one.
PYBIN="${MUTANTS_PYTHON:-python3}"

# The pristine mirror lives under $WORK, never in the tree: `python3 -m
# py_compile` writes a `__pycache__` next to whatever it compiles, and the tree
# copy is the repo's own working directory.
PRISTINE="${WORK}/.pristine"
cp -a "$SRC" "$PRISTINE"
rm -rf "${PRISTINE}/__pycache__"

# 🔴 stderr is DUPLICATED onto fd 9 so an instrument refusal is visible even from
# the self-tests, which redirect apply_mutant's entire output into a file. A
# refusal nobody can see is the same failure this whole change is about.
exec 9>&2

interpreter_id() {
  local p v
  p="$(command -v "$PYBIN" 2>/dev/null)" || p="NOT FOUND on PATH"
  # 🔴 no pipe: `$(cmd | head -1)` returns HEAD's status, so a dead interpreter
  # would read as a successful version probe (CLAUDE.md shell gotcha 8).
  v="$("$PYBIN" -VV 2>&1)" || v="(no version: exit $?)"
  printf '%s [%s]' "${p:-?}" "${v%%$'\n'*}"
}

# instrument_failure <what> [detail]
# 🔴 EXIT 3, AND NEVER A COUNTER. 1 means "a mutant survived / was misattributed
# / could not be built" — a claim about the code. 3 means "the battery could not
# measure" — a claim about the box. Nothing about any mutant is asserted here.
instrument_failure() {
  {
    printf '\n🔴 INSTRUMENT FAILURE — the battery cannot measure: %s\n' "$1"
    printf '   This is NOT a verdict about the mutant. The interpreter or the tree is\n'
    printf '   broken, so every gate would fail for a reason that has nothing to do with\n'
    printf '   the mutation; scoring it BROKEN or KILLED would attribute a failure of\n'
    printf '   this harness to the code under test.\n'
    printf '   interpreter : %s\n' "$(interpreter_id)"
    printf '   pristine    : %s\n' "$PRISTINE"
    if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/   > /'; fi
    printf '   Known cause on this box: python3 resolves through direnv to a SHARED\n'
    printf '   clone .venv that another session rebuilt mid-run (seen 2026-08-19 as\n'
    printf '   eight consecutive mutants "not compiling"). Re-run once it is back.\n'
  } >&9
  exit 3
}

# assert_instrument_live <file>
# Run the exact check the mutant has JUST failed, against the PRISTINE copy of
# the same file. Pristine passes -> that failure is about the mutant. Pristine
# fails -> we know nothing, and say so. Called from inside the failure branches,
# never speculatively: on a healthy tree a SURVIVING mutant costs zero extra
# interpreter calls.
assert_instrument_live() {
  local file="$1" ref="${PRISTINE}/$1" err="${WORK}/instrument.err"
  case "$file" in
    *.py)
      "$PYBIN" -m py_compile "$ref" 2>"$err" \
        || instrument_failure "the PRISTINE $file does not compile" "$(head -3 "$err" 2>/dev/null)" ;;
    *.json)
      "$PYBIN" -c 'import json,sys;json.load(open(sys.argv[1]))' "$ref" 2>"$err" \
        || instrument_failure "the PRISTINE $file does not parse as JSON" "$(head -3 "$err" 2>/dev/null)" ;;
    *.sh)
      bash -n "$ref" 2>"$err" \
        || instrument_failure "the PRISTINE $file does not parse as bash" "$(head -3 "$err" 2>/dev/null)" ;;
  esac
  rm -rf "${PRISTINE}/__pycache__"
}

# A one-time PRE-FLIGHT over one file of each kind. 🔴 It is NOT the guarantee —
# the per-verdict calls inside apply_mutant are — because a pre-flight cannot see an
# interpreter that dies at mutant 47, which is precisely what happened. It earns
# its place for two other reasons: it fails LOUDLY and EARLY, before the
# self-tests start redirecting output into files, and it stamps the interpreter's
# identity into the log right next to the numbers that run produced.
preflight_instrument() {
  local f
  for f in plan.py store-bounds.json capture.sh; do assert_instrument_live "$f"; done
  printf '  preflight      pristine plan.py / store-bounds.json / capture.sh all parse — the instrument is alive\n'
}

KILLED=0; SURVIVED=0; BROKEN=0; MISATTRIB=0
declare -a SURVIVORS=()

# apply_mutant <name> <file> <expected-gate-prefix> <description> <sed-expr> <match-literal>
#   <file>                 plan.py | frame.py | store-bounds.json
#   <expected-gate-prefix> the gate id whose FAIL line must appear, e.g. "P6"
# MUTANTS_ONLY="M14 M28" runs just those, for re-measuring a case you have just
# repaired without a full sweep.
# 🔴 A FILTERED RUN IS NEVER A VERDICT. It prints a PARTIAL banner and says how
# many it skipped, because "0 survivors" over a set of two is exactly the shape
# of a green that means nothing — and a filter left set in a shell would
# otherwise make every later run look complete. A name in MUTANTS_ONLY that
# matches nothing is a hard error, not a quiet empty run.
MUTANTS_ONLY="${MUTANTS_ONLY:-}"
SKIPPED=0
declare -a REQUESTED=()
[ -n "$MUTANTS_ONLY" ] && read -r -a REQUESTED <<< "$MUTANTS_ONLY"
declare -a MATCHED=()

apply_mutant() {
  local name="$1" file="$2" gate="$3" desc="$4" expr="$5" lit="$6"
  local dir="${WORK}/${name}" tgt n

  if [ -n "$MUTANTS_ONLY" ] && [ "${name#SELF}" = "$name" ]; then
    local want found=0 w
    for w in "${REQUESTED[@]}"; do [ "$w" = "$name" ] && found=1; done
    if [ "$found" = 0 ]; then SKIPPED=$((SKIPPED + 1)); return; fi
    MATCHED+=("$name")
  fi

  rm -rf "$dir"; cp -a "$SRC" "$dir"
  # 🔴 DROP THE COPIED BYTECODE CACHE. `cp -a` brings `__pycache__` across with
  # the ORIGINAL sources' mtimes, and CPython validates a cached module on the
  # source's mtime-in-whole-SECONDS plus its size. plan.py imports evidence.py,
  # so a mutant that happens to land in the same second at the same length would
  # be scored SURVIVED having never executed. (Measured elsewhere in this repo at
  # 198/200 stale.) The mutants here are rewritten by `sed` well after the copy,
  # which by itself makes the collision unlikely — but "unlikely" is not a
  # control, and a silently-unrun mutant is indistinguishable from a real gap.
  rm -rf "${dir}/__pycache__"
  tgt="${dir}/${file}"

  n="$(grep -cF -- "$lit" "$tgt")"
  if [ "$n" != "1" ]; then
    printf '  BROKEN   %-5s target not unique in %s (%s occurrences): %s\n' "$name" "$file" "$n" "$lit"
    BROKEN=$((BROKEN + 1)); return
  fi

  # 🔴 READ sed's EXIT STATUS, and read it BEFORE the checks below. On a
  # malformed expression sed exits non-zero having written nothing, while the
  # redirection has already truncated the mutant to zero bytes — which then
  # fails every gate and reads as an emphatic kill. Validation 2 in the header.
  local sederr sedrc
  sederr="${WORK}/${name}.sederr"
  sed "$expr" "${SRC}/${file}" > "$tgt" 2>"$sederr"; sedrc=$?
  if [ "$sedrc" -ne 0 ]; then
    printf '  BROKEN   %-5s sed FAILED (exit %s), the mutant was never written: %s\n' \
      "$name" "$sedrc" "$(head -1 "$sederr" 2>/dev/null)"
    BROKEN=$((BROKEN + 1)); return
  fi
  if cmp -s "${SRC}/${file}" "$tgt"; then
    printf '  BROKEN   %-5s mutation did not change %s — a no-op reads as SURVIVED\n' "$name" "$file"
    BROKEN=$((BROKEN + 1)); return
  fi
  # 🔴 VALIDATION 0 — THE INSTRUMENT IS RE-PROVEN AT THE MOMENT OF THE VERDICT,
  # NOT BEFORE IT. Each branch below asks a tool whether the MUTANT parses; a
  # "no" is only about the mutant if the SAME tool can still parse the PRISTINE
  # file. So `assert_instrument_live` sits INSIDE each failure branch, between
  # the failed check and the BROKEN line it would otherwise print.
  #
  # 🔴 THE PLACEMENT IS THE WHOLE FIX, AND THE OBVIOUS PLACEMENT IS WRONG.
  # Checking the pristine file just BEFORE this `case` was tried first and was
  # demonstrated to fail: with an interpreter rigged to die at a chosen call, the
  # pristine check passed on call N and the mutant's own compile died on call
  # N+1, so `BROKEN M2 mutant does not compile` was printed anyway — the exact
  # misattribution this validation exists to remove, merely one call later. A
  # pre-check leaves a window; a check between the failure and its
  # interpretation leaves none.
  case "$file" in
    *.py)
      if ! "$PYBIN" -m py_compile "$tgt" 2>/dev/null; then
        assert_instrument_live "$file"
        printf '  BROKEN   %-5s mutant does not compile — every gate would fail, a fake kill\n' "$name"
        BROKEN=$((BROKEN + 1)); return
      fi ;;
    *.json)
      if ! "$PYBIN" -c 'import json,sys;json.load(open(sys.argv[1]))' "$tgt" 2>/dev/null; then
        assert_instrument_live "$file"
        printf '  BROKEN   %-5s mutant is not valid JSON — every gate would fail, a fake kill\n' "$name"
        BROKEN=$((BROKEN + 1)); return
      fi ;;
    *.sh)
      # validation 4 for the shell halves. A `sed` that breaks bash syntax makes
      # capture.sh fail to parse, A2 goes red, and every downstream gate collapses
      # — an emphatic kill that measures nothing.
      if ! bash -n "$tgt" 2>/dev/null; then
        assert_instrument_live "$file"
        printf '  BROKEN   %-5s mutant does not parse as bash — every gate would fail, a fake kill\n' "$name"
        BROKEN=$((BROKEN + 1)); return
      fi
      chmod +x "$tgt" ;;
  esac

  local out rc failed by
  out="$(PYTHONDONTWRITEBYTECODE=1 APP_CAPTURE_SCRIPTS="$dir" bash "$SUITE" 2>&1)"; rc=$?
  failed="$(printf '%s\n' "$out" | grep -c '^  FAIL:')"
  by="$(printf '%s\n' "$out" | grep '^  FAIL:' | sed 's/^  FAIL: /            by: /' | cut -c1-120)"

  if [ "$rc" -ne 0 ]; then
    # 🔴 VALIDATION 0, ASKED AGAIN ON THE OTHER SIDE OF THE SUITE. The suite runs
    # python3 itself, so an interpreter that dies DURING it turns every gate red
    # — which reads as an emphatic kill, the same misattribution one step later.
    # One extra compile per red mutant is what separates "the suite noticed the
    # mutation" from "the tool stopped working while it looked".
    assert_instrument_live "$file"
    # validation 5: did the gate that was SUPPOSED to catch this actually fail?
    # `([^0-9]|$)` and not `[:a-z ]`: a gate id can be followed by a sub-letter
    # (`P16a`), a colon, or a SLASH where one FAIL line covers several ids
    # (`P3/P4/P5:`). What must never match is a longer id with the same prefix
    # (`P1` must not match `P11`), which is exactly what excluding a digit buys.
    if printf '%s\n' "$out" | grep '^  FAIL:' | grep -qE "FAIL: ${gate}([^0-9]|$)"; then
      printf '  KILLED   %-5s (%s FAIL, incl. %s) %s\n' "$name" "$failed" "$gate" "$desc"
      printf '%s\n' "$by"
      KILLED=$((KILLED + 1))
    else
      printf '  MISATTR  %-5s killed by %s FAIL, but NOT by %s — coverage is not where it looks: %s\n' \
        "$name" "$failed" "$gate" "$desc"
      printf '%s\n' "$by"
      MISATTRIB=$((MISATTRIB + 1))
    fi
  else
    printf '  SURVIVED %-5s %s\n' "$name" "$desc"
    SURVIVED=$((SURVIVED + 1)); SURVIVORS+=("$name: $desc")
  fi
}

# ── SELF-TEST: this battery's own NEGATIVE CONTROL ──────────────────────────
# 🔴 A harness that COUNTS kills must be shown to classify a known-bad case as
# BROKEN, or its count is a fact about the harness rather than about the code.
# Feed apply_mutant a malformed `s|...|` whose pattern contains the delimiter,
# require it to be reported BROKEN *for the sed reason specifically*, and require
# the KILLED/SURVIVED counters not to move. Asserting on the REASON matters: a
# self-test that only looked for the word BROKEN would also go green if the
# literal merely stopped matching ("target not unique"), leaving the sed check
# entirely unproven.
self_test_broken_sed() {
  local k="$KILLED" s="$SURVIVED" b="$BROKEN" m="$MISATTRIB" out rc=0
  out="${WORK}/selftest.out"
  # The pattern below deliberately CONTAINS the `|` delimiter (plan.py really
  # does join KNOWN_ACTIONS with a pipe), which is the shape that makes sed exit
  # non-zero having written nothing.
  apply_mutant SELFT plan.py P0 "self-test: malformed sed must be BROKEN, not KILLED" \
    's|"|".join(KNOWN_ACTIONS)|X|' \
    '"|".join(KNOWN_ACTIONS)' > "$out" 2>&1

  grep -q 'BROKEN' "$out" && grep -q 'sed FAILED' "$out" || {
    echo "🔴 SELF-TEST FAILED: a malformed sed expression was NOT reported BROKEN for the sed reason."; rc=1; }
  [ "$BROKEN" -eq $((b + 1)) ] || {
    echo "🔴 SELF-TEST FAILED: the BROKEN counter did not advance ($b -> $BROKEN)."; rc=1; }
  [ "$KILLED" -eq "$k" ] && [ "$SURVIVED" -eq "$s" ] && [ "$MISATTRIB" -eq "$m" ] || {
    echo "🔴 SELF-TEST FAILED: a mutation that never happened was counted as a verdict."; rc=1; }

  if [ "$rc" -ne 0 ]; then
    echo "   The battery cannot distinguish a broken mutation from a killed one, so"
    echo "   every number it prints below is unproven. Refusing to report a verdict."
    sed 's/^/   > /' "$out"
    exit 1
  fi
  KILLED="$k"; SURVIVED="$s"; BROKEN="$b"; MISATTRIB="$m"
  printf '  selftest       malformed sed -> BROKEN (not KILLED) — the battery can tell them apart\n'
}

# A SECOND self-test: a mutation that lands but changes nothing the suite can
# observe must come back SURVIVED, not KILLED. Without this, a battery whose
# runner always fails would report 100%% kills and look perfect.
self_test_inert_mutation() {
  local k="$KILLED" s="$SURVIVED" b="$BROKEN" m="$MISATTRIB" out rc=0
  out="${WORK}/selftest2.out"
  apply_mutant SELFI plan.py P0 "self-test: an INERT edit must SURVIVE" \
    's/^WAKE_MS = 4000 .*$/WAKE_MS = 4000/' \
    'WAKE_MS = 4000          # bridge cap is 6s; 4s measured sufficient for these apps' \
    > "$out" 2>&1
  grep -q 'SURVIVED' "$out" || {
    echo "🔴 SELF-TEST FAILED: an inert comment-only edit was not reported SURVIVED:"; cat "$out"; rc=1; }
  [ "$rc" -ne 0 ] && exit 1
  KILLED="$k"; SURVIVED="$s"; BROKEN="$b"; MISATTRIB="$m"; SURVIVORS=()
  printf '  selftest       inert edit -> SURVIVED — the suite is not simply always-red\n'
}

# A THIRD self-test, added 2026-08-17 after this file EXECUTED a command it meant
# to quote. A mutant description written in DOUBLE quotes with a backticked term —
# "so a plain `xdotool click` walks through" — is a command substitution: bash ran
# `xdotool click` on the operator's real display, and the description printed with
# a hole in it. In a repo whose whole safety story is "capture never actuates",
# the test harness pressing a key is the worst possible place for that bug. So the
# CLASS is pinned, not the instance: no `apply_mutant`/`pass`/`fail` line in either
# file may carry an unescaped backtick.
self_test_no_command_substitution() {
  local pat='^[^:]*:[0-9]*: *#' hits ctl bt
  # 🔴 THE BACKTICK ITSELF IS BUILT, NEVER TYPED. A literal one in this function's
  # own positive control is indistinguishable from the defect it hunts, and the
  # scan flagged itself the first time it ran.
  bt="$(printf '\140')"
  hits="$(grep -nE '(apply_mutant |pass "|fail ")' "$SUITE" "$SCRIPT_DIR/$(basename "$0")" 2>/dev/null \
          | grep -F "$bt" | grep -v "\\\\$bt" | grep -vE "$pat")"
  # POSITIVE CONTROL: the same pipeline must SEE a planted bad line, or a clean
  # result here is a fact about the grep and not about these two files.
  ctl="$(printf 'x.sh:1:apply%s M0 plan.py P0 "a %sdate%s here"\n' "_mutant" "$bt" "$bt" \
         | grep -F "$bt" | grep -v "\\\\$bt" | grep -vE "$pat")"
  if [ -z "$ctl" ]; then
    echo "🔴 SELF-TEST FAILED: the backtick scan cannot see a planted command substitution."
    exit 1
  fi
  if [ -n "$hits" ]; then
    echo "🔴 SELF-TEST FAILED: an unescaped backtick in a harness label is a COMMAND"
    echo "   SUBSTITUTION — bash runs it. Escape it as \\\` :"
    printf '%s\n' "$hits" | sed 's/^/   > /'
    exit 1
  fi
  printf '  selftest       no unescaped backtick in any harness label (positive control fired)\n'
}

# A FOURTH self-test, added 2026-08-19 alongside the instrument check itself.
# 🔴 A CONTROL NOBODY HAS WATCHED FIRE IS EXACTLY WHAT THIS CHANGE EXISTS TO
# PREVENT, so the check gets the same treatment it imposes on everything else:
# both halves are exercised on every invocation.
#   (a) FIRES  — a dead interpreter must exit 3 with the INSTRUMENT message and
#                must NOT emit any mutant verdict word.
#   (b) SILENT — the same call on the healthy tree returns 0 and prints nothing,
#                or the check is just an unconditional refusal.
# The subshell is what makes this testable: assert_instrument_live EXITS, so its
# exit code IS the assertion. fd 9 is redirected into the capture file too —
# it points at the real stderr, and without that the message would escape the
# file being grepped and half (a) would pass on an empty file.
self_test_instrument_control() {
  local out rc=0 subrc
  out="${WORK}/selftest4.out"

  ( PYBIN="${WORK}/no-such-python3"; assert_instrument_live plan.py ) >"$out" 2>&1 9>&1
  subrc=$?
  [ "$subrc" -eq 3 ] || {
    echo "🔴 SELF-TEST FAILED: a dead interpreter did not exit 3 (got $subrc) — an"
    echo "   instrument failure would still be reportable as a mutant verdict."; rc=1; }
  grep -q 'INSTRUMENT FAILURE' "$out" || {
    echo "🔴 SELF-TEST FAILED: a dead interpreter produced no instrument message:"; cat "$out"; rc=1; }
  grep -q '^   interpreter : ' "$out" || {
    echo "🔴 SELF-TEST FAILED: the refusal does not name the interpreter, so a"
    echo "   shared-venv swap would still be invisible in the log:"; cat "$out"; rc=1; }
  # 🔴 ANCHORED ON THE VERDICT LINE'S SHAPE, NOT ON THE WORDS. The refusal text
  # itself contains "BROKEN" and "KILLED" — it says scoring it either way would
  # be a lie — so a bare word search flags the correct output (it did, first
  # run). What must not exist is a line in apply_mutant's verdict FORMAT: two
  # spaces, then the verdict token.
  local verdict='^  (BROKEN|KILLED|SURVIVED|MISATTR)'
  if grep -qE "$verdict" "$out"; then
    echo "🔴 SELF-TEST FAILED: a dead interpreter was reported as a MUTANT verdict:"; cat "$out"; rc=1
  fi
  # POSITIVE CONTROL for that pattern: a clean result above is otherwise
  # indistinguishable from a pattern that can never match anything.
  printf '  BROKEN   M0    planted\n' | grep -qE "$verdict" || {
    echo "🔴 SELF-TEST FAILED: the verdict-line pattern cannot see a planted verdict line."; rc=1; }

  ( assert_instrument_live plan.py ) >"$out" 2>&1 9>&1
  subrc=$?
  [ "$subrc" -eq 0 ] || {
    echo "🔴 SELF-TEST FAILED: the instrument check refused a HEALTHY tree (exit $subrc):"; cat "$out"; rc=1; }
  [ ! -s "$out" ] || {
    echo "🔴 SELF-TEST FAILED: the instrument check is not silent on a healthy tree:"; cat "$out"; rc=1; }

  if [ "$rc" -ne 0 ]; then
    echo "   Refusing to report a verdict: the battery cannot tell an instrument"
    echo "   failure from a mutant failure, which is the whole point of the check."
    exit 1
  fi
  printf '  selftest       dead interpreter -> exit 3 INSTRUMENT FAILURE, healthy -> silent (both halves watched)\n'
}

# 🔴 EVERY MUTANT'S TARGET, CHECKED BEFORE ANY OF THEM RUNS — INCLUDING THE ONES
# THIS RUN WILL SKIP. `apply_mutant` already reports BROKEN when a `sed` target
# has stopped matching, but that verdict only exists for a mutant the run
# actually REACHES: a scoped `MUTANTS_ONLY=` re-measurement — the recommended way
# to re-check one guard after editing it — never reaches the others, so an edit
# that silently unhooks a NEIGHBOURING mutant leaves no trace at all. Found the
# hard way on 2026-09-02: M169/M174/M178 had been sitting BROKEN, and M128's
# target had stopped matching on `trunk` when an unrelated change inserted
# `2>"$ferr"` into the line it names. A battery whose target has vanished reports
# nothing and READS AS COVERAGE.
#
# This is a claim about the BATTERY's own wiring, so it is a BROKEN count (exit
# 1), never an instrument failure (exit 3): the tools all worked, the targets did
# not. It costs milliseconds against an hours-long sweep.
preflight_targets() {
  local out rc
  out="$("$PYBIN" - "${BASH_SOURCE[0]}" "$SRC" <<'PY'
import os, re, shlex, sys
battery, src = sys.argv[1], sys.argv[2]
joined = re.sub(r"\\\n\s*", " ", open(battery, encoding="utf-8").read())
bad, n = [], 0
for line in joined.splitlines():
    line = line.strip()
    if not line.startswith("apply_mutant "):
        continue
    try:
        parts = shlex.split(line)
    except ValueError as e:
        bad.append("UNPARSEABLE apply_mutant line (%s): %s" % (e, line[:70]))
        continue
    if len(parts) != 7:
        # the SELF* self-tests take their own argv shape and are exercised directly
        if len(parts) > 1 and parts[1].startswith("SELF"):
            continue
        bad.append("apply_mutant with %d words, expected 7: %s" % (len(parts), line[:70]))
        continue
    n += 1
    name, f, gate, _desc, _expr, lit = parts[1:]
    path = os.path.join(src, f)
    if not os.path.exists(path):
        bad.append("%s names %s, which does not exist" % (name, f))
        continue
    cnt = open(path, encoding="utf-8").read().count(lit)
    if cnt != 1:
        bad.append("%s (%s, claims gate %s): its target appears %d time(s), not 1 — "
                   "%r" % (name, f, gate, cnt, lit[:90]))
print("COUNT=%d" % n)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    assert_instrument_live "frame.py"
    # the COUNT line is bookkeeping for the success message, not a finding
    printf '%s\n' "$out" | grep -v '^COUNT=' | sed 's/^/  BROKEN   /'
    BROKEN=$((BROKEN + 1))
    printf '  preflight      🔴 the line(s) above name mutants whose sed target no longer matches. They\n'
    printf '                 measure NOTHING and read as coverage. Re-point them at the current source.\n'
    return
  fi
  printf '  preflight      every mutant target resolves to exactly ONE line in its file (%s) — checked for\n' \
    "$(printf '%s\n' "$out" | sed -n 's/^COUNT=/mutants=/p')"
  printf '                 ALL mutants, not just this run%s, because a scoped run cannot see a neighbour it skips\n' \
    "$([ -n "$MUTANTS_ONLY" ] && printf "'s" || true)"
}

echo "=== app-capture mutation battery ==="
echo "    scripts: $SRC"
echo "    suite  : $SUITE"
echo "    python : $(interpreter_id)"
echo
preflight_instrument
preflight_targets
self_test_instrument_control
self_test_broken_sed
self_test_inert_mutation
self_test_no_command_substitution
echo

# ── plan.py: the 404 / logged-out guard ─────────────────────────────────────
apply_mutant M1 plan.py P6 "404 detection deleted — a logged-out error page gets captured and framed" \
  's/^    hits = \[m for m in NOT_FOUND_MARKERS if m in text\]$/    hits = []/' \
  '    hits = [m for m in NOT_FOUND_MARKERS if m in text]'

apply_mutant M2 plan.py P8 "404 detection INVERTED — every real page is refused, every 404 planned" \
  's/^    hits = \[m for m in NOT_FOUND_MARKERS if m in text\]$/    hits = [m for m in NOT_FOUND_MARKERS if m not in text]/' \
  '    hits = [m for m in NOT_FOUND_MARKERS if m in text]'

# 🔴 THE DIAGNOSIS IS THE GUARD HERE, SO THE DIAGNOSIS IS WHAT GETS MUTATED.
# `not_found` cannot establish WHICH cause produced the 404 — the page text is
# identical across all of them — so the reason code is constant and the entire
# usable output is the sentence. M1/M2 mutate the DETECTION and are killed by the
# reason code alone; neither can see a message that names the wrong causes, which
# is the defect that actually cost a session on 2026-09-14. This one deletes the
# suspension cause by REWORDING, leaves the refusal firing with the right code,
# and must be killed by P6b's whole-string pin specifically.
apply_mutant M1b plan.py P6b "the SUSPENDED/not-approved cause is reworded out of the not_found message — the refusal still fires with the right code and sends the reader back to a session and a slug that are both fine" \
  's/^            "and its text cannot tell them apart: the app is SUSPENDED or not yet "$/            "and its text cannot tell them apart: the session is logged out or "/' \
  '            "and its text cannot tell them apart: the app is SUSPENDED or not yet "'

apply_mutant M3 plan.py P7 "logged-out detection deleted — an anonymous session captures the sign-in wall" \
  's/^    out = \[m for m in LOGGED_OUT_MARKERS if m in text\]$/    out = []/' \
  '    out = [m for m in LOGGED_OUT_MARKERS if m in text]'

apply_mutant M4 plan.py P6 "the guard runs AFTER the frame is resolved — order matters: the refusal must be early" \
  's/^    guard_page(observed)$/    pass/' \
  '    guard_page(observed)'

# ── plan.py: the cross-origin frame ─────────────────────────────────────────
apply_mutant M5 plan.py P10 "frame matched by SUBSTRING instead of by host — attacker.example wins, and so does the TOP frame" \
  's/    matches = \[f for f in frames if host_of(f.get("url", "")) == want\]/    matches = [f for f in frames if want in f.get("url", "").lower()]/' \
  '    matches = [f for f in frames if host_of(f.get("url", "")) == want]'

# 🔴 ANCHORED ON THE `seen = ...` LINE, NOT ON `raise Refuse(`. The obvious
# anchor occurs 14 times in plan.py and the battery reported it BROKEN — which is
# validation 1 of the header doing its job, and the reason a non-unique target is
# a failure rather than a shrug.
apply_mutant M6 plan.py P9 "a missing app frame FALLS BACK to the top frame instead of refusing" \
  's|        seen = ", ".join(host_of(f.get("url", "")) or "?" for f in frames) or "(none)"|        return 0|' \
  '        seen = ", ".join(host_of(f.get("url", "")) or "?" for f in frames) or "(none)"'

apply_mutant M7 plan.py P2 "emit_dom drops --frame — every app op runs against the top frame and finds nothing" \
  's/self._add(op, \["browser"\] + self.g + \["--frame", str(self.frame_id), op\] + tail,/self._add(op, ["browser"] + self.g + [op] + tail,/' \
  'self._add(op, ["browser"] + self.g + ["--frame", str(self.frame_id), op] + tail,'

apply_mutant M8 plan.py P15 "a nav no longer terminates the plan — the STALE frame id is reused after a reload" \
  's/^            return p.steps, warnings, True$/            pass/' \
  '            return p.steps, warnings, True'

# ── plan.py: throttling + the pathless screenshot ───────────────────────────
apply_mutant M9 plan.py P3 "the wake after a click is dropped — clicks go silently inert on a throttled tab" \
  '/^            p.emit_dom("click", \[a\["click"\]\], "click %s" % a\["click"\])$/{n;s/^            p.wake("click")$/            pass/;}' \
  '            p.emit_dom("click", [a["click"]], "click %s" % a["click"])'

apply_mutant M10 plan.py P3 "wake --wait drops to 0 ms — the call is made and un-throttles nothing" \
  's/^WAKE_MS = 4000  /WAKE_MS = 0  /' \
  'WAKE_MS = 4000  '

# 🔴 THE INDENTATION IS PART OF THE ANCHOR, and it MOVED: the screenshot and its
# settle wake now live inside `if screenshot:` (a capture is an output, not a step
# of the recipe). The old `^    p.wake(...)$` matched nothing, sed no-opped, and
# the battery reported BROKEN — validation 3 doing its job, and the reason a
# no-op is a failure rather than a shrug.
apply_mutant M11 plan.py P3 "the settle wake before the screenshot is dropped — captures come back blank" \
  's/^        p.wake("the last action, before capturing", SETTLE_MS)$/        pass/' \
  '        p.wake("the last action, before capturing", SETTLE_MS)'

apply_mutant M12 plan.py P3 "screenshot is given a PATH — auto-REJECTED under opencode external_directory" \
  's/    p.emit_tab("screenshot", \[\], "capture the tab/    p.emit_tab("screenshot", ["\/tmp\/shot.png"], "capture the tab/' \
  '    p.emit_tab("screenshot", [], "capture the tab'

# ── plan.py: the spend path ─────────────────────────────────────────────────
apply_mutant M13 plan.py P11 "the --trusted requirement INVERTED — the spend path fires unless you ask for it" \
  's/^    if not trusted:$/    if trusted:/' \
  '    if not trusted:'

# 🔴 THIS LITERAL TRACKS `build`'s SIGNATURE, and that is a maintenance edge with
# teeth: when --evidence added a parameter, the anchor stopped matching and the
# battery reported BROKEN — which is the header's validation 1 working, and the
# reason a non-unique target is a failure rather than a shrug. M28 is the same
# class caught late: its anchor had not existed since the declared-cropRect work,
# so that case had been silently unmeasured for some time.
# 🔴 AND AGAIN, EXACTLY AS THIS COMMENT PREDICTED: `build` gained `screenshot`
# and `foreground`, its signature became two lines, and the anchor stopped
# matching. The anchor now sits on the signature's LAST line, which is also where
# the injected body line has to go.
apply_mutant M14 plan.py P11 "--trusted defaults to ON at the API — every plan can spend" \
  '/^def build(recipe, observed, state_name, trusted, evidence_mode=False,$/{n;s/$/\n    trusted = True/;}' \
  'def build(recipe, observed, state_name, trusted, evidence_mode=False,'

apply_mutant M15 plan.py P13 "the Buzz-balance refusal deleted — a spend gets 'verified' by a balance that never moves" \
  's/^    if "verifyBalanceDelta" in a:$/    if False:/' \
  '    if "verifyBalanceDelta" in a:'

apply_mutant M16 plan.py P14 "verifyLabel becomes optional — a swallowed spend is indistinguishable from a fired one" \
  's/^    if not a.get("verifyLabel"):$/    if False:/' \
  '    if not a.get("verifyLabel"):'

apply_mutant M17 plan.py P12 "the operator window is never restored — --trusted leaves the browser holding the screen" \
  's/^    p._add("xdotool", \["xdotool", "windowactivate", "\$PREV_WINDOW"\],$/    p._add("noop", ["true"],/' \
  '    p._add("xdotool", ["xdotool", "windowactivate", "$PREV_WINDOW"],'

apply_mutant M18 plan.py P12 "activate happens BEFORE the focused window is recorded — nothing to restore to" \
  's/^           captureVar="PREV_WINDOW")$/           captureVar="PREV_WINDOW_UNUSED")/' \
  '           captureVar="PREV_WINDOW")'

apply_mutant M19 plan.py P16 "an unknown action verb is SKIPPED instead of refused — a typo silently drops a step" \
  's/^            if len(verbs) != 1:$/            if False:/' \
  '            if len(verbs) != 1:'

# ── frame.py: the cropper ───────────────────────────────────────────────────
apply_mutant M20 frame.py F2 "the full-frame threshold raised past 1.0 — the gate can never fire" \
  's/^FULL_FRAME_FRAC = 0.97$/FULL_FRAME_FRAC = 1.01/' \
  'FULL_FRAME_FRAC = 0.97'

# 🔴 M21 IS THE REASON F4 EXISTS AS A SEPARATE CASE, AND THE BATTERY IS WHY THIS
# COMMENT SAYS F4 AND NOT F3. It was written claiming the FOOTER trap is what an
# AND rule lets through — measured, that is FALSE at this threshold: footer-only
# is 100.0% x 98.2%, and 98.2% >= 97%, so AND still fires and F3 stays green. The
# case that actually discriminates is the RIGHT-EDGE furniture trap: 78.7% wide x
# 100.0% tall, where the width half is nowhere near the threshold. F2 (all bands
# zero, 100.0% x 99.4%) dies to AND as well. Only F4 tells OR from AND.
apply_mutant M21 frame.py F4 "full-frame test uses AND instead of OR — the right-edge-furniture trap (78.7% wide, 100% tall) walks straight through" \
  's/    if fw >= FULL_FRAME_FRAC or fh >= FULL_FRAME_FRAC:/    if fw >= FULL_FRAME_FRAC and fh >= FULL_FRAME_FRAC:/' \
  '    if fw >= FULL_FRAME_FRAC or fh >= FULL_FRAME_FRAC:'

apply_mutant M22 frame.py F1 "the box is no longer clamped to the usable band — it escapes the frame and crops to nothing" \
  's/    x1, y1 = min(max(xs) + stride, band_x1), min(max(ys) + stride, band_y1)/    x1, y1 = max(xs) + stride * 3, max(ys) + stride * 3/' \
  '    x1, y1 = min(max(xs) + stride, band_x1), min(max(ys) + stride, band_y1)'

apply_mutant M23 frame.py F1 "the footer band is ignored — bands become advisory and every box runs to the page bottom" \
  's/    band_y1 = max(band_y0, h - footer)/    band_y1 = h/' \
  '    band_y1 = max(band_y0, h - footer)'

apply_mutant M24 frame.py F1 "the right-edge band is ignored — the scrollbar pins every box to full height" \
  's/    band_x1 = max(band_x0, w - right)/    band_x1 = w/' \
  '    band_x1 = max(band_x0, w - right)'

apply_mutant M25 frame.py F9 "recipe crop overrides are read but discarded — a per-app band change becomes inert" \
  's/        ct = crop.get("chromeTop", ct)/        ct = ct/' \
  '        ct = crop.get("chromeTop", ct)'

# 🔴 EXPECTED GATE F5, NOT F1: F1 passes the manifest's bands AND tolerance
# explicitly, so it is structurally blind to a drift in the DEFAULT. The default
# is what F5/F2/F3/F4/R1 exercise. (Measured: expecting F1 here reported
# MISATTRIBUTED — coverage existed, but not where the label claimed.)
apply_mutant M26 frame.py F5 "the difference tolerance is widened to 200 — nothing ever differs from the background" \
  's/^DEF_TOLERANCE = 8$/DEF_TOLERANCE = 200/' \
  'DEF_TOLERANCE = 8'

# ── frame.py: the identical-box tell ────────────────────────────────────────
apply_mutant M27 frame.py F6 "the identical-box gate deleted — the cheapest real check is gone" \
  's/^    if dupes:$/    if False:/' \
  '    if dupes:'

# 🔴 M28 IS WHY F7 EXISTS. Comparing only against the FIRST state passes the
# 4-identical case (F6) — no: it catches that one, but it CANNOT catch a
# duplicate between states 2 and 3 while state 1 differs. Only F7 builds that.
apply_mutant M28 frame.py F7 "duplicates are only sought against the FIRST state — a 2-vs-3 collision goes unseen" \
  's/^    for m in detected:$/    for m in detected[:2]:/' \
  '    for m in detected:'

apply_mutant M29 frame.py F8 "a single state is accepted — one box can never disagree with itself, so the gate passes vacuously" \
  's/^    if len(measures) < 2:$/    if len(measures) < 0:/' \
  '    if len(measures) < 2:'

apply_mutant M30 frame.py F6 "the box key drops w/h — only the ORIGIN is compared, so two different-sized boxes at one origin read as distinct" \
  's/        key = (b\["x"\], b\["y"\], b\["w"\], b\["h"\])/        key = (b["w"], b["h"])/' \
  '        key = (b["x"], b["y"], b["w"], b["h"])'

# ── frame.py + store-bounds.json: the store gate ────────────────────────────
apply_mutant M31 frame.py B6 "min-dimension checked against the LONG edge — a 1000x200 asset passes on its width" \
  's/        if "min_dimension" in b and min(w, h) < b\["min_dimension"\]:/        if "min_dimension" in b and max(w, h) < b["min_dimension"]:/' \
  '        if "min_dimension" in b and min(w, h) < b["min_dimension"]:'

apply_mutant M32 frame.py B7 "the byte cap becomes an off-by-one (> becomes >=) — an exactly-at-limit asset is wrongly refused" \
  's/        if size > b\["max_bytes"\]:/        if size >= b["max_bytes"]:/' \
  '        if size > b["max_bytes"]:'

apply_mutant M33 frame.py B5 "the count limit is never checked — a 9th screenshot is accepted" \
  's/    if n > b\["max_count"\]:/    if False:/' \
  '    if n > b["max_count"]:'

apply_mutant M34 frame.py B3 "the aspect bounds are SWAPPED — the acceptable range inverts to everything outside it" \
  's/        if ar < b\["aspect_min"\] or ar > b\["aspect_max"\]:/        if ar > b["aspect_min"] and ar < b["aspect_max"]:/' \
  '        if ar < b["aspect_min"] or ar > b["aspect_max"]:'

apply_mutant M35 store-bounds.json B3 "aspect_max drifts to 99 in the SOURCE OF TRUTH — the gate is disabled by data, not by code" \
  's/"aspect_max": 2.6/"aspect_max": 99.0/' \
  '"aspect_max": 2.6'

apply_mutant M36 store-bounds.json B6 "min_dimension drifts to 1 — a 300x300 asset is accepted" \
  's/"min_dimension": 320/"min_dimension": 1/' \
  '"min_dimension": 320'

apply_mutant M37 store-bounds.json R1 "the render canvas drifts off the store's 1200x778 precedent" \
  's/"width": 1200/"width": 1201/' \
  '"width": 1200'

# ── evidence.py: the a11y checks ────────────────────────────────────────────
# Each of these must die to E4, which drives every check from BOTH sides — a
# minimal edit of a REAL capture that must make it fire, and the same file
# untouched that must leave it silent. A one-sided gate cannot tell an inert
# check from a correct one, because both apps score zero on all four.
apply_mutant M38 evidence.py E4 "a <button> is no longer treated as interactive — every unnamed button stops being reported" \
  's/    if node.tag == "button":/    if node.tag == "buttonx":/' \
  '    if node.tag == "button":'

apply_mutant M39 evidence.py E4 "the img-alt test is INVERTED — alt=\"\" (the correct decorative marker) is reported and a missing alt is not" \
  's/        if n.tag == "img" and "alt" not in n.attrs/        if n.tag == "img" and "alt" in n.attrs/' \
  '        if n.tag == "img" and "alt" not in n.attrs'

apply_mutant M40 evidence.py E4 "a PLACEHOLDER counts as a label — the commonest real violation goes silent (WCAG 2.5.3/4.1.2 says it is not a name)" \
  's/            has = has or bool((n.get("title") or "").strip())/            has = has or bool((n.get("placeholder") or "").strip())/' \
  '            has = has or bool((n.get("title") or "").strip())'

apply_mutant M41 evidence.py E4 "the heading-order tolerance widens to three levels — an h1 -> h4 jump stops being a jump" \
  's/            if prev is not None and lvl > prev + 1:/            if prev is not None and lvl > prev + 3:/' \
  '            if prev is not None and lvl > prev + 1:'

# ── evidence.py: the testid inventory ───────────────────────────────────────
# 🔴 EXPECTED E5, and E5 exists BECAUSE of this shape: the inventory is checked
# against an INDEPENDENT regex over the raw bytes. A parser graded only against
# its own totals agrees with itself for free — here `count` silently becomes the
# UNIQUE count (25 -> 22) and every duplicate testid disappears from the total.
apply_mutant M42 evidence.py E5 "the testid COUNT silently becomes the UNIQUE count — duplicates vanish from the inventory" \
  's/    return {"count": sum(ids.values()), "unique": len(ids),/    return {"count": len(ids), "unique": len(ids),/' \
  '    return {"count": sum(ids.values()), "unique": len(ids),'

# ── evidence.py: the two refusals that stop a reassuring zero ───────────────
apply_mutant M43 evidence.py E6 "the probe self-test refusal is deleted — a probe that never hooked anything reports 0 console errors" \
  's/    if not probe.get("selfTest") and not allow_unverified:/    if False:/' \
  '    if not probe.get("selfTest") and not allow_unverified:'

apply_mutant M44 evidence.py E6 "the truncated-DOM refusal is deleted — the bridge's 32768 default silently drops the tail of a 38.6 KB app DOM" \
  's/    if TRUNCATION_MARKER in html\[-200:\]:/    if False:/' \
  '    if TRUNCATION_MARKER in html[-200:]:'

# ── evidence.py: the network classifier ─────────────────────────────────────
apply_mutant M45 evidence.py E3 "a fetch that REJECTED (status 0) is scored ok — a total API outage reads as zero failed requests" \
  's/        if st == 0:/        if st == 1:/' \
  '        if st == 0:'

# 🔴 THE FALSE-POSITIVE DIRECTION, which is the one that kills a gate socially:
# resource-timing reports responseStatus 0 for perfectly good cross-origin loads
# (MEASURED 0 on a successful load), so scoring it `failed` floods every run and
# trains everyone to skip the section.
apply_mutant M46 evidence.py E3 "resource-timing status 0 is scored as a REAL result instead of unknown — every cross-origin asset becomes a false failure" \
  's/    if not isinstance(st, int) or st <= 0:/    if not isinstance(st, int) or st < 0:/' \
  '    if not isinstance(st, int) or st <= 0:'

# ── evidence.py: the console sentinel ───────────────────────────────────────
apply_mutant M47 evidence.py E2 "the probe's own sentinel is no longer stripped — every state reports a phantom debug line the app never logged" \
  's/        if SELFTEST_SENTINEL in text:/        if False:/' \
  '        if SELFTEST_SENTINEL in text:'

# ── evidence.py: the before/after diff ──────────────────────────────────────
apply_mutant M48 evidence.py E7 "the diff stops comparing console messages — a fixed error reads as 'nothing changed'" \
  's/    con = set((m\["level"\], m\["text"\]) for m in art\["console"\]\["messages"\])/    con = set()/' \
  '    con = set((m["level"], m["text"]) for m in art["console"]["messages"])'

# 🔴 THE ONE THAT MAKES THE TOOL USELESS ON DAY TWO rather than wrong: comparing
# the whole artifact means a timestamp or a reinstall flag makes EVERY diff
# non-empty, and a diff that is never empty is a diff nobody reads.
apply_mutant M49 evidence.py E7 "the diff compares volatile meta too — every run differs from every other and the tool stops meaning anything" \
  's/    out\["changed"\] = changed/    out["changed"] = changed or before != after/' \
  '    out["changed"] = changed'

# 🔴 M49b IS THE SAME FAILURE ARRIVED AT HONESTLY. Folding the DOM hash into the
# verdict looks obviously right and makes `diff` exit 1 on every re-run: two real
# captures of one state, minutes apart, agreed on console, network, a11y and all
# 15 testids and differed on the hash (35,556 vs 35,676 bytes) because the app's
# content is live. A signal that is always red is one everyone learns to skip.
apply_mutant M49b evidence.py E7 "a changed DOM hash sets 'changed' — every honest re-run reads as a regression and the exit code becomes noise" \
  's/^    changed = False$/    changed = out["domChanged"]/' \
  '    changed = False'

# ── evidence.py: the probe source ───────────────────────────────────────────
apply_mutant M50 evidence.py E8 "_one_line stops flattening — the probe arrives multi-line and capture.sh's mapfile -t splits it into several arguments" \
  's/    return " ".join(ln.strip() for ln in js.strip().splitlines() if ln.strip())/    return js/' \
  '    return " ".join(ln.strip() for ln in js.strip().splitlines() if ln.strip())'

apply_mutant M51 evidence.py E11 "the actuation ban loses the click( token — the probe may then click things inside a live, logged-in app" \
  's/^PROBE_FORBIDDEN = ("\.click(", /PROBE_FORBIDDEN = (/' \
  'PROBE_FORBIDDEN = (".click(", '

# ── plan.py: the evidence plan ──────────────────────────────────────────────
apply_mutant M52 plan.py E8 "the probe is never installed — the console section is empty for a reason that has nothing to do with the app" \
  's/^        plan_evidence_install(p, state)$/        pass/' \
  '        plan_evidence_install(p, state)'

apply_mutant M53 plan.py E8 "the DOM read goes back to the bridge's DEFAULT cap — a real 38.6 KB app DOM is truncated at 32768 and under-reports every testid" \
  's/\["--max-bytes", "0"\]/["--max-bytes", "32768"]/' \
  '["--max-bytes", "0"]'

apply_mutant M54 plan.py E8 "the DOM read stops being frame-scoped — it reads the TOP frame, which is civitai.com and not the app at all" \
  's/    p.emit_dom("html", /    p.emit_tab("html", /' \
  '    p.emit_dom("html", '

apply_mutant M55 plan.py E10 "the nav guard is deleted — a navigating state plans, emits no artifact, and reads as a clean run" \
  's/^            if "nav" in a:$/            if False:/' \
  '            if "nav" in a:'

# ── capture.sh: the seam ────────────────────────────────────────────────────
# 🔴 THESE TWO ARE WHY THE SUITE'S CAPTURE_SH NOW FOLLOWS $SCRIPTS. Pinned to the
# repo path, the battery mutated a copy nothing ever ran and both would have been
# recorded as SURVIVED — coverage that does not exist, reported as a gap in the code.
apply_mutant M56 capture.sh E9 "capture.sh reads a captureDom key plan.py never emits — the DOM step runs and its output is thrown away" \
  's/get("captureDom","")/get("captureDomX","")/' \
  'get("captureDom","")'

# 🔴 M58 IS THE ONE THAT WOULD HAVE BROKEN EVERY LIVE RUN AND NO OFFLINE FIXTURE
# WOULD HAVE NOTICED. capture.sh reads a step with `2>&1`, and the bridge writes
# "tab is hidden — background tabs are throttled" to STDERR on essentially every
# read, because tabs are CREATED hidden. Judging the payload by its first byte
# then treats banner+JSON as MARKUP: it contains `<`, so it passes every shape
# check, parses to junk, and reports 0 testids and 0 a11y violations, silently.
apply_mutant M58 evidence.py E6 "the payload is judged by its FIRST BYTE again — the bridge's stderr banner turns a real capture into 0 testids and 0 violations, with no error" \
  's/    brace = s.find("{")/    brace = 0 if s[0] == "{" else -1/' \
  '    brace = s.find("{")'

apply_mutant M57 capture.sh E12 "a REFUSED analyze no longer stops the run — the state is skipped and the run still exits 0" \
  's/Not shipping an artifact."; exit 10; }/Not shipping an artifact."; true; }/' \
  'Not shipping an artifact."; exit 10; }'

# ── plan.py: FOREGROUNDING vs ACTUATION ─────────────────────────────────────
# 🔴 THESE SIX ARE THE LOCK ON THE TRADE MADE ON 2026-08-17. The old rule was
# "never `browser activate` outside --trusted", and it went on the finding that
# an App Block does not boot in a hidden tab (5/5 deadlock). 🔴 THAT PREMISE IS
# RETRACTED (2026-08-24: App Blocks boot hidden, 4/4) and the raise is inert,
# but these six still hold — they lock the SEPARATION of two guards, which is a
# property of the code, not of the retracted premise. What replaced it is two guards
# that must be shown to be INDEPENDENT — one that permits foregrounding and one
# that forbids actuation. M59/M60 kill the second; M61 kills it in the
# over-broad direction, where a guard that also banned `activate` would quietly
# take capture back to being unable to run at all.
apply_mutant M59 plan.py G2 "the actuation ban never runs — a plan built WITHOUT --trusted may carry xdotool, i.e. capture can spend" \
  's/^    if trusted:$/    if not trusted:/' \
  '    if trusted:'

# 🔴 M60/M60b/M60c ARE SPLIT BECAUSE A COMBINED ONE SURVIVED. The first version
# dropped the xdotool token AND its op together, and the battery scored it
# SURVIVED: gate G2 planted a single step carrying BOTH `xdotool` and
# `--clearmodifiers`, so the step still matched the other token and the mutant
# died to a clause it had not touched. G2 now plants each clause on its own —
# and these three mutate the narrowest expression that can be wrong.
apply_mutant M60 plan.py G2 "the ban loses the xdotool TOKEN — a step whose argv runs xdotool with no --clearmodifiers walks through" \
  's/^ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")$/ACTUATION_TOKENS = ("--clearmodifiers",)/' \
  'ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")'

apply_mutant M60b plan.py G2 "the ban loses the --clearmodifiers token — a keypress delivered by any other tool walks through" \
  's/^ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")$/ACTUATION_TOKENS = ("xdotool",)/' \
  'ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")'

# 🔴 M60c IS WHY THERE IS NO SECOND "banned ops" LIST. There was one, and it
# could never fire on its own — the scan below joins the op into the text it
# searches, so a mutant of the op list died to the TOKEN list and the battery
# would have scored coverage that did not exist. What remains genuinely
# independent is the SCOPE of that scan: argv alone would pass a step merely
# LABELLED with the actuating tool.
apply_mutant M60c plan.py G2 "the actuation scan narrows to argv and stops reading the step's OP — a step labelled op=xdotool walks through" \
  's/        blob = " ".join(\[st\["op"\]\] + list(st\["argv"\]))/        blob = " ".join(list(st["argv"]))/' \
  '        blob = " ".join([st["op"]] + list(st["argv"]))'

apply_mutant M61 plan.py G1 "the ban is widened back to \`activate\` — the two guards collapse into one again and NO App Block can be captured at all" \
  's/^ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")$/ACTUATION_TOKENS = ("xdotool", "--clearmodifiers", "activate")/' \
  'ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")'

apply_mutant M62 plan.py G1 "the foreground plan stops foregrounding — it wakes the tab instead, which is exactly the thing measured NOT to clear the deadlock" \
  's/    p.emit_tab("activate", \["--wait", str(WAKE_MS), NO_FOCUS_ARG\],/    p.emit_tab("wake", ["--wait", str(WAKE_MS), NO_FOCUS_ARG],/' \
  '    p.emit_tab("activate", ["--wait", str(WAKE_MS), NO_FOCUS_ARG],'

apply_mutant M63 plan.py G1 "the foreground planner may emit a frame-scoped op — it runs BEFORE the app frame exists, so that op would read the TOP frame" \
  's/^            raise Refuse("frame_unresolved",$/            pass; Refuse("frame_unresolved",/' \
  '            raise Refuse("frame_unresolved",'

apply_mutant M64 plan.py G1 "--foreground-plan quietly accepts --trusted — the flag that is supposed to be the spend gate becomes decoration on the capture path" \
  's/^            if a.trusted:$/            if False:/' \
  '            if a.trusted:'

# ── plan.py: the APP-READY gate ─────────────────────────────────────────────
apply_mutant M65 plan.py G3 "the app-ready gate is never planned — every state fires its first action into a booting app again" \
  's/^    plan_ready(p, recipe)$/    pass/' \
  '    plan_ready(p, recipe)'

# 🔴 EXPECTED G3, and the reason is the shape of the bug: waiting only for the
# loading shell to VANISH cannot tell "booted" from "never started" — a frame
# that renders neither answers the same as a frame that finished.
apply_mutant M66 plan.py G3 "the gate waits for the loading marker to vanish instead of for a POSITIVE ready token" \
  's/               expect=READY_TOKEN_READY, timeoutMs=tmo,/               expectAbsent=READY_TOKEN_LOADING, timeoutMs=tmo,/' \
  '               expect=READY_TOKEN_READY, timeoutMs=tmo,'

# 🔴 RE-ANCHORED 2026-08-19: `ready_js` now renders the ANCHOR first (the markup
# question comes before the visibility one), so the old literal matched nothing
# and the battery reported BROKEN — validation 1 doing its job, and the reason a
# non-unique/absent target is a failure rather than a shrug.
apply_mutant M67 plan.py G3 "the ready probe stops looking for the loading shell — it asks about the anchor twice, so a half-booted frame reads as ready" \
  's/            % (json.dumps(anchor_sel), json.dumps(loading_sel),/            % (json.dumps(anchor_sel), json.dumps(anchor_sel),/' \
  '            % (json.dumps(anchor_sel), json.dumps(loading_sel),'

apply_mutant M68 plan.py G4 "a recipe with NO ready gate is silently given a made-up one — the refusal that forces an anchor to be declared disappears" \
  's/^    ready = r.get("ready")$/    ready = r.get("ready") or {"testid": "x"}/' \
  '    ready = r.get("ready")'

apply_mutant M69 plan.py G4 "the ready probe is no longer scanned for actuation — a recipe field can smuggle a click into JS we inject into a live, logged-in app" \
  's/^    guard_injected_js(js, "app-ready probe", "ready_actuates")$/    pass/' \
  '    guard_injected_js(js, "app-ready probe", "ready_actuates")'

apply_mutant M70 plan.py G4 "a ready gate may declare BOTH testid and selector — two anchors, neither of which is the proof" \
  's/^    if len(picked) != 1:$/    if False:/' \
  '    if len(picked) != 1:'

# ── evidence.py: the empty state as a reportable defect ─────────────────────
# 🔴 EVERY ONE OF THESE MUST DIE TO G5, which drives the check from three arms
# cut out of REAL captures (the corpus contains no empty screen, so its silence
# on the untouched files is not evidence the check works).
apply_mutant M71 evidence.py G5 "every child counts as an item — a list holding only its own toolbar reads as populated, so no empty state is ever found" \
  's/        if not (c.get("data-testid") or c.tag in ITEM_TAGS):/        if False:/' \
  '        if not (c.get("data-testid") or c.tag in ITEM_TAGS):'

apply_mutant M72 evidence.py G5 "the verdict is hardcoded to populated — the check becomes a reassuring constant" \
  's/        verdict = "empty" if not items else "populated"/        verdict = "populated"/' \
  '        verdict = "empty" if not items else "populated"'

# 🔴 THE HALF THE OPERATOR ASKED FOR: an empty state WITH a clear next action is
# a finding; one WITHOUT is a defect. A mutant that calls both a defect is the
# false-positive direction, which is what trains people to ignore a section.
apply_mutant M73 evidence.py G5 "every empty state is called a defect, next action or not — the distinction the operator asked for is gone" \
  's/        "defect": bool(verdict == "empty" and not controls),/        "defect": bool(verdict == "empty"),/' \
  '        "defect": bool(verdict == "empty" and not controls),'

apply_mutant M74 evidence.py G5 "the next-action search never widens past the collection itself — a CTA sitting beside the empty list is missed and the state is wrongly called a defect" \
  's/    outer = _named_controls(section, by_id) if section is not None else \[\]/    outer = []/' \
  '    outer = _named_controls(section, by_id) if section is not None else []'

apply_mutant M75 evidence.py G5 "the missing input is never named — the report says a surface is empty and cannot say what would fill it" \
  's/    inputs = (_unfilled_inputs(section if section is not None else root, by_id)/    inputs = ([]/' \
  '    inputs = (_unfilled_inputs(section if section is not None else root, by_id)'

apply_mutant M76 evidence.py G5 "the unfilled test is INVERTED — a filled control is reported as the missing input and an empty one is skipped" \
  's/^        if filled:$/        if not filled:/' \
  '        if filled:'

apply_mutant M77 evidence.py G5 "the no-next-action DEFECT key is never emitted — the finding exists in prose and cannot be diffed" \
  's/^    if es.get("defect"):$/    if False:/' \
  '    if es.get("defect"):'

# ── evidence.py: the diff learns to see content ─────────────────────────────
apply_mutant M78 evidence.py G7 "empty-state keys drop out of the diff entirely — 'the primary state stopped being empty' becomes invisible again" \
  's/    emp = empty_state_defects(art.get("emptyState"))/    emp = set()/' \
  '    emp = empty_state_defects(art.get("emptyState"))'

apply_mutant M79 evidence.py G7 "empty-state transitions stop counting as fixed/regressed — they are listed but score zero" \
  's/^DEFECT_NAMES = ("console", "networkFailures", "a11y", "emptyState")$/DEFECT_NAMES = ("console", "networkFailures", "a11y")/' \
  'DEFECT_NAMES = ("console", "networkFailures", "a11y", "emptyState")'

# 🔴 THE ORIGINAL DEFECT, RE-INTRODUCED: comparing id SETS only. 24 -> 39
# occurrences read `unchanged: 15` on the live run.
apply_mutant M80 evidence.py G6 "per-id occurrence deltas are never computed — the diff is back to comparing unique testid SETS and cannot see a grid fill up" \
  's/^        if nb != na:$/        if False:/' \
  '        if nb != na:'

apply_mutant M81 evidence.py G6 "an occurrence-only change sets \`changed\` — a live app moves its item counts between honest runs, so the verdict goes permanently red" \
  's/^    out\["changed"\] = changed$/    out["changed"] = changed or bool(moved)/' \
  '    out["changed"] = changed'

apply_mutant M82 evidence.py G6 "the human report drops the repeated-id line — the signal exists only in JSON nobody opens" \
  's/^        if rep:$/        if False:/' \
  '        if rep:'

# ── capture.sh: the foregrounding wiring and the two sentences ──────────────
# 🔴 THE SUITE'S CAPTURE_SH FOLLOWS $SCRIPTS (see its header), which is what
# makes these three measure the mutant rather than the pristine file.
apply_mutant M83 capture.sh G8 "the run never foregrounds its tab — every capture is of a deadlocked 'Loading…' frame, which is the blocker this work exists to fix" \
  's/^foreground_tab; fg_rc=\$?$/fg_rc=0/' \
  'foreground_tab; fg_rc=$?'

apply_mutant M84 capture.sh G9 "a never-booted app falls through to the generic failure — the deadlock is reported as a failing action, which is the misdiagnosis that cost the first live run" \
  's/^    \[ "\$step_rc" = 11 \] && { echo "     THE APP NEVER BOOTED/    [ "$step_rc" = 111 ] \&\& { echo "     THE APP NEVER BOOTED/' \
  '    [ "$step_rc" = 11 ] && { echo "     THE APP NEVER BOOTED'

apply_mutant M85 capture.sh G9 "run_step stops telling an app-ready timeout apart from any other timeout — both print the same sentence" \
  's/^      if \[ -n "\$ready" \]; then$/      if false; then/' \
  '      if [ -n "$ready" ]; then'

apply_mutant M86 capture.sh G10 "--tab no longer implies keep-tab — a run CLOSES the operator's own tab when it finishes" \
  's/    --tab)      TAB="\$2"; ATTACHED=1; KEEP_TAB=1; shift 2 ;;/    --tab)      TAB="$2"; ATTACHED=1; shift 2 ;;/' \
  '    --tab)      TAB="$2"; ATTACHED=1; KEEP_TAB=1; shift 2 ;;'

# ── evidence.py: THE PROBE'S OWN LIFECYCLE (defect 1) ───────────────────────
# 🔴 THESE SEVEN LOCK THE FIX FOR THE ARTIFACT THAT STATED A NUMBER ITS OWN
# RECORDS CONTRADICTED. In --tab attach mode the probe survives between states
# and between invocations; the drain emptied the arrays and left the counter
# counting, and `reinstalled` was written at install while only the DRAIN is ever
# saved — so a re-used probe was indistinguishable from a fresh one BY
# CONSTRUCTION. M87/M88/M89 break the probe source; M90-M92 break the reading of
# it; M93 removes the one shape that is corruption rather than lifecycle.
#
# 🔴 ANCHORED ON THE DRAIN'S OWN `var out = ...` LINE AND SCOPED BY A sed RANGE:
# the bare reset statement occurs TWICE (the JS, and the PER_DRAIN_RESETS ledger
# that pins it), so the obvious literal is reported BROKEN — validation 1 doing
# its job. The range mutates the JS only, which is exactly the asymmetry E14's
# ledger check exists to catch.
apply_mutant M87 evidence.py E14 "the drain empties its arrays and leaves the network counter COUNTING — the live defect: networkTotal 6 beside two records, under a note saying ZERO" \
  '/^var out = JSON.stringify(S);$/,/^return out;$/{s/^S\.counts\.networkTotal = 0;$/S.counts.networkTotalX = 0;/;}' \
  'var out = JSON.stringify(S);'

apply_mutant M88 evidence.py E14 "the drain number is stamped AFTER the payload is serialised — every drain reports the PREVIOUS count, so drain #2 still looks like the first" \
  's/^S.drains = (S.drains || 0) + 1;$/;/' \
  'S.drains = (S.drains || 0) + 1;'

apply_mutant M89 evidence.py E14 "the re-install branch stops marking the SURVIVING probe — reinstalled reverts to being structurally always false, because only the DRAIN is ever written to disk" \
  's/^  P.reinstalled = true;$/  P.reinstalledX = true;/' \
  '  P.reinstalled = true;'

apply_mutant M90 evidence.py E13 "the counter is never compared with the records it counts — agree is always true, so the artifact cannot notice its own contradiction" \
  's/    agree = None if total is None else (total == window)/    agree = None if total is None else True/' \
  '    agree = None if total is None else (total == window)'

apply_mutant M91 evidence.py E13 "a counter that disagrees with its own array stops being a tell — a probe predating the lifecycle fields (no installs, no drains) then reads as FRESH" \
  's/        or agree is False/        or False/' \
  '        or agree is False'

apply_mutant M92 evidence.py E13 "the 'observed ZERO requests' note stops checking whether the window can be vouched for — the note that contradicted the field beside it comes straight back" \
  's/            and life\["counts"\]\["agree"\] is not False:/            and True:/' \
  '            and life["counts"]["agree"] is not False:'

# 🔴 M105-M107 EXIST BECAUSE AN AUDIT REPLACED THE WHOLE DISJUNCTION WITH
# `reused = agree is False` AND THE ENTIRE SUITE STAYED GREEN (117 PASS). Three of
# the four reuse tells had zero coverage — and the covered one is precisely the
# tell that CANNOT fire in production, because a correctly-draining re-used probe
# now has `agree == True`. M89/M88 looked like coverage but kill on E14's grep of
# the JS SOURCE: producer side only, nothing testing the reader. One mutant per
# tell, and each must die to E13's own per-tell arm.
apply_mutant M105 evidence.py E13 "the reinstalled tell is dropped — the flag the re-install branch exists to set stops meaning anything to the reader" \
  's/    reused = bool(probe.get("reinstalled")) \\/    reused = False \\/' \
  '    reused = bool(probe.get("reinstalled")) \'

apply_mutant M106 evidence.py E13 "the install-count tell is dropped — a probe installed twice over one page reads as fresh" \
  's/        or (installs is not None and installs > 1) \\/        or False \\/' \
  '        or (installs is not None and installs > 1) \'

apply_mutant M107 evidence.py E13 "the drain-count tell is dropped — the second drain of a surviving probe reads as its first" \
  's/        or (drains is not None and drains > 1) \\/        or False \\/' \
  '        or (drains is not None and drains > 1) \'

# 🔴 M108: the fixture-of-default-values trap made visible. Every probe fixture in
# the corpus had `dropped.network == 0`, so `observed + dropped` and `observed`
# were indistinguishable and this mutant SURVIVED the full suite. E13's arm 7
# feeds a payload whose buffer actually overflowed.
apply_mutant M108 evidence.py E13 "dropped records are left out of the window — an overflowing FRESH state is mislabelled as a re-used probe, and its counter as a lie" \
  's/    window = observed + dropped/    window = observed/' \
  '    window = observed + dropped'

apply_mutant M93 evidence.py E15 "a counter BEHIND the records it counts is accepted — cumulative drift can only run ahead, so this shape is corruption and an artifact is built from it anyway" \
  's/    if agree is False and total < window:/    if False:/' \
  '    if agree is False and total < window:'

# ── plan.py: THE FOREGROUND RE-ASSERTS ──────────────────────────────────────
# 🔴 Foregrounding ONCE PER TAB does not survive: the raised foreground lasts a
# median ~1.5 s (measured 2026-08-19), against states that take tens of seconds.
# Two things need the window and each has its own re-assert — the `state` one
# that OPENS every state plan (the app-ready gate is the next step) and the
# `pre-screenshot` one with GAP 0 to its capture (3/3 at gap 0 vs 1/3 with a 4 s
# wake in between). 🔴 The OCCLUSION rationale both of these used to carry is
# RETRACTED 2026-08-24; the positions are what these mutants pin, and the
# positions still hold. M94/M94b remove one each; M95-M97 and
# M96c/M96d leave them in place and disable the guard clauses that make their
# positions enforceable rather than incidental — the P17 lesson, where a SHAPE
# assertion stayed green for five days over a selector that matched nothing.
apply_mutant M94 plan.py G11 "the per-capture foreground re-assert is never emitted — every screenshot is taken with no raise adjacent to it, which is the 0/3 arm" \
  's/^        if foreground:$/        if False:/' \
  '        if foreground:'

# 🔴 M94b IS DEFECT 1 ITSELF, RE-INTRODUCED. Gating the re-assert on the
# screenshot left an --evidence --no-frame run with no activate in any state plan;
# live, state 1 booted and state 2 came back exit 11 CONFOUND. Deleting the lead
# is the same hole arrived at directly.
# 🔴 THE LITERAL IS THE EMITTER'S OWN MARKER, NOT THE `if` LINE. `grep -F` is a
# SUBSTRING match, so `    if foreground:` (4 spaces) also matches the 8-space
# line inside `if screenshot:` and validation 1 reports BROKEN — correctly. The
# sed expression is anchored (`^    if foreground:$`) and therefore already
# unambiguous; only the uniqueness probe needed a literal that names one site.
apply_mutant M94b plan.py G11 "the state's OWN foreground re-assert is never emitted — a screenshot-free evidence run raises the window once per tab and then works for minutes on a foreground that lasts ~1.5s" \
  's/^    if foreground:$/    if False:/' \
  '                   foreground="state", verifyForeground="i3")'

# 🔴 RE-ANCHORED 2026-08-19: the post-condition now takes the run's own
# --no-foreground switch, so the 3-argument call no longer exists and the battery
# reported BROKEN — validation 1 doing its job. This anchor tracks a SIGNATURE,
# which is the maintenance edge M14's comment warns about; expect it to move again.
apply_mutant M95 plan.py G11 "the activate-placement post-condition never runs on a state plan — an activate may then appear anywhere, marked anything" \
  's/^    guard_activate_placement(steps, trusted, "state", foreground)$/    pass/' \
  '    guard_activate_placement(steps, trusted, "state", foreground)'

# 🔴 M96 SURVIVED THE FIRST SWEEP, AND THE REASON IS THE WHOLE POINT OF
# VALIDATION 5. Both clauses raised the SAME refusal code, so deleting the
# position check left the plant refused anyway — by the COUNT clause — and G11,
# which asserted only the code, passed. The clauses now raise
# `activate_misordered` and `activate_uncounted` separately, and G11 asserts the
# specific one per plant. M96b is the count clause's own killer, reached through
# the module API because no shipped recipe plans two captures.
apply_mutant M96 plan.py G11 "the re-assert's POSITION stops being checked — it may sit anywhere, including after the capture it exists for, taking the screen for nothing" \
  's/            if ops\[i + 1:i + 2\] != \["screenshot"\]:/            if False:/' \
  '            if ops[i + 1:i + 2] != ["screenshot"]:'

# 🔴 M96c/M96d ARE THE TWO NEW CLAUSES, AND THEY EXIST SEPARATELY FOR THE M96
# REASON: one code per clause. `activate_lead_misplaced` is planted by G11's
# fourth plant (a `state` re-assert emitted after the DOM ops); `activate_lead_
# missing` is reached through the module API, because no shipped call site can
# build a foregrounded state plan without a lead — that is what the emitter is.
apply_mutant M96c plan.py G11 "the state re-assert's position stops being checked — it may land AFTER the app-ready gate it exists to hold the window for, which is a raise that held nothing" \
  's/^            if served:$/            if False:/' \
  '            if served:'

apply_mutant M96d plan.py G11 "a foregrounded state plan may carry NO re-assert at all — the guard stops being able to refuse the exact plan shape that shipped and CONFOUNDed live" \
  's/^    if mode == "state" and foreground and n_lead != 1:$/    if False:/' \
  '    if mode == "state" and foreground and n_lead != 1:'

# 🔴 M111: the constant that used to sit on the re-assert, restored. `activate
# --wait MS` is the bridge's bounded page-LOAD wait and holds no foreground —
# swept nowait/100/250/500/1000/1500 from the failing state, 3/3 at every value
# (18/18). A --wait here is inert ceremony that reads as a tuned safety margin.
apply_mutant M111 plan.py G11 "a re-assert carries a --wait again — an inert page-LOAD wait re-acquires the look of a focus-hold timer that was measured not to exist" \
  's/^REFOCUS_ARGS = \["--no-wait", NO_FOCUS_ARG\]$/REFOCUS_ARGS = ["--wait", "1500", NO_FOCUS_ARG]/' \
  'REFOCUS_ARGS = ["--no-wait", NO_FOCUS_ARG]'

# 🔴 M183/M184: THE CONSENT CLAUSE, AND ITS EXEMPTION, EACH ON ITS OWN. Omitting
# --no-focus does NOT withhold the host-side i3 raise: the bridge CLI resolves
# the flag as "on iff stdout is a TTY", so the raise falls back to how capture.sh
# happened to be invoked. Measured 2026-08-28 against an instrumented endpoint —
# identical argv, "focus":false through a command substitution, "focus":TRUE
# through a PTY. Before this clause the property held only because capture.sh's
# run_step runs every op inside a command substitution, and nothing pinned that.
# 🔴 NEITHER IS A PLANT, DELIBERATELY. A planted activate sits at the evidence
# anchor, nowhere near a screenshot, so it is misordered TOO and dies to
# activate_misordered once this clause is neutered — measured, and exactly the
# M96 wrong-clause attribution this battery exists to prevent. G11 reaches both
# through the module API instead, where a step is legal in every other dimension.
apply_mutant M183 plan.py G11 "the consent clause never fires — an activate may omit --no-focus, and the host-side i3 raise then depends on the CALLER'S STDIO (the CLI turns it on for a TTY) rather than on anything the plan declares" \
  's/^        if why != "spend" and NO_FOCUS_ARG not in s\["argv"\]:$/        if False:/' \
  '        if why != "spend" and NO_FOCUS_ARG not in s["argv"]:'

apply_mutant M184 plan.py G11 "the consent clause loses its spend EXEMPTION and becomes a blanket ban — which silently settles, by default, an open question about whether a trusted keypress needs Brave genuinely raised" \
  's/^        if why != "spend" and NO_FOCUS_ARG not in s\["argv"\]:$/        if NO_FOCUS_ARG not in s["argv"]:/' \
  '        if why != "spend" and NO_FOCUS_ARG not in s["argv"]:'

apply_mutant M96b plan.py G11 "one re-assert is accepted for ANY number of captures — a second capture in a state then runs on a foregrounding measured not to survive to it" \
  's/^    if n_pre and n_pre != n_shots:$/    if False:/' \
  '    if n_pre and n_pre != n_shots:'

apply_mutant M97 plan.py G11 "an activate no longer has to ask capture.sh to read the bridge's i3 outcome — a FAILED window raise then walks into a deadlock that reads as a bad ready anchor" \
  's/        if s.get("verifyForeground") != "i3":/        if False:/' \
  '        if s.get("verifyForeground") != "i3":'

apply_mutant M100 plan.py G3 "the ready probe stops asking whether the TAB IS VISIBLE — a window nobody raised and a wrong anchor answer identically again, which is what made two live diagnosis runs conclude nothing" \
  's|            .var V=d.visibilityState==="visible";.|            ""|' \
  '            '"'"'var V=d.visibilityState==="visible";'"'"''

# ── plan.py: THE READY VERDICT (defect 2) ───────────────────────────────────
# 🔴 THESE THREE ARE WHY G3b EXECUTES THE PROBE INSTEAD OF READING IT. The
# defect was a SEMANTIC one — visibility short-circuited ahead of the markup, so
# panorama-360 (16 testids, no app-loading, a click that changed the prompt) was
# refused as APPBOOT_HIDDEN — and every mutation below leaves the word
# `visibilityState`, both `querySelector` calls and the original order intact.
# A gate that greps the injected JS cannot see any of them.
apply_mutant M109 plan.py G3b "HIDDEN loses its anchor-ABSENT conjunction in the injected JS — the token stops being a claim about a window nobody raised and starts firing on any frame that reports hidden, which is the direction the defect came from" \
  's|            .if(!A&&!V)return "%s";.|            '"'"'if(!V)return "%s";'"'"'|' \
  '            '"'"'if(!A&&!V)return "%s";'"'"''

apply_mutant M109b plan.py G3b "the same conjunction dropped on the PYTHON side — the source of truth and the program it renders now disagree, and only one of them is what runs in the app" \
  's/^    if not anchor_present and not visible:$/    if not visible:/' \
  '    if not anchor_present and not visible:'

apply_mutant M110 plan.py G3b "READY stops requiring the loading shell to be GONE — a half-booted frame that renders the anchor beside app-loading reads as ready and the actions fire into it" \
  's|            .if(A&&!L)return "%s";.|            '"'"'if(A)return "%s";'"'"'|' \
  '            '"'"'if(A&&!L)return "%s";'"'"''

# ── plan.py: THE SCREENSHOT AS AN OUTPUT, NOT A STEP (defect 3) ─────────────
apply_mutant M98 plan.py E16 "the screenshot is emitted unconditionally again — on a run that DISCARDS the picture, a bridge-side failure once more destroys the DOM read and the drain that follow it" \
  's/^    if screenshot:$/    if True:/' \
  '    if screenshot:'

apply_mutant M99 plan.py E16 "a plan may drop its screenshot with no --evidence — it then drives the app and keeps no record of anything, which reads exactly like a run that worked" \
  's/^    if not screenshot and not evidence_mode:$/    if False:/' \
  '    if not screenshot and not evidence_mode:'

# ── capture.sh: THE THREE SENTENCES, AND THE SEAM (defects 2 + 3) ───────────
apply_mutant M101 capture.sh G13b "a FAILED host-side window raise no longer stops the run — the tab is never in front and every later failure is misattributed" \
  's/    if \[ "\$i3state" = "failed" \]; then/    if false; then/' \
  '    if [ "$i3state" = "failed" ]; then'

apply_mutant M102 capture.sh G13 "exit 11 stops telling a tab-was-never-in-front from a wrong ready anchor — the confound branch never matches, so the run implicates the recipe's anchor again" \
  's/          \*APPBOOT_HIDDEN\*|\*"tab is hidden"\*)/          *APPBOOT_NEVER_MATCHES*)/' \
  '          *APPBOOT_HIDDEN*|*"tab is hidden"*)'

apply_mutant M103 capture.sh G14 "a screenshot that comes back with no path exits 4 again — the code whose message says THE ACTION FAILED and the app WAS booted, blaming the recipe for the bridge" \
  's/^        exit 12$/        exit 4/' \
  '        exit 12'

apply_mutant M104 capture.sh G14 "capture.sh stops telling plan.py that --no-frame discards the picture — the evidence run takes a screenshot it throws away, and dies with it" \
  's/^        \$(\[ "\$EVIDENCE" = 1 \] && \[ "\$DO_FRAME" = 0 \] && echo --no-screenshot) \\$/        \\/' \
  '        $([ "$EVIDENCE" = 1 ] && [ "$DO_FRAME" = 0 ] && echo --no-screenshot) \'

# 🔴 M112/M112b: THE TWO DISPROVEN PREMISES, EACH RESTORED AS ADVICE. This
# remediation has now named the wrong variable TWICE, and the SECOND time it was
# a test that kept it alive — G14 asserted OCCLUSION for five days after the docs
# retracted it. So there is one mutant per dead end, and each must die.
#   FOCUS    — retracted 2026-08-19: visible-but-unfocused captures 6/6 in
#              192-306ms, so focus does not move the outcome.
#   OCCLUSION— retracted 2026-08-24: the 18.1s hang reproduces with the window on
#              a non-visible workspace and NOTHING drawn on top. Real cause: an
#              unbounded captureVisibleTab fast path (devrc #797).
# 🔴 M112b mutates the line into the operative i3 COMMAND rather than into the
# words "un-cover the window", because the words also occur in the CORRECT
# message ("Do not un-cover the window") — a negative assert on them fires on its
# own negation. The command cannot appear in a correct message.
apply_mutant M112 capture.sh G14 "the exit-12 remediation sends the operator after FOCUS again — the first disproven premise, restored as the one instruction a failed capture leaves behind" \
  's|^            echo "       192-306ms. So moving the pointer or clicking to focus changes"$|            echo "       Keep the Brave window focused for the run, or move the pointer off it."|' \
  '            echo "       192-306ms. So moving the pointer or clicking to focus changes"'

apply_mutant M112b capture.sh G14 "the exit-12 remediation sends the operator to UN-COVER THE WINDOW again — the second disproven premise, restored as an i3 command that moves Brave for a failure window position cannot cause" \
  's|^            echo "       FIX: update the bridge extension, then confirm what is RUNNING —"$|            echo "         i3-msg '"'"'[class=\\"Brave-browser\\"] move container to workspace current'"'"'"|' \
  '            echo "       FIX: update the bridge extension, then confirm what is RUNNING —"'

# 🔴 M112c: THE SAME ADVICE AS PROSE, WITH NO COMMAND IN IT. This is not a third
# variant for completeness — it is the mutant an ADVERSARIAL AUDIT used to walk
# the previous version of this gate, with the whole suite green over it
# (138 PASS). M112b only proves G14 catches the i3-COMMAND spelling; a keyword
# guard cannot catch a paraphrase, which is why G14 now pins the remediation body
# VERBATIM. M112c is the mutant that makes that pin load-bearing rather than
# merely tidy: delete it and a reworded dead end walks back in.
apply_mutant M112c capture.sh G14 "the exit-12 remediation restores the un-cover-the-window advice as PROSE carrying no command — the exact paraphrase that walked the keyword version of this gate while the suite stayed green" \
  's|^            echo "       ⚠️ NOT ESTABLISHED: whether a GENUINELY OCCLUDED window makes it"$|            echo "       Un-cover the window: give Brave the whole workspace and leave nothing"|' \
  '            echo "       ⚠️ NOT ESTABLISHED: whether a GENUINELY OCCLUDED window makes it"'

# 🔴 M112d: THE MUTANT THAT MAKES THE PIN'S *RANGE* LOAD-BEARING, and without it
# the range fix is unguarded. M112/M112b/M112c all REPLACE lines INSIDE the old
# positional range, so every one of them dies under the OLD pin too — i.e. they
# say nothing about whether the range runs to end of output. Reverting `,$p` to a
# content end-anchor would leave the battery at 0 survivors and the suite at
# 138 PASS while restoring the exact escape a delta audit demonstrated.
# This mutant APPENDS one line PAST the old end anchor, still inside the
# `*op_timeout*` branch and still printed to the operator. It is the audit's
# escape, verbatim. It SURVIVES a positional pin and dies only at HEAD.
apply_mutant M112d capture.sh G14 "the retracted un-cover advice is APPENDED past the old end-anchor — inside the branch, printed to the operator, and INVISIBLE to a positionally-bounded pin (this is the escape a delta audit measured at 138 PASS)" \
  's|^            echo "       worker alive) — a FULL Brave restart is the reliable path." ;;$|            echo "       worker alive) — a FULL Brave restart is the reliable path."\n            echo "       Un-cover the window: give Brave the whole workspace and leave nothing"\n            echo "       on top of it, then re-run." ;;|' \
  '            echo "       worker alive) — a FULL Brave restart is the reliable path." ;;'

# ── frame.py + capture.sh + plan.py: THE APP-FRAME BAND, AND THE OPTIONAL CLICK ─
# 🔴 M120 IS THE ONE THAT MATTERS. `max` -> `min` is not a deletion: the derived
# bands are still computed, still threaded, still printed, and every number looks
# ordinary. It is the SIGN of the comparison that decides whether a rect can
# NARROW a band the recipe set — i.e. whether the derivation can readmit the
# full-width furniture it exists to exclude.
apply_mutant M120 frame.py F10 "the rect NARROWS a band instead of widening it — a scrolled page reports a negative top gap, which then drops chromeTop below the breadcrumb bar and it is sampled as content" \
  's/^    return max(ct, top), max(ft, bottom), max(rt, right)$/    return min(ct, top), min(ft, bottom), min(rt, right)/' \
  '    return max(ct, top), max(ft, bottom), max(rt, right)'

apply_mutant M121 frame.py F10 "the viewport cross-check is deleted — a devicePixelRatio the probe read differently from the one the bridge captured at silently yields bands in the wrong units" \
  's/^    if abs(vw - png_w) > APP_FRAME_SCALE_SLACK or abs(vh - png_h) > APP_FRAME_SCALE_SLACK:$/    if False:/' \
  '    if abs(vw - png_w) > APP_FRAME_SCALE_SLACK or abs(vh - png_h) > APP_FRAME_SCALE_SLACK:'

apply_mutant M122 frame.py F10 "the scale slack widens to 200px — the check survives as a decoration no realistic disagreement can trip" \
  's/^APP_FRAME_SCALE_SLACK = 2$/APP_FRAME_SCALE_SLACK = 200/' \
  'APP_FRAME_SCALE_SLACK = 2'

apply_mutant M123 frame.py F10b "a recipe that asks for a derived band and gets none FALLS BACK to its static one — the reassuring fallback, which is the defect this replaces" \
  's/^    if wants and not raw:$/    if False:/' \
  '    if wants and not raw:'

apply_mutant M124 frame.py F10c "a rect handed to a recipe that never asked for one is applied anyway — the recipe own bands become a lie nothing reports" \
  's/^    if raw and not wants:$/    if False:/' \
  '    if raw and not wants:'

apply_mutant M125 frame.py F10 "an ABSENT app frame is reported as the generic unreadable error — the run no longer says the iframe was not found, only that something could not be parsed" \
  's/^                "app_frame_absent",$/                "app_frame_unreadable",/' \
  '                "app_frame_absent",'

apply_mutant M126 frame.py F12 "the probe rounds the TOP gap DOWN — half a pixel readmits the bottom border row of the full-width bar above the iframe, and the box goes full width again" \
  's/Math[.]ceil(r[.]top[*]p)/Math.floor(r.top*p)/' \
  'Math.ceil(r.top*p)'

apply_mutant M127 frame.py F12 "the injected-JS actuation ban is disarmed for the app-frame probe — a probe that can click would ship into the MAIN world of a live, logged-in account" \
  's/^    for tok in RECT_JS_FORBIDDEN:$/    for tok in ():/' \
  '    for tok in RECT_JS_FORBIDDEN:'

# 🔴 M128 WAS FOUND SILENTLY BROKEN ON 2026-09-02 — its target had stopped
# matching on `origin/trunk`, i.e. BEFORE the horizontal-anchor work, when the
# viewport-of-record change inserted `2>"$ferr"` into this very line. A `sed` that
# matches nothing leaves the file pristine, the suite passes, and the battery
# prints BROKEN — which is only a verdict if someone reads it. Re-pointed here.
# Same class as M169/M174/M178, found the same day, by the same audit: after ANY
# edit to a mutated line, re-check that its mutant still applies.
apply_mutant M128 capture.sh G15 "capture.sh stops handing the measured rect to frame.py — the crop silently reverts to the static band that cannot be right in both banner states" \
  's/^          \${USE_APPFRAME:+--app-frame-rect "\$OUT\/\$st.rect.json"} 2>"\$ferr")" || {$/          2>"$ferr")" || {/' \
  '          ${USE_APPFRAME:+--app-frame-rect "$OUT/$st.rect.json"} 2>"$ferr")" || {'

apply_mutant M129 capture.sh G15 "the app-frame probe is sent FRAME-SCOPED — it then searches the app own document, finds no iframe, and answers ABSENT forever" \
  's|--tab "\$TAB" js "\$RJS"|--tab "$TAB" --frame 830 js "$RJS"|' \
  '--tab "$TAB" js "$RJS"'

apply_mutant M130 capture.sh G16 "every selector miss is tolerated again — a drifted selector runs a step that does nothing, captures the wrong screen, and reports success" \
  's/^        if \[ -n "\$optional" \]; then$/        if true; then/' \
  '        if [ -n "$optional" ]; then'

# 🔴 RETARGETED when the class check moved onto the exit STATUS. This string no
# longer decides whether a failure is NOTICED (M135/M136 own that) — what is left
# to it is the DIAGNOSIS, and a diagnosis that fires on everything is a confident
# wrong answer: it would tell the operator a stale selector for a failure that had
# nothing to do with one.
apply_mutant M131 capture.sh G17 "the stale-selector diagnosis fires on EVERY op failure — an occlusion timeout or a dead bridge is reported as a drifted selector, sending the reader to the wrong file" \
  's/^          \*"element_not_found"\*)$/          *)/' \
  '          *"element_not_found"*)'

apply_mutant M132 plan.py G16 "clickIfPresent stops marking its step optional — the only thing that separates a declared absence from a drifted selector is gone, and the verb becomes a synonym for click" \
  's/^                       optional=True)$/                       )/' \
  '                       optional=True)'

# 🔴 SCOPED TO ONE STATE, by a RANGE address anchored on a unique line. The three
# states carry byte-identical dismissal lines, so a whole-file substitution has no
# unique target and the harness would score it BROKEN — and a mutant that mutates
# all three at once is also the weaker test: this one asks whether the gate reads
# EVERY state or only the first thing it finds.
apply_mutant M133 recipes/model-benchmarking.json P18 "ONE state goes back to a REQUIRED click for the how-to dismissal — every profile that has already dismissed it then fails that state, and a gate that checks only the first state cannot see it" \
  '/"name": "matchups"/,/\]/ s/"clickIfPresent":/"click":/' \
  '      "name": "matchups",'

apply_mutant M134 recipes/model-benchmarking.json P18 "model-benchmarking stops deriving its top band — the recipe returns to the fixed chromeTop that F11 measures to be unsatisfiable" \
  's/^    "fromAppFrame": true,$/    "fromAppFrame": false,/' \
  '    "fromAppFrame": true,'

# ── capture.sh: THE OP-FAILURE CLASS (the audit finding on infra ticket #1271) ───────────
# 🔴 M136 IS THE REGRESSION THAT WAS ACTUALLY SHIPPED AND CAUGHT IN REVIEW: the
# first version of this branch matched one error STRING, so a `click` answered
# with the bridge generic `op_timeout:click` ran green and wrote its artifact.
apply_mutant M135 capture.sh G17 "the op exit status is discarded again — a one-shot step that the bridge REFUSED reads exactly like one that worked" \
  's/^    out="\$("\${argv\[@\]}" 2>&1)"; oprc=\$?$/    out="$("${argv[@]}" 2>\&1)"; oprc=0/' \
  '    out="$("${argv[@]}" 2>&1)"; oprc=$?'

apply_mutant M136 capture.sh G17 "the class narrows back to ONE error string — every other bridge failure on a one-shot step goes silent again, which is the defect this replaced" \
  's/^  if \[ -z "\$expect" \] \&\& \[ -z "\$absent" \] \&\& \[ -z "\$vfg" \] \&\& \[ "\$oprc" != 0 \]; then$/  if [ -z "$expect" ] \&\& [ -z "$absent" ] \&\& [ -z "$vfg" ] \&\& [ "$oprc" != 0 ] \&\& case "$out" in *element_not_found*) true;; *) false;; esac; then/' \
  '  if [ -z "$expect" ] && [ -z "$absent" ] && [ -z "$vfg" ] && [ "$oprc" != 0 ]; then'

apply_mutant M137 capture.sh G17 "an optional step SWALLOWS any failure, not just absence — so a renamed element-not-found error upstream silently skips the step instead of failing loudly" \
  's/^            \*element_not_found\*)$/            *)/' \
  '            *element_not_found*)'

apply_mutant M138 capture.sh G17 "the screenshot loses its exemption — a bridge-side capture failure is flattened into the generic action failure, blaming the recipe for the occlusion hang" \
  's/^      screenshot) : ;;   # the caller.s no-path check owns this one (exit 12)$/      no_such_op) : ;;/' \
  '      screenshot) : ;;   # the caller'"'"'s no-path check owns this one (exit 12)'

apply_mutant M139 capture.sh G17 "a bridge that DIES on the window raise is no longer read — only the i3 FIELD is, so the run walks into the BLOCK_INIT deadlock it exists to stop" \
  's/^    if \[ "\$oprc" != 0 \]; then$/    if false; then/' \
  '    if [ "$oprc" != 0 ]; then'

apply_mutant M140 frame.py F10 "the rect parser accepts non-ASCII digits and a lone minus again — both RAISE where the handler promises a REFUSE line, turning a bad read into a traceback" \
  's/^        if ("0" <= ch <= "9") or (ch == "-" and not num):$/        if ch.isdigit() or (ch == "-" and not num):/' \
  '        if ("0" <= ch <= "9") or (ch == "-" and not num):'

apply_mutant M141 frame.py F10f "frame-rect-js stops checking frameHost — a bare KeyError under a handler that prints REFUSE lines" \
  's/^            if not rec.get("frameHost"):$/            if False:/' \
  '            if not rec.get("frameHost"):'

# ── the DOM-scoping guard (G18) ─────────────────────────────────────────────
# 🔴 THE HAZARD THESE LOCK IS NOT "the selector finds nothing". A --frame op is
# dispatched synthetically (trusted:false — the reason the spend path rejects
# it); a TOP-FRAME click/type/key goes through CDP Input and is trusted:true. So
# every mutant below re-opens a second route to a trusted event that spells no
# `xdotool` and that guard_no_actuation therefore cannot see. Each is a
# NARROWING or a DROP, not a deletion of the whole function, because a deleted
# function is the easiest thing in the world for a suite to notice.
apply_mutant M142 plan.py G18 "the DOM-scoping loop iterates NOTHING — the guard is present, reads as covered, and inspects no step" \
  's/^    for i, st in enumerate(steps):$/    for i, st in enumerate([]):/' \
  '    for i, st in enumerate(steps):'

apply_mutant M143 plan.py G18 "the guard NARROWS to one op — click, the only one that can fire a money button, is dropped while the guard still fires on html" \
  's/^        if st\["op"\] in DOM_OPS and "--frame" not in st\["argv"\]:$/        if st["op"] in ("html",) and "--frame" not in st["argv"]:/' \
  '        if st["op"] in DOM_OPS and "--frame" not in st["argv"]:'

apply_mutant M144 plan.py G18 "the --frame test is INVERTED — correctly scoped ops are refused and unscoped ones sail through; only G18's positive controls can tell this from a working guard" \
  's/^        if st\["op"\] in DOM_OPS and "--frame" not in st\["argv"\]:$/        if st["op"] in DOM_OPS and "--frame" in st["argv"]:/' \
  '        if st["op"] in DOM_OPS and "--frame" not in st["argv"]:'

apply_mutant M145 plan.py G18 "the guard is dropped from build() — every STATE plan is unguarded while build_foreground still calls it, so the function and one call site both still exist" \
  's/^    guard_dom_scoping(steps)$/    pass/' \
  '    guard_dom_scoping(steps)'

apply_mutant M146 plan.py G18 "the guard is dropped from build_foreground() — the plan built BEFORE any frame exists, where an unscoped op is likeliest, is the one left unguarded" \
  's/^    guard_dom_scoping(p.steps)$/    pass/' \
  '    guard_dom_scoping(p.steps)'

apply_mutant M147 capture.sh D8 "the app-frame probe-build failure returns to exit 5 — sharing a code with the measure refusal, so a caller cannot tell this skill's own JS refusing from a bad crop of a real screenshot" \
  's/^        echo "     could not build the app-frame probe — see the REFUSE line."; exit 9; }$/        echo "     could not build the app-frame probe — see the REFUSE line."; exit 5; }/' \
  '        echo "     could not build the app-frame probe — see the REFUSE line."; exit 9; }'

# ── the clickable ledger (G19) ──────────────────────────────────────────────
# 🔴 THESE LOCK A LEDGER, NOT A DETECTOR. Nothing here can assert "the guard
# knows vote-btn is dangerous" — a pure planner cannot know that, which is the
# whole reason the hazard is DECLARED rather than detected. What each mutant
# re-opens is a way for a control-activating action to reach a live, logged-in
# app without anyone having written it down.
apply_mutant M148 plan.py G19 "the ledger check returns before it looks — no recipe declares anything and every click is permitted again" \
  's/^    if not used:$/    if True:/' \
  '    if not used:'

apply_mutant M149 plan.py G19 "key drops out of the ledger scope — an Enter on a focused input, which submits the form it sits in, goes undeclared again" \
  's/^CLICKING_ACTIONS = ("click", "clickIfPresent", "key")$/CLICKING_ACTIONS = ("click", "clickIfPresent")/' \
  'CLICKING_ACTIONS = ("click", "clickIfPresent", "key")'

apply_mutant M150 plan.py G19 "a MISSING ledger is read as an empty one, so the no_click_ledger clause never fires and its case is caught by the OTHER clause instead — coverage that looks present and is not" \
  's/^    ledger = r.get("clickable")$/    ledger = r.get("clickable", [])/' \
  '    ledger = r.get("clickable")'

apply_mutant M151 plan.py G19 "the SHRINK clause is dropped — a ledger may drift from the recipe it claims to describe, and a stale ledger reads as coverage" \
  's/^    if unused:$/    if False:/' \
  '    if unused:'

apply_mutant M152 plan.py G19 "the membership test is INVERTED — declared controls are refused and undeclared ones sail through; only the positive controls can tell this from a working ledger" \
  's/^        if sel not in allowed:$/        if sel in allowed:/' \
  '        if sel not in allowed:'

# ── M160.. : the FRAME-RELATIVE declared rect (infra ticket #1297) ────────────
# 🔴 EVERY MUTANT HERE IS A SILENT ONE. The form's whole purpose is that ONE
# declared rect is correct in both banner layouts; break any part of it and the
# measurement still returns a plausible box, still passes check-states (a
# declared rect is exempt), and still renders a picture. Only the pixel
# comparison in F13 can tell the difference, which is why that gate grades on
# content rather than on the two y values it could have restated.
apply_mutant M160 frame.py F13 "the ANCHOR is dropped — \`y\` is used as declared, i.e. the frame-relative form silently becomes the ABSOLUTE one it exists to replace, and is wrong by the banner's 36px in one layout" \
  's|^        y0 = frame_top + y0$|        y0 = y0 + 0|' \
  '        y0 = frame_top + y0'

# 🔴 M161: the ORDERING defect, which is the one a reviewer would not see. The
# anchor still works; only the frame check reads the DECLARED y. Every crop that
# fits stays byte-identical, so F13's pixel arm is green — it dies solely on the
# rect that must be legal in one layout and off the bottom in the other.
apply_mutant M161 frame.py F13 "the off-frame gate is evaluated against the DECLARED y instead of the RESOLVED one — a rect that runs off the bottom of the banner layout is accepted there and crops a short image" \
  's|^    if x0 + bw > limit_w or y0 + bh > limit_h:$|    if x0 + bw > limit_w or rect["y"] + bh > limit_h:|' \
  '    if x0 + bw > limit_w or y0 + bh > limit_h:'

apply_mutant M162 frame.py F13 "an unknown key in \`crop.rect\` is IGNORED again — a misspelt \`yFrom\` then leaves an absolute rect that measures plausibly and crops the wrong region in one layout, with nothing anywhere saying so" \
  's|^        if k not in known:$|        if k not in known and False:|' \
  '        if k not in known:'

apply_mutant M163 frame.py F13 "the \`yFrom\` VALUE stops being checked — any string marks the rect frame-relative, so a typo in the value is accepted rather than named" \
  's|^    if "yFrom" in rect and rect\["yFrom"\] != RECT_Y_APP_FRAME:$|    if "yFrom" in rect and rect["yFrom"] != rect["yFrom"]:|' \
  '    if "yFrom" in rect and rect["yFrom"] != RECT_Y_APP_FRAME:'

apply_mutant M164 frame.py F13 "a NEGATIVE app-frame top (a scrolled page) is resolved instead of refused — the crop walks off the top of the capture while every other check still passes" \
  's|^        if frame_top < 0:$|        if frame_top < -1000:|' \
  '        if frame_top < 0:'

apply_mutant M165 frame.py F13 "the resolution stops being REPORTED — \`box.y\` is the one number a declared rect does not state, so without this an operator cannot tell a working anchor from a rect that happened to land plausibly" \
  's|^        out\["resolved"\] = res$|        out["_resolved"] = res|' \
  '        out["resolved"] = res'

apply_mutant M166 frame.py F13b "the seam stops refusing a frame-relative rect in a recipe with NO fromAppFrame — nothing runs the probe, so the rect is read as ABSOLUTE and is wrong by the banner's 36px, silently" \
  's|^    if relative and not wants:$|    if False and relative and not wants:|' \
  '    if relative and not wants:'

# 🔴 M167 is about a TRACEBACK, not a wrong crop: declared_box is a module entry
# point and `app_frame[0]` on None is an exception where every other failure in
# this file is a REFUSE line. It is the defensive half of the seam.
apply_mutant M167 frame.py F13 "declared_box stops refusing a frame-relative rect handed NO app-frame rect — the resolution then dies on a traceback instead of the sentence this module promises" \
  's|^        if app_frame is None:$|        if app_frame is None and False:|' \
  '        if app_frame is None:'

# 🔴 M168: the ADVICE, not the arithmetic. The full_frame message is what sends
# the next author to a crop form, and it sent two of them into a second refusal
# for a month (infra ticket #1297). A message can lose the form that actually
# works while every arithmetic gate stays green.
# 🔴 THE SUBSTITUTION KEEPS THE `%r`. Dropping it was tried first: the args tuple
# then has one element too many, `%` raises, and EVERY full_frame gate goes red
# (6 FAIL) — an emphatic kill that measures the crash and not the message.
# Validation 4's shape, arrived at through a runtime error rather than a syntax
# one, which is why py_compile does not catch it. With the specifier kept, F4b is
# the only gate that moves.
apply_mutant M168 frame.py F4b "the full_frame refusal loses the FRAME-RELATIVE route — it names only the absolute rect, which on a rewards-banner page is wrong in one layout by construction, so the reader is sent back into the refusal the message is answering" \
  's|"the rect a yFrom of %r: `y` is then measured DOWN FROM THE IFRAME.S TOP "|"there is nothing further to try (%r). NOT measured from the "|' \
  '"the rect a yFrom of %r: `y` is then measured DOWN FROM THE IFRAME'"'"'S TOP "'

# 🔴 M170/M171 pin the two guards an ADVERSARIAL AUDIT found unpinned on the first
# round of this PR — both SURVIVED the 141-gate suite as written. Neither is a
# deletion: one narrows a condition, the other drops a term from a bound, and both
# leave every other gate green.
apply_mutant M170 frame.py F13 "the viewport/DPR cross-check is skipped for a DECLARED rect — resolve_bands' own docstring calls it the only check on a devicePixelRatio this code cannot see, and a rect anchored to an edge measured in half-scale units resolves to a plausible wrong box with no complaint" \
  's|^    if rect:$|    if rect and not declared:|' \
  '    if rect:'

apply_mutant M171 frame.py F13 "the lower edge of the IFRAME stops bounding the rect — only the PNG does, so a rect anchored to the iframe top can run past the app and put the page footer below it into the asset" \
  's|^        limit_h = h - max(0, app_frame\[1\])$|        limit_h = h - 0 * max(0, app_frame[1])|' \
  '        limit_h = h - max(0, app_frame[1])'

# 🔴 M173 is the OTHER term of the same expression, and it was unpinned until a
# delta re-audit measured it: the acceptance arm for a negative bottom gap uses a
# rect that fits with or WITHOUT the clamp, so it is an invariant guard. Deleting
# the clamp lets a degenerate probe reading push the bound PAST the frame.
apply_mutant M173 frame.py F13 "the max(0, ...) clamp on the bottom gap is dropped — a NEGATIVE gap (an iframe taller than the viewport) then WIDENS the bound past the capture, so a crop ending 49px off the bottom of the photograph is accepted" \
  's|^        limit_h = h - max(0, app_frame\[1\])$|        limit_h = h - app_frame[1]|' \
  '        limit_h = h - max(0, app_frame[1])'

apply_mutant M172 capture.sh F13d "the app-frame rect is dropped from the RENDER call and kept on MEASURE — a frame-relative recipe then measures against the iframe and renders against nothing, the exact measure/render drift resolve_bands claims to prevent" \
  's|^      \${USE_APPFRAME:+--app-frame-rect "\$OUT/\$st.rect.json"} --exec >/dev/null \\$|      --exec >/dev/null \\|' \
  '      ${USE_APPFRAME:+--app-frame-rect "$OUT/$st.rect.json"} --exec >/dev/null \'

# 🔴 M174 is the mutant that separates P18's TWO arms, and it is why the second
# one exists. h=560 overruns the LIVE iframe (141+507+560 = 1208 > 1191) but fits
# the 1709x1314 FIXTURE the other arm measures against (1250), so the fixture arm
# passes it and only the recorded-geometry arm can see it. Without this the second
# arm is decoration.
# 🔴 M175 grows the recorded viewport to the FIXTURE's height. That single edit
# is what two audit rounds used as half of a walk-the-gate move (the other half
# being M174's rect growth), and the battery cannot combine them — each mutant
# starts from pristine sources — so M175 pins the half that is pinnable, and the
# whole combined move is closed structurally instead: P18 refuses a recorded
# viewport equal to the fixture's, because that claim removes the reason the
# second record exists at all. M175 dies on that refusal.
apply_mutant M175 recipes/app-requests.json P18 "the recorded viewport is grown to the FIXTURE's height so the geometry arm agrees with an overrun rect — the exact fixture-vs-live confusion the arm exists to catch, re-entered by editing the witness instead of the rect" \
  's|"viewport": \[1709, 1255\], "appFrameTop": 141, "appFrameBottomGap": 64|"viewport": [1709, 1314], "appFrameTop": 141, "appFrameBottomGap": 64|' \
  '"viewport": [1709, 1255], "appFrameTop": 141, "appFrameBottomGap": 64'

# 🔴 M176 WAS RETIRED, and the reason is worth keeping. It applied the full
# three-number walk (rect + recorded viewport + prose) and died on the premise
# refusal — but only because the walk used the fixture's EXACT dimensions. A
# round-5 audit showed the same walk with any other viewport >= 1272 passes this
# suite, so the mutant was pinning a spelling, not a class. Two further problems:
# its sed carried three substitutions while `apply_mutant`'s uniqueness check
# inspects only the ONE literal passed as its target, so a JSON reformat could
# silently no-op two of them and leave a mutant that still scored KILLED for
# M174's reason; and the harm it described is not reachable — the walked recipe
# REFUSES on its next live run (measured), because declared_box bounds the rect
# by the probe's reported edge. That live bound is the real property and it is
# pinned by F13 section 5b, M171 and M173. What survives here is the drift half:
# M174 (rect moves alone), M175 (record moves to the fixture's numbers) and M177
# (record drifts anywhere else).

# 🔴 M181 pins `isinstance(geo, dict)`, which the ledger had listed as
# UNPINNABLE-without-a-fixture — a claim a round-8 audit refuted with one `sed` on
# a shipped recipe, i.e. exactly the technique M180 had just used in the same
# commit. "Unreachable" is a much stronger claim than "unpinned" and it is the one
# that stops anyone trying; this mutant is the correction. Verified both ways:
# KILLED here, and SURVIVES when only that branch's report is neutered.
apply_mutant M181 recipes/app-requests.json P18 "the recorded geometry becomes a STRING that happens to contain all three key names — \`k not in geo\` on a str is SUBSTRING containment, so the required-keys walk finds nothing missing and sails through, and the code below dies on .get() with a traceback naming no recipe; the object check has to run first" \
  's|"_measuredGeometry": { "viewport": \[1709, 1255\], "appFrameTop": 141, "appFrameBottomGap": 64,|"_measuredGeometry": "viewport 1709x1255, appFrameTop 141, appFrameBottomGap 64", "_wasGeometry": {|' \
  '"_measuredGeometry": { "viewport": [1709, 1255], "appFrameTop": 141, "appFrameBottomGap": 64,'

# 🔴 M180 pins the required-keys branch, which a round-7 audit demonstrated was
# reachable and cheaply pinnable while the ledger listed only two guards as
# unpinned. One substitution, one FAIL, and it carries that branch's own message
# ("_measuredGeometry is missing appFrameTop") rather than a neighbour's — so the
# `continue` chain really does stop there and the diagnosis really is the one the
# branch computes.
apply_mutant M180 recipes/app-requests.json P18 "the recorded geometry loses appFrameTop — the arm that checks the rect against the live reading then has no anchor to check it against, and must say WHICH key is gone rather than fall through to a neighbouring complaint" \
  's|"appFrameTop": 141, "appFrameBottomGap": 64|"appFrameBottomGap": 64|' \
  '"appFrameTop": 141, "appFrameBottomGap": 64'

# 🔴 M182 pins sensei's OWN rect against its OWN recorded geometry — the check that
# would have caught the twelve-day-old defect that converted it. Reverting `y` to
# the historical 97 (now a frame-RELATIVE offset) resolves to 141+97=238 and ends at
# 1220, past the iframe's lower edge at 1255-64=1191, so the live-geometry arm
# refuses it. Nothing catches "the crop is on the wrong CONTENT" — that stays a
# by-eye judgement — but a rect that no longer fits the app it was measured on is
# now a gate, for this recipe and not only for app-requests.
apply_mutant M182 recipes/sensei.json P18 "sensei's y reverts to its historical 97 — as a frame-relative offset that lands 97px INTO the app instead of above it, and runs off the iframe's lower edge" \
  's|"y": 64, "w": 1694, "h": 982|"y": 97, "w": 1694, "h": 982|' \
  '"y": 64, "w": 1694, "h": 982'

# 🔴 M179 RESTORES ATTRIBUTABLE COVERAGE OF THE PREMISE REFUSAL, which retiring
# M176 removed and this file wrongly implied M175 still provided. Measured by a
# round-6 audit: neuter ONLY `if list(vp) == list(FIX_WH)` and M174/M175/M177/
# M178/M169 all still die — to the rect bound, the prose check, the prose check,
# the exactly-once rule and the ledger respectively — so the branch could have
# been deleted with a fully green battery.
#
# This mutant leaves the rect ALONE at h=524 and moves BOTH records to the
# fixture's height, so the prose agrees and the rect still fits: the premise
# branch is then the only thing that can fire. Delete that branch and M179
# SURVIVES, which is what makes it attributable rather than merely fatal.
#
# 🔴 It carries two substitutions, and apply_mutant validates only the ONE
# literal it is given (the M176 hazard). Here that degradation is BENIGN and it
# is worth saying why: if the prose sub silently no-ops, what is left is exactly
# M175 — which still dies on this same premise branch, because the premise check
# runs before the prose check. A partial application can therefore overstate
# ATTRIBUTION, never manufacture a pass.
apply_mutant M179 recipes/app-requests.json P18 "both records move to the fixture's height while the rect stays put — every other arm is satisfied (prose agrees, rect fits), so only the premise refusal can catch it" \
  's|"viewport": \[1709, 1255\]|"viewport": [1709, 1314]|; s|viewport 1709x1255|viewport 1709x1314|' \
  '"viewport": [1709, 1255]'

# 🔴 M177 keeps the PROSE cross-check killable. M175 used to die on it and now
# dies on the premise refusal instead (which runs first), so without this the
# cross-check would have no mutant of its own. 1280 is neither the live 1255 nor
# the fixture's 1314: it clears the premise check and leaves the rect fitting
# (1280-64 = 1216 > 1172), so the disagreement with the prose is the only thing
# that can fire. 🔴 It is a DRIFT mutant — an inconsistent edit — which is the
# only thing this arm claims to catch; a CONSISTENT edit is not catchable here
# and is not meant to be (see the scope note in run-tests-app-capture.sh).
apply_mutant M177 recipes/app-requests.json P18 "the recorded viewport drifts to a value that is neither the live one nor the fixture's — it clears the premise check and the rect still fits, so only the disagreement with the recipe's own prose can catch it" \
  's|"viewport": \[1709, 1255\], "appFrameTop": 141, "appFrameBottomGap": 64|"viewport": [1709, 1280], "appFrameTop": 141, "appFrameBottomGap": 64|' \
  '"viewport": [1709, 1255], "appFrameTop": 141, "appFrameBottomGap": 64'

# 🔴 M178 pins the EXACTLY-ONCE rule, which shipped one round without a mutant.
# It is not pedantry: `re.findall`'s first hit is the one read, and both
# `_measured` strings are accretive 1000+ char narratives — so APPENDING a
# re-shoot (the natural way to record one) leaves the stale block winning and the
# gate silently grading the old geometry. The mutant appends a second, different
# reading exactly as an author would.
apply_mutant M178 recipes/app-requests.json P18 "a re-shoot is APPENDED to the measurement prose instead of replacing it — a second \`viewport WxH\` / \`top=\` / \`gap=\` triple, so the stale one is still what the gate reads and the new measurement is silently ignored" \
  's|1052x682 is aspect 1.543|RE-SHOT 2026-09-03: viewport 1709x1200, app-frame top=150, bottom gap=70. 1052x682 is aspect 1.543|' \
  '1052x682 is aspect 1.543'

# 🔴 RE-DERIVED 2026-09-02, TWICE OVER, and both reasons are worth keeping. (a) The
# recipe was re-measured that day (the rect went 446/507/804/524 -> 329/27/1052/682)
# and this literal was not updated with it, so the mutant had silently gone BROKEN —
# a battery whose target no longer exists reports nothing and reads as coverage.
# (b) Its old rationale ("still inside the taller test fixture, so the fixture arm
# alone reports nothing") DIED the same day: P18's frame.py arm now runs on a canvas
# built at the RECORDED viewport, so both arms bound the rect by 1255 - 64 = 1191.
# The number: 141 + 27 + h > 1191 needs h > 1023, so 1030 overruns the app's own
# lower edge by 7 rows and would photograph page furniture below it.
apply_mutant M174 recipes/app-requests.json P18 "the declared height is grown from 682 to 1030 — past the live iframe's lower edge at 1191, so the crop would run off the bottom of the app and photograph the page furniture below it" \
  's|"w": 1052, "h": 682, "yFrom"|"w": 1052, "h": 1030, "yFrom"|' \
  '"w": 1052, "h": 682, "yFrom"'

apply_mutant M169 recipes/app-requests.json P18 "app-requests' declared rect loses its \`yFrom\` marker — it becomes an ABSOLUTE rect alongside fromAppFrame, which refuses at capture time, and the ledger is the only thing that says so before a live run" \
  's|"h": 682, "yFrom": "appFrame" }|"h": 682 }|' \
  '"h": 682, "yFrom": "appFrame" }'

# ── THE VIEWPORT OF RECORD (2026-09-02) ────────────────────────────────────
# The gate that would have caught the incident: a declared rect is ABSOLUTE, so
# it is only meaningful on the canvas it was measured on, and nothing compared
# the two. Each clause gets its OWN mutant and its OWN expected gate, because the
# neighbouring check (`app_frame_scale`) is deliberately blind here — C5 asserts
# that directly — so a mutant dying to it would be recorded coverage that does
# not exist.

# M185 — the tolerance. 2000 is chosen to swallow the incident's real 1722px
# width delta, so this is not "a bigger number" but "a number that reproduces the
# defect". C5's ±3 boundary arms fail too, which is the point of watching a
# boundary rather than a single value.
apply_mutant M185 frame.py C5 "the viewport-of-record tolerance widens from 2px to 2000px — enough to swallow the incident's own 1722px width delta, so a rect measured at 1709 is applied to a 3431 capture again" \
  's|^VIEWPORT_RECORD_SLACK = 2$|VIEWPORT_RECORD_SLACK = 2000|' \
  'VIEWPORT_RECORD_SLACK = 2'

# M186/M187 — ONE AXIS EACH. The incident moved BOTH axes (1722 and 31), so a
# mutant that drops one axis still refuses the incident itself; what catches it is
# C5's per-axis ±3 arm. That is exactly why the tolerance is watched on each axis
# separately instead of on one composite case.
apply_mutant M186 frame.py C5 "the viewport-of-record check stops comparing HEIGHT — a window that is the same width and a different height then crops short, silently, which is the failure direction the iframe-bottom bound cannot see" \
  's|    if abs(vw - png_w) > VIEWPORT_RECORD_SLACK or abs(vh - png_h) > VIEWPORT_RECORD_SLACK:|    if abs(vw - png_w) > VIEWPORT_RECORD_SLACK:|' \
  '    if abs(vw - png_w) > VIEWPORT_RECORD_SLACK or abs(vh - png_h) > VIEWPORT_RECORD_SLACK:'

apply_mutant M187 frame.py C5 "the viewport-of-record check stops comparing WIDTH — the one axis with no live anchor at all, and the axis the incident's asset was actually wrong on" \
  's|    if abs(vw - png_w) > VIEWPORT_RECORD_SLACK or abs(vh - png_h) > VIEWPORT_RECORD_SLACK:|    if abs(vh - png_h) > VIEWPORT_RECORD_SLACK:|' \
  '    if abs(vw - png_w) > VIEWPORT_RECORD_SLACK or abs(vh - png_h) > VIEWPORT_RECORD_SLACK:'

# M188 — THE FAIL-OPEN SHAPE, spelled as the edit someone would actually make: a
# missing record defaults to "the usual viewport" instead of refusing. The early
# return isolates that branch; the refusal below it is left in place, so the
# mutation is the guard and not the guard plus its scaffolding.
apply_mutant M188 frame.py C6 "a declared rect with NO recorded viewport falls back to a hardcoded default instead of refusing — the fail-open shape, and the one that makes this whole gate opt-in" \
  's|^    if rec is None:$|    if rec is None:\n        return (1709, 1314)|' \
  '    if rec is None:'

# M189 — the conflict seam, mutated to the PLAUSIBLE wrong edit rather than to a
# deletion: refuse only when the two records disagree. It reads like leniency and
# it reintroduces the ambiguity the refusal exists to remove, because "they agree
# today" says nothing about which measurement session the rect belongs to. C7
# feeds MATCHING values precisely so this cannot hide behind the tolerance check.
apply_mutant M189 frame.py C7 "the two-records-of-one-fact refusal fires only when the recipe record and --measured-viewport DISAGREE, so a matching pair is silently accepted and the caller's flag decides" \
  's|    if rec is not None and cli is not None:|    if rec is not None and cli is not None and list(rec) != list(parse_measured_viewport(cli)):|' \
  '    if rec is not None and cli is not None:' 

# M190 — the OTHER direction of the same seam: a --measured-viewport on a run that
# detects its crop. Made unreachable rather than deleted (`declared` is falsy in
# that branch by construction), which is how a "tightening" edit would spell it.
apply_mutant M190 frame.py C7 "a --measured-viewport supplied to a run that DETECTS its crop is silently ignored instead of refused — the reachable case is a --crop-rect that never arrived, and the run then crops something nobody asked for" \
  's|^    if cli_vp is not None:$|    if cli_vp is not None and declared:|' \
  '    if cli_vp is not None:'

# M191 — the REQUIRED POSITIONAL. A keyword default is a way to call declared_box
# with no record at all, i.e. a bypass that no CLI test can see. F13 section 8 is
# the only thing that looks at the signature.
apply_mutant M191 frame.py F13 "declared_box's measured_viewport gains a default of None — the operand the gate needs becomes optional, so any caller that forgets it crops unchecked" \
  's|def declared_box(path, rect, chrome_top, footer, right, app_frame, measured_viewport):|def declared_box(path, rect, chrome_top, footer, right, app_frame=None, measured_viewport=None):|' \
  'def declared_box(path, rect, chrome_top, footer, right, app_frame, measured_viewport):'

# M192/M193 — the capture.sh half. One failure, one exit code: a wrong window and
# a wrong rect ask for different operator actions, so they must be distinguishable
# by STATUS. M192 collapses the codes (D8's business); M193 breaks the token the
# branch matches on, which is invisible to a static read of the file and shows up
# only when the run is actually driven.
apply_mutant M192 capture.sh D8 "the viewport refusal collapses back onto exit 5 — a wrong WINDOW then reports as a bad CROP, sending the operator to re-measure a rect that is correct" \
  's|^        exit 14$|        exit 5|' \
  '        exit 14'

apply_mutant M193 capture.sh G20 "the refusal token capture.sh matches on is misspelt, so the viewport branch never fires and the run falls through to the generic crop refusal — a static read of the file still shows exit 14 present" \
  "s|REFUSE\\[viewport_of_record\\]|REFUSE[viewport_of_recrod]|" \
  'REFUSE[viewport_of_record]'

# ===========================================================================
# M194-M206 — THE HORIZONTAL FRAME ANCHOR (`xFrom` / `wFrom`), 2026-09-02.
#
# 🔴 SCOPED SWEEP ONLY. These were measured with
# `MUTANTS_ONLY="M194 … M206" ./tests/mutants-app-capture.sh`, not by a full
# battery — every mutant runs the whole 4-minute suite, so the full sweep is
# hours. What that costs is stated rather than hidden: it proves each NEW guard
# is load-bearing and dies on F14/F10/F12; it says nothing about whether the new
# code broke an OLD mutant's target, which is checked separately by re-running
# the pristine suite (green) and by the BROKEN accounting the harness prints for
# every mutant whose `sed` target has stopped matching. That accounting is the
# reason M169/M174/M178 were caught silently BROKEN earlier the same day.
# ===========================================================================

# M194 — the anchor made inert. It reads as a tidy-up ("x0 is already x0") and it
# turns the whole form back into the absolute rect it replaces. F14's pixel arm
# is what sees it: the box is right at 1709 and wrong at 2509.
apply_mutant M194 frame.py F14 "the LEFT-edge resolution is dropped — an xFrom rect silently becomes ABSOLUTE again, correct at the window it was measured in and wrong at every other one, which is the entire defect this form exists to remove" \
  's|^        x0 = frame_left + x0$|        x0 = x0|' \
  '        x0 = frame_left + x0'

# M195 — THE FAIL-OPEN SHAPE, spelled as the edit someone would actually make. A
# five-field probe answer has no left inset; `or 0` reads that as "the frame
# starts at column 0", which is also a REAL reading for a full-bleed iframe. The
# two are indistinguishable afterwards, which is why the refusal exists.
apply_mutant M195 frame.py F14 "a probe answer with NO left inset is read as left=0 instead of refusing — 'nobody told me where the frame starts' becomes 'the frame starts at column 0', which is a real reading for a full-bleed iframe and therefore undetectable downstream" \
  's|^        frame_left = app_frame\[5\]$|        frame_left = app_frame[5] or 0|' \
  '        frame_left = app_frame[5]'

# M196 — the half-specified form allowed through. Neutered rather than inverted:
# inverting it would refuse every legal rect and die everywhere, which measures
# the suite's breadth rather than this branch.
apply_mutant M196 frame.py F14 "wFrom without xFrom stops refusing — the right edge would track the app frame while the left edge stayed an absolute column, so the width silently absorbs the drift it looks like it removed" \
  's|^    if "wFrom" in rect and "xFrom" not in rect:$|    if False and "wFrom" in rect and "xFrom" not in rect:|' \
  '    if "wFrom" in rect and "xFrom" not in rect:'

# M197 — the two marker VALUES collapse onto one token. This is the copy-paste
# hazard the distinct value exists to make loud, committed on purpose.
apply_mutant M197 frame.py F14 "wFrom accepts the same \`appFrame\` token as xFrom/yFrom — so a value copied across from a neighbouring key is silently read as 'w is a gap', which produces a plausible box of the wrong width" \
  's|^RECT_W_APP_FRAME_RIGHT = "appFrameRight"$|RECT_W_APP_FRAME_RIGHT = "appFrame"|' \
  'RECT_W_APP_FRAME_RIGHT = "appFrameRight"'

# M198 — the arithmetic, one term short. The resolved width stops depending on the
# LEFT inset, so it is right only when that inset is zero — which it is on every
# capture in this repo's corpus, and is not on the window the incident happened in.
apply_mutant M198 frame.py F14 "the resolved width forgets the left inset — correct on a full-bleed frame and wrong by exactly the left margin on a centred one, i.e. right on every fixture and wrong on the real case" \
  's|^        bw = frame_right - rect\["w"\] - x0$|        bw = frame_right - rect["w"]|' \
  '        bw = frame_right - rect["w"] - x0'

# M199/M200 — the two terms of the horizontal bound, one each. M199 removes the
# app frame's right edge (the PNG becomes the only limit again, which is the
# incident's own looseness); M200 removes the PNG clamp, so a NEGATIVE right gap
# widens the bound PAST the photograph. This is the exact pairing M171/M173 are
# for the vertical axis.
apply_mutant M199 frame.py F14 "the IFRAME's right edge stops bounding an x-anchored rect — only the PNG does, so a crop can run out of the app into the host page, and a WIDER window makes that check looser rather than tighter" \
  's|^        limit_w = min(w, frame_right)$|        limit_w = w|' \
  '        limit_w = min(w, frame_right)'

apply_mutant M200 frame.py F14 "the min() with the PNG is dropped from the horizontal bound — a NEGATIVE right gap (an iframe wider than the viewport) then pushes the limit PAST the capture and a crop running off the right of the photograph is accepted" \
  's|^        limit_w = min(w, frame_right)$|        limit_w = frame_right|' \
  '        limit_w = min(w, frame_right)'

# M201 — the re-based gate's tolerance. 2000 swallows every frame-width change
# this fixture can produce, so it is "a number that reproduces the defect" rather
# than merely a bigger one. F14 watches the boundary at ±2/±3.
apply_mutant M201 frame.py F14 "the frame-of-record tolerance widens to 2000px — a rect anchored on both horizontal edges is then applied to a frame of any width, so a reflowed layout is cropped as if it were the one the rect was measured against" \
  's|^        if abs(live_fw - rec_fw) > VIEWPORT_RECORD_SLACK:$|        if abs(live_fw - rec_fw) > 2000:|' \
  '        if abs(live_fw - rec_fw) > VIEWPORT_RECORD_SLACK:'

# M202 — the HEIGHT half of the re-based gate, compared with ITSELF. The plausible
# wrong edit: having re-based the width axis onto the frame, drop the other one as
# "already covered". It is not — `h` is absolute in every form and the live iframe
# bound is one-sided, so a taller window ends the crop early and silently.
apply_mutant M202 frame.py F14 "the re-based gate compares the recorded height with itself instead of with the capture — a fully anchored rect then accepts any window height, and ending EARLY is not something the iframe bound can see" \
  's|^        if abs(recorded\[1\] - png_h) > VIEWPORT_RECORD_SLACK:$|        if abs(recorded[1] - recorded[1]) > VIEWPORT_RECORD_SLACK:|' \
  '        if abs(recorded[1] - png_h) > VIEWPORT_RECORD_SLACK:'

# M203 — the missing record fails OPEN via an early return, the same shape M188
# pins for the viewport half. The refusal below it is left in place, so the
# mutation is the guard and not the guard plus its scaffolding.
apply_mutant M203 frame.py F14 "a fully anchored rect whose recipe records no appFrameW skips the frame check instead of refusing — the absence becomes 'nothing to compare', which is how this axis came to be unguarded in the first place" \
  's|^        if len(recorded) < 3:$|        if len(recorded) < 3:\n            return recorded|' \
  '        if len(recorded) < 3:'

# M204 — the parser's accepted window. Five-or-six is a deliberate range (the old
# probe and the new one); widening it further means accepting an answer this
# module did not write, in a shape nothing downstream knows how to index.
apply_mutant M204 frame.py F10 "the probe parser tolerates a SEVEN-number answer — an envelope this module never emits is read as valid and its extra field is silently discarded" \
  's|^    if len(out) not in (5, 6):$|    if len(out) not in (5, 6, 7):|' \
  '    if len(out) not in (5, 6):'

# M205 — the sixth field's rounding. The left inset is a NEAR edge, so rounding it
# DOWN puts the crop's first column in the host page — the horizontal twin of
# M126, which pins the same error on the top gap.
apply_mutant M205 frame.py F12 "the probe rounds the LEFT inset DOWN — half a pixel then places an x-anchored crop's first column outside the app frame, in the host page" \
  "s|+Math.ceil(r.left\\*p)})()'|+Math.floor(r.left*p)})()'|" \
  "+Math.ceil(r.left*p)})()'"

# M206 — the report claims a resolution that did not happen. Not cosmetic: the
# `resolved` block is the ONLY place an operator can see which anchors fired, so a
# report that always names the horizontal one asserts coverage that is not there —
# and on a yFrom-only rect it names an appFrameLeft of None.
apply_mutant M206 frame.py F14 "the measurement reports a horizontal resolution unconditionally — a yFrom-only rect then claims an anchor it does not have, which is the one thing this report exists to let a reader distinguish" \
  's|^        if anch.x:                    # report the LEFT-edge anchor only when it fired$|        if True:|' \
  '        if anch.x:                    # report the LEFT-edge anchor only when it fired'

# M207 — the P18 TRIPWIRE for the horizontal anchor. Not a mutation of logic but
# of the CORPUS: convert a shipped recipe to the form P18 has not been taught, and
# require P18 to say so rather than fall through to arithmetic that is wrong about
# it. Without this the tripwire is a comment.
apply_mutant M207 recipes/app-requests.json P18 "a shipped recipe adopts the HORIZONTAL frame anchor while P18's ledger arm still reads \`w\` as a width and synthesises a five-number probe with no left inset — the gate must name that, not report the rect as bad" \
  's|"yFrom": "appFrame" },|"yFrom": "appFrame", "xFrom": "appFrame" },|' \
  '"yFrom": "appFrame" },'

# M208 — the SECOND token capture.sh's exit-14 branch matches on, mutated exactly
# the way M193 mutates the first. Both are SPELLED guards: a static read of the
# file still shows `exit 14` present and D8 still passes, so only a driven run can
# see the branch stop firing. Without G21 this half was untested.
apply_mutant M208 capture.sh G21 "the frame-of-record token capture.sh matches on is misspelt, so a wrong APP FRAME falls through to the generic crop refusal and reports as exit 5 — sending the operator to re-measure a rect that is correct" \
  "s|REFUSE\\[frame_of_record\\]|REFUSE[frame_of_recrod]|" \
  'REFUSE[frame_of_record]'

echo
if [ -n "$MUTANTS_ONLY" ]; then
  echo "🔴 PARTIAL RUN — MUTANTS_ONLY='${MUTANTS_ONLY}' ran ${#MATCHED[@]} mutant(s) and SKIPPED ${SKIPPED}."
  echo "   This is NOT a verdict on the suite. Clear MUTANTS_ONLY for the real sweep."
  if [ "${#MATCHED[@]}" -ne "${#REQUESTED[@]}" ]; then
    echo "🔴 a name in MUTANTS_ONLY matched no mutant (asked for ${#REQUESTED[@]}, ran ${#MATCHED[@]}):"
    echo "   asked: ${REQUESTED[*]}"
    echo "   ran  : ${MATCHED[*]:-(none)}"
    exit 1
  fi
fi
echo "=== battery: ${KILLED} killed, ${SURVIVED} survivor(s), ${MISATTRIB} misattributed, ${BROKEN} broken ==="
if [ "$BROKEN" -ne 0 ]; then
  echo "🔴 a BROKEN mutant means the battery could not measure that case — treat as a failure."
fi
if [ "$MISATTRIB" -ne 0 ]; then
  echo "🔴 a MISATTRIBUTED mutant died to a gate other than the one that claims to cover it."
  echo "   The coverage exists somewhere, but not where the suite's labels say — fix the"
  echo "   expected gate or add the case that should have caught it."
fi
if [ "$SURVIVED" -ne 0 ]; then
  printf '🔴 survivors:\n'
  printf '   - %s\n' "${SURVIVORS[@]}"
fi
[ "$SURVIVED" -eq 0 ] && [ "$BROKEN" -eq 0 ] && [ "$MISATTRIB" -eq 0 ]
