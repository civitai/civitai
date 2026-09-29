#!/usr/bin/env bash
# ============================================================================
# attach.sh — the MUTATING verb, kept separate from `capture` on purpose.
#
#   attach.sh --app <slug> [--screenshot F [--caption C]]... [--icon F]
#             [--cover F] --changelog "<why>" [--confirm]
#
# 🔴 WITHOUT --confirm IT MUTATES NOTHING. It prints the exact commands it would
# run and exits 3. `--confirm` is the only way past that; there is no env var,
# no --yes, and no interactive prompt that a runaway loop could satisfy.
#
# 🔴 EVERY ASSET IS GATED AGAINST scripts/store-bounds.json BEFORE ANYTHING IS
# SENT — including in dry-run, so the dry-run is a real check and not theatre.
#
# What attaching to a LIVE listing actually does (verified 2026-08-13):
#   - it opens a SHADOW REVISION for moderator re-review. Hence --changelog is
#     mandatory, not optional.
#   - icon + cover + several screenshots done in ONE session land on ONE
#     revision: the same alpr_... id came back from each call.
#   - 🔴 add-screenshot / updateScreenshotCaption / removeScreenshot return an id
#     RE-KEYED ONTO THE CLONE — it is NOT an echo of the id you passed. Treating
#     it as an echo corrupts any subsequent reorder or caption call. This script
#     therefore RE-READS the listing after mutating and reports the ids the
#     server actually holds.
#   - reorder requires ALL current screenshot ids in the new order.
#   - captions are supported and currently unused on every listing. Use them.
# ============================================================================
set -uo pipefail

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
FRAME="${APP_CAPTURE_FRAME:-$HERE/frame.py}"
CIVITAI="${APP_CAPTURE_CIVITAI:-civitai}"

