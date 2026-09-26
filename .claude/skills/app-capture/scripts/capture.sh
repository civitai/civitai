#!/usr/bin/env bash
# ============================================================================
# capture.sh — the IMPURE half. It executes what plan.py emits, and decides
# nothing. Every refusal, every guard and every constant lives in plan.py or
# frame.py, where .claude/skills/app-capture/tests/run-tests-app-capture.sh can watch them work.
#
#   capture.sh <recipe.json> [--instance work] [--out DIR] [--state NAME]
#              [--trusted] [--keep-tab] [--evidence] [--no-frame] [--no-render]
#              [--tab ID] [--no-foreground]
#
# 🔴 RETRACTED 2026-08-24 — this header used to open "A CAPTURE RUNS IN A
# FOREGROUND TAB, OR IT CAPTURES NOTHING", on a 2026-08-17 model-benchmarking
# run where a hidden tab deadlocked the BLOCK_INIT handshake 5/5. Re-measured:
# App Blocks boot hidden, 4/4, one with no `activate` at all. The 5/5 is
# unexplained and is not evidence for the requirement.
# 🔴 The HOST-SIDE RAISE is withheld here because every capture-path `activate`
# ASKS for it to be, with --no-focus, so the bridge answers `i3: "withheld"`.
# 🔴 CORRECTED 2026-08-28 — this file used to derive that from "this script never
# passes --focus", AND THAT DOES NOT FOLLOW. The bridge CLI resolves the flag as
# "on iff stdout is a TTY", so an omitted flag delegates the raise to how this
# script happened to be invoked. Measured against an instrumented endpoint, same
# argv: "focus":false through a command substitution, "focus":TRUE through a PTY.
# It held only because run_step runs every op inside `out="$(...)"` — an accident
# of stdio, in a different repo from the default that decides it, pinned by
# nothing. plan.py now DECLARES it (NO_FOCUS_ARG, guard code
# `activate_unconsented`), so no refactor of run_step can turn the raise on.
# 🔴 WITHHELD IS STILL NOT "INERT", and calling it inert is a mistake this file
# has already made: the extension still runs `chrome.tabs.update{active:true}`
# (the tab DOES become its window's active tab) AND
# `chrome.windows.update{focused:true}`, which NO flag covers. The steps are kept
# as the shipped design (ACTIVATE_REASONS / G11 / M59-M64); removing them is
# optional cleanup, not a fix.
# 🔴 TWO CLAIMS, TWO DOCS — cite the right one or the number is not there:
#   hidden boot 4/4  -> claudedocs/app-capture-hidden-tab-boot-2026-08-24.md
#   screenshot hang  -> claudedocs/app-capture-occlusion-refutation-2026-08-24.md
# (the claudedocs/... records below live in the PRIVATE infra repo, not here)
#   --keep-tab        leave the tab open when the run ends, so the app can be
#                     inspected by hand afterwards. Implied by --tab.
#   --no-render       measure and check the crops but skip the imagemagick
#                     render, so nothing is produced to attach. 🔴 It is NOT a
#                     quieter --no-frame: the crop still runs, so exits 5, 6 and
#                     9 remain reachable and only 7 and 8 are skipped. Use it to
#                     test a recipe's geometry where imagemagick is unavailable.
#   --tab ID          drive an EXISTING tab (one the operator already has in
#                     front) instead of opening one. Implies --keep-tab: a tab
#                     this script did not open is never closed by it.
#   --no-foreground   skip the foregrounding step. 🔴 NOT cosmetic: the i3 window
#                     raise is withheld anyway (--no-focus), but `activate` also makes the tab
#                     its window's ACTIVE tab, and an ACTIVE tab is what takes the
#                     captureVisibleTab path. 🔴 ONLY ON THE TAB-OPENING PATH —
#                     `open` creates tabs with active:false, but a --tab the
#                     operator already has in front is ALREADY active, so
#                     `--tab --no-foreground` still takes captureVisibleTab.
#                     On the opening path, omitting it leaves the tab in the
#                     background, which takes CDP instead (measured 3/3, identical
#                     geometry). ⚠️ That was a WORKAROUND for the exit-12 hang and it
#                     was NOT what shipped — the hang was fixed at source in the
#                     bridge (FAST_CAPTURE_BUDGET_MS, devrc #797). Do not reach for
#                     this flag as a cure; check the RUNNING build first. n=3,
#                     indicative.
#

# --evidence adds the MACHINE-ANALYSABLE half: per state it writes
#   <state>.dom.json  (the app frame's raw outerHTML, uncapped)
#   <state>.dom.html  (the same DOM pretty-printed, for reading and for diffing)
#   <state>.probe.json(the drained observer probe: console + network + hook status)
#   <state>.evidence.json (the artifact — console, failed requests, a11y, testids)
# and prints a short human summary. It adds NO spend path: the probe observes and
# plan.py refuses to inject one that can actuate. --no-frame skips the crop/
# measure/render pipeline, for a defect run that is not shooting store art.
#
# 🔴 capture NEVER SPENDS. The spend path exists only behind --trusted, and
# plan.py is what refuses without it.
#
# 🔴 THIS SCRIPT DOES EMIT BRIDGE OPS OF ITS OWN — the older "every op it runs
# came out of a plan" here was FALSE, and an auditor who checked it lost the
# thread on the rest. What is true is narrower and still sufficient:
#   * LIFECYCLE + OBSERVE, unplanned by necessity (a plan is built FROM the
#     observation): `whoami`, `open`, `close`, `text`, `frames`, and the `nav` +
#     `wake` pair in `reload_app` that starts every state from a fresh load.
#     None of them addresses the app's document and none can actuate.
#   * ONE DOM op: the top-frame app-frame rect probe below. It is deliberately
#     NOT frame-scoped (the <iframe> element lives in the host page) and it is
#     refused by frame.py's `guard_rect_js`, not by plan.py.
#   * EVERYTHING ELSE — every op that touches the app's own document — comes out
#     of a plan, the foregrounding one included, and is refused by plan.py:
#     `guard_no_actuation` (no xdotool / --clearmodifiers without --trusted) and
#     `guard_dom_scoping` (a DOM op with no --frame, which would take the
#     bridge's CDP Input path and deliver a TRUSTED event).
# So there are TWO refusers, in two files, and neither covers the other's ops.
#
# 🔴 FOREGROUNDING IS NOT SPENDING, and the two are guarded SEPARATELY. Bringing
# a window to the front cannot fire a billable action; an OS-level keypress
# delivered to a focused control can. plan.py refuses ANY step carrying an
# actuation token (xdotool / --clearmodifiers) in a plan built without --trusted
# — a check that is deliberately blind to the foregrounding op, so neither guard
# can be satisfied by the other.
#
# Requires: the browser bridge, python3 (stdlib only), and — for --render —
# imagemagick. On NixOS: nix-shell -p imagemagick --run '...'
# ============================================================================
set -uo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BB="${APP_CAPTURE_BB:-$HOME/workspace/devrc/scripts/browser-bridge/browser}"
PLAN="${APP_CAPTURE_PLAN:-$HERE/plan.py}"
FRAME="${APP_CAPTURE_FRAME:-$HERE/frame.py}"
EVIDENCE_PY="${APP_CAPTURE_EVIDENCE:-$HERE/evidence.py}"

