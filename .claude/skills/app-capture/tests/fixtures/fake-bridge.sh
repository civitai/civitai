#!/usr/bin/env bash
# ============================================================================
# fake-bridge.sh — a stand-in for the browser bridge, so capture.sh's EVIDENCE
# WIRING can be exercised offline, end to end, with no browser.
#
# 🔴 WHY THIS EXISTS AT ALL. This skill has already shipped a positive control
# that proved nothing: `attach.sh` emitted `--app`/`--file` for its whole life
# and NEVER attached anything, because the gate asserted only that a CLI *was
# invoked* and the stub accepted any flags. "It ran" is not "it was right". So
# this fake is deliberately PICKY — it refuses an op it does not recognise, it
# refuses `html` without `--max-bytes 0`, and it refuses any frame-scoped op
# that arrives without `--frame`. A capture.sh that stops wiring the evidence
# steps therefore FAILS here rather than producing a smaller, quieter run.
#
# It serves the REAL captures under tests/fixtures/app-capture/evidence/, so the
# artifact the integration gate reads is computed from real app DOM.
#
# Knobs, for the negative controls:
#   FAKE_PROBE_MODE=selftest-fail   drain returns selfTest:false  -> analyze must REFUSE
#   FAKE_DOM_MODE=truncated         html returns a truncated DOM  -> analyze must REFUSE
#   FAKE_READY_MODE=never           the app-ready probe answers APPBOOT_LOADING for
#                                   ever — a hidden-tab BLOCK_INIT deadlock, which
#                                   the run must report as "the app never booted"
#                                   rather than as a failing action
#   FAKE_READY_MODE=hidden          the probe answers APPBOOT_HIDDEN for ever — the
#                                   tab was never really in front (the i3 workspace
#                                   was not raised). The run must report this as a
#                                   CONFOUND, not as a verdict on the ready anchor
#   FAKE_I3_MODE=failed|skipped     `activate` reports that the host-side window
#                                   raise did not happen. `failed` must STOP the run
#   FAKE_SHOT_MODE=timeout          `screenshot` answers `op_timeout:screenshot` with
#                                   no path — the captureVisibleTab hang on a
#                                   visible-but-UNFOCUSED window. The run must
#                                   attribute it to the bridge, not to the recipe
#   FAKE_SHOT_SEQ=<file>            serve a DIFFERENT real capture per screenshot
#                                   (the counter lives in that file). A framed
#                                   multi-state run needs distinct pictures or
#                                   check-states fires on the fixture
#   FAKE_APPFRAME_MODE=absent       the app-frame probe finds no iframe -> the run
#                                   must STOP rather than fall back to the static
#                                   band the recipe could not satisfy
#   FAKE_APPFRAME_MODE=scale        the probe reports a viewport that disagrees
#                                   with the captured PNG -> refused
#   FAKE_CLICK_MODE=not-found       every click answers element_not_found (exit 1)
#                                   — a stale selector must FAIL the state, unless
#                                   the action declared itself optional
#   FAKE_CLICK_MODE=op-error        every click fails with the bridge's GENERIC op
#                                   error (exit 1, no element_not_found anywhere).
#                                   The class the string-matching version missed
#   FAKE_I3_MODE=die                `activate` fails as an OP (exit 1) rather than
#                                   reporting i3=failed — must still exit 13
#   FAKE_LOG=<file>                 append every invocation's argv (the ledger)
#
# 🔴 `activate` IS ACCEPTED, AND THAT IS A DELIBERATE CHANGE (2026-08-17). This
# fake used to refuse it outright, which encoded "capture never takes the screen"
# — measured false: an App Block does NOT boot in a hidden tab (5/5 deadlock), so
# a capture that never foregrounds its tab captures a spinner. What must stay
# impossible is ACTUATION, and no bridge op can actuate: `xdotool` is not a
# bridge op at all, so the ledger (FAKE_LOG) is where a gate proves the run
# foregrounded exactly once and pressed nothing.
# ============================================================================
set -uo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
EV="${HERE}/evidence"
[ -n "${FAKE_LOG:-}" ] && printf '%s\n' "$*" >> "$FAKE_LOG"

