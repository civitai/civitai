#!/usr/bin/env python3
# ============================================================================
# plan.py — the PURE half of app-capture's browser work.
#
#   recipe.json + OBSERVED state  ->  an ordered list of browser-bridge commands
#
# It performs no I/O beyond reading its two JSON inputs and printing JSON. It
# never opens a browser. Everything that can be wrong about a capture run is
# decided HERE, where a test can watch it be decided — capture.sh only executes
# what this prints.
#
# 🔴 THE SEVEN BRIDGE FACTS THIS FILE ENCODES AS GUARDS RATHER THAN AS PROSE.
# Every one was hit on 2026-08-13; each is a test in .claude/skills/app-capture/tests/run-tests-app-capture.sh.
#
#  1. APP BLOCKS RENDER IN A CROSS-ORIGIN IFRAME (`<slug>.civit.ai` inside
#     `civitai.com/apps/run/<slug>`). A top-frame selector finds nothing and
#     injected JS returns `null` — indistinguishable from a broken bridge. So
#     every app read/click carries `--frame <id>`; `emit_dom` is the only way to
#     add one and it cannot be called without a resolved frame id.
#  2. THE FRAME ID CHANGES EVERY LOAD (observed 819, 821, 828, 830, 832 in one
#     session). It is therefore never cached across a navigation: a `nav` action
#     ENDS the plan with a `reobserve` sentinel, and capture.sh must re-run
#     `frames` and re-plan. There is no code path that emits a `--frame` step
#     after a nav in the same plan.
#  3. APPS BOOT SLOWLY. Right after `open`, the top frame reads "Starting <App>."
#     and the app frame does not exist yet. A missing frame is a REFUSAL that
#     says "poll again", not a crash and not a silent top-frame fallback.
#  4. TABS ARE CREATED HIDDEN AND THROTTLED. Every navigation and every
#     view-changing click is followed by `wake --wait 4000`, and the step
#     immediately before every `screenshot` is a wake. A throttled capture is a
#     blank page that looks like a broken app.
#  5. `screenshot` TAKES NO PATH ARGUMENT. It writes its own temp file and
#     prints JSON containing `path`. Passing a path breaks under `opencode`,
#     whose `external_directory` permission AUTO-REJECTS rather than prompting.
#  6. `browser activate` CAN MOVE THE OPERATOR'S FOCUS — it does not reliably
#     "steal the screen" (an earlier wording here), because every capture-path
#     activate ASKS for the host-side i3 raise to be withheld, with --no-focus.
#     The residual is the ungated windows.update{focused:true}; see the WITHHELD
#     IS NOT INERT note below.
#     It was admitted here on
#     the 2026-08-17 finding that a hidden tab DEADLOCKS the BLOCK_INIT
#     handshake 5/5, i.e. that activation was the only way an App Block boots.
#     🔴 THAT IS RETRACTED (2026-08-24): App Blocks boot hidden, 4/4, one with
#     no `activate` at all — and the HOST-SIDE raise is withheld in this harness
#     regardless (every activate here sends --no-focus, so the bridge answers
#     `i3: withheld`). 🔴 CORRECTED 2026-08-28 — the derivation this file used to
#     state, "capture.sh never passes --focus, so the raise is withheld", DOES NOT
#     FOLLOW: the CLI defaults the flag to ON when stdout is a TTY, so omitting it
#     delegates the decision to the caller's stdio. It held only because run_step
#     runs ops in a command substitution. Now it is DECLARED — see NO_FOCUS_ARG.
#     🔴 WITHHELD IS NOT INERT: the extension
#     still makes the tab its window's ACTIVE tab, and still calls
#     `chrome.windows.update{focused:true}`, which no flag covers.
#     The steps are kept because they are the shipped design
#     that ACTIVATE_REASONS/G11/M59-M64 pin; removing them is optional cleanup,
#     not a fix. Do not re-derive the deleted premise from these guards.
#     🔴 TWO CLAIMS, TWO DOCS — cite the right one or the number is not there:
#       hidden boot 4/4  -> the private infra repo's app-capture-hidden-tab-boot-2026-08-24.md
#       screenshot hang  -> the private infra repo's app-capture-occlusion-refutation-2026-08-24.md
#     (the claudedocs/... records below live in the PRIVATE infra repo, not here)
#     🔴 ACTIVATION IS NOT ACTUATION, and the two are now enforced SEPARATELY:
#     activation only puts a window in front; what makes a spend possible is an
#     OS-level ACTUATION (`xdotool key`) landing on a focused control. So
#     `activate` is allowed in a FOREGROUND plan (build_foreground), while
#     `guard_no_actuation` refuses ANY step carrying an actuation token in a plan
#     built without --trusted — including one an edit to this file might add
#     beside the activate. Neither guard can be satisfied by the other.
#  7. LOGGED OUT, `/apps/run/<slug>` IS A PLAIN 404 — byte-identical to a
#     nonexistent slug. Capturing it would produce four perfectly framed pictures
#     of an error page, so the 404/logged-out check runs BEFORE anything else.
#
# 🔴 THE SPEND PATH REJECTS SYNTHETIC EVENTS. Measured on panorama-360: a
# synthetic in-frame click works on an ordinary control and does NOTHING AT ALL
# on the Generate button. Only a trusted OS keypress on the focused control
# fires it. That is what `trustedKey` emits, and it is unreachable without the
# explicit --trusted flag.
#
# 🔴 DO NOT VERIFY A SPEND WITH A BUZZ-BALANCE DELTA. Some apps bill per GPU
# second ON COMPLETION, so the balance does not move at submission. A misread of
# exactly this nearly caused a working result to be discarded. A `trustedKey`
# action must carry `verifyLabel` — the control's OWN state label, e.g. the
# button changing to "Rendering." — and a recipe that tries to verify by balance
# is refused by name.
#
# 🔴 --evidence ADDS MACHINE-ANALYSABLE CAPTURE, and adds no way to spend. It
# wraps each state in three extra frame-scoped reads — install the observer
# probe BEFORE the actions, then read the DOM and drain the probe AFTER the
# screenshot. The probe's source is single-sourced in evidence.py and scanned
# here for actuation verbs (click/submit/navigate) before it may be planned: it
# is the one piece of this skill that runs our own code inside a live,
# logged-in, mod-gated app, so "it only observes" has to be a check, not a claim.
#
# 🔴 EVERY STATE OPENS WITH AN APP-READY GATE, BEFORE ITS FIRST ACTION. Measured
# 2026-08-17: every recipe's first action was a click, with nothing waiting for
# the app to finish booting. When the app booted AFTER that click, the click was
# thrown away, the following `waitForGone` never cleared, and the run failed with
# a message that reads exactly like a broken dismiss button — which it was not (a
# synthetic in-frame click dismisses the panel fine). `plan_ready` emits a
# frame-scoped probe that polls until the loading marker is gone AND the recipe's
# ready anchor is present, and marks the step `appReady` so capture.sh can say
# "the app never booted" instead of "the action failed".
#
# Usage:
#   plan.py <recipe.json> --observed <state.json> --state <name> [--trusted]
#           [--evidence]
#   plan.py <recipe.json> --observed <state.json> --foreground-plan
# Exit: 0 = plan on stdout · 2 = REFUSAL on stderr · 1 = usage/parse error
# ============================================================================
import argparse
import json
import sys

import evidence

WAKE_MS = 4000          # bridge cap is 6s; 4s measured sufficient for these apps
SETTLE_MS = 4000        # the wake that settles the page BEFORE the raise+capture
# 🔴 A RE-ASSERT CARRIES NO --wait, AND THAT IS A MEASUREMENT, NOT A SAVING.
# `activate --wait MS` is the bridge's bounded page-LOAD wait; it is NOT a
# focus-hold timer, and `activate` returns in ~350-500 ms whatever it is set to.
# Swept nowait/100/250/500/1000/1500 from the failing state: 3/3 recovered at
# every value, 18/18 overall — the constant that used to sit here (1500 ms, with
# a rationale about holding focus) was inert. What IS load-bearing is the GAP
# between the raise and the thing that needs the window: measured 3/3 at gap 0,
# 1/3 with a 4 s wake in between, and the raised foreground itself survives a
# median ~1.5 s (1176/2550/1176/1503/1232 ms over 5 runs). So a re-assert is
# emitted with --no-wait and placed IMMEDIATELY before what it exists for.
# 🔴 SCOPE ON THAT MEDIAN: those 5 samples were taken at load 130-145 on a
# 24-thread box (~5.7x oversubscribed), so it is a LOWER bound, not a constant —
# and it is not what this design rests on. The GAP arms are outcomes of the
# capture itself and hold whatever the true dwell time is.
# 🔴 SAY --no-focus OUT LOUD. THE ABSENCE OF --focus IS *NOT* WHAT WITHHOLDS THE
# HOST-SIDE RAISE, AND EVERY DOC IN THIS SKILL USED TO DERIVE IT THAT WAY.
# The bridge CLI resolves the flag as "on iff stdout is a TTY"
# (<devrc>/scripts/browser-bridge/browser, the `activate` case): a human typing
# it in a terminal means it; an agent on a pipe does not. Measured 2026-08-28
# against an instrumented endpoint, SAME argv, `activate --no-wait`:
#
#   | stdout                                   | wire payload   |
#   |------------------------------------------|----------------|
#   | command substitution (capture.sh's shape)| "focus":false  |
#   | a PTY                                    | "focus":TRUE   |
#   | explicit --focus / --no-focus            | true / false   |
#
# So the property "capture.sh does not take the operator's screen via i3" held
# only because capture.sh's `run_step` runs every op inside `out="$(...)"`. That
# is an accident of stdio in a helper, in a different repo from the default that
# decides it, and NOTHING pinned the relationship. Passing the flag makes the
# property true BY CONSTRUCTION — immune to any refactor of run_step and to the
# CLI changing its default — and it makes this skill's prose correct AS WRITTEN
# rather than true-by-coincidence. `guard_activate_placement` enforces it, with
# its own refusal code `activate_unconsented`.
#
# 🔴 The gate covers the i3 half ONLY. `activate` still calls
# chrome.tabs.update{active:true} (which is what routes a capture onto the
# captureVisibleTab fast path) and the UNGATED chrome.windows.update{focused:true}.
# --no-focus is not "activate does nothing"; it is "we did not ask for the i3 raise".
NO_FOCUS_ARG = "--no-focus"
REFOCUS_ARGS = ["--no-wait", NO_FOCUS_ARG]
READY_TIMEOUT_MS = 45000  # a foregrounded App Block booted in ~4s; 45s is slack
DEFAULT_LOADING_TESTID = "app-loading"   # measured: the frame's loading shell