RECIPE=""; INSTANCE="work"; OUT=""; ONLY_STATE=""; TRUSTED=0; KEEP_TAB=0; RENDER=1
EVIDENCE=0; DO_FRAME=1; FOREGROUND=1; TAB=""; ATTACHED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) INSTANCE="$2"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    --state)    ONLY_STATE="$2"; shift 2 ;;
    --tab)      TAB="$2"; ATTACHED=1; KEEP_TAB=1; shift 2 ;;
    --trusted)  TRUSTED=1; shift ;;
    --keep-tab) KEEP_TAB=1; shift ;;
    --evidence) EVIDENCE=1; shift ;;
    --no-frame) DO_FRAME=0; RENDER=0; shift ;;
    --no-foreground) FOREGROUND=0; shift ;;
    --no-render) RENDER=0; shift ;;
    # 🔴 BOUNDED BY A SENTINEL, NOT A LINE NUMBER — the header's own closing
    # `# ====` rule. The line-number form silently TRUNCATED --help every time
    # the header grew, and it had already done so twice: once mid-sentence on
    # "...the exit-12 hang and it", and again at `2,45p`, which cut the entire
    # --evidence output-format block out of the help for a headline feature.
    # Line 2 is the OPENING rule and is the range's start, so sed looks for the
    # end match from line 3 on and stops at the closing rule. Nothing to move.
    -h|--help)  sed -n '2,/^# =\{20,\}$/p' "$0"; exit 0 ;;
    -*)         echo "unknown flag $1" >&2; exit 2 ;;
    *)          RECIPE="$1"; shift ;;
  esac
done
[ -n "$RECIPE" ] || { echo "usage: capture.sh <recipe.json> [--instance K] [--out DIR]" >&2; exit 2; }
[ -f "$RECIPE" ] || { echo "no such recipe: $RECIPE" >&2; exit 2; }
[ -x "$BB" ] || { echo "browser bridge not found or not executable: $BB" >&2; exit 3; }
OUT="${OUT:-$(mktemp -d -t app-capture-XXXX)}"
mkdir -p "$OUT"

SLUG="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["slug"])' "$RECIPE")"
# 🔴 DOES THIS RECIPE DERIVE ITS TOP BAND FROM THE APP IFRAME? `apps/run/<slug>`
# carries a CONDITIONAL rewards banner above the iframe, so a fixed `chromeTop`
# is not merely imprecise, it is unsatisfiable: the banner-absent and
# banner-present layouts need values whose valid ranges do not overlap (measured
# — .claude/skills/app-capture/tests/run-tests-app-capture.sh F11 sweeps both and finds an EMPTY
# intersection). frame.py owns the JS and the arithmetic; this script only runs
# the probe and hands the answer over.
USE_APPFRAME="$(python3 -c 'import json,sys;print("1" if (json.load(open(sys.argv[1])).get("crop") or {}).get("fromAppFrame") else "")' "$RECIPE")"
URL="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("url","https://civitai.com/apps/run/"+json.load(open(sys.argv[1]))["slug"]))' "$RECIPE")"

echo "=== app-capture: $SLUG ==="
echo "    recipe : $RECIPE"
echo "    out    : $OUT"
echo "    trusted: $([ "$TRUSTED" = 1 ] && echo 'YES — THIS WILL SPEND AND TAKE THE SCREEN' || echo 'no (spend path unreachable)')"
echo "    screen : $([ "$FOREGROUND" = 1 ] && echo 'the capture tab is made its window ACTIVE tab; the i3 WINDOW raise is a separate half — read the i3= line each step reports' || echo '--no-foreground: the tab stays in the BACKGROUND, so captures take the CDP path')"

# --- orient. Both hosts may share a hostname; confirm which bridge this is. ---
"$BB" whoami >"$OUT/whoami.json" 2>&1 || { echo "bridge whoami failed:"; cat "$OUT/whoami.json"; exit 3; }

if [ "$ATTACHED" = 1 ]; then
  # A tab the OPERATOR opened. It is theirs: never closed, and the app may
  # already be past its boot, which is the cheapest way to get a foreground tab.
  echo "    tab    : $TAB (attached — not opened by this run, and never closed by it)"
else
  TAB="$("$BB" --instance "$INSTANCE" open "$URL" --wake=4000 \
         | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("result",d).get("data",{}).get("tabId",""))')"
  [ -n "$TAB" ] || { echo "could not open a tab" >&2; exit 3; }
  echo "    tab    : $TAB"