APP=""; CHANGELOG=""; CONFIRM=0; ICON=""; COVER=""
declare -a SHOTS=() CAPTIONS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --app)        APP="$2"; shift 2 ;;
    --screenshot) SHOTS+=("$2"); CAPTIONS+=(""); shift 2 ;;
    --caption)    [ ${#CAPTIONS[@]} -gt 0 ] || { echo "--caption must follow a --screenshot" >&2; exit 2; }
                  CAPTIONS[$(( ${#CAPTIONS[@]} - 1 ))]="$2"; shift 2 ;;
    --icon)       ICON="$2"; shift 2 ;;
    --cover)      COVER="$2"; shift 2 ;;
    --changelog)  CHANGELOG="$2"; shift 2 ;;
    --confirm)    CONFIRM=1; shift ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *)            echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$APP" ] || { echo "--app <slug> is required" >&2; exit 2; }
[ ${#SHOTS[@]} -gt 0 ] || [ -n "$ICON" ] || [ -n "$COVER" ] || {
  echo "nothing to attach: pass --screenshot / --icon / --cover" >&2; exit 2; }
[ -n "$CHANGELOG" ] || {
  echo "--changelog is REQUIRED: attaching to a live listing opens a SHADOW REVISION" >&2
  echo "for moderator re-review, and a revision with no changelog wastes a mod's time." >&2
  exit 2; }

fail=0
gate() {  # gate <kind> <count-on-listing> <files...>
  local kind="$1" count="$2"; shift 2
  python3 "$FRAME" bounds "$kind" "$@" --count "$count" >/dev/null || fail=1
}
[ ${#SHOTS[@]} -gt 0 ] && gate screenshot "${#SHOTS[@]}" "${SHOTS[@]}"
[ -n "$ICON" ]  && gate icon  1 "$ICON"
[ -n "$COVER" ] && gate cover 1 "$COVER"
[ "$fail" = 0 ] || { echo "store bounds violated — refusing to attach." >&2; exit 4; }

# 🔴 THE CLI CONTRACT, and it was WRONG here until 2026-08-15 -- this script had
# NEVER successfully attached anything. It emitted `--app <slug> --file <path>`;
# the CLI takes `--slug <slug>` and a POSITIONAL path, so every invocation died
# with `unknown flag: --app`. Four more in the same breath: no `-y`, so a live
# listing would block on the revision prompt; the caption was deferred to a
# non-existent follow-up command when `--caption` is available right here; and
# the re-read below called `app listing get`, which is not a subcommand at all.
#
# The suite did not catch ANY of it: D4 asserts only that the CLI *is invoked*
# with --confirm, and its stub accepts any flags, so a permanently-broken argv
# read as a passing positive control. The argv shape is now pinned as data by
# the A5 gate instead of merely being executed.
declare -a CMDS=()
for i in "${!SHOTS[@]}"; do
  cmd="$CIVITAI app listing add-screenshot ${SHOTS[$i]} --slug $APP --changelog $(printf '%q' "$CHANGELOG") -y"
  [ -n "${CAPTIONS[$i]}" ] && cmd="$cmd --caption $(printf '%q' "${CAPTIONS[$i]}")"
  CMDS+=("$cmd")
done
[ -n "$ICON" ]  && CMDS+=("$CIVITAI app listing set-icon  $ICON  --slug $APP --changelog $(printf '%q' "$CHANGELOG") -y")
[ -n "$COVER" ] && CMDS+=("$CIVITAI app listing set-cover $COVER --slug $APP --changelog $(printf '%q' "$CHANGELOG") -y")

echo "=== attach plan for $APP ==="
echo "    changelog: $CHANGELOG"
echo "    NOTE: these land on ONE shadow revision and go back to moderator review."
printf '    %s\n' "${CMDS[@]}"

if [ "$CONFIRM" != 1 ]; then
  echo
  echo "DRY RUN — nothing was sent. Store bounds: OK. Re-run with --confirm to mutate the listing."
  exit 3
fi

command -v "$CIVITAI" >/dev/null 2>&1 || { echo "the civitai CLI is not on PATH" >&2; exit 3; }

# 🔴 A FAILED COMMAND MUST NOT SKIP THE RE-READ — that is the whole point of the
# re-read, and until 2026-09-04 a failure `exit 5`d right past it.
#
# `appListings.persistAssetImage` times out often enough to fail THREE times
# consecutively and succeed on the fourth (measured with a 303 KiB PNG twice and
# a 96 KiB JPEG once, so size is not the variable). A client-side failure is NOT
# evidence the server did nothing — and the natural response to "attach FAILED"
# is to run the same command again, which is exactly how three "failed" uploads
# become three screenshots on the listing.
#
# So on failure this stops (it does NOT retry — a re-send of add-screenshot DOES
# attach, unlike attach-offsite.py's persistAssetImage, which only mints an
# image) and then re-reads and says plainly what is on the listing now. The
# operator decides whether to re-run from the COUNT, not from the exit code.
attach_rc=0
failed_cmd=""
for c in "${CMDS[@]}"; do
  case "$c" in "  #"*) continue ;; esac
  echo "+ $c"
  if ! eval "$c"; then
    failed_cmd="$c"
    attach_rc=5
    break
  fi
done

if [ "$attach_rc" != 0 ]; then
  echo >&2
  echo "attach FAILED on: $failed_cmd" >&2
  echo "🔴 DO NOT RE-RUN THIS BLIND. A client-side failure is not evidence the server" >&2
  echo "   did nothing: this asset may already be on the listing. Read the CURRENT" >&2
  echo "   state below and count the assets before deciding to re-send." >&2
  echo "   Any command AFTER the failed one was not attempted." >&2
fi

# 🔴 RE-READ, on BOTH paths. The ids returned above are re-keyed onto the clone;
# the only trustworthy ids for a follow-up caption/reorder/remove are the ones
# the listing reports now.
echo
if [ "$attach_rc" != 0 ]; then
  echo "=== what the listing holds NOW (did the failed call land? count them) ==="
else
  echo "=== ids the server actually holds now (use THESE for caption/reorder) ==="
fi
"$CIVITAI" app listing status --slug "$APP" || echo "(could not re-read the listing — re-read before any reorder)"
echo
echo "reorder, when you need it, takes ALL current screenshot ids in the new order."
exit "$attach_rc"