die() { echo "fake-bridge: $*" >&2; exit 1; }

OP=""; HAS_FRAME=0; MAXBYTES=""; JSARG=""
prev=""
for a in "$@"; do
  case "$a" in
    --frame) HAS_FRAME=1 ;;
    --instance|--tab|--wait|--max-bytes|--selector) ;;
    --*) ;;
    *)
      case "$prev" in
        --instance|--tab|--frame|--wait|--max-bytes|--selector) ;;
        *)
          if [ -z "$OP" ]; then
            case "$a" in
              whoami|open|close|wake|frames|text|html|js|click|type|key|screenshot|nav|activate)
                OP="$a" ;;
            esac
          elif [ "$OP" = js ] && [ -z "$JSARG" ]; then
            JSARG="$a"
          fi ;;
      esac ;;
  esac
  [ "$prev" = "--max-bytes" ] && MAXBYTES="$a"
  prev="$a"
done

[ -n "$OP" ] || die "no recognised op in: $*"

need_frame() { [ "$HAS_FRAME" = 1 ] || die "op '$OP' arrived WITHOUT --frame — App Blocks render in a cross-origin iframe, so this would have read the top frame and found nothing"; }

case "$OP" in
  whoami)  echo '{"ok":true,"host":"fake"}' ;;
  open)    echo '{"ok":true,"result":{"ok":true,"data":{"tabId":8123,"url":"https://civitai.com/apps/run/custom-generators"}}}' ;;
  close|release) echo '{"ok":true}' ;;
  wake)    echo '{"ok":true,"result":{"ok":true,"data":{"wake":{"ok":true}}}}' ;;
  nav)     echo '{"ok":true,"result":{"ok":true,"data":{"url":"https://civitai.com/apps/run/custom-generators"}}}' ;;
  frames)  echo '{"ok":true,"result":{"ok":true,"data":{"frames":[{"frameId":0,"url":"https://civitai.com/apps/run/custom-generators"},{"frameId":830,"url":"https://custom-generators.civit.ai/"}]}}}' ;;
  click|type|key)
           need_frame
           # the bridge's own answer for a selector that resolves to nothing
           # (protocol.js: `if (!el) return { ok: false, error: "element_not_found" }`).
           # 🔴 AN ERROR RESPONSE MEANS EXIT 1, LIKE THE REAL CLI. `browser` ends
           # every failed op with `die "op '<op>' failed in the browser: <err>"`
           # (<devrc>/scripts/browser-bridge/browser), so a fake that printed the
           # error JSON and exited 0 could only ever exercise a runner that reads
           # the error TEXT — never one that reads the STATUS. That is precisely
           # how a `click` answered with op_timeout ran green: the string branch
           # did not match and there was nothing else to look at.
           if [ "${FAKE_CLICK_MODE:-}" = "not-found" ]; then
             echo '{"ok":false,"error":"element_not_found"}'; exit 1
           elif [ "${FAKE_CLICK_MODE:-}" = "op-error" ]; then
             # the GENERIC op failure — same shape as op_timeout:screenshot, which
             # already has its own branch in capture.sh, one op over.
             echo "browser: op 'click' failed in the browser: op_timeout:click" >&2
             exit 1
           else
             echo '{"ok":true,"result":{"ok":true,"data":{"clicked":true}}}'
           fi ;;
  text)
           # the top-frame read (no --frame) feeds guard_page; the in-frame read
           # feeds waitForText/waitForGone. Neither may carry the explainer copy,
           # or `waitForGone` would spin until it times out.
           echo '{"ok":true,"result":{"ok":true,"data":{"text":"Custom Generators Discover My generators Create"}}}' ;;
  screenshot)
           # 🔴 THE MEASURED HANG. On a window that is VISIBLE BUT NOT FOCUSED the
           # bridge's captureVisibleTab fast path never returns and the op is
           # killed by its own budget — no path, and an ordinary-looking exit.
           if [ "${FAKE_SHOT_MODE:-}" = "timeout" ]; then
             # exit 1, like the real CLI — and the run must STILL come back with
             # exit 12 (the bridge/occlusion sentence), not the generic action
             # failure. That is the positive control on capture.sh's deliberate
             # exemption for this op.
             echo '{"ok":false,"error":"op_timeout:screenshot"}'; exit 1
           elif [ -n "${FAKE_SHOT_SEQ:-}" ]; then
             # 🔴 A DIFFERENT REAL CAPTURE PER STATE. A framed multi-state run is
             # the only way to exercise the crop/measure/check-states chain end to
             # end, and serving ONE picture to every state would make the
             # identical-box gate fire — correctly, on the fixture rather than on
             # the code. The counter lives in a file because each invocation is a
             # fresh process.
             n=0; [ -f "$FAKE_SHOT_SEQ" ] && n="$(cat "$FAKE_SHOT_SEQ")"
             shots=(1-explainer.png 2-discover.png 3-generator.png 4-mine.png)
             shot="${shots[$(( n % ${#shots[@]} ))]}"
             printf '%s' "$(( n + 1 ))" > "$FAKE_SHOT_SEQ"
             printf '{"ok":true,"result":{"ok":true,"data":{"path":"%s"}}}\n' "${HERE}/${shot}"
           else
             printf '{"ok":true,"result":{"ok":true,"data":{"path":"%s"}}}\n' "${HERE}/1-explainer.png"
           fi ;;
  html)
           need_frame
           [ "$MAXBYTES" = "0" ] || die "html without --max-bytes 0: the bridge's 32768-byte default TRUNCATES a real App Block DOM (measured 38,758 bytes) and silently under-reports every testid and a11y violation"
           if [ "${FAKE_DOM_MODE:-}" = "truncated" ]; then
             python3 - "${EV}/cg-explainer.dom.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