fi
cleanup() { [ "$KEEP_TAB" = 1 ] || "$BB" --instance "$INSTANCE" --tab "$TAB" close >/dev/null 2>&1; }
trap cleanup EXIT

# --- observe: top-frame text + the frame list. Re-observed before EVERY state,
#     because the app frame id changes on every load and must never be cached. --
observe() {
  local txt frames
  txt="$("$BB" --instance "$INSTANCE" --tab "$TAB" text --max-bytes 8000 2>/dev/null)"
  frames="$("$BB" --instance "$INSTANCE" --tab "$TAB" frames 2>/dev/null)"
  python3 -c '
import json,sys
txt_raw, fr_raw, inst, tab = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def data(s):
    try: d=json.loads(s)
    except Exception: return {}
    return (d.get("result") or d).get("data") or {}
t=data(txt_raw); f=data(fr_raw)
print(json.dumps({"instance":inst,"tabId":tab,
  "topText": t.get("text") or t.get("innerText") or "",
  "frames": f.get("frames") or []}))' "$txt" "$frames" "$INSTANCE" "$TAB"
}

# --- poll for the app frame: apps boot slowly, the frame does not exist yet ---
await_frame() {
  local try
  for try in 1 2 3 4 5 6 7 8; do
    observe > "$OUT/observed.json"
    if python3 -c '
import json,sys
o=json.load(open(sys.argv[1])); r=json.load(open(sys.argv[2]))
want=r["frameHost"].lower()
def host(u): return u.split("://",1)[-1].split("/",1)[0].split("@")[-1].split(":")[0].lower()
sys.exit(0 if any(host(f.get("url",""))==want for f in o["frames"]) else 1)' \
       "$OUT/observed.json" "$RECIPE"; then return 0; fi
    echo "    ...app frame not up yet (try $try/8)"
    "$BB" --instance "$INSTANCE" --tab "$TAB" wake --wait 2000 >/dev/null 2>&1
  done
  return 1
}

# 🔴 EVERY STATE STARTS FROM A FRESH LOAD. A recipe's actions are written against
# the app's INITIAL screen, so running states back-to-back in one tab leaves each
# one standing wherever the previous one finished — and its clicks then miss.
# Measured on the first two live runs of custom-generators: without this reload,
# `mine` clicked #tab-mine while the app was still inside the legoify generator
# (no such tab there), so it captured the generator screen and came back with a
# box identical to `generator`. The identical-box gate caught it both times, which
# is the whole argument for that gate.
#
# The reload also re-derives the frame id, which CHANGES on every load — observed
# 844 -> 845 across one reload during this same run.
reload_app() {
  "$BB" --instance "$INSTANCE" --tab "$TAB" nav "$URL" --wake=4000 >/dev/null 2>&1
  await_frame || { echo "    app frame never appeared after reload"; return 1; }
}

STATES="$(python3 -c 'import json,sys;print("\n".join(s["name"] for s in json.load(open(sys.argv[1]))["states"]))' "$RECIPE")"
[ -n "$ONLY_STATE" ] && STATES="$ONLY_STATE"

