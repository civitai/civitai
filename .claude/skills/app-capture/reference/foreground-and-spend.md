# Foregrounding vs spending, and the app-ready gate

Two changes that arrived together on 2026-08-17, from the first live
`capture --evidence` run. Both replace a rule that read as safe and was not.

## 🔴 RETRACTED — "An App Block does not boot in a hidden tab"

🔴 **THIS SECTION'S HEADLINE IS FALSE. Re-measured 2026-08-24: App Blocks DO boot
hidden — 4/4, one of them with no `activate` at all** (the app frame renders at
`visibilityState: "hidden"`). Record:
`<datapacket-talos>/claudedocs/app-capture-hidden-tab-boot-2026-08-24.md`.
The 5/5 below is left in place because it is a real observation that is still
unexplained — but it is **not** evidence that foregrounding is required, and
nothing may be built on it. The `## 🔴 SUPERSEDED 2026-08-24` block further down
scopes itself to the *occlusion* half and does **not** cover this section.

Note also that the HOST-SIDE raise this section motivated is **withheld**: every
capture-path `activate` passes `--no-focus`, so the bridge answers
`i3: "withheld"`. 🔴 **Corrected 2026-08-28** — this used to read "`capture.sh`
never passes `--focus`", as though the absence were what withheld the raise. It
is not; see [Consent is declared, not inherited from stdio](#-consent-is-declared-not-inherited-from-stdio).
🔴 **Withheld is not "inert"** — the extension still makes
the tab its window's **active tab**, and still calls
`chrome.windows.update({focused: true})`, which no flag covers.

The original (retracted) measurement, on `model-benchmarking`, driven by hand
through the bridge:

| tab state | attempts | result |
|---|---|---|
| hidden, plain | 1 | deadlock |
| hidden + `wake` | 1 | deadlock |
| hidden + sustained back-to-back `wake` | 1 | deadlock |
| hidden + iframe reload | 2 | deadlock |
| **genuinely foregrounded** | 1 | **booted in ~4 s** |

It is a **deadlock, not throttling**: the host page renders `Starting <App>…`
while the app frame renders `Loading <App>…` (`app-loading`, ~16 elements, one
testid), each waiting on the other half of `BLOCK_INIT`. Sustained `wake` does
not clear it, which is what rules out the "wake restores render" theory — `wake`
un-throttles rendering, it does not complete a handshake.

Every bridge tab is **created hidden**. The conclusion drawn at the time — that
`capture.sh` was *structurally incapable* of capturing any App Block — followed
from the retracted premise and does not hold.

## 🔴 Activation is not actuation — and the guards are now separate

The old rule was "never `browser activate` outside `--trusted`", because
activation is what lets a genuine OS keypress reach the page and therefore what
makes **spending** possible. That rule cannot survive the measurement above, and
loosening it must not loosen the spend path. So the single ban was split into
two checks in `.claude/skills/app-capture/scripts/plan.py` that **cannot stand in
for each other**:

| guard | what it permits / forbids | where |
|---|---|---|
| foreground plan | `activate` may appear **only** in the plan built by `build_foreground` — never in a state plan | `build_foreground`, gate P11b |
| `guard_no_actuation` | **any** step carrying `xdotool` / `--clearmodifiers` is refused in **every** plan built without `--trusted`, foreground plans included | post-condition over the assembled steps |

The second is deliberately **blind to `activate`**. If it also banned it, the
foreground plan could not exist and there would again be one guard doing two
jobs — which is how the original ban ended up blocking capture entirely.

What still holds, unchanged:

- `trustedKey` refuses without `--trusted` (`trusted_required`).
- `--foreground-plan --trusted` is refused (`bad_usage`): mixing the flags is how
  they stop being separable.
- Every op that touches the **app's** document comes out of a plan, the
  foregrounding one included, so `plan.py` is the thing that refuses it.
  🔴 **RETRACTED (2026-08-23): "`capture.sh` emits no bridge op of its own."** It
  emits several — `whoami`, `open`, `close`, `text`, `frames`, and the `nav`+`wake`
  pair `reload_app` runs before every state (lifecycle and observe, unplanned by
  necessity since the plan is built *from* the observation), plus the top-frame
  app-frame rect probe. That last one is a DOM op and is refused by **`frame.py`'s
  `guard_rect_js`**, not by `plan.py`. The safety conclusion was right and the
  stated mechanism was wrong; there are two refusers in two files and neither
  covers the other's ops.
- Any JS we inject is scanned for actuation verbs over its **rendered** source,
  not its template: the app-ready probe interpolates a selector that comes from a
  recipe, so a recipe field cannot smuggle a `.click(` into a live, logged-in app
  (`ready_actuates`).

### The test that proves they are separable

Gate **G2** in `tests/run-tests-app-capture.sh` copies the scripts, plants an
actuation step in the emitter **both** paths share, and asserts three arms:

1. refused in the **foreground** plan (`actuation_without_trusted`),
2. refused in a **non-trusted state** plan (same code),
3. **planned fine with `--trusted`** — the attribution control, proving the
   refusal is the trust check and not a broken mutant.

Gate G1 adds the mirror image from the permitted side, with a positive control
that the actuation scan can *see* `xdotool` in a `--trusted` plan — a "no
actuation found" from a scanner wired to nothing would look identical.

Mutants `M59`–`M64` in `tests/mutants-app-capture.sh` are the lock: they kill the
ban outright, narrow it, **widen it back to `activate`** (which would silently
return capture to being unable to run at all), stop the foregrounding, let a
frame-scoped op into the foreground plan, and make `--trusted` decoration.

## 🔴 Consent is declared, not inherited from stdio

**The absence of `--focus` does NOT withhold the host-side i3 raise.** The bridge
CLI resolves the flag as **"on iff stdout is a TTY"** — a human typing `browser
activate` in a terminal means it, an agent on a pipe does not — so omitting it
delegates the decision to *how the caller happened to be invoked*. Measured
2026-08-28 against an instrumented endpoint, identical argv (`activate --no-wait`):

| stdout | wire payload |
|---|---|
| command substitution (`run_step`'s `out="$(…)"`) | `"focus":false` |
| **a PTY** | **`"focus":true`** |
| explicit `--focus` / `--no-focus` | `true` / `false` (the controls — the field moves both ways) |

Until 2026-08-28 this skill derived "the raise is withheld" from "`capture.sh`
never passes `--focus`", in `SKILL.md`, `capture.sh`, `plan.py`, this file and
`bridge-facts.md`. The **conclusion** was true on every path
— `activate` is emitted only by `plan.py` and executed only by `capture.sh`'s
`run_step`, which command-substitutes every op — but the **derivation** was not.
The property rested on an accident of stdio in a helper function, in a different
repo from the default that decides it, and no test in either repo pinned the
relationship.

So it is now **declared**: `plan.py` emits `--no-focus` on every capture-path
`activate` (`NO_FOCUS_ARG`), and `guard_activate_placement` refuses a plan that
omits it (`activate_unconsented`). No refactor of `run_step`, and no change to
the CLI's default, can turn the raise on. Gate **G11** reaches the clause through
the module API — *not* by planting, because a planted activate sits at the
evidence anchor, is misordered too, and dies to `activate_misordered` instead
(measured; the M96 wrong-clause shape). Mutants **M183**/**M184** are the lock.

🔴 **`spend` is EXEMPT, on purpose.** `plan_spend`'s `activate` sends no focus
flag at all, because a trusted OS keypress may genuinely need Brave raised — what
that path should ask for is an **open question**, and a blanket ban would settle
it by default. G11 pins the exemption so a sweep cannot quietly close it. Today
that step's raise is withheld only by the same stdio accident described above.

🔴 **None of this touches the residual.** `--no-focus` gates the `i3-msg` half
only. The extension unconditionally calls `chrome.tabs.update({active:true})`
*and* `chrome.windows.update({focused:true})`
(`<devrc>/scripts/browser-bridge/extension/service_worker.js`, the `activate`
case) — neither is gated by any flag, and whether the second reaches X11 is
still unmeasured.

## The two ways to get a foreground tab

```bash
SK=.claude/skills/app-capture/scripts
# 1. default — open a tab and make it its window's active tab. The host-side i3
#    raise is WITHHELD because the step asks for that with --no-focus, so this
#    does not take the screen cross-workspace; the residual is the ungated
#    windows.update{focused:true},
#    which can move focus whenever Brave is already on the visible workspace.
$SK/capture.sh $SK/recipes/model-benchmarking.json --evidence --no-frame --out /tmp/mb

# 2. attach to a tab the operator already has in front. No open, no close —
#    a tab this script did not open is never closed by it.
$SK/capture.sh $SK/recipes/model-benchmarking.json --tab 8123 --evidence --out /tmp/mb
```

`--no-foreground` skips it. 🔴 **RETRACTED 2026-08-24** — this used to read "the
app will almost certainly deadlock". It will not: App Blocks boot hidden, 4/4.
And the flag is not cosmetic in the other direction either: the i3 window raise
is withheld regardless, but `activate` also makes the tab its window's **active
tab**, and an active tab is what takes the `captureVisibleTab` path. Skipping it
leaves the tab in the **background**, which takes CDP — measured 3/3, identical
geometry. ⚠️ That was a **workaround** for the exit-12 hang and it is **not what
shipped** — the hang was fixed at source in the bridge
(`FAST_CAPTURE_BUDGET_MS`, devrc #797). n=3, indicative. Do not reach for this
flag as a cure; check the RUNNING build first.

## 🔴 SUPERSEDED 2026-08-24 — occlusion is NOT the discriminator, and the host-side raise is withheld

Read this before the section below, which is kept for its measurements but whose
**mechanism claim is retracted**. Re-measured 2026-08-24
(`claudedocs/app-capture-occlusion-refutation-2026-08-24.md`):

- The hang reproduces with the window on a **non-visible workspace and nothing drawn on
  top** — 3/3 `op_timeout:screenshot` at ~18.1 s — in the state the table below calls
  "not visible at all → ok". The same state had succeeded 3/3 at ~292 ms twenty minutes
  earlier, same tab, same window.
- So `captureVisibleTab` is **flaky against its own 18 s budget**, not sensitive to
  occlusion: one arm *succeeded* at 17.97 s. One-shot arms cannot tell a near-miss from a
  timeout, which is what the arm A/arm B table below is made of.
- 🔴 **`activate`'s HOST-SIDE raise is withheld today.** Asked to withhold it, the bridge
  answers `i3: "withheld"`, `i3_detail: "not_requested"` — a **fourth** value beside the
  `applied | skipped | failed` this file documents, and exit 13 fires only on `failed`.
  Every capture-path activate passes `--no-focus`, so **no `i3-msg` runs**. 🔴 **Corrected
  2026-08-28** — this bullet used to say "`capture.sh` does not pass `--focus`, so no
  `i3-msg` runs", which does not follow: the CLI defaults the flag ON for a TTY. See
  [Consent is declared, not inherited from stdio](#-consent-is-declared-not-inherited-from-stdio).
  🔴 **That does NOT make the re-asserts inert, and writing "raises nothing" here was
  wrong.** The extension still calls `chrome.tabs.update({active: true})` — the tab
  becomes its window's active tab, which is what routes the capture onto
  `captureVisibleTab` — *and* `chrome.windows.update({focused: true})`, which the
  withheld gate does not cover. Under i3's default `smart`, a focus request from a window
  on the **active** workspace is granted, so a **residual** exists whenever Brave is
  already on the visible workspace. The bridge's own source retracts the "takes nothing"
  wording and its README records that nobody has measured whether that request fires.
- ✅ The cure that actually measured 3/3 is the **CDP path**: keep the capture tab
  **non-active** and the bridge takes `Page.captureScreenshot` at the *same* 1709×1314
  geometry, pixel-correct, with no screen involvement. "Forcing CDP changes the image"
  is true only of `--fullpage`; it is not true of a background tab.
- ✅ **FIXED UPSTREAM 2026-08-24 — in the BRIDGE, not here (devrc #797, merged).** The
  root cause was narrower than "use CDP": `chrome.tabs.captureVisibleTab` can **HANG**
  rather than reject, and the fast path's `catch` — whose whole job is to fall through to
  CDP — can only see a rejection. So the op ran out the full 18 s `EXEC_OP_BUDGET_MS` on a
  tab CDP captures in well under a second. The fast path now carries its own 1500 ms bound
  (`FAST_CAPTURE_BUDGET_MS`), which turns "never settles" into a rejection the catch can
  act on. **Nothing in `capture.sh`/`plan.py` changed**, and the raise is left standing
  (host-side half withheld) rather than reworked — so `ACTIVATE_REASONS`, gate G11 and
  mutants M59–M64 are untouched and still describe the shipped design.
  🔴 **Deployed ≠ running.** The MV3 service worker keeps executing the OLD code until the
  extension is reloaded, and `brave://extensions` ↻ **often no-ops** because the bridge's
  long-poll holds the worker alive — the reliable path is a **full Brave restart**. Verify
  with `browser --instance <key> ping` and read **`buildMarker`** (expect
  `790ffec959040e69` or newer). `extensionVersion` and `id` describe the load DIRECTORY,
  not the executing code, so neither answers "did the reload take". Until that reload a
  screenshot-taking run can still hit the 18 s hang.
- 🔴 **Not established:** a genuinely OCCLUDED window was never held (the probe could not
  hold the workspace), so arm B's own number is neither confirmed nor refuted. The
  conclusion does not rest on it.

## Once per tab is not enough — the ORIGINAL (2026-08-19) account, mechanism retracted

Activation used to be issued **once per tab**, on the bridge's own guidance, with
nothing re-checking it. That is wrong, but for most of a week it was wrong for
the stated reason too. 🔴 **RETRACTED: "`captureVisibleTab` hangs when the window
is visible but not focused."** A live acceptance run on 2026-08-19 measured the
opposite, and the guards, the constants and the operator advice had all been
built on it:

| arm | window state | result |
|---|---|---|
| D | visible **and focused** | ok, 265 ms |
| A | visible, **NOT focused** (another window has focus) | **ok 6/6**, 192–306 ms, every one via `captureVisibleTab` |
| B | visible workspace, **OCCLUDED** (another window drawn on top) | **`op_timeout:screenshot` at 18.1 s** |
| control | occluded, no raise at all | 0/3, ~18.1 s each |

**Occlusion is the discriminator.** Keyboard focus is not: arm A is the case the
old story called broken, and it captures in under a third of a second. So there
is nothing to chase about `focus_follows_mouse` or where the pointer sits — what
has to be true at the instant of the capture is that **nothing is drawn on top of
the Brave window**.

**Mechanism, from the extension's own source** (`screenshot` in
`<devrc>/scripts/browser-bridge/extension/service_worker.js`): the fast path is
taken when `tab.active && !fullpage && !emulated`, and `tab.active` is true for
the active tab of *any* window. `chrome.tabs.captureVisibleTab` does not return
while that window is covered, so the op is killed by its own budget. A fully
hidden window makes the call *error* instead, and the `catch` falls through to
`Page.captureScreenshot` over CDP — which is why a window on another workspace
captures fine.

**Why re-assert rather than route to CDP.** Forcing the CDP path from here is
only possible via `--fullpage` (or `emulate`), and `--fullpage` captures the
whole scrollable document — a different image, which would silently invalidate
every crop band, the identical-box gate and the pinned 1200×778 store geometry.
There is no `--via cdp` flag to ask for. Raising the window is idempotent, cheap,
changes nothing about what is captured, and keeps the raise itself inside a plan
rather than in `capture.sh`.

### The load-bearing quantity is the GAP, and the wait is not a timer

`activate --wait MS` is the bridge's bounded page-**LOAD** wait. It is not a
focus-hold, and `activate` returns in ~350–500 ms whatever it is set to — swept
`nowait/100/250/500/1000/1500` from the occluded state, **3/3 recovered at every
value, 18/18 overall**. The old `REFOCUS_WAIT_MS = 1500` was therefore inert, and
its comment (a "shorter wait, because this is a re-assert of a tab that is
already loaded") described a mechanism that does not exist. It is **deleted**,
not retuned; a re-assert carries `--no-wait`.

What does move the outcome is the distance between the raise and the thing that
needs the window:

| sequence | result |
|---|---|
| `activate` → `screenshot` (gap 0) | **3/3 ok** (~280 ms) |
| `activate` → 4 s (`SETTLE_MS`) → `screenshot` | 1/3 |
| `activate` → 4 s, focus touched | 0/3 |

Measured foreground hold after a re-assert, 5 runs: 1176 / 2550 / 1176 / 1503 /
1232 ms — **median ~1.5 s**. A plan that raised the window and then waited 4 s
was capturing ~2.5 s after the foreground it acquired was already gone.

🔴 **Scope on that median: it was taken at load 130–145 on a 24-thread box
(~5.7× oversubscribed), so treat it as a LOWER bound, not a constant.** It is
also not what the design rests on — the three GAP arms above are measured
outcomes of the capture itself and hold whatever the true dwell time is, and a
state runs for tens of seconds either way. If you re-measure it on an idle box,
expect a larger number and change nothing but this paragraph.

### So there are TWO re-asserts, each next to what it is for

- **`state`** — opens **every** state plan, immediately before the app-ready
  gate. `capture.sh` reloads the app between states, so every state boots an App
  Block again, and an App Block does not boot while its window is occluded.
- **`pre-screenshot`** — sits with **gap 0** to its capture. The settle wake goes
  *before* it, never between it and the screenshot.

🔴 **The `state` one is what a screenshot-free run has, and losing it was defect
1.** It used to be emitted inside `if screenshot:`, so an `--evidence --no-frame`
run — the defect-hunting run this path exists to enable — planned **zero**
`activate` in any state plan and leaned on the once-per-tab raise. Live on
model-benchmarking: state 1 booted, state 2 came back `exit 11` **CONFOUND**, and
`plan-combinations.json` / `plan-prompts.json` contained no `activate` at all.

**None of it widens the spend path.** `guard_no_actuation` is unchanged and still
blind to `activate`; `trustedKey` still refuses without `--trusted`; a re-assert
carries no `xdotool` and no `--clearmodifiers`. The *other* half is
`guard_activate_placement`, a post-condition over the assembled plan: every
`activate` declares one of `ACTIVATE_REASONS`
(`tab` / `state` / `pre-screenshot` / `spend`); a `pre-screenshot` one must be
followed **immediately** by the screenshot (`activate_misordered`); a `state` one
must lead everything that needs the window (`activate_lead_misplaced`) and a
foregrounded state plan must carry exactly one (`activate_lead_missing`); the
pre-screenshot count must equal the number of screenshots
(`activate_uncounted`); `tab` may appear only in a foreground plan and `spend`
only under `--trusted` (`activate_unplaced`); and every one must ask capture.sh
to read the bridge's i3 outcome (`activate_unverified`). **One code per clause**
is not cosmetic — when two clauses shared a code, a mutant that deleted the
position check died to the count check and the battery scored it SURVIVED. Gate
**G11** plants four separate violations and requires each to be refused by its
own code, reaches the two unplantable clauses through the module API, and pairs
all of it with the unmutated copy planning.

## 🔴 `activate` raises the TAB, not necessarily the WORKSPACE

`browser activate` foregrounds the tab inside Brave and then asks the host to
raise the window with `i3-msg '[class="Brave-browser" title="…"] focus'`. That
second half is **best effort**, reported as `i3: applied | skipped | failed`, and
until 2026-08-18 nothing read the field. With the Brave window parked on another
workspace, the app-ready gate can time out with the *same* message a wrong ready
anchor produces, and two live diagnosis runs died on that ambiguity and concluded
nothing. 🔴 **RETRACTED 2026-08-24:** the causal half of that sentence — "the tab
stays hidden, the App Block deadlocks on `BLOCK_INIT`" — is FALSE. App Blocks
boot hidden, 4/4. The **ambiguity** is real and is what the two signals below
resolve; the **deadlock mechanism** is not, and nothing may be built on it.

Two independent signals now separate them, neither of which needs `xdotool` (a
token the actuation ban refuses outside `--trusted` — a detector that has to be
smuggled past a safety guard is not one this skill may have):

1. **The ready probe asks `document.visibilityState`, as the TIE-BREAK on an
   ABSENT anchor.** A nested browsing context reports the top-level document's
   visibility, so this is the same value you would read by hand.
   🔴 **It used to ask FIRST, and that was defect 2.** The probe short-circuited
   on `visibilityState !== "visible"` before querying any markup, so a booted app
   that happens to report hidden was refused outright: measured live 2026-08-19,
   panorama-360 answered `visibilityState: hidden` while rendering **16 testids**,
   no `app-loading`, and accepting a click that changed the prompt. A present
   anchor is now believed whatever the tab says; `APPBOOT_HIDDEN` is reserved for
   the read that genuinely cannot speak — **anchor ABSENT *and* not visible** —
   which is the whole of the CONFOUND it was introduced for.
   The decision is one table, `plan.ready_verdict`, and `ready_js` renders it:

   | anchor | loading | visible | token |
   |---|---|---|---|
   | present | absent | either | `APPBOOT_READY` |
   | absent | either | **not visible** | `APPBOOT_HIDDEN` (confound) |
   | either | present | visible | `APPBOOT_LOADING` |
   | absent | absent | visible | `APPBOOT_ABSENT` (the only one that may implicate the anchor) |

   Gate **G3b** EXECUTES the rendered JS with a translator that shares no code
   with `plan.py` and requires it to agree with the table on all 8 combinations —
   a word-level check could not tell the fix from the defect, since both mention
   `visibilityState` — and it rebuilds the pre-fix program as its positive
   control.
2. **capture.sh reads the `i3` field of every `activate`** (`verifyForeground`).
   `failed` stops the run with **exit 13**; anything other than `applied` prints a
   warning. `applied` is necessary and **not sufficient** — `i3-msg` can exit 0
   having matched no window — which is why the visibility token is the authority
   and the pair is reported together.

Exit 11 then prints one of three verdicts: **CONFOUND** (the tab was never in
front — the anchor is *unproven*, not disproven), *still rendering the loading
shell* (booting or deadlocked), or *rendered neither* — the only one that may
implicate the ready anchor.

## 🔴 The app-ready gate

Every recipe state's first action used to be `click howto-dismiss` with nothing
waiting for the app. When the app booted *after* that click, the click was thrown
away, the following `waitForGone "How this works"` never cleared, and the run
failed with a message that reads exactly like a broken dismiss button — it was
not: a synthetic in-frame click dismisses that panel fine.

So a recipe must now declare an anchor, and `plan.py` refuses one that does not
(`no_ready_gate`):

```json
"ready": {
  "testid": "view-switch",
  "loadingTestid": "app-loading",
  "timeoutMs": 45000
}
```

- exactly one of `testid` or `selector` (`selector` is the escape hatch for an app
  with no usable testid, e.g. panorama-360's `#pano-controls`)
- `loadingTestid` defaults to `app-loading`, the one testid a deadlocked frame
  renders
- `timeoutMs` defaults to 45 000 — a foregrounded app booted in ~4 s

`plan.py` emits **one** frame-scoped probe before the first action of every state
(and, under `--evidence`, right after the probe install, so a boot-time console
error is still captured). It returns **one bare token** — `APPBOOT_READY`,
`APPBOOT_LOADING` or `APPBOOT_ABSENT` — never a JSON object: the bridge escapes
every quote inside a returned value, so a `"ready":true` needle would never match
the text the runner polls.

It waits for a **positive** token, not merely for the loading marker to vanish: a
frame that renders neither answers the same as one that finished.

### Two failures, two sentences

| what happened | exit | what the run prints |
|---|---|---|
| the app-ready gate timed out | **11** | `APP NEVER BOOTED` + the gate, the last read, and **which of the three causes** it was (see above) |
| the host-side window raise reported `failed` | **13** | `THE WINDOW WAS NOT RAISED` — not a recipe failure and not an app failure |
| the screenshot op returned no path | **12** | `THE SCREENSHOT BRIDGE OP FAILED`, naming a STALE BRIDGE BUILD when the read carries `op_timeout` |
| any later step timed out | 4 | `THE ACTION FAILED` — *the app-ready gate had already passed, so the app WAS booted* |

🔴 **Exit 12 exists because a bridge failure used to be reported as a recipe
failure.** A missing screenshot path exited 4, whose message asserts "the app WAS
booted … this is the step above" — blaming the recipe's action for something the
recipe never touched. Combined with the unconditional screenshot (below), it
killed two live `--evidence` runs.

🔴 **A run that discards the picture no longer takes one.** `plan.py` emitted the
screenshot unconditionally and `plan_evidence_read` ran *after* it, so on
`--evidence --no-frame` a bridge-side screenshot failure destroyed the DOM read
and the probe drain of a state whose actions had all succeeded. `capture.sh` now
passes `--no-screenshot` in exactly that combination; `plan.py` refuses the flag
without `--evidence` (`no_output`), because a plan that drives the app and keeps
no record of it reads exactly like a run that worked. Gate **G14** drives both
arms under one broken screenshot: the capturing run stops at 12, the evidence run
is untouched and ships its artifact.

Gate G9 drives both through the fake bridge (`FAKE_READY_MODE=never`), asserts
the boot message appears and the action message does **not**, and pairs it with
the same recipe on a booting app exiting 0.

## Limits, stated

- 🔴 **RETRACTED 2026-08-24 — this bullet was doubly wrong.** It read "Foregrounding
  **takes the operator's screen for the whole run** … There is no way around it for a
  screenshot: the window has to be un-occluded to be photographed." Neither half holds:
  the host-side raise is **withheld** because every capture-path activate asks for that
  with `--no-focus` (🔴 corrected 2026-08-28 — this used to say "without `--focus`, which
  `capture.sh` never passes"; the CLI defaults the flag ON for a TTY, so the absence
  withheld nothing), and a **background** tab is captured via CDP at identical geometry, so a
  screenshot does **not** require an un-occluded window. What survives is a **residual**
  — the extension's own `chrome.windows.update({focused: true})` is outside the gate and
  can be granted when Brave is already on the visible workspace, which is unmeasured.
  There are still one raise per state plus one per capture. `--tab` remains the polite
  form: the operator chooses the moment.
- **Nothing here holds the window; it only re-takes it.** The raised foreground
  lasts a median ~1.5 s, so anything the operator does mid-run can cover the
  window again between one re-assert and the next. The re-asserts sit adjacent to
  the two things that need it (the app-ready gate, the capture); everything
  between them is unprotected by construction.
- **The two failure modes are detected, not prevented.** An occluded capture
  costs an 18.1 s timeout before exit 12 says so, and a state that boots into an
  occluded window costs the ready timeout before exit 11 says CONFOUND.
- **`--no-wait` is a claim about `activate`'s own return, not about the desktop.**
  The sweep that made the wait inert was run from one occluded state on one i3
  box; a compositor that animates a raise could need slack that no value in that
  sweep would have revealed.
- The ready anchor is a claim about the app's markup, live-verified per recipe
  and as fragile as any selector. When an app renames a testid the gate fails
  loudly (`APP NEVER BOOTED` naming the anchor) rather than silently capturing a
  half-booted screen. 🔴 And since 2026-08-19 a **present** anchor is believed
  even in a tab reporting `hidden` — so an anchor that a *deadlocked* frame also
  renders would now pass the gate where the visibility short-circuit used to
  catch it by accident. The anchor must be something only the **booted** app
  renders; that requirement is now load-bearing rather than advisory.


## Exit codes — one failure, one code, one sentence

Demoted from `SKILL.md` 2026-08-24 (size prune). VERBATIM.

**One failure, one exit code, one sentence** — a code once carried several, twice:

| code | meaning |
|---|---|
| `4`  | a recipe action really failed |
| `9`  | the app-frame probe could not be **BUILT** (this skill's own JS refused by `guard_rect_js`) |
| `10` | evidence refused |
| `11` | the app never booted — **CONFOUND** only when the anchor is ABSENT *and* the tab is not visible; a **present** anchor is believed whatever the tab reports |
| `12` | the screenshot op returned no path — a **bridge** failure, never the recipe's |
| `13` | the bridge's host-side window raise reported `failed` |

✅ Exit 12's message was rewritten 2026-08-25 and now names the unbounded fast path (fixed in
devrc #797), points the operator at `browser --instance <key> ping` → `buildMarker`, and states
explicitly what was NOT established (whether a genuinely occluded window contributes — that arm
was never held). Its whole body is pinned VERBATIM by gate **G14**, so a reword fails the suite
and must be re-pinned deliberately. Gate **D8** pins the 9/5 split.