# The ready probe answers with ONE BARE TOKEN, never a JSON object. The bridge
# returns `{"data":{"value":"..."}}`, so every quote inside the value comes back
# BACKSLASH-ESCAPED — a `"ready":true` needle would never match the text
# capture.sh polls. A bare token is immune to that.
READY_TOKEN_READY = "APPBOOT_READY"
READY_TOKEN_LOADING = "APPBOOT_LOADING"
READY_TOKEN_ABSENT = "APPBOOT_ABSENT"
# 🔴 THE CONFOUND TOKEN, AND IT IS CHECKED FIRST. `browser activate` raises the
# tab WITHIN Brave; whether the operator's i3 WORKSPACE follows is a host-side
# best effort that can silently not happen (the window parked on another
# workspace). When the app-ready gate then times out it reports APPBOOT_ABSENT
# — byte-identical to the report for a WRONG READY ANCHOR. Two live diagnosis
# runs died that way and proved nothing, so the probe reports VISIBILITY
# alongside markup to keep the two apart.
# 🔴 The CONFOUND is real; its old explanation ("the tab stays hidden, so the
# App Block deadlocks on BLOCK_INIT") is RETRACTED 2026-08-24 — App Blocks boot
# hidden, and `visibilityState: hidden` has been observed on a fully drivable
# app (see `ready_js` below). Hidden is a TIE-BREAK, never a verdict.
READY_TOKEN_HIDDEN = "APPBOOT_HIDDEN"

# A logged-out /apps/run/<slug> is a plain 404. These are the strings that page
# carries and a rendered app does not.
NOT_FOUND_MARKERS = (
    "404",
    "page could not be found",
    "This page could not be found",
    "Page not found",
)
LOGGED_OUT_MARKERS = (
    "Sign In",
    "Sign Up",
    "Log in with",
)

VIEW_CHANGING = ("click", "type", "key", "trustedKey", "nav")
# The bridge ops that address a DOCUMENT, and therefore must carry --frame here.
# Read by `guard_dom_scoping`; see that docstring for why an unscoped one is a
# spend hazard and not merely a wrong read.
DOM_OPS = ("click", "type", "key", "text", "html", "js")
KNOWN_ACTIONS = ("click", "clickIfPresent", "type", "key", "waitForText",
                 "waitForGone", "trustedKey", "sleep", "nav")

# 🔴 THE ACTUATION LEDGER — the half of the old `activate` ban that still holds.
# Foregrounding a window cannot spend; an OS-level keypress or click delivered to
# a focused control can. These are the tokens that deliver one, and NONE of them
# is `activate`: that omission is the whole point, and `guard_no_actuation` is
# the check that makes "capture can be foregrounded and still cannot spend" a
# property of the code rather than a sentence in a doc.
#
# 🔴 ONE LIST, SCANNED OVER op + argv TOGETHER — there is deliberately no second
# "banned ops" list. An earlier draft had one, and it could never fire on its
# own: the scan already joins the op into the text it searches, so every mutant
# of the op list died to the token list instead, and the battery would have
# recorded coverage that did not exist.
ACTUATION_TOKENS = ("xdotool", "--clearmodifiers")

# 🔴 THE PLACES `activate` MAY APPEAR, AS A CLOSED SET. Foregrounding is not
# actuation and is not banned — but "not banned" must not mean "anywhere". Every
# activate step declares WHY it is there, and `guard_activate_placement` checks
# both the reason and the position over the assembled plan:
#
#   tab            the once-per-tab foregrounding plan (build_foreground).
#   state          the re-assert that OPENS every state plan, immediately before
#                  the app-ready gate. Each state reloads the app, and the raised
#                  foreground lasts a median ~1.5 s, i.e. far less than one
#                  state, so once per tab does not reach them. This is
#                  the ONLY activate a screenshot-free run (`--evidence
#                  --no-frame`) carries, and gating it on the screenshot is what
#                  made a live evidence run boot state 1 and CONFOUND on state 2.
#   pre-screenshot the re-assert IMMEDIATELY before a screenshot (gap 0, after
#                  the settle wake), because the gap is what the 2026-08-19
#                  sweep actually resolved: 3/3 at gap 0, 1/3 with a 4 s wake
#                  in between. 🔴 Its old rationale — "captureVisibleTab never
#                  returns while the window is OCCLUDED" — is RETRACTED; the
#                  hang was an unbounded fast path, fixed in devrc #797.
#   spend          the trusted path's own activate, which only exists under
#                  --trusted and is bracketed by save/restore of the operator's
#                  window (P12 pins that bracketing).
ACTIVATE_REASONS = ("tab", "state", "pre-screenshot", "spend")