# 🔴 run_step MUST NOT BE CALLED IN A COMMAND SUBSTITUTION. It publishes the
# step's output in the global STEP_OUT and, for a step carrying `captureVar`,
# assigns that variable in THIS shell — the trusted path's PREV_WINDOW depends on
# it surviving to a later step. `out="$(run_step ...)"` runs the body in a
# subshell, so the assignment would be discarded and the restore step would hand
# xdotool a window id of 0. (The mutation battery's M18 is the lock on the plan
# side of this wiring.)
STEP_OUT=""
run_step() {   # run_step <step-json>   ; output in $STEP_OUT
  local op argv expect absent timeout capvar ready
  STEP_OUT=""
  op="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["op"])' "$1")"
  case "$op" in
    sleep)
      python3 -c 'import json,sys,time;time.sleep(json.loads(sys.argv[1])["ms"]/1000.0)' "$1"; return 0 ;;
    reobserve)
      echo "      RE-OBSERVE required (nav invalidated the frame id) — stopping this plan"; return 9 ;;
  esac
  mapfile -t argv < <(python3 -c 'import json,sys;[print(a) for a in json.loads(sys.argv[1])["argv"]]' "$1")
  [ "${argv[0]}" = "browser" ] && argv[0]="$BB"
  expect="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("expect",""))' "$1")"
  absent="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("expectAbsent",""))' "$1")"
  timeout="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("timeoutMs",0))' "$1")"
  capvar="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("captureVar",""))' "$1")"
  ready="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("appReady",""))' "$1")"
  local optional
  optional="$(python3 -c 'import json,sys;print("1" if json.loads(sys.argv[1]).get("optional") else "")' "$1")"
  local vfg
  vfg="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("verifyForeground",""))' "$1")"

  # $PREV_WINDOW substitution for the trusted restore step
  local i; for i in "${!argv[@]}"; do
    [ "${argv[$i]}" = "\$PREV_WINDOW" ] && argv[$i]="${PREV_WINDOW:-0}"
  done

  local out oprc deadline=$(( $(date +%s%3N) + ${timeout:-0} ))
  while :; do
    # 🔴 READ THE OP'S EXIT STATUS. `out="$(...)"` throws away `$?`, and the bridge
    # CLI `die`s (exit 1) on EVERY op error — not just the one string this used to
    # look for. See the block after the loop.
    out="$("${argv[@]}" 2>&1)"; oprc=$?
    if [ -n "$expect" ]; then
      case "$out" in *"$expect"*) break ;; esac
    elif [ -n "$absent" ]; then
      case "$out" in *"$absent"*) : ;; *) break ;; esac
    else
      break
    fi
    if [ "$(date +%s%3N)" -ge "$deadline" ]; then
      # 🔴 TWO DIFFERENT FAILURES, TWO DIFFERENT SENTENCES. A timed-out APP-READY
      # gate means the app never finished booting; a timed-out anything-else means
      # the action did not do what the recipe expects. Reported identically, the
      # first reads as the second — that is exactly how a hidden-tab deadlock was
      # read as a broken dismiss button on the first live --evidence run.
      if [ -n "$ready" ]; then
        echo "      APP NEVER BOOTED — the app-ready gate timed out after ${timeout}ms."
        echo "        gate      : $ready"
        echo "        last read : ${out:0:160}"
        # 🔴 TWO CAUSES, ONE EXIT CODE, AND UNTIL 2026-08-18 ONE MESSAGE. The
        # timeout read APPBOOT_ABSENT whether the tab was hidden or the anchor
        # was simply wrong, which is byte-identical to the report for a ready
        # anchor that does not exist. Two live diagnosis runs died on that
        # ambiguity and concluded nothing. (Hidden is a TIE-BREAK, not a verdict:
        # App Blocks DO boot hidden, 4/4.) The probe now answers about VISIBILITY
        # first, and the bridge's own "tab is hidden" advice is the second,
        # independent tell — so this branch names the CONFOUND instead of
        # implicating the recipe.
        case "$out" in
          *APPBOOT_HIDDEN*|*"tab is hidden"*)
            echo "        🔴 CONFOUND — NOT A VERDICT ON THE ANCHOR. The last read says the"
            echo "        anchor was ABSENT *and* the tab was NOT VISIBLE (visibilityState !="
            echo "        'visible', and/or the bridge's own 'tab is hidden' advice). Either"
            echo "        alone would not say this: an app that renders its anchor is believed"
            echo "        whatever the tab reports. Foregrounding raises the"
            echo "        tab INSIDE Brave; raising the operator's i3 WORKSPACE is a host-side"
            echo "        best effort that can silently not happen when the Brave window is"
            echo "        parked on another workspace. That does NOT by itself stop the app"
            echo "        booting (App Blocks boot hidden, 4/4) — but this gate timed out and"
            echo "        the anchor is UNPROVEN here, not disproven."
            echo "        Fix the tab, then re-run — but do NOT drive i3 yourself. This run"
            echo "        already performs the host-side raise on every foreground step;"
            echo "        \`i3-msg\` by hand only takes the operator's screen a second time."
            echo "        (Measured 2026-08-19: a subagent 'helping' this way issued 42"
            echo "        i3-msg calls and 14 workspace switches in one run and restored"
            echo "        nothing. This skill contains no i3-msg invocation at all.)"
            echo "        Why move it at all, if App Blocks boot hidden? Because this removes"
            echo "        the ATTRIBUTION confound, not a boot cause: with the tab visible,"
            echo "        an ABSENT anchor CAN implicate the anchor — it does not prove it"
            echo "        (a still-LOADING frame is the other visible-tab case, below)."
            echo "        Either move the Brave window ONCE to the workspace the operator"
            echo "        is already on and LEAVE it there:"
            echo "          i3-msg '[class=\"Brave-browser\"] move container to workspace current'"
            echo "        or pass --tab <id> of a tab already in front."
            echo "        Then re-read the run's \`i3=\` line above — NOTE: under"
            echo "        --no-foreground no foreground step runs, so there is no such line."
            ;;
          *APPBOOT_LOADING*)
            echo "        The app frame is still rendering its LOADING shell, so the frame"
            echo "        exists: the app is booting slowly or is deadlocked on BLOCK_INIT."
            echo "        Raise \`ready.timeoutMs\` only after confirming the app is slow rather"
            echo "        than wedged — a frame stuck on BLOCK_INIT is a deadlock no timeout can"
            echo "        outlast. (Window visibility is NOT the discriminator: App Blocks boot"
            echo "        hidden, 4/4.)"
            ;;
          *)
            echo "        The tab reported VISIBLE and the frame rendered NEITHER the loading shell"
            echo "        NOR the anchor. THIS is the read that can implicate the anchor: check"
            echo "        the recipe's \`ready\` testid still exists in the booted app. Note the"
            echo "        anchor must be something only the BOOTED app renders — these apps"
            echo "        ship an empty <div id=\"root\"> shell, so a static-shell selector"
            echo "        would pass before boot and hand a spinner to the actions."
            ;;
        esac
        echo "        No recipe action has run yet, so this is NOT a broken control."
        return 11
      fi
      echo "      TIMEOUT waiting for ${expect:-absence of $absent}"
      return 1
    fi
    sleep 0.5
  done
  # 🔴 A FAILED OP USED TO BE SWALLOWED IN SILENCE, AND THE FIRST FIX FOR IT WAS
  # TOO NARROW. A step with no `expect`/`expectAbsent` gets exactly ONE shot, so
  # the poll loop breaks on the first read whatever the bridge said — and the
  # command substitution above threw away `$?`. A recipe whose selector had
  # drifted therefore ran a step that did nothing, captured the WRONG screen and
  # reported success; only the identical-box gate could catch that, and only when
  # two states happened to collide.
  #
  # 🔴 THE STATUS, NOT A STRING. The first version of this branch matched
  # `*element_not_found*` — which closed one error and left the class open one
  # word over. Measured: a `click` answered with `op_timeout:click` (the bridge's
  # generic `die "op '%s' failed in the browser"`, exit 1 — the SAME shape that
  # `op_timeout:screenshot` already has its own branch for further down) ran
  # green, wrote its evidence artifact and said nothing. It also made a
  # cross-repo error STRING load-bearing in this file, so a rename over there
  # would silently restore the whole defect. `oprc` is the general form and it
  # subsumes the string.
  #
  # 🔴 POLLING STEPS ARE DELIBERATELY EXEMPT. A `waitForText`/`waitForGone` is
  # BUILT to tolerate a read that is not true yet, and it has its own deadline
  # and its own sentence. Only a one-shot step has nothing else to go on.
  #
  # 🔴 TWO KINDS OF STEP KEEP THEIR OWN CODE, because this skill's whole failure
  # design is "one failure, one exit code, one sentence" and a generic exit 4
  # here would flatten two of them:
  #   the screenshot            falls through to the no-path check below -> exit
  #                             12, which names the BRIDGE and the stale-build
  #                             capture hang rather than the recipe.
  #   a foreground-verified step (`$vfg`) is handled by the block right below this
  #                             one, which owns exit 13 -> the host-side window
  #                             raise. 🔴 KEYED ON THE STEP'S OWN MARKER, not on
  #                             the op's NAME: plan.py sets `verifyForeground` on
  #                             exactly the steps that raise the window, so this
  #                             reads the structural signal instead of spelling an
  #                             op that D7 forbids this file from naming — and it
  #                             cannot drift out of step with plan.py the way a
  #                             hardcoded name could.
  if [ -z "$expect" ] && [ -z "$absent" ] && [ -z "$vfg" ] && [ "$oprc" != 0 ]; then
    case "$op" in
      screenshot) : ;;   # the caller's no-path check owns this one (exit 12)
      *)
        # 🔴 `optional` NARROWS, IT DOES NOT SWALLOW — and it is the one place the
        # error string is still read, deliberately in the SAFE direction.
        # `clickIfPresent` declares that the element may be ABSENT (see
        # model-benchmarking: the how-to dismissal persists, so the control exists
        # on a fresh profile and not on a used one). It does not declare that any
        # failure is fine. So absence is tolerated by name, and every other error
        # still fails — which means a rename of `element_not_found` upstream turns
        # an optional step LOUD, never silent. That is the direction to fail in,
        # and it is why the general check above does not depend on the string.
        if [ -n "$optional" ]; then
          case "$out" in
            *element_not_found*)
              echo "      (optional: the element is absent — step skipped, which is a"
              echo "       supported outcome for this action, not a failure)"
              STEP_OUT="$out"; return 0 ;;
          esac
          echo "      AN OPTIONAL STEP FAILED FOR A REASON THAT IS NOT ABSENCE (exit $oprc)."
          echo "        \`clickIfPresent\` declares that the element may not be there. It"
          echo "        does not declare that any failure is acceptable, so this is NOT"
          echo "        skipped. If the bridge has renamed its element-not-found error,"
          echo "        this is what that looks like — fix it here rather than widening"
          echo "        the tolerance."
          echo "        last read : ${out:0:160}"
          return 1
        fi
        echo "      THE BRIDGE OP FAILED — \`$op\` exited $oprc."
        case "$out" in
          # quoted so this pattern is textually distinct from the tolerance one
          # above it: they are otherwise identical strings at different indents,
          # and the mutation battery matches a target by literal SUBSTRING, so an
          # indistinguishable pair cannot be mutated separately (one target, two
          # hits -> BROKEN, which measures nothing).
          *"element_not_found"*)
            echo "        THE SELECTOR MATCHED NOTHING. This is a RECIPE failure, not an"
            echo "        app failure: the app-ready gate already passed, so the app is"
            echo "        booted and this selector is stale. If the element is legitimately"
            echo "        absent on some profiles (a dismissed intro panel, an"
            echo "        already-accepted consent), say so in the recipe with"
            echo "        \`clickIfPresent\` instead of \`click\` — silence is not the same"
            echo "        claim." ;;
          *)
            echo "        The step ran once and the bridge refused it. A one-shot step has"
            echo "        no second reading to fall back on, so this is where it stops." ;;
        esac
        echo "        last read : ${out:0:160}"
        return 1 ;;
    esac
  fi
  STEP_OUT="$out"
  # 🔴 READ THE BRIDGE'S OWN ANSWER ABOUT THE WINDOW. `activate` returns
  # i3=applied|skipped|failed: `applied` means i3-msg ran and exited 0, `skipped`
  # means the host has no i3/DISPLAY, `failed` means the raise ERRORED. Until
  # 2026-08-18 nothing read this field, so a run whose window was never raised
  # went on to deadlock and be misread as a bad ready anchor. `applied` is
  # necessary and NOT sufficient — the visibility token in the ready gate is the
  # authority — so this reports the pair rather than trusting either alone.
  if [ -n "$vfg" ]; then
    # 🔴 THE OP CAN FAIL OUTRIGHT, NOT ONLY REPORT A FAILED RAISE. Until the
    # status was read at all, this block could only see the i3 FIELD — so a bridge
    # that died on the raise left `i3state` unreadable, printed the soft "!!" note
    # and carried on into a deadlock that surfaced later as someone else's fault.
    # A dead op is at least as strong a statement as `i3: failed`, so it reaches
    # the same code and the same sentence.
    if [ "$oprc" != 0 ]; then
      echo "      🔴 THE WINDOW WAS NOT RAISED — the bridge FAILED the op (exit $oprc)."
      echo "        Not a recipe failure and not an app failure: the bridge could not carry"
      echo "        out a step this run declared, so the run's own preconditions are unmet"
      echo "        and nothing after this is attributable. Stopping HERE rather than"
      echo "        producing a run whose every later failure would be misattributed"
      echo "        to the recipe."
      echo "        last read : ${out:0:160}"
      return 13
    fi
    local i3state
    i3state="$(printf '%s' "$out" | python3 -c '