h = d["result"]["data"]["html"]
d["result"]["data"]["html"] = h[:20000] + "\n…[truncated %d bytes]" % (len(h) - 20000)
print(json.dumps(d))
PY
           else
             cat "${EV}/cg-explainer.dom.json"
           fi ;;
  js)
           # 🔴 THE APP-FRAME PROBE IS THE ONE `js` THAT MUST *NOT* BE FRAME-SCOPED,
           # and this fake is where that stops being a sentence and becomes a check.
           # It measures the <iframe> ELEMENT, which lives in the TOP frame; sent
           # with --frame it would run inside the app's own document, find no
           # iframe, and answer APPFRAME_ABSENT — a refusal blaming the recipe for
           # a scoping bug. So: this payload is refused WITH --frame, and every
           # other js payload is still refused WITHOUT one.
           case "$JSARG" in
             *APPFRAME_ABSENT*)
               [ "$HAS_FRAME" = 0 ] || die "the app-frame probe arrived WITH --frame — it measures the iframe ELEMENT in the TOP frame, so frame-scoping it would search the app's own document and always answer APPFRAME_ABSENT"
               case "${FAKE_APPFRAME_MODE:-}" in
                 absent) echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPFRAME_ABSENT"}}}' ;;
                 scale)  echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPFRAME_RECT:201,110,70,1280,800"}}}' ;;
                 # 🔴 FIVE numbers here, deliberately: this is the PRE-2026-09-02
                 # probe answer, and it is what an `xFrom` rect must REFUSE against
                 # (`app_frame_left_missing`) rather than silently read `x` as an
                 # absolute column. Kept as a mode so the refusal is reachable end
                 # to end, not only in frame.py's own tests.
                 fivefield) echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPFRAME_RECT:201,110,70,1709,1314"}}}' ;;
                 # 🔴 201, NOT 182 AND NOT 163. The value has to be one that appears
                 # in NEITHER the recipe NOR frame.py's defaults, or a gate on the
                 # resulting bands cannot tell "the rect was applied" from "the rect
                 # was ignored and the static band happened to match" (the lesson F9
                 # already carries). 201 also has to WIN the max() against the
                 # recipe's 182, or the wiring could be inert and still look right.
                 #
                 # 🔴 SIX NUMBERS SINCE 2026-09-02 — the trailing 0 is the frame's
                 # LEFT inset, and 0 is not a placeholder: every live probe answer in
                 # this repo's corpus reads the app iframe as FULL-BLEED at a 1709px
                 # viewport (`rightGap = -1`), so a left inset of 0 is what the real
                 # page reports. The live app frame this bridge describes is therefore
                 # 1709 - 70 - 0 = 1639 device px wide, which is the number a
                 # fully-anchored recipe must record as `appFrameW`.
                 *)      echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPFRAME_RECT:201,110,70,1709,1314,0"}}}' ;;
               esac
               exit 0 ;;
           esac
           need_frame
           case "$JSARG" in
             *"__APP_CAPTURE__ = S"*|*"W.__APP_CAPTURE__ = S"*)
               echo '{"ok":true,"result":{"ok":true,"data":{"value":"{\"schema\":\"app-capture/probe@1\",\"installed\":true,\"reinstalled\":false,\"selfTest\":true,\"hooks\":{\"console\":true,\"errorEvents\":true,\"fetch\":true,\"xhr\":true,\"perfObserver\":true}}"}}}' ;;
             *"S.console = []"*)
               if [ "${FAKE_PROBE_MODE:-}" = "selftest-fail" ]; then
                 python3 - "${EV}/cg-explainer.probe.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