class Refuse(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


# ------------------------------------------------------------------ recipe --
def validate_recipe(r):
    for k in ("slug", "frameHost", "states"):
        if k not in r:
            raise Refuse("bad_recipe", "recipe is missing required key %r" % k)
    if not isinstance(r["states"], list) or not r["states"]:
        raise Refuse("bad_recipe", "recipe `states` must be a non-empty list")
    names = set()
    for s in r["states"]:
        if "name" not in s:
            raise Refuse("bad_recipe", "every state needs a `name`")
        if s["name"] in names:
            raise Refuse("bad_recipe", "duplicate state name %r" % s["name"])
        names.add(s["name"])
        for a in s.get("actions", []):
            verbs = [k for k in a if k in KNOWN_ACTIONS]
            if len(verbs) != 1:
                raise Refuse(
                    "bad_recipe",
                    "state %r: each action needs exactly one known verb (%s); got %s"
                    % (s["name"], "|".join(KNOWN_ACTIONS), sorted(a)))
    validate_click_ledger(r)
    validate_ready(r)
    return r


# The action verbs that can make the APP DO something. `type` fills a field and
# is not one; `waitForText`/`waitForGone` read; `trustedKey` has its own,
# stricter gate (`--trusted`). `key` IS one — Enter on a focused input submits
# the form it sits in, which is the same mutation a click on its submit button
# would make.
CLICKING_ACTIONS = ("click", "clickIfPresent", "key")


def validate_click_ledger(r):
    """🔴 "capture never mutates" WAS ONLY TRUE OF THE SPEND PATH AND THE
    INJECTED JS. A recipe's own `click` had no restriction at all.

    The skill's safety argument is that a synthetic in-frame click does nothing
    on a money button, because the spend path rejects untrusted events. That is
    measured, and it is NARROW: it is a fact about the SPEND path. An ordinary
    authenticated mutation — post, vote, edit, withdraw — has no such rejection,
    and this skill's own docs say synthetic clicks "drive the vast majority of
    apps". Measured 2026-08-23 on app-requests, which now renders `submit-btn`,
    `vote-btn`, `edit-btn` and `withdraw-btn`: every one is frame-scoped
    clickable and every one was permitted. A plausible "voting" state would have
    cast a real vote from the operator's account on every run, and every state
    reload; `withdraw-btn` would have deleted someone's request.

    🔴 WHAT THIS GUARD IS, AND WHAT IT IS NOT — read this before "improving" it.
    It does NOT detect a mutating control. It CANNOT: `plan.py` is pure and never
    sees the app's DOM, and HTML carries no "this mutates" signal — `type=submit`
    would catch a form button and miss `vote-btn`, which is an ordinary button
    with a handler. The rejected alternative was a name scan
    (`submit|vote|delete|withdraw`), which is a SPELLED guard in the exact sense
    the rules warn about: walkable by renaming a testid to `cast`, and a false
    positive on `submit-search`. A hazard that cannot be detected can only be
    DECLARED, so this is an asserted ledger and nothing more:

      "clickable": ["[data-testid='view-switch'] > button:nth-of-type(1)", ...]

    What it buys is not detection but REVIEWABILITY. Adding a clickable control
    becomes a second, deliberate edit in a place whose whole purpose is to say
    "someone confirmed this control does not mutate", and it makes the ledger
    GROW in the diff — the audit signal that did not exist before. The honest
    limit: a determined author can still list `vote-btn` and be wrong about it.

    It fails on GROWTH *and* on SHRINK. An entry no state clicks is a stale
    ledger, and a ledger that has stopped describing the recipe stops being read.
    """
    used = []
    for s in r["states"]:
        for a in s.get("actions", []):
            for verb in CLICKING_ACTIONS:
                if verb in a:
                    sel = a.get("selector") if verb == "key" else a[verb]
                    if sel:
                        used.append((s["name"], verb, sel))
    ledger = r.get("clickable")
    if not used:
        return                      # nothing to declare; a ledger is not required
    if ledger is None:
        raise Refuse(
            "no_click_ledger",
            "recipe %r plans %d control-activating action(s) (%s) and declares no "
            "`clickable` ledger. A click cannot be checked for whether it MUTATES "
            "— nothing in the markup says so — so every selector this recipe may "
            "activate has to be listed once, deliberately: \"clickable\": [%s]. "
            "Listing one is the assertion that someone confirmed it does not post, "
            "vote, edit or delete."
            % (r.get("slug"), len(used), ", ".join(sorted({v for _, v, _ in used})),
               ", ".join(repr(s) for _, _, s in used[:2]) + (", ..." if len(used) > 2 else "")))
    if not isinstance(ledger, list) or any(not isinstance(x, str) for x in ledger):
        raise Refuse("bad_recipe", "recipe `clickable` must be a list of selector strings")
    allowed = set(ledger)
    for name, verb, sel in used:
        if sel not in allowed:
            raise Refuse(
                "click_unledgered",
                "state %r would %s %r, which is NOT in this recipe's `clickable` "
                "ledger. If that control is safe — it navigates, filters, expands or "
                "dismisses, and does not post, vote, edit or delete — add it to the "
                "ledger. If it activates something on the operator's account, it does "
                "not belong in a capture at all: `capture` reads, it does not act."
                % (name, verb, sel))
    unused = [x for x in ledger if x not in {s for _, _, s in used}]
    if unused:
        raise Refuse(
            "clickable_unused",
            "recipe %r declares %d `clickable` entr(y/ies) no state activates: %s. "
            "A ledger that has drifted from the recipe stops being read as one — it "
            "reads as coverage while describing controls this recipe no longer "
            "touches. Remove them, or restore the state that used them."
            % (r.get("slug"), len(unused), ", ".join(repr(x) for x in unused)))


def validate_ready(r):
    """🔴 A RECIPE WITHOUT A READY GATE RACES THE APP'S OWN BOOT.

    Checked LAST, so a typo'd verb or a duplicate state name still reports its
    own reason rather than being masked by this one.
    """
    ready = r.get("ready")
    if not isinstance(ready, dict):
        raise Refuse(
            "no_ready_gate",
            "recipe %r declares no `ready` gate. Every state's first action would "
            "then run against whatever is on screen at that instant — and if the "
            "app boots AFTER it, the click is thrown away and the following "
            "waitForGone never clears, which reads exactly like a broken selector. "
            "Add: \"ready\": {\"testid\": \"<a testid only the booted app renders>\"} "
            "(or \"selector\"), optionally \"loadingTestid\" (default %r) and "
            "\"timeoutMs\" (default %d)."
            % (r.get("slug"), DEFAULT_LOADING_TESTID, READY_TIMEOUT_MS))
    picked = [k for k in ("testid", "selector") if ready.get(k)]
    if len(picked) != 1:
        raise Refuse(
            "bad_recipe",
            "recipe `ready` needs exactly one of `testid` or `selector`; got %s. "
            "Two anchors cannot both be the one thing that proves the app booted, "
            "and none is no gate at all." % (sorted(k for k in ready if not k.startswith("_")) or "nothing"))
    tmo = ready.get("timeoutMs", READY_TIMEOUT_MS)
    if not isinstance(tmo, int) or tmo <= 0:
        raise Refuse("bad_recipe",
                     "recipe `ready.timeoutMs` must be a positive integer of ms, got %r" % (tmo,))


def find_state(r, name):
    for s in r["states"]:
        if s["name"] == name:
            return s
    raise Refuse("unknown_state", "recipe %s has no state %r (has: %s)"
                 % (r["slug"], name, ", ".join(s["name"] for s in r["states"])))


# ----------------------------------------------------------------- guards --
def guard_page(observed):
    """🔴 RUNS FIRST. A 404 crops and frames exactly as well as a real app.

    🔴 THE REASON CODE STAYS `not_found` BECAUSE THE PAGE CANNOT SAY MORE.
    Several different conditions serve the SAME bytes at /apps/run/<slug>, so a
    per-cause reason here would be a SPELLED guard — a name for something this
    function cannot establish. The code names what was OBSERVED; the message
    carries the differential and hands over the read that settles it.

    That makes the message load-bearing, and until 2026-09-14 it named only two
    causes — logged-out and wrong-slug — and on that day BOTH were wrong.
    `custom-generators` and `gen-matrix` refused while `model-benchmarking` and
    `playable-collections` captured in the SAME session, the same minute, so the
    session was good and the slugs were right. The cause was
    `app_blocks.status = suspended`, deliberately set to hide an unfinished app
    from testers — 15 of that table's 24 rows, i.e. the COMMON case. The refusal
    was correct; its explanation sent the reader past the answer.
    """
    text = observed.get("topText", "")
    hits = [m for m in NOT_FOUND_MARKERS if m in text]
    if hits:
        raise Refuse(
            "not_found",
            "the page reads as a 404 (matched %s). THREE causes render this SAME page "
            "and its text cannot tell them apart: the app is SUSPENDED or not yet "
            "approved (the COMMON case — a suspended app 404s for a logged-in mod "
            "exactly like a nonexistent slug), the session is logged out, or the slug "
            "is wrong. A sibling recipe capturing fine in the same session already "
            "rules out logged-out. Read the status from the DB, not the page: "
            "`SELECT slug, status FROM app_blocks ORDER BY status, slug;` against the "
            "platform database (the infra repo's `manage-postgres` skill carries the "
            "connection recipe) — anything but `approved` means this refusal is "
            "CORRECT and no session or slug change will help. Refusing to capture an "
            "error page."
            % ", ".join(repr(h) for h in hits))
    out = [m for m in LOGGED_OUT_MARKERS if m in text]
    if out:
        raise Refuse(
            "logged_out",
            "the page shows logged-out chrome (matched %s). App Blocks are mod-gated; "
            "an anonymous session cannot reach them. Refusing to capture."
            % ", ".join(repr(o) for o in out))


def host_of(url):
    """Host component of a URL, without importing urllib's full machinery.

    🔴 STRUCTURAL, NOT SPELLED. Matching the frame by `frameHost in url` would
    also match `custom-generators.civit.ai.example.com` and every civitai.com
    page carrying the slug in its path — i.e. it would happily hand back the TOP
    frame, which is the exact failure mode guard 1 exists to prevent."""
    s = url.split("://", 1)[-1]
    s = s.split("/", 1)[0]
    s = s.split("@")[-1]
    return s.split(":")[0].lower()


def resolve_frame(observed, frame_host):
    frames = observed.get("frames") or []
    want = frame_host.lower()
    matches = [f for f in frames if host_of(f.get("url", "")) == want]
    if not matches:
        seen = ", ".join(host_of(f.get("url", "")) or "?" for f in frames) or "(none)"
        raise Refuse(
            "frame_absent",
            "no frame served by %s (frames present: %s). Apps boot slowly — right after "
            "`open` the top frame still reads 'Starting ...' and the app frame does not "
            "exist yet. Poll `frames` again (1-2 tries typical) and re-plan. Do NOT fall "
            "back to the top frame: top-frame selectors find nothing here."
            % (frame_host, seen))
    if len(matches) > 1:
        raise Refuse("frame_ambiguous",
                     "%d frames served by %s — cannot pick one deterministically"
                     % (len(matches), frame_host))
    fid = matches[0].get("frameId")
    if not isinstance(fid, int):
        raise Refuse("frame_bad_id", "frame for %s has no numeric frameId" % frame_host)
    return fid


# ------------------------------------------------------------------- steps --
class Planner:
    def __init__(self, observed, frame_id, trusted):
        self.g = []
        if observed.get("instance"):
            self.g += ["--instance", str(observed["instance"])]
        if observed.get("tabId") is not None:
            self.g += ["--tab", str(observed["tabId"])]
        self.frame_id = frame_id
        self.trusted = trusted
        self.steps = []

    def _add(self, op, argv, note, **extra):
        # 🔴 ONE LINE PER ARGV ELEMENT — a seam invariant, not a style rule.
        # capture.sh materialises a step's argv with `mapfile -t argv < <(...
        # print(a) ...)`, i.e. ONE ARRAY ELEMENT PER LINE. An argument holding a
        # newline is therefore silently split into several argv entries, and the
        # bridge is handed a fragment of a program plus some stray flags. The
        # error names an argument that appears nowhere in the source, so it reads
        # as a bridge bug. This is reachable the moment anyone edits the probe JS
        # in evidence.py, which is authored multi-line and flattened there.
        for a in argv:
            if "\n" in a or "\r" in a:
                raise Refuse(
                    "multiline_argv",
                    "step %r carries an argv element containing a newline. "
                    "capture.sh reads argv one element PER LINE (`mapfile -t`), "
                    "so this would be split into several arguments and the bridge "
                    "would be handed a fragment. Flatten it (evidence._one_line)."
                    % op)
        st = {"op": op, "argv": argv, "note": note}
        st.update(extra)
        self.steps.append(st)

    def emit_tab(self, op, tail, note, **extra):
        """A TAB-level bridge op — no --frame. `screenshot`, `wake`, `nav` and
        `activate` are the only ones that must not be frame-scoped, and that is
        enforced rather than asked for: this method takes an arbitrary op name,
        so `guard_dom_scoping` refuses any `DOM_OPS` member that reaches the
        assembled plan through here."""
        self._add(op, ["browser"] + self.g + [op] + tail, note, **extra)

    def emit_dom(self, op, tail, note, **extra):
        """The ONLY way to emit an op that touches app DOM. It always carries
        --frame, so guard 1 cannot be forgotten at a call site."""
        if self.frame_id is None:
            # The foreground plan is built BEFORE the app frame exists — that is
            # the point of it. A frame-scoped op there would be scoped to `None`.
            raise Refuse("frame_unresolved",
                         "a frame-scoped %r op was planned with no resolved frame id. "
                         "The foreground plan runs before the app frame exists and may "
                         "carry tab-level ops only." % op)
        self._add(op, ["browser"] + self.g + ["--frame", str(self.frame_id), op] + tail,
                  note, **extra)

    def wake(self, why, ms=WAKE_MS):
        # `wake` is refused with --frame by the bridge (wake_with_frame_unsupported),
        # so it is deliberately a tab-level op.
        self.emit_tab("wake", ["--wait", str(ms)], "un-throttle after %s" % why)


def guard_no_actuation(steps, trusted):
    """🔴 THE SPEND BAN, SEPARATED FROM THE FOREGROUND BAN THAT REPLACED IT.

    `browser activate` was admitted into the capture path (on a premise since
    retracted — see the module header rule 6), so "no activate outside
    --trusted" could not survive. What
    still must hold is that a capture cannot SPEND, and spending needs an
    OS-level event delivered to a focused control — `xdotool key`. This scans the
    ASSEMBLED plan, so it also catches an actuation step some future edit adds
    next to the activate, or one smuggled in through a recipe field. It is
    deliberately blind to `activate`: if it also banned that, the foreground plan
    could not exist and there would again be exactly one guard doing two jobs.
    """
    if trusted:
        return
    for st in steps:
        # op AND argv: a step can name the actuating tool in either, and a scan
        # of argv alone would pass a step merely LABELLED as one.
        blob = " ".join([st["op"]] + list(st["argv"]))
        hit = None
        for tok in ACTUATION_TOKENS:
            if tok in blob:
                hit = tok
        if hit:
            raise Refuse(
                "actuation_without_trusted",
                "step %r carries the ACTUATION token %r in a plan built WITHOUT "
                "--trusted. Foregrounding the tab (`activate`) is PERMITTED (not "
                "required — App Blocks boot hidden, 4/4), but an OS-level keypress "
                "or click is the thing that can fire a billable action, and `capture` "
                "never spends. Refusing to emit it." % (st["op"], hit))


def guard_dom_scoping(steps):
    """🔴 GUARD 1 AS A REFUSAL, NOT A CALL-SITE CONVENTION — and the second route
    to a TRUSTED event, which `guard_no_actuation` cannot see.

    `emit_dom` adds `--frame` so no call site has to remember to; that is why
    every DOM op in this file is correctly scoped today. But `emit_tab` takes an
    arbitrary op name, and nothing stopped a future edit emitting `click` through
    it. Until 2026-08-23 `DOM_OPS` was DECLARED and never read — the intent was
    written down and never became a code path, which is the shape that reads as
    coverage while providing none.

    🔴 WHY THIS IS A SAFETY GUARD AND NOT A CORRECTNESS ONE. The doc's reason for
    guard 1 is "top-frame selectors find nothing here", i.e. a wrong answer. The
    worse half is that they find something: the bridge dispatches a `--frame`
    op as a SYNTHETIC in-frame event (`trusted:false`, which the spend path
    rejects — that is the measured fact this skill's whole no-spend argument
    rests on), but a TOP-FRAME `click`/`key`/`type` goes through CDP
    `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`
    and is `trusted:true` — indistinguishable from a human's
    (`<devrc>/scripts/browser-bridge/extension/service_worker.js`, the `click`,
    `type` and `key` handlers). So an unscoped DOM op is a second way to deliver
    a trusted event, and it spells no `xdotool`: `guard_no_actuation` scans for
    ACTUATION_TOKENS and would pass it. The two guards do not overlap, and this
    one needs no exception — the ONE deliberate top-frame DOM op in this skill,
    the app-frame rect probe, is emitted by capture.sh and guarded by frame.py's
    `guard_rect_js`; it never passes through a plan.
    """
    for i, st in enumerate(steps):
        if st["op"] in DOM_OPS and "--frame" not in st["argv"]:
            raise Refuse(
                "dom_op_unscoped",
                "step %d is a %r op with no --frame. App Blocks render in a "
                "cross-origin iframe, so this addresses the HOST page: it reads "
                "the wrong document, and for click/type/key the bridge takes its "
                "CDP Input path there, which delivers a TRUSTED event the spend "
                "path does NOT reject. Emit it through `emit_dom`, which cannot "
                "forget the flag." % (i, st["op"]))


def guard_activate_placement(steps, trusted, mode, foreground=True):
    """🔴 FOREGROUNDING IS PERMITTED, AND ONLY WHERE IT IS REQUIRED.

    `guard_no_actuation` is deliberately blind to `activate` — that is what keeps
    the two guards from collapsing back into one (the blanket ban that made this
    skill structurally unable to capture anything). This is the OTHER half: an
    activate must be one of `ACTIVATE_REASONS`, and each reason has its own
    position, because the raised foreground is measured to last a median ~1.5 s:
    the `state` re-assert OPENS a state plan (the app-ready gate runs next), and
    a `pre-screenshot` one sits IMMEDIATELY before its capture, with the settle
    wake ahead of it
    rather than between them (gap 0: 3/3; a 4 s wake in between: 1/3).

    `mode` is which plan this is: a foreground plan may carry only the
    once-per-tab activate and no screenshot at all; a state plan may not carry
    that one, because foregrounding the tab happens before the app frame exists.
    `foreground` is the run's own --no-foreground switch: with it off, a state
    plan carries no activate at all and none is required.

    🔴 ONE REFUSAL CODE PER CLAUSE, AND THAT IS NOT COSMETIC. With a single shared
    code the clauses cover for each other: a mutant that deleted the POSITION
    check was still refused — by the COUNT check, with the same code — so the
    battery scored it SURVIVED while the suite happily reported a refusal. A kill
    has to name which clause did the killing, or the coverage it records does not
    exist. The six codes here are `activate_unplaced` (wrong reason, or a reason
    in the wrong KIND of plan), `activate_unverified` (nobody reads the bridge's
    i3 answer), `activate_unconsented` (a non-`spend` activate that does not say
    --no-focus out loud, and so leaves the i3 raise to be decided by the caller's
    stdio), `activate_misordered` (a pre-screenshot re-assert that is not
    adjacent to its capture), `activate_lead_misplaced` (a `state` re-assert that
    does not open the plan) and `activate_lead_missing` (a foregrounded state
    plan that carries none at all) — plus `activate_uncounted`, reachable only on
    a plan with more than one capture, which no shipped recipe produces; gate G11
    exercises those last two through the module API rather than pretending a
    recipe can reach them.
    """
    ops = [s["op"] for s in steps]
    n_shots = ops.count("screenshot")
    n_pre = 0
    n_lead = 0
    for i, s in enumerate(steps):
        why = s.get("foreground")
        if why is not None and s["op"] != "activate":
            raise Refuse("activate_unplaced",
                         "step %r is marked foreground=%r but is not an `activate` "
                         "— the marker is what the placement guard reads, so it "
                         "may not travel on anything else." % (s["op"], why))
        if s.get("verifyForeground") is not None and s["op"] != "activate":
            raise Refuse("activate_unplaced",
                         "step %r carries verifyForeground but is not an `activate`"
                         % s["op"])
        if s["op"] != "activate":
            continue
        # 🔴 EVERY activate IS CHECKED AGAINST THE BRIDGE'S OWN ANSWER. `activate`
        # raises the tab inside Brave and asks the host to raise the WINDOW via
        # i3-msg, and that second half is best-effort: it reports
        # applied/skipped/failed and, until now, nobody read it. A `failed` there
        # means a step this run DECLARED did not happen, which is what makes the
        # rest of the run unattributable. (It used to say "the tab stays hidden
        # and the app deadlocks" — RETRACTED 2026-08-24, App Blocks boot hidden.
        # 🔴 There is a FOURTH value the docs still omit: `withheld`, which is
        # what the bridge answers when a command sends --no-focus, and which
        # every capture-path activate therefore gets. (NOT what it answers on a
        # merely OMITTED flag — the CLI defaults that ON for a TTY; see
        # NO_FOCUS_ARG.) 🔴 THAT IS THE i3 HALF ONLY — `activate` still makes the tab the
        # ACTIVE TAB of its Brave window. Do not read "withheld" as "activate
        # does nothing": the tab-activation half is precisely what routes the
        # capture onto the captureVisibleTab fast path.)
        if s.get("verifyForeground") != "i3":
            raise Refuse(
                "activate_unverified",
                "the `activate` step at %d does not ask capture.sh to read the "
                "bridge's own i3 outcome. Foregrounding the tab inside Brave is "
                "not the same as raising the operator's WINDOW/workspace, and a "
                "step that declares a foreground it never verifies is a guard "
                "reporting coverage it does not have." % i)
        if why not in ACTIVATE_REASONS:
            raise Refuse(
                "activate_unplaced",
                "an `activate` step declares foreground=%r, which is not one of "
                "%s. Foregrounding can move the operator's focus (the host-side "
                "i3 raise is withheld when a step sends --no-focus, but the extension's own "
                "windows.update{focused:true} is not gated), so every one of "
                "them has to say which of the four declared reasons it is."
                % (why, ", ".join(ACTIVATE_REASONS)))
        # 🔴 CONSENT IS DECLARED, NOT INHERITED FROM STDIO. The bridge CLI turns
        # the host-side i3 raise ON when stdout is a TTY, so OMITTING the flag
        # does not withhold the raise — it delegates the decision to how the
        # caller happened to be invoked. Measured 2026-08-28: the same argv sends
        # "focus":false through a command substitution and "focus":TRUE through a
        # PTY. Every capture-path activate therefore says --no-focus out loud.
        # `spend` is EXEMPT and that is deliberate: a trusted OS keypress needs
        # Brave genuinely forward, so what that step should ask for is an OPEN
        # question (see plan_spend) and this guard must not settle it by default.
        if why != "spend" and NO_FOCUS_ARG not in s["argv"]:
            raise Refuse(
                "activate_unconsented",
                "the `activate` step at %d (foreground=%r) does not carry %s. "
                "Omitting it does NOT withhold the host-side i3 raise: the bridge "
                "CLI defaults the flag to ON when stdout is a TTY, so the raise "
                "would then depend on how capture.sh happened to be invoked "
                "rather than on anything this plan declares. Say it out loud."
                % (i, why, NO_FOCUS_ARG))
        if why == "tab" and mode != "foreground":
            raise Refuse("activate_unplaced",
                         "the once-per-tab foregrounding activate appears in a "
                         "STATE plan. It belongs to the foreground plan, which "
                         "runs before the app frame exists.")
        if why == "state":
            n_lead += 1
            if mode != "state":
                raise Refuse("activate_unplaced",
                             "a `state` re-assert appears in a %s plan. It exists "
                             "to raise the window for ONE state's app-ready gate "
                             "and actions, and there is no such gate here."
                             % mode)
            # 🔴 BEFORE EVERYTHING THAT NEEDS THE WINDOW — stated as that, not as
            # "index 0". A raise that lands after the app-ready gate has already
            # timed out has held nothing, whatever it is that the raise buys.
            # (Semantic rather than
            # positional so that an unrelated step prepended by some other edit
            # is refused by ITS own guard rather than by this one — a clause that
            # fires on the wrong thing records coverage that does not exist.)
            served = [x["op"] for x in steps[:i]
                      if x["op"] in ("wake", "screenshot", "nav")
                      or "--frame" in x["argv"]]
            if served:
                raise Refuse(
                    "activate_lead_misplaced",
                    "the `state` foreground re-assert is at step %d, AFTER %s. It "
                    "must lead everything that needs the window, because the "
                    "app-ready gate runs immediately after it and a raise that "
                    "lands once that gate has timed out has held nothing." % (i, served))
        if why == "pre-screenshot":
            n_pre += 1
            if ops[i + 1:i + 2] != ["screenshot"]:
                raise Refuse(
                    "activate_misordered",
                    "the pre-screenshot `activate` at step %d is followed by %s, "
                    "not by the screenshot itself. The load-bearing quantity is the "
                    "GAP between the raise and the capture — measured 3/3 at gap 0 "
                    "and 1/3 with a 4 s wake in between, because the raised "
                    "foreground survives a median ~1.5 s. The settle wake belongs "
                    "BEFORE the raise, not between them."
                    % (i, ops[i + 1:i + 2] or "nothing"))
        if why == "spend" and not trusted:
            raise Refuse("activate_unplaced",
                         "the spend path's `activate` appears in a plan built "
                         "without --trusted.")
    if mode == "foreground" and n_shots:
        raise Refuse("activate_unplaced",
                     "the foreground plan carries a screenshot; it runs before the "
                     "app frame exists and photographs a booting page.")
    # 🔴 THE CLAUSE THAT CATCHES DEFECT 1. The re-assert used to be emitted inside
    # `if screenshot:`, so an `--evidence --no-frame` run — the defect-hunting run
    # this skill exists to enable — planned ZERO activates per state and relied on
    # a once-per-tab foregrounding that outlives nothing: measured live, state 1
    # booted and state 2 came back `exit 11` CONFOUND. A screenshot-free run needs
    # the window MORE, not less: it still boots an App Block and still drives it.
    if mode == "state" and foreground and n_lead != 1:
        raise Refuse(
            "activate_lead_missing",
            "this state plan carries %d `state` foreground re-assert(s), not 1. "
            "Every state reloads the app and must raise the window before its "
            "app-ready gate — including a run that takes no screenshot at all, "
            "which is exactly the run that lost it (an --evidence --no-frame run "
            "planned zero activates and CONFOUNDed on its second state)." % n_lead)
    if n_pre and n_pre != n_shots:
        raise Refuse(
            "activate_uncounted",
            "%d pre-screenshot activate(s) for %d screenshot(s). Every capture "
            "needs its own re-assert: foregrounding once per tab is what was "
            "measured NOT to survive to the capture." % (n_pre, n_shots))


def guard_injected_js(js, what, code):
    """🔴 ANY JS WE INJECT MAY OBSERVE AND MUST NOT ACTUATE — the probe and the
    app-ready gate alike. The ready probe interpolates a selector that comes from
    a RECIPE, so the scan runs over the RENDERED source, not over the template."""
    for tok in evidence.PROBE_FORBIDDEN:
        if tok in js:
            raise Refuse(
                code,
                "the %s contains %r, which can ACTUATE the app. capture never "
                "spends and never mutates: injected JS may read the DOM and hook "
                "console/fetch/XHR, and nothing else. Refusing to inject it."
                % (what, tok))


def ready_verdict(anchor_present, loading_present, visible):
    """🔴 THE DECISION THE INJECTED PROBE MAKES, IN PYTHON — the single source of
    truth `ready_js` renders into JS, and the only form of it a test can execute.

    🔴 THE MARKUP IS ASKED FIRST, AND VISIBILITY ONLY BREAKS THE TIE. Until
    2026-08-19 this short-circuited on `document.visibilityState !== "visible"`
    BEFORE looking at any markup, on the theory that a hidden tab's anchor state
    could not be evidence about the anchor. Measured live: panorama-360 reported
    `visibilityState: hidden` while rendering 16 testids and no `app-loading`, and
    accepted a click that changed the prompt — a booted, fully drivable app that
    the gate refused. So a present anchor is believed whatever the tab says.

    HIDDEN is still emitted, and still carries the whole CONFOUND diagnosis — but
    only for the case it can actually speak about: the anchor is ABSENT *and* the
    tab is not visible, i.e. the read that cannot tell "wrong anchor" from "this
    window was never raised". It is deliberately NOT `xdotool getactivewindow` —
    that token is refused in any plan built without --trusted, and a detector that
    has to be smuggled past the actuation ban is not one this skill may have.
    """
    if anchor_present and not loading_present:
        return READY_TOKEN_READY
    if not anchor_present and not visible:
        return READY_TOKEN_HIDDEN
    return READY_TOKEN_LOADING if loading_present else READY_TOKEN_ABSENT


def ready_js(anchor_sel, loading_sel):
    """One line, one bare token back. No `//` comments — see evidence._one_line.

    Renders `ready_verdict` — same order, same tokens. Gate G3 executes both and
    requires them to agree on all 8 combinations of (anchor, loading, visible).
    """
    return ('(function(){var d=document;'
            'var A=!!d.querySelector(%s);'
            'var L=!!d.querySelector(%s);'
            'var V=d.visibilityState==="visible";'
            'if(A&&!L)return "%s";'
            'if(!A&&!V)return "%s";'
            'return L?"%s":"%s"})()'
            % (json.dumps(anchor_sel), json.dumps(loading_sel),
               READY_TOKEN_READY, READY_TOKEN_HIDDEN,
               READY_TOKEN_LOADING, READY_TOKEN_ABSENT))


def plan_ready(p, recipe):
    """🔴 BEFORE THE FIRST ACTION OF EVERY STATE, actions or not.

    A state whose first action fires into a still-booting app renders a timeout on
    the NEXT wait, naming the dismiss button — a defect report about the wrong
    component. This step polls until the loading shell is gone AND the recipe's
    anchor is present, and `appReady` tells capture.sh which sentence to print
    when it does not arrive.

    🔴 RETRACTED 2026-08-24 — this gate used to justify itself with "an App Block
    in a hidden tab deadlocks on BLOCK_INIT (5/5, 2026-08-17)". It does boot
    hidden: 4/4, one with no `activate` at all. The gate is still right, for the
    reason above; only its old mechanism story was wrong.
    the private infra repo's hidden-tab-boot write-up (2026-08-24)
    """
    r = recipe["ready"]
    loading = '[data-testid="%s"]' % r.get("loadingTestid", DEFAULT_LOADING_TESTID)
    anchor = ('[data-testid="%s"]' % r["testid"]) if r.get("testid") else r["selector"]
    tmo = int(r.get("timeoutMs", READY_TIMEOUT_MS))
    js = ready_js(anchor, loading)
    guard_injected_js(js, "app-ready probe", "ready_actuates")
    p.emit_dom("js", [js],
               "APP-READY GATE: poll until %s is gone AND %s is present — a first "
               "action fired into a still-booting app is silently thrown away, and "
               "the NEXT wait then times out naming the wrong control" % (loading, anchor),
               expect=READY_TOKEN_READY, timeoutMs=tmo,
               appReady="loading=%s anchor=%s" % (loading, anchor))


def build_foreground(recipe, observed):
    """Bring the capture tab into the real foreground before the app boots.

    🔴 RETRACTED 2026-08-24 — THE PREMISE THIS FUNCTION WAS BUILT ON IS FALSE.
    It read "the tab must be in the real foreground or the app never boots",
    from a 2026-08-17 model-benchmarking run where a hidden tab deadlocked 5/5
    on BLOCK_INIT. Re-measured: an App Block boots hidden, 4/4, one of them with
    no `activate` at all. The 5/5 is not explained, and is not evidence for the
    requirement.

    🔴 AND THE HOST-SIDE RAISE IS WITHHELD ANYWAY — but `activate` is NOT a no-op.
    It does THREE things and only ONE is suppressed: it makes the tab the ACTIVE
    TAB of its Brave window (this HAPPENS); it calls
    `chrome.windows.update({focused: true})`, which the consent gate does NOT
    cover and which i3's default `smart` grants for a window already on the
    ACTIVE workspace (unmeasured — see the module header); and it asks the host
    to raise the operator's i3 window (`i3: "withheld", i3_detail: "not_requested"` without
    `--focus`, which capture.sh never passes — the bridge defaults the raise to
    "yes iff stdout is a TTY" and an agent is on a pipe).

    🔴 That distinction is load-bearing in the wrong direction: the tab-activation
    half is what routes the capture onto `chrome.tabs.captureVisibleTab`, i.e.
    the path that hangs. A tab left NON-active takes CDP instead — measured 3/3,
    identical geometry — so this plan is not merely inert, it steers toward the
    failing path. See conclusion 4 of the occlusion refutation.

    It is kept because `ACTIVATE_REASONS`, gate G11 and mutants M59-M64 describe
    the shipped design and removing it is optional cleanup, NOT a fix — do not
    reason about it as load-bearing. The 4/4 hidden boot is measured in
    the private infra repo's hidden-tab-boot write-up (2026-08-24);
    that doc is also explicit that it tested BOOT only, never the screenshot path.

    This plan carries NO frame-scoped step (the app frame need not exist yet) and
    no actuation — `guard_no_actuation` is asserted over it, without --trusted.
    """
    validate_recipe(recipe)
    p = Planner(observed, None, False)
    p.emit_tab("activate", ["--wait", str(WAKE_MS), NO_FOCUS_ARG],
               "FOREGROUND the capture tab — it becomes its window's ACTIVE TAB. "
               "Whether the operator's WINDOW is also raised is the separate i3 half, "
               "and the `i3=` line below reports what actually happened (this step "
               "passes --no-focus, so expect `withheld`). RETRACTED: this is NOT what "
               "makes the App Block boot (they boot hidden, 4/4)",
               foreground="tab", verifyForeground="i3")
    p.wake("foregrounding", WAKE_MS)
    guard_no_actuation(p.steps, False)
    guard_dom_scoping(p.steps)
    guard_activate_placement(p.steps, False, "foreground")
    return {
        "slug": recipe["slug"],
        "state": None,
        "mode": "foreground",
        "frameId": None,
        "frameHost": recipe["frameHost"],
        "trusted": False,
        "evidence": False,
        "truncatedAtNav": False,
        "steps": p.steps,
        "warnings": [
            "FOREGROUNDING the capture tab with `browser activate`: it makes the "
            "tab its window's ACTIVE tab, and separately ASKS the host to raise "
            "the operator's window. This step sends --no-focus, so that second "
            "half is normally `withheld` — but read the run's own `i3=` line "
            "rather than assuming it. This is NOT the spend path — no actuation "
            "step (xdotool / trustedKey) can appear in any plan built without "
            "--trusted, which plan.py refuses separately.",
        ],
    }


def guard_probe_js():
    """🔴 THE PROBE MAY OBSERVE AND MUST NOT ACTUATE.

    It is our own code, running in the MAIN world of a live, logged-in,
    mod-gated app (measured 2026-08-17 — a frame-scoped `js` in a cross-origin
    App Block frame shares the page's main world, which is exactly why console
    hooking works at all). One synthetic click in there is one unintended
    action on a real account, and `capture` is the verb that never spends.

    So the ban is a CHECK on the source, evaluated every time a plan that would
    inject it is built — not a comment in evidence.py that a later edit can
    quietly falsify. It is a cross-file seam: the source lives in one module and
    the decision to inject it lives in this one.
    """
    for js in (evidence.PROBE_INSTALL_JS, evidence.PROBE_DRAIN_JS):
        guard_injected_js(js, "observer probe", "probe_actuates")


def plan_evidence_install(p, state):
    """🔴 INSTALLED BEFORE THE FIRST ACTION, NEVER AFTER.

    The probe hooks `console.*`, `fetch` and `XMLHttpRequest` by wrapping them.
    A wrapper only sees calls made AFTER it is in place, so installing it after
    the state's actions would report a clean console for a state whose actions
    logged the very error we are hunting — the reassuring-zero failure, with the
    zero produced by ordering rather than by the app.
    """
    p.emit_dom("js", [evidence.PROBE_INSTALL_JS],
               "install the observer probe (console + fetch/XHR + error events + "
               "resource timing) BEFORE any action — a hook sees only what happens "
               "after it exists",
               probe="install", expectValue=True)


def plan_evidence_read(p, state):
    """The DOM and the drain, AFTER the screenshot, so the artifact and the
    picture describe the same moment."""
    # 🔴 --max-bytes 0. The bridge's `html` default cap is 32768 and a real App
    # Block DOM measured 38,758 bytes, so the DEFAULT read silently loses the
    # tail — under-reporting every testid and every a11y violation while looking
    # entirely normal. evidence.py refuses a DOM carrying the truncation marker;
    # this is the other half of that pair.
    p.emit_dom("html", ["--max-bytes", "0"],
               "read the app frame's rendered DOM UNCAPPED (the 32768-byte default "
               "would truncate it and under-report everything)",
               captureDom=state["name"])
    p.emit_dom("js", [evidence.PROBE_DRAIN_JS],
               "drain the probe: console messages, failed requests, hook status",
               captureProbe=state["name"], probe="drain")


def plan_state(recipe, state, observed, frame_id, trusted, evidence_mode=False,
               screenshot=True, foreground=True):
    p = Planner(observed, frame_id, trusted)
    warnings = []

    # 🔴 EVERY STATE OPENS BY RE-ASSERTING THE FOREGROUND, SCREENSHOT OR NOT.
    # capture.sh reloads the app before every state, so every state boots an App
    # Block again. This used to live inside `if screenshot:`, which left the
    # `--evidence --no-frame` run — the defect-hunting run, the one this whole
    # path exists for — with no activate anywhere in any state plan.
    #
    # 🔴 RETRACTED 2026-08-24: the justification was "an App Block does not boot
    # while its window is occluded". It boots hidden (4/4). What actually
    # motivated the move is the OBSERVATION in `activate_lead_missing` below —
    # a screenshot-free run planned zero activates and CONFOUNDed on its second
    # state — and that observation stands on its own. Note the HOST-SIDE raise is
    # withheld today (`i3: withheld`), so a WORKSPACE change cannot be what fixed
    # it; the cause of that CONFOUND is UNIDENTIFIED. (The tab-activation half
    # DOES still happen, so "inert" would be the wrong word here.) Placement is
    # kept as the shipped design.
    if foreground:
        p.emit_tab("activate", list(REFOCUS_ARGS),
                   "RE-ASSERT THE FOREGROUND for this state, before the app-ready "
                   "gate — this state reloads the app (a screenshot-free evidence "
                   "run needs this just as much: it still boots and drives the app). "
                   "NOTE: this step passes --no-focus, so the i3 WINDOW raise is "
                   "withheld; the tab still becomes its window's active tab",
                   foreground="state", verifyForeground="i3")

    if evidence_mode:
        guard_probe_js()
        # 🔴 A `nav` INVALIDATES THE FRAME ID (guard 2), so the plan stops there
        # — which means the DOM read and the drain would never be emitted and the
        # state would come back with NO evidence at all, silently. A missing
        # artifact reads as "nothing to report". Refuse instead: split the state,
        # or drop the nav.
        for a in state.get("actions", []):
            if "nav" in a:
                raise Refuse(
                    "evidence_after_nav",
                    "state %r navigates, and a nav ENDS the plan because the frame "
                    "id changes on every load. Under --evidence the DOM read and "
                    "the probe drain come after the actions, so they would never "
                    "be emitted and this state would produce no artifact at all — "
                    "which reads exactly like a clean run. Split the state at the "
                    "nav, or remove it." % state["name"])
        plan_evidence_install(p, state)

    # 🔴 AFTER the probe install (so a boot-time console error is still captured),
    # BEFORE the first action (so no action races the app's own boot).
    plan_ready(p, recipe)

    for a in state.get("actions", []):
        verb = [k for k in a if k in KNOWN_ACTIONS][0]

        if verb == "click":
            p.emit_dom("click", [a["click"]], "click %s" % a["click"])
            p.wake("click")
        elif verb == "clickIfPresent":
            # 🔴 THE SAME BRIDGE OP, WITH THE ABSENCE DECLARED. It is emitted as an
            # ordinary frame-scoped `click` — this is NOT an injected-JS click,
            # which would have to smuggle `.click(` past the actuation ban and put
            # a synthetic activation into the main world of a live account.
            # `optional` is the whole difference, and capture.sh BRANCHES on it:
            # without the key a bridge `element_not_found` fails the state, with it
            # the step is skipped and the run continues.
            #
            # It exists for a control whose presence depends on PROFILE HISTORY,
            # not on app state: model-benchmarking's how-to panel is dismissed
            # once and stays dismissed across reloads, so a fresh profile needs
            # the click and every later run must not require it. Deleting the
            # click would break the fresh profile; leaving it unmarked makes every
            # stale selector in the corpus silent.
            p.emit_dom("click", [a["clickIfPresent"]],
                       "click %s IF PRESENT — a bridge `element_not_found` here is "
                       "a supported outcome, not an action failure (the control's "
                       "presence depends on profile history)" % a["clickIfPresent"],
                       optional=True)
            p.wake("clickIfPresent")
        elif verb == "type":
            tail = [a["type"]]
            if a.get("selector"):
                tail += ["--selector", a["selector"]]
            p.emit_dom("type", tail, "type into %s" % a.get("selector", "focused element"))
            p.wake("type")
        elif verb == "key":
            tail = [a["key"]]
            if a.get("selector"):
                tail += ["--selector", a["selector"]]
            p.emit_dom("key", tail, "key %s" % a["key"])
            p.wake("key")
        elif verb == "waitForText":
            p.emit_dom("text", [], "poll until %r appears" % a["waitForText"],
                       expect=a["waitForText"],
                       timeoutMs=a.get("timeoutMs", 20000))
        elif verb == "waitForGone":
            p.emit_dom("text", [], "poll until %r is gone" % a["waitForGone"],
                       expectAbsent=a["waitForGone"],
                       timeoutMs=a.get("timeoutMs", 20000))
        elif verb == "sleep":
            p._add("sleep", [], "wait %d ms" % a["sleep"], ms=a["sleep"])
        elif verb == "nav":
            # 🔴 Guard 2. A navigation invalidates the frame id, so the plan STOPS
            # here rather than emitting steps against an id that no longer exists.
            p.emit_tab("nav", [a["nav"], "--wake=%d" % WAKE_MS],
                       "navigate (this INVALIDATES the frame id)")
            p._add("reobserve", [], "RE-OBSERVE: re-run `frames` and re-plan. The frame "
                                    "id changes on every load and must never be cached "
                                    "across a navigation.", terminal=True)
            return p.steps, warnings, True
        elif verb == "trustedKey":
            emit_trusted(p, a, recipe, trusted, warnings)
        else:  # pragma: no cover - validate_recipe rejects unknown verbs first
            raise Refuse("bad_recipe", "unhandled verb %r" % verb)

    # 🔴 GUARD 8: A SCREENSHOT IS AN OUTPUT, NOT A STEP OF THE RECIPE. It used to
    # be emitted unconditionally, and `plan_evidence_read` ran AFTER it — so on an
    # `--evidence --no-frame` run, where the picture is discarded the moment it is
    # written, a bridge-side screenshot failure took the DOM read and the drain
    # down with it and the run died with "THE ACTION FAILED ... the app WAS
    # booted". A recipe action had not failed; nothing about the app had. It
    # killed two live runs. When the caller is not going to keep the picture, do
    # not take one.
    if screenshot:
        # 🔴 Guard 4: settle FIRST. The settle wake belongs BEFORE the raise, not
        # between the raise and the capture — measured 2026-08-19: raise then
        # capture immediately, 3/3 OK (~280 ms); raise, wait 4 s (the settle wake),
        # then capture, 1/3. The raised foreground survives a median ~1.5 s, so a
        # 4 s wake in the gap means the capture happens ~2.5 s after it is gone.
        p.wake("the last action, before capturing", SETTLE_MS)
        # 🔴 GUARD 9: RE-ASSERT THE FOREGROUND IMMEDIATELY BEFORE THE CAPTURE.
        # 🔴 RETRACTED 2026-08-24 — "OCCLUSION is the discriminator, not focus"
        # is FALSE. The 18.1 s hang reproduced with the window on a non-visible
        # workspace and NOTHING drawn on top, twenty minutes after the same
        # window/tab captured 3/3. Real cause: `chrome.tabs.captureVisibleTab`
        # can HANG rather than reject, so the fast path's `catch` — whose job is
        # to fall through to CDP — never ran and the op burned the whole 18 s
        # EXEC_OP_BUDGET_MS. The timeouts pinned at 18.07-18.11 s (the ceiling,
        # not a natural error latency) and one arm RETURNED via captureVisibleTab
        # at 17.97 s, which is the same phenomenon landing just inside the bound.
        # ✅ Fixed in the BRIDGE, not here: devrc #797 bounds the fast path at
        # FAST_CAPTURE_BUDGET_MS (1500 ms) so "never settles" becomes a rejection
        # the existing catch can act on.
        #
        # What SURVIVES from the 2026-08-19 sweep is the GAP, which is why this
        # step still sits at gap 0: a raise held 4 s before the capture recovered
        # 1/3 where a raise at gap 0 recovered 3/3. Treat those as indicative —
        # they are one-shot arms on a primitive now known to be flaky.
        if foreground:
            p.emit_tab("activate", list(REFOCUS_ARGS),
                       "RE-ASSERT THE FOREGROUND for this capture, with NOTHING "
                       "between it and the screenshot — a raise held for 4 s before "
                       "the capture recovered 1/3 where a raise at gap 0 recovered "
                       "3/3. NOTE: this step passes --no-focus, so the i3 WINDOW "
                       "raise is withheld, but the tab IS made active — which routes this "
                       "capture onto the captureVisibleTab fast path whose 18.1 s "
                       "hang was fixed in the bridge (devrc #797), not here",
                       foreground="pre-screenshot", verifyForeground="i3")
        # 🔴 Guard 5: a PATHLESS screenshot.
        p.emit_tab("screenshot", [], "capture the tab — NO path argument: the bridge writes "
                                     "its own temp file and prints {path}; passing a path is "
                                     "auto-REJECTED under opencode's external_directory rule",
                   capture=state["name"])
    if evidence_mode:
        plan_evidence_read(p, state)
    return p.steps, warnings, False


def emit_trusted(p, a, recipe, trusted, warnings):
    sel = a["trustedKey"]
    key = a.get("keyName", "Return")
    if not trusted:
        raise Refuse(
            "trusted_required",
            "state uses `trustedKey` on %r, which is the SPEND path: it takes the "
            "operator's screen (browser activate) and fires a real, billable action. "
            "It is unreachable without the explicit --trusted flag. Re-run with "
            "--trusted only if spending is intended." % sel)
    if "verifyBalanceDelta" in a:
        raise Refuse(
            "balance_verification",
            "action verifies the spend with a Buzz-balance delta. That is WRONG: some "
            "apps bill per GPU second ON COMPLETION, so the balance does not move at "
            "submission and a working run reads as a failure. Use `verifyLabel` — the "
            "control's own state label, e.g. 'Rendering...'.")
    if not a.get("verifyLabel"):
        raise Refuse(
            "no_verify_label",
            "a `trustedKey` action must carry `verifyLabel`: the control's own state "
            "label after firing (e.g. 'Rendering...'). Without it the run cannot tell a "
            "fired spend from a swallowed one — and a Buzz-balance delta will not tell "
            "you either.")
    warnings.append(
        "TRUSTED/SPEND PATH ENABLED for %s: it fires a real billable action on %s, "
        "and it drives the SCREEN with `xdotool` (a trusted keypress, then a "
        "windowactivate to give the screen back). 🔴 NOTE the `activate` in this "
        "sequence is emitted with NO --focus, so its host-side i3 raise is "
        "WITHHELD like every other one — what Brave gets is the tab-active change "
        "plus the ungated windows.update{focused:true}. Whether that is enough to "
        "put the keypress on Brave is UNMEASURED; the restore at the end is what "
        "bounds the damage if it is not." % (sel, recipe["slug"]))

    focus_js = ("(function(){var e=document.querySelector(%s);"
                "if(!e)return 'no-element';e.focus();"
                "return document.activeElement===e})()" % json.dumps(sel))
    # 1. focus in-frame and VERIFY document.activeElement really is that element
    p.emit_dom("js", [focus_js], "focus the control and verify activeElement",
               expectValue=True)
    # 2. remember the operator's window BEFORE stealing the screen
    p._add("xdotool", ["xdotool", "getactivewindow"],
           "record the currently focused X window so it can be restored",
           captureVar="PREV_WINDOW")
    # 3. the one intrusive op
    # 🔴 THE ONE activate THAT `activate_unconsented` EXEMPTS, AND THE
    # EXEMPTION IS THE POINT. Everywhere else a capture-path activate now says
    # --no-focus out loud, because omitting the flag delegates the i3 raise to the
    # caller's stdio (the CLI defaults it ON for a TTY). Here the flag is omitted
    # and NOT replaced, because this step is the one place where a raise may be
    # WANTED: a trusted OS keypress needs Brave genuinely forward, and the bridge's
    # own CLI says a script that wants the screen should ask with --focus. Which of
    # the two this should send is an OPEN QUESTION on a spend path — settling it by
    # default in either direction is a behaviour change nobody has measured, so the
    # guard declines to. What holds today: with no flag, capture.sh's command
    # substitution puts "focus":false on the wire, so the i3 raise IS withheld here
    # too — by accident of stdio, not by declaration.
    # The older note called this step "the one intrusive op" and said it STEALS THE
    # SCREEN; that mis-attributes the intrusion — the ops that actually drive the
    # screen are the xdotool pair below. Do not read this step as guaranteeing
    # Brave is focused when the keypress lands.
    p.emit_tab("activate", [],
               "bring Brave forward for the trusted keypress — required because the "
               "money path rejects synthetic events. NOTE: this is the ONE activate "
               "that sends no focus flag (see the comment above — what a spend path "
               "should ask for is unsettled), so the i3 raise is withheld only "
               "because capture.sh runs ops on a pipe; focus rests on the ungated "
               "windows.update, which is UNMEASURED. The xdotool restore bounds that",
               foreground="spend", verifyForeground="i3")
    # 4. re-focus: activation can move focus
    p.emit_dom("js", [focus_js], "re-focus after activation (activation can move focus)",
               expectValue=True)
    # 5. the trusted keypress itself. NOT a coordinate click: the maths spans an
    #    iframe offset plus window chrome and a mis-aimed trusted click in a live
    #    browser can hit anything.
    p._add("xdotool", ["xdotool", "key", "--clearmodifiers", key],
           "trusted OS keypress on the focused control")
    # 6. give the screen back IMMEDIATELY
    p._add("xdotool", ["xdotool", "windowactivate", "$PREV_WINDOW"],
           "restore the operator's window immediately", usesVar="PREV_WINDOW")
    # 7. verify by the control's OWN label
    p.emit_dom("text", [], "confirm the spend fired by the control's own state label",
               expect=a["verifyLabel"], timeoutMs=a.get("timeoutMs", 30000))


# -------------------------------------------------------------------- main --
def build(recipe, observed, state_name, trusted, evidence_mode=False,
          screenshot=True, foreground=True):
    validate_recipe(recipe)
    if not screenshot and not evidence_mode:
        # 🔴 A PLAN THAT PRODUCES NOTHING IS NOT A CHEAPER PLAN. Dropping the
        # screenshot is only meaningful when something else is being collected;
        # without --evidence this would drive the app and keep no record of it,
        # and a run with no output reads exactly like a run that worked.
        raise Refuse(
            "no_output",
            "--no-screenshot was given without --evidence, so this plan would "
            "drive the app and produce NO artifact of any kind. Drop "
            "--no-screenshot (a store shoot needs the picture) or add --evidence "
            "(a defect run keeps the DOM, console, network and a11y instead).")
    guard_page(observed)
    st = find_state(recipe, state_name)
    frame_id = resolve_frame(observed, recipe["frameHost"])
    steps, warnings, truncated = plan_state(recipe, st, observed, frame_id, trusted,
                                            evidence_mode, screenshot, foreground)
    # 🔴 THE POST-CONDITION, over the ASSEMBLED plan — not a promise made at each
    # call site. Without --trusted, nothing that can deliver an OS-level event to
    # a focused control may survive into the output.
    guard_no_actuation(steps, trusted)
    guard_dom_scoping(steps)
    guard_activate_placement(steps, trusted, "state", foreground)
    out = {
        "slug": recipe["slug"],
        "state": st["name"],
        "frameId": frame_id,
        "frameHost": recipe["frameHost"],
        "trusted": bool(trusted),
        "evidence": bool(evidence_mode),
        "screenshot": bool(screenshot),
        "foreground": bool(foreground),
        "truncatedAtNav": truncated,
        "steps": steps,
    }
    if st.get("caption"):
        out["caption"] = st["caption"]
    if warnings:
        out["warnings"] = warnings
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="plan.py")
    ap.add_argument("recipe")
    ap.add_argument("--observed", required=True,
                    help="JSON file of observed browser state, or '-' for stdin")
    ap.add_argument("--state", help="state name (default: every state, planned "
                                    "independently — each needs its own re-observe)")
    ap.add_argument("--trusted", action="store_true",
                    help="unlock the SPEND path. Never a default. Takes the screen.")
    ap.add_argument("--evidence", action="store_true",
                    help="also capture machine-analysable evidence: install the "
                         "observer probe before the actions, then read the DOM and "
                         "drain the probe after the screenshot. Adds no spend path.")
    ap.add_argument("--no-screenshot", action="store_true",
                    help="plan no screenshot for this state. For an --evidence run "
                         "whose caller discards the picture (capture.sh --no-frame): "
                         "a bridge-side screenshot failure must not be able to "
                         "destroy the DOM read and the probe drain that come after "
                         "it. Refused without --evidence — the plan would then "
                         "produce nothing at all.")
    ap.add_argument("--no-foreground", action="store_true",
                    help="omit every foreground re-assert (the one that opens the "
                         "state and the one before the capture). Diagnostics only, "
                         "and the mirror of capture.sh's own --no-foreground. NOTE: "
                         "this is NOT merely cosmetic — the i3 window raise is "
                         "withheld anyway, but `activate` also makes the tab its "
                         "window's ACTIVE tab, and an active tab is what takes the "
                         "captureVisibleTab path. On the TAB-OPENING path omitting "
                         "it leaves the tab background, which takes CDP instead "
                         "(n=3, indicative) — but a --tab the operator already has "
                         "in front is ALREADY active, so this flag changes nothing "
                         "there. Not a cure either way: the hang was fixed in the "
                         "bridge (devrc #797).")
    ap.add_argument("--foreground-plan", action="store_true",
                    help="emit ONLY the two steps that bring the capture tab into "
                         "the real foreground. Carries no frame-scoped step and no "
                         "actuation.")
    a = ap.parse_args(argv)
    try:
        with open(a.recipe) as fh:
            recipe = json.load(fh)
        src = sys.stdin.read() if a.observed == "-" else open(a.observed).read()
        observed = json.loads(src)
        if a.foreground_plan:
            if a.trusted:
                raise Refuse("bad_usage",
                             "--foreground-plan is the NON-spend path and takes no "
                             "--trusted: foregrounding is not actuation, and mixing "
                             "the two flags is how they stop being separable.")
            if a.no_foreground or a.no_screenshot:
                raise Refuse("bad_usage",
                             "--foreground-plan emits the foregrounding step and "
                             "nothing else; --no-foreground / --no-screenshot are "
                             "state-plan flags and mean nothing here.")
            out = build_foreground(recipe, observed)
        elif a.state:
            out = build(recipe, observed, a.state, a.trusted, a.evidence,
                        not a.no_screenshot, not a.no_foreground)
        else:
            validate_recipe(recipe)
            out = {"slug": recipe["slug"],
                   "plans": [build(recipe, observed, s["name"], a.trusted, a.evidence,
                                   not a.no_screenshot, not a.no_foreground)
                             for s in recipe["states"]]}
        print(json.dumps(out, indent=2, sort_keys=True))
    except Refuse as e:
        sys.stderr.write("REFUSE[%s]: %s\n" % (e.code, e.msg))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