import json,sys
s=sys.stdin.read(); b=s.find("{")
try: d=json.loads(s[b:]) if b>=0 else {}
except Exception: d={}
inner=(d.get("result") or d)
data=inner.get("data") if isinstance(inner,dict) else None
print((data or {}).get("i3","(absent)"))' 2>/dev/null)"
    echo "      foreground: i3=${i3state:-(unreadable)}"
    if [ "$i3state" = "failed" ]; then
      echo "      🔴 THE WINDOW WAS NOT RAISED — the bridge ran i3-msg and it FAILED."
      echo "        The tab is foregrounded inside Brave but the operator's window/workspace"
      echo "        is not. A step this run declared did not happen, so its preconditions are"
      echo "        unmet. Stopping HERE rather than producing a run whose every failure would"
      echo "        be misattributed to the recipe."
      return 13
    fi
    if [ "$i3state" != "applied" ]; then
      echo "      !! the host-side window raise reported '${i3state}', not 'applied' — if this"
      echo "         box runs i3, the capture tab may not really be in front. The app-ready"
      echo "         gate's visibility token is what settles it."
    fi
  fi
  if [ -n "$capvar" ]; then
    printf -v "$capvar" '%s' "$(printf '%s' "$out" | tr -d '\n')"
    echo "      recorded ${capvar}=$(eval "printf '%s' \"\${$capvar}\"")"
  fi
  return 0
}