p = json.loads(d["result"]["data"]["value"])
p["selfTest"] = False
p["console"] = [m for m in p["console"] if "selftest" not in m["text"]]
d["result"]["data"]["value"] = json.dumps(p)
print(json.dumps(d))
PY
               else
                 cat "${EV}/cg-explainer.probe.json"
               fi ;;
             *APPBOOT_READY*)
               # the app-ready probe. It answers with ONE BARE TOKEN, so the poll
               # cannot be defeated by the bridge's JSON quote-escaping.
               case "${FAKE_READY_MODE:-}" in
                 never)  echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPBOOT_LOADING"}}}' ;;
                 hidden) echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPBOOT_HIDDEN"}}}' ;;
                 *)      echo '{"ok":true,"result":{"ok":true,"data":{"value":"APPBOOT_READY"}}}' ;;
               esac ;;
             *) die "unrecognised js payload — the fake serves the probe's install and drain halves and the app-ready probe only" ;;
           esac ;;
  activate)
           # 🔴 `i3` IS THE BRIDGE'S OWN ANSWER ABOUT THE WINDOW, and it is the
           # half that can silently not happen: activating raises the tab INSIDE
           # Brave, while raising the operator's i3 workspace is a host-side
           # best effort reported as applied|skipped|failed.
           # FAKE_I3_MODE=die: the bridge itself fails the op, as opposed to
           # raising the tab and reporting that the host-side i3 raise did not
           # happen. Both must stop the run with exit 13 — until now only the
           # second could, because nobody read the op's status.
           if [ "${FAKE_I3_MODE:-}" = "die" ]; then
             echo "browser: op 'activate' failed in the browser: op_timeout:activate" >&2
             exit 1
           fi
           printf '{"ok":true,"result":{"ok":true,"data":{"activated":true,"i3":"%s"}}}\n' \
             "${FAKE_I3_MODE:-applied}" ;;
  *)       die "unhandled op $OP" ;;
esac
exit 0
