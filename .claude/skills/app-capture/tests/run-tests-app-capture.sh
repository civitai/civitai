#!/usr/bin/env bash
# ============================================================================
# run-tests-app-capture.sh — gate harness for .claude/skills/app-capture.
#
# OFFLINE. No cluster, no kubectl, no network, no browser, no imagemagick, no
# pip. That is possible only because every decision the runner makes lives in
# the two PURE scripts (plan.py, frame.py) and the impure halves (capture.sh,
# attach.sh) merely execute what those print.
#
# Four groups:
#   A  the tools + data files themselves parse
#   P  plan.py  — the browser-bridge planner and its seven guards
#   F  frame.py — the cropper, measured against REAL captures
#   B  frame.py — the store-bounds gate, from its single source of truth
#   R  frame.py — the render argv
#   D  the skill doc + attach.sh's refusal to mutate without --confirm
#
# 🔴 EVERY NEGATIVE CONTROL HERE HAS A PAIRED POSITIVE CONTROL. A refusal gate
# that also refuses the good case is a gate wired to `exit 2`, and it looks
# identical in the output. Where you see an N-gate, the P-gate beside it is what
# makes its zero meaningful.
#
# Point the suite at a different copy of the scripts (the mutation battery does):
#   APP_CAPTURE_SCRIPTS=/tmp/mutant ./tests/run-tests-app-capture.sh
#
# Run:  ./tests/run-tests-app-capture.sh    (exit 0 = all gates pass)
# ============================================================================
set -uo pipefail

# 🔴 COLOCATED LAYOUT. This suite used to live at <repo>/tests/ and reach UP into
# .claude/skills/app-capture. It now sits INSIDE the skill it tests, so the anchor
# is the skill dir, not the repo root — a skill that carries its own tests can be
# moved between repos without every path in here going stale, which is exactly
# what the migration into this repo proved (the old form named nine
# `tests/...` paths that only resolved in one repo).
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SKILL_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SKILL_DIR}/../../.." && pwd)"
SCRIPTS="${APP_CAPTURE_SCRIPTS:-${SKILL_DIR}/scripts}"
PLAN="${SCRIPTS}/plan.py"
FRAME="${SCRIPTS}/frame.py"
EVID="${SCRIPTS}/evidence.py"
EVFIX="${SCRIPT_DIR}/fixtures/evidence"
FAKEBB="${SCRIPT_DIR}/fixtures/fake-bridge.sh"
BOUNDS="${SCRIPTS}/store-bounds.json"
RECIPES="${SCRIPTS}/recipes"
SKILL="${SKILL_DIR}/SKILL.md"
FIX="${SCRIPT_DIR}/fixtures"
MKPNG="${FIX}/mkpng.py"
# 🔴 THESE FOLLOW $SCRIPTS, NOT THE REPO PATH. They used to be pinned to the
# repo copy, which meant the mutation battery — whose whole mechanism is to
# point APP_CAPTURE_SCRIPTS at a mutated COPY — could never mutate the two shell
# halves at all. Every gate that reads them (D7, and now the E12 end-to-end run)
# was silently grading the pristine file while reporting on the mutant.
CAPTURE_SH="${SCRIPTS}/capture.sh"
ATTACH_SH="${SCRIPTS}/attach.sh"

FAILS=0
pass() { printf '  PASS: %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf '  FAIL: %s\n' "$1"; }

WORK="$(mktemp -d -t app-capture-tests-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "=== app-capture test harness ==="
echo "    scripts : $SCRIPTS"
echo "    fixtures: $FIX"
echo

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
# run_capture <outfile> -- cmd...   ; echoes exit code
run_capture() {
  local out="$1"; shift; [ "$1" = "--" ] && shift
  "$@" >"$out" 2>"${out}.err"
  echo $?
}

# expect_refuse <label> <expected-code> -- cmd...
expect_refuse() {
  local label="$1" code="$2"; shift 2; [ "$1" = "--" ] && shift
  local o="${WORK}/r.$$" rc
  rc="$(run_capture "$o" -- "$@")"
  if [ "$rc" != "2" ]; then
    fail "$label — expected exit 2 (REFUSE), got $rc"
    head -3 "${o}.err" | sed 's/^/          /'
    return
  fi
  if ! grep -q "REFUSE\[${code}\]" "${o}.err"; then
    fail "$label — refused, but not with REFUSE[${code}]:"
    head -3 "${o}.err" | sed 's/^/          /'
    return
  fi
  pass "$label — REFUSE[${code}]"
}

# expect_ok <label> -- cmd...
expect_ok() {
  local label="$1"; shift; [ "$1" = "--" ] && shift
  local o="${WORK}/o.$$" rc
  rc="$(run_capture "$o" -- "$@")"
  if [ "$rc" = "0" ]; then pass "$label"; else
    fail "$label — expected exit 0, got $rc"
    head -3 "${o}.err" | sed 's/^/          /'
  fi
}

mkobs() {  # mkobs <file> <topText> <frames-json>
  python3 -c 'import json,sys; open(sys.argv[1],"w").write(json.dumps({
    "instance":"work","tabId":8123,"topText":sys.argv[2],"frames":json.loads(sys.argv[3])}))' "$@"
}

FRAMES_OK='[{"frameId":830,"url":"https://custom-generators.civit.ai/embed?v=1"},
            {"frameId":1,"url":"https://civitai.com/apps/run/custom-generators"}]'
TEXT_OK='Custom Generators Discover Mine Buzz 12,345 zach'

mkobs "${WORK}/obs-ok.json"        "$TEXT_OK" "$FRAMES_OK"
mkobs "${WORK}/obs-404.json"       'Civitai 404 This page could not be found.' "$FRAMES_OK"
mkobs "${WORK}/obs-loggedout.json" 'Civitai Models Images Sign In Sign Up'     "$FRAMES_OK"
mkobs "${WORK}/obs-noframe.json"   'Starting Custom Generators...' \
      '[{"frameId":1,"url":"https://civitai.com/apps/run/custom-generators"}]'
mkobs "${WORK}/obs-spoof.json"     "$TEXT_OK" \
      '[{"frameId":9,"url":"https://custom-generators.civit.ai.attacker.example/x"}]'
mkobs "${WORK}/obs-pano.json"      'Panorama 360 Presets Checkpoint Generate' \
      '[{"frameId":832,"url":"https://panorama-360.civit.ai/"}]'
# 🔴 One REAL fixture per recipe. Do NOT synthesise these from the recipe under test:
# a fixture derived from the thing being tested makes every frameHost valid by
# construction, so P2/P3 can no longer tell a correct recipe from one pointing at a
# host that does not exist. That was tried and the mutant (frameHost ->
# nope.example.invalid) passed the whole suite while the DOM-op counter went UP,
# which reads as more coverage. Adding a recipe means adding a fixture here; P2/P3
# fail loudly and by name if you forget.
# Values below are live-observed (opencode browser-agent, 2026-08-15).
mkobs "${WORK}/obs-model-benchmarking.json" \
      'Model Benchmarking Crowdsourced model-comparison grid How this works Combinations (1) Prompts (2) Grid Buzz 12,345 zach' \
      '[{"frameId":851,"url":"https://model-benchmarking.civit.ai/"}]'
mkobs "${WORK}/obs-sensei.json" \
      'Civitai Sensei Ask me about AI models, checkpoints, or anything related to AI art generation. Buzz 12,345 zach' \
      '[{"frameId":845,"url":"https://sensei.civit.ai/"}]'
# Live-observed 2026-08-24, driven through the bridge (the `observed.json` each
# capture.sh --evidence run writes), NOT hand-written and NOT derived from the
# recipes. topText is the real host-page text, flattened and truncated; the
# frameIds are the real ones those runs resolved.
mkobs "${WORK}/obs-app-requests.json" \
      'Pro / Create ZA 2.3M Home Models Images Videos Hubs Articles Shop / Apps / App Requests Terms of Service Privacy Safety API Status' \
      '[{"frameId":4042,"url":"https://app-requests.civit.ai/"}]'
mkobs "${WORK}/obs-gen-matrix.json" \
      'Pro / Create ZA 2.3M Home Models Images Videos Hubs Articles Shop / Apps / Gen Matrix Terms of Service Privacy Safety API Status' \
      '[{"frameId":4056,"url":"https://gen-matrix.civit.ai/"}]'
mkobs "${WORK}/obs-playable-collections.json" \
      'Pro / Create ZA 2.3M Home Models Images Videos Hubs Articles Shop / Apps / Playable Collections Terms of Service Privacy Safety API Status' \
      '[{"frameId":4059,"url":"https://playable-collections.civit.ai/"}]'

# ── THE host -> observed-fixture MAP: ONE PLACE. ────────────────────────────
# 🔴 This used to be open-coded in THREE python heredocs (P2, P3, G3), so adding
# a recipe meant editing three dicts and forgetting one left that gate silently
# not covering the new app — a predicate duplicated across call sites is wrong at
# N-1 of them. Adding an app is now ONE line here.
#
# 🔴 EXPLICIT, not a glob over the fixture dir. Several fixtures deliberately
# share a frame set (obs-404, obs-loggedout and obs-spoof all reuse custom-
# generators' frames to drive the refusal gates), so "first fixture whose frame
# matches this host" silently handed custom-generators the 404 fixture and every
# one of its states refused as not_found. Matching by host is not enough; the
# mapping has to say WHICH fixture is the good one.
FIXTURE_MAP="${WORK}/fixture-map.json"
python3 - "$FIXTURE_MAP" "$WORK" <<'MAPPY'
import json, sys
out, work = sys.argv[1], sys.argv[2]
json.dump({
    "custom-generators.civit.ai":    work + "/obs-ok.json",
    "panorama-360.civit.ai":         work + "/obs-pano.json",
    "sensei.civit.ai":               work + "/obs-sensei.json",
    "model-benchmarking.civit.ai":   work + "/obs-model-benchmarking.json",
    "app-requests.civit.ai":         work + "/obs-app-requests.json",
    "gen-matrix.civit.ai":           work + "/obs-gen-matrix.json",
    "playable-collections.civit.ai": work + "/obs-playable-collections.json",
}, open(out, "w"))
MAPPY
# Fail LOUD if the map does not name a real file — a missing fixture must not
# reach a gate as "no observed fixture" and read like a recipe defect.
python3 - "$FIXTURE_MAP" <<'MAPCHK' || { echo "FATAL: fixture map is broken"; exit 1; }
import json, os, sys
m = json.load(open(sys.argv[1]))
missing = sorted(h for h, f in m.items() if not os.path.exists(f))
if missing:
    print("fixture-map names files that do not exist: %s" % missing); raise SystemExit(1)
if len(m) < 7:
    print("fixture-map has %d entries, expected >= 7" % len(m)); raise SystemExit(1)
MAPCHK

steps_of() {  # steps_of <plan.json>  ->  "op|argv joined" per line
  python3 -c '
import json,sys
p=json.load(open(sys.argv[1]))
for s in p["steps"]: print(s["op"]+"|"+" ".join(s["argv"]))' "$1"
}

# ---------------------------------------------------------------------------
echo "--- A: the tools and data parse -------------------------------------"
# ---------------------------------------------------------------------------
a_ok=1
for f in "$PLAN" "$FRAME" "$EVID"; do
  # compile to a temp cfile so the suite never drops __pycache__ into the tree
  python3 -c 'import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)' \
    "$f" "${WORK}/$(basename "$f").pyc" 2>/dev/null \
    || { fail "A1: $f does not compile"; a_ok=0; }
done
[ "$a_ok" = 1 ] && pass "A1: plan.py, frame.py and evidence.py compile"

b_ok=1
for f in "$CAPTURE_SH" "$ATTACH_SH"; do
  bash -n "$f" 2>/dev/null || { fail "A2: $f has a syntax error"; b_ok=0; }
  [ -x "$f" ] || { fail "A2: $f is not executable"; b_ok=0; }
done
[ "$b_ok" = 1 ] && pass "A2: capture.sh and attach.sh parse and are executable"

if python3 -c '
import json,sys
c=json.load(open(sys.argv[1]))
assert set(c["assets"]) == {"screenshot","icon","cover"}, sorted(c["assets"])
assert c["render"]["width"] and c["render"]["height"]
for k,v in c["assets"].items():
    for need in ("aspect_min","aspect_max","max_bytes","max_count"):
        assert need in v, (k, need)
' "$BOUNDS" 2>/dev/null; then
  pass "A3: store-bounds.json parses and defines screenshot/icon/cover"
else
  fail "A3: store-bounds.json is missing keys or does not parse"
fi

# A5 🔴 THE ARGV SHAPE, PINNED AS DATA. attach.sh emitted `--app`/`--file` for its
# whole life and NEVER attached anything -- every call died with `unknown flag:
# --app`. D4 could not see it: it asserts the CLI *is invoked*, and its stub
# accepts any flags, so a permanently-broken argv read as a passing positive
# control. "It ran" is not "it was right". These literals come from the CLI's own
# `add-screenshot --help`, not from the script under test.
a5=$(APP_CAPTURE_CIVITAI=echo "$ATTACH_SH" --app demo --screenshot "$FIX/1-explainer.png" \
       --caption "cap" --changelog "cl" 2>&1 || true)
a5_ok=1
case "$a5" in *"--slug demo"*) ;; *) fail "A5: attach.sh does not pass --slug (the CLI has no --app)"; a5_ok=0 ;; esac
case "$a5" in *"--file "*) fail "A5: attach.sh still passes --file; the CLI takes a POSITIONAL path"; a5_ok=0 ;; esac
case "$a5" in *"--app demo"*) fail "A5: attach.sh still passes --app; the CLI flag is --slug"; a5_ok=0 ;; esac
case "$a5" in *"--caption"*) ;; *) fail "A5: --caption is available on add-screenshot and must be passed inline"; a5_ok=0 ;; esac
case "$a5" in *" -y"*) ;; *) fail "A5: attach.sh omits -y and will block on the live-listing prompt"; a5_ok=0 ;; esac
case "$a5" in *"listing get"*) fail "A5: attach.sh calls 'app listing get', which is not a subcommand (it is 'status')"; a5_ok=0 ;; esac
[ "$a5_ok" = 1 ] && pass "A5: attach.sh emits the CLI's REAL argv (--slug, positional file, inline --caption, -y; no --app/--file/get)"

r_ok=1
for r in "$RECIPES"/*.json; do
  python3 -c '
import json,sys
sys.path.insert(0, sys.argv[2])
import plan
plan.validate_recipe(json.load(open(sys.argv[1])))' "$r" "$SCRIPTS" 2>/dev/null \
    || { fail "A4: recipe $(basename "$r") is invalid"; r_ok=0; }
done
[ "$r_ok" = 1 ] && pass "A4: every shipped recipe validates ($(ls "$RECIPES"/*.json | wc -l) recipes)"

# ---------------------------------------------------------------------------
echo
echo "--- P: plan.py — the planner and its guards --------------------------"
# ---------------------------------------------------------------------------

# P1 POSITIVE — the exact contract, pinned literally. Derived from what the plan
# MUST be (bridge semantics), not re-derived from the code under test.
python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-ok.json" \
        --state discover > "${WORK}/plan-discover.json" 2>"${WORK}/plan-discover.err"
if [ $? = 0 ]; then
  cat > "${WORK}/expected-discover.txt" <<'EOF'
activate|browser --instance work --tab 8123 activate --no-wait --no-focus
js|browser --instance work --tab 8123 --frame 830 js (function(){var d=document;var A=!!d.querySelector("[data-testid=\"discover-list\"]");var L=!!d.querySelector("[data-testid=\"app-loading\"]");var V=d.visibilityState==="visible";if(A&&!L)return "APPBOOT_READY";if(!A&&!V)return "APPBOOT_HIDDEN";return L?"APPBOOT_LOADING":"APPBOOT_ABSENT"})()
click|browser --instance work --tab 8123 --frame 830 click #panel-discover > div > div > div > div:nth-child(1) > button:nth-child(2)
wake|browser --instance work --tab 8123 wake --wait 4000
text|browser --instance work --tab 8123 --frame 830 text
wake|browser --instance work --tab 8123 wake --wait 4000
activate|browser --instance work --tab 8123 activate --no-wait --no-focus
screenshot|browser --instance work --tab 8123 screenshot
EOF
  steps_of "${WORK}/plan-discover.json" > "${WORK}/actual-discover.txt"
  if diff -u "${WORK}/expected-discover.txt" "${WORK}/actual-discover.txt" >"${WORK}/d.txt"; then
    pass "P1: discover plan matches the pinned expected command sequence (a foreground re-assert OPENS the plan, then the APP-READY gate, and the capture is settle-wake -> re-assert -> screenshot with nothing in the gap)"
  else
    fail "P1: discover plan drifted from the pinned sequence"
    sed 's/^/          /' "${WORK}/d.txt" | head -20
  fi
else
  fail "P1: planning the discover state failed outright"
  sed 's/^/          /' "${WORK}/plan-discover.err"
fi

# P2 — the cross-origin iframe invariant, across EVERY state of EVERY recipe.
python3 - "$PLAN" "$RECIPES" "$FIXTURE_MAP" > "${WORK}/p2.txt" 2>&1 <<'PY'
import json, subprocess, sys, glob, os
PLAN, RECIPES, FIXTURE_MAP = sys.argv[1:4]
FIXTURE = json.load(open(FIXTURE_MAP))   # single source — see FIXTURE_MAP above
DOM = {"click", "type", "key", "text", "html", "js"}
TAB_ONLY = {"screenshot", "wake", "activate", "nav"}
bad = []
n_dom = 0


def observed_for(recipe_path, rec):
    """Pick the REAL observed fixture whose frame is served by this recipe's frameHost.

    🔴 The fixture must be independent data, never derived from the recipe under
    test. A previous attempt synthesised it from `rec["frameHost"]` so the corpus
    would be self-serving; that made every host valid by construction and the
    killing mutation (frameHost -> nope.example.invalid) passed the ENTIRE suite,
    with the DOM-op counter rising as if coverage had improved.

    🔴 A recipe with no fixture is a FAILURE, not a skip. The old code hardcoded a
    two-way map, so recipe #3 onwards silently refused with frame_absent; making
    that loud and naming the missing file is what turns it into a one-line fix.
    """
    # The host -> fixture mapping is the SINGLE SOURCE built as FIXTURE_MAP in the
    # bash preamble (which also carries why it must be EXPLICIT rather than a glob
    # over the fixture dir). It used to be open-coded here and in two other
    # heredocs; adding a recipe then meant editing three dicts.
    return FIXTURE.get(rec["frameHost"])


for r in sorted(glob.glob(os.path.join(RECIPES, "*.json"))):
    rec = json.load(open(r))
    obs = observed_for(r, rec)
    if obs is None:
        bad.append("%s: NO observed fixture serves %s -- add one (mkobs obs-%s.json) "
                   "beside obs-ok.json; do NOT synthesise it from the recipe"
                   % (rec["slug"], rec["frameHost"], rec["slug"]))
        continue
    fid = str(json.load(open(obs))["frames"][0]["frameId"])
    for st in rec["states"]:
        cmd = ["python3", PLAN, r, "--observed", obs, "--state", st["name"], "--trusted"]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            bad.append("%s/%s did not plan: %s" % (rec["slug"], st["name"], p.stderr.strip()[:90]))
            continue
        for s in json.loads(p.stdout)["steps"]:
            argv = s["argv"]
            if s["op"] in DOM:
                n_dom += 1
                if "--frame" not in argv or argv[argv.index("--frame") + 1] != fid:
                    bad.append("%s/%s: %s has no --frame %s" % (rec["slug"], st["name"], s["op"], fid))
            if s["op"] in TAB_ONLY and "--frame" in argv:
                bad.append("%s/%s: %s must NOT be frame-scoped" % (rec["slug"], st["name"], s["op"]))
# positive control: if the corpus contains no DOM ops the check above is vacuous
if n_dom < 5:
    bad.append("POSITIVE CONTROL FAILED: only %d DOM ops inspected" % n_dom)
print("DOM_OPS=%d" % n_dom)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
if [ $? = 0 ]; then
  pass "P2: every DOM op carries --frame <resolved id>; screenshot/wake/nav never do ($(grep -o 'DOM_OPS=[0-9]*' "${WORK}/p2.txt") ops)"
else
  fail "P2: frame-scoping invariant broken"; sed 's/^/          /' "${WORK}/p2.txt" | head -10
fi

# P3/P4 — the throttling invariants, across every state of every recipe.
python3 - "$PLAN" "$RECIPES" "$FIXTURE_MAP" > "${WORK}/p3.txt" 2>&1 <<'PY'
import json, subprocess, sys, glob, os
PLAN, RECIPES, FIXTURE_MAP = sys.argv[1:4]
FIXTURE = json.load(open(FIXTURE_MAP))   # single source — see FIXTURE_MAP above
VIEW_CHANGING = {"click", "type", "key", "nav"}
bad, n_pairs, n_shots = [], 0, 0


def observed_for(recipe_path, rec):
    """Real fixture matched by frameHost. See P2's copy: never synthesise it from
    the recipe under test, and treat a missing fixture as a failure."""
    # The host -> fixture mapping is the SINGLE SOURCE built as FIXTURE_MAP in the
    # bash preamble (which also carries why it must be EXPLICIT rather than a glob
    # over the fixture dir). It used to be open-coded here and in two other
    # heredocs; adding a recipe then meant editing three dicts.
    return FIXTURE.get(rec["frameHost"])


for r in sorted(glob.glob(os.path.join(RECIPES, "*.json"))):
    rec = json.load(open(r))
    obs = observed_for(r, rec)
    if obs is None:
        bad.append("%s: NO observed fixture serves %s -- add one" % (rec["slug"], rec["frameHost"]))
        continue
    for st in rec["states"]:
        p = subprocess.run(["python3", PLAN, r, "--observed", obs, "--state", st["name"],
                            "--trusted"], capture_output=True, text=True)
        if p.returncode != 0:
            # 🔴 This used to `continue`, SILENTLY. A recipe that could not be planned
            # was dropped from the throttling checks entirely and the gate still went
            # green -- coverage vanished without a word. A state that will not plan is
            # a failure of this gate, not an exemption from it.
            bad.append("%s/%s did not plan: %s" % (rec["slug"], st["name"],
                                                   p.stderr.strip()[:90]))
            continue
        steps = json.loads(p.stdout)["steps"]
        for i, s in enumerate(steps):
            if s["op"] in VIEW_CHANGING:
                nxt = steps[i + 1] if i + 1 < len(steps) else None
                if not nxt or nxt["op"] not in ("wake", "reobserve"):
                    bad.append("%s/%s: %s at %d is not followed by wake" % (rec["slug"], st["name"], s["op"], i))
                elif nxt["op"] == "wake":
                    n_pairs += 1
                    if "4000" not in nxt["argv"]:
                        bad.append("%s/%s: wake after %s does not --wait 4000" % (rec["slug"], st["name"], s["op"]))
            if s["op"] == "screenshot":
                n_shots += 1
                # 🔴 THE SETTLE WAKE IS STILL REQUIRED, AND IT NO LONGER SITS
                # ADJACENT TO THE CAPTURE. Measured 2026-08-19: raise -> capture at
                # gap 0 recovered 3/3, raise -> 4 s wake -> capture only 1/3,
                # because the raised foreground survives a median ~1.5 s. So the
                # order is wake -> activate -> screenshot, and what this gate pins
                # is that the wake is still there, two steps back.
                window = [x["op"] for x in steps[max(0, i - 2):i]]
                if window[-1:] == ["activate"]:
                    if window[:1] != ["wake"]:
                        bad.append("%s/%s: screenshot at %d is preceded by the "
                                   "foreground re-assert but the settle wake is "
                                   "not the step before it (%s)"
                                   % (rec["slug"], st["name"], i, window))
                elif window[-1:] != ["wake"]:
                    bad.append("%s/%s: screenshot at %d is preceded by %s, neither "
                               "the settle wake nor the re-assert that follows it"
                               % (rec["slug"], st["name"], i, window))
                # guard 5: NO path argument
                if s["argv"][-1] != "screenshot":
                    bad.append("%s/%s: screenshot carries an argument: %s" % (rec["slug"], st["name"], s["argv"]))
if n_pairs < 3 or n_shots < 5:
    bad.append("POSITIVE CONTROL FAILED: %d wake-pairs, %d screenshots inspected" % (n_pairs, n_shots))
print("WAKE_PAIRS=%d SCREENSHOTS=%d" % (n_pairs, n_shots))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
if [ $? = 0 ]; then
  pass "P3/P4/P5: wake --wait 4000 after every view change, before every screenshot, and screenshot takes NO path ($(grep -o 'WAKE_PAIRS=.*' "${WORK}/p3.txt"))"
else
  fail "P3/P4/P5: throttling / pathless-screenshot invariant broken"
  sed 's/^/          /' "${WORK}/p3.txt" | head -10
fi

expect_refuse "P6 NEG: a 404 page refuses to be captured" not_found -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-404.json" --state discover

# P6b 🔴 THE `not_found` DIAGNOSIS IS PINNED AS A WHOLE NORMALISED STRING, the
# way exit 12's body is (G14), and for the same reason: the artifact under test
# is PROSE, so a guard on individual WORDS is walkable by rewording. The pin is
# what makes the list of causes a machine-readable claim.
#
# 🔴 WHY IT EXISTS. `guard_page` cannot distinguish its causes — page text is
# BYTE-IDENTICAL across all of them — so the REASON CODE stays `not_found` and
# the whole burden of the diagnosis falls on the sentence. Until 2026-09-14 that
# sentence named only two causes, logged-out and wrong-slug, and on 2026-09-14
# BOTH were wrong: `custom-generators` and `gen-matrix` refused while
# `model-benchmarking` and `playable-collections` captured in the SAME session,
# the same minute. The real cause was `app_blocks.status = suspended` — 15 of the
# 24 rows in that table, i.e. the COMMON case, not an edge case. A refusal that
# is correct and sends the reader to check two things that are both fine costs
# more than no message at all, so the sentence is graded here.
#
# 🔴 THE RANGE IS THE WHOLE OF STDERR, NOT A MATCHED LINE — G14's lesson. Only
# the `REFUSE[not_found]: ` prefix is stripped; every other byte plan.py writes
# is inside the pin, so a second line appended to the message lands INSIDE it
# rather than past the end of a window.
python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-404.json" \
  --state discover >/dev/null 2>"${WORK}/p6b.err"
sed 's/^REFUSE\[not_found\]: //' "${WORK}/p6b.err" \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/[[:space:]][[:space:]]*/ /g' >"${WORK}/p6b.actual"
cat >"${WORK}/p6b.expected" <<'P6BEOF'
the page reads as a 404 (matched '404', 'page could not be found', 'This page could not be found'). THREE causes render this SAME page and its text cannot tell them apart: the app is SUSPENDED or not yet approved (the COMMON case — a suspended app 404s for a logged-in mod exactly like a nonexistent slug), the session is logged out, or the slug is wrong. A sibling recipe capturing fine in the same session already rules out logged-out. Read the status from the DB, not the page: `SELECT slug, status FROM app_blocks ORDER BY status, slug;` against the platform database (the infra repo's `manage-postgres` skill carries the connection recipe) — anything but `approved` means this refusal is CORRECT and no session or slug change will help. Refusing to capture an error page.
P6BEOF
if diff -q "${WORK}/p6b.expected" "${WORK}/p6b.actual" >/dev/null 2>&1; then
  pass "P6b: the not_found refusal names ALL THREE causes of an identical 404 — app SUSPENDED/not-approved first (the common one, and the one the old two-cause message sent a reader straight past), logged-out, wrong slug — hands over the one read that discriminates them (app_blocks.status on the platform database), and says what an unapproved status means for this refusal; pinned as a whole normalised string, so a reword fails the suite on purpose"
else
  fail "P6b: the not_found diagnosis drifted from its pin"
  diff "${WORK}/p6b.expected" "${WORK}/p6b.actual" 2>&1 | sed 's/^/          /' | head -12
fi

expect_refuse "P7 NEG: logged-out chrome refuses to be captured" logged_out -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-loggedout.json" --state discover
expect_ok "P8 POS control for P6/P7: the same recipe on a logged-in page plans fine" -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-ok.json" --state discover
expect_refuse "P9 NEG: app frame not up yet -> refuse and say 'poll again'" frame_absent -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-noframe.json" --state discover
expect_refuse "P10 NEG: a host that merely CONTAINS the frameHost is not the frame" frame_absent -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-spoof.json" --state discover

# P11 — the spend path is unreachable without the flag, AND `activate` appears nowhere.
expect_refuse "P11a NEG: trustedKey without --trusted refuses" trusted_required -- \
  python3 "$PLAN" "$RECIPES/panorama-360.json" --observed "${WORK}/obs-pano.json" --state rendering
if python3 - "$PLAN" "$RECIPES/panorama-360.json" "${WORK}/obs-pano.json" >"${WORK}/p11b.txt" 2>&1 <<'PY'
import json, subprocess, sys
PLAN, RECIPE, OBS = sys.argv[1:4]
rec = json.load(open(RECIPE))
bad, planned, n_pre = [], 0, 0
for st in rec["states"]:
    p = subprocess.run(["python3", PLAN, RECIPE, "--observed", OBS, "--state", st["name"]],
                       capture_output=True, text=True)
    if p.returncode != 0:
        continue                                   # refused — that is P11a's case
    planned += 1
    steps = json.loads(p.stdout)["steps"]
    ops = [s["op"] for s in steps]
    for i, s in enumerate(steps):
        blob = s["op"] + " " + " ".join(s["argv"])
        # 🔴 BOTH HALVES, FOR DIFFERENT REASONS. `xdotool` is ACTUATION — the
        # thing that can spend — and is banned in any plan built without
        # --trusted, foreground plans included. `activate` is FOREGROUNDING,
        # which capture is PERMITTED (🔴 not "requires" — the 2026-08-17 "an App
        # Block does not boot in a hidden tab" is RETRACTED 2026-08-24: they boot
        # hidden, 4/4, and the HOST-SIDE half of the raise is withheld — the
        # steps send --no-focus. 🔴 NOT "inert": the tab is still made ACTIVE
        # and windows.update{focused:true} is ungated). The foreground a
        # raise wins survives a median ~1.5 s (measured 2026-08-19), i.e. nothing
        # like a whole state, which is why there are two. So a state plan
        # carries exactly two, each in its own measured place: the `state`
        # re-assert that OPENS the plan, and the `pre-screenshot` one with gap 0
        # to its capture. Gate G2 proves the two guards still cannot stand in for
        # each other; G11 proves these placements are enforced, not merely observed.
        if "xdotool" in blob:
            bad.append("state %r emitted ACTUATION (%r) without --trusted" % (st["name"], s["op"]))
        if s["op"] == "activate":
            why = s.get("foreground")
            if why == "state":
                if i != 0:
                    bad.append("state %r: the `state` re-assert is at %d, not "
                               "opening the plan" % (st["name"], i))
            elif why == "pre-screenshot":
                n_pre += 1
                if ops[i + 1:i + 2] != ["screenshot"]:
                    bad.append("state %r: the activate at %d is not immediately "
                               "before its screenshot (%s)"
                               % (st["name"], i, ops[i + 1:i + 2]))
                if ops[i - 1:i] != ["wake"]:
                    bad.append("state %r: the settle wake does not precede the "
                               "re-assert at %d (%s)" % (st["name"], i, ops[i - 1:i]))
            else:
                bad.append("state %r emitted an activate marked %r: a STATE plan "
                           "carries only the `state` lead and the `pre-screenshot` "
                           "re-assert" % (st["name"], why))
if planned and not n_pre:
    bad.append("POSITIVE CONTROL FAILED: %d state plan(s) and NOT ONE activate — "
               "the placement findings above are about nothing, and every capture "
               "is back to relying on a foregrounding that was measured not to "
               "survive to the screenshot" % planned)
# ...and planning the WHOLE recipe must refuse loudly rather than quietly
# skipping the spend state and returning the safe ones.
whole = subprocess.run(["python3", PLAN, RECIPE, "--observed", OBS],
                       capture_output=True, text=True)
if whole.returncode != 2 or "trusted_required" not in whole.stderr:
    bad.append("planning the whole recipe without --trusted did not refuse "
               "(rc=%d) — a spend state must never be silently skipped" % whole.returncode)
if planned < 2:
    bad.append("POSITIVE CONTROL FAILED: only %d non-spend states planned, so the "
               "'no activate' finding is about nothing" % planned)
print("NON_SPEND_STATES_PLANNED=%d" % planned)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "P11b NEG: no actuation ('xdotool') in a non-trusted STATE plan, and the only 'activate's one may carry are the 'state' lead that opens it and the 'pre-screenshot' re-assert sitting between the settle wake and its own capture; a recipe holding a spend state refuses as a whole rather than silently skipping it"
else
  fail "P11b: the spend path leaked into a non-trusted run"
  sed 's/^/          /' "${WORK}/p11b.txt" | head -8
fi

# P12 — the POSITIVE control for P11: with the flag, the full trusted sequence appears.
if python3 - "$PLAN" "$RECIPES/panorama-360.json" "${WORK}/obs-pano.json" >"${WORK}/p12.txt" 2>&1 <<'PY'
import json, subprocess, sys
PLAN, RECIPE, OBS = sys.argv[1:4]
p = subprocess.run(["python3", PLAN, RECIPE, "--observed", OBS, "--state", "rendering",
                    "--trusted"], capture_output=True, text=True)
assert p.returncode == 0, p.stderr
plan = json.loads(p.stdout)
ops = [s["op"] for s in plan["steps"]]
flat = [" ".join(s["argv"]) for s in plan["steps"]]
need = [
    ("focus+verify activeElement", any("document.activeElement===e" in f for f in flat)),
    ("record prev X window",       any("getactivewindow" in f for f in flat)),
    ("browser activate",           "activate" in ops),
    ("RE-focus after activation",  sum("document.activeElement===e" in f for f in flat) >= 2),
    ("trusted keypress",           any("key --clearmodifiers Return" in f for f in flat)),
    ("restore the operator window",any("windowactivate" in f for f in flat)),
    ("loud warning emitted",       bool(plan.get("warnings"))),
    ("no coordinate click",        not any(f.split()[-2:] == ["click", "x,y"] for f in flat)),
]
bad = [n for n, ok in need if not ok]
# order matters: the SPEND activate must sit BETWEEN getactivewindow and
# windowactivate. It is selected by its own marker, not by `ops.index("activate")`
# — a state plan also opens with the `state` foreground re-assert, and taking the
# first activate would grade that one and report a bracketing that was never checked.
i_get = next(i for i, f in enumerate(flat) if "getactivewindow" in f)
i_act = next(i for i, s in enumerate(plan["steps"]) if s.get("foreground") == "spend")
i_res = next(i for i, f in enumerate(flat) if "windowactivate" in f)
if not (i_get < i_act < i_res):
    bad.append("activate is not bracketed by save/restore of the focused window")

# 🔴 THE WIRING, NOT JUST THE ORDER. Three steps in the right order still restore
# nothing if the save step stores into one variable and the restore step reads
# another. Measured: renaming the save step's captureVar SURVIVED a version of
# this gate that only checked order. So: the save step must declare a captureVar,
# the restore step must reference that EXACT name, and no other name.
save = plan["steps"][i_get]
rest = plan["steps"][i_res]
var = save.get("captureVar")
if not var:
    bad.append("the getactivewindow step declares no captureVar — nothing is recorded")
elif ("$" + var) not in rest["argv"]:
    bad.append("the restore step reads %s but the save step stores into %r"
               % ([a for a in rest["argv"] if a.startswith("$")] or "nothing", var))
elif rest.get("usesVar") != var:
    bad.append("the restore step's usesVar (%r) disagrees with the save step's "
               "captureVar (%r)" % (rest.get("usesVar"), var))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "P12 POS control for P11: --trusted emits focus->verify->save-window->activate->refocus->key->RESTORE, with a loud warning"
else
  fail "P12: the trusted sequence is incomplete or mis-ordered"
  sed 's/^/          /' "${WORK}/p12.txt" | head -10
fi

# P13/P14 — the two spend-verification traps.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
st=[s for s in r["states"] if s["name"]=="rendering"][0]
st["actions"][0].pop("verifyLabel",None); st["actions"][0]["verifyBalanceDelta"]=100
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/panorama-360.json" "${WORK}/rec-balance.json"
expect_refuse "P13 NEG: verifying a spend by Buzz-balance delta is refused by name" balance_verification -- \
  python3 "$PLAN" "${WORK}/rec-balance.json" --observed "${WORK}/obs-pano.json" --state rendering --trusted

python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
st=[s for s in r["states"] if s["name"]=="rendering"][0]
st["actions"][0].pop("verifyLabel",None)
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/panorama-360.json" "${WORK}/rec-nolabel.json"
expect_refuse "P14 NEG: a trustedKey with no verifyLabel is refused" no_verify_label -- \
  python3 "$PLAN" "${WORK}/rec-nolabel.json" --observed "${WORK}/obs-pano.json" --state rendering --trusted

# P15 — a nav invalidates the frame id, so the plan STOPS. No --frame step may
# follow a nav in one plan; the frame id is re-derived by re-observing.
python3 -c '
import json,sys
json.dump({"slug":"navtest","frameHost":"custom-generators.civit.ai",
  "ready":{"testid":"discover-list"},"clickable":["#tab-mine","#tab-discover"],"states":[
  {"name":"after-nav","actions":[{"click":"#tab-mine"},
                                 {"nav":"https://civitai.com/apps/run/custom-generators"},
                                 {"click":"#tab-discover"}]}]}, open(sys.argv[1],"w"))' \
  "${WORK}/rec-nav.json"
if python3 - "$PLAN" "${WORK}/rec-nav.json" "${WORK}/obs-ok.json" >"${WORK}/p15.txt" 2>&1 <<'PY'
import json, subprocess, sys
p = subprocess.run(["python3", sys.argv[1], sys.argv[2], "--observed", sys.argv[3],
                    "--state", "after-nav"], capture_output=True, text=True)
assert p.returncode == 0, p.stderr
plan = json.loads(p.stdout)
steps = plan["steps"]
bad = []
if not plan.get("truncatedAtNav"):
    bad.append("plan is not marked truncatedAtNav")
if steps[-1]["op"] != "reobserve" or not steps[-1].get("terminal"):
    bad.append("plan does not end in a terminal `reobserve` sentinel")
i_nav = [i for i, s in enumerate(steps) if s["op"] == "nav"]
if not i_nav:
    bad.append("no nav step emitted")
else:
    after = steps[i_nav[0] + 1:]
    leaked = [s["op"] for s in after if "--frame" in s["argv"]]
    if leaked:
        bad.append("frame-scoped ops AFTER a nav (the id is stale): %s" % leaked)
    if any(s["op"] == "screenshot" for s in after):
        bad.append("a screenshot was planned after a nav without re-observing")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "P15: a nav ends the plan with a terminal reobserve; no frame-scoped op survives it"
else
  fail "P15: the frame id is being carried across a navigation"
  sed 's/^/          /' "${WORK}/p15.txt" | head -10
fi

# P16 — malformed recipes are rejected rather than half-planned.
python3 -c 'import json,sys; json.dump({"slug":"x","frameHost":"custom-generators.civit.ai",
  "ready":{"testid":"discover-list"},
  "states":[{"name":"a","actions":[{"clik":"#x"}]}]}, open(sys.argv[1],"w"))' "${WORK}/rec-typo.json"
expect_refuse "P16a NEG: a typo'd action verb is refused, not silently skipped" bad_recipe -- \
  python3 "$PLAN" "${WORK}/rec-typo.json" --observed "${WORK}/obs-ok.json" --state a
python3 -c 'import json,sys; json.dump({"slug":"x","frameHost":"custom-generators.civit.ai",
  "ready":{"testid":"discover-list"},
  "states":[{"name":"a"},{"name":"a"}]}, open(sys.argv[1],"w"))' "${WORK}/rec-dup.json"
expect_refuse "P16b NEG: duplicate state names are refused" bad_recipe -- \
  python3 "$PLAN" "${WORK}/rec-dup.json" --observed "${WORK}/obs-ok.json" --state a
expect_refuse "P16c NEG: an unknown state name is refused" unknown_state -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-ok.json" --state nope

# P17 — the selectors that were got wrong on 2026-08-13 stay pinned.
if python3 -c '
import json,sys
pano=json.load(open(sys.argv[1]))
gen=[s for s in pano["states"] if s["name"]=="rendering"][0]["actions"][0]["trustedKey"]
# 🔴 THIS GATE PINNED A SELECTOR THAT MATCHED NOTHING, AND STAYED GREEN OVER IT.
# Until 2026-08-18 it asserted `">" in gen` and `gen.startswith("#pano-controls")`
# — the SHAPE of a selector, never that it RESOLVES. `pano-controls` is a custom
# element TAG NAME, not an id; the live frame carries exactly one `id`, div#root.
# So every assertion here passed while the selector matched zero elements, for
# five days, on a gate whose stated job was pinning "the selectors that were got
# wrong". A shape assertion cannot see a kind error. Pin the MEASURED selector
# instead, and pin the id form as FORBIDDEN so it cannot come back.
assert "#pano-controls" not in gen, (
    "#pano-controls matches nothing — it is a TAG name, not an id (measured live "
    "2026-08-18: querySelector('#pano-controls') -> null in a fully booted frame)")
assert "data-testid" in gen and "pn-generate" in gen, gen
for s in pano["states"]:
    for a in s.get("actions", []):
        for k in ("click", "trustedKey"):
            if k in a:
                assert "#pano-controls" not in a[k], (a["_comment"] if "_comment" in a else a)
# The ready anchor must be a POST-BOOT signal. #root ships in the static HTML
# shell (curl returns 814 bytes whose whole body is <div id="root"></div>, zero
# testids), so it is present before the app boots and in a deadlocked frame — a
# gate on it would pass early and hand a spinner to the actions.
assert pano["ready"].get("testid") == "pn-prompt", pano["ready"]
assert "root" not in json.dumps(pano["ready"].get("selector", "")), pano["ready"]

cg=json.load(open(sys.argv[2]))
byname={s["name"]: s for s in cg["states"]}
sels=[a["click"] for s in cg["states"] for a in s.get("actions",[]) if "click" in a]
assert "#tab-mine" in sels, sels
assert any("#panel-discover >" in s for s in sels), "legoify Open selector missing"

# 🔴 THE LIVE-RUN LESSON, PINNED. The Discover TAB is already active on load, so a
# `discover` state whose only action is `click #tab-discover` is a NO-OP and comes
# back identical to `explainer` — which is what the identical-box gate caught on
# the first live run of this recipe. The state must DISMISS the explainer panel.
d=byname["discover"]["actions"]
assert d, "the discover state has no actions — it cannot differ from explainer"
assert d[0].get("click") != "#tab-discover", (
    "discover clicks the already-active tab: a no-op that duplicates explainer")
assert "#panel-discover" in d[0]["click"], d[0]
assert any(a.get("waitForGone") for a in d), (
    "discover must waitForGone the explainer text, or the capture races the dismissal")
' "$RECIPES/panorama-360.json" "$RECIPES/custom-generators.json" 2>"${WORK}/p17.err"; then
  pass "P17: the verified selectors are pinned (pano Generate is the MEASURED pn-generate testid and #pano-controls is banned; ready is a post-boot testid, never the static-shell #root; discover DISMISSES the explainer rather than clicking the already-active tab)"
else
  fail "P17: a verified selector drifted"; sed 's/^/          /' "${WORK}/p17.err" | head -6
fi

# ---------------------------------------------------------------------------
echo
echo "--- F: frame.py — the cropper, against REAL captures -----------------"
# ---------------------------------------------------------------------------

# F1 POSITIVE — every fixture measures to the box PINNED in the manifest.
if python3 - "$FRAME" "$FIX" >"${WORK}/f1.txt" 2>&1 <<'PY'
import json, subprocess, sys, os
FRAME, FIX = sys.argv[1:3]
man = json.load(open(os.path.join(FIX, "manifest.json")))
b = man["bands"]
bad, n = [], 0
for cap in man["captures"]:
    p = subprocess.run(["python3", FRAME, "measure", os.path.join(FIX, cap["file"]),
                        "--chrome-top", str(b["chromeTop"]), "--footer", str(b["footer"]),
                        "--right", str(b["right"]), "--stride", str(b["stride"]),
                        "--tolerance", str(b["tolerance"])], capture_output=True, text=True)
    if p.returncode != 0:
        bad.append("%s REFUSED: %s" % (cap["file"], p.stderr.strip()[:100])); continue
    m = json.loads(p.stdout)
    n += 1
    if m["box"] != cap["box"]:
        bad.append("%s: got %s, manifest pins %s" % (cap["file"], m["box"], cap["box"]))
    if m["frame"] != man["frame"]:
        bad.append("%s: frame %s != %s" % (cap["file"], m["frame"], man["frame"]))
    if m["bg"] != man["bg"]:
        bad.append("%s: background %s != %s" % (cap["file"], m["bg"], man["bg"]))
    # the clamp: a box may never leave the image it came from
    if (m["box"]["x"] + m["box"]["w"] > m["frame"]["w"]
            or m["box"]["y"] + m["box"]["h"] > m["frame"]["h"]):
        bad.append("%s: box escapes the frame -> crops to nothing" % cap["file"])
if n != 5:
    bad.append("POSITIVE CONTROL FAILED: measured %d of 5 fixtures" % n)
print("MEASURED=%d" % n)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "F1 POS: all 5 real captures — four custom-generators states and one model-benchmarking state, two DIFFERENT app columns on the same viewport — measure to the manifest's pinned boxes, inside the frame"
else
  fail "F1: a real capture no longer measures to its pinned box"
  sed 's/^/          /' "${WORK}/f1.txt" | head -12
fi

# F2/F3/F4 NEG — the three broken-band shapes, reproduced FROM THE REAL FIXTURES.
expect_refuse "F2 NEG: no exclusion bands -> box is the whole frame -> refused" full_frame -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --chrome-top 0 --footer 0 --right 0
expect_refuse "F3 NEG: footer left in -> full-WIDTH box (100.0% x 98.2%) -> refused" full_frame -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --footer 0
# 🔴 F4 IS THE CASE THAT TELLS OR FROM AND. At 78.7% wide x 100.0% tall an AND
# rule does not fire; F2 and F3 are both >=97% on BOTH axes and cannot see the
# difference. (This gate was labelled the other way round until the mutation
# battery measured it — see M21.)
expect_refuse "F4 NEG: right-edge furniture left in -> full-HEIGHT box (78.7% x 100.0%) -> refused; this is the case that requires OR, not AND" full_frame -- \
  python3 "$FRAME" measure "$FIX/2-discover.png" --right 0

# F4b 🔴 THE REFUSAL MUST NAME BOTH CAUSES OF ITS OWN MEASUREMENT. A >=97% fill
# has two: page furniture in the box (fixable by bands), and an app whose content
# genuinely fills the band (NOT fixable by bands — declare `crop.rect`). Until
# 2026-08-25 the message asserted only the first, so three recipes' authors were
# sent to tune chromeTop/footer on frames that can never be trimmed below the
# threshold (infra ticket #1297: app-requests 46.9% x 98.3%, playable-collections
# 63.9% x 100.0%). Pinned because a one-cause message on a two-cause measurement
# reads as complete and is what stops anyone looking — and because the widening
# is prose, which is exactly what a later size-prune deletes first.
f4b="${WORK}/f4b.err"
python3 "$FRAME" measure "$FIX/2-discover.png" --right 0 >/dev/null 2>"$f4b"
ok4b=1
grep -q 'TWO CAUSES' "$f4b" || ok4b=0
grep -q 'found page FURNITURE' "$f4b" || ok4b=0          # cause (a) survives
grep -q 'GENUINELY fills the band' "$f4b" || ok4b=0      # cause (b) is named
grep -qF 'crop.rect' "$f4b" || ok4b=0                    # ...with the route out (-F: `.` is a BRE wildcard)
grep -qF 'sensei.json' "$f4b" || ok4b=0                  # ...and a worked example
grep -qF 'verify such a crop BY EYE' "$f4b" || ok4b=0    # ...and what it costs
grep -qF 'identical-box check inert' "$f4b" || ok4b=0    # ...named, not merely implied by "by eye"
# 🔴 AND WHICH OF THE TWO DECLARED FORMS, or (b) is advice into a SECOND refusal.
# A bare `rect` is ABSOLUTE and is still mutually exclusive with `fromAppFrame`;
# on an `apps/run/<slug>` page it is wrong by the rewards banner's ~36px in one
# of the two layouts by construction. The form that combines with `fromAppFrame`
# is the frame-relative one, `"yFrom": "appFrame"` — and until it existed this
# message's advice terminated in a refusal for exactly the two apps whose numbers
# motivated it (infra ticket #1297). A remedy stated without the precondition that
# makes it applicable is the same defect class this whole gate is about.
grep -qF 'MUTUALLY EXCLUSIVE' "$f4b" || ok4b=0
grep -qF 'yFrom' "$f4b" || ok4b=0                        # the form that DOES combine
grep -qF 'appFrame' "$f4b" || ok4b=0
grep -q 'IFRAME.S TOP EDGE' "$f4b" || ok4b=0             # ...and what it anchors to
# 🔴 NEGATIVE, and it is the half that rots: the old text told the reader to DROP
# `fromAppFrame` in order to declare a rect. That is now the wrong instruction for
# a banner page, and a message can regain it while every positive grep above
# still passes.
grep -qiE 'you must DROP it|must be DROPPED' "$f4b" && ok4b=0
if [ "$ok4b" = 1 ]; then
  pass "F4b: the full_frame refusal names BOTH causes — furniture in the box AND content that genuinely fills the band — points the second at a declared crop.rect (sensei.json), states what declaring COSTS (the identical-box check goes inert, so verify by eye), and names WHICH declared form applies: a bare rect is absolute and still mutually exclusive with fromAppFrame, while \`yFrom: appFrame\` anchors y to the iframe's top edge and is the one that combines — and it no longer tells the reader to drop fromAppFrame, which was advice into a second refusal"
else
  fail "F4b: the full_frame refusal asserts one cause for a measurement that has two — it will send the reader to tune exclusion bands on a frame that cannot be trimmed"
  sed 's/^/          /' "$f4b" | head -8
fi

# F5 POS / F6 NEG — the identical-box tell.
python3 - "$FRAME" "$FIX" "${WORK}" <<'PY'
import json, subprocess, sys, os
FRAME, FIX, WORK = sys.argv[1:4]
def m(f, extra):
    p = subprocess.run(["python3", FRAME, "measure", os.path.join(FIX, f)] + extra,
                       capture_output=True, text=True)
    return json.loads(p.stdout)
files = ["1-explainer.png", "2-discover.png", "3-generator.png", "4-mine.png"]
json.dump([m(f, []) for f in files], open(os.path.join(WORK, "ms-good.json"), "w"))
json.dump([m(f, ["--right", "0", "--no-gate"]) for f in files],
          open(os.path.join(WORK, "ms-right0.json"), "w"))
# a duplicate in positions 2 and 3 — NOT adjacent to the first state, so a
# check that only compares the first pair (or only adjacent pairs from index 0)
# passes this and must not.
d = m("2-discover.png", []); d2 = dict(d); d2["file"] = "2b-discover-copy.png"
json.dump([m("1-explainer.png", []), d, d2], open(os.path.join(WORK, "ms-dupe.json"), "w"))
json.dump([m("1-explainer.png", [])], open(os.path.join(WORK, "ms-one.json"), "w"))
PY
expect_ok "F5 POS control for F6: the 4 correct boxes are all distinct" -- \
  python3 "$FRAME" check-states "${WORK}/ms-good.json"
expect_refuse "F6 NEG: identical content boxes across states are refused" identical_boxes -- \
  python3 "$FRAME" check-states "${WORK}/ms-right0.json"
expect_refuse "F7 NEG: a duplicate in states 2+3 (not the first pair) is still caught" identical_boxes -- \
  python3 "$FRAME" check-states "${WORK}/ms-dupe.json"
expect_refuse "F8 NEG: one state cannot prove a cropper works -> refused" too_few_states -- \
  python3 "$FRAME" check-states "${WORK}/ms-one.json"

# F9 — the recipe's `crop` block really drives the bands.
# 🔴 THE OVERRIDE VALUES MUST DIFFER FROM THE DEFAULTS. The shipped recipe's crop
# block happens to hold exactly the module defaults (182/110/70), so asserting
# against it cannot distinguish "the override was applied" from "the override was
# ignored and the defaults happened to match" — measured: a mutation that read the
# crop block and threw it away SURVIVED that version of this gate. This one uses
# values that appear nowhere as a default, and asserts they are not defaults.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["crop"]={"chromeTop":211,"footer":137,"right":83}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-crop.json"
if python3 - "$FRAME" "$FIX/1-explainer.png" "${WORK}/rec-crop.json" "$SCRIPTS" \
     >"${WORK}/f9.txt" 2>&1 <<'PY'
import json, subprocess, sys
FRAME, PNG, RECIPE, SCRIPTS = sys.argv[1:5]
want = {"chromeTop": 211, "footer": 137, "right": 83}
sys.path.insert(0, SCRIPTS)
import frame as F
defaults = {"chromeTop": F.DEF_CHROME_TOP, "footer": F.DEF_FOOTER, "right": F.DEF_RIGHT}
assert defaults != want, ("the override values equal the defaults, so this gate "
                          "cannot tell an applied override from an ignored one: %s" % defaults)
p = subprocess.run(["python3", FRAME, "measure", PNG, "--recipe", RECIPE, "--no-gate"],
                   capture_output=True, text=True)
assert p.returncode == 0, p.stderr
m = json.loads(p.stdout)
assert m["bands"] == want, "bands %s != the recipe's %s" % (m["bands"], want)
print("ok: %s applied over defaults %s" % (want, defaults))
PY
then
  pass "F9: a recipe's \`crop\` block drives the exclusion bands, asserted with values that are NOT the defaults"
else
  fail "F9: recipe crop overrides are inert"; sed 's/^/          /' "${WORK}/f9.txt" | head -6
fi

# ---------------------------------------------------------------------------
# F10/F11/F12 — `crop.fromAppFrame`: the top band DERIVED from the app iframe.
#
# 🔴 WHY THIS EXISTS, AND WHY THE OBVIOUS FIX WAS REJECTED. model-benchmarking's
# capture refused outright with `full_frame` at chromeTop=182. The tempting
# repair is a bigger number. It cannot work: `civitai.com/apps/run/<slug>` puts a
# CONDITIONAL full-width rewards banner ("BONUS REWARDS ACTIVE", ~36px, rendered
# only once a Buzz-multiplier query resolves) ABOVE the app iframe, so the same
# app on the same viewport has two layouts a constant offset apart. F11 sweeps
# every candidate value against BOTH and finds no value that works for both —
# the two valid windows are ~34px wide and DISJOINT. So the band is derived from
# the iframe's own bounding rect, which is where the app actually begins and
# which moves WITH the banner.
# ---------------------------------------------------------------------------

# --- the banner-state fixture, CUT FROM A REAL CAPTURE (bannershift.py) ------
BANNER="${WORK}/banner-mb-combinations.png"
if python3 "${FIX}/bannershift.py" "$FIX/5-mb-combinations.png" "$BANNER" \
     --at 100 --height 36 >"${WORK}/bshift.txt" 2>&1 && [ -s "$BANNER" ]; then
  pass "F10-fixture: the banner layout is CUT FROM the real model-benchmarking capture — the app that actually broke — by inserting a 36-row full-width strip at y=100, not synthesised: a clean synthetic page carries neither the full-width footer nor the right-edge furniture, which is what made the cropper silently no-op twice"
else
  fail "F10-fixture: bannershift.py did not produce a banner-state capture"
  sed 's/^/          /' "${WORK}/bshift.txt" | head -5
fi

# F10 — the arithmetic and the four refusals, in the PURE module.
if python3 - "$SCRIPTS" >"${WORK}/f10.txt" 2>&1 <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import frame as F
bad = []

# 🔴 THE RECT WIDENS, NEVER NARROWS. Every value below is distinct from every
# other AND from frame.py's defaults, so no assertion can pass by coincidence
# (F9's lesson: an override that equals the default proves nothing).
assert (F.DEF_CHROME_TOP, F.DEF_FOOTER, F.DEF_RIGHT) == (182, 110, 70), "defaults moved"
got = F.app_frame_bands(182, 110, 70, (201, 37, 15, 1709, 1314), 1709, 1314)
if got != (201, 110, 70):
    bad.append("a rect that is TIGHTER on two axes must lose on those two: %s" % (got,))
got = F.app_frame_bands(182, 110, 70, (163, 140, 96, 1709, 1314), 1709, 1314)
if got != (182, 140, 96):
    bad.append("a rect LOOSER on the top must lose there and win elsewhere: %s" % (got,))
# the degenerate readings the live page really produces: an iframe taller than
# the viewport reports a NEGATIVE bottom gap, a scrolled page a negative top.
got = F.app_frame_bands(182, 110, 70, (-40, -187, 14, 1709, 1314), 1709, 1314)
if got != (182, 110, 70):
    bad.append("negative gaps must lose to the recipe's floors, not clamp or crash: %s" % (got,))

# the scale POSITIVE CONTROL, at its boundary in both directions
try:
    F.app_frame_bands(182, 110, 70, (201, 110, 70, 1711, 1316), 1709, 1314)
except F.Refuse as e:
    bad.append("a 2px viewport disagreement must be tolerated (fractional DPR): %s" % e.code)
try:
    F.app_frame_bands(182, 110, 70, (201, 110, 70, 1712, 1314), 1709, 1314)
    bad.append("a 3px viewport disagreement was ACCEPTED — the units check is inert")
except F.Refuse as e:
    if e.code != "app_frame_scale":
        bad.append("wrong code for a scale disagreement: %s" % e.code)

# the parser, on the shape the bridge really returns (escaped, wrapped, noisy)
r = F.parse_app_frame_rect('{"ok":true,"result":{"data":{"value":"APPFRAME_RECT:201,-187,14,1709,1314"}}}')
if r != (201, -187, 14, 1709, 1314, None):
    bad.append("parse of a real bridge envelope: %s" % (r,))
# 🔴 THE SIX-FIELD ANSWER, AND THE FIVE-FIELD ONE AS ITS CONTROL. The sixth number
# is the frame's LEFT inset (added 2026-09-02). A five-field answer is the OLD
# probe and must still parse — every band, bound and `yFrom` rect predates the
# sixth number and none of them reads it — but it must come back as `None` rather
# than as a plausible 0, because `left=0` is a REAL reading (a full-bleed iframe)
# and conflating "the frame starts at column 0" with "nobody told me where the
# frame starts" is the whole silent-fallback shape this form exists to refuse.
r6 = F.parse_app_frame_rect('{"data":{"value":"APPFRAME_RECT:141,64,-1,1709,1255,803"}}')
if r6 != (141, 64, -1, 1709, 1255, 803):
    bad.append("parse of a SIX-field probe answer: %s" % (r6,))
if r[5] is not None:
    bad.append("a five-field answer reported a left inset of %r — a missing reading "
               "must not be spelled as a real one" % (r[5],))
# 🔴 THE MALFORMED ARMS MUST REFUSE, NOT RAISE. This parser runs over whatever a
# bridge error happened to print, and a traceback where the handler promises a
# REFUSE line is a worse answer than either. `str.isdigit()` is true for
# non-ASCII digits and `int("-")` raises, so both are pinned here.
for blob, code in (('{"data":{"value":"APPFRAME_ABSENT"}}', "app_frame_absent"),
                   ('{"data":{"value":"APPFRAME_RECT:1,2,3"}}', "app_frame_unreadable"),
                   # the OTHER side of the 5-or-6 window: seven numbers is not a
                   # newer probe to be tolerated, it is an answer this module did
                   # not write.
                   ('{"data":{"value":"APPFRAME_RECT:1,2,3,4,5,6,7"}}', "app_frame_unreadable"),
                   ('{"data":{"value":"APPFRAME_RECT:-,2,3,4,5"}}', "app_frame_unreadable"),
                   ('{"data":{"value":"APPFRAME_RECT:\u0663,2,3,4,5"}}', "app_frame_unreadable"),
                   ('{"ok":false,"error":"op_timeout:js"}', "app_frame_unreadable")):
    try:
        F.parse_app_frame_rect(blob)
        bad.append("%s was parsed rather than refused" % blob)
    except F.Refuse as e:
        if e.code != code:
            bad.append("%s -> %s, wanted %s" % (blob, e.code, code))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "F10: the derived bands take the MAX of rect-and-recipe on every axis (so a scrolled page's negative gaps, and an iframe taller than the viewport, LOSE rather than narrowing a band), the viewport cross-check tolerates 2px of DPR rounding and refuses 3, and the parser reads a real bridge envelope and refuses the three unreadable ones"
else
  fail "F10: the app-frame band derivation is wrong"
  sed 's/^/          /' "${WORK}/f10.txt" | head -12
fi

# F10b — the two SEAM refusals, from BOTH sides, through the CLI.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["crop"]={"chromeTop":182,"footer":110,"right":70}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-noafr.json"
expect_refuse "F10b NEG: a recipe that asks for fromAppFrame and is given no rect REFUSES rather than falling back to the static band it could not satisfy" app_frame_rect_missing -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --recipe "$RECIPES/custom-generators.json"
expect_refuse "F10c NEG: a rect handed to a recipe that never asked for one is refused, not silently applied or silently dropped" app_frame_rect_unexpected -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --recipe "${WORK}/rec-noafr.json" \
    --app-frame-rect 'APPFRAME_RECT:201,110,70,1709,1314'
# 🔴 THIS BUILDS ITS OWN ABSOLUTE RECT AND NO LONGER BORROWS sensei's. It used to
# take sensei.json (the only absolute-form recipe) and add fromAppFrame. sensei
# converted to the FRAME-RELATIVE form on 2026-08-27, so that recipe now carries
# `yFrom` — and rect+fromAppFrame+yFrom is the LEGAL combination, so the borrowed
# recipe no longer builds the shape this negative is named for. 🔴 BE ACCURATE
# ABOUT WHAT WOULD HAVE HAPPENED: it would have FAILED LOUDLY, not passed
# vacuously. Measured — the old construction against the converted recipe gives
# REFUSE[crop_rect_outside] — on the IFRAME's lower edge at 1204, not on the
# fixture's 1314 height (the resolved rect ends at 1247, inside the frame); the
# message's own next clause says which bound it used —
# and `expect_refuse` checks the CODE, not merely exit 2, so it reports a wrong
# code rather than a green. The rewrite is still right; "vacuous pass" was the
# strongest available framing applied to a case that was never silent. There is
# now NO shipped absolute-form recipe, so the case has to be constructed.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
r["crop"]["fromAppFrame"]=True
r["crop"]["rect"]={"x":0,"y":97,"w":1694,"h":1090}   # ABSOLUTE: no yFrom
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/sensei.json" "${WORK}/rec-both.json"
expect_refuse "F10d NEG: a recipe declaring BOTH a crop rect and fromAppFrame is refused — a declared rect bypasses detection, so a derived detection band would have nothing to act on" crop_rect_invalid -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --recipe "${WORK}/rec-both.json" \
    --app-frame-rect 'APPFRAME_RECT:201,110,70,1709,1314'
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r.pop("frameHost",None)
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/model-benchmarking.json" "${WORK}/rec-nohost.json"
expect_refuse "F10f NEG: frame-rect-js on a recipe with no frameHost REFUSES by name — it is reachable on its own, and a bare KeyError under a handler that promises a REFUSE line is a traceback where the caller wants a sentence" bad_recipe -- \
  python3 "$FRAME" frame-rect-js --recipe "${WORK}/rec-nohost.json"
expect_ok "F10g POS control for F10f: the same subcommand on the real recipe prints its probe" -- \
  python3 "$FRAME" frame-rect-js --recipe "$RECIPES/model-benchmarking.json"
# 🔴 gen-matrix, NOT custom-generators, SINCE 2026-09-04 — this control drives the
# DETECTION path, and custom-generators converted to a declared rect that day, which
# frame.py returns verbatim. It was simply the wrong fixture for a detection control
# once it stopped being a detection recipe.
expect_ok "F10e POS control for F10b/c/d: the opted-in DETECT recipe measures cleanly" -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --recipe "$RECIPES/gen-matrix.json" \
    --app-frame-rect 'APPFRAME_RECT:201,110,70,1709,1314'

# ---------------------------------------------------------------------------
# F11 🔴 THE HEADLINE: NO FIXED `chromeTop` IS CORRECT IN BOTH BANNER STATES.
#
# This is the whole justification for deriving the band, and it is asserted by
# MEASUREMENT rather than by argument: sweep every candidate value over the real
# capture and over the banner state cut from it, and intersect the sets that come
# back correct. Both sets must be non-empty (or the sweep is measuring nothing)
# and their intersection must be EMPTY.
#
# 🔴 THE SWEEP RUNS ON AN INDEPENDENT SCANNER, NOT ON `content_box`. 200-odd
# full measurements of a 1709x1314 PNG in pure Python is 90 s; this decodes each
# image ONCE and answers any chromeTop from the same sample grid. It is
# cross-checked against the code under test at three values first — if the two
# disagree the gate fails there, so the fast path can never quietly grade
# something else.
# ---------------------------------------------------------------------------
if python3 - "$SCRIPTS" "$FIX/5-mb-combinations.png" "$BANNER" >"${WORK}/f11.txt" 2>&1 <<'PY'
import json, subprocess, sys
sys.path.insert(0, sys.argv[1])
import frame as F
PLAIN, BANNER = sys.argv[2], sys.argv[3]
STRIDE, TOL, FOOTER, RIGHT = 4, 8, 110, 70
BG = (0x1a, 0x1b, 0x1e)
COLUMN = {"x": 252, "w": 1200, "h": 312}  # model-benchmarking's app column, unclipped, from the manifest
bad = []


def scan(png):
    w, h, px = F.png_decode(png)
    x1b, yb = w - RIGHT, h - FOOTER
    ext = {}
    for y in range(yb):
        base, lo, hi = y * w * 3, None, None
        for x in range(0, x1b, STRIDE):
            o = base + x * 3
            if (abs(px[o] - BG[0]) > TOL or abs(px[o + 1] - BG[1]) > TOL
                    or abs(px[o + 2] - BG[2]) > TOL):
                if lo is None:
                    lo = x
                hi = x
        ext[y] = (lo, hi)
    return x1b, yb, ext


def box_at(x1b, yb, ext, ct):
    rows = [y for y in range(ct, yb, STRIDE) if ext[y][0] is not None]
    if not rows:
        return None
    return {"x": min(ext[y][0] for y in rows), "y": rows[0],
            "w": min(max(ext[y][1] for y in rows) + STRIDE, x1b) - min(ext[y][0] for y in rows),
            "h": min(rows[-1] + STRIDE, yb) - rows[0]}


def correct(b):
    return bool(b) and all(b[k] == v for k, v in COLUMN.items())


windows = {}
for png in (PLAIN, BANNER):
    x1b, yb, ext = scan(png)
    # the cross-check: the fast scanner must agree with frame.py itself
    for ct in (170, 182, 205):
        p = subprocess.run(["python3", F.__file__, "measure", png, "--chrome-top",
                            str(ct), "--no-gate"], capture_output=True, text=True)
        if p.returncode != 0:
            bad.append("cross-check %s@%d did not measure: %s" % (png, ct, p.stderr[:80]))
            continue
        d = json.loads(p.stdout)
        if d["bg"] != "#1a1b1e":
            bad.append("cross-check %s@%d: background %s, the scanner assumes #1a1b1e"
                       % (png, ct, d["bg"]))
        if d["box"] != box_at(x1b, yb, ext, ct):
            bad.append("THE SWEEP IS GRADING SOMETHING ELSE: %s@%d frame.py=%s scanner=%s"
                       % (png, ct, d["box"], box_at(x1b, yb, ext, ct)))
    windows[png] = [ct for ct in range(120, 281) if correct(box_at(x1b, yb, ext, ct))]

plain, banner = windows[PLAIN], windows[BANNER]
if not plain:
    bad.append("POSITIVE CONTROL FAILED: no chromeTop is correct on the banner-ABSENT capture")
if not banner:
    bad.append("POSITIVE CONTROL FAILED: no chromeTop is correct on the banner-PRESENT capture")
overlap = sorted(set(plain) & set(banner))
if overlap:
    bad.append("A FIXED chromeTop DOES work for both (%s) — the premise of "
               "crop.fromAppFrame is false and this change should be reconsidered" % overlap[:6])
# the operator's exact symptom, pinned: the shipped value is right on one and
# refuses on the other, with the refusal naming the full-frame detector.
if 182 not in plain:
    bad.append("182 is no longer correct on the banner-absent capture")
if 182 in banner:
    bad.append("182 no longer fails on the banner-present capture")
p = subprocess.run(["python3", F.__file__, "measure", BANNER, "--chrome-top", "182"],
                   capture_output=True, text=True)
if p.returncode != 2 or "REFUSE[full_frame]" not in p.stderr:
    bad.append("the banner state at 182 must refuse with full_frame; got rc=%d %s"
               % (p.returncode, p.stderr[:90]))

# 🔴 THE GREEN ARM. One recipe, one set of floors, both layouts — because the
# rect moves with the banner. 163/199 are the iframe tops the two layouts really
# have (the full-width furniture above the app ends there).
#
# 🔴 THE RECIPE HERE IS custom-generators, NOT model-benchmarking, AND THE
# FIXTURE IS STILL AN mb CAPTURE. That pairing is deliberate and it is not a
# mismatch: on the DETECTION path a recipe contributes only its BAND FLOORS, and
# all three remaining detect recipes carry the identical 182/110/70 +
# fromAppFrame. What this arm grades is the band ARITHMETIC against the host
# page's conditional banner — a property of the `apps/run/<slug>` shell, not of
# any one app — so the fixture is just a PNG with a known column (COLUMN above,
# x=252 w=1200, which is mb's PRE-#16 centred column and is what makes it a
# usable detection fixture at all). model-benchmarking itself can no longer
# serve here: #16 uncapped its width, it is full-bleed, and it converted to a
# declared rect on 2026-08-29 — frame.py would return that rect verbatim and
# this arm would grade the rect path while asserting detection expectations.
# 🔴 custom-generators CONVERTED on 2026-09-04 to a declared yFrom-only rect, so
# this arm moved to gen-matrix — which the note this replaces predicted would be
# needed. Checked at the time of the move: gen-matrix and panorama-360 are the only
# remaining detect recipes and BOTH carry the identical 182/110/70 + fromAppFrame,
# so the substitution changes nothing this arm measures. 🔴 If gen-matrix ever
# converts, the next mover needs the same check — a detect recipe with these floors,
# not a rect one — or this arm silently grades the rect path while asserting
# detection expectations.
for png, top, want_y in ((PLAIN, 163, 194), (BANNER, 199, 231)):
    p = subprocess.run(["python3", F.__file__, "measure", png,
                        "--recipe", sys.argv[1] + "/recipes/gen-matrix.json",
                        "--app-frame-rect", "APPFRAME_RECT:%d,110,70,1709,1314" % top],
                       capture_output=True, text=True)
    if p.returncode != 0:
        bad.append("derived bands did not measure %s: %s" % (png, p.stderr[:120]))
        continue
    m = json.loads(p.stdout)
    if not correct(m["box"]):
        bad.append("derived bands gave the wrong box on %s: %s" % (png, m["box"]))
    if m["box"]["y"] != want_y:
        bad.append("derived bands on %s: y=%d, expected %d" % (png, m["box"]["y"], want_y))

print("plain window : %s..%s (%d values)" % (plain[0], plain[-1], len(plain)) if plain else "plain: EMPTY")
print("banner window: %s..%s (%d values)" % (banner[0], banner[-1], len(banner)) if banner else "banner: EMPTY")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "F11 🔴 THE PREMISE, MEASURED: sweeping chromeTop over both layouts gives two non-empty windows whose intersection is EMPTY — no fixed value can be right in both, the shipped 182 is right on one and REFUSES with full_frame on the other, and the SAME recipe measures both correctly once the band is derived from the iframe rect ($(sed -n '1,2p' "${WORK}/f11.txt" | tr '\n' ' '))"
else
  fail "F11: the disjoint-window claim, or the derived-band fix, does not hold"
  sed 's/^/          /' "${WORK}/f11.txt" | head -14
fi

# ---------------------------------------------------------------------------
# F12 — the injected probe's SOURCE. It runs in the MAIN world of a live,
# logged-in, mod-gated page and it interpolates a value taken from a RECIPE, so
# it gets the same treatment as the app-ready probe and the evidence probe: it
# may MEASURE and must not ACTUATE.
# ---------------------------------------------------------------------------
if python3 - "$SCRIPTS" >"${WORK}/f12.txt" 2>&1 <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import evidence
import frame as F
bad = []
js = F.app_frame_rect_js("model-benchmarking.civit.ai")

# 🔴 THE LEDGER, not a copy. frame.py is dependency-free on purpose, so it keeps
# its own ban list — which means a token added to evidence.PROBE_FORBIDDEN could
# go unbanned here and nothing would say so. This is what says so.
missing = [t for t in evidence.PROBE_FORBIDDEN if t not in F.RECT_JS_FORBIDDEN]
if missing:
    bad.append("RECT_JS_FORBIDDEN does not cover evidence.PROBE_FORBIDDEN: %s" % missing)
for tok in F.RECT_JS_FORBIDDEN:
    if tok in js:
        bad.append("the probe carries the forbidden token %r" % tok)
# the guard must be able to FIRE, or the clean result above is a fact about the
# string and not about the guard.
try:
    F.guard_rect_js('(function(){document.querySelector("x").click()})()')
    bad.append("guard_rect_js accepted a probe that clicks — it is inert")
except F.Refuse as e:
    if e.code != "rect_js_actuates":
        bad.append("guard_rect_js refused with %s" % e.code)

if "\n" in js or "\r" in js:
    bad.append("the probe is not ONE LINE — capture.sh hands it over as a single argv element")
# all three handles are present: a rename of any one of them is not an outage
for needle in ('data-testid="app-page-iframe"', "getElementsByTagName", "indexOf(H)"):
    if needle not in js:
        bad.append("the probe lost the handle %r" % needle)
# the recipe's host really reaches the probe, and is JSON-escaped on the way
if '"model-benchmarking.civit.ai"' not in js:
    bad.append("the frameHost is not interpolated into the probe")
if '"' not in F.app_frame_rect_js('a"b'):
    bad.append("the frameHost is not escaped — a quote in a recipe would break the JS")
# 🔴 ASYMMETRIC ROUNDING, and it is load-bearing: a half-pixel rounded the wrong
# way readmits the bottom border row of the full-width bar above the iframe.
if "Math.ceil(r.top" not in js:
    bad.append("the TOP gap is not ceil()'d — the rect would not be inscribed")
if js.count("Math.floor") != 2:
    bad.append("the two far-edge gaps are not both floor()'d")
# 🔴 THE LEFT INSET ROUNDS LIKE THE TOP, NOT LIKE THE FAR EDGES. It is a NEAR
# edge — an anchor that `x` is added to — so rounding it outwards would put the
# crop's first column in the host page. Asserted separately from the count above
# because `Math.ceil` now appears twice and a count alone cannot say which two.
if "Math.ceil(r.left" not in js:
    bad.append("the LEFT inset is not ceil()'d — an x-anchored crop would start "
               "outside the app frame by up to a pixel")
if js.count("Math.ceil") != 2:
    bad.append("expected exactly two ceil()'d NEAR edges (top and left), got %d"
               % js.count("Math.ceil"))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  # the EXECUTED arm, when a JS engine is available. It is additive: the
  # structural assertions above always run.
  if command -v node >/dev/null 2>&1; then
    python3 "$FRAME" frame-rect-js --recipe "$RECIPES/model-benchmarking.json" >"${WORK}/rect.js" 2>/dev/null
    if node -e '
const src=require("fs").readFileSync(process.argv[1],"utf8").trim();
const mk=(f)=>{global.document={querySelector:()=>null,getElementsByTagName:()=>f};
               global.window={devicePixelRatio:1,innerHeight:1314,innerWidth:1709};
               const d=global.document,w=global.window; return eval(src);};
const hit=mk([{getAttribute:()=>"https://model-benchmarking.civit.ai/",
               getBoundingClientRect:()=>({top:200.4,bottom:1500.2,right:1694.6,left:60.3})}]);
if(hit!=="APPFRAME_RECT:201,-187,14,1709,1314,61") throw new Error("measured arm: "+hit);
const none=mk([]);
if(none!=="APPFRAME_ABSENT") throw new Error("absent arm: "+none);
' "${WORK}/rect.js" >"${WORK}/f12node.txt" 2>&1; then
      pass "F12: the app-frame probe cannot actuate (its ban list COVERS evidence.PROBE_FORBIDDEN, and the guard was watched refusing a clicking probe), is one line, carries all three iframe handles, escapes the recipe's host, rounds the top up and the far edges down — and was EXECUTED under node on both arms: a 200.4px top comes back as 201 and an iframe-less page as APPFRAME_ABSENT"
    else
      fail "F12: the probe does not evaluate correctly under node"
      sed 's/^/          /' "${WORK}/f12node.txt" | head -6
    fi
  else
    pass "F12: the app-frame probe cannot actuate (ban list COVERS evidence.PROBE_FORBIDDEN, guard watched refusing a clicking probe), is one line, carries all three iframe handles, escapes the recipe's host and rounds asymmetrically — STRUCTURAL ARMS ONLY, the executed arm was skipped because node is not on PATH (nix-shell -p nodejs to get it)"
  fi
else
  fail "F12: the app-frame probe's source is wrong"
  sed 's/^/          /' "${WORK}/f12.txt" | head -10
fi

# ---------------------------------------------------------------------------
# F13 🔴 THE FRAME-RELATIVE DECLARED RECT, GRADED ON PIXELS.
#
# The third crop form (infra ticket #1297): a DECLARED rect whose `y` is measured
# down from the app iframe's top edge. It exists because the two older forms
# cannot both be had on a scrolling, content-dense app — detection refuses with
# `full_frame` (app-requests 46.9% x 98.3%, playable-collections 63.9% x 100.0%)
# and a plain declared rect is ABSOLUTE, so it is wrong by the conditional
# rewards banner's ~36px in the other layout.
#
# 🔴 THE CLAIM IS ABOUT CONTENT, SO IT IS GRADED ON CONTENT. Asserting the two
# resolved y values (194 and 230) only restates the arithmetic this file already
# performs. What has to be true is that the SAME declared rect photographs the
# SAME PIXELS in both layouts — so both crops are extracted and compared byte for
# byte, with the ABSOLUTE form as the negative control: if that one also matched,
# the marker would be doing nothing and this gate would be measuring addition.
# ---------------------------------------------------------------------------
if python3 - "$SCRIPTS" "$FIX/5-mb-combinations.png" "$BANNER" "${WORK}" >"${WORK}/f13.txt" 2>&1 <<'PY'
import hashlib, json, os, subprocess, sys
SCRIPTS, PLAIN, BANNER, WORK = sys.argv[1:5]
sys.path.insert(0, SCRIPTS)
import frame as F
bad = []

# model-benchmarking's own app column. 194 - 163 = 31 down from the iframe top.
REL = {"x": 252, "y": 31, "w": 1200, "h": 312, "yFrom": "appFrame"}
ABSOLUTE = {"x": 252, "y": 194, "w": 1200, "h": 312}
LAYOUTS = ((PLAIN, 163, 194), (BANNER, 199, 230))
BASE = json.load(open(os.path.join(SCRIPTS, "recipes", "model-benchmarking.json")))


def recipe(name, rect, from_app_frame, viewport=(1709, 1314)):
    r = json.loads(json.dumps(BASE))
    r["crop"] = {"chromeTop": 182, "footer": 110, "right": 70}
    if from_app_frame:
        r["crop"]["fromAppFrame"] = True
    if rect is not None:
        r["crop"]["rect"] = rect
        # 🔴 EVERY DECLARED RECT MUST RECORD THE VIEWPORT IT WAS MEASURED IN, and
        # here that is the FIXTURES' own 1709x1314 — these rects were chosen
        # against these files, so recording anything else would be the drift the
        # record exists to catch. `viewport=None` is the deliberate omission,
        # used by section 6 to prove the omission is REFUSED rather than skipped.
        if viewport is not None:
            r["crop"]["_measuredGeometry"] = {"viewport": list(viewport)}
    p = os.path.join(WORK, "f13-%s.json" % name)
    json.dump(r, open(p, "w"))
    return p


def run(cmd, png, rec, top, extra=()):
    argv = ["python3", F.__file__, cmd, png, "--recipe", rec] + list(extra)
    if top is not None:
        argv += ["--app-frame-rect", "APPFRAME_RECT:%d,110,70,1709,1314" % top]
    return subprocess.run(argv, capture_output=True, text=True)


def pixels(png, r):
    """The cropped region's raw bytes. Decoded with frame.py's own reader — the
    thing under test is WHICH region was chosen, not how a PNG is unpacked."""
    w, _h, px = F.png_decode(png)
    return b"".join(bytes(px[(r["y"] + i) * w * 3 + r["x"] * 3:
                             (r["y"] + i) * w * 3 + (r["x"] + r["w"]) * 3])
                    for i in range(r["h"]))


rec_rel = recipe("rel", REL, True)
rec_abs = recipe("abs", ABSOLUTE, False)

# 1. the resolution itself, through the CLI, in both layouts
boxes = {}
for png, top, want_y in LAYOUTS:
    p = run("measure", png, rec_rel, top)
    if p.returncode != 0:
        bad.append("frame-relative rect did not measure %s: %s"
                   % (os.path.basename(png), p.stderr[:160]))
        continue
    m = json.loads(p.stdout)
    boxes[png] = m["box"]
    want = {"x": 252, "y": want_y, "w": 1200, "h": 312}
    if m["box"] != want:
        bad.append("%s: box %s, wanted %s" % (os.path.basename(png), m["box"], want))
    if m.get("mode") != "declared":
        bad.append("%s: mode %r, a declared rect must still say so (check_states "
                   "exempts on it)" % (os.path.basename(png), m.get("mode")))
    res = m.get("resolved") or {}
    if res.get("appFrameTop") != top or res.get("declaredY") != REL["y"]:
        bad.append("%s: the resolution is not REPORTED (%s) — an operator has no other "
                   "way to tell a working anchor from a rect that landed plausibly"
                   % (os.path.basename(png), res))
    # 🔴 measure and render must not drift: they did once, over this same path.
    p = run("render", png, rec_rel, top, ["--out", os.path.join(WORK, "f13.png")])
    if p.returncode != 0:
        bad.append("render refused a rect measure accepted on %s: %s"
                   % (os.path.basename(png), p.stderr[:120]))
    elif json.loads(p.stdout)["crop"] != want:
        bad.append("render cropped %s, measure said %s"
                   % (json.loads(p.stdout)["crop"], want))

# 🔴 the gate is not vacuous only if the two layouts really disagree
if len(boxes) == 2 and len(set(b["y"] for b in boxes.values())) != 2:
    bad.append("both layouts resolved to the SAME y — the fixtures are not two layouts")

# 2. THE CLAIM: the same declared rect photographs the same pixels.
if len(boxes) == 2:
    got = [hashlib.sha256(pixels(png, boxes[png])).hexdigest() for png, _t, _y in LAYOUTS]
    if got[0] != got[1]:
        bad.append("THE TWO LAYOUTS CROPPED DIFFERENT PIXELS (%s vs %s) — the anchor "
                   "does not follow the banner" % (got[0][:12], got[1][:12]))
    # negative control: the ABSOLUTE form, the very thing this replaces
    ctl = hashlib.sha256(pixels(BANNER, ABSOLUTE)).hexdigest()
    if ctl == got[0]:
        bad.append("THE NEGATIVE CONTROL MATCHED TOO: an absolute rect crops the same "
                   "pixels in both layouts, so this gate cannot see the marker working "
                   "and the whole form is unnecessary")

# 3. the absolute form really is wrong here — measured through the CLI, not argued
p = run("measure", BANNER, rec_abs, None)
if p.returncode != 0:
    bad.append("the absolute-rect control did not measure: %s" % p.stderr[:120])
elif json.loads(p.stdout)["box"]["y"] != 194:
    bad.append("the absolute control moved: %s" % json.loads(p.stdout)["box"])

# 4. THE GATES RUN ON THE RESOLVED VALUE, NOT THE DECLARED ONE. A rect that fits
#    in one layout and runs off the bottom in the other must be accepted in the
#    first and REFUSED in the second — the same JSON, both verdicts.
#
#    🔴 THE BINDING LIMIT IS THE IFRAME, NOT THE PNG, so the arithmetic is against
#    1314 - 110 = 1204 and the window is narrow: y must satisfy
#    163+y+312 <= 1204 (fits, absent) AND 199+y+312 > 1204 (refuses, present),
#    i.e. 694..729. 720 sits inside it with room either side. An earlier draft
#    used 820 against the FRAME height and stopped discriminating the moment the
#    iframe bound landed — the fixture has to be re-derived when a bound moves,
#    which is what that caught.
tall = recipe("tall", dict(REL, y=720), True)
p = run("measure", PLAIN, tall, 163)
if p.returncode != 0:
    bad.append("y=720 must FIT the banner-absent layout (163+720+312=1195 <= 1204): %s"
               % p.stderr[:160])
p = run("measure", BANNER, tall, 199)
if p.returncode != 2 or "REFUSE[crop_rect_outside]" not in p.stderr:
    bad.append("the SAME rect must run off the bottom of the banner layout "
               "(199+720+312=1231 > 1204); got rc=%d %s" % (p.returncode, p.stderr[:160]))
elif "RESOLVED" not in p.stderr:
    # 🔴 NO NUMBER IN THIS SENTENCE, DELIBERATELY. It named 1331 (a superseded
    # draft's figure), was "corrected" to 1231 by copying the arithmetic comment
    # two lines up, and 1231 was ALSO wrong — the y the message actually prints is
    # 919, the RESOLVED top edge, not the bottom the comment computes. Two audit
    # rounds, two wrong numbers, both plausible. A figure maintained in parallel
    # with the thing it describes drifts; the assertion does not need one.
    bad.append("the off-frame refusal does not say the y it names is the RESOLVED "
               "one — the reader will go looking for that number in the recipe and "
               "not find it. Message was: %s" % p.stderr.strip()[:200])

# 5. a NEGATIVE top gap (a scrolled page) must refuse, not resolve upwards
p = run("measure", PLAIN, rec_rel, None,
        ["--app-frame-rect", "APPFRAME_RECT:-40,110,70,1709,1314"])
if p.returncode != 2 or "REFUSE[crop_rect_outside]" not in p.stderr:
    bad.append("a negative app-frame top must refuse; got rc=%d %s"
               % (p.returncode, p.stderr[:120]))

# 5b. 🔴 THE IFRAME'S OWN BOTTOM EDGE BOUNDS THE RECT, not just the PNG. A rect
#     anchored to the TOP can otherwise run past the app and photograph the page
#     footer below it — and the probe already reports the number that catches it.
#     163 + 31 + 312 = 506 fits the 1314 frame either way; what separates the two
#     is a SHORT iframe, so the fixture must make the iframe the binding limit.
p = run("measure", PLAIN, rec_rel, None,
        ["--app-frame-rect", "APPFRAME_RECT:163,900,70,1709,1314"])
if p.returncode != 2 or "REFUSE[crop_rect_outside]" not in p.stderr:
    bad.append("a rect running past the IFRAME's lower edge (top=163 bottom-gap=900 "
               "leaves a 251px iframe; the rect needs 343) was accepted — it would put "
               "page furniture below the app into the asset; got rc=%d %s"
               % (p.returncode, p.stderr[:160]))
elif "IFRAME'S OWN lower edge" not in p.stderr:
    bad.append("the refusal does not say the binding limit was the IFRAME, so the "
               "reader will check the rect against the frame height and find it fits")
# ...and the POSITIVE CONTROL, or the arm above only proves the number is small:
# the same rect with a bottom gap that leaves room must still measure.
p = run("measure", PLAIN, rec_rel, None,
        ["--app-frame-rect", "APPFRAME_RECT:163,100,70,1709,1314"])
if p.returncode != 0:
    bad.append("a rect that FITS inside the iframe was refused by the new bottom "
               "bound: %s" % p.stderr[:160])
# a NEGATIVE bottom gap = the iframe runs past the viewport, so the PNG edge is
# the real limit and the degenerate reading must LOSE rather than refuse.
p = run("measure", PLAIN, rec_rel, None,
        ["--app-frame-rect", "APPFRAME_RECT:163,-187,70,1709,1314"])
if p.returncode != 0:
    bad.append("a negative bottom gap (an iframe taller than the viewport) must lose "
               "to the frame edge, not tighten it: %s" % p.stderr[:160])
# 🔴 ...AND THAT ARM ALONE IS AN INVARIANT GUARD, NOT A DISCRIMINATING ONE. A
# 312px rect fits whether or not the `max(0, …)` clamp is there, so the
# acceptance above is green with the clamp DELETED — measured. The clamp only
# does work when a negative gap would push the limit PAST the frame: without it,
# bottom=-187 makes the limit 1314+187=1501 and a crop ending at row 1363 is
# accepted on a 1314-row PNG, 49px off the bottom of the photograph. So feed a
# rect that lands in exactly that window and require a REFUSAL.
p = run("measure", PLAIN, recipe("overrun", dict(REL, y=0, h=1200), True), None,
        ["--app-frame-rect", "APPFRAME_RECT:163,-187,70,1709,1314"])
if p.returncode != 2 or "REFUSE[crop_rect_outside]" not in p.stderr:
    bad.append("a rect ending at row 1363 on a 1314-row capture was ACCEPTED under a "
               "negative bottom gap — the max(0, …) clamp is inert and a degenerate "
               "probe reading can push the bound PAST the frame; got rc=%d %s"
               % (p.returncode, p.stderr[:160]))

# 5c. 🔴 THE VIEWPORT CROSS-CHECK RUNS ON THE DECLARED PATH TOO — resolve_bands'
#     docstring calls it load-bearing, and nothing pinned it. It is the only
#     check on a devicePixelRatio this module cannot see, and a rect anchored to
#     an edge measured in the wrong units is exactly as wrong as a band derived
#     from one. Watched at the boundary in both directions.
p = run("measure", PLAIN, rec_rel, None,
        ["--app-frame-rect", "APPFRAME_RECT:163,110,70,854,657"])
if p.returncode != 2 or "REFUSE[app_frame_scale]" not in p.stderr:
    bad.append("a HALF-SCALE viewport reading was accepted on the declared path — the "
               "DPR cross-check is inert there; got rc=%d %s"
               % (p.returncode, p.stderr[:160]))
p = run("measure", PLAIN, rec_rel, None,
        ["--app-frame-rect", "APPFRAME_RECT:163,110,70,1711,1316"])
if p.returncode != 0:
    bad.append("2px of DPR rounding must still be tolerated on the declared path: %s"
               % p.stderr[:160])

# 6. the DEFENSIVE guard in declared_box. Unreachable through the CLI — the seam
#    in app_frame_from refuses first — but declared_box is a module entry point
#    and `app_frame[0]` on None is a traceback where the caller wants a sentence.
try:
    F.declared_box(PLAIN, REL, 182, 110, 70, None, (1709, 1314))
    bad.append("declared_box resolved a frame-relative rect with NO app-frame rect")
except F.Refuse as e:
    if e.code != "app_frame_rect_missing":
        bad.append("declared_box refused a missing app-frame rect with %s" % e.code)

# 7. the marker's own validation, in the pure module
for rect, why in ((dict(REL, yFromm="appFrame"), "a misspelt marker key"),
                  (dict(REL, yFrom="iframe"), "an unsupported yFrom value"),
                  (dict(REL, yFrom=True), "a boolean yFrom")):
    try:
        F.rect_is_frame_relative(rect)
        bad.append("%s was ACCEPTED — it degrades silently to an absolute rect" % why)
    except F.Refuse as e:
        if e.code != "crop_rect_invalid":
            bad.append("%s refused with %s" % (why, e.code))
if F.rect_is_frame_relative(ABSOLUTE):
    bad.append("an unmarked rect was read as frame-relative")
if not F.rect_is_frame_relative(dict(REL, _comment="recipes comment like this")):
    bad.append("a `_`-prefixed comment key broke the marker")
# 🔴 `isinstance(True, int)` is True in Python, so a JSON `"x": true` used to be
# accepted as the coordinate 1 and cropped a 1px-offset region without a word.
try:
    F.declared_box(PLAIN, dict(ABSOLUTE, x=True), 182, 110, 70, None, (1709, 1314))
    bad.append("a BOOLEAN coordinate was accepted as an int — JSON true would crop at x=1")
except F.Refuse as e:
    if e.code != "crop_rect_invalid":
        bad.append("a boolean coordinate refused with %s" % e.code)

# 8. 🔴 `measured_viewport` IS A REQUIRED POSITIONAL, NOT A DEFAULT. A keyword
#    default is a way to call this path unguarded, and the whole defect class is
#    a check that can be satisfied by not supplying its operand.
#
#    🔴 A BARE `except TypeError: pass` CANNOT SEE THIS, and the first draft of
#    this arm was exactly that — mutant M191 (add `measured_viewport=None`)
#    SURVIVED it. With the default in place the short call reaches the body,
#    `vw, vh = None` raises TypeError too, and the handler swallows it: the guard
#    passed on the very mutation it was written for. So BOTH halves, and the
#    behavioural one asserts WHICH TypeError:
#      - structural: the parameter carries no default at all (`inspect`);
#      - behavioural: the short call fails NAMING the missing parameter, which
#        an unpack of None does not ("cannot unpack non-iterable NoneType").
import inspect
_sig = inspect.signature(F.declared_box).parameters
if "measured_viewport" not in _sig:
    bad.append("declared_box has no measured_viewport parameter at all — the "
               "viewport-of-record gate has no operand to read")
elif _sig["measured_viewport"].default is not inspect.Parameter.empty:
    bad.append("declared_box's measured_viewport carries a default (%r) — a default "
               "is a way to call this path with no record, i.e. a bypass no CLI test "
               "can see" % (_sig["measured_viewport"].default,))
try:
    F.declared_box(PLAIN, REL, 182, 110, 70, None)
    bad.append("declared_box accepted a call with NO measured viewport — the operand "
               "the viewport-of-record gate needs is optional, so the gate is opt-in")
except TypeError as e:
    if "measured_viewport" not in str(e):
        bad.append("the short call raised a TypeError that does NOT name "
                   "measured_viewport (%s) — it got INTO the body and died on the "
                   "missing operand instead of being rejected at the call, which is "
                   "how a default hides here" % e)
except F.Refuse as e:
    bad.append("declared_box has a default for measured_viewport (it refused with %s "
               "instead of rejecting the call) — a default is a bypass" % e.code)

print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "F13 🔴 THE FRAME-RELATIVE RECT, GRADED ON PIXELS: one declared rect resolves to y=194 in the banner-absent layout and y=230 in the banner-present one and crops BYTE-IDENTICAL content in both — with the absolute form as the negative control (it does not, which is why the form exists); render agrees with measure; the frame gates run on the RESOLVED y, so the same JSON is accepted in one layout and REFUSED off the bottom in the other; a negative top gap (a scrolled page) refuses; and a misspelt marker, a wrong yFrom value and a missing app-frame rect each refuse rather than degrading silently to an absolute rect"
else
  fail "F13: the frame-relative declared rect does not track the banner"
  sed 's/^/          /' "${WORK}/f13.txt" | head -14
fi

# F13b — the two SEAM directions for the new form, through the CLI.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
r["crop"]={"chromeTop":182,"footer":110,"right":70,
           "rect":{"x":252,"y":31,"w":1200,"h":312,"yFrom":"appFrame"}}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/model-benchmarking.json" "${WORK}/rec-rel-noafr.json"
expect_refuse "F13b NEG: a frame-relative rect in a recipe that does NOT set fromAppFrame is refused — nothing would run the probe, so the rect would be read as ABSOLUTE and be wrong by the banner's ~36px in one layout" crop_rect_invalid -- \
  python3 "$FRAME" measure "$FIX/5-mb-combinations.png" --recipe "${WORK}/rec-rel-noafr.json"
python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
r["crop"]={"chromeTop":182,"footer":110,"right":70,"fromAppFrame":True,
           "rect":{"x":252,"y":31,"w":1200,"h":312,"yFrom":"appFrame"}}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/model-benchmarking.json" "${WORK}/rec-rel-ok.json"
expect_refuse "F13c NEG: the frame-relative form still needs the rect ITSELF — fromAppFrame with no --app-frame-rect refuses rather than falling back" app_frame_rect_missing -- \
  python3 "$FRAME" measure "$FIX/5-mb-combinations.png" --recipe "${WORK}/rec-rel-ok.json"

# F13d 🔴 BOTH SIDES OF THE capture.sh SEAM, AS A LEDGER. `resolve_bands` says in
# its own docstring that reading the app-frame rect twice is how `measure` and
# `render` come to disagree — but nothing asserted that capture.sh hands it to
# BOTH. Dropping it from the RENDER call survives the whole suite (no gate here
# drives `--render` end to end), and the failure is a render silently anchored to
# nothing on a recipe that declares a frame-relative rect. This pins the SET: it
# fails if a call site is added without the flag as readily as if one loses it.
f13d="${WORK}/f13d.txt"
{ grep -nF -- '--app-frame-rect "$OUT/$st.rect.json"' "$SCRIPTS/capture.sh" || true; } >"$f13d"
n13d="$(wc -l <"$f13d" | tr -d ' ')"
g13d="$(grep -cF -- '${USE_APPFRAME:+--app-frame-rect "$OUT/$st.rect.json"}' "$SCRIPTS/capture.sh" || true)"
if [ "$n13d" = 2 ] && [ "$g13d" = 2 ]; then
  pass "F13d: capture.sh passes the app-frame rect to BOTH frame.py invocations that consume it (measure and render), each behind the same \`\${USE_APPFRAME:+…}\` conditional — a set assertion, so adding a third consumer without it fails here too"
else
  fail "F13d: the app-frame rect reaches $n13d frame.py call site(s) ($g13d guarded), expected 2 and 2 — measure and render must anchor to the SAME edge or a declared rect is resolved differently in each"
  sed 's/^/          /' "$f13d" | head -4
fi

# ---------------------------------------------------------------------------
# F14 🔴 THE HORIZONTAL ANCHOR, GRADED ON PIXELS AT TWO WINDOW WIDTHS.
#
# F13 is this gate's vertical twin and the reasoning is the same, one axis over.
# What makes the horizontal axis its own problem is that until 2026-09-02 the
# app-frame probe reported no LEFT edge and no WIDTH — only `top, bottomGap,
# rightGap, viewportW, viewportH` — so `x` and `w` had no live witness of any
# kind and their only bound was `x + w > pngWidth`, which a WIDER window makes
# LOOSER. That is the incident C5 reproduces. `viewport_of_record` converted it
# into a refusal; this converts it into a rect that does not need one.
#
# 🔴 THE CLAIM IS ABOUT CONTENT, SO IT IS GRADED ON CONTENT, exactly as in F13:
# the SAME declared rect, with the SAME record, must photograph the SAME PIXELS
# at 1709 and at 2509 — with the ABSOLUTE form as the negative control. If the
# control matched too, the markers would be doing nothing and this gate would be
# measuring addition.
#
# 🔴 AND THE THING THE FIXTURE CANNOT SAY. framewiden.py builds the second window
# by TRANSLATING the frame's pixels, so "the app does not move relative to its
# frame" is true by construction here and is not evidence about any real app —
# a real app can reflow inside a constant-width frame, and nothing in this repo
# would show that. `frame_of_record` is what refuses a frame of a DIFFERENT
# width, which is the observable that reflow has that this fixture does not.
# ---------------------------------------------------------------------------
WIDE="${WORK}/wide-mb-combinations.png"
# 🔴 THE FIXTURE'S OWN CLAIM IS CHECKED HERE, not merely asserted in a pass
# message. F14 leans on "the frame's pixels are carried across byte for byte", so
# a band of the wide file is compared with the source's — decoded independently of
# which region frame.py would choose — plus a control that the INSERTED columns
# are NOT the same ink, or a fixture that produced a flat image would pass this.
if python3 "${FIX}/framewiden.py" "$FIX/5-mb-combinations.png" "$WIDE" --pad 400 \
     >"${WORK}/fwiden.txt" 2>&1 && [ -s "$WIDE" ] \
   && python3 - "$SCRIPTS" "$FIX/5-mb-combinations.png" "$WIDE" >>"${WORK}/fwiden.txt" 2>&1 <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import frame as F
sw, sh, spx = F.png_decode(sys.argv[2])
ww, wh, wpx = F.png_decode(sys.argv[3])
PAD = 400
bad = []
if (ww, wh) != (sw + 2 * PAD, sh):
    bad.append("the wide capture is %dx%d, expected %dx%d" % (ww, wh, sw + 2 * PAD, sh))
else:
    moved = same = 0
    for r in range(0, sh, 97):                      # a coprime stride: every band
        a = bytes(spx[r * sw * 3:(r * sw + sw) * 3])
        b = bytes(wpx[(r * ww + PAD) * 3:(r * ww + PAD + sw) * 3])
        moved += (a == b)
        # the CONTROL: the inserted columns must differ from the frame's own first
        # column, or "identical" below would be a statement about a flat image.
        same += (bytes(wpx[r * ww * 3:r * ww * 3 + 3])
                 == bytes(wpx[(r * ww + PAD) * 3:(r * ww + PAD) * 3 + 3]))
    rows = len(range(0, sh, 97))
    if moved != rows:
        bad.append("%d of %d sampled rows carry the source band unchanged at +%d — the "
                   "fixture does not translate the frame" % (moved, rows, PAD))
    if same == rows:
        bad.append("the inserted host ink is identical to the frame's first column on "
                   "every sampled row — the fixture cannot show a crop landing outside "
                   "the frame, so the equivalence arm would pass on a flat image")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "F14-fixture: the wider-window layout is CUT FROM the same real capture by inserting 400 columns of host ink at EACH of the app frame's edges — MEASURED here, not assumed: every sampled row of the source band reappears byte-identical 400 columns right in a capture 800px wider, and the inserted ink differs from the frame's own first column (without that control the comparison would pass on a flat image). That is the max-width-container shape the operator's re-tiling really produces, not a synthesised page"
else
  fail "F14-fixture: framewiden.py did not produce a faithful wider-window capture"
  sed 's/^/          /' "${WORK}/fwiden.txt" | head -6
fi

if python3 - "$SCRIPTS" "$FIX/5-mb-combinations.png" "$WIDE" "$WORK" "$MKPNG" \
     >"${WORK}/f14.txt" 2>&1 <<'PY'
import hashlib, json, os, subprocess, sys
SCRIPTS, NARROW, WIDE, WORK, MKPNG = sys.argv[1:6]
sys.path.insert(0, SCRIPTS)
import frame as F
bad = []

PAD, NARROW_W, WIDE_W, VH = 400, 1709, 2509, 1314
FRAME_W = NARROW_W                    # unchanged by construction — the whole point
TOP, BOTTOM = 163, 110
BASE = json.load(open(os.path.join(SCRIPTS, "recipes", "model-benchmarking.json")))

# 🔴 UNDER `wFrom` THE NUMBER 257 IS A GAP, NOT A WIDTH. 1709 - 252 - 257 = 1200,
# which is F13's width, so the two gates crop comparable regions and a reader can
# hold both in mind at once.
FULL = {"x": 252, "y": 31, "w": 257, "h": 312,
        "xFrom": "appFrame", "yFrom": "appFrame", "wFrom": "appFrameRight"}
XONLY = {"x": 252, "y": 31, "w": 1200, "h": 312,
         "xFrom": "appFrame", "yFrom": "appFrame"}
ABSOLUTE = {"x": 252, "y": 194, "w": 1200, "h": 312}


def recipe(name, rect, viewport=(NARROW_W, VH), frame_w=FRAME_W, from_app_frame=True):
    r = json.loads(json.dumps(BASE))
    r["crop"] = {"chromeTop": 182, "footer": 110, "right": 70}
    if from_app_frame:
        r["crop"]["fromAppFrame"] = True
    r["crop"]["rect"] = rect
    geo = {}
    if viewport is not None:
        geo["viewport"] = list(viewport)
    if frame_w is not None:
        geo["appFrameW"] = frame_w
    if geo:
        r["crop"]["_measuredGeometry"] = geo
    p = os.path.join(WORK, "f14-%s.json" % name)
    json.dump(r, open(p, "w"))
    return p


def probe(top=TOP, bottom=BOTTOM, right=0, vw=NARROW_W, vh=VH, left=0, six=True):
    n = [top, bottom, right, vw, vh] + ([left] if six else [])
    return "APPFRAME_RECT:" + ",".join(str(v) for v in n)


NARROW_PROBE = probe()
WIDE_PROBE = probe(right=PAD, vw=WIDE_W, left=PAD)


def run(cmd, png, rec, pr, extra=()):
    argv = ["python3", F.__file__, cmd, png, "--recipe", rec] + list(extra)
    if pr is not None:
        argv += ["--app-frame-rect", pr]
    return subprocess.run(argv, capture_output=True, text=True)


def refuses(label, code, png, rec, pr, needle=None, extra=()):
    p = run("measure", png, rec, pr, extra)
    if p.returncode != 2 or ("REFUSE[%s]" % code) not in p.stderr:
        bad.append("%s: wanted REFUSE[%s], got rc=%d %s"
                   % (label, code, p.returncode, (p.stderr or p.stdout)[:200]))
    elif needle and needle not in p.stderr:
        bad.append("%s: refused with the right code but the sentence does not carry "
                   "%r — %s" % (label, needle, p.stderr.strip()[:200]))


def pixels(png, r):
    """The cropped region's raw bytes, via frame.py's own reader — what is under
    test is WHICH region was chosen, not how a PNG is unpacked."""
    w, _h, px = F.png_decode(png)
    return b"".join(bytes(px[(r["y"] + i) * w * 3 + r["x"] * 3:
                             (r["y"] + i) * w * 3 + (r["x"] + r["w"]) * 3])
                    for i in range(r["h"]))


# 0. THE PREMISE. Two different window widths, one frame width. If the fixture is
#    not that, nothing below means anything.
if F.image_size(NARROW) != (NARROW_W, VH) or F.image_size(WIDE) != (WIDE_W, VH):
    bad.append("the fixture pair is %s / %s, not %dx%d / %dx%d — F14 cannot speak"
               % (F.image_size(NARROW), F.image_size(WIDE), NARROW_W, VH, WIDE_W, VH))

# 1. THE HEADLINE: ONE rect, ONE record, both windows.
rec_full = recipe("full", FULL)
WANT = {NARROW: {"x": 252, "y": 194, "w": 1200, "h": 312},
        WIDE: {"x": 652, "y": 194, "w": 1200, "h": 312}}
boxes = {}
for png, pr in ((NARROW, NARROW_PROBE), (WIDE, WIDE_PROBE)):
    p = run("measure", png, rec_full, pr)
    if p.returncode != 0:
        bad.append("the fully anchored rect did not measure %s: %s"
                   % (os.path.basename(png), p.stderr[:200]))
        continue
    m = json.loads(p.stdout)
    boxes[png] = m["box"]
    if m["box"] != WANT[png]:
        bad.append("%s: box %s, wanted %s" % (os.path.basename(png), m["box"], WANT[png]))
    res = m.get("resolved") or {}
    # 🔴 THE RESOLUTION IS REPORTED PER ANCHOR. `box.x` and `box.w` are the two
    # numbers this form does not state, so without these an operator cannot tell
    # a working anchor from a rect that landed plausibly — F13's lesson, on the
    # axis that has two of them.
    want_res = {"xFrom": "appFrame", "declaredX": 252, "wFrom": "appFrameRight",
                "declaredW": 257, "resolvedW": 1200, "yFrom": "appFrame",
                "declaredY": 31, "appFrameTop": TOP}
    for k, v in want_res.items():
        if res.get(k) != v:
            bad.append("%s: resolved[%r] = %r, wanted %r (full report: %s)"
                       % (os.path.basename(png), k, res.get(k), v, res))
    # measure and render must not drift — they did once, over this same path
    p = run("render", png, rec_full, pr, ["--out", os.path.join(WORK, "f14.png")])
    if p.returncode != 0:
        bad.append("render refused a rect measure accepted on %s: %s"
                   % (os.path.basename(png), p.stderr[:160]))
    elif json.loads(p.stdout)["crop"] != WANT[png]:
        bad.append("render cropped %s, measure said %s"
                   % (json.loads(p.stdout)["crop"], WANT[png]))

# the gate is not vacuous only if the two windows really disagree about x
if len(boxes) == 2 and len(set(b["x"] for b in boxes.values())) != 2:
    bad.append("both windows resolved to the SAME x — the fixture is not two windows")

# 2. THE CLAIM: the same rect photographs the same pixels. Plus the control.
if len(boxes) == 2:
    got = [hashlib.sha256(pixels(p, boxes[p])).hexdigest() for p in (NARROW, WIDE)]
    if got[0] != got[1]:
        bad.append("THE TWO WINDOWS CROPPED DIFFERENT PIXELS (%s vs %s) — the "
                   "horizontal anchor does not follow the frame" % (got[0][:12], got[1][:12]))
    ctl = hashlib.sha256(pixels(WIDE, ABSOLUTE)).hexdigest()
    if ctl == got[0]:
        bad.append("THE NEGATIVE CONTROL MATCHED TOO: an ABSOLUTE rect crops the same "
                   "pixels at both widths, so this gate cannot see the markers working "
                   "and the whole form is unnecessary")

# 3. 🔴 `viewport_of_record` IS RE-BASED FOR THIS FORM, NOT REMOVED — and both
#    halves of that sentence are asserted. The width axis is graded against the
#    APP FRAME (arm 1 above ran the same record at 1709 and 2509 and passed), and
#    a frame of a DIFFERENT width still refuses. Watched at the tolerance
#    boundary on both sides, because "it refuses on a big change" is satisfied by
#    a check with any slack at all.
for dl, want in ((0, 0), (2, 0), (-2, 0), (3, 2), (-3, 2), (200, 2)):
    pr = probe(right=PAD, vw=WIDE_W, left=PAD + dl)
    p = run("measure", WIDE, rec_full, pr)
    if p.returncode != want:
        bad.append("a frame %+dpx off the recorded width gave rc=%d, wanted %d "
                   "(2px of DPR rounding is tolerated, 3px is a different layout)"
                   % (-dl, p.returncode, want))
    elif want == 2 and "REFUSE[frame_of_record]" not in p.stderr:
        bad.append("a frame %+dpx off refused with the wrong code: %s"
                   % (-dl, p.stderr[:160]))
# ...and the HEIGHT axis is NOT re-based, because `h` is still absolute. A taller
# window ends the crop early, silently, and the iframe bound cannot see it.
tall = os.path.join(WORK, "f14-tall.png")
if not os.path.exists(tall):
    subprocess.run(["python3", MKPNG, tall, str(WIDE_W), str(VH + 40)],
                   capture_output=True, text=True, check=True)
refuses("a fully anchored rect at a DIFFERENT viewport HEIGHT", "viewport_of_record",
        tall, rec_full, probe(right=PAD, vw=WIDE_W, vh=VH + 40, left=PAD),
        needle="HEIGHT")

# 4. `xFrom` ALONE tracks the frame but stays RECORD-BOUND, and that is the
#    honest difference between the two forms. Same rect, same window, two records.
rec_x = recipe("xonly", XONLY, frame_w=None)
refuses("an xFrom-only rect at an unrecorded window width", "viewport_of_record",
        WIDE, rec_x, WIDE_PROBE)
rec_x_wide = recipe("xonly-wide", XONLY, viewport=(WIDE_W, VH), frame_w=None)
p = run("measure", WIDE, rec_x_wide, WIDE_PROBE)
if p.returncode != 0:
    bad.append("an xFrom-only rect whose record MATCHES the window was refused: %s"
               % p.stderr[:200])
elif json.loads(p.stdout)["box"] != WANT[WIDE]:
    bad.append("an xFrom-only rect resolved to %s, wanted %s — `x` must anchor even "
               "when `w` does not" % (json.loads(p.stdout)["box"], WANT[WIDE]))

# 5. THE REFUSALS. Every one of these is a way the form could QUIETLY degrade to
#    the absolute rect it replaces, which is the defect it exists to remove.
refuses("wFrom with NO xFrom (the half-specified form)", "crop_rect_invalid", NARROW,
        recipe("wonly", {"x": 252, "y": 31, "w": 257, "h": 312,
                         "yFrom": "appFrame", "wFrom": "appFrameRight"}),
        NARROW_PROBE, needle="half-specified")
refuses("wFrom carrying the xFrom/yFrom token", "crop_rect_invalid", NARROW,
        recipe("wtok", dict(FULL, wFrom="appFrame")), NARROW_PROBE,
        needle="appFrameRight")
refuses("an unsupported xFrom value", "crop_rect_invalid", NARROW,
        recipe("xtok", dict(FULL, xFrom="iframe")), NARROW_PROBE)
refuses("a MISSPELT horizontal marker key", "crop_rect_invalid", NARROW,
        recipe("xmis", {"x": 252, "y": 31, "w": 257, "h": 312, "yFrom": "appFrame",
                        "xFromm": "appFrame", "wFrom": "appFrameRight"}), NARROW_PROBE)
refuses("the horizontal form in a recipe that does NOT set fromAppFrame",
        "crop_rect_invalid", NARROW, recipe("noafr", FULL, from_app_frame=False), None)
# 🔴 THE ONE THAT MATTERS MOST: a probe that predates the left inset. The rect
# must REFUSE, never read `x` as an absolute column.
refuses("an xFrom rect against a FIVE-field (pre-left-inset) probe answer",
        "app_frame_left_missing", NARROW, rec_full, probe(six=False),
        needle="silent fallback")
# 🔴 THE PROBE HERE KEEPS THE FRAME 1709 WIDE (left -40, right +40) ON PURPOSE.
# A horizontally scrolled page SHIFTS the frame, it does not resize it — and if
# the fixture resized it, `frame_of_record` would refuse FIRST and this arm would
# be grading that check instead of the one it names. Ordering is deliberate:
# geometry-of-record runs before any coordinate is resolved.
refuses("a NEGATIVE left inset (a horizontally scrolled page)", "crop_rect_outside",
        NARROW, rec_full, probe(left=-40, right=40), needle="NEGATIVE left inset")
# a leftover WIDTH left in place when converting to `wFrom`: 1709 - 1694 - 252 < 0
refuses("a width left in `w` when converting to wFrom (insets that cross)",
        "crop_rect_invalid", NARROW, recipe("cross", dict(FULL, w=1694)), NARROW_PROBE,
        needle="GAP")
# ...and the same shape landing ABOVE zero but under the 128px asset floor, which
# is the arm that proves the floor moved onto the RESOLVED width.
refuses("a resolved width under the 128px floor", "crop_rect_invalid", NARROW,
        recipe("tiny", dict(FULL, w=1357)), NARROW_PROBE, needle="RESOLVED")

# 6. 🔴 THE IFRAME'S RIGHT EDGE BOUNDS AN X-ANCHORED RECT, the horizontal twin of
#    F13's iframe-bottom bound — and it is the arm that reproduces the incident's
#    own shape: the rect FITS THE PNG (2452 <= 2509) and runs out of the app.
big = recipe("big", dict(XONLY, w=1800), viewport=(WIDE_W, VH), frame_w=None)
refuses("an x-anchored rect running past the IFRAME's right edge", "crop_rect_outside",
        WIDE, big, WIDE_PROBE, needle="IFRAME'S OWN right edge")
ok = recipe("fits", dict(XONLY, w=1400), viewport=(WIDE_W, VH), frame_w=None)
p = run("measure", WIDE, ok, WIDE_PROBE)
if p.returncode != 0:
    bad.append("POSITIVE CONTROL for the right-edge bound: a rect that FITS inside "
               "the frame (652+1400=2052 <= 2109) was refused: %s" % p.stderr[:200])
# a NEGATIVE right gap means the iframe runs past the viewport, so the PNG edge
# must stay the limit rather than the bound WIDENING past the photograph.
p = run("measure", WIDE, recipe("overrun", dict(XONLY, x=252, w=2000),
                                viewport=(WIDE_W, VH), frame_w=None),
        probe(right=-200, vw=WIDE_W, left=PAD))
if p.returncode != 2 or "REFUSE[crop_rect_outside]" not in p.stderr:
    bad.append("a rect ending at column 2652 on a 2509-column capture was ACCEPTED "
               "under a NEGATIVE right gap — the min() with the PNG is inert and a "
               "degenerate probe reading pushes the bound past the frame; got rc=%d %s"
               % (p.returncode, p.stderr[:160]))

# 7. THE RECORD FOR THE RE-BASED AXIS IS REQUIRED, NOT OPTIONAL — the absence must
#    not mean "skip the check", which is how the axis was unguarded to begin with.
refuses("a fully anchored rect whose recipe records NO appFrameW",
        "frame_width_unrecorded", NARROW, recipe("nofw", FULL, frame_w=None),
        NARROW_PROBE)
refuses("a malformed appFrameW", "viewport_unrecorded", NARROW,
        recipe("badfw", FULL, frame_w=0), NARROW_PROBE)

# 8. A `yFrom`-ONLY RECT MUST NOT CLAIM A HORIZONTAL RESOLUTION. A report that
#    always names `xFrom` would assert coverage that is not there.
p = run("measure", NARROW, recipe("yonly", {"x": 252, "y": 31, "w": 1200, "h": 312,
                                            "yFrom": "appFrame"}, frame_w=None),
        NARROW_PROBE)
if p.returncode != 0:
    bad.append("the y-only form (every shipped recipe) stopped measuring: %s"
               % p.stderr[:200])
else:
    res = json.loads(p.stdout).get("resolved") or {}
    stray = [k for k in ("xFrom", "declaredX", "appFrameLeft", "wFrom") if k in res]
    if stray:
        bad.append("a yFrom-only rect reports %s in `resolved` — it claims a "
                   "horizontal anchor it does not have" % stray)

print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "F14 🔴 THE HORIZONTAL ANCHOR, GRADED ON PIXELS: one \`xFrom\`+\`wFrom\` rect with ONE record resolves to x=252 at a 1709px window and x=652 at a 2509px one and crops BYTE-IDENTICAL content in both — with the absolute form as the negative control (it does not); render agrees with measure; the resolution is reported per anchor and a yFrom-only rect claims none; \`viewport_of_record\` is RE-BASED onto the app frame's own width for this form (watched at ±2/±3) and NOT re-based on the height axis, where \`h\` is still absolute; the iframe's RIGHT edge bounds an x-anchored rect the way its lower edge bounds a y-anchored one, including under a degenerate negative gap; and the half-specified form, a copied marker token, a misspelt key, a missing \`fromAppFrame\`, a five-field probe with no left inset, a negative left inset, a leftover width and a missing \`appFrameW\` each REFUSE rather than degrading silently to the absolute rect this replaces"
else
  fail "F14: the horizontal frame anchor is wrong"
  sed 's/^/          /' "${WORK}/f14.txt" | head -16
fi

# ---------------------------------------------------------------------------
echo
echo "--- B: the store-bounds gate ----------------------------------------"
# ---------------------------------------------------------------------------
mk() { python3 "$MKPNG" "$@" >/dev/null; }
mk "${WORK}/ok-shot.png"      1200 778
mk "${WORK}/small.png"        300 300
# 🔴 1600x400, NOT 1200x300. A fixture that violates TWO bounds at once cannot
# test either: at 1200x300 the aspect is 4.0 AND the short edge is under 320, so
# the min-dimension clause refuses it whatever the aspect clause does — and a
# mutation that disables the aspect check (or drifts aspect_max to 99 in the
# bounds file) SURVIVES, which is exactly what the battery measured. 1600x400
# violates aspect ONLY: short edge 400 >= 320.
mk "${WORK}/wide.png"         1600 400
mk "${WORK}/toobig.png"       1200 778 --noise
mk "${WORK}/edge-320.png"     832 320
mk "${WORK}/edge-319.png"     829 319
mk "${WORK}/at-limit.png"     1200 778 --bytes 2097152
mk "${WORK}/over-limit.png"   1200 778 --bytes 2097153
mk "${WORK}/icon-ok.png"      1024 1024
mk "${WORK}/icon-small.png"   100 100
mk "${WORK}/icon-huge.png"    4100 4100
mk "${WORK}/icon-oblong.png"  1200 800
mk "${WORK}/cover-ok.png"     1600 800
mk "${WORK}/cover-narrow.png" 600 300
mk "${WORK}/cover-wide.png"   1600 400

expect_ok     "B1 POS: a 1200x778 render passes the screenshot bounds" -- \
  python3 "$FRAME" bounds screenshot "${WORK}/ok-shot.png" --bounds "$BOUNDS"
expect_refuse "B2 NEG: 300x300 is below the 320px minimum" store_bounds -- \
  python3 "$FRAME" bounds screenshot "${WORK}/small.png" --bounds "$BOUNDS"
expect_refuse "B3 NEG: aspect 4.0 is outside 0.4-2.6 (and ONLY the aspect is wrong — 1600x400)" store_bounds --\
  python3 "$FRAME" bounds screenshot "${WORK}/wide.png" --bounds "$BOUNDS"
expect_refuse "B4 NEG: a 2.8 MB screenshot exceeds the 2 MiB cap" store_bounds -- \
  python3 "$FRAME" bounds screenshot "${WORK}/toobig.png" --bounds "$BOUNDS"
expect_refuse "B5 NEG: a 9th screenshot exceeds the count of 8" store_bounds -- \
  python3 "$FRAME" bounds screenshot "${WORK}/ok-shot.png" --count 9 --bounds "$BOUNDS"
expect_ok     "B5b POS control for B5: 8 screenshots are allowed" -- \
  python3 "$FRAME" bounds screenshot "${WORK}/ok-shot.png" --count 8 --bounds "$BOUNDS"
expect_ok     "B6a POS: exactly 320px on the short edge passes (boundary is <=)" -- \
  python3 "$FRAME" bounds screenshot "${WORK}/edge-320.png" --bounds "$BOUNDS"
expect_refuse "B6b NEG: 319px fails — the boundary is reachable in both directions" store_bounds -- \
  python3 "$FRAME" bounds screenshot "${WORK}/edge-319.png" --bounds "$BOUNDS"
expect_ok     "B7a POS: exactly 2 MiB passes" -- \
  python3 "$FRAME" bounds screenshot "${WORK}/at-limit.png" --bounds "$BOUNDS"
expect_refuse "B7b NEG: 2 MiB + 1 byte fails" store_bounds -- \
  python3 "$FRAME" bounds screenshot "${WORK}/over-limit.png" --bounds "$BOUNDS"
expect_ok     "B8a POS: a 1024x1024 icon passes" -- \
  python3 "$FRAME" bounds icon "${WORK}/icon-ok.png" --bounds "$BOUNDS"
expect_refuse "B8b NEG: a 100x100 icon is below the 128px minimum" store_bounds -- \
  python3 "$FRAME" bounds icon "${WORK}/icon-small.png" --bounds "$BOUNDS"
expect_refuse "B8c NEG: a 4100x4100 icon is above the 4096px maximum" store_bounds -- \
  python3 "$FRAME" bounds icon "${WORK}/icon-huge.png" --bounds "$BOUNDS"
expect_refuse "B8d NEG: a 1200x800 icon is outside the 0.9-1.1 square range" store_bounds -- \
  python3 "$FRAME" bounds icon "${WORK}/icon-oblong.png" --bounds "$BOUNDS"
expect_ok     "B9a POS: a 1600x800 cover passes" -- \
  python3 "$FRAME" bounds cover "${WORK}/cover-ok.png" --bounds "$BOUNDS"
expect_refuse "B9b NEG: a 600px-wide cover is below the 640px minimum width" store_bounds -- \
  python3 "$FRAME" bounds cover "${WORK}/cover-narrow.png" --bounds "$BOUNDS"
expect_refuse "B9c NEG: a 1600x400 cover (aspect 4.0) is outside 1.3-2.4" store_bounds -- \
  python3 "$FRAME" bounds cover "${WORK}/cover-wide.png" --bounds "$BOUNDS"

# B10 — SINGLE SOURCE OF TRUTH. Mutate a COPY of store-bounds.json and require
# the verdict to follow it. If frame.py carried a hardcoded fallback, the same
# file would still pass and this gate is what says so.
python3 -c '
import json,sys
c=json.load(open(sys.argv[1])); c["assets"]["screenshot"]["aspect_max"]=1.0
json.dump(c,open(sys.argv[2],"w"))' "$BOUNDS" "${WORK}/bounds-tight.json"
expect_refuse "B10 NEG: tightening aspect_max in the bounds FILE changes the verdict (no hardcoded fallback)" store_bounds -- \
  python3 "$FRAME" bounds screenshot "${WORK}/ok-shot.png" --bounds "${WORK}/bounds-tight.json"
expect_ok     "B10b POS control for B10: the same file passes against the real bounds" -- \
  python3 "$FRAME" bounds screenshot "${WORK}/ok-shot.png" --bounds "$BOUNDS"

# B11 — the icon re-encode warning is actually carried (it is the one bound this
# gate CANNOT enforce, so it must be said out loud).
if python3 "$FRAME" bounds icon "${WORK}/icon-ok.png" --bounds "$BOUNDS" \
     | grep -q 're-encoded server-side'; then
  pass "B11: the icon verdict carries the server-side re-encode caveat this gate cannot check"
else
  fail "B11: the icon re-encode caveat is missing from the verdict"
fi

# ---------------------------------------------------------------------------
echo
echo "--- R: the render argv ----------------------------------------------"
# ---------------------------------------------------------------------------
if python3 - "$FRAME" "$FIX" "$BOUNDS" >"${WORK}/r1.txt" 2>&1 <<'PY'
import json, subprocess, sys, os
FRAME, FIX, BOUNDS = sys.argv[1:4]
p = subprocess.run(["python3", FRAME, "render", os.path.join(FIX, "2-discover.png"),
                    "--out", "/tmp/x-discover.png", "--bounds", BOUNDS],
                   capture_output=True, text=True)
assert p.returncode == 0, p.stderr
r = json.loads(p.stdout)
# pinned: box 972x344+364+194, pad 18 -> 1008x380+346+176 ... but y0 is clamped
# to chromeTop=182, so 194-18=176 < 182 -> 182, height 344+18+(194-182)=374
expect = {"x": 346, "y": 182, "w": 1008, "h": 374}
assert r["crop"] == expect, "crop %s != %s" % (r["crop"], expect)
assert r["canvas"] == {"w": 1200, "h": 778}, r["canvas"]
argv = r["argv"]
assert argv[0] == "magick" and argv[-1] == "/tmp/x-discover.png", argv
assert "-crop" in argv and argv[argv.index("-crop") + 1] == "1008x374+346+182", argv
assert argv[argv.index("-extent") + 1] == "1200x778", argv
assert argv[argv.index("-background") + 1] == "#1a1b1e", argv
assert "-quality" not in argv, "png output must not carry a jpeg quality flag"
# the canvas comes from the bounds FILE, not a constant
import tempfile
c = json.load(open(BOUNDS)); c["render"] = {"width": 999, "height": 555}
t = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(c, t); t.close()
p2 = subprocess.run(["python3", FRAME, "render", os.path.join(FIX, "2-discover.png"),
                     "--out", "/tmp/x.png", "--bounds", t.name], capture_output=True, text=True)
r2 = json.loads(p2.stdout)
assert r2["canvas"] == {"w": 999, "h": 555}, r2["canvas"]
assert r2["argv"][r2["argv"].index("-extent") + 1] == "999x555", r2["argv"]
print("ok")
PY
then
  pass "R1: render emits the pinned magick argv, clamps the pad to the chrome band, and takes its canvas from store-bounds.json"
else
  fail "R1: the render argv drifted"; sed 's/^/          /' "${WORK}/r1.txt" | head -12
fi

expect_refuse "R2 NEG: render refuses on a capture whose box is the whole frame (no crop is shipped from a broken measure)" full_frame -- \
  python3 "$FRAME" render "$FIX/1-explainer.png" --out "${WORK}/never.png" \
    --chrome-top 0 --footer 0 --right 0 --bounds "$BOUNDS"


# ---------------------------------------------------------------------------
echo
echo "--- C: declared cropRect — the full-bleed escape hatch ----------------"
# ---------------------------------------------------------------------------
# Content-DETECTION assumes the app is an island inside page furniture. A
# full-bleed app (sensei: sidebar + chat, edge to edge) defeats it — the box
# fills the band and full_frame refuses at every band setting, correctly. So the
# crop can be DECLARED. These gates pin that declaring bypasses DETECTION and
# nothing else.

DECL_OK='{"x":0,"y":97,"w":1694,"h":1090}'
DECL_ALT='{"x":0,"y":64,"w":1694,"h":1123}'
# 🔴 THE CANVAS THESE RECTS WERE MEASURED ON. A declared rect is absolute, so it
# is only meaningful against the viewport it was chosen at, and frame.py now
# REFUSES one that records none (`viewport_unrecorded`) — the CLI spelling of a
# recipe's `crop._measuredGeometry.viewport`. Every fixture here is 1709x1314, so
# that is the honest value; C5 is where a WRONG one is fed in.
DECL_VP='1709x1314'

# C1 POSITIVE — a valid rect is accepted and used VERBATIM.
if python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect "$DECL_OK" --measured-viewport "$DECL_VP" > "${WORK}/c1.json" 2>&1 \
   && python3 -c '
import json,sys
m=json.load(open(sys.argv[1]))
assert m["mode"]=="declared", m.get("mode")
b=m["box"]; assert (b["x"],b["y"],b["w"],b["h"])==(0,97,1694,1090), b
assert m["bg"], "bg must still be sampled: render pads with -background <bg>"
' "${WORK}/c1.json"; then
  pass "C1 POS: a declared rect is accepted verbatim, marked mode=declared, and still carries a sampled bg"
else
  fail "C1 POS: declared rect not honoured"; head -4 "${WORK}/c1.json" | sed 's/^/          /'
fi

# C2 — the refusals. Declaring must not buy a bypass of the gate that exists to
# catch a no-op crop, so the whole-frame rect must STILL refuse full_frame.
expect_refuse "C2a NEG: a rect running outside the frame" crop_rect_outside -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect '{"x":1600,"y":97,"w":400,"h":800}' --measured-viewport "$DECL_VP"
expect_refuse "C2b NEG: a rect below the 128px floor" crop_rect_invalid -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect '{"x":0,"y":97,"w":1694,"h":40}' --measured-viewport "$DECL_VP"
expect_refuse "C2c NEG: a whole-frame rect is a no-op crop — declaring does NOT bypass full_frame" full_frame -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect '{"x":0,"y":0,"w":1709,"h":1314}' --measured-viewport "$DECL_VP"
expect_refuse "C2d NEG: a malformed rect (missing h)" crop_rect_invalid -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect '{"x":0,"y":97,"w":1694}' --measured-viewport "$DECL_VP"

# C3 🔴 THE REGRESSION THAT SHIPPED. render clamped the padded box to the
# DETECTION bands (`y0 = max(chromeTop, y-pad)`, width re-expanded to the frame),
# so a declared rect was silently overridden: two DIFFERENT rects rendered
# byte-identical output that still looked like a reasonable screenshot. Only a
# diff of two renders that were supposed to differ caught it. Assert they differ.
ca=$(python3 "$FRAME" render "$FIX/1-explainer.png" --out "${WORK}/ca.png" --crop-rect "$DECL_OK" --measured-viewport "$DECL_VP" 2>/dev/null \
     | python3 -c 'import json,sys; c=json.load(sys.stdin)["crop"]; print("%(x)d,%(y)d,%(w)d,%(h)d"%c)')
cb=$(python3 "$FRAME" render "$FIX/1-explainer.png" --out "${WORK}/cb.png" --crop-rect "$DECL_ALT" --measured-viewport "$DECL_VP" 2>/dev/null \
     | python3 -c 'import json,sys; c=json.load(sys.stdin)["crop"]; print("%(x)d,%(y)d,%(w)d,%(h)d"%c)')
if [ -n "$ca" ] && [ "$ca" = "0,97,1694,1090" ] && [ "$cb" = "0,64,1694,1123" ]; then
  pass "C3: render uses a declared rect VERBATIM — no pad, clamped to the frame not the bands ($ca vs $cb)"
else
  fail "C3: render did not honour the declared rect (got '$ca' and '$cb'; expected the two rects unchanged)"
fi

# C4 — check-states cannot speak about declared rects, and must SAY so rather
# than either refusing every full-bleed app or silently dropping the safety net.
if python3 - "$FRAME" > "${WORK}/c4.txt" 2>&1 <<'PY'
import json, subprocess, sys
FRAME = sys.argv[1]
ms = [{"file": "a.png", "box": {"x": 0, "y": 97, "w": 1694, "h": 1090}, "mode": "declared"},
      {"file": "b.png", "box": {"x": 0, "y": 97, "w": 1694, "h": 1090}, "mode": "declared"}]
p = subprocess.run(["python3", FRAME, "check-states", "-"], input=json.dumps(ms),
                   capture_output=True, text=True)
assert p.returncode == 0, "identical DECLARED boxes must not refuse: %s" % p.stderr[:200]
out = json.loads(p.stdout)
assert out["declared"] == 2, out
assert "declared" in out.get("note", "").lower(), "the exemption must be stated in the output"
# ...and the exemption must NOT leak to detected boxes
ms2 = [{"file": "a.png", "box": {"x": 1, "y": 2, "w": 3, "h": 4}},
       {"file": "b.png", "box": {"x": 1, "y": 2, "w": 3, "h": 4}}]
p2 = subprocess.run(["python3", FRAME, "check-states", "-"], input=json.dumps(ms2),
                    capture_output=True, text=True)
assert p2.returncode == 2 and "identical_boxes" in p2.stderr, \
    "DETECTED identical boxes must still refuse: rc=%d %s" % (p2.returncode, p2.stderr[:200])
print("ok")
PY
then
  pass "C4: identical DECLARED boxes are exempt AND the output says so; identical DETECTED boxes still refuse"
else
  fail "C4: the declared exemption is wrong"; sed 's/^/          /' "${WORK}/c4.txt" | tail -4
fi

# ---------------------------------------------------------------------------
# C5 🔴 THE VIEWPORT OF RECORD — REPRODUCED FROM THE 2026-09-02 INCIDENT, WITH
# ITS REAL NUMBERS AND THE REAL SHIPPED RECIPE.
#
# What happened: capture.sh produced a badly wrong framed image and EXITED 0.
# sensei's rect (x=0 y=64 w=1694 h=982) was measured at a 1709x1255 viewport; the
# operator's window had become ~3008 CSS px wide at devicePixelRatio 1.140625, so
# the capture came back 3431x1286 and the rect photographed the LEFT HALF.
#
# 🔴 WHY NOTHING FIRED, WHICH IS THE PART WORTH PINNING. `app_frame_scale`
# compares the page's viewport reading with the PNG — 3431 vs 3431, consistent,
# PASS. It is an INTERNAL-CONSISTENCY check that reads like a correctness one.
# The only x-axis bound a declared rect has ever had is `x0 + bw > w` against the
# capture, and a WIDER capture makes that LOOSER. So this arm is built to fail on
# the pristine module: measured 2026-09-02, the pre-fix frame.py accepts this
# exact invocation and reports fill.w = 0.4937 — half the frame — with rc 0.
#
# The POSITIVE control is the same recipe at the viewport it records, and it must
# still resolve to y = 141 + 64 = 205. Without it this gate could be satisfied by
# refusing every declared rect, which would break all four shipped recipes.
# ---------------------------------------------------------------------------
if python3 - "$FRAME" "$RECIPES" "$MKPNG" "$WORK" >"${WORK}/c5.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
FRAME, RECIPES, MKPNG, WORK = sys.argv[1:5]
bad = []

REC = os.path.join(RECIPES, "sensei.json")
CROP = json.load(open(REC))["crop"]
GEO, RECT = CROP["_measuredGeometry"], CROP["rect"]
RECORDED = tuple(GEO["viewport"])                      # [1709, 1255], as shipped
TOP, GAP = GEO["appFrameTop"], GEO["appFrameBottomGap"]
if RECORDED != (1709, 1255):
    bad.append("sensei no longer records the 1709x1255 viewport this gate is written "
               "against (%r) — re-derive the incident numbers before trusting it"
               % (RECORDED,))


def canvas(w, h):
    p = os.path.join(WORK, "c5-%dx%d.png" % (w, h))
    if not os.path.exists(p):
        subprocess.run(["python3", MKPNG, p, str(w), str(h)],
                       capture_output=True, text=True, check=True)
    return p


def measure(w, h):
    """The recipe, a capture of w x h, and a probe that AGREES with it — which is
    exactly the configuration app_frame_scale is blind to."""
    return subprocess.run(
        ["python3", FRAME, "measure", canvas(w, h), "--recipe", REC,
         "--app-frame-rect", "APPFRAME_RECT:%d,%d,-1,%d,%d" % (TOP, GAP, w, h)],
        capture_output=True, text=True)


# 1. THE NEGATIVE CONTROL: the incident, exactly.
p = measure(3431, 1286)
if p.returncode != 2 or "REFUSE[viewport_of_record]" not in p.stderr:
    bad.append("THE INCIDENT WAS ACCEPTED: sensei's 1709x1255 rect applied to a "
               "3431x1286 capture gave rc=%d %s" % (p.returncode, (p.stderr or p.stdout)[:200]))
else:
    for needle in ("1709x1255", "3431x1286"):
        if needle not in p.stderr:
            bad.append("the refusal does not name %s — an operator cannot tell WHICH "
                       "window to go back to without both viewports" % needle)
    if "app_frame_scale" in p.stderr:
        bad.append("the refusal blames the DPR cross-check, which passed here")

# 2. THE POSITIVE CONTROL: the same recipe at the viewport it records still works,
#    and still resolves its `y` against the live edge.
p = measure(*RECORDED)
if p.returncode != 0:
    bad.append("THE WORKING CASE BROKE: sensei at its own recorded viewport was "
               "refused — every shipped declared-rect recipe would stop capturing: %s"
               % p.stderr[:200])
else:
    m = json.loads(p.stdout)
    # derived from the recipe, not restated: a re-measure of the rect alone must
    # not turn this arm into a confusing failure about numbers nobody edited.
    want = {"x": RECT["x"], "y": TOP + RECT["y"], "w": RECT["w"], "h": RECT["h"]}
    if m["box"] != want:
        bad.append("the accepted box is %r, not %r — the rect resolved against the "
                   "live edge" % (m["box"], want))

# 3. 🔴 app_frame_scale IS NOT DOING THIS JOB — asserted, not assumed. Feed the
#    incident capture with a probe that also agrees, and confirm the OLD gate is
#    silent about it: if the two checks overlapped, a mutant in one would die to
#    the other and the coverage would be imaginary.
p = subprocess.run(
    ["python3", FRAME, "measure", canvas(3431, 1286), "--recipe", REC,
     "--app-frame-rect", "APPFRAME_RECT:%d,%d,-1,3431,1286" % (TOP, GAP)],
    capture_output=True, text=True)
if "REFUSE[app_frame_scale]" in p.stderr:
    bad.append("app_frame_scale fired on the incident configuration — this gate is "
               "then measuring that check, not the viewport-of-record one")

# 4. THE TOLERANCE, WATCHED AT ITS BOUNDARY ON BOTH AXES AND IN BOTH DIRECTIONS.
#    2px is DPR rounding; 3px is not. A one-sided check would pass three of these.
for dw, dh, want in ((2, 0, 0), (-2, 0, 0), (0, 2, 0), (0, -2, 0),
                     (3, 0, 2), (-3, 0, 2), (0, 3, 2), (0, -3, 2)):
    p = measure(RECORDED[0] + dw, RECORDED[1] + dh)
    if p.returncode != want:
        bad.append("a %+dx%+d px capture gave rc=%d, wanted %d (2px of DPR rounding is "
                   "tolerated, 3px is a different window)" % (dw, dh, p.returncode, want))
    elif want == 2 and "REFUSE[viewport_of_record]" not in p.stderr:
        bad.append("a %+dx%+d px capture refused with the wrong code: %s"
                   % (dw, dh, p.stderr[:120]))

print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "C5 🔴 THE 2026-09-02 INCIDENT: sensei's shipped 1709x1255 rect applied to the real 3431x1286 capture is REFUSED (viewport_of_record, naming both viewports) where the pre-fix module accepted it at fill.w=0.4937; the SAME recipe at its recorded viewport still resolves to y=205; app_frame_scale is proven silent on the same input, so the two checks do not overlap; and the 2px tolerance is watched at ±2/±3 on both axes"
else
  fail "C5: the viewport-of-record gate does not reproduce the incident"
  sed 's/^/          /' "${WORK}/c5.txt" | tail -10
fi

# C6/C7 — the two ways the operand can be missing or doubled. A declared rect
# with no record must not FAIL OPEN: the numbers look equally plausible at any
# viewport, so an absent record cannot be allowed to mean "skip the check".
expect_refuse "C6 NEG: a declared rect that records NO viewport is refused, not cropped unchecked — the absence is the failure, not a reason to skip the gate" viewport_unrecorded -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect "$DECL_OK"
expect_refuse "C6b NEG: a malformed --measured-viewport is a missing record, not a tolerated one" viewport_unrecorded -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --crop-rect "$DECL_OK" --measured-viewport "1709"
# 🔴 THE FLAG'S VALUE MATCHES THE RECIPE'S RECORD ON PURPOSE. A MISmatched pair
# is also refused by the tolerance check one step later, so this arm would pass
# on a mutant that only refuses a conflict when the two DISAGREE — the plausible
# "be lenient when they agree" edit, and the one that reintroduces the ambiguity
# this refusal exists to remove. Matching values make it the only thing that can
# produce this code.
expect_refuse "C7 NEG: a recipe record AND a --measured-viewport is refused even when they AGREE — two records of one fact, and nothing can tell which session the rect belongs to" viewport_record_conflict -- \
  python3 "$FRAME" measure "$FIX/5-mb-combinations.png" --recipe "$RECIPES/model-benchmarking.json" \
    --app-frame-rect "APPFRAME_RECT:141,64,-1,1709,1314" --measured-viewport 1709x1255
expect_refuse "C7b NEG: a --measured-viewport on a run that DETECTS its crop is refused rather than ignored — the reachable case is a --crop-rect that never arrived" viewport_record_conflict -- \
  python3 "$FRAME" measure "$FIX/1-explainer.png" --measured-viewport 1709x1314

# C8 🔴 THE LEDGER: every shipped recipe that declares a rect records a viewport.
# P18 checks the recorded geometry against the rect; this checks that the key the
# LIVE path reads is present at all, and it is the arm that makes adding a fifth
# declared-rect recipe without a record fail HERE rather than on a live run.
if python3 - "$RECIPES" >"${WORK}/c8.txt" 2>&1 <<'PY'
import glob, json, os, sys
bad, declared = [], []
for f in sorted(glob.glob(os.path.join(sys.argv[1], "*.json"))):
    crop = json.load(open(f)).get("crop") or {}
    if not crop.get("rect"):
        if crop.get("_measuredGeometry"):
            bad.append("%s records a measured geometry but declares no rect — the "
                       "record describes nothing" % os.path.basename(f))
        continue
    declared.append(os.path.basename(f))
    geo = crop.get("_measuredGeometry")
    vp = geo.get("viewport") if isinstance(geo, dict) else None
    if (not isinstance(vp, list) or len(vp) != 2
            or not all(isinstance(v, int) and not isinstance(v, bool) and v > 0 for v in vp)):
        bad.append("%s declares a rect but its crop._measuredGeometry.viewport is %r — "
                   "frame.py will refuse this recipe on its next live run"
                   % (os.path.basename(f), vp))
# POSITIVE CONTROL: a ledger over an empty set proves nothing.
if len(declared) < 4:
    bad.append("only %d recipe(s) declare a rect (%s) — this ledger was written when "
               "four did; if one was retired say so, but do not let the count drop "
               "silently" % (len(declared), ", ".join(declared) or "none"))
print("DECLARED_RECT_RECIPES=%d (%s)" % (len(declared), ", ".join(declared)))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "C8: every shipped declared-rect recipe records the viewport its rect was measured in — $(grep -o 'DECLARED_RECT_RECIPES=[0-9]*' "${WORK}/c8.txt") — and no detect recipe carries a record that describes nothing"
else
  fail "C8: a shipped recipe would be refused on its next live run"
  sed 's/^/          /' "${WORK}/c8.txt" | tail -6
fi

# ---------------------------------------------------------------------------
echo
echo "--- D: the doc, and attach.sh's refusal to mutate --------------------"
# ---------------------------------------------------------------------------
if [ -f "$SKILL" ] && head -5 "$SKILL" | grep -q '^name: app-capture$' \
   && grep -q '^description:' "$SKILL"; then
  pass "D1: SKILL.md exists with app-capture frontmatter"
else
  fail "D1: SKILL.md is missing or has no name/description frontmatter"
fi

# D2 — every repo path the skill CORPUS names must exist.
#
# 🔴 THIS USED TO BE TWO GATES AND THE SPLIT WAS AN ARTEFACT OF THE OTHER REPO.
# In the private infra repo, D2 shelled out to that repo's `scripts/validate-skill-paths.sh`,
# which deliberately excludes `tests/` from its roots (many skills there use
# `tests/` to mean an UPSTREAM repo's test dir) — so a second gate, D2b, existed
# purely to cover the `tests/...` paths the first one structurally could not see.
# It reported "5 path reference(s)" for a doc that named 8. Here the suite lives
# INSIDE the skill, there is no repo-wide doc linter to defer to, and every path
# the corpus names is spelled the same way, so one self-contained check covers
# the whole corpus. One predicate, one place — and no dependency on a script in
# a different repository.
#
# 🔴 THE CORPUS IS SKILL.md *PLUS ITS SIDECARS*, and that is not cosmetic. The
# 2026-08-24 size prune demoted the tests/battery block into reference/, taking
# the domsurgery.py reference with it — so scanning SKILL.md alone dropped from 3
# refs to 2 (tripping the control below) while the demoted path became checked by
# NOBODY. A prune must not be able to move a path out of coverage.
if python3 - "$SKILL" "$REPO_ROOT" >"${WORK}/d2.txt" 2>&1 <<'PY'
import glob, os, re, sys
SKILL, ROOT = sys.argv[1:3]
PREFIX = ".claude/skills/app-capture/"
PAT = r"`(\.claude/skills/app-capture/[A-Za-z0-9_./-]+)`"
docs = [SKILL] + sorted(glob.glob(os.path.join(os.path.dirname(SKILL), "reference", "*.md")))
text = "\n".join(open(d).read() for d in docs)
refs = sorted(set(re.findall(PAT, text)))
dead = [r for r in refs if not os.path.exists(os.path.join(ROOT, r))]
# Positive control: the extractor must be able to SEE a dead path. Without this a
# zero is indistinguishable from a regex that matches nothing at all.
probe = PREFIX + "definitely-not-here.png"
if os.path.exists(os.path.join(ROOT, probe)):
    dead.append("the control path unexpectedly exists")
elif not re.findall(PAT, "see `%s` here" % probe):
    dead.append("POSITIVE CONTROL FAILED: the extractor cannot match a skill path")
# Floor: the corpus is known to name well over this many. A collapse to near-zero
# means the docs were reworded out of the gate's reach, not that they got cleaner.
if len(refs) < 10:
    dead.append("POSITIVE CONTROL FAILED: only %d skill refs extracted" % len(refs))
# The tests dir must be among them, or the migration silently dropped its own
# self-reference — the exact rot that made D2b necessary in the first place.
if not any(r.startswith(PREFIX + "tests/") for r in refs):
    dead.append("POSITIVE CONTROL FAILED: the corpus names no tests/ path")
print("SKILL_REFS=%d" % len(refs))
print("\n".join("DEAD: " + d for d in dead))
sys.exit(1 if dead else 0)
PY
then
  pass "D2: every repo path the skill CORPUS names exists — SKILL.md plus its reference/ sidecars ($(grep -o 'SKILL_REFS=[0-9]*' "${WORK}/d2.txt")), including its own tests/ dir"
else
  fail "D2: the skill corpus names a repo path that does not exist"
  sed 's/^/          /' "${WORK}/d2.txt" | head -8
fi

# A FAKE civitai CLI. It writes a sentinel; the sentinel's ABSENCE is what proves
# the dry run mutated nothing, and its PRESENCE under --confirm is what proves
# the absence was not vacuous. No real listing is ever touched.
FAKEBIN="${WORK}/bin"; mkdir -p "$FAKEBIN"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/sentinel.txt"\necho "{\\"id\\":\\"alpr_REKEYED\\"}"\n' \
  "$WORK" > "${FAKEBIN}/civitai"
chmod +x "${FAKEBIN}/civitai"
mk "${WORK}/attach-shot.png" 1200 778

rm -f "${WORK}/sentinel.txt"
out="$(APP_CAPTURE_CIVITAI="${FAKEBIN}/civitai" bash "$ATTACH_SH" --app custom-generators \
        --screenshot "${WORK}/attach-shot.png" --caption "hello" \
        --changelog "test" 2>&1)"; rc=$?
if [ "$rc" = 3 ] && [ ! -f "${WORK}/sentinel.txt" ] && printf '%s' "$out" | grep -q 'DRY RUN'; then
  pass "D3 NEG: attach without --confirm mutates NOTHING (exit 3, the CLI was never invoked)"
else
  fail "D3: attach without --confirm did not refuse cleanly (rc=$rc, sentinel=$([ -f "${WORK}/sentinel.txt" ] && echo present || echo absent))"
  printf '%s\n' "$out" | sed 's/^/          /' | head -8
fi

rm -f "${WORK}/sentinel.txt"
APP_CAPTURE_CIVITAI="${FAKEBIN}/civitai" bash "$ATTACH_SH" --app custom-generators \
  --screenshot "${WORK}/attach-shot.png" --changelog "test" --confirm >/dev/null 2>&1
if [ -f "${WORK}/sentinel.txt" ] && grep -q 'add-screenshot' "${WORK}/sentinel.txt"; then
  pass "D4 POS control for D3: with --confirm the CLI IS invoked (so D3's silence means something)"
else
  fail "D4: --confirm did not invoke the CLI — D3's 'mutated nothing' is unproven"
fi

rc=0; bash "$ATTACH_SH" --app custom-generators --screenshot "${WORK}/attach-shot.png" \
  >/dev/null 2>&1 || rc=$?
if [ "$rc" = 2 ]; then
  pass "D5 NEG: attach without --changelog refuses (a shadow revision with no changelog wastes a mod's time)"
else
  fail "D5: attach accepted a missing --changelog (rc=$rc)"
fi

rm -f "${WORK}/sentinel.txt"
rc=0; APP_CAPTURE_CIVITAI="${FAKEBIN}/civitai" bash "$ATTACH_SH" --app custom-generators \
  --screenshot "${WORK}/small.png" --changelog "test" --confirm >/dev/null 2>&1 || rc=$?
if [ "$rc" = 4 ] && [ ! -f "${WORK}/sentinel.txt" ]; then
  pass "D6 NEG: attach gates the store bounds BEFORE sending — an undersized asset never reaches the CLI"
else
  fail "D6: an out-of-bounds asset was not stopped before the CLI (rc=$rc)"
fi

# D6b — a FAILED attach must still re-read the listing. persistAssetImage times
# out often enough to fail three times running and succeed on the fourth, and a
# client-side failure is not evidence the server did nothing — so the natural
# "just run it again" is how three failed uploads become three screenshots. The
# re-read is the only thing that tells the operator which happened, and until
# 2026-09-04 the failure path `exit 5`d straight past it.
FAILBIN="${WORK}/failbin"; mkdir -p "$FAILBIN"
# Fails add-screenshot, succeeds at `listing status` — so the re-read can be
# observed independently of the failure.
cat > "${FAILBIN}/civitai" <<'FAKECLI'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SENTINEL}"
case "$*" in
  *add-screenshot*) echo "boom: upstream timeout" >&2; exit 1 ;;
  *"listing status"*) echo "RE-READ-RAN screenshots: 1" ;;
  *) echo '{"id":"alpr_REKEYED"}' ;;
esac
FAKECLI
chmod +x "${FAILBIN}/civitai"

rm -f "${WORK}/sentinel2.txt"
rc=0
out="$(SENTINEL="${WORK}/sentinel2.txt" APP_CAPTURE_CIVITAI="${FAILBIN}/civitai" \
  bash "$ATTACH_SH" --app custom-generators --screenshot "${WORK}/attach-shot.png" \
  --changelog "test" --confirm 2>&1)" || rc=$?
if [ "$rc" = 5 ] \
   && printf '%s' "$out" | grep -q 'RE-READ-RAN' \
   && printf '%s' "$out" | grep -q 'DO NOT RE-RUN THIS BLIND'; then
  pass "D6b: a FAILED attach still re-reads the listing and warns against a blind re-run — the exit code cannot tell you whether the asset landed, only the count can"
else
  # 🔴 Name WHICH condition failed. The first draft printed only "rc=$rc, want 5",
  # and against the pre-fix script that reads "rc=5, want 5" — which looks like a
  # broken gate rather than a caught defect, because the old script DID exit 5;
  # what it skipped was the re-read and the warning.
  d6b_why=""
  [ "$rc" = 5 ] || d6b_why="${d6b_why} exit=$rc(want 5);"
  printf '%s' "$out" | grep -q 'RE-READ-RAN' || d6b_why="${d6b_why} the re-read did NOT run;"
  printf '%s' "$out" | grep -q 'DO NOT RE-RUN THIS BLIND' || d6b_why="${d6b_why} no blind-re-run warning;"
  fail "D6b: a failed attach did not leave the operator able to tell whether the asset landed —${d6b_why}"
  printf '%s\n' "$out" | sed 's/^/          /' | head -10
fi

# D6c POS control for D6b: on the SUCCESS path the re-read still runs and the
# blind-re-run warning is ABSENT. Without this, D6b passes just as well against a
# script that prints the warning unconditionally.
rm -f "${WORK}/sentinel3.txt"
rc=0
out="$(SENTINEL="${WORK}/sentinel3.txt" APP_CAPTURE_CIVITAI="${FAKEBIN}/civitai" \
  bash "$ATTACH_SH" --app custom-generators --screenshot "${WORK}/attach-shot.png" \
  --changelog "test" --confirm 2>&1)" || rc=$?
if [ "$rc" = 0 ] && ! printf '%s' "$out" | grep -q 'DO NOT RE-RUN THIS BLIND'; then
  pass "D6c POS control for D6b: a SUCCESSFUL attach exits 0 and does NOT print the blind-re-run warning (so D6b's warning is conditional, not boilerplate)"
else
  fail "D6c: the success path is wrong (rc=$rc, want 0, warning must be absent)"
  printf '%s\n' "$out" | sed 's/^/          /' | head -10
fi

# D7 — capture.sh has no path to the spend ops of its own. The only way the
# runner can `activate` or press a trusted key is via a plan.py step, and plan.py
# refuses to emit one without --trusted (P11). This is the structural half.
if grep -nE '(^|[^-])\bactivate\b|xdotool' "$CAPTURE_SH" \
     | grep -vE '^[0-9]+: *#|NEVER|never|windowactivate' >"${WORK}/d7.txt" 2>&1; then
  fail "D7: capture.sh contains its own activate/xdotool call — the spend path must come only from plan.py"
  sed 's/^/          /' "${WORK}/d7.txt" | head -6
else
  pass "D7: capture.sh emits no activate/xdotool of its own — the only route to them is a --trusted plan"
fi

# D8 🔴 ONE FAILURE, ONE EXIT CODE — the framing path, which had two on one code.
# The skill's stated design is "one failure, one exit code, one sentence,
# because one code once carried several of them"; exits 11/12/13 were split apart
# for exactly that. The framing path kept the defect anyway until 2026-08-23:
# BUILDING the app-frame probe (a refusal from frame.py's own guard — a bug in
# THIS skill) and MEASURING with it (the crop being wrong about a real
# screenshot) both exited 5, so the printed lines differed and a caller
# branching on the status could not tell them apart. Build is now 9.
#
# 🔴 A THIRD SITE SINCE 2026-09-02, split for the same reason and along the same
# axis — WHAT THE OPERATOR MUST DO. Exit 5 means the rect is wrong about this
# screenshot: go and fix the rect. `viewport_of_record` means the OPPOSITE — the
# rect is fine and the WINDOW is not the one it was measured in, so the fix is to
# resize the window or re-measure the recipe. Nothing is broken, and this one is
# expected to recur: nothing pins the operator's window size, and it changed
# between two runs an hour apart on the day this shipped. That is exit 14.
if python3 - "$CAPTURE_SH" >"${WORK}/d8.txt" 2>&1 <<'PY'
import re, sys
src = open(sys.argv[1]).read()
bad = []
# The two sites, matched on the SENTENCE (which is what distinguishes them to a
# human) and read for the code that follows it on the same line.
SITES = [
    ("build",    r'could not build the app-frame probe[^\n]*?exit (\d+)'),
    ("measure",  r'framing REFUSED for [^\n]*?exit (\d+)'),
    ("viewport", r'the WINDOW is not the one[^\n]*\n[^\n]*\n\s*exit (\d+)'),
]
found = {}
for label, pat in SITES:
    m = re.findall(pat, src)
    # 🔴 POSITIVE CONTROL FIRST: a regex that matches nothing would let every
    # assertion below pass on an empty set. #15/#16 in CLAUDE.md, in miniature.
    if len(m) != 1:
        bad.append("the %s site was matched %d times, expected exactly 1 — this gate "
                   "cannot speak until the pattern finds it" % (label, len(m)))
        continue
    found[label] = m[0]
if len(found) == len(SITES):
    # every PAIR must differ, not just the first two — a third site added on the
    # code one of the other two already uses is the same defect, one step later.
    for i, (la, ca) in enumerate(sorted(found.items())):
        for lb, cb in sorted(found.items())[i + 1:]:
            if ca == cb:
                bad.append("the %s and %s framing failures both exit %s. They are "
                           "different failures asking for different operator actions — "
                           "fix the skill's own JS, fix the rect, or resize the window — "
                           "and a caller branching on the status cannot tell them apart."
                           % (la, lb, ca))
    for label, code in found.items():
        n = len(re.findall(r'\bexit %s\b' % re.escape(code), src))
        if n != 1:
            bad.append("exit %s (the %s failure) is emitted from %d sites — a code that "
                       "carries more than one sentence is the defect this gate exists for"
                       % (code, label, n))
print("BUILD=%s MEASURE=%s VIEWPORT=%s"
      % (found.get("build", "?"), found.get("measure", "?"), found.get("viewport", "?")))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "D8: the THREE framing failures carry pairwise-different exit codes and each code is emitted from exactly one site ($(grep -o 'BUILD=[0-9?]* MEASURE=[0-9?]* VIEWPORT=[0-9?]*' "${WORK}/d8.txt")) — a probe that could not be built, a bad crop, and a window that is not the one the rect was measured in are distinguishable by status, not only by the printed line"
else
  fail "D8: a framing exit code carries more than one sentence"
  sed 's/^/          /' "${WORK}/d8.txt" | head -8
fi

# ---------------------------------------------------------------------------
echo
echo "--- E: evidence.py — the machine-analysable capture --------------------"
# ---------------------------------------------------------------------------
# 🔴 THE CORPUS IS REAL CAPTURED DOM, NOT SOMETHING THIS SUITE EMITTED. The
# fixtures under .claude/skills/app-capture/tests/fixtures/evidence/ came off a live, logged-in
# App Block run through the browser bridge on 2026-08-17. A fixture synthesised
# from the analyser would make every case valid by construction — this skill
# already lost a round to exactly that (the `observed` fixtures behind P2/P3),
# where the killing mutation passed the whole suite while a counter went UP.
#
# 🔴 AND EVERY ZERO HERE IS PAIRED. The two real apps score 0 on all four a11y
# checks, which is a real result and useless as evidence that the checks work.
# E4 therefore drives each check from BOTH sides — a minimal mechanical edit of
# the real DOM that must make it fire, and the same file untouched that must
# leave it silent.

# E1 POS — the pinned numbers, from the manifest, over the real captures.
if python3 - "$EVID" "$EVFIX" >"${WORK}/e1.txt" 2>&1 <<'PY'
import json, subprocess, sys, os
EVID, FIX = sys.argv[1:3]
man = json.load(open(os.path.join(FIX, "manifest.json")))
bad, n = [], 0
for c in man["captures"]:
    p = subprocess.run(["python3", EVID, "analyze",
                        "--dom", os.path.join(FIX, c["dom"]),
                        "--probe", os.path.join(FIX, c["probe"]),
                        "--state", c["state"], "--slug", c["slug"]],
                       capture_output=True, text=True)
    if p.returncode != 0:
        bad.append("%s REFUSED: %s" % (c["state"], p.stderr.strip()[:120])); continue
    a = json.loads(p.stdout); n += 1
    def eq(label, got, want):
        if got != want:
            bad.append("%s %s: got %r, manifest pins %r" % (c["state"], label, got, want))
    eq("dom.bytes", a["dom"]["bytes"], c["domBytes"])
    eq("dom.sha256", a["dom"]["sha256"], c["domSha256"])
    eq("dom.elements", a["dom"]["elements"], c["elements"])
    eq("console.counts", a["console"]["counts"], c["console"])
    eq("console.total", a["console"]["total"], c["consoleTotal"])
    eq("network.counts", a["network"]["counts"], c["network"])
    eq("a11y.counts", a["a11y"]["counts"], c["a11y"])
    eq("testids.count", a["testids"]["count"], c["testidCount"])
    eq("testids.unique", a["testids"]["unique"], c["testidUnique"])
    es = a.get("emptyState") or {}
    want_es = c["emptyState"]
    eq("emptyState.verdict", es.get("verdict"), want_es["verdict"])
    eq("emptyState.defect", es.get("defect"), want_es["defect"])
    eq("emptyState.primary", (es.get("primary") or {}).get("testid"), want_es["primary"])
    eq("emptyState.items", (es.get("primary") or {}).get("items"), want_es["items"])
    if a["console"]["capture"]["selfTest"] is not True:
        bad.append("%s: the pinned fixture is not self-tested, so its zeroes mean nothing" % c["state"])
if n != 2:
    bad.append("POSITIVE CONTROL FAILED: analysed %d of 2 real captures" % n)
print("ANALYSED=%d" % n)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E1 POS: both real captures analyse to the manifest's pinned dom/console/network/a11y/testid/empty-state numbers"
else
  fail "E1: a real capture no longer analyses to its pinned numbers"
  sed 's/^/          /' "${WORK}/e1.txt" | head -12
fi

# E2 — the probe's own sentinel. It is what makes a later zero mean anything, and
# it must NOT then be reported as an app console message.
if python3 - "$EVID" "$EVFIX" >"${WORK}/e2.txt" 2>&1 <<'PY'
import json, subprocess, sys, os
EVID, FIX = sys.argv[1:3]
sys.path.insert(0, os.path.dirname(EVID))
import evidence as E
raw = json.load(open(os.path.join(FIX, "cg-explainer.probe.json")))
payload = json.loads(raw["result"]["data"]["value"])
bad = []
# positive control: the exclusion below is vacuous unless the sentinel IS there
if not any(E.SELFTEST_SENTINEL in m["text"] for m in payload["console"]):
    bad.append("POSITIVE CONTROL FAILED: the fixture carries no sentinel line, so "
               "'the sentinel is excluded' is a claim about nothing")
p = subprocess.run(["python3", EVID, "analyze",
                    "--dom", os.path.join(FIX, "cg-explainer.dom.json"),
                    "--probe", os.path.join(FIX, "cg-explainer.probe.json"),
                    "--state", "explainer"], capture_output=True, text=True)
a = json.loads(p.stdout)
if any(E.SELFTEST_SENTINEL in m["text"] for m in a["console"]["messages"]):
    bad.append("the probe's own sentinel is reported as an app console message")
if not a["console"]["capture"]["sentinelSeen"]:
    bad.append("sentinelSeen is false although the fixture carries the sentinel")
# levels survive the round trip, and are not all collapsed into one bucket
levels = set(m["level"] for m in a["console"]["messages"])
if levels != {"error", "warn"}:
    bad.append("levels came back as %s, expected {'error','warn'}" % sorted(levels))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E2: the probe's self-test sentinel is counted as the positive control and EXCLUDED from the reported messages; levels survive"
else
  fail "E2: the console sentinel handling is wrong"; sed 's/^/          /' "${WORK}/e2.txt" | head -8
fi

# E3 — the network classifier, at its boundaries and on the case that would
# otherwise flood every run with false positives.
if python3 - "$EVID" >"${WORK}/e3.txt" 2>&1 <<'PY'
import os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
import evidence as E
cases = [
    # (via, status)              expected
    (("fetch", 199), "ok"), (("fetch", 200), "ok"), (("fetch", 299), "ok"),
    (("fetch", 300), "ok"), (("fetch", 399), "ok"),
    (("fetch", 400), "failed"), (("fetch", 404), "failed"), (("fetch", 500), "failed"),
    (("fetch", 0), "failed"),
    (("xhr", 200), "ok"), (("xhr", 404), "failed"), (("xhr", 0), "failed"),
    (("element", 0), "failed"),
    # 🔴 THE ONE THAT MATTERS. A PerformanceObserver reports responseStatus 0 for
    # a load that really happened and for every cross-origin resource with no
    # Timing-Allow-Origin (MEASURED 0 on a successful load, 2026-08-17). Scoring
    # that as failed would put false positives on almost every run.
    (("resource", 0), "unknown"), (("resource", -1), "unknown"),
    (("resource", 200), "ok"), (("resource", 399), "ok"),
    (("resource", 400), "failed"), (("resource", 503), "failed"),
]
bad = []
for (via, st), want in cases:
    got = E.classify_network({"via": via, "status": st})
    if got != want:
        bad.append("via=%s status=%s -> %s, expected %s" % (via, st, got, want))
# the summary must dedupe one URL failing through two instruments into ONE defect
recs = [{"via": "fetch", "status": 0, "url": "https://x/y", "error": "Failed to fetch"},
        {"via": "resource", "status": 0, "url": "https://x/y"},
        {"via": "element", "status": 0, "url": "https://x/y"}]
s = E.network_summary(recs)
if len(s["failures"]) != 1 or s["failures"][0]["via"] != "fetch":
    bad.append("dedupe wrong: %s" % s["failures"])
# positive control: a table in which nothing can be "failed" would let a
# classifier that returns "ok" unconditionally pass every case above
wanted = set(w for _, w in cases)
if wanted != {"ok", "failed", "unknown"}:
    bad.append("POSITIVE CONTROL FAILED: the table only expects %s, so it cannot "
               "tell an always-ok classifier from a correct one" % sorted(wanted))
print("CASES=%d" % len(cases))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E3: the network classifier is right at 399/400 and on both sides of 0, and resource-timing status 0 is UNKNOWN not FAILED ($(grep -o 'CASES=[0-9]*' "${WORK}/e3.txt"))"
else
  fail "E3: network classification is wrong"; sed 's/^/          /' "${WORK}/e3.txt" | head -10
fi

# E4 — the a11y checks, each from BOTH sides, on real DOM.
if python3 - "$EVID" "$EVFIX" >"${WORK}/e4.txt" 2>&1 <<'PY'
import json, os, sys
EVID, FIX = sys.argv[1:3]
sys.path.insert(0, os.path.dirname(EVID))
import evidence as E
man = json.load(open(os.path.join(FIX, "manifest.json")))
bad, n = [], 0
for check, spec in man["a11yProbes"].items():
    if check.startswith("_"):
        continue
    html = E.load_dom(open(os.path.join(FIX, spec["dom"])).read())
    # 🔴 COUNT THE TARGET BEFORE REPLACING. A count=1 replace that lands on an
    # occurrence you did not picture makes a guard look real when it is not —
    # that has already happened in this skill's mutation battery.
    occ = html.count(spec["find"])
    if occ != 1:
        bad.append("%s: probe literal occurs %d times in %s, must be exactly 1"
                   % (check, occ, spec["dom"])); continue
    clean_src = html if "clean" not in spec else html.replace(spec["find"], spec["clean"], 1)
    bad_src = html.replace(spec["find"], spec["violating"], 1)
    if bad_src == html or clean_src == bad_src:
        bad.append("%s: the probe edit changed nothing" % check); continue
    clean = E.a11y_scan(E.parse_dom(clean_src))["counts"]
    fired = E.a11y_scan(E.parse_dom(bad_src))["counts"]
    n += 1
    if clean[check] != 0:
        bad.append("%s: the CLEAN arm already reports %d — the check fires on "
                   "correct markup" % (check, clean[check]))
    if fired[check] != 1:
        bad.append("%s: the VIOLATING arm reports %d, expected exactly 1"
                   % (check, fired[check]))
    # ...and the edit must not disturb any OTHER check, or a kill here could be
    # a kill by the neighbour
    for other in clean:
        if other != check and fired[other] != clean[other]:
            bad.append("%s: the probe also moved %s (%d -> %d) — this case cannot "
                       "attribute anything" % (check, other, clean[other], fired[other]))
if n != len(E.CHECKS):
    bad.append("POSITIVE CONTROL FAILED: %d of %d checks have a working probe pair"
               % (n, len(E.CHECKS)))
print("CHECKS_PROVEN=%d" % n)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E4: every a11y check fires on a minimally-broken REAL DOM and stays silent on the same file unedited, moving no other check's count ($(grep -o 'CHECKS_PROVEN=[0-9]*' "${WORK}/e4.txt"))"
else
  fail "E4: an a11y check is inert, over-eager, or entangled with another"
  sed 's/^/          /' "${WORK}/e4.txt" | head -12
fi

# E5 — the testid inventory, cross-checked by a SECOND, differently-built
# measurement. A parser agreeing with itself is not a measurement.
if python3 - "$EVID" "$EVFIX" >"${WORK}/e5.txt" 2>&1 <<'PY'
import json, os, re, sys
EVID, FIX = sys.argv[1:3]
sys.path.insert(0, os.path.dirname(EVID))
import evidence as E
man = json.load(open(os.path.join(FIX, "manifest.json")))
bad, total = [], 0
files = [(c["dom"], c["testidCount"], c["testidUnique"]) for c in man["captures"]]
files += [(d["dom"], d["testidCount"], d["testidUnique"]) for d in man["domOnly"]]
for f, want_n, want_u in files:
    html = E.load_dom(open(os.path.join(FIX, f)).read())
    inv = E.testid_inventory(E.parse_dom(html))
    # the independent instrument: a raw regex over the bytes, which cannot share
    # a bug with the tree walker
    raw = re.findall(r'data-testid="([^"]*)"', html)
    if inv["count"] != len(raw):
        bad.append("%s: parser counted %d testids, a raw regex counted %d"
                   % (f, inv["count"], len(raw)))
    if sorted(set(raw)) != inv["ids"]:
        bad.append("%s: the id SETS disagree between parser and regex" % f)
    if (inv["count"], inv["unique"]) != (want_n, want_u):
        bad.append("%s: %s != pinned %s" % (f, (inv["count"], inv["unique"]), (want_n, want_u)))
    if sum(inv["byId"].values()) != inv["count"]:
        bad.append("%s: byId does not sum to count" % f)
    total += inv["count"]
if total < 40:
    bad.append("POSITIVE CONTROL FAILED: only %d testids across the corpus — the "
               "agreement above would be an agreement about nothing" % total)
print("TESTIDS=%d" % total)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E5: the testid inventory agrees with an independent regex count on every real capture ($(grep -o 'TESTIDS=[0-9]*' "${WORK}/e5.txt") occurrences)"
else
  fail "E5: the testid inventory is wrong"; sed 's/^/          /' "${WORK}/e5.txt" | head -10
fi

# E6 — the refusals, each with the good case beside it.
python3 - "$EVFIX" "${WORK}" <<'PY'
import json, os, sys
FIX, WORK = sys.argv[1:3]
d = json.load(open(os.path.join(FIX, "cg-explainer.dom.json")))
h = d["result"]["data"]["html"]
d["result"]["data"]["html"] = h[:9000] + "\n…[truncated %d bytes]" % (len(h) - 9000)
json.dump(d, open(os.path.join(WORK, "dom-truncated.json"), "w"))

p = json.load(open(os.path.join(FIX, "cg-explainer.probe.json")))
v = json.loads(p["result"]["data"]["value"])
v2 = dict(v); v2["selfTest"] = False
v2["console"] = [m for m in v["console"] if "selftest" not in m["text"]]
p["result"]["data"]["value"] = json.dumps(v2)
json.dump(p, open(os.path.join(WORK, "probe-nosel.json"), "w"))

v3 = dict(v); v3["installed"] = False; v3["error"] = "probe not installed"
json.dump({"result": {"data": {"value": json.dumps(v3)}}},
          open(os.path.join(WORK, "probe-noinstall.json"), "w"))
# the real shape of a stale --frame id: the bridge answers ok, with no DOM
json.dump({"result": {"data": {"html": ""}}}, open(os.path.join(WORK, "dom-empty.json"), "w"))
open(os.path.join(WORK, "probe-garbage.json"), "w").write("{\"result\":{\"data\":{\"value\":\"not json\"}}}")
open(os.path.join(WORK, "dom-garbage.json"), "w").write("no markup and no json at all")

# 🔴 THE BRIDGE WRITES ADVICE TO STDERR AND capture.sh CAPTURES 2>&1, so this is
# what an ORDINARY read looks like on a hidden tab — which every capture is,
# because tabs are created hidden and throttled.
banner = ("browser: tab is hidden — background tabs are throttled, so SPA content "
          "may not have rendered. Non-intrusive fix: run 'browser wake'.\n")
for src, dst in (("cg-explainer.dom.json", "dom-bannered.json"),
                 ("cg-explainer.probe.json", "probe-bannered.json")):
    open(os.path.join(WORK, dst), "w").write(banner + open(os.path.join(FIX, src)).read())
PY
expect_refuse "E6a NEG: a TRUNCATED DOM is refused — the bridge's 32768 default would silently drop a real 38.6 KB app DOM" dom_truncated -- \
  python3 "$EVID" analyze --dom "${WORK}/dom-truncated.json" --probe "$EVFIX/cg-explainer.probe.json" --state x
expect_refuse "E6b NEG: a probe whose self-test never came back is refused rather than printing a reassuring zero" probe_selftest_failed -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "${WORK}/probe-nosel.json" --state x
expect_refuse "E6c NEG: a probe that was never installed is refused" probe_missing -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "${WORK}/probe-noinstall.json" --state x
expect_refuse "E6d NEG: a DOM read that came back with no markup is refused (usually a stale --frame id: it changes on EVERY load)" dom_unreadable -- \
  python3 "$EVID" analyze --dom "${WORK}/dom-empty.json" --probe "$EVFIX/cg-explainer.probe.json" --state x
expect_refuse "E6e NEG: an unreadable probe payload is refused" probe_unreadable -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "${WORK}/probe-garbage.json" --state x
expect_refuse "E6h NEG: a blob that is neither markup nor JSON is refused, not analysed" input_unreadable -- \
  python3 "$EVID" analyze --dom "${WORK}/dom-garbage.json" --probe "$EVFIX/cg-explainer.probe.json" --state x
expect_ok "E6f POS control for E6a-e: the same real inputs, unmutated, analyse fine" -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "$EVFIX/cg-explainer.probe.json" --state x
expect_ok "E6g POS: --allow-unverified-probe is the documented escape hatch, and downgrades E6b to a note" -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "${WORK}/probe-nosel.json" --state x --allow-unverified-probe

# E6i 🔴 THE ONE THAT WOULD HAVE BROKEN EVERY LIVE RUN. `capture.sh` reads a step
# with `2>&1`, and the bridge writes "tab is hidden — background tabs are
# throttled" to STDERR on essentially every read (tabs are CREATED hidden). A
# parser that judges the payload by its first byte then treats the whole blob as
# markup: it contains `<`, passes every shape check, parses to junk, and reports
# 0 testids and 0 a11y violations with no error anywhere. The assertion is that
# the bannered input analyses IDENTICALLY to the clean one — not merely that it
# does not crash.
if python3 - "$EVID" "$EVFIX" "${WORK}" >"${WORK}/e6i.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
EVID, FIX, WORK = sys.argv[1:4]


def run(dom, probe):
    p = subprocess.run(["python3", EVID, "analyze", "--dom", dom, "--probe", probe,
                        "--state", "x"], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr

rc0, clean, err0 = run(os.path.join(FIX, "cg-explainer.dom.json"),
                       os.path.join(FIX, "cg-explainer.probe.json"))
rc1, dirty, err1 = run(os.path.join(WORK, "dom-bannered.json"),
                       os.path.join(WORK, "probe-bannered.json"))
bad = []
if rc0 != 0:
    bad.append("the clean control did not analyse: %s" % err0.strip()[:120])
if rc1 != 0:
    bad.append("a bridge STDERR banner broke the read: %s" % err1.strip()[:120])
elif clean != dirty:
    a, b = json.loads(clean), json.loads(dirty)
    bad.append("bannered input analysed DIFFERENTLY: testids %s vs %s, a11y %s vs %s"
               % (a["testids"]["count"], b["testids"]["count"],
                  a["a11y"]["total"], b["a11y"]["total"]))
# positive control: the banner really is in the file, so this proves something
if "tab is hidden" not in open(os.path.join(WORK, "dom-bannered.json")).read():
    bad.append("POSITIVE CONTROL FAILED: the fixture carries no banner")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E6i POS: a bridge STDERR banner in front of the payload (what 2>&1 captures on every hidden tab) analyses IDENTICALLY to the clean read"
else
  fail "E6i: the bridge's stderr advice corrupts the analysis"
  sed 's/^/          /' "${WORK}/e6i.txt" | head -6
fi

# E7 — the DIFF. A before/after pass is the whole point of a machine-readable
# artifact, and it is worthless if a timestamp makes every diff non-empty.
if python3 - "$EVID" "$EVFIX" "${WORK}" >"${WORK}/e7.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
EVID, FIX, WORK = sys.argv[1:4]
base = subprocess.run(["python3", EVID, "analyze",
                       "--dom", os.path.join(FIX, "cg-explainer.dom.json"),
                       "--probe", os.path.join(FIX, "cg-explainer.probe.json"),
                       "--state", "explainer", "--slug", "custom-generators"],
                      capture_output=True, text=True)
a = json.loads(base.stdout)
bad = []


def write(name, obj):
    p = os.path.join(WORK, name)
    json.dump(obj, open(p, "w"))
    return p


def run(b, c):
    p = subprocess.run(["python3", EVID, "diff", b, c], capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)

same = write("d-a.json", a)
copy = write("d-b.json", json.loads(json.dumps(a)))
rc, d = run(same, copy)
if rc != 0 or d["changed"]:
    bad.append("two identical artifacts diffed as CHANGED (%s)" % d)

# 🔴 THE ONE THAT MAKES IT USABLE ON DAY TWO: volatile fields live under `meta`
# and must not register. A diff that is always non-empty is a diff nobody reads.
mv = json.loads(json.dumps(a)); mv["meta"]["reinstalled"] = True
mv["meta"]["somethingNew"] = "2026-08-17T00:00:00Z"
rc, d = run(same, write("d-meta.json", mv))
if rc != 0 or d["changed"]:
    bad.append("a `meta`-only difference registered as a change: %s" % d)

# 🔴 THE RE-RUN CASE, MEASURED: two independent real captures of the same state
# agreed exactly on console, network, a11y and all 15 testids while differing on
# the DOM hash (35,556 vs 35,676 bytes — the app's content is live). If the hash
# fed `changed`, `diff` would exit 1 on every honest re-run and the exit code
# would become noise everyone learns to skip.
domonly = json.loads(json.dumps(a)); domonly["dom"]["sha256"] = "0" * 64
domonly["dom"]["bytes"] = a["dom"]["bytes"] + 120
rc, d = run(same, write("d-domonly.json", domonly))
if not d["domChanged"]:
    bad.append("a changed DOM hash is not reported at all")
if rc != 0 or d["changed"]:
    bad.append("a DOM-hash-only difference set changed=%s rc=%s — every honest "
               "re-run would read as a regression" % (d["changed"], rc))

# a fixed console error
fixed = json.loads(json.dumps(a))
fixed["console"]["messages"] = [m for m in fixed["console"]["messages"]
                                if m["text"] != "LIVE_PAGE_ERROR"]
rc, d = run(same, write("d-fixed.json", fixed))
if rc != 1 or not d["changed"] or d["fixed"] != 1 or d["regressed"] != 0:
    bad.append("removing one console error did not read as fixed=1: rc=%s %s"
               % (rc, {k: d[k] for k in ("changed", "fixed", "regressed")}))
if ["error", "LIVE_PAGE_ERROR"] not in d["console"]["removed"]:
    bad.append("the diff does not name the message that disappeared: %s" % d["console"])

# a NEW a11y violation
reg = json.loads(json.dumps(a))
reg["a11y"]["violations"].append({"check": "img-alt", "path": "html > body > img",
                                  "why": "<img> has no alt attribute", "testid": None})
rc, d = run(same, write("d-reg.json", reg))
if rc != 1 or d["regressed"] != 1:
    bad.append("a new a11y violation did not read as regressed=1: %s" % d)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E7: diff is empty for identical runs, for meta-only drift AND for a DOM-hash-only re-run; names a fixed console error (fixed=1) and a new a11y violation (regressed=1)"
else
  fail "E7: the before/after diff is wrong"; sed 's/^/          /' "${WORK}/e7.txt" | head -10
fi

# E8 — the PLAN under --evidence: ordering, frame-scoping, the uncapped read,
# and the one-line-per-argv seam.
if python3 - "$PLAN" "$RECIPES/custom-generators.json" "${WORK}/obs-ok.json" >"${WORK}/e8.txt" 2>&1 <<'PY'
import json, subprocess, sys
PLAN, RECIPE, OBS = sys.argv[1:4]
bad = []


def plan(state, ev):
    cmd = ["python3", PLAN, RECIPE, "--observed", OBS, "--state", state]
    if ev:
        cmd.append("--evidence")
    p = subprocess.run(cmd, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)

n_states = 0
for state in ("explainer", "discover", "generator", "mine"):
    n_states += 1
    off = plan(state, False)
    on = plan(state, True)
    # WITHOUT the flag nothing changes — the store-shoot path is untouched
    if any(s.get("probe") or s.get("captureDom") or s.get("captureProbe")
           for s in off["steps"]):
        bad.append("%s: an evidence step leaked into a plan built WITHOUT --evidence" % state)
    if off.get("evidence") is not False:
        bad.append("%s: plans without the flag are not marked evidence:false" % state)
    steps = on["steps"]
    ops = [s["op"] for s in steps]
    # 1. install FIRST of everything that touches the app, before anything that
    #    can change the view or log. The one step allowed ahead of it is the
    #    `state` foreground re-assert, which touches no DOM and logs nothing, so
    #    it cannot cost the hook anything by going first. (Its old rationale —
    #    "the app cannot boot while its window is occluded" — is RETRACTED
    #    2026-08-24; the ORDERING is what this asserts, and that still holds.)
    i_inst = next((j for j, s in enumerate(steps) if s.get("probe") == "install"), None)
    lead = [s for s in steps[:i_inst or 0] if s.get("foreground") != "state"]
    if i_inst is None or steps[i_inst]["op"] != "js" or lead:
        bad.append("%s: the probe install is not the first app-touching step "
                   "(index=%s, ops=%s) — a hook installed after the actions reports "
                   "a clean console for a state whose actions logged the error"
                   % (state, i_inst, ops[:3]))
    # 2. DOM read + drain AFTER the screenshot
    i_shot = ops.index("screenshot")
    dom = [i for i, s in enumerate(steps) if s.get("captureDom")]
    drain = [i for i, s in enumerate(steps) if s.get("captureProbe")]
    if len(dom) != 1 or len(drain) != 1:
        bad.append("%s: expected exactly one DOM read and one drain, got %s/%s"
                   % (state, len(dom), len(drain)))
        continue
    if not (i_shot < dom[0] < drain[0]):
        bad.append("%s: order is screenshot=%d dom=%d drain=%d" % (state, i_shot, dom[0], drain[0]))
    if steps[dom[0]].get("captureDom") != state or steps[drain[0]].get("captureProbe") != state:
        bad.append("%s: the capture keys do not name this state" % state)
    # 3. all three are FRAME-SCOPED with the resolved id (guard 1)
    for i in (i_inst, dom[0], drain[0]):
        argv = steps[i]["argv"]
        if "--frame" not in argv or argv[argv.index("--frame") + 1] != "830":
            bad.append("%s: evidence step %d is not scoped to the resolved frame" % (state, i))
    # 4. the DOM read is UNCAPPED
    argv = steps[dom[0]]["argv"]
    if "--max-bytes" not in argv or argv[argv.index("--max-bytes") + 1] != "0":
        bad.append("%s: the DOM read is not --max-bytes 0; the 32768 default "
                   "truncates a real app DOM and under-reports everything" % state)
    # 5. install must precede EVERY view-changing op, not merely be early
    for i, s in enumerate(steps):
        if s["op"] in ("click", "type", "key", "nav") and i < i_inst:
            bad.append("%s: a view-changing op runs before the probe is installed" % state)
    # 6. THE SEAM: one line per argv element (capture.sh reads them with mapfile -t)
    for s in steps:
        for aa in s["argv"]:
            if "\n" in aa or "\r" in aa:
                bad.append("%s: step %s has a MULTI-LINE argv element — capture.sh "
                           "would split it into several arguments" % (state, s["op"]))
if n_states < 4:
    bad.append("POSITIVE CONTROL FAILED: only %d states inspected" % n_states)
# ...and the newline check above must be able to SEE one
probe = {"argv": ["a\nb"]}
if not any("\n" in x for x in probe["argv"]):
    bad.append("POSITIVE CONTROL FAILED: the newline scan cannot see a planted newline")
print("STATES=%d" % n_states)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E8: --evidence installs the probe BEFORE every action and reads DOM+drain AFTER the screenshot, all frame-scoped, DOM uncapped, one line per argv; without the flag nothing changes ($(grep -o 'STATES=[0-9]*' "${WORK}/e8.txt"))"
else
  fail "E8: the evidence plan is mis-ordered, unscoped, capped, or leaks without the flag"
  sed 's/^/          /' "${WORK}/e8.txt" | head -12
fi

# E9 🔴 THE SEAM NOBODY OWNS. plan.py emits `capture*` keys; capture.sh is the
# only thing that consumes them. Each half was tested in isolation for a long
# time, and a step whose output is planned and never written is an artifact that
# never exists — which reads exactly like "nothing to report". This gate pins the
# RELATIONSHIP: the ledger of keys must not GROW on one side or SHRINK on the other.
if python3 - "$PLAN" "$RECIPES/custom-generators.json" "$RECIPES/panorama-360.json" \
     "${WORK}/obs-ok.json" "${WORK}/obs-pano.json" "$CAPTURE_SH" >"${WORK}/e9.txt" 2>&1 <<'PY'
import json, re, subprocess, sys
PLAN, REC_CG, REC_PANO, OBS_CG, OBS_PANO, CAPTURE = sys.argv[1:7]
emitted = set()
for rec, obs, extra in ((REC_CG, OBS_CG, ["--evidence"]),
                        (REC_PANO, OBS_PANO, ["--trusted"]),
                        (REC_PANO, OBS_PANO, ["--trusted", "--evidence"])):
    r = json.load(open(rec))
    for st in r["states"]:
        p = subprocess.run(["python3", PLAN, rec, "--observed", obs,
                            "--state", st["name"]] + extra, capture_output=True, text=True)
        if p.returncode != 0:
            continue
        for s in json.loads(p.stdout)["steps"]:
            emitted |= set(k for k in s if k.startswith("capture"))
src = open(CAPTURE).read()
consumed = set(re.findall(r'\.get\("(capture[A-Za-z]*)"', src))
bad = []
if not emitted:
    bad.append("POSITIVE CONTROL FAILED: no capture* key was emitted at all, so "
               "this ledger compares two empty sets")
for k in sorted(emitted - consumed):
    bad.append("plan.py emits %r and capture.sh never reads it — the step runs and "
               "its output is thrown away, so the artifact silently does not exist" % k)
for k in sorted(consumed - emitted):
    bad.append("capture.sh reads %r but no plan emits it — dead wiring, or a key "
               "that was renamed on one side only" % k)
print("LEDGER=%s" % sorted(emitted))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E9: the capture* key ledger matches exactly between plan.py and capture.sh ($(grep -o "LEDGER=.*" "${WORK}/e9.txt"))"
else
  fail "E9: a planned capture key is not wired into capture.sh (or vice versa)"
  sed 's/^/          /' "${WORK}/e9.txt" | head -8
fi

# E10 — a nav under --evidence would silently produce no artifact at all.
python3 -c '
import json,sys
json.dump({"slug":"navev","frameHost":"custom-generators.civit.ai",
  "ready":{"testid":"discover-list"},"clickable":["#tab-mine"],"states":[
  {"name":"withnav","actions":[{"click":"#tab-mine"},
                               {"nav":"https://civitai.com/apps/run/custom-generators"}]},
  {"name":"nonav","actions":[{"click":"#tab-mine"}]}]}, open(sys.argv[1],"w"))' \
  "${WORK}/rec-navev.json"
expect_refuse "E10 NEG: --evidence on a state that navigates is refused (its artifact would never be emitted, which reads as a clean run)" evidence_after_nav -- \
  python3 "$PLAN" "${WORK}/rec-navev.json" --observed "${WORK}/obs-ok.json" --state withnav --evidence
expect_ok "E10b POS control for E10: the same recipe's nav-free state plans fine with --evidence" -- \
  python3 "$PLAN" "${WORK}/rec-navev.json" --observed "${WORK}/obs-ok.json" --state nonav --evidence
expect_ok "E10c POS control for E10: the SAME nav state still plans WITHOUT --evidence (the refusal is scoped to evidence, not a new ban on nav)" -- \
  python3 "$PLAN" "${WORK}/rec-navev.json" --observed "${WORK}/obs-ok.json" --state withnav

# E11 — the probe observes and must never actuate. It is our own code running in
# the MAIN world of a live, logged-in, mod-gated app.
if python3 - "$EVID" "$PLAN" "$RECIPES/custom-generators.json" "${WORK}/obs-ok.json" "${WORK}" \
     >"${WORK}/e11.txt" 2>&1 <<'PY'
import json, os, shutil, subprocess, sys
EVID, PLAN, RECIPE, OBS, WORK = sys.argv[1:6]
sys.path.insert(0, os.path.dirname(EVID))
import evidence as E
bad = []
for name, js in (("install", E.PROBE_INSTALL_JS), ("drain", E.PROBE_DRAIN_JS)):
    for tok in E.PROBE_FORBIDDEN:
        if tok in js:
            bad.append("the %s probe contains the actuation token %r" % (name, tok))
    if "\n" in js:
        bad.append("the %s probe is multi-line" % name)
    if "//" in js:
        bad.append("the %s probe contains a // comment, which swallows the rest of "
                   "the program once it is flattened to one line" % name)
if not E.PROBE_FORBIDDEN:
    bad.append("POSITIVE CONTROL FAILED: the forbidden-token list is empty")
# positive control: the scanner must SEE a planted token
planted = E.PROBE_INSTALL_JS + ' document.querySelector("x").click();'
if not any(t in planted for t in E.PROBE_FORBIDDEN):
    bad.append("POSITIVE CONTROL FAILED: the scan cannot see a planted `.click(`")
# ...and plan.py must REFUSE rather than inject such a probe
mut = os.path.join(WORK, "probe-mut")
shutil.rmtree(mut, ignore_errors=True)
shutil.copytree(os.path.dirname(EVID), mut)
src = open(os.path.join(mut, "evidence.py")).read()
needle = 'PROBE_INSTALL_JS = _one_line(_INSTALL_SRC)'
if src.count(needle) != 1:
    bad.append("cannot plant the actuating probe: anchor occurs %d times" % src.count(needle))
else:
    open(os.path.join(mut, "evidence.py"), "w").write(
        src.replace(needle, needle + '\nPROBE_INSTALL_JS += \' document.querySelector("x").click(); \'', 1))
    p = subprocess.run(["python3", os.path.join(mut, "plan.py"), RECIPE,
                        "--observed", OBS, "--state", "discover", "--evidence"],
                       capture_output=True, text=True)
    if p.returncode != 2 or "probe_actuates" not in p.stderr:
        bad.append("plan.py planned an ACTUATING probe (rc=%d): %s"
                   % (p.returncode, p.stderr.strip()[:120]))
    p2 = subprocess.run(["python3", os.path.join(mut, "plan.py"), RECIPE,
                         "--observed", OBS, "--state", "discover"],
                        capture_output=True, text=True)
    if p2.returncode != 0:
        bad.append("the actuating probe also broke the NON-evidence path, so the "
                   "refusal above cannot be attributed to the probe check")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E11: the probe carries no actuation verb, is one line, has no // comments — and plan.py REFUSES (probe_actuates) an injected click call, while the non-evidence path is unaffected"
else
  fail "E11: the observer probe can actuate, or the guard does not fire"
  sed 's/^/          /' "${WORK}/e11.txt" | head -10
fi

# E12 🔴 END TO END, THROUGH capture.sh, WITH NO BROWSER. The lesson behind this
# gate is attach.sh: it emitted `--app`/`--file` for its whole life and NEVER
# attached anything, because the positive control asserted only that a CLI was
# INVOKED and its stub accepted any flags. So the fake bridge here is PICKY — it
# refuses `html` without `--max-bytes 0` and any frame-scoped op without --frame
# — and the assertion is on the ARTIFACT's contents, not on the run's exit code.
if [ -x "$FAKEBB" ]; then
  E2E="${WORK}/e2e"; mkdir -p "$E2E"
  APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "$RECIPES/custom-generators.json" \
    --state discover --evidence --no-frame --out "$E2E" >"${WORK}/e12.log" 2>&1
  e12rc=$?
  if [ "$e12rc" = 0 ] && python3 - "${E2E}/discover.evidence.json" "$EVFIX" >>"${WORK}/e12.log" 2>&1 <<'PY'
import json, os, sys
art = json.load(open(sys.argv[1]))
man = json.load(open(os.path.join(sys.argv[2], "manifest.json")))
want = [c for c in man["captures"] if c["state"] == "explainer"][0]
bad = []
if art["testids"]["count"] != want["testidCount"]:
    bad.append("testids %s != %s" % (art["testids"]["count"], want["testidCount"]))
if art["console"]["counts"] != want["console"]:
    bad.append("console %s != %s" % (art["console"]["counts"], want["console"]))
if art["network"]["counts"]["failed"] != want["network"]["failed"]:
    bad.append("failed %s != %s" % (art["network"]["counts"]["failed"], want["network"]["failed"]))
if art["state"] != "discover" or art["slug"] != "custom-generators":
    bad.append("the artifact is not labelled with the state/slug that produced it")
for extra in ("discover.dom.html", "discover.probe.json", "discover.dom.json"):
    if not os.path.exists(os.path.join(os.path.dirname(sys.argv[1]), extra)):
        bad.append("missing sidecar %s" % extra)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
  then
    pass "E12 POS: capture.sh --evidence drives the whole chain against a fake bridge and writes an artifact whose numbers match the fixture"
  else
    fail "E12: the end-to-end evidence run did not produce a correct artifact (rc=$e12rc)"
    sed 's/^/          /' "${WORK}/e12.log" | tail -12
  fi

  # E12b/c NEG — the two ways a run must STOP rather than ship a quiet artifact.
  for mode in "FAKE_PROBE_MODE=selftest-fail:probe_selftest_failed" "FAKE_DOM_MODE=truncated:dom_truncated"; do
    env_kv="${mode%%:*}"; want_code="${mode##*:}"
    NEGD="${WORK}/neg-${want_code}"; mkdir -p "$NEGD"
    env "$env_kv" APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
      "$RECIPES/custom-generators.json" --state discover --evidence --no-frame \
      --out "$NEGD" >"${WORK}/neg.log" 2>&1
    negrc=$?
    if [ "$negrc" != 0 ] && [ ! -f "${NEGD}/discover.evidence.json" ] \
       && grep -q "REFUSE\[${want_code}\]" "${WORK}/neg.log"; then
      pass "E12-neg: ${env_kv} makes the run STOP with REFUSE[${want_code}] and ship NO artifact"
    else
      fail "E12-neg: ${env_kv} did not stop the run (rc=$negrc, artifact=$([ -f "${NEGD}/discover.evidence.json" ] && echo present || echo absent))"
      sed 's/^/          /' "${WORK}/neg.log" | tail -6
    fi
  done
else
  fail "E12: .claude/skills/app-capture/tests/fixtures/fake-bridge.sh is missing or not executable"
fi

# E13 🔴 THE PROBE OUTLIVES THE CAPTURE, AND THE ARTIFACT MUST SAY SO. This gate
# is driven by the two REAL drains in the corpus, which happen to be exactly the
# two lifecycles:
#
#   cg-explainer.probe.json  networkTotal 4, 4 record(s)  -> a FIRST drain
#   cg-discover.probe.json   networkTotal 4, 0 record(s)  -> a RE-USED probe
#
# The second is the live defect, captured: the drain emptied the arrays and left
# the counter counting, so an artifact carried a number describing an earlier
# state next to a note asserting ZERO for this one. Nothing had to be
# synthesised — the manifest already calls cg-discover "an untouched drain [that]
# is genuinely empty", and it is ALSO a re-used one, which is precisely why the
# old artifact could not tell those two facts apart.
#
# 🔴 THIS GATE FAILS ON THE PRE-FIX CODE, in both arms: there was no `probe`
# block at all, and the misleading note WAS emitted for cg-discover.
if python3 - "$EVID" "$EVFIX" "${WORK}" >"${WORK}/e13.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
EVID, FIX, WORK = sys.argv[1:4]
bad = []


def analyze(probe, dom="cg-explainer.dom.json"):
    p = subprocess.run(["python3", EVID, "analyze", "--dom", os.path.join(FIX, dom),
                        "--probe", probe, "--state", "x"], capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


ZERO_NOTE = "observed ZERO requests"

# --- the CONTROL first: is the corpus really the two shapes this gate claims? A
# gate about a re-used probe over a corpus of two fresh ones proves nothing.
raw = {}
for name in ("cg-explainer", "cg-discover"):
    v = json.loads(json.load(open(os.path.join(FIX, "%s.probe.json" % name)))
                   ["result"]["data"]["value"])
    raw[name] = (v.get("counts", {}).get("networkTotal"), len(v.get("network") or []))
if raw["cg-explainer"] != (4, 4):
    bad.append("CONTROL FAILED: cg-explainer is %s, expected a FIRST drain (4, 4)" % (raw["cg-explainer"],))
if raw["cg-discover"] != (4, 0):
    bad.append("CONTROL FAILED: cg-discover is %s, expected the RE-USED shape (4, 0) — "
               "the live defect this gate exists for" % (raw["cg-discover"],))

# --- arm 1: the FRESH drain
rc, out, err = analyze(os.path.join(FIX, "cg-explainer.probe.json"))
if rc != 0:
    bad.append("the fresh capture did not analyse: %s" % err.strip()[:140])
else:
    a = json.loads(out)
    pr = a.get("probe")
    if not pr:
        bad.append("the artifact carries NO probe block, so a re-used probe is "
                   "indistinguishable from a fresh one — the whole defect")
    else:
        if pr.get("reused") is not False:
            bad.append("a first drain reads reused=%r" % pr.get("reused"))
        if pr["counts"]["agree"] is not True:
            bad.append("a first drain's counter does not agree with its own records: %s"
                       % pr["counts"])
        if pr["counts"]["observedThisDrain"] != 4:
            bad.append("observedThisDrain %s != 4" % pr["counts"]["observedThisDrain"])

# --- arm 2: the RE-USED drain — the live artifact's exact shape
rc, out, err = analyze(os.path.join(FIX, "cg-discover.probe.json"), "cg-discover.dom.json")
if rc != 0:
    bad.append("the re-used capture did not analyse: %s" % err.strip()[:140])
else:
    b = json.loads(out)
    pr = b.get("probe") or {}
    if not pr.get("reused"):
        bad.append("a drain whose counter (4) contradicts its records (0) is NOT "
                   "reported as re-used — this is the artifact that carried "
                   "networkTotal 6 beside two records and said nothing")
    if pr.get("counts", {}).get("agree") is not False:
        bad.append("counts.agree is %r on a payload where the counter and the array "
                   "disagree" % pr.get("counts", {}).get("agree"))
    if pr.get("counts", {}).get("observedThisDrain") != 0:
        bad.append("observedThisDrain %s != 0" % pr.get("counts", {}).get("observedThisDrain"))
    # 🔴 THE NOTE THAT WAS CONTRADICTED BY THE FIELD BESIDE IT.
    if any(ZERO_NOTE in n for n in b.get("notes", [])):
        bad.append("the artifact still asserts %r for a state whose probe cannot "
                   "vouch for the window: %s" % (ZERO_NOTE, b["notes"]))
    if not any(n.startswith("PROBE REUSED") for n in b.get("notes", [])):
        bad.append("no note tells a reader the probe was re-used: %s" % b.get("notes"))
    # ...and the human report must carry it too — a JSON-only signal is one nobody
    # opens. Both arms, so "REUSED" cannot be printed unconditionally.
    pa, pb = os.path.join(WORK, "life-fresh.json"), os.path.join(WORK, "life-reused.json")
    json.dump(json.loads(out), open(pb, "w"))
    rc2, out2, _ = analyze(os.path.join(FIX, "cg-explainer.probe.json"))
    json.dump(json.loads(out2), open(pa, "w"))
    rep_a = subprocess.run(["python3", EVID, "report", pa], capture_output=True, text=True).stdout
    rep_b = subprocess.run(["python3", EVID, "report", pb], capture_output=True, text=True).stdout
    if "REUSED" not in rep_b:
        bad.append("`report` does not surface the re-use: %s" % rep_b[:200])
    if "REUSED" in rep_a:
        bad.append("`report` calls a FIRST drain re-used — the word is printed "
                   "unconditionally and means nothing")
    if "fresh" not in rep_a:
        bad.append("`report` does not name the fresh lifecycle either: %s" % rep_a[:200])

# 🔴 --- arms 3-6: EACH REUSE TELL, ON ITS OWN, WITH A CONSISTENT COUNTER.
# The corpus's only re-used drain predates the lifecycle fields, so it carries
# exactly ONE tell: the counter disagreement. That is also the ONE TELL THAT
# CANNOT FIRE IN PRODUCTION — after the drain resets its counter, a correctly
# draining re-used probe has `agree == True`. So live detection rests entirely on
# `reinstalled` / `installs>1` / `drains>1`, and until this arm existed all three
# were untested: replacing the whole disjunction with `reused = agree is False`
# left the ENTIRE SUITE GREEN while silently reintroducing the defect this work
# exists to fix. Each payload below carries exactly one tell and a CONSISTENT
# counter, so a pass attributes to that tell and nothing else.
base = json.loads(json.load(open(os.path.join(FIX, "cg-explainer.probe.json")))
                  ["result"]["data"]["value"])
n_rec = len(base["network"])


def lifecycle_payload(name, **over):
    v = json.loads(json.dumps(base))
    v["counts"] = {"networkTotal": n_rec, "networkSinceInstall": n_rec}
    v["dropped"] = {"console": 0, "network": 0}
    v["reinstalled"], v["installs"], v["drains"] = False, 1, 1
    v.update(over)
    p = os.path.join(WORK, "probe-%s.json" % name)
    json.dump({"result": {"data": {"value": json.dumps(v)}}}, open(p, "w"))
    return p


TELLS = [
    ("reinstalled", {"reinstalled": True}, True),
    ("installs-2", {"installs": 2}, True),
    ("drains-2", {"drains": 2}, True),
    # the paired control: the SAME payload with no tell at all must read fresh,
    # or every "reused" above is a constant rather than a detection.
    ("no-tell", {}, False),
]
for label, over, want_reused in TELLS:
    rc, out, err = analyze(lifecycle_payload(label, **over))
    if rc != 0:
        bad.append("[%s] did not analyse: %s" % (label, err.strip()[:120]))
        continue
    art = json.loads(out)
    pr = art.get("probe") or {}
    if pr.get("counts", {}).get("agree") is not True:
        bad.append("[%s] CONTROL FAILED: the counter is inconsistent (%s), so this "
                   "case cannot isolate its own tell — it would pass on the counter "
                   "disagreement instead" % (label, pr.get("counts")))
    if pr.get("reused") is not want_reused:
        bad.append("[%s] reused=%r, expected %r — this tell is the only signal a "
                   "correctly-draining re-used probe emits in production"
                   % (label, pr.get("reused"), want_reused))
    noted = any(n.startswith("PROBE REUSED") for n in art.get("notes", []))
    if noted is not want_reused:
        bad.append("[%s] the PROBE REUSED note %s" % (label, "is missing" if want_reused
                                                      else "fired on a fresh probe"))

# 🔴 --- arm 7: `dropped` IS PART OF THE WINDOW, and the corpus cannot say so.
# Every real and synthetic probe here has `dropped.network == 0`, so
# `window = observed + dropped` and `window = observed` are indistinguishable —
# the fixture-of-default-values trap: a fixture whose field can only ever hold
# the identity value cannot see a mutant that drops the term. This payload
# overflows the buffer instead.
p_drop = lifecycle_payload("dropped", **{"dropped": {"console": 0, "network": 2},
                                         "counts": {"networkTotal": n_rec + 2,
                                                    "networkSinceInstall": n_rec + 2}})
rc, out, err = analyze(p_drop)
if rc != 0:
    bad.append("the dropped-buffer payload did not analyse: %s" % err.strip()[:140])
else:
    pr = (json.loads(out).get("probe") or {})
    c = pr.get("counts") or {}
    if c.get("droppedThisDrain") != 2:
        bad.append("droppedThisDrain %r != 2 — the overflow is not reported" % c.get("droppedThisDrain"))
    if c.get("agree") is not True:
        bad.append("a counter of %s against %d record(s) + 2 DROPPED reads as "
                   "disagreeing: the dropped records are being left out of the "
                   "window, so any overflowing state is mislabelled re-used"
                   % (c.get("networkTotal"), n_rec))
    if pr.get("reused"):
        bad.append("an overflowing FRESH probe is reported as re-used")

# --- the ZERO note must still be REACHABLE, or arm 2's absence proves nothing.
# cg-discover's DOM with a probe whose counter agrees at zero: fetch hooked, no
# requests, nothing stale — the one case the note is true for.
v = json.loads(json.load(open(os.path.join(FIX, "cg-discover.probe.json")))
               ["result"]["data"]["value"])
v["counts"] = {"networkTotal": 0, "networkSinceInstall": 0}
v["installs"], v["drains"] = 1, 1
honest = os.path.join(WORK, "probe-honest-zero.json")
json.dump({"result": {"data": {"value": json.dumps(v)}}}, open(honest, "w"))
rc, out, err = analyze(honest, "cg-discover.dom.json")
if rc != 0:
    bad.append("POSITIVE CONTROL FAILED: the honest-zero probe did not analyse: %s" % err[:140])
else:
    c = json.loads(out)
    if not any(ZERO_NOTE in n for n in c.get("notes", [])):
        bad.append("POSITIVE CONTROL FAILED: the %r note is never emitted at all, so "
                   "its absence in arm 2 is a fact about the note, not about the "
                   "probe" % ZERO_NOTE)
    if (c.get("probe") or {}).get("reused"):
        bad.append("POSITIVE CONTROL FAILED: a fresh single-drain probe reads re-used")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E13: the artifact tells its own probe lifecycle — the REAL re-used drain (counter 4, records 0) reads reused/agree=false, is NAMED in the notes and the report, and no longer claims 'observed ZERO requests'; the fresh drain reads the opposite and the note is proven still reachable"
else
  fail "E13: a re-used probe is still indistinguishable from a fresh one, or the artifact still states a number its own records contradict"
  sed 's/^/          /' "${WORK}/e13.txt" | head -12
fi

# E14 🔴 THE PER-DRAIN LEDGER, PINNED AS LITERAL TEXT IN THE TEST. The drain
# hands back one WINDOW, so every field it reports must be reset by it. The
# counter was not, and that is the whole of defect 1(a). The expected statements
# live HERE rather than being read out of the module — a check that compares the
# module against itself agrees for free.
if python3 - "$EVID" >"${WORK}/e14.txt" 2>&1 <<'PY'
import os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
import evidence as E
bad = []
EXPECT = ("S.console = [];", "S.network = [];", "S.counts.networkTotal = 0;",
          "S.dropped.console = 0;", "S.dropped.network = 0;")
js = E.PROBE_DRAIN_JS
for stmt in EXPECT:
    n = js.count(stmt)
    if n != 1:
        bad.append("the drain contains %r %d time(s), expected exactly 1 — a field "
                   "it REPORTS and does not RESET is cumulative while the array "
                   "beside it is per-drain" % (stmt, n))
# 🔴 THE POSITIVE CONTROL, REWRITTEN — the previous one could not fire on ANY
# input. It read `if any(s in js.replace(s, "") ...)`: `.replace` removes EVERY
# occurrence, so the membership test was unconditionally False and the control
# was green against the real drain, against a drain with the reset deleted, and
# against the empty string alike. A control that cannot go red is decoration.
# This one runs the SAME scan over a drain with one reset deleted and requires it
# to report that statement missing — and requires the count to move, so it cannot
# pass on a scan wired to nothing.
control_src = js.replace("S.counts.networkTotal = 0;", "", 1)
if control_src == js:
    bad.append("POSITIVE CONTROL SKIPPED: the reset this control deletes is ALREADY "
               "absent from the drain, so the control could not be built — read the "
               "line above, which is the real finding")
elif control_src.count("S.counts.networkTotal = 0;") != 0:
    bad.append("POSITIVE CONTROL FAILED: the reset survived its own deletion")
else:
    missing = [s for s in EXPECT if control_src.count(s) != 1]
    if missing != ["S.counts.networkTotal = 0;"]:
        bad.append("POSITIVE CONTROL FAILED: deleting the networkTotal reset made the "
                   "scan report %s — it must report exactly that one statement "
                   "missing, or the scan is not what is deciding" % (missing or "NOTHING"))
# 🔴 THE LEDGER, BOTH DIRECTIONS. evidence.PER_DRAIN_RESETS is what the module
# claims; EXPECT is what this test requires. They must be the SAME SET, so the
# gate fails when the ledger GROWS (a new per-drain field nobody reset) or
# SHRINKS (a reset quietly dropped from the contract).
if set(E.PER_DRAIN_RESETS) != set(EXPECT):
    bad.append("PER_DRAIN_RESETS %s != the pinned %s"
               % (sorted(E.PER_DRAIN_RESETS), sorted(EXPECT)))
# the drain must stamp which drain this is, BEFORE serialising (or the payload
# always says 0 and a re-used probe stays invisible)
if "S.drains = (S.drains || 0) + 1;" not in js:
    bad.append("the drain does not stamp `drains`")
if js.index("S.drains = (S.drains || 0) + 1;") > js.index("var out = JSON.stringify(S);"):
    bad.append("`drains` is stamped AFTER the payload is serialised, so every "
               "payload reports the previous value")
# and the INSTALL half of defect 1(b): the re-install branch must write onto the
# SURVIVING object, because only the drain is ever saved to disk
inst = E.PROBE_INSTALL_JS
for stmt in ("P.reinstalled = true;", "P.installs = (P.installs || 1) + 1;"):
    if stmt not in inst:
        bad.append("the re-install branch does not %r — `reinstalled` would stay the "
                   "value set at FIRST install, and capture.sh only ever writes the "
                   "DRAIN, so meta.reinstalled could never be true" % stmt)
if "installs:1, drains:0" not in inst.replace(" ", "").replace(",", ", "):
    pass  # shape-insensitive: the counters are asserted through analyze() in E13
print("RESETS=%d" % len(EXPECT))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E14: the drain resets EVERY per-drain field ($(grep -o 'RESETS=[0-9]*' "${WORK}/e14.txt")), stamps its drain number before serialising, and the re-install branch writes reinstalled/installs onto the SURVIVING object — the ledger matches the module's own PER_DRAIN_RESETS in both directions"
else
  fail "E14: a field the drain REPORTS is not one the drain RESETS (or a re-used probe cannot mark itself)"
  sed 's/^/          /' "${WORK}/e14.txt" | head -10
fi

# E15 — the counter may run AHEAD of its records (a re-used probe) and NEVER
# behind them. Behind means the payload is not the one the probe produced.
python3 - "$EVFIX" "${WORK}" <<'PY'
import json, os, sys
FIX, WORK = sys.argv[1:3]
d = json.load(open(os.path.join(FIX, "cg-explainer.probe.json")))
v = json.loads(d["result"]["data"]["value"])
assert len(v["network"]) == 4, v["counts"]
v["counts"]["networkTotal"] = 1          # 1 < 4 records: impossible under any lifecycle
json.dump({"result": {"data": {"value": json.dumps(v)}}},
          open(os.path.join(WORK, "probe-counter-behind.json"), "w"))
PY
expect_refuse "E15 NEG: a probe counter BEHIND the records it counts is refused — cumulative drift can only run ahead" probe_counts_impossible -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "${WORK}/probe-counter-behind.json" --state x
expect_ok "E15b POS control for E15: the same real probe, counter untouched, analyses fine" -- \
  python3 "$EVID" analyze --dom "$EVFIX/cg-explainer.dom.json" --probe "$EVFIX/cg-explainer.probe.json" --state x

# E16 🔴 DEFECT 3, AT THE PLAN LEVEL. The screenshot used to be emitted
# unconditionally and `plan_evidence_read` ran AFTER it, so on a run that
# discards the picture a bridge-side screenshot failure took the DOM read and the
# drain with it — and reported it as a failing recipe ACTION. plan.py did not
# know --no-frame existed.
if python3 - "$PLAN" "$RECIPES/custom-generators.json" "${WORK}/obs-ok.json" >"${WORK}/e16.txt" 2>&1 <<'PY'
import json, subprocess, sys
PLAN, RECIPE, OBS = sys.argv[1:4]
bad, n = [], 0


def plan(extra):
    p = subprocess.run(["python3", PLAN, RECIPE, "--observed", OBS, "--state",
                        "discover"] + extra, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


for state_extra in (["--evidence"], ["--evidence", "--no-screenshot"]):
    rc, out, err = plan(state_extra)
    if rc != 0:
        bad.append("%s did not plan: %s" % (state_extra, err.strip()[:120]))
        continue
    pl = json.loads(out)
    steps = pl["steps"]
    ops = [s["op"] for s in steps]
    want_shot = "--no-screenshot" not in state_extra
    n += 1
    if ("screenshot" in ops) != want_shot:
        bad.append("%s: screenshot present=%s, expected %s"
                   % (state_extra, "screenshot" in ops, want_shot))
    if pl.get("screenshot") is not want_shot:
        bad.append("%s: the plan is not marked screenshot=%s" % (state_extra, want_shot))
    # the EVIDENCE half must survive either way — that is the whole point
    dom = [i for i, s in enumerate(steps) if s.get("captureDom")]
    drain = [i for i, s in enumerate(steps) if s.get("captureProbe")]
    if len(dom) != 1 or len(drain) != 1:
        bad.append("%s: the DOM read/drain did not survive (%s/%s)"
                   % (state_extra, len(dom), len(drain)))
    elif dom[0] > drain[0]:
        bad.append("%s: the drain precedes the DOM read" % state_extra)
    if not want_shot:
        # ...and with no capture there is nothing to raise the window FOR at the
        # moment of a capture that does not happen
        if any(s.get("foreground") == "pre-screenshot" for s in steps):
            bad.append("a pre-screenshot foreground re-assert survives a plan with no "
                       "screenshot — it takes the operator's screen for nothing")
        # 🔴 BUT THE STATE'S OWN RE-ASSERT MUST SURVIVE, AND THIS IS DEFECT 1.
        # The re-assert used to be emitted inside `if screenshot:`, so exactly the
        # run that discards the picture — `--evidence --no-frame`, the defect-hunt
        # — planned ZERO activates and leaned on a once-per-tab foregrounding that
        # is gone within ~1.5 s. Measured live on model-benchmarking: state 1
        # booted, state 2 came back `exit 11` CONFOUND, and the state plans on
        # disk carried no `activate` at all. A screenshot-free run still boots and
        # drives an App Block, so it needs the window at least as much.
        lead = [i for i, s in enumerate(steps) if s.get("foreground") == "state"]
        if lead != [0]:
            bad.append("%s: a screenshot-free state plan must still OPEN with the "
                       "`state` foreground re-assert; found it at %s (activates=%s). "
                       "Without it the app-ready gate runs against a window nothing "
                       "raised and reports a CONFOUND."
                       % (state_extra, lead or "nowhere",
                          [s.get("foreground") for s in steps if s["op"] == "activate"]))

# 🔴 A PLAN THAT PRODUCES NOTHING IS REFUSED, and the paired positive is the same
# flag WITH --evidence (above).
rc, out, err = plan(["--no-screenshot"])
if rc != 2 or "no_output" not in err:
    bad.append("--no-screenshot without --evidence was not refused (rc=%d): %s"
               % (rc, err.strip()[:120]))
if n != 2:
    bad.append("POSITIVE CONTROL FAILED: only %d of 2 plan shapes built" % n)
print("SHAPES=%d" % n)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "E16: --no-screenshot drops the capture (and only the re-assert that exists for it — the state's OWN re-assert still opens the plan) while the DOM read and the drain SURVIVE; the same flag without --evidence is refused as no_output ($(grep -o 'SHAPES=[0-9]*' "${WORK}/e16.txt"))"
else
  fail "E16: the screenshot is still mandatory, dropping it takes the evidence with it, or a screenshot-free run has lost the foreground re-assert that holds the window for its own app-ready gate"
  sed 's/^/          /' "${WORK}/e16.txt" | head -10
fi

# ---------------------------------------------------------------------------
echo
echo "--- G: foregrounding vs spending, and the app-ready gate ---------------"
# ---------------------------------------------------------------------------
# 🔴 THE COLLISION THIS GROUP RESOLVES. Until 2026-08-17 this skill banned
# `browser activate` outside --trusted, because activation is what lets a genuine
# OS keypress reach the page and therefore what makes SPENDING possible. Then the
# first live --evidence run measured that an App Block DOES NOT BOOT in a hidden
# tab (5/5 deadlock on BLOCK_INIT), so the ban made `capture` structurally
# incapable of capturing any App Block.
#
# 🔴 THAT MEASUREMENT IS RETRACTED (2026-08-24): App Blocks boot hidden, 4/4, one
# of them with no `activate` at all — claudedocs/app-capture-hidden-tab-boot-2026-08-24.md.
# The 5/5 is unexplained and is NOT evidence for the requirement, and the raise's
# HOST-SIDE half is withheld besides (every capture-path activate sends
# --no-focus, so the bridge answers i3: withheld). 🔴 "inert" — the word that
# stood here — is RETRACTED: the tab is still made ACTIVE, and
# windows.update{focused:true} is ungated. This group is
# kept because what it actually proves is the SEPARATION below, which is a
# property of the code and survives the retraction intact.
#
# The resolution is that ACTIVATION and ACTUATION are different things and are
# now guarded by two checks that CANNOT stand in for each other: `activate` is
# allowed, and only in a dedicated foreground plan; `xdotool`/`--clearmodifiers`
# is refused in ANY plan built without --trusted, by a post-condition over the
# assembled steps. G2 is the gate that proves the separation, by mutating a copy
# of plan.py so the foreground path also emits an actuation step.

# G1 — the foreground plan's shape, with the spend refusal still standing.
if python3 - "$PLAN" "$RECIPES/custom-generators.json" "$RECIPES/panorama-360.json" \
     "${WORK}/obs-ok.json" "${WORK}/obs-pano.json" >"${WORK}/g1.txt" 2>&1 <<'PY'
import json, subprocess, sys
PLAN, REC_CG, REC_PANO, OBS_CG, OBS_PANO = sys.argv[1:6]
bad = []


def run(args):
    p = subprocess.run(["python3", PLAN] + args, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


rc, out, err = run([REC_CG, "--observed", OBS_CG, "--foreground-plan"])
if rc != 0:
    bad.append("the foreground plan did not build: %s" % err.strip()[:140])
else:
    plan = json.loads(out)
    steps = plan["steps"]
    ops = [s["op"] for s in steps]
    flat = [" ".join(s["argv"]) for s in steps]
    if "activate" not in ops:
        bad.append("the foreground plan does not foreground anything (ops=%s) — "
                   "raising the tab is the entire purpose of this plan" % ops)
    for s in steps:
        if "--frame" in s["argv"]:
            bad.append("a foreground step is frame-scoped (%s) — it runs BEFORE the "
                       "app frame exists" % s["op"])
    # the separation, from the allowed side
    for f in flat:
        if "xdotool" in f or "--clearmodifiers" in f:
            bad.append("the foreground plan carries ACTUATION: %s" % f[:80])
    if not plan.get("warnings"):
        bad.append("taking the operator's screen is not announced")
    if plan.get("trusted") is not False:
        bad.append("the foreground plan is not marked trusted:false")

# ...and mixing the two flags is refused rather than quietly honoured
rc, _, err = run([REC_CG, "--observed", OBS_CG, "--foreground-plan", "--trusted"])
if rc != 2 or "bad_usage" not in err:
    bad.append("--foreground-plan --trusted was not refused (rc=%d)" % rc)

# 🔴 THE SPEND REFUSAL MUST STILL STAND. Allowing activation must not have
# loosened anything about spending.
rc, _, err = run([REC_PANO, "--observed", OBS_PANO, "--state", "rendering"])
if rc != 2 or "trusted_required" not in err:
    bad.append("trustedKey no longer refuses without --trusted (rc=%d): allowing "
               "activation has leaked into the spend path" % rc)

# POSITIVE CONTROL for every "no xdotool" finding above: with --trusted the very
# same scanner DOES see actuation. Without this, "no actuation found" is
# indistinguishable from a scan wired to nothing.
rc, out, err = run([REC_PANO, "--observed", OBS_PANO, "--state", "rendering", "--trusted"])
if rc != 0:
    bad.append("POSITIVE CONTROL FAILED: the trusted plan did not build: %s" % err[:120])
else:
    flat = [" ".join(s["argv"]) for s in json.loads(out)["steps"]]
    if not any("xdotool" in f for f in flat):
        bad.append("POSITIVE CONTROL FAILED: the scan cannot see actuation even in a "
                   "--trusted plan, so its silence elsewhere means nothing")
    if not any("--clearmodifiers" in f for f in flat):
        bad.append("POSITIVE CONTROL FAILED: the --clearmodifiers token never appears")

# 🔴 THE FOREGROUND PLANNER MUST BE UNABLE TO EMIT A FRAME-SCOPED OP AT ALL,
# rather than merely not doing so today: it is built BEFORE the app frame
# exists, so a frame-scoped step there would be scoped to `None` and read the
# top frame. Exercised through the module API because no shipped call site
# reaches it — an assertion nothing can reach is not a guard.
import os
sys.path.insert(0, os.path.dirname(PLAN))
import plan as P
pl = P.Planner({"instance": "work", "tabId": 1}, None, False)
try:
    pl.emit_dom("html", [], "should be impossible")
    bad.append("the foreground planner emitted a frame-scoped op with NO resolved "
               "frame id — it would have read the top frame")
except P.Refuse as e:
    if e.code != "frame_unresolved":
        bad.append("wrong refusal for a frame-scoped foreground op: %s" % e.code)
# ...and the same planner WITH a frame id must still work, or the check above is
# just a broken emitter.
pl2 = P.Planner({"instance": "work", "tabId": 1}, 830, False)
pl2.emit_dom("html", [], "ordinary")
if "--frame" not in pl2.steps[0]["argv"]:
    bad.append("POSITIVE CONTROL FAILED: emit_dom no longer scopes an ordinary op")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G1: --foreground-plan emits \`activate\` (tab-level, no --frame, announced) and NO actuation; trustedKey still refuses without --trusted; the actuation scan is proven able to see xdotool in a --trusted plan"
else
  fail "G1: the foreground plan is wrong, or allowing activation loosened the spend path"
  sed 's/^/          /' "${WORK}/g1.txt" | head -10
fi

# G2 🔴 THE SEPARABILITY PROOF. One mutation of a COPY of plan.py makes EVERY
# planner emit an actuation step as its first step, so the SAME edit reaches the
# foreground plan and every state plan. (It used to plant after the shared `wake`
# emitter; that lands BETWEEN the pre-screenshot foreground re-assert and the
# capture it exists for, so from 2026-08-18 the placement guard refuses it first
# and the three arms below could no longer attribute anything. Planting in the
# Planner's constructor is shared by CONSTRUCTION rather than by call site, which
# is strictly stronger.) The three arms are the whole claim:
# refused in a foreground plan, refused in a non-trusted state plan, and PLANNED
# under --trusted — i.e. the actuation guard is doing the work, not the
# foreground guard, and neither can substitute for the other.
if python3 - "$EVID" "$PLAN" "$RECIPES/custom-generators.json" "$RECIPES/panorama-360.json" \
     "${WORK}/obs-ok.json" "${WORK}/obs-pano.json" "${WORK}" >"${WORK}/g2.txt" 2>&1 <<'PY'
import json, os, shutil, subprocess, sys
EVID, PLAN, REC_CG, REC_PANO, OBS_CG, OBS_PANO, WORK = sys.argv[1:8]
bad = []
needle = '        self.steps = []'

# 🔴 ONE PLANT PER CLAUSE OF THE BAN, NOT ONE PLANT FOR THE WHOLE BAN. The first
# version of this gate planted a single step carrying BOTH `xdotool` and
# `--clearmodifiers`, so a mutant that deleted the `xdotool` token AND its op
# entry SURVIVED the whole battery: the step still matched on the OTHER token.
# Each arm below is the narrowest thing a clause can be wrong about, so a kill
# here names which clause is doing the work.
PLANTS = [
    ("xdotool token", 'self._add("press", ["xdotool", "getactivewindow"], "planted")'),
    ("--clearmodifiers token", 'self._add("press", ["some-key-tool", "key", "--clearmodifiers", "Return"], "planted")'),
    ("xdotool OP with an innocent argv", 'self._add("xdotool", ["true"], "planted")'),
]
for label, stmt in PLANTS:
    mut = os.path.join(WORK, "actuation-mut-%s" % abs(hash(label)))
    shutil.rmtree(mut, ignore_errors=True)
    shutil.copytree(os.path.dirname(PLAN), mut)
    shutil.rmtree(os.path.join(mut, "__pycache__"), ignore_errors=True)
    src = open(os.path.join(mut, "plan.py")).read()
    if src.count(needle) != 1:
        bad.append("cannot plant %s: anchor occurs %d times" % (label, src.count(needle)))
        continue
    open(os.path.join(mut, "plan.py"), "w").write(
        src.replace(needle, needle + "\n        " + stmt, 1))
    MPLAN = os.path.join(mut, "plan.py")

    def run(args):
        p = subprocess.run(["python3", MPLAN] + args, capture_output=True, text=True)
        return p.returncode, p.stdout, p.stderr

    rc, _, err = run([REC_CG, "--observed", OBS_CG, "--foreground-plan"])
    if rc != 2 or "actuation_without_trusted" not in err:
        bad.append("[%s] an actuation step smuggled into the FOREGROUND plan was NOT "
                   "refused (rc=%d): %s" % (label, rc, err.strip()[:120]))
    rc, _, err = run([REC_CG, "--observed", OBS_CG, "--state", "discover"])
    if rc != 2 or "actuation_without_trusted" not in err:
        bad.append("[%s] an actuation step in a NON-TRUSTED state plan was not refused "
                   "(rc=%d): %s" % (label, rc, err.strip()[:120]))
    # attribution + the paired positive: the mutation itself is plannable, and it
    # is the ABSENCE of --trusted that refuses it — not a broken mutant.
    rc, out, err = run([REC_PANO, "--observed", OBS_PANO, "--state", "rendering", "--trusted"])
    if rc != 0:
        bad.append("[%s] POSITIVE CONTROL FAILED: the same mutant does not plan even "
                   "WITH --trusted (rc=%d, %s), so the refusals above cannot be "
                   "attributed to the trust check" % (label, rc, err.strip()[:120]))
    elif not any("planted" in s.get("note", "") for s in json.loads(out)["steps"]):
        bad.append("[%s] POSITIVE CONTROL FAILED: the planted actuation step is not in "
                   "the trusted plan, so it was never really planted" % label)
print("PLANTS=%d" % len(PLANTS))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G2: activation and actuation are SEPARABLE — each clause of the ban planted on its own ($(grep -o 'PLANTS=[0-9]*' "${WORK}/g2.txt")) is refused (actuation_without_trusted) in both the foreground plan and a non-trusted state plan, while the same mutant plans fine WITH --trusted"
else
  fail "G2: the foreground path can carry actuation, or the guard is not the one refusing"
  sed 's/^/          /' "${WORK}/g2.txt" | head -10
fi

# G18 🔴 THE OTHER ROUTE TO A TRUSTED EVENT — a DOM op with no --frame.
#
# G1/G2 prove the ACTUATION ban. This proves the ban it cannot see. `emit_dom`
# adds --frame so no call site has to remember to, but `emit_tab` takes an
# arbitrary op name: until 2026-08-23 nothing refused a `click` emitted through
# it, and `DOM_OPS` was declared and never read. That matters beyond reading the
# wrong document — the bridge dispatches a --frame op SYNTHETICALLY
# (`trusted:false`, which is precisely why the spend path rejects it) but takes
# the CDP Input path on the TOP frame, where the event is `trusted:true`. So an
# unscoped click is a second way to deliver a trusted event, and it spells no
# `xdotool`: guard_no_actuation would pass it.
#
# 🔴 THE GUARD IS NOT TRUST-GATED, and one arm below pins that: --trusted buys
# the SPEND path, not the right to address the host page by accident.
if python3 - "$PLAN" "$RECIPES/custom-generators.json" "$RECIPES/panorama-360.json" \
     "${WORK}/obs-ok.json" "${WORK}/obs-pano.json" "${WORK}" >"${WORK}/g18.txt" 2>&1 <<'PY'
import importlib.util, json, os, shutil, subprocess, sys
PLAN, REC_CG, REC_PANO, OBS_CG, OBS_PANO, WORK = sys.argv[1:7]
bad = []

# ── ARM 1: the guard itself, through the module API. No ordering, no plan, no
# other guard — so a refusal here cannot be another clause's doing. The SCOPED
# case is the positive control: a guard that refuses both arms refuses nothing.
spec = importlib.util.spec_from_file_location("plan_under_test", PLAN)
P = importlib.util.module_from_spec(spec)
sys.path.insert(0, os.path.dirname(PLAN))
spec.loader.exec_module(P)

# 🔴 A MISSING GUARD IS A FINDING, NOT A TRACEBACK. Read against pre-change
# code the getattr raised AttributeError and aborted the whole gate, so arms 2
# and 3 were never exercised — the red proved only that arm 1 could not run.
# Each arm has to be able to report its own red independently.
GUARD = getattr(P, "guard_dom_scoping", None)
if GUARD is None:
    bad.append("plan.py exposes no guard_dom_scoping — the refusal this gate is "
               "about does not exist")
if not getattr(P, "DOM_OPS", ()):
    bad.append("DOM_OPS is empty or absent — the guard has nothing to check and "
               "every arm below would pass vacuously")
for op in (P.DOM_OPS if GUARD else ()):
    unscoped = [{"op": op, "argv": ["browser", "--tab", "9", op, "#x"], "note": "n"}]
    scoped = [{"op": op, "argv": ["browser", "--tab", "9", "--frame", "7", op, "#x"], "note": "n"}]
    try:
        GUARD(unscoped)
        bad.append("an UNSCOPED %r op was not refused" % op)
    except P.Refuse as e:
        if e.code != "dom_op_unscoped":
            bad.append("an unscoped %r op was refused as %r, not dom_op_unscoped" % (op, e.code))
    try:
        GUARD(scoped)                        # POSITIVE CONTROL
    except P.Refuse as e:
        bad.append("POSITIVE CONTROL FAILED: a correctly --frame-scoped %r op was "
                   "refused as %r — the guard refuses everything" % (op, e.code))
# and a tab-level op that is NOT a DOM op must pass, or the guard is just "no
# unscoped steps" wearing a different name.
if GUARD:
    try:
        GUARD([{"op": "screenshot", "argv": ["browser", "screenshot"], "note": "n"}])
    except P.Refuse as e:
        bad.append("POSITIVE CONTROL FAILED: a tab-level `screenshot` was refused as %r" % e.code)

# ── ARM 2: a PLANTED edit, end to end through the real builders. Two plants,
# because the two builders are reached differently: the constructor plant is
# shared by CONSTRUCTION (it reaches the foreground plan, which has no state and
# no actions), and the call-site plant is the realistic future edit — someone
# swaps emit_dom for emit_tab on the click path.
PLANTS = [
    ("constructor: an unscoped `js` shared by every planner",
     '        self.steps = []',
     '        self.steps = []\n        self.emit_tab("js", ["1"], "planted")',
     ("foreground", "state", "trusted-pano")),
    # 🔴 ITS TRUSTED ARM IS A DIFFERENT RECIPE ON PURPOSE. panorama-360's only
    # --trusted state (`rendering`) has NO click, so this plant cannot reach it
    # and the arm passed vacuously at rc=0 — the plant was never applied to
    # anything. The arm has to be a state that actually clicks.
    ("call site: the real click path emitted tab-level",
     '            p.emit_dom("click", [a["click"]], "click %s" % a["click"])',
     '            p.emit_tab("click", [a["click"]], "click %s" % a["click"])',
     ("state", "trusted-cg")),
]
for label, needle, repl, arms in PLANTS:
    mut = os.path.join(WORK, "domscope-mut-%s" % abs(hash(label)))
    shutil.rmtree(mut, ignore_errors=True)
    shutil.copytree(os.path.dirname(PLAN), mut)
    shutil.rmtree(os.path.join(mut, "__pycache__"), ignore_errors=True)
    src = open(os.path.join(mut, "plan.py")).read()
    if src.count(needle) != 1:
        bad.append("cannot plant %s: anchor occurs %d times" % (label, src.count(needle)))
        continue
    open(os.path.join(mut, "plan.py"), "w").write(src.replace(needle, repl, 1))
    MPLAN = os.path.join(mut, "plan.py")

    def run(plan_py, args):
        p = subprocess.run(["python3", plan_py] + args, capture_output=True, text=True)
        return p.returncode, p.stdout, p.stderr

    argsets = {
        "foreground": [REC_CG, "--observed", OBS_CG, "--foreground-plan"],
        "state":      [REC_CG, "--observed", OBS_CG, "--state", "discover"],
        # 🔴 --trusted must NOT excuse it. It buys the spend path, not an
        # unscoped DOM op — and it also proves this refusal is not
        # guard_no_actuation's (which returns immediately under --trusted).
        # Two of them because a plant can only be tested on a state that
        # actually reaches it (see the note on PLANTS).
        "trusted-pano": [REC_PANO, "--observed", OBS_PANO, "--state", "rendering", "--trusted"],
        "trusted-cg":   [REC_CG, "--observed", OBS_CG, "--state", "discover", "--trusted"],
    }
    for arm in arms:
        rc, _, err = run(MPLAN, argsets[arm])
        if rc != 2 or "dom_op_unscoped" not in err:
            bad.append("[%s] the %s plan did not refuse with dom_op_unscoped (rc=%d): %s"
                       % (label, arm, rc, err.strip()[:140]))
    # POSITIVE CONTROL: the very same arms plan fine on the UNMUTATED tree, so
    # the refusals above are the plant and not a broken copy.
    for arm in arms:
        rc, _, err = run(PLAN, argsets[arm])
        if rc != 0:
            bad.append("[%s] POSITIVE CONTROL FAILED: the pristine plan.py does not plan "
                       "the %s arm either (rc=%d): %s" % (label, arm, rc, err.strip()[:140]))

# ── ARM 3: the guard is REACHABLE on real input. A guard whose op set never
# appears in a real plan is green for free.
rc = subprocess.run(["python3", PLAN, REC_CG, "--observed", OBS_CG, "--state", "discover"],
                    capture_output=True, text=True)
steps = json.loads(rc.stdout)["steps"]
dom = [s for s in steps if s["op"] in P.DOM_OPS]
if not dom:
    bad.append("REACHABILITY FAILED: a real state plan contains no DOM_OPS step at all, "
               "so the guard never executes on anything this skill actually emits")
if any("--frame" not in s["argv"] for s in dom):
    bad.append("a real plan already carries an unscoped DOM op — the guard is not running")
print("PLANTS=%d DOM_OPS=%d REAL_DOM_STEPS=%d" % (len(PLANTS), len(getattr(P, "DOM_OPS", ())), len(dom)))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G18: a DOM op with no --frame is REFUSED by its own code (dom_op_unscoped) — proven through the module API for every DOM_OPS member with the --frame-scoped and tab-level cases as positive controls, and end-to-end through both builders on two planted edits, each of which the pristine tree plans fine; --trusted does not excuse it, and a real plan carries scoped DOM steps so the guard is reachable ($(grep -o 'PLANTS=[0-9]* DOM_OPS=[0-9]* REAL_DOM_STEPS=[0-9]*' "${WORK}/g18.txt"))"
else
  fail "G18: an unscoped DOM op survives into a plan, or the refusal is not this guard's"
  sed 's/^/          /' "${WORK}/g18.txt" | head -12
fi

# G19 🔴 THE MUTATING CLICK — the hazard the spend ban does NOT cover.
#
# "A synthetic in-frame click does nothing on a money button" is measured and
# NARROW: it is about the SPEND path. An ordinary authenticated mutation — post,
# vote, edit, withdraw — has no such rejection. Measured 2026-08-23 on
# app-requests (`submit-btn`, `vote-btn`, `edit-btn`, `withdraw-btn` all live and
# all clickable), nothing in plan.py said no.
#
# 🔴 THIS GATE PINS A LEDGER, NOT A DETECTOR, and the distinction is the point.
# A mutating control cannot be detected from a pure planner — so the arms below
# never assert "the guard knows vote-btn is dangerous". They assert that a click
# outside the declared set is REFUSED, that a stale declaration is refused too,
# and — the controls — that a correct ledger plans, a click-free recipe needs no
# ledger, and `type` is NOT swept in. Without those last three this would be
# indistinguishable from a guard that refuses every recipe.
if python3 - "$PLAN" "$RECIPES" "${WORK}/obs-ok.json" "${WORK}" >"${WORK}/g19.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
PLAN, RECIPES, OBS, WORK = sys.argv[1:5]
bad = []
BASE = {"slug": "ledger", "frameHost": "custom-generators.civit.ai",
        "ready": {"testid": "discover-list"}}

def plan(recipe, state, extra=()):
    p = os.path.join(WORK, "g19-%s.json" % abs(hash(json.dumps(recipe, sort_keys=True))))
    json.dump(recipe, open(p, "w"))
    r = subprocess.run(["python3", PLAN, p, "--observed", OBS, "--state", state] + list(extra),
                       capture_output=True, text=True)
    return r.returncode, r.stderr

def rec(actions, ledger=None):
    r = dict(BASE); r["states"] = [{"name": "s", "actions": actions}]
    if ledger is not None:
        r["clickable"] = ledger
    return r

CLICK = [{"click": "#tab-mine"}]
# ── NEGATIVE ARMS, one per clause, each asserting its OWN code (a shared code
# lets one clause cover for another and records coverage that does not exist).
for label, recipe, code in [
    ("a click with NO ledger at all", rec(CLICK), "no_click_ledger"),
    ("a click OUTSIDE the ledger", rec(CLICK, ["#something-else"]), "click_unledgered"),
    ("a ledger entry no state clicks", rec(CLICK, ["#tab-mine", "#stale"]), "clickable_unused"),
    # `key` is in the ledger's scope because Enter on a focused input submits the
    # form it sits in — the same mutation its submit button would make.
    ("a `key` on a selector, unledgered",
     rec([{"key": "Enter", "selector": "#title-input"}]), "no_click_ledger"),
]:
    rc, err = plan(recipe, "s")
    if rc != 2 or code not in err:
        bad.append("%s was not refused with %s (rc=%d): %s" % (label, code, rc, err.strip()[:130]))

# ── POSITIVE CONTROLS. Without these the arms above are satisfied by a guard
# that refuses everything.
for label, recipe in [
    ("a click WITH a correct ledger", rec(CLICK, ["#tab-mine"])),
    ("a recipe with NO clicking actions and no ledger",
     rec([{"waitForText": "Discover"}])),
    # `type` fills a field; it does not activate a control. If it were swept in,
    # the ledger would grow to cover things it makes no claim about.
    ("a `type` action with no ledger",
     rec([{"type": "hello", "selector": "#title-input"}])),
]:
    rc, err = plan(recipe, "s")
    if rc != 0:
        bad.append("POSITIVE CONTROL FAILED: %s did not plan (rc=%d): %s"
                   % (label, rc, err.strip()[:130]))

# ── THE REAL CORPUS. A ledger that has drifted from the recipe it describes is
# the failure this gate exists to make loud, so pin every shipped recipe's
# ledger against what its states actually activate — and count them, so a
# recipe silently losing its clicks cannot pass this by having nothing to check.
import glob
n_led = 0
for f in sorted(glob.glob(os.path.join(RECIPES, "*.json"))):
    r = json.load(open(f))
    used = []
    for s in r["states"]:
        for a in s.get("actions", []):
            for v in ("click", "clickIfPresent", "key"):
                if v in a:
                    sel = a.get("selector") if v == "key" else a[v]
                    if sel and sel not in used:
                        used.append(sel)
    led = r.get("clickable")
    if not used:
        if led:
            bad.append("%s declares a `clickable` ledger but activates nothing"
                       % os.path.basename(f))
        continue
    n_led += 1
    if sorted(led or []) != sorted(used):
        bad.append("%s: ledger %s != activated %s"
                   % (os.path.basename(f), sorted(led or []), sorted(used)))
if n_led < 3:
    bad.append("only %d shipped recipe(s) activate a control — too few for this "
               "corpus check to mean anything" % n_led)
print("LEDGERED_RECIPES=%d" % n_led)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G19: a control-activating action outside the recipe's declared \`clickable\` ledger is REFUSED, and so is a stale ledger entry — each by its own code (no_click_ledger / click_unledgered / clickable_unused), \`key\` included because Enter submits — while a correct ledger, a click-free recipe and a bare \`type\` all plan fine, and every shipped recipe's ledger equals what it actually activates ($(grep -o 'LEDGERED_RECIPES=[0-9]*' "${WORK}/g19.txt"))"
else
  fail "G19: a recipe can activate an undeclared control, or the ledger refuses the good case"
  sed 's/^/          /' "${WORK}/g19.txt" | head -12
fi

# G3 — the APP-READY gate: present in every state of every recipe, before every
# action, and refused when a recipe does not declare one.
if python3 - "$PLAN" "$RECIPES" "$FIXTURE_MAP" \
     >"${WORK}/g3.txt" 2>&1 <<'PY'
import glob, json, os, subprocess, sys
PLAN, RECIPES, FIXTURE_MAP = sys.argv[1:4]
FIXTURE = json.load(open(FIXTURE_MAP))   # single source — see FIXTURE_MAP above
ACTIONISH = ("click", "type", "key", "nav")
bad, n_states, n_ready = [], 0, 0
for r in sorted(glob.glob(os.path.join(RECIPES, "*.json"))):
    rec = json.load(open(r))
    obs = FIXTURE.get(rec["frameHost"])
    if obs is None:
        bad.append("%s: no observed fixture" % rec["slug"]); continue
    for st in rec["states"]:
        for extra in ([], ["--evidence"]):
            p = subprocess.run(["python3", PLAN, r, "--observed", obs, "--state",
                                st["name"], "--trusted"] + extra,
                               capture_output=True, text=True)
            if p.returncode != 0:
                bad.append("%s/%s did not plan: %s" % (rec["slug"], st["name"],
                                                       p.stderr.strip()[:90]))
                continue
            steps = json.loads(p.stdout)["steps"]
            n_states += 1
            ready = [i for i, s in enumerate(steps) if s.get("appReady")]
            if len(ready) != 1:
                bad.append("%s/%s%s: %d app-ready steps, expected exactly 1"
                           % (rec["slug"], st["name"], extra, len(ready)))
                continue
            n_ready += 1
            i = ready[0]
            s = steps[i]
            # 🔴 BEFORE EVERY ACTION. This is the whole defect: the first action of
            # every state was a click with nothing waiting for the app to boot, so
            # a late boot swallowed it and the NEXT wait timed out naming the
            # control — a defect report about the wrong component.
            first_action = next((j for j, x in enumerate(steps) if x["op"] in ACTIONISH), None)
            if first_action is not None and i > first_action:
                bad.append("%s/%s%s: the app-ready gate is at %d, AFTER the first "
                           "action at %d" % (rec["slug"], st["name"], extra, i, first_action))
            if "--frame" not in s["argv"]:
                bad.append("%s/%s: the app-ready gate is not frame-scoped" % (rec["slug"], st["name"]))
            if s.get("expect") != "APPBOOT_READY":
                bad.append("%s/%s: the gate does not poll for a positive ready token "
                           "(expect=%r) — waiting only for a loading marker to vanish "
                           "cannot tell 'booted' from 'never started'"
                           % (rec["slug"], st["name"], s.get("expect")))
            if not s.get("timeoutMs"):
                bad.append("%s/%s: the app-ready gate has no timeout" % (rec["slug"], st["name"]))
            js = " ".join(s["argv"])
            # 🔴 THE PROBE MUST ASK ABOUT THE MARKUP BEFORE IT ASKS ABOUT THE TAB.
            # It used to short-circuit on `visibilityState !== "visible"` before
            # querying anything, so a hidden-but-working app was refused outright:
            # measured live 2026-08-19, panorama-360 reported
            # `visibilityState: hidden` while rendering 16 testids, no
            # `app-loading`, and accepting a click that changed the prompt. The
            # visibility question survives — it is still the only thing that can
            # separate "this anchor never appears" from "this window was never
            # raised" — but it is now the TIE-BREAK for an ABSENT anchor.
            if "visibilityState" not in js:
                bad.append("%s/%s: the ready probe never asks whether the tab is "
                           "VISIBLE, so a window that was never raised and a wrong "
                           "anchor answer identically" % (rec["slug"], st["name"]))
            if js.index("visibilityState") < js.index("querySelector"):
                bad.append("%s/%s: the visibility question comes BEFORE the markup "
                           "question — a booted, drivable app reporting hidden is "
                           "then refused without its anchor ever being looked at"
                           % (rec["slug"], st["name"]))
            if "app-loading" not in js:
                bad.append("%s/%s: the gate never looks for the loading shell" % (rec["slug"], st["name"]))
            anchor = rec["ready"].get("testid") or rec["ready"].get("selector")
            if anchor not in js:
                bad.append("%s/%s: the gate does not use the recipe's own anchor %r"
                           % (rec["slug"], st["name"], anchor))
            if extra:
                # step 0 is the state's foreground re-assert (a tab-level op that
                # touches no DOM and logs nothing), then the probe install, then
                # this gate. The install must still precede everything that can
                # log, which is everything from the gate onwards.
                if steps[0].get("foreground") != "state":
                    bad.append("%s/%s: the state plan does not open with the "
                               "foreground re-assert (%s)"
                               % (rec["slug"], st["name"], steps[0]["op"]))
                if steps[1].get("probe") != "install":
                    bad.append("%s/%s: under --evidence the probe install is no longer "
                               "the first app-touching step, so a boot-time console "
                               "error is lost" % (rec["slug"], st["name"]))
                if i != 2:
                    bad.append("%s/%s: under --evidence the gate is at %d, expected 2 "
                               "(re-assert, install, gate)" % (rec["slug"], st["name"], i))
if n_ready < 20:
    bad.append("POSITIVE CONTROL FAILED: only %d app-ready gates inspected across %d "
               "state plans" % (n_ready, n_states))
print("READY_GATES=%d of %d state plans" % (n_ready, n_states))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G3: every state of every recipe opens with ONE frame-scoped app-ready gate, before the first action, polling a positive token with a timeout and using the recipe's own anchor ($(grep -o 'READY_GATES=.*' "${WORK}/g3.txt"))"
else
  fail "G3: a state can still fire its first action into a booting app"
  sed 's/^/          /' "${WORK}/g3.txt" | head -12
fi

# G3b 🔴 DEFECT 2, AND IT IS A BEHAVIOUR CLAIM, SO IT IS EXECUTED — NOT GREPPED.
# The ready probe short-circuited on `document.visibilityState !== "visible"`
# BEFORE querying any markup, so an app that reports hidden while being fully
# booted was refused: measured live 2026-08-19, panorama-360 answered
# `visibilityState: hidden` with 16 testids, no `app-loading`, and a click that
# changed the prompt. A word-level check on the injected JS cannot tell that apart
# from the fix (both mention `visibilityState`), so this gate EVALUATES the
# rendered JS with a translator that shares no code with plan.py and requires it
# to agree with `ready_verdict` on all 8 combinations — plus the four named
# outcomes, plus a control that reconstructs the PRE-FIX program and requires the
# translator to catch it disagreeing.
if python3 - "$PLAN" >"${WORK}/g3b.txt" 2>&1 <<'PY'
import itertools, json, os, re, sys
PLAN = sys.argv[1]
sys.path.insert(0, os.path.dirname(PLAN))
import plan as P
bad = []
ANCHOR, LOADING = '[data-testid="mb-grid"]', '[data-testid="app-loading"]'


def evaluate(js, anchor, loading, visible):
    """An INDEPENDENT reading of the injected program: bind the names from their
    own `var` lines, then walk the returns. It shares no code with plan.py, and
    it RAISES rather than guessing when the program is not the shape it knows —
    a translator that silently falls through would grade everything green."""
    body = re.sub(r"^\(function\(\)\{var d=document;", "", js)
    body = re.sub(r"\}\)\(\)$", "", body)
    env = {}
    for name, sel in re.findall(r"var (\w+)=!!d\.querySelector\((\".*?\")\);", body):
        # the captured group is a JS/JSON string literal — read it back to the raw
        # selector rather than re-deriving the escaping plan.py used
        env[name] = {ANCHOR: anchor, LOADING: loading}[json.loads(sel)]
    for name in re.findall(r'var (\w+)=d\.visibilityState==="visible";', body):
        env[name] = visible
    if len(env) != 3:
        raise AssertionError("bound %r, expected three names" % sorted(env))
    tail = body[body.rindex(";", 0, body.index("if(")) + 1:] if "if(" in body else body

    def truth(expr):
        py = expr.replace("&&", " and ").replace("||", " or ").replace("!", " not ")
        return bool(eval(py, {"__builtins__": {}}, dict(env)))

    for cond, tok in re.findall(r'if\((.*?)\)return "(\w+)";', tail):
        if truth(cond):
            return tok
    m = re.search(r'return (\w+)\?"(\w+)":"(\w+)";?$', tail.strip())
    if m:
        return m.group(2) if env[m.group(1)] else m.group(3)
    m = re.search(r'return "(\w+)";?$', tail.strip())
    if m:
        return m.group(1)
    raise AssertionError("cannot read the program's final return: %r" % tail[-80:])


js = P.ready_js(ANCHOR, LOADING)
n = 0
for a, l, v in itertools.product((True, False), repeat=3):
    want = P.ready_verdict(a, l, v)
    try:
        got = evaluate(js, a, l, v)
    except AssertionError as e:
        bad.append("the injected JS is not readable: %s" % e)
        break
    n += 1
    if got != want:
        bad.append("anchor=%s loading=%s visible=%s: the injected JS answers %s "
                   "while ready_verdict says %s" % (a, l, v, got, want))
if n and n != 8:
    bad.append("only %d of 8 combinations evaluated" % n)

# 🔴 THE FOUR NAMED OUTCOMES, stated as the live measurements they come from.
NAMED = [
    ((True, False, False), P.READY_TOKEN_READY,
     "a booted, drivable app that reports visibilityState:hidden (panorama-360, "
     "16 testids, no app-loading, a click that changed the prompt) must be READY"),
    ((False, False, False), P.READY_TOKEN_HIDDEN,
     "anchor ABSENT and the tab not visible is the CONFOUND the token exists for "
     "and must NOT be lost"),
    ((False, True, True), P.READY_TOKEN_LOADING,
     "a visible frame still rendering the loading shell is a booting/deadlocked app"),
    ((False, False, True), P.READY_TOKEN_ABSENT,
     "a visible frame rendering neither is the only read that may implicate the anchor"),
]
for args, want, why in NAMED:
    got = P.ready_verdict(*args)
    if got != want:
        bad.append("%s — got %s" % (why, got))

# 🔴 POSITIVE CONTROL FOR THE TRANSLATOR: rebuild the PRE-FIX program (visibility
# asked first, unconditionally) in the same grammar and require this instrument to
# catch it. Without this, "8/8 agree" is indistinguishable from a translator that
# returns whatever it is told.
pre = js.replace('if(A&&!L)return "%s";if(!A&&!V)return "%s";'
                 % (P.READY_TOKEN_READY, P.READY_TOKEN_HIDDEN),
                 'if(!V)return "%s";if(A&&!L)return "%s";'
                 % (P.READY_TOKEN_HIDDEN, P.READY_TOKEN_READY))
if pre == js:
    bad.append("POSITIVE CONTROL FAILED: could not rebuild the pre-fix program — "
               "the shipped JS no longer has the shape this control edits")
else:
    caught = [c for c in itertools.product((True, False), repeat=3)
              if evaluate(pre, *c) != P.ready_verdict(*c)]
    if not caught:
        bad.append("POSITIVE CONTROL FAILED: the translator finds the PRE-FIX "
                   "program (visibility asked first) indistinguishable from the "
                   "fixed one, so its agreement above means nothing")
    elif (True, False, False) not in caught:
        bad.append("POSITIVE CONTROL FAILED: the pre-fix program is caught, but not "
                   "on the measured case (anchor present, tab hidden) — caught on %s"
                   % (caught,))
print("COMBOS=%d NAMED=%d" % (n, len(NAMED)))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G3b: the injected ready probe, EXECUTED, agrees with ready_verdict on all 8 (anchor, loading, visible) combinations — a present anchor wins even when the tab reports hidden (the measured panorama case), while ABSENT+hidden still answers HIDDEN so the CONFOUND survives; a rebuilt PRE-FIX program is caught by the same translator ($(grep -o 'COMBOS=.*' "${WORK}/g3b.txt"))"
else
  fail "G3b: the ready probe still refuses a booted app on visibility alone, or the probe and its Python source of truth disagree"
  sed 's/^/          /' "${WORK}/g3b.txt" | head -12
fi

# G4 — the recipe-side refusals around the ready gate, each with its positive arm.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r.pop("ready",None)
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-noready.json"
expect_refuse "G4a NEG: a recipe with no \`ready\` gate is refused — every state would race the app's own boot" no_ready_gate -- \
  python3 "$PLAN" "${WORK}/rec-noready.json" --observed "${WORK}/obs-ok.json" --state discover
expect_ok "G4b POS control for G4a: the same recipe WITH its ready gate plans fine" -- \
  python3 "$PLAN" "$RECIPES/custom-generators.json" --observed "${WORK}/obs-ok.json" --state discover
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["ready"]={"testid":"discover-list","selector":"#x"}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-tworeadys.json"
expect_refuse "G4c NEG: a ready gate declaring BOTH testid and selector is refused (two anchors cannot both be the proof)" bad_recipe -- \
  python3 "$PLAN" "${WORK}/rec-tworeadys.json" --observed "${WORK}/obs-ok.json" --state discover
# 🔴 THE READY PROBE INTERPOLATES A RECIPE STRING INTO INJECTED JS, so the
# actuation scan has to run over the RENDERED source, not over the template.
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["ready"]={"selector":"#x\").click(); (\"a"}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-readyclick.json"
expect_refuse "G4d NEG: a ready selector that smuggles an actuation call into the injected JS is refused" ready_actuates -- \
  python3 "$PLAN" "${WORK}/rec-readyclick.json" --observed "${WORK}/obs-ok.json" --state discover
python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["ready"]={"selector":"#pano-controls"}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-readysel.json"
expect_ok "G4e POS control for G4d: an ordinary CSS selector in the same field plans fine" -- \
  python3 "$PLAN" "${WORK}/rec-readysel.json" --observed "${WORK}/obs-ok.json" --state discover

# G5 — the empty state as a REPORTABLE DEFECT, from real DOM cut with an
# independent instrument (.claude/skills/app-capture/tests/fixtures/domsurgery.py).
if python3 - "$EVID" "$EVFIX" "$FIX" >"${WORK}/g5.txt" 2>&1 <<'PY'
import json, os, sys
EVID, FIX, FIXROOT = sys.argv[1:4]
sys.path.insert(0, os.path.dirname(EVID))
sys.path.insert(0, FIXROOT)
import evidence as E
import domsurgery as DS
man = json.load(open(os.path.join(FIX, "manifest.json")))
bad, n = [], 0
for name, spec in man["emptyStateProbes"].items():
    if name.startswith("_"):
        continue
    html = E.load_dom(open(os.path.join(FIX, spec["dom"])).read())
    clean = E.empty_state_scan(E.parse_dom(html))
    # the paired arm: the SAME file, untouched, must NOT read as empty
    if clean["verdict"] != "populated" or clean["defect"]:
        bad.append("%s: the untouched capture already reads %s/defect=%s — the check "
                   "fires on a populated screen" % (name, clean["verdict"], clean["defect"]))
    cut = html
    for opening in spec["cut"]:
        cut, removed = DS.cut(cut, opening)
        if len(removed) < 40:
            bad.append("%s: cutting %r removed only %d bytes — that is not a real "
                       "element" % (name, opening[:40], len(removed)))
    if cut == html:
        bad.append("%s: the surgery changed nothing" % name); continue
    got = E.empty_state_scan(E.parse_dom(cut))
    n += 1
    w = spec["expect"]
    if got["verdict"] != w["verdict"]:
        bad.append("%s: verdict %r != %r" % (name, got["verdict"], w["verdict"]))
    if got["defect"] != w["defect"]:
        bad.append("%s: defect %r != %r (why: %s)" % (name, got["defect"], w["defect"], got.get("why")))
    if (got["primary"] or {}).get("testid") != w["primary"]:
        bad.append("%s: primary %r != %r" % (name, (got["primary"] or {}).get("testid"), w["primary"]))
    if (got["primary"] or {}).get("items") != 0:
        bad.append("%s: the emptied collection still reports %s item(s)"
                   % (name, (got["primary"] or {}).get("items")))
    if got["nextAction"]["scope"] != w["nextActionScope"]:
        bad.append("%s: next-action scope %r != %r" % (name, got["nextAction"]["scope"], w["nextActionScope"]))
    if "nextActionName" in w:
        names = [c["name"] for c in got["nextAction"]["controls"]]
        if w["nextActionName"] not in names:
            bad.append("%s: the named next action %r is not among %s" % (name, w["nextActionName"], names))
    if got["missing"]["kind"] != w["missingKind"]:
        bad.append("%s: missing.kind %r != %r" % (name, got["missing"]["kind"], w["missingKind"]))
    if "missingInputTestid" in w:
        tids = [i["testid"] for i in got["missing"]["inputs"]]
        if w["missingInputTestid"] not in tids:
            bad.append("%s: the missing input is not NAMED (%s), expected %r"
                       % (name, tids, w["missingInputTestid"]))
        ph = [i["placeholder"] for i in got["missing"]["inputs"]
              if i["testid"] == w["missingInputTestid"]]
        if ph and ph[0] != w["missingInputPlaceholder"]:
            bad.append("%s: placeholder %r != %r" % (name, ph[0], w["missingInputPlaceholder"]))
    # the defect must be a KEY the diff can carry, not only prose
    keys = E.empty_state_defects(got)
    if ("empty-state", w["primary"]) not in keys:
        bad.append("%s: the empty verdict produced no diffable key (%s)" % (name, sorted(keys)))
    if w["defect"] != any(k[0] == "empty-state-no-next-action" for k in keys):
        bad.append("%s: the no-next-action key disagrees with `defect`" % name)
    if E.empty_state_defects(clean):
        bad.append("%s: the untouched capture produced defect keys %s"
                   % (name, sorted(E.empty_state_defects(clean))))
if n != 3:
    bad.append("POSITIVE CONTROL FAILED: only %d of 3 empty-state probes ran" % n)
# ...and a screen with no collection at all must DECLINE to have an opinion
none = E.empty_state_scan(E.parse_dom("<html><body><p>hello</p></body></html>"))
if none["verdict"] != "no-collection" or none["defect"]:
    bad.append("a screen with no collection was judged %r/defect=%s instead of "
               "declining" % (none["verdict"], none["defect"]))
print("EMPTY_PROBES=%d" % n)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G5: an emptied REAL collection reads as empty, names its next action or reports the DEFECT of having none, and names the unfilled input — while the same files untouched read populated ($(grep -o 'EMPTY_PROBES=[0-9]*' "${WORK}/g5.txt"))"
else
  fail "G5: the empty-state check is inert, over-eager, or cannot name what is missing"
  sed 's/^/          /' "${WORK}/g5.txt" | head -14
fi

# G6 🔴 THE DIFF BLINDNESS THE FIRST LIVE RUN EXPOSED. `diff` compared UNIQUE
# testid SETS, so a grid going 24 -> 39 OCCURRENCES reported `unchanged: 15` —
# structurally unable to see "the primary state stopped being empty", which is
# one of this mode's own definition-of-done criteria.
if python3 - "$EVID" "$EVFIX" "$FIX" "${WORK}" >"${WORK}/g6.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
EVID, FIX, FIXROOT, WORK = sys.argv[1:5]
sys.path.insert(0, os.path.dirname(EVID))
sys.path.insert(0, FIXROOT)
import evidence as E
import domsurgery as DS
man = json.load(open(os.path.join(FIX, "manifest.json")))
spec = man["occurrenceProbe"]
bad = []
raw = open(os.path.join(FIX, spec["dom"])).read()
html = E.load_dom(raw)
more = DS.duplicate(html, spec["duplicate"], times=spec["times"])
probe = json.load(open(os.path.join(FIX, "cg-explainer.probe.json")))["result"]["data"]["value"]
pp = os.path.join(WORK, "occ-probe.json")
json.dump({"result": {"data": {"value": probe}}}, open(pp, "w"))


def artifact(h, name):
    art = E.analyze(h, json.loads(probe), "discover", "custom-generators")
    p = os.path.join(WORK, name)
    json.dump(art, open(p, "w"))
    return art, p


a, pa = artifact(html, "occ-before.json")
b, pb = artifact(more, "occ-after.json")
if (a["testids"]["count"], b["testids"]["count"]) != (spec["countBefore"], spec["countAfter"]):
    bad.append("occurrences %s -> %s, manifest pins %s -> %s"
               % (a["testids"]["count"], b["testids"]["count"],
                  spec["countBefore"], spec["countAfter"]))
if a["testids"]["unique"] != spec["uniqueUnchanged"] or b["testids"]["unique"] != spec["uniqueUnchanged"]:
    bad.append("the unique count moved (%s -> %s); this probe must move occurrences ONLY"
               % (a["testids"]["unique"], b["testids"]["unique"]))
p = subprocess.run(["python3", EVID, "diff", pa, pb], capture_output=True, text=True)
d = json.loads(p.stdout)
# 🔴 THE CONTROL THAT MAKES THIS GATE MEAN SOMETHING: the SET diff really is
# blind here. If it were not, the new signal would be redundant and this case
# would prove nothing about it.
if d["testids"]["added"] or d["testids"]["removed"]:
    bad.append("CONTROL FAILED: the set diff is NOT blind to this change (%s/%s), so "
               "it is not the 24->39 shape" % (d["testids"]["added"], d["testids"]["removed"]))
if d["testids"]["unchanged"] != spec["uniqueUnchanged"]:
    bad.append("the set diff reports unchanged=%s, expected %s"
               % (d["testids"]["unchanged"], spec["uniqueUnchanged"]))
moved = {m["id"]: m for m in d["testidCounts"]["changed"]}
if spec["repeatedId"] not in moved:
    bad.append("the per-id deltas do not name %r: %s" % (spec["repeatedId"], sorted(moved)))
elif moved[spec["repeatedId"]]["delta"] != spec["times"]:
    bad.append("%s delta %s != %s" % (spec["repeatedId"], moved[spec["repeatedId"]]["delta"], spec["times"]))
if d["testidCounts"]["delta"] != spec["countAfter"] - spec["countBefore"]:
    bad.append("total occurrence delta %s != %s"
               % (d["testidCounts"]["delta"], spec["countAfter"] - spec["countBefore"]))
if not d["occurrencesChanged"]:
    bad.append("occurrencesChanged is false although %d id(s) moved" % len(moved))
# ...and, like domChanged, this must NOT make the verdict red on an honest re-run
if d["changed"] or p.returncode != 0:
    bad.append("an occurrence-only difference set changed=%s rc=%s — a live app's "
               "item counts move between honest runs, and a verdict that is always "
               "red is one everyone skips" % (d["changed"], p.returncode))
# the human report must carry it too — a JSON-only signal is one nobody reads
rep = subprocess.run(["python3", EVID, "report", pb], capture_output=True, text=True).stdout
if "repeated" not in rep or spec["repeatedId"] not in rep:
    bad.append("`report` does not surface the per-id occurrence counts: %s" % rep[-200:])
rep_a = subprocess.run(["python3", EVID, "report", pa], capture_output=True, text=True).stdout
if rep_a == rep:
    bad.append("CONTROL FAILED: `report` prints the same text for 15 and 31 occurrences")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G6: per-id OCCURRENCE deltas are reported in \`diff\` and \`report\` for a change the SET diff is provably blind to (15 -> 31 occurrences, same 15 ids), without making an honest re-run read as changed"
else
  fail "G6: the diff still cannot see an occurrence-only change"
  sed 's/^/          /' "${WORK}/g6.txt" | head -12
fi

# G7 — an empty state appearing or disappearing is a DEFECT transition the diff
# counts, which is what makes "the primary state stopped being empty" visible.
if python3 - "$EVID" "$EVFIX" "$FIX" "${WORK}" >"${WORK}/g7.txt" 2>&1 <<'PY'
import json, os, subprocess, sys
EVID, FIX, FIXROOT, WORK = sys.argv[1:5]
sys.path.insert(0, os.path.dirname(EVID))
sys.path.insert(0, FIXROOT)
import evidence as E
import domsurgery as DS
bad = []
probe = json.loads(json.load(open(os.path.join(FIX, "cg-explainer.probe.json")))
                   ["result"]["data"]["value"])
full = E.load_dom(open(os.path.join(FIX, "mb-combos.dom.json")).read())
empty, _ = DS.cut(full, '<div data-testid="matchup-card"')
stuck, _ = DS.cut(empty, '<button type="button" data-testid="submit-matchup"')


def art(h, name):
    a = E.analyze(h, probe, "matchups", "model-benchmarking")
    p = os.path.join(WORK, name)
    json.dump(a, open(p, "w"))
    return p


p_full, p_empty, p_stuck = art(full, "es-full.json"), art(empty, "es-empty.json"), art(stuck, "es-stuck.json")


def run(b, a):
    r = subprocess.run(["python3", EVID, "diff", b, a], capture_output=True, text=True)
    return r.returncode, json.loads(r.stdout)

rc, d = run(p_empty, p_full)
if rc != 1 or d["fixed"] < 1 or ["empty-state", "matchups-list"] not in d["emptyState"]["removed"]:
    bad.append("empty -> populated did not read as FIXED: rc=%s fixed=%s %s"
               % (rc, d.get("fixed"), d.get("emptyState")))
rc, d = run(p_full, p_stuck)
if rc != 1 or d["regressed"] < 2:
    bad.append("populated -> empty-with-nothing-to-do did not read as REGRESSED: %s" % d.get("emptyState"))
if ["empty-state-no-next-action", "matchups-list"] not in d["emptyState"]["added"]:
    bad.append("the no-next-action DEFECT is not named in the diff: %s" % d.get("emptyState"))
rc, d = run(p_full, p_full)
if rc != 0 or d["changed"]:
    bad.append("POSITIVE CONTROL FAILED: an artifact diffed against itself is not clean (%s)" % d)
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G7: an empty state appearing counts as REGRESSED (naming the no-next-action defect) and one disappearing counts as FIXED — the criterion the set diff could not express"
else
  fail "G7: empty-state transitions are not visible in the diff"
  sed 's/^/          /' "${WORK}/g7.txt" | head -10
fi

# G8 — capture.sh's end of the foregrounding wiring, through the fake bridge, and
# the two sentences a run must be able to tell apart.
if [ -x "$FAKEBB" ]; then
  FGD="${WORK}/fg"; mkdir -p "$FGD"
  FAKE_LOG="${WORK}/fg-ledger.txt" APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --evidence --no-frame \
    --out "$FGD" >"${WORK}/g8.log" 2>&1
  g8rc=$?
  n_act="$(grep -c ' activate' "${WORK}/fg-ledger.txt" 2>/dev/null)"
  n_xdo="$(grep -c 'xdotool' "${WORK}/fg-ledger.txt" 2>/dev/null)"
  # order: the tab is foregrounded BEFORE any frame-scoped work, or the app is
  # still deadlocked when the probe and the actions arrive.
  i_act="$(grep -n ' activate' "${WORK}/fg-ledger.txt" | head -1 | cut -d: -f1)"
  i_frame="$(grep -n -- '--frame' "${WORK}/fg-ledger.txt" | head -1 | cut -d: -f1)"
  NOFG="${WORK}/nofg"; mkdir -p "$NOFG"
  FAKE_LOG="${WORK}/nofg-ledger.txt" APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --evidence --no-frame \
    --no-foreground --out "$NOFG" >"${WORK}/g8b.log" 2>&1
  n_act0="$(grep -c ' activate' "${WORK}/nofg-ledger.txt" 2>/dev/null)"
  # 🔴 TWO, NOT ONE: the once-per-tab foreground plan, plus the `state` re-assert
  # that opens the single state's own plan. A run that raises the window once and
  # then works for minutes is what CONFOUNDed a live evidence run on its second
  # state — the raised foreground survives a median ~1.5 s.
  if [ "$g8rc" = 0 ] && [ "$n_act" = 2 ] && [ "$n_xdo" = 0 ] \
     && [ -n "$i_act" ] && [ -n "$i_frame" ] && [ "$i_act" -lt "$i_frame" ] \
     && [ "$n_act0" = 0 ]; then
    pass "G8: a screenshot-free evidence run foregrounds TWICE — once per tab, then again to open the state's own plan — the first before any frame-scoped op, and presses nothing (0 xdotool); --no-foreground produces 0 activations, so the ledger count is proven able to move"
  else
    fail "G8: the foregrounding wiring is wrong (rc=$g8rc activate=$n_act xdotool=$n_xdo order=$i_act/$i_frame no-fg=$n_act0)"
    sed 's/^/          /' "${WORK}/g8.log" | tail -8
  fi

  # G9 — "the app never booted" must not read as "the action failed". A short
  # ready timeout keeps this gate cheap; FAKE_READY_MODE=never is the deadlock.
  python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["ready"]["timeoutMs"]=1200
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-fastready.json"
  BOOTD="${WORK}/noboot"; mkdir -p "$BOOTD"
  FAKE_READY_MODE=never APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-fastready.json" --state discover --evidence --no-frame \
    --out "$BOOTD" >"${WORK}/g9.log" 2>&1
  g9rc=$?
  ok9=1
  [ "$g9rc" = 11 ] || { ok9=0; }
  grep -q 'APP NEVER BOOTED' "${WORK}/g9.log" || ok9=0
  grep -q 'THE ACTION FAILED' "${WORK}/g9.log" && ok9=0
  [ -f "${BOOTD}/discover.evidence.json" ] && ok9=0
  # POSITIVE CONTROL: the SAME recipe, same short timeout, without the deadlock
  # knob, runs green — so the exit-11 above is about the app, not the recipe copy.
  OKD="${WORK}/booted"; mkdir -p "$OKD"
  APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "${WORK}/rec-fastready.json" \
    --state discover --evidence --no-frame --out "$OKD" >"${WORK}/g9b.log" 2>&1
  g9brc=$?
  [ "$g9brc" = 0 ] || ok9=0
  if [ "$ok9" = 1 ]; then
    pass "G9: an app that never boots stops the run with its OWN message (exit 11, 'APP NEVER BOOTED', no artifact) and never the action-failure one — while the same recipe on a booting app exits 0"
  else
    fail "G9: a hidden-tab deadlock is still reported as a failing action (rc=$g9rc, control rc=$g9brc, artifact=$([ -f "${BOOTD}/discover.evidence.json" ] && echo present || echo absent))"
    sed 's/^/          /' "${WORK}/g9.log" | tail -8
  fi
  # G10 — the OTHER way to get a foreground tab: attach to one the operator
  # already has in front. A tab this script did not open is never closed by it,
  # and no `open` is issued at all.
  ATTD="${WORK}/attach"; mkdir -p "$ATTD"
  FAKE_LOG="${WORK}/att-ledger.txt" APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --evidence --no-frame \
    --tab 8123 --out "$ATTD" >"${WORK}/g10.log" 2>&1
  g10rc=$?
  a_open="$(grep -cE '(^| )open ' "${WORK}/att-ledger.txt" 2>/dev/null)"
  a_close="$(grep -cE '(^| )close( |$)' "${WORK}/att-ledger.txt" 2>/dev/null)"
  a_act="$(grep -c ' activate' "${WORK}/att-ledger.txt" 2>/dev/null)"
  # POSITIVE CONTROL: the default run's ledger DOES carry both, so these zeroes
  # are a fact about --tab and not about a grep that matches nothing.
  d_open="$(grep -cE '(^| )open ' "${WORK}/fg-ledger.txt" 2>/dev/null)"
  d_close="$(grep -cE '(^| )close( |$)' "${WORK}/fg-ledger.txt" 2>/dev/null)"
  if [ "$g10rc" = 0 ] && [ "$a_open" = 0 ] && [ "$a_close" = 0 ] && [ "$a_act" = 2 ] \
     && [ "$d_open" = 1 ] && [ "$d_close" = 1 ]; then
    pass "G10: --tab attaches to an EXISTING tab — no open, no close (the operator's tab is never closed by this run), and still foregrounded (once per tab, once opening the state); the default run's ledger carries open+close, so those zeroes mean something"
  else
    fail "G10: --tab attach mode is wrong (rc=$g10rc open=$a_open close=$a_close activate=$a_act; control open=$d_open close=$d_close)"
    sed 's/^/          /' "${WORK}/g10.log" | tail -8
  fi
else
  fail "G8/G9/G10: .claude/skills/app-capture/tests/fixtures/fake-bridge.sh is missing or not executable"
fi

# G11 🔴 WHERE EVERY FOREGROUND RE-ASSERT SITS, AND WHY EACH ONE IS THERE.
# Foregrounding ONCE PER TAB does not survive: the raised foreground lasts a
# median ~1.5 s (1176/2550/1176/1503/1232 ms over 5 runs, 2026-08-19), while a
# state takes tens of seconds. Two things need the window, so there are two
# re-asserts: the `state` one OPENS the plan, because the app-ready gate is the
# very next step; and the `pre-screenshot` one sits with GAP 0 to its capture,
# measured 3/3 at gap 0 against 1/3 with a 4 s wake in between.
# 🔴 RETRACTED 2026-08-24: both used to be justified by OCCLUSION
# ("captureVisibleTab does not return while the window is OCCLUDED"). It is not
# the discriminator — the 18.1 s hang reproduces with nothing drawn on top, and
# the cause was an unbounded fast path (fixed in devrc #797). FOCUS is not the
# discriminator either: visible-but-unfocused captured 6/6 in 192-306 ms. What
# these gates pin is the POSITIONS, which stand independently of either story.
#
# 🔴 AND THE LESSON FROM P17: a SHAPE assertion cannot see an absence. So this
# gate does not merely check that an activate exists somewhere — it pins both
# POSITIONS, the REASON markers, the verification key, the absence of an inert
# --wait, the count against the number of screenshots, and then plants four
# separate violations in a COPY and requires each to be refused BY ITS OWN CODE,
# with the unmutated copy planning as the paired positive.
if python3 - "$PLAN" "$RECIPES/custom-generators.json" "$RECIPES/panorama-360.json" \
     "${WORK}/obs-ok.json" "${WORK}/obs-pano.json" "${WORK}" >"${WORK}/g11.txt" 2>&1 <<'PY'
import json, os, shutil, subprocess, sys
PLAN, REC_CG, REC_PANO, OBS_CG, OBS_PANO, WORK = sys.argv[1:7]
bad, n_states, n_pre = [], 0, 0


def run(plan_py, args):
    p = subprocess.run(["python3", plan_py] + args, capture_output=True, text=True)
    return p.returncode, p.stdout, p.stderr


rec = json.load(open(REC_CG))
for st in rec["states"]:
    for extra in ([], ["--evidence"]):
        rc, out, err = run(PLAN, [REC_CG, "--observed", OBS_CG, "--state", st["name"]] + extra)
        if rc != 0:
            bad.append("%s%s did not plan: %s" % (st["name"], extra, err.strip()[:90]))
            continue
        steps = json.loads(out)["steps"]
        ops = [s["op"] for s in steps]
        n_states += 1
        acts = [i for i, s in enumerate(steps) if s["op"] == "activate"]
        shots = [i for i, s in enumerate(steps) if s["op"] == "screenshot"]
        lead = [i for i in acts if steps[i].get("foreground") == "state"]
        pre = [i for i in acts if steps[i].get("foreground") == "pre-screenshot"]
        # 🔴 ONE LEAD PER STATE, ONE RE-ASSERT PER CAPTURE, AND NOTHING ELSE.
        if lead != [0]:
            bad.append("%s%s: the `state` re-assert is at %s, not opening the plan "
                       "— the app-ready gate is the next thing that needs the "
                       "window" % (st["name"], extra, lead or "nowhere"))
        if len(pre) != len(shots):
            bad.append("%s%s: %d pre-screenshot activate(s) for %d screenshot(s) — "
                       "every capture needs its OWN re-assert"
                       % (st["name"], extra, len(pre), len(shots)))
            continue
        if len(acts) != len(lead) + len(pre):
            bad.append("%s%s: an activate is marked something else: %s"
                       % (st["name"], extra, [steps[i].get("foreground") for i in acts]))
        for i in acts:
            n_pre += 1
            s = steps[i]
            if s.get("verifyForeground") != "i3":
                bad.append("%s%s: activate at %d does not ask for the bridge's i3 outcome "
                           "to be read — a window raise that FAILED then walks into a "
                           "deadlock that reads as a bad anchor" % (st["name"], extra, i))
            if "--frame" in s["argv"]:
                bad.append("%s%s: the re-assert is frame-scoped" % (st["name"], extra))
            # 🔴 NO --wait ON A RE-ASSERT. `activate --wait MS` is the bridge's
            # bounded page-LOAD wait, not a focus-hold: swept
            # nowait/100/250/500/1000/1500 from the occluded state, 3/3 recovered
            # at every value (18/18). A constant here would be inert ceremony.
            if "--wait" in s["argv"]:
                bad.append("%s%s: the re-assert at %d carries --wait %s — that is a "
                           "page-LOAD wait and holds no foreground (measured inert "
                           "across a 6-value sweep)"
                           % (st["name"], extra, i, s["argv"][s["argv"].index("--wait") + 1:][:1]))
            # 🔴 THE SHIPPED PLAN, NOT JUST THE GUARD. The plants below prove the
            # rule is ENFORCED; this proves it is OBEYED. Both are needed: a
            # guard nothing violates and a plan nobody checks are different
            # failures. Omitting --no-focus does not withhold the host-side i3
            # raise — the bridge CLI turns the flag ON when stdout is a TTY, so
            # the raise would be decided by how capture.sh happened to be
            # invoked. Measured 2026-08-28 against an instrumented endpoint:
            # identical argv, "focus":false through a command substitution,
            # "focus":TRUE through a PTY.
            if "--no-focus" not in s["argv"]:
                bad.append("%s%s: the re-assert at %d does not say --no-focus out "
                           "loud (argv=%s) — the i3 raise would then depend on the "
                           "caller's stdio rather than on anything the plan declares"
                           % (st["name"], extra, i, s["argv"]))
            if "--focus" in s["argv"]:
                bad.append("%s%s: the re-assert at %d asks for --focus — that TAKES "
                           "the operator's screen and no capture-path step may"
                           % (st["name"], extra, i))
        for i in pre:
            if ops[i + 1:i + 2] != ["screenshot"]:
                bad.append("%s%s: the re-assert at %d is followed by %s, not by the "
                           "capture itself — the GAP is the load-bearing quantity "
                           "(3/3 at gap 0, 1/3 with a 4 s wake in between)"
                           % (st["name"], extra, i, ops[i + 1:i + 2]))
            if ops[i - 1:i] != ["wake"]:
                bad.append("%s%s: the settle wake is not the step before the "
                           "re-assert at %d (%s) — it belongs BEFORE the raise, "
                           "never between the raise and the capture"
                           % (st["name"], extra, i, ops[i - 1:i]))
        # --no-foreground removes it entirely, and removes NOTHING else
        rc2, out2, _ = run(PLAN, [REC_CG, "--observed", OBS_CG, "--state", st["name"],
                                  "--no-foreground"] + extra)
        if rc2 != 0:
            bad.append("%s%s: --no-foreground did not plan" % (st["name"], extra))
        else:
            s2 = json.loads(out2)["steps"]
            if any(x["op"] == "activate" for x in s2):
                bad.append("%s%s: --no-foreground still emits an activate" % (st["name"], extra))
            if [x["op"] for x in s2] != [o for o in ops if o != "activate"]:
                bad.append("%s%s: --no-foreground changed more than the re-assert"
                           % (st["name"], extra))

if n_pre < 4:
    bad.append("POSITIVE CONTROL FAILED: only %d re-assert(s) inspected across %d "
               "state plans — the placement findings are about nothing" % (n_pre, n_states))

# 🔴 THE GUARD ITSELF, PLANTED THREE WAYS IN A COPY. A gate that only reads the
# shipped plan cannot tell an enforced rule from a coincidence.
# 🔴 ONE EXPECTED CODE PER CLAUSE. With a single shared code the clauses cover
# for each other: the mutant that deleted the POSITION check was still refused —
# by the COUNT check, same code — and the battery scored it SURVIVED while this
# gate reported a refusal and passed. A kill must name the clause that did it.
# 🔴 EVERY PLANT IS WELL-FORMED IN EVERY DIMENSION EXCEPT THE ONE IT TESTS —
# INCLUDING --no-focus. This is the repo's isolate-the-mutation rule applied to a
# fixture: when `activate_unconsented` was added, four plants built with
# `["--no-wait"]` alone started dying to IT instead of to the clause each is
# named for, and two positive controls in the module-API section below refused
# outright. That reads as a broken guard and is really a stale fixture. A plant
# that can die for two reasons attributes nothing.
PLANTS = [
    ("moved AFTER the capture",
     '        p.emit_tab("activate", ["--no-wait", "--no-focus"], "planted late", foreground="pre-screenshot", verifyForeground="i3")',
     "activate_misordered"),
    ("marked with an unknown reason",
     '        p.emit_tab("activate", ["--no-wait", "--no-focus"], "planted", foreground="because", verifyForeground="i3")',
     "activate_unplaced"),
    ("unverified — nobody reads the i3 outcome",
     '        p.emit_tab("activate", ["--no-wait", "--no-focus"], "planted", foreground="pre-screenshot")',
     "activate_unverified"),
    # 🔴 THE LEAD'S POSITION, PLANTED ON ITS OWN. A second `state` re-assert late
    # in the plan raises nothing in time for the app-ready gate that has already
    # run, and it must be refused by the POSITION clause — with its own code, so a
    # mutant of that clause cannot die to the count check next door (the M96
    # lesson: two clauses sharing a code scored a survivor as a kill).
    ("a `state` re-assert that does not open the plan",
     '        p.emit_tab("activate", ["--no-wait", "--no-focus"], "planted lead", foreground="state", verifyForeground="i3")',
     "activate_lead_misplaced"),
]
# 🔴 THE CONSENT CLAUSE IS *NOT* PLANTED HERE, AND THAT IS THE FINDING. A plant
# goes in at the `evidence_mode` anchor, which is nowhere near a screenshot — so
# a planted `pre-screenshot` activate missing --no-focus is ALSO misordered, and
# with the consent clause neutered it died to `activate_misordered` instead.
# Measured 2026-08-28: the plant scored a kill that attributed to the wrong
# clause, which is precisely the M96 failure this gate's own header warns about.
# It is exercised through the module API below, where a step can be legal in
# every OTHER dimension and illegal in exactly this one.
anchor = "    if evidence_mode:\n        plan_evidence_read(p, state)"
mut_dir = os.path.join(WORK, "g11-mut")
for label, stmt, code in PLANTS:
    shutil.rmtree(mut_dir, ignore_errors=True)
    shutil.copytree(os.path.dirname(PLAN), mut_dir)
    shutil.rmtree(os.path.join(mut_dir, "__pycache__"), ignore_errors=True)
    src = open(os.path.join(mut_dir, "plan.py")).read()
    if src.count(anchor) != 1:
        bad.append("cannot plant %r: anchor occurs %d times" % (label, src.count(anchor)))
        continue
    open(os.path.join(mut_dir, "plan.py"), "w").write(src.replace(anchor, stmt + "\n" + anchor, 1))
    MP = os.path.join(mut_dir, "plan.py")
    rc, _, err = run(MP, [REC_CG, "--observed", OBS_CG, "--state", "discover"])
    if rc != 2 or code not in err:
        bad.append("[%s] was NOT refused as %s (rc=%d): %s" % (label, code, rc, err.strip()[:110]))

# the paired positive: the SAME copy, unmutated, plans — so the refusals above
# are the guard and not a broken copy.
shutil.rmtree(mut_dir, ignore_errors=True)
shutil.copytree(os.path.dirname(PLAN), mut_dir)
shutil.rmtree(os.path.join(mut_dir, "__pycache__"), ignore_errors=True)
rc, _, err = run(os.path.join(mut_dir, "plan.py"), [REC_CG, "--observed", OBS_CG, "--state", "discover"])
if rc != 0:
    bad.append("POSITIVE CONTROL FAILED: an unmutated copy does not plan (%s)" % err.strip()[:110])

# 🔴 THE COUNT CLAUSE, REACHED THROUGH THE MODULE API. "one re-assert per
# capture" only has teeth on a plan with MORE THAN ONE capture, and no shipped
# recipe produces one — so no plant can reach it and a clause nothing can reach
# is a clause nothing tests. Exercised directly, with the paired positive.
sys.path.insert(0, os.path.dirname(PLAN))
import plan as P


def act(why):
    # 🔴 --no-focus BELONGS IN THIS FIXTURE, not because these cases are about
    # consent but because they are about the COUNT and LEAD clauses. A synthetic
    # step that trips `activate_unconsented` first can never reach them, and the
    # two positive controls below would refuse — a fixture failing for a reason
    # it was not built to express.
    return {"op": "activate", "argv": ["browser", "activate", "--no-focus"],
            "note": "x", "foreground": why, "verifyForeground": "i3"}


def steps_for(n_pre, n_shots, lead=True):
    out = [act("state")] if lead else []
    for i in range(max(n_pre, n_shots)):
        out.append({"op": "wake", "argv": ["browser", "wake"], "note": "x"})
        if i < n_pre:
            out.append(act("pre-screenshot"))
        if i < n_shots:
            out.append({"op": "screenshot", "argv": ["browser", "screenshot"], "note": "x"})
    return out


try:
    P.guard_activate_placement(steps_for(1, 2), False, "state")
    bad.append("one re-assert for TWO captures was accepted — the second capture "
               "runs on a foregrounding measured not to survive to it")
except P.Refuse as e:
    if e.code != "activate_uncounted":
        bad.append("the count clause refused as %r, not activate_uncounted — a "
                   "clause that cannot be told apart from its neighbour records "
                   "coverage that does not exist" % e.code)
try:
    P.guard_activate_placement(steps_for(1, 1), False, "state")
except P.Refuse as e:
    bad.append("POSITIVE CONTROL FAILED: the matched 1-and-1 case refused (%s)" % e.code)

# 🔴 THE CONSENT CLAUSE, ISOLATED — AND IT HAS TO BE, WHICH IS WHY IT IS NOT A
# PLANT. `steps_for(1, 1)` is legal in every dimension this guard checks, so
# stripping --no-focus from ONE of its activates leaves exactly one thing wrong
# and `activate_unconsented` is the only clause that can speak. The plant that
# was tried first sat at the evidence anchor, far from any screenshot, so it was
# misordered TOO and died to `activate_misordered` once this clause was neutered
# — a kill attributed to the wrong clause, the exact M96 shape.
# WHY THE CLAUSE EXISTS: omitting --no-focus does not withhold the host-side i3
# raise. The bridge CLI resolves the flag as "on iff stdout is a TTY", so the
# raise would be decided by how capture.sh happened to be invoked rather than by
# anything the plan declares. Measured 2026-08-28 against an instrumented
# endpoint: identical argv sends "focus":false through a command substitution
# and "focus":TRUE through a PTY.
unconsented = steps_for(1, 1)
_pre = [x for x in unconsented if x.get("foreground") == "pre-screenshot"]
if len(_pre) != 1:
    bad.append("fixture drift: steps_for(1,1) has %d pre-screenshot activate(s)" % len(_pre))
else:
    _pre[0]["argv"] = ["browser", "activate"]        # the ONLY difference
    try:
        P.guard_activate_placement(unconsented, False, "state")
        bad.append("an activate that does not say --no-focus was ACCEPTED. Omitting "
                   "the flag does not withhold the i3 raise — the CLI turns it ON "
                   "for a TTY — so this plan's raise would depend on the caller's "
                   "stdio, which is the thing the clause exists to stop")
    except P.Refuse as e:
        if e.code != "activate_unconsented":
            bad.append("the consent clause refused as %r, not activate_unconsented "
                       "— a clause that cannot be told apart from its neighbour "
                       "records coverage that does not exist" % e.code)

# 🔴 THE EXEMPTION, ALSO ISOLATED: the SAME omission on a `spend` activate must
# be ACCEPTED. Without this the clause could be a blanket ban and every test
# above would still pass — and a blanket ban would silently settle an open
# question on the spend path (a trusted keypress may genuinely need the raise).
spend_ok = steps_for(1, 1)
spend_ok.insert(1, {"op": "activate", "argv": ["browser", "activate"], "note": "x",
                    "foreground": "spend", "verifyForeground": "i3"})
try:
    P.guard_activate_placement(spend_ok, True, "state")
except P.Refuse as e:
    bad.append("POSITIVE CONTROL FAILED: a `spend` activate with no focus flag was "
               "refused (%s). It is EXEMPT on purpose — what a spend path should "
               "ask for is unsettled and this guard must not decide it" % e.code)

# 🔴 DEFECT 1'S OWN CLAUSE, ALSO THROUGH THE MODULE API. No shipped call site can
# produce a foregrounded state plan with NO lead re-assert — that is the point of
# the emitter — so the refusal has to be exercised here or it is a clause nothing
# reaches. This is the shape the merged code actually shipped: `--evidence
# --no-frame` planned zero activates per state.
try:
    P.guard_activate_placement(steps_for(0, 0, lead=False), False, "state")
    bad.append("a foregrounded state plan carrying NO `state` re-assert was "
               "accepted — that is exactly the --evidence --no-frame plan that "
               "CONFOUNDed on its second state live")
except P.Refuse as e:
    if e.code != "activate_lead_missing":
        bad.append("the missing-lead clause refused as %r, not activate_lead_missing"
                   % e.code)
try:
    P.guard_activate_placement(steps_for(0, 0, lead=False), False, "state", False)
except P.Refuse as e:
    bad.append("POSITIVE CONTROL FAILED: --no-foreground (foreground=False) must "
               "not require a re-assert, but refused (%s)" % e.code)
try:
    P.guard_activate_placement(steps_for(0, 0, lead=True), False, "state")
except P.Refuse as e:
    bad.append("POSITIVE CONTROL FAILED: a lone lead re-assert refused (%s)" % e.code)

# ...and the spend path's own activate is still allowed, under --trusted only
rc, out, err = run(PLAN, [REC_PANO, "--observed", OBS_PANO, "--state", "rendering", "--trusted"])
if rc != 0:
    bad.append("the trusted plan no longer builds: %s" % err.strip()[:110])
else:
    tsteps = json.loads(out)["steps"]
    marks = [s.get("foreground") for s in tsteps if s["op"] == "activate"]
    if "spend" not in marks:
        bad.append("the spend path's activate is not marked `spend` (%s)" % marks)
    if "pre-screenshot" not in marks:
        bad.append("a trusted state still takes its capture without a focus re-assert (%s)" % marks)
    # 🔴 THE EXEMPTION, PINNED — SO CHANGING IT HAS TO BE DELIBERATE. `spend` is
    # the ONE activate that sends no focus flag, and that is an OPEN QUESTION,
    # not a settled design: a trusted OS keypress needs Brave genuinely forward,
    # so this step is the one place where --focus might be the RIGHT answer. The
    # consent clause therefore exempts it rather than choosing for it. Pinning
    # the current shape here means a blanket edit that sweeps --no-focus across
    # every emit site fails this gate instead of silently settling a spend-path
    # question nobody measured. Whoever settles it edits this assertion and says
    # why.
    for s in tsteps:
        if s["op"] == "activate" and s.get("foreground") == "spend":
            if "--no-focus" in s["argv"] or "--focus" in s["argv"]:
                bad.append("the `spend` activate now carries a focus flag (%s). That "
                           "is a behaviour change on a SPEND path: it decides, by "
                           "default, whether a trusted keypress lands on a genuinely "
                           "raised Brave. Settle it deliberately, not by a sweep."
                           % s["argv"])

# 🔴 THE FOREGROUND PLAN'S OWN activate, WHICH THE STATE-PLAN LOOP ABOVE NEVER
# SEES. It is built by a different function (`build_foreground`) and is the FIRST
# thing any capture run emits, so a consent regression there would ship ahead of
# everything the loop checks.
rc, out, err = run(PLAN, [REC_CG, "--observed", OBS_CG, "--foreground-plan"])
if rc != 0:
    bad.append("the foreground plan no longer builds: %s" % err.strip()[:110])
else:
    facts = [s for s in json.loads(out)["steps"] if s["op"] == "activate"]
    if len(facts) != 1:
        bad.append("the foreground plan carries %d activate(s), expected exactly 1" % len(facts))
    for s in facts:
        if "--no-focus" not in s["argv"]:
            bad.append("the foreground plan's once-per-tab activate does not say "
                       "--no-focus out loud (argv=%s)" % s["argv"])
        if "--focus" in s["argv"]:
            bad.append("the foreground plan's activate asks for --focus (argv=%s)" % s["argv"])
print("PRE_ASSERTS=%d over %d state plans; PLANTS=%d" % (n_pre, n_states, len(PLANTS)))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "G11: every state plan OPENS with its own foreground re-assert and every capture is immediately preceded by another — both marked, verified, un-waited, positioned (settle wake, then raise, then capture with nothing in the gap) and each saying --no-focus OUT LOUD rather than leaving the i3 raise to the caller's stdio, the foreground plan's once-per-tab activate included ($(grep -o 'PRE_ASSERTS=.*' "${WORK}/g11.txt")); the spend activate's exemption from that is pinned so a sweep cannot settle it; --no-foreground removes exactly those steps and nothing else; four planted violations are each refused by their own code, the missing-lead, count and consent clauses are reached through the module API (the consent one CANNOT be a plant — a planted step is misordered too and attributes to the wrong clause), and the unmutated copy plans"
else
  fail "G11: a foreground re-assert is missing, misplaced, unverified, or not actually enforced"
  sed 's/^/          /' "${WORK}/g11.txt" | head -14
fi

if [ -x "$FAKEBB" ]; then
  # G12 — the same claim through capture.sh, on the LEDGER. A run that takes a
  # picture activates three times (tab + the state's lead + the capture's own);
  # the --evidence --no-frame run takes no picture at all, so it activates twice
  # and NEVER screenshots. That second arm is also defect 3's proof, and each is
  # the other's positive control — and the difference between them is exactly ONE
  # activate, which is what defect 1 got wrong by making it two.
  SHOTD="${WORK}/shot"; mkdir -p "$SHOTD"
  FAKE_LOG="${WORK}/shot-ledger.txt" APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --no-frame --out "$SHOTD" \
    >"${WORK}/g12.log" 2>&1
  g12rc=$?
  s_act="$(grep -c ' activate' "${WORK}/shot-ledger.txt" 2>/dev/null)"
  s_shot="$(grep -c 'screenshot' "${WORK}/shot-ledger.txt" 2>/dev/null)"
  s_last_act="$(grep -n ' activate' "${WORK}/shot-ledger.txt" | tail -1 | cut -d: -f1)"
  s_shot_at="$(grep -n 'screenshot' "${WORK}/shot-ledger.txt" | head -1 | cut -d: -f1)"
  # the evidence arm, from G8's ledger: 1 activate, 0 screenshots
  e_act="$(grep -c ' activate' "${WORK}/fg-ledger.txt" 2>/dev/null)"
  e_shot="$(grep -c 'screenshot' "${WORK}/fg-ledger.txt" 2>/dev/null)"
  # the raise must be the ledger line IMMEDIATELY before the screenshot: nothing
  # may sit in the gap (3/3 at gap 0 against 1/3 with a 4 s wake in between).
  s_gap=$(( s_shot_at - s_last_act ))
  if [ "$g12rc" = 0 ] && [ "$s_act" = 3 ] && [ "$s_shot" = 1 ] \
     && [ -n "$s_last_act" ] && [ -n "$s_shot_at" ] && [ "$s_gap" = 1 ] \
     && [ "$e_act" = 2 ] && [ "$e_shot" = 0 ]; then
    pass "G12: a capturing run foregrounds THREE times — once per tab, once opening the state, and once as the ledger line immediately before the screenshot — while the --evidence --no-frame run foregrounds twice and issues NO screenshot at all (so neither count is a grep that matches everything)"
  else
    fail "G12: the per-capture re-assert or the screenshot-free evidence run is wrong (rc=$g12rc shot-run activate=$s_act screenshot=$s_shot order=$s_last_act/$s_shot_at; evidence-run activate=$e_act screenshot=$e_shot)"
    sed 's/^/          /' "${WORK}/g12.log" | tail -8
  fi

  # G13 🔴 THE THREE SENTENCES BEHIND ONE EXIT CODE. A tab that was never really
  # in front cannot boot an App Block, and its anchor state is no evidence about
  # the anchor — but the timeout read the same either way, so two live diagnosis
  # runs concluded nothing. Each arm below must produce its OWN sentence and NOT
  # the others'.
  g13=1
  for arm in "hidden:CONFOUND:never really in front" "never:LOADING shell:the app is booting"; do
    mode="${arm%%:*}"
    D="${WORK}/ready-${mode}"; mkdir -p "$D"
    python3 -c '
import json,sys
r=json.load(open(sys.argv[1])); r["ready"]["timeoutMs"]=1200
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-fast-${mode}.json"
    FAKE_READY_MODE="$mode" APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
      "${WORK}/rec-fast-${mode}.json" --state discover --evidence --no-frame \
      --out "$D" >"${WORK}/g13-${mode}.log" 2>&1
    rc13=$?
    [ "$rc13" = 11 ] || { g13=0; echo "arm ${mode}: rc=$rc13, expected 11" >>"${WORK}/g13.txt"; }
    grep -q 'APP NEVER BOOTED' "${WORK}/g13-${mode}.log" || { g13=0; echo "arm ${mode}: no boot message" >>"${WORK}/g13.txt"; }
    grep -q 'THE ACTION FAILED' "${WORK}/g13-${mode}.log" && { g13=0; echo "arm ${mode}: printed the ACTION sentence" >>"${WORK}/g13.txt"; }
  done
  # the discriminator: only the hidden arm may say CONFOUND, and only the
  # loading arm may talk about the app booting. Same exit code, different verdict.
  grep -q 'CONFOUND' "${WORK}/g13-hidden.log" || { g13=0; echo "hidden arm does not name the confound" >>"${WORK}/g13.txt"; }
  grep -q 'CONFOUND' "${WORK}/g13-never.log"  && { g13=0; echo "the LOADING arm also says CONFOUND — the two are not distinguished" >>"${WORK}/g13.txt"; }
  grep -q 'LOADING shell' "${WORK}/g13-never.log" || { g13=0; echo "the loading arm does not describe a booting app" >>"${WORK}/g13.txt"; }
  grep -q 'ready\` testid still exists' "${WORK}/g13-hidden.log" && { g13=0; echo "the hidden arm implicates the ANCHOR, which it cannot speak about" >>"${WORK}/g13.txt"; }
  if [ "$g13" = 1 ]; then
    pass "G13: exit 11 tells its three causes apart — a tab that was never in front reads as a CONFOUND (and never implicates the ready anchor), a loading shell reads as a booting/deadlocked app, and neither is reported as a failing action"
  else
    fail "G13: a hidden tab still impersonates a bad ready anchor"
    sed 's/^/          /' "${WORK}/g13.txt" 2>/dev/null | head -8
  fi

  # G13b — the bridge's own window-raise verdict is READ. `applied` is necessary
  # and not sufficient (the visibility token above is the authority), but a
  # `failed` must stop the run rather than let it walk into the deadlock.
  I3D="${WORK}/i3fail"; mkdir -p "$I3D"
  FAKE_I3_MODE=failed APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --evidence --no-frame \
    --out "$I3D" >"${WORK}/g13b.log" 2>&1
  i3rc=$?
  if [ "$i3rc" = 13 ] && grep -q 'THE WINDOW WAS NOT RAISED' "${WORK}/g13b.log" \
     && [ ! -f "${I3D}/discover.evidence.json" ] \
     && grep -q 'i3=applied' "${WORK}/g8.log"; then
    pass "G13b: a FAILED host-side window raise stops the run (exit 13, no artifact) — and the ordinary run prints i3=applied, so the failure arm is not a grep that always matches"
  else
    fail "G13b: the bridge's i3 verdict is not read (rc=$i3rc, artifact=$([ -f "${I3D}/discover.evidence.json" ] && echo present || echo absent))"
    sed 's/^/          /' "${WORK}/g13b.log" | tail -8
  fi

  # G14 🔴 DEFECT 3, END TO END, AND THE MEASURED CAUSE. Under FAKE_SHOT_MODE the
  # screenshot answers `op_timeout:screenshot` with no path — a captureVisibleTab
  # call that HANGS rather than rejecting, so the fast path's catch never falls
  # through to CDP and the op burns the whole 18 s budget. Two arms:
  #   (a) a run that WANTS the picture must stop, attribute it to the BRIDGE, and
  #       never print the action-failure sentence that blamed the recipe;
  #   (b) a run that DISCARDS the picture must be unaffected — it plans no
  #       screenshot at all, so the same broken bridge op cannot destroy its
  #       evidence. That is the regression that killed two live runs.
  SHF="${WORK}/shotfail"; mkdir -p "$SHF"
  FAKE_SHOT_MODE=timeout APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --no-frame --out "$SHF" \
    >"${WORK}/g14a.log" 2>&1
  a14=$?
  EVOK="${WORK}/shotfail-ev"; mkdir -p "$EVOK"
  FAKE_SHOT_MODE=timeout APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "$RECIPES/custom-generators.json" --state discover --evidence --no-frame \
    --out "$EVOK" >"${WORK}/g14b.log" 2>&1
  b14=$?
  ok14=1
  [ "$a14" = 12 ] || ok14=0
  grep -q 'THE SCREENSHOT BRIDGE OP FAILED' "${WORK}/g14a.log" || ok14=0
  # 🔴 THE REMEDIATION MUST NAME THE BUILD, MUST CARRY THE MEASUREMENTS, AND MUST
  # RULE OUT BOTH DEAD ENDS THIS SKILL HAS ALREADY WALKED.
  #
  # 🔴 THIS GATE ITSELF SHIPPED THE SECOND WRONG VARIABLE. It was hardened on
  # 2026-08-19 to stop the message advising FOCUS — and pinned OCCLUSION in its
  # place, which the 2026-08-24 refutation then killed: the hang reproduces with
  # the window on a non-visible workspace and NOTHING drawn on top. A test that
  # asserts a mechanism keeps that mechanism alive after the docs retract it, so
  # this assertion now names the CAUSE (an unbounded fast path, fixed in the
  # bridge) and the two refuted variables are BOTH negative-asserted.
  #
  # 🔴 THE ARTIFACT UNDER TEST IS PROSE, SO PIN THE WHOLE NORMALISED STRING.
  # A guard on WORDS is walkable by REWORDING, and this message has now been
  # permitted to name a wrong variable THREE times. Two spelled attempts failed
  # here, both measured:
  #   - a negative assert on "un-cover the window" ALSO matches the correct
  #     message's "un-covering the window is not the fix" — a spelled guard
  #     catching its own negation;
  #   - narrowing it to the operative i3 command ("move container to workspace")
  #     was then walked by the SAME retracted advice written as PROSE without the
  #     command, and the whole suite stayed green over it (138 PASS).
  # So the remediation body is pinned VERBATIM, whitespace-normalised. Any
  # reword fails and must be re-pinned deliberately — that is the trade, and it
  # is the only form of this assertion that a paraphrase cannot walk.
  # The variable lines ("for state '<st>'", "last read : ...") are excluded on
  # purpose; everything below the op_timeout branch is constant text.
  #
  # 🔴 THE RANGE ENDS AT EOF, NOT AT A CONTENT ANCHOR — and that is the whole
  # point. The first version of this pin ended at "FULL Brave restart is the
  # reliable path", so it saw only the text BETWEEN two anchors. A delta audit
  # then appended the retracted un-cover advice ONE LINE past the end anchor,
  # still inside the op_timeout branch and still printed to the operator, and
  # the suite stayed green: 138 PASS, G14 included. A POSITIONALLY BOUNDED pin
  # is not a pin, it is a window — and the same round had deleted the
  # position-independent asserts that used to cover the rest. Both halves are
  # restored below: the range now runs to end of output, so anything appended
  # is INSIDE it, and the two negative greps are back for anything inserted
  # BEFORE the anchor.
  norm_g14() { sed -n '/This is a STALE BRIDGE BUILD/,$p' "$1" \
                 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/[[:space:]][[:space:]]*/ /g'; }
  # ⚠️ ONE LINE OF THIS PIN IS NOT CONSTANT TEXT: `browser --instance work ping`
  # interpolates $INSTANCE, and `work` is only capture.sh's DEFAULT. The G14 arm
  # passes no --instance, so it is deterministic today — but a --instance on this
  # invocation, or a change to that default, red-lines the pin for a reason that
  # has nothing to do with prose drift. Read this note before "fixing" such a red.
  cat >"${WORK}/g14.expected" <<'G14EOF'
This is a STALE BRIDGE BUILD, not a recipe failure.
chrome.tabs.captureVisibleTab can HANG rather than reject, so the fast
path's catch — whose job is to fall through to CDP — never ran, and the
op burned the whole 18s EXEC_OP_BUDGET_MS on a tab CDP captures in under
a second. The tell is the ceiling: timeouts pin at 18.1s, and one arm
RETURNED via captureVisibleTab at 17.97s — a near-miss and a timeout are
the same phenomenon. Fixed by bounding the fast path at 1500ms
(FAST_CAPTURE_BUDGET_MS, devrc #797).
🔴 OCCLUSION IS NOT REQUIRED and FOCUS IS NOT THE VARIABLE. It
reproduces with the window on a non-visible workspace and NOTHING
drawn on top, and a window VISIBLE but UNFOCUSED captured 6/6 in
192-306ms. So moving the pointer or clicking to focus changes
nothing, and un-covering the window is not the fix.
⚠️ NOT ESTABLISHED: whether a GENUINELY OCCLUDED window makes it
worse. That arm was never held — do not read the above as ruling
occlusion out as a contributor. The 6/6 and 3/3 figures are
one-shot arms on a primitive now known to be flaky: indicative.
FIX: update the bridge extension, then confirm what is RUNNING —
browser --instance work ping # buildMarker, NOT extensionVersion
extensionVersion stayed 0.8.1 across two DIFFERENT builds, so it cannot
tell you this. The MV3 worker keeps old code until it reloads and the
brave://extensions reload button often no-ops (the long-poll holds the
worker alive) — a FULL Brave restart is the reliable path.
G14EOF
  norm_g14 "${WORK}/g14a.log" >"${WORK}/g14.actual"
  if ! diff -q "${WORK}/g14.expected" "${WORK}/g14.actual" >/dev/null 2>&1; then
    ok14=0
    echo "the exit-12 remediation text drifted from its pin:" >"${WORK}/g14.txt"
    diff "${WORK}/g14.expected" "${WORK}/g14.actual" >>"${WORK}/g14.txt" 2>&1
  fi
  # ...and the sentences that must never come back ANYWHERE in the run, whatever
  # the pin's range happens to cover. These are the position-independent half:
  # the pin proves the remediation says the right thing, these prove no dead end
  # was smuggled in beside it.
  grep -q 'THE ACTION FAILED' "${WORK}/g14a.log" && ok14=0
  grep -qi 'visible but not focused\|focus_follows_mouse\|window focused for the run' "${WORK}/g14a.log" && ok14=0
  # 🔴 SCOPED TO THE EXIT-12 STANZA, NOT THE WHOLE RUN. `move container to
  # workspace` is CORRECT advice in the exit-11 CONFOUND arm (capture.sh prints
  # it there on purpose, to remove an attribution confound), so a run-wide ban
  # reads as banning the file's own advice and would misattribute a red the
  # moment a fixture reaches that arm. It is only wrong as an exit-12 remedy.
  sed -n '/THE SCREENSHOT BRIDGE OP FAILED/,$p' "${WORK}/g14a.log" \
    | grep -q 'move container to workspace' && ok14=0
  [ "$b14" = 0 ] || ok14=0
  [ -f "${EVOK}/discover.evidence.json" ] || ok14=0
  if [ "$ok14" = 1 ]; then
    pass "G14: a screenshot that comes back with no path exits 12 naming the BRIDGE, and its whole remediation body is pinned VERBATIM rather than by keyword — because this one message has been allowed to name a wrong variable three times, and two spelled guards were each walked (one matched its own negation, one was walked by the same advice written as prose). The pin carries the cause (an unbounded fast path), the measurements that identify it, the fix, the only field that reads the RUNNING build, and an explicit NOT-ESTABLISHED clause; 'THE ACTION FAILED' can never appear. Meanwhile the SAME broken screenshot leaves an --evidence --no-frame run untouched: it exits 0 with its artifact, because it never asked for a picture it discards"
  else
    fail "G14: a bridge-side screenshot failure is still attributed to the recipe, its remediation text drifted from its pin, or it still destroys an evidence run (shot-run rc=$a14, evidence-run rc=$b14, artifact=$([ -f "${EVOK}/discover.evidence.json" ] && echo present || echo absent))"
    sed 's/^/          /' "${WORK}/g14.txt" 2>/dev/null | head -24
    sed 's/^/          /' "${WORK}/g14a.log" | tail -6
    sed 's/^/          /' "${WORK}/g14b.log" | tail -4
  fi
fi


# ---------------------------------------------------------------------------
# G15 🔴 THE APP-FRAME WIRING, END TO END THROUGH capture.sh, WITH NO BROWSER.
# F10/F11 prove the arithmetic; this proves the number ever REACHES it. The
# fake bridge answers the probe with chromeTop 201 — a value that appears in
# NEITHER the recipe (182) NOR frame.py's defaults (182), and that must WIN the
# max() — so a run whose wiring is inert measures 182 and fails here. It is also
# picky about scope: it REFUSES the probe if it arrives --frame-scoped, because
# the <iframe> element lives in the TOP frame and a frame-scoped probe would
# search the app's own document and answer ABSENT forever.
# ---------------------------------------------------------------------------
if [ -x "$FAKEBB" ]; then
  # two states is enough for check-states and keeps the gate cheap
  python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
r["states"]=[s for s in r["states"] if s["name"] in ("explainer","discover")]
kept=[a[v] for s in r["states"] for a in s.get("actions",[])
      for v in ("click","clickIfPresent") if v in a]
r["clickable"]=[x for x in r.get("clickable",[]) if x in kept]
# 🔴 STRIP THE DECLARED RECT — this arm grades the DETECTION path, and frame.py
# returns a declared rect verbatim, so leaving it in would grade the rect path while
# asserting detection expectations (two distinct boxes, the recipe`s floors intact).
# Building the detect form HERE keeps this arm`s frameHost and its two state names,
# which the fake bridge is keyed on, and stops it depending on a property of another
# file that can change under it again.
r["crop"]={k:v for k,v in r["crop"].items() if k not in ("rect","_measuredGeometry","_measured")}
json.dump(r,open(sys.argv[2],"w"))' "$RECIPES/custom-generators.json" "${WORK}/rec-2state.json"

  AFD="${WORK}/appframe"; mkdir -p "$AFD"
  FAKE_SHOT_SEQ="${WORK}/shotseq.txt" FAKE_LOG="${WORK}/af-ledger.txt" \
    APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "${WORK}/rec-2state.json" \
    --out "$AFD" >"${WORK}/g15.log" 2>&1
  g15rc=$?
  if [ "$g15rc" = 0 ] && python3 - "$AFD" "${WORK}/af-ledger.txt" >>"${WORK}/g15.log" 2>&1 <<'PY'
import json, os, sys
OUT, LEDGER = sys.argv[1], sys.argv[2]
bad = []
ms = json.load(open(os.path.join(OUT, "measures.json")))
if len(ms) != 2:
    bad.append("expected 2 measures, got %d" % len(ms))
for m in ms:
    if m["bands"]["chromeTop"] != 201:
        bad.append("%s measured with chromeTop=%s — the probe's 201 never reached "
                   "frame.py, so the wiring is inert" % (m["file"], m["bands"]["chromeTop"]))
    # the floors must still be the recipe's: the rect reported the same values,
    # so a max() that silently took the rect's side would look identical here —
    # what this pins is that neither band was DROPPED.
    if (m["bands"]["footer"], m["bands"]["right"]) != (110, 70):
        bad.append("%s: footer/right are %s, not the recipe's floors"
                   % (m["file"], (m["bands"]["footer"], m["bands"]["right"])))
if len({(m["box"]["x"], m["box"]["y"], m["box"]["w"], m["box"]["h"]) for m in ms}) != 2:
    bad.append("the two states measured the SAME box — check-states should have refused")
for st in ("explainer", "discover"):
    p = os.path.join(OUT, "%s.rect.json" % st)
    if not os.path.exists(p):
        bad.append("no %s.rect.json — the probe was never run for that state" % st)
    elif "APPFRAME_RECT:" not in open(p).read():
        bad.append("%s.rect.json holds no rect" % st)
# the probe is a TOP-FRAME op: no --frame on its line, and the ledger has to
# carry frame-scoped lines too or that absence proves nothing.
lines = [l for l in open(LEDGER).read().splitlines()]
probes = [l for l in lines if "APPFRAME_ABSENT" in l]
if len(probes) != 2:
    bad.append("the app-frame probe was sent %d time(s), expected once per state" % len(probes))
if any("--frame" in l for l in probes):
    bad.append("the app-frame probe was frame-scoped — it would search the app's own document")
if not any("--frame" in l for l in lines):
    bad.append("POSITIVE CONTROL FAILED: the ledger carries no --frame line at all, so "
               "'the probe has no --frame' is a fact about the grep")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
  then
    pass "G15: a framed run reads the app iframe's rect once per state, TOP-FRAME (never --frame-scoped, while the same ledger carries frame-scoped ops), and the probe's chromeTop=201 — a value in neither the recipe nor the defaults — is what both states are actually measured with, with the recipe's footer/right floors intact and two distinct boxes"
  else
    fail "G15: the app-frame rect never reaches the cropper (rc=$g15rc)"
    sed 's/^/          /' "${WORK}/g15.log" | tail -14
  fi

  # G15b/c NEG — the two ways the derived band must STOP the run instead of
  # quietly falling back to the static one that cannot be right in both layouts.
  for mode in "absent:app_frame_absent" "scale:app_frame_scale"; do
    knob="${mode%%:*}"; want="${mode##*:}"
    ND="${WORK}/af-neg-${knob}"; mkdir -p "$ND"
    FAKE_APPFRAME_MODE="$knob" FAKE_SHOT_SEQ="${WORK}/shotseq-${knob}.txt" \
      APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "${WORK}/rec-2state.json" \
      --out "$ND" >"${WORK}/g15-${knob}.log" 2>&1
    nrc=$?
    if [ "$nrc" = 5 ] && grep -q "REFUSE\[${want}\]" "${WORK}/g15-${knob}.log" \
       && [ ! -f "${ND}/measures.json" ]; then
      pass "G15-neg: FAKE_APPFRAME_MODE=${knob} stops the run with REFUSE[${want}] and ships no measurement — a fallback to the static band here would restore exactly the defect this replaces"
    else
      fail "G15-neg: ${knob} did not stop the run (rc=$nrc)"
      sed 's/^/          /' "${WORK}/g15-${knob}.log" | tail -6
    fi
  done

  # -------------------------------------------------------------------------
  # G20 🔴 THE VIEWPORT OF RECORD, END TO END, WITH ITS OWN EXIT CODE.
  # C5 proves frame.py refuses; this proves capture.sh STOPS on that refusal and
  # tells the operator apart from a bad crop by STATUS (14, not 5). The whole
  # incident's shape was a run that exited 0 and shipped the asset, so "the run
  # stops" is the property, and "with a code that means resize the window" is
  # what a caller can act on.
  #
  # The fake bridge serves the 1709x1314 fixtures and answers the probe with a
  # matching viewport, so a recipe that records 1709x1255 is the real defect in
  # miniature: probe and capture AGREE (app_frame_scale passes) and the record is
  # the only thing that disagrees.
  # -------------------------------------------------------------------------
  for vph in 1255 1314; do
    python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
r["crop"]["rect"]={"x":252,"y":31,"w":1200,"h":312,"yFrom":"appFrame"}
r["crop"]["_measuredGeometry"]={"viewport":[1709,int(sys.argv[3])]}
json.dump(r,open(sys.argv[2],"w"))' \
      "${WORK}/rec-2state.json" "${WORK}/rec-vp-${vph}.json" "$vph"
    VPD="${WORK}/vp-${vph}"; mkdir -p "$VPD"
    FAKE_SHOT_SEQ="${WORK}/shotseq-vp-${vph}.txt" APP_CAPTURE_BB="$FAKEBB" \
      bash "$CAPTURE_SH" "${WORK}/rec-vp-${vph}.json" --out "$VPD" \
      >"${WORK}/g20-${vph}.log" 2>&1
    vprc=$?
    if [ "$vph" = 1255 ]; then
      if [ "$vprc" = 14 ] \
         && [ "$(grep -c 'REFUSE\[viewport_of_record\]' "${WORK}/g20-${vph}.log")" != "0" ] \
         && [ "$(grep -c 'REFUSE\[app_frame_scale\]' "${WORK}/g20-${vph}.log")" = "0" ] \
         && [ ! -f "${VPD}/measures.json" ] && [ ! -f "${VPD}/explainer-framed.png" ]; then
        pass "G20-neg: a recipe whose rect records a 1709x1255 viewport, run against a 1709x1314 capture whose PROBE AGREES with it, stops the run with exit 14 (its own code, not the bad-crop 5) and ships neither a measurement nor a framed asset — while app_frame_scale stays silent, which is exactly why nothing caught this before"
      else
        fail "G20-neg: the viewport mismatch did not stop the run with exit 14 (rc=$vprc)"
        sed 's/^/          /' "${WORK}/g20-${vph}.log" | tail -8
      fi
    else
      # 🔴 THE POSITIVE CONTROL, and it is not optional: a gate that refused every
      # declared rect would satisfy the arm above and break all four shipped
      # recipes. Same recipe, same bridge, record corrected to the capture.
      if [ "$vprc" = 0 ] && [ -f "${VPD}/measures.json" ] \
         && [ "$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(sum(1 for x in m if x["box"]=={"x":252,"y":232,"w":1200,"h":312} and x["mode"]=="declared"))' "${VPD}/measures.json")" = "2" ]; then
        pass "G20-pos: the SAME recipe with its record corrected to the capture's own 1709x1314 runs green end to end and measures both states at the rect resolved against the live edge (y=201+31=232, mode=declared) — so exit 14 is about the mismatch, not about declaring a rect"
      else
        fail "G20-pos: a correctly recorded declared rect no longer captures (rc=$vprc)"
        sed 's/^/          /' "${WORK}/g20-${vph}.log" | tail -8
      fi
    fi
  done

  # -------------------------------------------------------------------------
  # G21 🔴 THE HORIZONTAL ANCHOR, END TO END — AND THE SECOND TOKEN capture.sh
  # MATCHES ON. F14 proves frame.py refuses; this proves capture.sh STOPS on that
  # refusal and reports it with the SAME status as the viewport one (14, not the
  # bad-crop 5), because a wrong app frame and a wrong window ask the operator for
  # the same thing. Without this arm the `frame_of_record` half of that branch is
  # a SPELLED token with nothing exercising it: misspell it and the run falls
  # through to exit 5, while a static read of capture.sh still shows exit 14
  # present and D8 still passes. That is exactly the shape M193 pins for the
  # viewport token, and M208 pins here.
  #
  # The fake bridge's probe answer is `201,110,70,1709,1314,0` — a full-bleed
  # frame, as every live answer in this repo's corpus is — so the LIVE app frame
  # is 1709 - 70 - 0 = 1639 device px. A recipe recording that captures; one
  # recording 1000 does not.
  #
  # 🔴 AND THE THIRD ARM IS THE ONE THAT MATTERS MOST: the same recipe against a
  # FIVE-field probe answer must refuse (`app_frame_left_missing`, exit 5 — a
  # recipe/probe defect, not a window one), never read `x` as an absolute column.
  # -------------------------------------------------------------------------
  for fw in 1639 1000; do
    python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
r["crop"]["rect"]={"x":252,"y":31,"w":257,"h":312,
                   "yFrom":"appFrame","xFrom":"appFrame","wFrom":"appFrameRight"}
r["crop"]["_measuredGeometry"]={"viewport":[1709,1314],"appFrameW":int(sys.argv[3])}
json.dump(r,open(sys.argv[2],"w"))' \
      "${WORK}/rec-2state.json" "${WORK}/rec-fw-${fw}.json" "$fw"
    FWD="${WORK}/fw-${fw}"; mkdir -p "$FWD"
    FAKE_SHOT_SEQ="${WORK}/shotseq-fw-${fw}.txt" APP_CAPTURE_BB="$FAKEBB" \
      bash "$CAPTURE_SH" "${WORK}/rec-fw-${fw}.json" --out "$FWD" \
      >"${WORK}/g21-${fw}.log" 2>&1
    fwrc=$?
    if [ "$fw" = 1000 ]; then
      if [ "$fwrc" = 14 ] \
         && [ "$(grep -c 'REFUSE\[frame_of_record\]' "${WORK}/g21-${fw}.log")" != "0" ] \
         && [ "$(grep -c 'REFUSE\[viewport_of_record\]' "${WORK}/g21-${fw}.log")" = "0" ] \
         && [ ! -f "${FWD}/measures.json" ]; then
        pass "G21-neg: a fully anchored rect recording a 1000px app frame, run against a capture whose frame is 1639px wide, stops the run with exit 14 — the SAME code as the viewport mismatch, because both ask the operator to restore the geometry — and ships no measurement; \`viewport_of_record\` stays silent, so the two checks are not one check with two names"
      else
        fail "G21-neg: the frame-width mismatch did not stop the run with exit 14 (rc=$fwrc)"
        sed 's/^/          /' "${WORK}/g21-${fw}.log" | tail -8
      fi
    else
      # 🔴 THE POSITIVE CONTROL, and it carries the whole six-field probe end to
      # end: a gate that refused every anchored rect would satisfy the arm above.
      # x resolves to 0+252 and w to (1709-70)-257-252 = 1130.
      if [ "$fwrc" = 0 ] && [ -f "${FWD}/measures.json" ] \
         && [ "$(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(sum(1 for x in m if x["box"]=={"x":252,"y":232,"w":1130,"h":312} and (x.get("resolved") or {}).get("appFrameLeft")==0))' "${FWD}/measures.json")" = "2" ]; then
        pass "G21-pos: the SAME recipe recording the live 1639px app frame runs green end to end through the SIX-field probe, and both states resolve to the anchored box (x=0+252, w=(1709-70)-257-252=1130, y=201+31=232) with the left edge REPORTED — so exit 14 is about the frame mismatch, not about anchoring"
      else
        fail "G21-pos: a correctly recorded fully-anchored rect does not capture (rc=$fwrc)"
        sed 's/^/          /' "${WORK}/g21-${fw}.log" | tail -8
      fi
    fi
  done
  # ...and a stale FIVE-field probe answer must refuse rather than fall back.
  FWD5="${WORK}/fw-five"; mkdir -p "$FWD5"
  FAKE_APPFRAME_MODE=fivefield FAKE_SHOT_SEQ="${WORK}/shotseq-fw-five.txt" \
    APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "${WORK}/rec-fw-1639.json" \
    --out "$FWD5" >"${WORK}/g21-five.log" 2>&1
  fw5rc=$?
  if [ "$fw5rc" = 5 ] \
     && [ "$(grep -c 'REFUSE\[app_frame_left_missing\]' "${WORK}/g21-five.log")" != "0" ] \
     && [ ! -f "${FWD5}/measures.json" ]; then
    pass "G21-five: the SAME recipe against a stale FIVE-field probe answer refuses end to end (app_frame_left_missing, exit 5 — a recipe/probe defect, not a wrong window) rather than reading \`x\` as an absolute column, which is the silent fallback the whole form exists to remove"
  else
    fail "G21-five: a five-field probe answer did not stop an xFrom run (rc=$fw5rc)"
    sed 's/^/          /' "${WORK}/g21-five.log" | tail -8
  fi

  # -------------------------------------------------------------------------
  # G16 — `clickIfPresent`: a selector miss is an ACTION FAILURE by default, and
  # a SUPPORTED OUTCOME only where the recipe says so.
  #
  # 🔴 THE DEFAULT USED TO BE SILENCE. `click` carries no `expect`, so the poll
  # loop broke on the first read whatever the bridge answered — and the bridge
  # answers `element_not_found`. A recipe whose selector had drifted ran a step
  # that did nothing and captured the wrong screen, reporting success. Only the
  # identical-box gate could catch that, and only when two states collided.
  # -------------------------------------------------------------------------
  python3 -c '
import json,sys
r=json.load(open(sys.argv[1]))
for s in r["states"]:
    for a in s.get("actions",[]):
        if "click" in a: a["clickIfPresent"]=a.pop("click")
json.dump(r,open(sys.argv[2],"w"))' "${WORK}/rec-2state.json" "${WORK}/rec-optional.json"

  CD1="${WORK}/click-req"; mkdir -p "$CD1"
  FAKE_CLICK_MODE=not-found APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-2state.json" --state discover --evidence --no-frame \
    --out "$CD1" >"${WORK}/g16a.log" 2>&1
  c1rc=$?
  CD2="${WORK}/click-opt"; mkdir -p "$CD2"
  FAKE_CLICK_MODE=not-found APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-optional.json" --state discover --evidence --no-frame \
    --out "$CD2" >"${WORK}/g16b.log" 2>&1
  c2rc=$?
  CD3="${WORK}/click-ctrl"; mkdir -p "$CD3"
  APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "${WORK}/rec-2state.json" \
    --state discover --evidence --no-frame --out "$CD3" >"${WORK}/g16c.log" 2>&1
  c3rc=$?
  ok16=1
  [ "$c1rc" = 4 ] || ok16=0
  grep -q 'THE SELECTOR MATCHED NOTHING' "${WORK}/g16a.log" || ok16=0
  [ -f "${CD1}/discover.evidence.json" ] && ok16=0
  [ "$c2rc" = 0 ] || ok16=0
  grep -q 'optional: the element is absent' "${WORK}/g16b.log" || ok16=0
  [ -f "${CD2}/discover.evidence.json" ] || ok16=0
  [ "$c3rc" = 0 ] || ok16=0
  if [ "$ok16" = 1 ]; then
    pass "G16: a click whose selector matches nothing FAILS the state (exit 4, 'THE SELECTOR MATCHED NOTHING', no artifact) — while the SAME recipe with the SAME miss declared \`clickIfPresent\` exits 0 with its artifact and says the step was skipped; and the required-click recipe runs green when the element IS there, so exit 4 is about the miss and not about the recipe copy"
  else
    fail "G16: the required/optional click distinction is wrong (required=$c1rc optional=$c2rc control=$c3rc)"
    sed 's/^/          /' "${WORK}/g16a.log" | tail -6
  fi

  # -------------------------------------------------------------------------
  # G17 🔴 THE CLASS, NOT THE STRING — and the two ops that keep their own code.
  #
  # G16's first implementation matched `*element_not_found*`. That closed ONE
  # error and left the class open one word over: the bridge CLI ends every failed
  # op with `die "op '<op>' failed in the browser: <err>"` (exit 1), so a `click`
  # answered with `op_timeout:click` — the same shape `op_timeout:screenshot`
  # already had its own branch for, one op away — ran green, wrote its evidence
  # artifact and said nothing. Measured on the pre-fix tree: rc 0, artifact
  # present. It also made a CROSS-REPO error string load-bearing in capture.sh,
  # so a rename upstream would have restored the whole defect silently.
  #
  # So the check is on the op's EXIT STATUS. These arms pin that, and pin the two
  # deliberate exemptions that keep this skill's five-codes-five-sentences design
  # intact.
  # -------------------------------------------------------------------------
  ok17=1; note17=""
  ge() { note17="${note17} $1"; ok17=0; }

  # (a) a REQUIRED click that fails with an error carrying NO element_not_found
  ED1="${WORK}/opfail-req"; mkdir -p "$ED1"
  FAKE_CLICK_MODE=op-error APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-2state.json" --state discover --evidence --no-frame \
    --out "$ED1" >"${WORK}/g17a.log" 2>&1
  e1rc=$?
  [ "$e1rc" = 4 ] || ge "required-op-error rc=$e1rc (want 4)"
  [ -f "${ED1}/discover.evidence.json" ] && ge "required-op-error still shipped an artifact"
  grep -q 'THE BRIDGE OP FAILED' "${WORK}/g17a.log" || ge "required-op-error printed no bridge-op message"
  # the message must NOT invent a selector diagnosis it has no evidence for
  grep -q 'THE SELECTOR MATCHED NOTHING' "${WORK}/g17a.log" && ge "a generic op error was reported as a stale selector"

  # (b) 🔴 THE ONE THAT MAKES THE REMAINING STRING SAFE. `clickIfPresent` declares
  # that the element may be ABSENT — not that any failure is acceptable. So the
  # SAME generic error on the SAME step still fails. That is the direction a
  # rename of `element_not_found` upstream must fail in: loud, never silent.
  ED2="${WORK}/opfail-opt"; mkdir -p "$ED2"
  FAKE_CLICK_MODE=op-error APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-optional.json" --state discover --evidence --no-frame \
    --out "$ED2" >"${WORK}/g17b.log" 2>&1
  e2rc=$?
  [ "$e2rc" = 4 ] || ge "optional-op-error rc=$e2rc (want 4 — optional narrows, it does not swallow)"
  grep -q 'NOT ABSENCE' "${WORK}/g17b.log" || ge "optional-op-error did not say why it was not skipped"
  [ -f "${ED2}/discover.evidence.json" ] && ge "optional-op-error still shipped an artifact"

  # (c) the SCREENSHOT exemption: the same exit-1 shape, and the run must still
  # come back 12 (the BRIDGE + occlusion sentence), never the generic 4.
  ED3="${WORK}/opfail-shot"; mkdir -p "$ED3"
  FAKE_SHOT_MODE=timeout APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-2state.json" --state discover --out "$ED3" >"${WORK}/g17c.log" 2>&1
  e3rc=$?
  [ "$e3rc" = 12 ] || ge "screenshot-op-error rc=$e3rc (want 12, its own code)"
  grep -q 'THE BRIDGE OP FAILED' "${WORK}/g17c.log" && ge "the screenshot was flattened into the generic op failure"

  # (d) the ACTIVATE exemption: a bridge that DIES on activate is at least as
  # strong a statement as the i3=failed field, and must reach the same code 13.
  ED4="${WORK}/opfail-act"; mkdir -p "$ED4"
  FAKE_I3_MODE=die APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" \
    "${WORK}/rec-2state.json" --state discover --evidence --no-frame \
    --out "$ED4" >"${WORK}/g17d.log" 2>&1
  e4rc=$?
  [ "$e4rc" = 13 ] || ge "activate-op-error rc=$e4rc (want 13, the window-raise code)"

  # (e) POSITIVE CONTROL: with no knob at all the same recipe runs green, so every
  # code above is about the injected failure and not about the recipe copy.
  ED5="${WORK}/opfail-ctrl"; mkdir -p "$ED5"
  APP_CAPTURE_BB="$FAKEBB" bash "$CAPTURE_SH" "${WORK}/rec-2state.json" \
    --state discover --evidence --no-frame --out "$ED5" >"${WORK}/g17e.log" 2>&1
  e5rc=$?
  [ "$e5rc" = 0 ] || ge "the unknobbed control rc=$e5rc (want 0)"
  [ -f "${ED5}/discover.evidence.json" ] || ge "the unknobbed control shipped no artifact"

  if [ "$ok17" = 1 ]; then
    pass "G17: a one-shot bridge op is judged on its EXIT STATUS, not on one error string — a required click failing with a generic op_timeout exits 4 with no artifact (it ran green pre-fix), the SAME error on a \`clickIfPresent\` step ALSO fails (so a rename of element_not_found upstream goes loud, not silent), while the two ops with their own sentences keep them: screenshot 12 and activate 13; unknobbed, the same recipe exits 0"
  else
    fail "G17: the op-failure class is not closed —${note17}"
    sed 's/^/          /' "${WORK}/g17a.log" | tail -6
  fi
else
  fail "G15/G16: .claude/skills/app-capture/tests/fixtures/fake-bridge.sh is missing or not executable"
fi

# ---------------------------------------------------------------------------
# P18 — the recipe-side facts this change rests on, pinned so they cannot drift
# back. `optional` is a key capture.sh BRANCHES on (G16), so the assertion that
# plan.py emits it is about a code path, not about a field.
# ---------------------------------------------------------------------------
if python3 - "$PLAN" "$RECIPES" "${WORK}/obs-model-benchmarking.json" "$FIX" "$WORK" "$MKPNG" >"${WORK}/p18.txt" 2>&1 <<'PY'
import json, os, re, struct, subprocess, sys


def _png_wh(path):
    """The fixture's own dimensions, read from its IHDR.

    🔴 Deliberately NOT via frame.py's image_size: frame.py is the module under
    test and the mutation battery swaps it for a copy, so reading the fixture
    through it would let a mutant decide how big the fixture is.
    """
    with open(path, "rb") as fh:
        head = fh.read(24)
    return struct.unpack(">II", head[16:24])

# 🔴 $FIX IS PASSED IN, NOT DERIVED FROM $RECIPES. The fixtures live under
# REPO_ROOT while $RECIPES follows $SCRIPTS — which the mutation battery
# REDIRECTS to a copy. Walking up from $RECIPES therefore resolved to a path that
# does not exist under every mutant, so this gate failed unconditionally there:
# the battery's own self-test caught it on the first inert edit (scored MISATTR
# instead of SURVIVED) and refused to report anything, which is the only reason
# it did not quietly turn every mutant into a fake kill by P18.
PLAN, RECIPES, OBS, FIXTURES, WORK, MKPNG = sys.argv[1:7]
FIX_WH = _png_wh(os.path.join(FIXTURES, "5-mb-combinations.png"))
bad = []
mb = json.load(open(os.path.join(RECIPES, "model-benchmarking.json")))

# the how-to dismissal is PROFILE-dependent: present on a fresh profile, absent
# on every profile that has already run the app (the dismissal persists).
for st in mb["states"]:
    first = st["actions"][0]
    if "clickIfPresent" not in first or "howto-dismiss" not in first["clickIfPresent"]:
        bad.append("%s does not OPEN by dismissing the how-to if present: %s"
                   % (st["name"], first))
    if "click" in first:
        bad.append("%s dismisses with a REQUIRED click — that fails every profile "
                   "that has already dismissed it" % st["name"])
    # 🔴 THE waitForGone IS NOT DEAD AND MUST STAY. A wait-until-absent is
    # satisfied instantly when the panel is already gone, and on a FRESH profile
    # it is the only thing stopping the next click racing the dismissal.
    if not any(a.get("waitForGone") == "How this works" for a in st["actions"]):
        bad.append("%s dropped the waitForGone — the next click then races the "
                   "dismissal on a fresh profile" % st["name"])

# the stale content veto is gone, and the spend caveat is not
# 🔴 ASSERTED POSITIVELY, on the STATE it must describe, not on the absence of
# the old wording. A guard that only greps for the stale sentence is walkable by
# a reword — and it fired on the replacement itself, which quoted the old claim
# while correcting it.
cav = mb.get("_contentCaveat", "")
for needle in ("2 matchups", "4 prompts", "16 grid cells", "POPULATED"):
    if needle not in cav:
        bad.append("_contentCaveat does not state the measured content (%r missing) — "
                   "the old note read as a standing veto on shooting this app" % needle)
if "SPEND" not in cav.upper():
    bad.append("_contentCaveat lost the 'filling a cell spends Buzz' caveat")
if "2026-" not in cav:
    bad.append("_contentCaveat carries no date — a crowdsourced count is a "
               "measurement that goes stale, and the last one did")

# 🔴 THE FIXTURE IS A LAYOUT FIXTURE, NOT A CONTENT ONE, AND THE MANIFEST HAS TO
# SAY SO. It carried "the run the current store screenshots came from", which was
# true when the recipe still described a thin grid and became false the moment the
# listing was re-shot (2026-08-22, verified against the served bytes). Two docs
# then disagreed about the same app, and the stale one reads as a reason to
# "correct" the caveat back. Asserted POSITIVELY, on what the manifest must state.
man = json.load(open(os.path.join(FIXTURES, "manifest.json")))
mb_cap = [c for c in man["captures"] if c["file"] == "5-mb-combinations.png"]
if not mb_cap:
    bad.append("the model-benchmarking capture is no longer pinned in the manifest")
else:
    note = " ".join(mb_cap[0].get("_comment", []))
    if "NOT THE SOURCE OF THE LIVE STORE SCREENSHOTS" not in note:
        bad.append("the manifest does not say the fixture is NOT the source of the live "
                   "store screenshots — the claim that made two docs contradict")
    if "2026-08-22" not in note:
        bad.append("the manifest does not date the re-shoot that superseded the fixture")

# 🔴 WHICH CROP FORM EACH RECIPE USES — an ASSERTED LEDGER over every shipped
# recipe, not a spot-check, because the three forms are mutually exclusive in
# ways that only refuse at capture time. `detect` = bands only; `absolute` = a
# declared rect and NO fromAppFrame; `appFrame` = a declared rect whose y is
# anchored to the iframe top AND fromAppFrame (infra ticket #1297).
#
# 🔴 NO SHIPPED RECIPE USES THE `absolute` FORM ANY MORE, and the two halves of
# that are NOT the same loss — stated separately because one is worse:
#   - P18's `absolute` arm below is STRUCTURALLY DEAD. No FORMS value is
#     "absolute", so `if form == "absolute"` can never execute and a mutation to
#     it is unkillable BY CONSTRUCTION, not merely unpinned.
#   - frame.py's absolute-rect PATH is still exercised — gate C drives it with
#     hand-built `--crop-rect` cases, and F10d builds one for its refusal.
# Saying "no corpus instance" for both understated the first. sensei was the last one and converted
# on 2026-08-27 — measured, its `y: 97` sat 44px ABOVE the iframe top, inside the
# rewards banner, so its crop's top rows were host page chrome; the corrected
# start is 64 BELOW the iframe top, which is a non-negative offset and therefore
# expressible in the anchored form. It was never a legitimate absolute case, it
# was an unfixed instance of the defect #1316 fixed for the other two apps. The
# form itself stays supported: a genuinely full-bleed app on a page with no
# conditional banner would still want it.
# 🔴 model-benchmarking moved detect -> appFrame on 2026-08-29, and the cause was
# a change in the APP, not in this pipeline: civitai-app-model-benchmarking#16
# (shipped 0.3.3) removed `contentStyle.maxWidth`, which is exactly what task
# 419's criterion 3 asked for ("content spans >= 95% of its frame"). Measured
# across that change at a 1709px viewport: the content column was 1100px = 64.9%
# of the frame at base 6a3c2eb and is 1710.5px = 100% live. The app is therefore
# full-bleed now, content-detection legitimately reports ~98% width, and
# frame.py's full_frame gate was RIGHT to refuse it (its own cause (b)). The
# recipe carries the measurements. The general lesson, which this ledger is the
# only place that records it: A CAPTURE RECIPE ENCODES A CLAIM ABOUT THE APP'S
# SHAPE, so an app-side layout PR can silently invalidate it, and nothing in
# either repo links the two.
# 🔴 app-requests went appFrame -> detect -> appFrame across 2026-09-02, and the
# round trip is the point. The app-taste pass rebuilt its layout, invalidating
# every number in the 0.2.x rect, so the rect was DELETED rather than guessed and
# this entry was moved to "detect" for exactly as long as the new version sat in
# moderator review. That interim state was expected to FAIL a real run, and it
# did: exit 6, identical_boxes, top.png and newest.png both 816x868+448+182 —
# Top and Newest show the same cards reordered, so their content extents genuinely
# match and detection cannot separate them. That is now a MEASURED refutation of
# detection for this app rather than an inherited claim, and it is why the rect is
# declared. It has been re-measured against live 0.3.1 and verified by eye, which
# a declared rect requires: it makes the identical-box check inert and narrows
# full_frame to an AND on both axes, so nothing downstream catches a bad one.
FORMS = {"model-benchmarking": "appFrame", "custom-generators": "appFrame",
         "panorama-360": "detect", "gen-matrix": "detect", "sensei": "appFrame",
         "app-requests": "appFrame", "playable-collections": "appFrame"}
shipped = sorted(f[:-5] for f in os.listdir(RECIPES) if f.endswith(".json"))
if shipped != sorted(FORMS):
    bad.append("the crop-form ledger does not cover every shipped recipe: ledger=%s "
               "recipes=%s — a new recipe must declare which form it uses"
               % (sorted(FORMS), shipped))
for slug, form in sorted(FORMS.items()):
    crop = json.load(open(os.path.join(RECIPES, "%s.json" % slug))).get("crop", {})
    afr, rect = bool(crop.get("fromAppFrame")), crop.get("rect")
    if form == "detect" and (not afr or rect is not None):
        bad.append("%s: expected bands-only detection, got fromAppFrame=%r rect=%r"
                   % (slug, afr, rect))
    if form == "absolute" and (afr or not rect or "yFrom" in rect):
        bad.append("%s: expected an ABSOLUTE declared rect and no fromAppFrame, got "
                   "fromAppFrame=%r rect=%r" % (slug, afr, rect))
    if form == "appFrame":
        if not afr or not rect or rect.get("yFrom") != "appFrame":
            bad.append("%s: expected a FRAME-RELATIVE declared rect (fromAppFrame plus "
                       "rect.yFrom=appFrame), got fromAppFrame=%r rect=%r"
                       % (slug, afr, rect))
        elif not isinstance(crop.get("_measured"), str) or not crop["_measured"].strip():
            bad.append("%s: a declared rect is a MEASUREMENT and the identical-box "
                       "check is inert for it — the recipe must record what was "
                       "measured and when" % slug)
        else:
            # 🔴 RUN THE NUMBERS, do not merely read them. Neither app has a
            # fixture, so until this the shipped rects were prose-checked only: a
            # transposed digit, a rect wider than the viewport or one below the
            # 128px floor would sit in the tree until someone drove a live
            # capture.
            #
            # 🔴 TWO CHECKS, AND SINCE 2026-09-02 BOTH RUN ON THE RECORDED
            # GEOMETRY. Every 1709-wide capture in the FIXTURE CORPUS is 1314
            # rows; every shipped rect was chosen on a live 1709x1255 one — 59
            # rows SHORTER. The arithmetic arm below has always used the recorded
            # reading; the frame.py arm used to run against the 1314-row fixture
            # and so would pass a rect that overruns the real iframe (measured:
            # h=560 on app-requests ends at 1208, past the live bound of 1191,
            # and sailed through). It now runs on a canvas built AT the recorded
            # viewport, so that hole is closed and both arms bound the rect by
            # 1255 - gap. See the canvas note further down for what that costs.
            #
            # 🔴 NOW THE PART THAT MATTERS, AND IT IS A SCOPE STATEMENT, NOT A
            # STRONGER GATE. THIS ARM CANNOT VERIFY AN AUTHOR-SUPPLIED
            # MEASUREMENT, AND NOTHING STATIC CAN. Three audit rounds walked it
            # in turn: grow the rect; then grow the rect AND the recorded
            # viewport; then grow the rect, the viewport AND the prose. Each time
            # the records simply agreed with one another, because they are the
            # same author's numbers in one file and no gate can check provenance.
            # Adding a fourth witness would move the price to four edits and
            # close nothing. The premise check below refuses ONE specific value —
            # the fixture's own dimensions — because that is the tempting
            # shortcut, not because it closes the class. IT DOES NOT: the same
            # walk with any other viewport >= 1272 still passes here.
            #
            # 🔴 SO WHERE IS THE ACTUAL SAFETY PROPERTY? NOT HERE — in
            # declared_box, on the LIVE path, and it is structural because it
            # bounds the rect by the edge THE PROBE REPORTED rather than by any
            # number a recipe wrote down. MEASURED, not argued (2026-08-26): the
            # fully-walked recipe above — h=560, recorded viewport 1709x1300,
            # prose to match, green through every check in this file — run
            # against the real 1709x1255 capture and its real probe answer gives
            # REFUSE[crop_rect_outside], naming the iframe's lower edge at 1191.
            # So the walk does not ship a bad crop; it ships a recipe that FAILS
            # ON ITS NEXT LIVE RUN. That bound is pinned by F13 section 5b and by
            # mutants M171/M173.
            #
            # What this arm is for, stated at its real width: catching a recipe
            # whose recorded geometry and rect have drifted APART — a stale
            # re-shoot, a transposed digit, a rect edited without its record —
            # before someone burns a live run on it. That is worth having and it
            # is not a security boundary.
            #
            # 🔴 AND WHAT THE PROSE CHECK IS: a SECOND RECORD, not an independent
            # witness. Same file, same author, one line apart. It makes an
            # inconsistent edit visible; it does not make the key evidence.
            #
            # 🔴 COVERAGE LEDGER FOR THIS BLOCK, because "which mutant pins which
            # branch" was wrong once here and cost a round. Each entry was checked
            # by neutering ONLY that branch and confirming its mutant SURVIVES:
            #   premise (vp == FIX_WH) ............. M179
            #   prose cross-check .................. M177
            #   rect vs recorded bound ............. M174
            #   exactly-one-match rule ............. M178
            #   required-keys present .............. M180
            #   geometry is an object .............. M181
            #
            # 🔴 THIS LEDGER IS NOT A COMPLETENESS CLAIM, and the first draft of
            # it was — which is the defect it exists to prevent, committed inside
            # the comment written to prevent it. It names the branches that are
            # PINNED and says nothing about the rest. Unpinned, by category:
            #   - the `-?` sign allowance, which is on TWO of the three patterns
            #     (`viewport WxH` has none — a viewport cannot be negative).
            #     Genuinely not
            #     pinnable HERE, and measured rather than assumed: a mutant that
            #     writes `bottom gap=-64` into the prose dies to the prose
            #     cross-check while `-?` is present, and dies to the exactly-once
            #     branch when it is removed (`matched 0 time(s)` — the pattern
            #     needs a digit straight after `gap=`). No mutant can attribute to
            #     it, so it stays listed rather than faked.
            #   - the malformed-viewport/ints branch, the x-overrun check, and the
            #     two assertions on the fixture run's own result. Reachable,
            #     simply not pinned. Not a statement that they are unimportant — a
            #     statement that nobody has done it.
            #
            # 🔴 THAT CATEGORY USED TO CARRY `isinstance(geo, dict)` TOO, under a
            # justification that was FALSE: "pinning it needs a malformed-recipe
            # fixture this suite does not have". It needed one `sed` on a shipped
            # recipe — which is exactly how M180 was pinned, in the same commit
            # that wrote the excuse. It is M181 now. Beware the shape:
            # "unreachable" is a far stronger claim than "unpinned", and it is the
            # one that stops anyone trying.
            #
            # 🔴 AND RE-RUN THE ATTRIBUTION CHECK THE ISOLATED WAY, because the
            # crude way answers WRONG: neuter only a branch's `bad.append(...)`
            # and leave its `continue`. Deleting a whole `if …: … continue` block
            # removes control flow the code below depends on, so M180 then dies
            # with `KeyError: 'appFrameTop'` and the ledger line reads as broken
            # when it is correct. Isolate the mutation to the guard, never to the
            # guard plus its scaffolding.
            # If you add a mutant for one, add its line above.
            # 🔴 A TRIPWIRE, NOT A FEATURE — AND IT IS DELIBERATELY NOT AN
            # IMPLEMENTATION. The horizontal frame anchor (`xFrom` / `wFrom`,
            # 2026-09-02) exists in frame.py and is graded by F14, but NO shipped
            # recipe uses it: converting one needs a live capture against a
            # running app, which this session had no browser for. This arm would
            # be WRONG about such a recipe in two ways at once — its overrun
            # arithmetic reads `w` as a width (under `wFrom` it is a GAP from the
            # frame's right edge, so `x + w` is meaningless) and the probe answer
            # it synthesises below carries five numbers with no left inset, which
            # frame.py refuses by design. The failure would read as "this recipe's
            # rect is bad" when the rect is fine and the GATE is stale.
            #
            # Writing the real arithmetic instead was considered and rejected: it
            # could not be exercised by anything, because this arm reads the
            # shipped recipes directory and none is in that form — a speculative
            # branch nobody has watched run is exactly the guard that reads like
            # coverage while providing none. So it says so, loudly, and stops.
            # Mutant M207 is the pin: it converts a shipped recipe and requires
            # THIS sentence.
            horiz = [k for k in ("xFrom", "wFrom") if k in rect]
            if horiz:
                bad.append("%s: the rect carries %s — the HORIZONTAL frame anchor. This "
                           "ledger arm has NOT been taught it, and would be wrong about "
                           "it twice: `x + w` is not an overrun test when `w` is a gap, "
                           "and the five-number probe it synthesises has no left inset "
                           "for `xFrom` to resolve against. Teach this arm in the SAME "
                           "edit that converts the first recipe — the procedure is "
                           "`.claude/skills/app-capture/reference/cropping-and-attaching.md`"
                           % (slug, ", ".join(horiz)))
                continue
            geo = crop.get("_measuredGeometry")
            if not isinstance(geo, dict):
                # 🔴 BEFORE the key walk: `k not in geo` on a str is SUBSTRING
                # containment, so a string here computed a good message and then
                # died on .get() with a bare AttributeError naming no recipe and
                # no field — discarding the diagnosis it had just built AND
                # skipping every later P18 check.
                bad.append("%s: crop._measuredGeometry must be an object with "
                           "viewport / appFrameTop / appFrameBottomGap, got %r"
                           % (slug, geo))
                continue
            need = ("viewport", "appFrameTop", "appFrameBottomGap")
            missing = [k for k in need if k not in geo]
            vp = geo.get("viewport")
            ints = [k for k in ("appFrameTop", "appFrameBottomGap")
                    if k in geo and not isinstance(geo[k], int)]
            if missing:
                bad.append("%s: a frame-relative rect must record the LIVE geometry it "
                           "was chosen against — `crop._measuredGeometry` is missing %s. "
                           "The fixture is 59px taller than the real capture, so the "
                           "fixture arm below cannot see a rect that overruns the actual "
                           "iframe." % (slug, ", ".join(missing)))
                continue
            if (not isinstance(vp, list) or len(vp) != 2
                    or not all(isinstance(v, int) and v > 0 for v in vp) or ints):
                bad.append("%s: _measuredGeometry is malformed — viewport must be two "
                           "positive integers [w, h] (got %r) and appFrameTop / "
                           "appFrameBottomGap must be integers%s"
                           % (slug, vp, (" (bad: %s)" % ", ".join(ints)) if ints else ""))
                continue
            # the premise. FIX_WH is read from the fixture's own IHDR, not
            # hardcoded, so this cannot drift if the corpus is re-shot.
            if list(vp) == list(FIX_WH):
                bad.append("%s: _measuredGeometry records the FIXTURE's own dimensions "
                           "%dx%d as the live viewport. The record is what BOTH arms "
                           "bound the rect by — the canvas the frame.py arm runs on is "
                           "built at it — so a record grown to the fixture's 59-row-"
                           "taller shape buys a rect 59 rows it does not have live. If "
                           "the run GENUINELY reported %dx%d — possible, the fixtures "
                           "are themselves live captures and the difference from 1255 "
                           "is one browser toolbar row — then this refusal is a FALSE "
                           "ONE, and note that ADDING a fixture at that size does NOT "
                           "lift it: the comparison is against 5-mb-combinations.png's "
                           "dimensions specifically, so only re-shooting THAT would "
                           "change it. Refusing anyway, because the far commoner cause "
                           "is copying the fixture's numbers to make a rect fit."
                           % (slug, vp[0], vp[1], vp[0], vp[1]))
                continue
            # the second record, parsed from the SAME file. EXACTLY ONE match per
            # pattern: `re.search` takes the FIRST, so an appended re-shoot would
            # be silently ignored in favour of the stale block above it — and
            # these strings are accretive narratives, which is exactly the shape
            # that invites appending. `-?` because a NEGATIVE bottom gap (an
            # iframe taller than the viewport) is a real, handled case that the
            # doc documents and this pattern could not express.
            pats = (("viewport WxH", r"viewport (\d+)x(\d+)"),
                    ("app-frame top=N", r"app-frame top=(-?\d+)"),
                    ("bottom gap=N", r"bottom gap=(-?\d+)"))
            hits = {name: re.findall(rx, crop["_measured"]) for name, rx in pats}
            wrong = [n for n, h in hits.items() if len(h) != 1]
            if wrong:
                bad.append("%s: `crop._measured` must state the geometry EXACTLY ONCE in "
                           "the parseable form `viewport WxH`, `app-frame top=N`, "
                           "`bottom gap=N` — %s matched %s time(s). A second copy is not "
                           "harmless: only the FIRST is read, so an appended re-shoot "
                           "would be ignored in favour of the stale one."
                           % (slug, ", ".join(wrong),
                              "/".join(str(len(hits[n])) for n in wrong)))
            else:
                prose = ([int(hits["viewport WxH"][0][0]), int(hits["viewport WxH"][0][1])],
                         int(hits["app-frame top=N"][0]), int(hits["bottom gap=N"][0]))
                keyed = (vp, geo["appFrameTop"], geo["appFrameBottomGap"])
                if prose != keyed:
                    bad.append("%s: _measuredGeometry %r disagrees with the prose "
                               "measurement in _measured %r, in the same file — one "
                               "of them was edited to make a rect fit"
                               % (slug, keyed, prose))
            live_limit = vp[1] - max(0, geo["appFrameBottomGap"])
            end = geo["appFrameTop"] + rect["y"] + rect["h"]
            if end > live_limit:
                bad.append("%s: the rect ends at row %d on the geometry it records, "
                           "past the iframe's own lower edge at %d (viewport %dx%d, "
                           "bottom gap %d) — it would photograph page furniture "
                           "below the app"
                           % (slug, end, live_limit, vp[0], vp[1],
                              geo["appFrameBottomGap"]))
            if rect["x"] + rect["w"] > vp[0]:
                bad.append("%s: the rect ends at column %d, past the %dpx viewport "
                           "it records" % (slug, rect["x"] + rect["w"], vp[0]))
            # 🔴 frame.py comes from $RECIPES' OWN dir, never from the repo — the
            # mutation battery redirects $SCRIPTS to a copy, and a gate that
            # reached past it would grade the pristine module while claiming to
            # grade the mutant. (The comment at the top of this block is the same
            # lesson in the other direction, for $FIX.)
            # 🔴 THE CANVAS IS THE RECORDED VIEWPORT, NOT THE FIXTURE — CHANGED
            # 2026-09-02 AND IT IS A CORRECTION, NOT A CONCESSION. This arm used
            # to run against 5-mb-combinations.png (1709x1314) while telling
            # frame.py the probe had seen 1709x1314, because that is what
            # app_frame_scale demanded. But the rects were chosen at 1709x1255,
            # so the arm was exercising a pair that CANNOT occur live — the
            # block's own comment above admits it ("the fixture is not the
            # geometry", "the fixture arm alone would pass a rect that overruns
            # the real iframe"). frame.py's new viewport-of-record gate refuses
            # that pair outright, which is the gate working: a rect and a capture
            # from different windows is exactly what it exists to stop.
            #
            # So the canvas is synthesised AT the recorded viewport. What this
            # buys, beyond making the run possible: the iframe bound the run
            # computes is now the LIVE one (1255 - gap), not the fixture's looser
            # 1314 - gap, so a rect that overruns the real iframe now fails here
            # instead of only on the live run.
            #
            # 🔴 WHAT IT COSTS, STATED: a flat canvas carries no footer and no
            # right-edge furniture, and mkpng.py's docstring says not to use it
            # for the cropper for exactly that reason. That warning is about the
            # DETECT path, where content is what is being found. Nothing on the
            # DECLARED path reads a pixel's value except the background sample,
            # so the only fixture property this arm ever used was its DIMENSIONS.
            # Detection is still graded on the real captures, in F1-F9 and F13.
            canvas = os.path.join(WORK, "p18-canvas-%dx%d.png" % (vp[0], vp[1]))
            if not os.path.exists(canvas):
                mk = subprocess.run(["python3", MKPNG, canvas, str(vp[0]), str(vp[1])],
                                    capture_output=True, text=True)
                if mk.returncode != 0 or _png_wh(canvas) != (vp[0], vp[1]):
                    # the instrument, before its verdict: a canvas that is not the
                    # size asked for would make every refusal below meaningless.
                    bad.append("%s: could not build a %dx%d canvas to run the rect "
                               "against (%s) — this arm measured nothing"
                               % (slug, vp[0], vp[1], mk.stderr.strip()[:120]))
                    continue
            # 🔴 frame.py comes from $RECIPES' OWN dir, never from the repo — the
            # mutation battery redirects $SCRIPTS to a copy, and a gate that
            # reached past it would grade the pristine module while claiming to
            # grade the mutant. (The comment at the top of this block is the same
            # lesson in the other direction, for $FIX.)
            p = subprocess.run(
                ["python3", os.path.join(os.path.dirname(RECIPES), "frame.py"), "measure",
                 canvas,
                 "--recipe", os.path.join(RECIPES, "%s.json" % slug),
                 # 🔴 all three numbers come FROM the recipe's geometry key, with
                 # NO fallback — every path that could leave them unset has
                 # already `continue`d. A default here would be a second
                 # hardcoded copy, which is what this line was and what its own
                 # comment disowned.
                 "--app-frame-rect", "APPFRAME_RECT:%d,%d,-1,%d,%d"
                 % (geo["appFrameTop"], geo["appFrameBottomGap"], vp[0], vp[1])],
                capture_output=True, text=True)
            if p.returncode != 0:
                bad.append("%s: its shipped rect does not survive frame.py's own "
                           "structural gates on the %dx%d viewport it records: %s"
                           % (slug, vp[0], vp[1], p.stderr.strip()[:200]))
            else:
                box = json.loads(p.stdout)["box"]
                want_y = geo["appFrameTop"] + rect["y"]
                if box["y"] != want_y:
                    bad.append("%s: resolved y=%d, expected %d — the recipe's rect and "
                               "the anchor disagree" % (slug, box["y"], want_y))

# plan.py emits the key capture.sh branches on, and ONLY for the optional verb
p = subprocess.run(["python3", PLAN, os.path.join(RECIPES, "model-benchmarking.json"),
                    "--observed", OBS, "--state", "grid"], capture_output=True, text=True)
if p.returncode != 0:
    bad.append("model-benchmarking/grid did not plan: %s" % p.stderr[:120])
else:
    steps = json.loads(p.stdout)["steps"]
    opt = [s for s in steps if s.get("optional")]
    clicks = [s for s in steps if s["op"] == "click"]
    if len(opt) != 1:
        bad.append("%d optional step(s), expected exactly the how-to dismissal" % len(opt))
    elif "howto-dismiss" not in " ".join(opt[0]["argv"]):
        bad.append("the optional step is not the how-to dismissal: %s" % opt[0]["argv"])
    if len(clicks) != 2:
        bad.append("%d click ops, expected the dismissal plus the view switch" % len(clicks))
    if any(s.get("optional") for s in clicks if "howto-dismiss" not in " ".join(s["argv"])):
        bad.append("a REQUIRED click was marked optional — every selector miss in "
                   "this recipe would go silent")
    if opt and "--frame" not in opt[0]["argv"]:
        bad.append("the optional click is not frame-scoped")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
then
  pass "P18: model-benchmarking dismisses the how-to with \`clickIfPresent\` (its persistence makes the control present on a fresh profile and absent on a used one) and KEEPS the waitForGone that stops the next click racing the dismissal on a fresh one; its content veto is corrected but the Buzz caveat is not; EVERY shipped recipe is in the crop-form ledger and matches it (3 detect, 4 frame-relative WITH their measurements recorded AND their rects run against a canvas built at the viewport those measurements name — sensei included since 2026-08-27 — and NO shipped absolute); and exactly ONE planned step carries the \`optional\` key capture.sh branches on"
else
  fail "P18: a recipe-side fact drifted"
  sed 's/^/          /' "${WORK}/p18.txt" | head -12
fi

# ---------------------------------------------------------------------------
# O  attach-offsite.py — the transport policy (offline: no network, no credential)
# ---------------------------------------------------------------------------
echo
echo "-- O: attach-offsite.py transport policy"
if python3 "${FIX}/offsite-retry.py" "${SCRIPTS}" > "${WORK}/o1.txt" 2>&1; then
  pass "O1: attach-offsite.py bounds its own transport — an explicit \`HTTP_TIMEOUT\` (urlopen's default is None, i.e. block forever), a widening bounded backoff that still permits the MEASURED failure (three consecutive persistAssetImage failures, success on the fourth), no retry of a permanent 4xx, and a RETRYABLE_ROUTES ledger asserted WHOLE — it fails when the set grows as well as when it shrinks, because \`setIcon\`/\`setCover\`/\`submitListingRevision\` being re-sent is exactly how one timed-out upload becomes two attached assets"
else
  fail "O1: attach-offsite.py's transport policy drifted"
  sed 's/^/          /' "${WORK}/o1.txt" | head -12
fi

# O2 — the screenshot path refuses to mutate without --confirm, and its usage
# refusals are usage refusals (exit 2), not runtime failures. Offline: it never
# gets as far as the network because argparse rejects first.
AOFF="${SCRIPTS}/attach-offsite.py"
AOFFCFG="${WORK}/aoff-cfg.yaml"
printf 'token: "test-token-not-a-credential"\nbase_url: "https://example.invalid"\n' > "$AOFFCFG"
mk "${WORK}/oshot.png" 1200 778

rc=0; out="$(CIVITAI_CONFIG="$AOFFCFG" python3 "$AOFF" --app comfy --changelog x 2>&1)" || rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q 'screenshot'; then
  pass "O2 NEG: attach-offsite refuses an empty invocation with exit 2, and its message now names --screenshot alongside --icon/--cover"
else
  # Name WHICH half failed: at a ref with no screenshot path argparse also exits
  # 2 (unknown argument), so "rc=2, want 2" would read as a broken gate.
  o2why=""; [ "$rc" = 2 ] || o2why=" exit=$rc(want 2);"
  printf '%s' "$out" | grep -q 'screenshot' || o2why="${o2why} the refusal does not mention --screenshot (path absent?);"
  fail "O2: empty invocation did not refuse as a usage error —${o2why}"
  printf '%s\n' "$out" | sed 's/^/          /' | head -6
fi

rc=0; out="$(CIVITAI_CONFIG="$AOFFCFG" python3 "$AOFF" --app comfy --changelog x \
  --screenshot "${WORK}/oshot.png" --caption a --caption b 2>&1)" || rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -qi 'more --caption'; then
  pass "O3 NEG: more --caption than --screenshot is a usage error — the two lists are index-aligned, so a silent mis-pairing would caption the wrong image"
else
  o3why=""; [ "$rc" = 2 ] || o3why=" exit=$rc(want 2);"
  printf '%s' "$out" | grep -qi 'more --caption' || o3why="${o3why} no caption-pairing error (is --caption implemented?);"
  fail "O3: a caption/screenshot mis-pairing was not caught —${o3why}"
  printf '%s\n' "$out" | sed 's/^/          /' | head -6
fi

rc=0; out="$(CIVITAI_CONFIG="$AOFFCFG" python3 "$AOFF" --app comfy --changelog x \
  --screenshot "${WORK}/oshot.png" --caption "$(head -c 300 < /dev/zero | tr '\0' 'x')" 2>&1)" || rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q '280'; then
  pass "O4 NEG: an over-long caption is refused CLIENT-side against the server's 280-char limit, before anything is uploaded"
else
  o4why=""; [ "$rc" = 2 ] || o4why=" exit=$rc(want 2);"
  printf '%s' "$out" | grep -q '280' || o4why="${o4why} the refusal never names the 280-char server limit;"
  fail "O4: an over-long caption was not refused client-side —${o4why}"
  printf '%s\n' "$out" | sed 's/^/          /' | head -6
fi

# O5 POS control for O2-O4: a well-formed invocation gets PAST argparse. Without
# it, the three refusals above pass equally well against a script that rejects
# everything. It then fails at the network (example.invalid), which is the proof
# it got that far — and proof it did NOT mutate anything, since there is nothing
# to mutate at that host.
rc=0; out="$(CIVITAI_CONFIG="$AOFFCFG" python3 "$AOFF" --app comfy --changelog x \
  --screenshot "${WORK}/oshot.png" --caption "fine" 2>&1)" || rc=$?
if [ "$rc" != 2 ] && printf '%s' "$out" | grep -qi 'api/v1/apps\|HTTP 0'; then
  pass "O5 POS control for O2-O4: a well-formed screenshot invocation passes argparse and dies at the unreachable host, so the three refusals above are discriminating rather than blanket"
else
  o5why=""; [ "$rc" != 2 ] || o5why=" argparse REJECTED a valid invocation (exit 2);"
  printf '%s' "$out" | grep -qi 'api/v1/apps\|HTTP 0' || o5why="${o5why} it never reached the network;"
  fail "O5: a well-formed screenshot invocation did not get past argparse —${o5why}"
  printf '%s\n' "$out" | sed 's/^/          /' | head -6
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAILS" -eq 0 ]; then
  echo "=== ALL GATES PASSED ==="
  exit 0
fi
echo "=== ${FAILS} GATE(S) FAILED ==="
exit 1