# run_plan_file <plan.json> — run every step of a plan, in order. Never in a
# command substitution (see run_step's note).
run_plan_file() {
  local pf="$1" n i step note rc
  n="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["steps"]))' "$pf")"
  for i in $(seq 0 $((n - 1))); do
    step="$(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1]))["steps"][int(sys.argv[2])]))' "$pf" "$i")"
    note="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["note"])' "$step")"
    echo "     [f$i] $note"
    run_step "$step"; rc=$?
    [ "$rc" = 0 ] || return "$rc"
  done
  return 0
}

# The foregrounding plan. 🔴 Its premise is RETRACTED (see the header): App
# Blocks boot hidden. The i3 WINDOW raise is withheld because the step asks for
# that with --no-focus, but this
# is NOT a no-op — the tab is still made its window's ACTIVE tab, which is what
# routes captures onto the captureVisibleTab path. It still comes out of a
# plan like everything else: the FOREGROUNDING op is not one of the handful this
# script emits itself, plan.py decides what a foreground plan contains, and it
# refuses to put an actuation step in one.
foreground_tab() {
  [ "$FOREGROUND" = 1 ] || { echo "    --no-foreground: skipping the foreground step — the tab stays BACKGROUND, so captures take the CDP path"; return 0; }
  observe > "$OUT/observed.json"
  if ! python3 "$PLAN" "$RECIPE" --observed "$OUT/observed.json" --foreground-plan \
       > "$OUT/plan-foreground.json"; then
    echo "    foreground plan refused — see the REFUSE line above."; return 1
  fi
  python3 -c 'import json,sys;[print("    !! "+w) for w in json.load(open(sys.argv[1])).get("warnings",[])]' \
    "$OUT/plan-foreground.json"
  run_plan_file "$OUT/plan-foreground.json"
}

foreground_tab; fg_rc=$?
# 13 = the host-side window raise FAILED. It is not a planning refusal (3): the
# plan was fine and the bridge answered honestly, so it keeps its own code rather
# than being flattened into one that reads as "plan.py refused".
[ "$fg_rc" = 13 ] && exit 13
[ "$fg_rc" = 0 ] || exit 3
await_frame || echo "    (continuing — plan.py will refuse if the frame really is absent)"

MEASURES="[]"
declare -a RENDERS=()
declare -a ARTIFACTS=()
first_state=1
for st in $STATES; do
  echo "  -- state: $st"
  # fresh load per state (see reload_app above); the first state already landed
  # on a fresh page from `open`.
  if [ "$first_state" = 1 ]; then first_state=0; else reload_app || exit 3; fi
  observe > "$OUT/observed.json"
  PLANF="$OUT/plan-$st.json"
  # 🔴 --no-frame + --evidence MEANS THE PICTURE IS DISCARDED, SO DO NOT TAKE ONE.
  # plan.py used to emit the screenshot unconditionally and read the DOM and drain
  # the probe AFTER it, so a bridge-side screenshot failure destroyed the evidence
  # of a run that had already succeeded — and reported it as a failing recipe
  # ACTION. plan.py knew nothing about --no-frame; now it is told.
  if ! python3 "$PLAN" "$RECIPE" --observed "$OUT/observed.json" --state "$st" \
        $([ "$TRUSTED" = 1 ] && echo --trusted) \
        $([ "$EVIDENCE" = 1 ] && echo --evidence) \
        $([ "$EVIDENCE" = 1 ] && [ "$DO_FRAME" = 0 ] && echo --no-screenshot) \
        $([ "$FOREGROUND" = 0 ] && echo --no-foreground) > "$PLANF"; then
    echo "     plan refused — see the REFUSE line above. Not capturing this state."
    exit 2
  fi
  nsteps="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["steps"]))' "$PLANF")"
  shot=""
  for i in $(seq 0 $((nsteps - 1))); do
    step="$(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1]))["steps"][int(sys.argv[2])]))' "$PLANF" "$i")"
    note="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["note"])' "$step")"
    echo "     [$i] $note"
    run_step "$step"; step_rc=$?
    [ "$step_rc" = 9 ] && { echo "     (re-observe sentinel: this state needs another pass)"; break; }
    [ "$step_rc" = 11 ] && { echo "     THE APP NEVER BOOTED for state '$st' — nothing captured, and no recipe action ran. Not an action failure."; exit 11; }
    [ "$step_rc" = 13 ] && { echo "     THE CAPTURE TAB COULD NOT BE PUT IN FRONT for state '$st' — the bridge's own window raise failed. Not a recipe failure and not an app failure."; exit 13; }
    [ "$step_rc" = 0 ] || { echo "     THE ACTION FAILED for state '$st' (the app-ready gate had already passed, so the app WAS booted — this is the step above, not app boot)."; exit 4; }
    out="$STEP_OUT"
    cap="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("capture",""))' "$step")"
    if [ -n "$cap" ]; then
      shot="$(printf '%s' "$out" | python3 -c '
import json,sys
s=sys.stdin.read(); b=s.find("{")
try: d=json.loads(s[b:]) if b>=0 else {}
except Exception: d={}
print((d.get("result") or d).get("data",{}).get("path") or d.get("path",""))' 2>/dev/null)"
      # 🔴 A SCREENSHOT THAT COMES BACK WITHOUT A PATH IS A BRIDGE FAILURE, AND IT
      # USED TO EXIT 4 — the code that says "THE ACTION FAILED ... the app WAS
      # booted", i.e. it blamed the recipe's action for something the recipe never
      # touched. It killed two live runs. So it keeps its own code and names the
      # BRIDGE.
      # 🔴 THE REMEDIATION WAS REWRITTEN 2026-08-24. It used to name OCCLUSION and
      # send the operator to un-cover the window. That mechanism is RETRACTED: the
      # hang reproduced with the window on a non-visible workspace and NOTHING
      # drawn on top, 20 minutes after the same window/tab captured 3/3. The real
      # cause is an unbounded fast path, and it is fixed in the BRIDGE — so the
      # only useful thing to tell the operator is which BUILD is running.
      if [ -z "$shot" ]; then
        echo "     THE SCREENSHOT BRIDGE OP FAILED for state '$st' — it returned no path."
        echo "       last read : ${out:0:200}"
        case "$out" in
          *op_timeout*)
            echo "       This is a STALE BRIDGE BUILD, not a recipe failure."
            echo "       chrome.tabs.captureVisibleTab can HANG rather than reject, so the fast"
            echo "       path's catch — whose job is to fall through to CDP — never ran, and the"
            echo "       op burned the whole 18s EXEC_OP_BUDGET_MS on a tab CDP captures in under"
            echo "       a second. The tell is the ceiling: timeouts pin at 18.1s, and one arm"
            echo "       RETURNED via captureVisibleTab at 17.97s — a near-miss and a timeout are"
            echo "       the same phenomenon. Fixed by bounding the fast path at 1500ms"
            echo "       (FAST_CAPTURE_BUDGET_MS, devrc #797)."
            echo "       🔴 OCCLUSION IS NOT REQUIRED and FOCUS IS NOT THE VARIABLE. It"
            echo "       reproduces with the window on a non-visible workspace and NOTHING"
            echo "       drawn on top, and a window VISIBLE but UNFOCUSED captured 6/6 in"
            echo "       192-306ms. So moving the pointer or clicking to focus changes"
            echo "       nothing, and un-covering the window is not the fix."
            echo "       ⚠️ NOT ESTABLISHED: whether a GENUINELY OCCLUDED window makes it"
            echo "       worse. That arm was never held — do not read the above as ruling"
            echo "       occlusion out as a contributor. The 6/6 and 3/3 figures are"
            echo "       one-shot arms on a primitive now known to be flaky: indicative."
            echo "       FIX: update the bridge extension, then confirm what is RUNNING —"
            echo "         browser --instance $INSTANCE ping   # buildMarker, NOT extensionVersion"
            echo "       extensionVersion stayed 0.8.1 across two DIFFERENT builds, so it cannot"
            echo "       tell you this. The MV3 worker keeps old code until it reloads and the"
            echo "       brave://extensions reload button often no-ops (the long-poll holds the"
            echo "       worker alive) — a FULL Brave restart is the reliable path." ;;
          *)
            echo "       The recipe's actions all succeeded and the app was booted; this is"
            echo "       the bridge, not the app and not the recipe." ;;
        esac
        exit 12
      fi
      cp "$shot" "$OUT/$st.png"
      echo "     captured -> $OUT/$st.png"
    fi
    # 🔴 THE SEAM. plan.py emits these two keys and nothing else consumes them;
    # a step whose output is planned and never written is an artifact that never
    # exists, and a missing artifact reads as "nothing to report". The suite's
    # E9 gate asserts that the set of capture-* keys plan.py emits is exactly the
    # set handled here, so adding one there without wiring it here FAILS.
    dom_of="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("captureDom",""))' "$step")"
    prb_of="$(python3 -c 'import json,sys;print(json.loads(sys.argv[1]).get("captureProbe",""))' "$step")"
    [ -n "$dom_of" ] && { printf '%s' "$out" > "$OUT/$dom_of.dom.json"; echo "     dom      -> $OUT/$dom_of.dom.json"; }
    [ -n "$prb_of" ] && { printf '%s' "$out" > "$OUT/$prb_of.probe.json"; echo "     probe    -> $OUT/$prb_of.probe.json"; }
  done

  if [ "$EVIDENCE" = 1 ]; then
    # evidence.py owns every refusal here (truncated DOM, un-self-tested probe,
    # unreadable payload). capture.sh only runs it and stops on a refusal.
    python3 "$EVIDENCE_PY" analyze --dom "$OUT/$st.dom.json" --probe "$OUT/$st.probe.json" \
      --state "$st" --slug "$SLUG" \
      --frame-host "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["frameHost"])' "$RECIPE")" \
      --out "$OUT/$st.evidence.json" --pretty-dom "$OUT/$st.dom.html" >/dev/null || {
        echo "     evidence REFUSED for $st — see the REFUSE line above. Not shipping an artifact."; exit 10; }
    echo "     evidence -> $OUT/$st.evidence.json"
    ARTIFACTS+=("$OUT/$st.evidence.json")
  fi

  if [ "$DO_FRAME" = 1 ]; then
    # 🔴 MEASURE THE APP IFRAME AS LATE AS POSSIBLE, AND NEVER AT `observe` TIME.
    # The rewards banner that moves this boundary is rendered only after a
    # Buzz-multiplier query resolves, i.e. it can appear AFTER first paint — so a
    # rect read during the pre-plan observe can describe a layout the screenshot
    # no longer has, which is the very failure being fixed. This runs after the
    # state's whole plan, milliseconds after the capture, on the same page.
    if [ -n "$USE_APPFRAME" ]; then
      # 🔴 EXIT 9, NOT 5. Building the probe and measuring with it are different
      # failures — the first is this skill's own JS refusing to be emitted (a
      # `rect_js_actuates` / `rect_js_multiline` refusal, i.e. a bug HERE), the
      # second is the crop being wrong about a real screenshot. They shared exit
      # 5 until 2026-08-23, which is the "one code carrying several sentences"
      # defect exits 11/12/13 were split apart to remove; a caller branching on
      # the status could not tell them apart even though the printed lines did.
      RJS="$(python3 "$FRAME" frame-rect-js --recipe "$RECIPE")" || {
        echo "     could not build the app-frame probe — see the REFUSE line."; exit 9; }
      # tab-level ON PURPOSE: the iframe ELEMENT lives in the top frame. Every
      # other DOM op here is --frame-scoped (guard 1) because it addresses the
      # app's own document; this one addresses the box the app is drawn in.
      "$BB" --instance "$INSTANCE" --tab "$TAB" js "$RJS" > "$OUT/$st.rect.json" 2>&1
      echo "     app-frame -> $OUT/$st.rect.json"
    fi
    # 🔴 EXIT 14, NOT 5 — AND THE SPLIT IS BY OPERATOR ACTION, which is the same
    # reason 9 was split out of 5 above. Exit 5 says "this crop is wrong about
    # this screenshot": go and fix the rect. `viewport_of_record` says the
    # OPPOSITE — the rect is fine and the WINDOW is not the one it was measured
    # in, so the fix is to resize the window (or re-measure the recipe against
    # the new one), and nothing about the recipe is broken. A caller branching on
    # the status could not tell those apart on one code, and this failure is
    # expected to be COMMON: the operator's browser window is not pinned by
    # anything, and it changed between two runs an hour apart on 2026-09-02.
    # The stderr is captured (not left on the terminal) only so the code can be
    # read out of it; it is re-emitted verbatim either way.
    ferr="$OUT/$st.frame.err"
    m="$(python3 "$FRAME" measure "$OUT/$st.png" --recipe "$RECIPE" \
          ${USE_APPFRAME:+--app-frame-rect "$OUT/$st.rect.json"} 2>"$ferr")" || {
      cat "$ferr" >&2
      # 🔴 COUNT, never `grep -q` (CLAUDE.md's shell gotchas: `-a` because a tool
      # log can carry a byte that makes grep call it binary and answer NOTHING,
      # and a counted match cannot be an exit code read from the wrong command).
      # 🔴 TWO CODES, ONE EXIT, ON PURPOSE — the split here is by OPERATOR ACTION
      # and both of these ask for the same one. `viewport_of_record` says the
      # WINDOW is not the one the rect was measured in; `frame_of_record` says the
      # APP FRAME is not (the only form graded that way is a rect anchored on both
      # horizontal edges, where the window's width is no longer a fact about the
      # rect). Either way nothing is broken and the fix is to restore the geometry
      # or re-measure — so giving them separate statuses would be a distinction a
      # caller could not act on, which is the mirror of the 5/9/14 defect.
      if [ "$(command grep -caF 'REFUSE[viewport_of_record]' "$ferr")" != "0" ] \
         || [ "$(command grep -caF 'REFUSE[frame_of_record]' "$ferr")" != "0" ]; then
        echo "     the WINDOW is not the one this recipe's crop was measured in — see the REFUSE line for the geometry it names."
        echo "     Nothing here is broken: resize the browser window back, or re-measure the rect AND crop._measuredGeometry together."
        exit 14
      fi
      echo "     framing REFUSED for $st — see the REFUSE line. Not shipping a bad crop."; exit 5; }
    # success: frame.py writes nothing here, so do not leave an empty file beside
    # every capture — but emit it if it DID say something.
    [ -s "$ferr" ] && cat "$ferr" >&2
    rm -f "$ferr"
    MEASURES="$(python3 -c 'import json,sys;a=json.loads(sys.argv[1]);a.append(json.loads(sys.argv[2]));print(json.dumps(a))' "$MEASURES" "$m")"
  fi
done

if [ "$EVIDENCE" = 1 ] && [ "${#ARTIFACTS[@]}" -gt 0 ]; then
  echo
  python3 "$EVIDENCE_PY" report "${ARTIFACTS[@]}"
  echo
  echo "  diff a later run against this one:"
  echo "    .claude/skills/app-capture/scripts/evidence.py diff <before>.evidence.json <after>.evidence.json"
fi

if [ "$DO_FRAME" != 1 ]; then
  echo "  --no-frame: crop/measure/render skipped (evidence run, not a store shoot)."
  exit 0
fi

printf '%s' "$MEASURES" > "$OUT/measures.json"

# 🔴 THE CHEAPEST REAL CHECK: different screens cannot have identical content
# extents. When the cropper is broken every state reports the SAME box.
python3 "$FRAME" check-states "$OUT/measures.json" || {
  echo "  the crop is measuring page furniture, not content. Nothing shipped."; exit 6; }

if [ "$RENDER" = 1 ]; then
  command -v magick >/dev/null 2>&1 || {
    echo "  imagemagick not on PATH — captures + measurements are in $OUT, rendering skipped."
    echo "  re-run under: nix-shell -p imagemagick --run '.claude/skills/app-capture/scripts/capture.sh ...'"
    exit 0; }
  for st in $STATES; do
    python3 "$FRAME" render "$OUT/$st.png" --out "$OUT/$st-framed.png" --recipe "$RECIPE" \
      ${USE_APPFRAME:+--app-frame-rect "$OUT/$st.rect.json"} --exec >/dev/null \
      || { echo "  render failed for $st"; exit 7; }
    RENDERS+=("$OUT/$st-framed.png")
  done
  python3 "$FRAME" bounds screenshot "${RENDERS[@]}" || {
    echo "  the framed candidates violate the store bounds — see above. Nothing shipped."; exit 8; }
  echo "  candidates ready (store-bounds clean):"
  printf '    %s\n' "${RENDERS[@]}"
  echo "  attach them with: .claude/skills/app-capture/scripts/attach.sh --app $SLUG --screenshot <file> --changelog '...' --confirm"
fi
