---
name: app-capture
description: Deterministically drive a first-party Civitai App Block in the operator's browser and produce store-ready screenshots, machine-analysable per-state evidence (DOM + console + failed requests + a11y + testids), or attach media to a listing. Use when the user asks to capture / screenshot / re-shoot an app's store images, to add a screenshot / icon / cover / caption to an app listing, to add a new app to the capture set, to FIND DEFECTS in a running App Block or diff a before/after fix, or to run a scripted App Block action (including the spend path behind an explicit flag).
argument-hint: "[capture <slug> | evidence <slug> | attach <slug> | discover <slug> | test]"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# app-capture — scripted App Block runs + store screenshots

Two verbs, deliberately separate:

| verb | mutates? | entry point |
|---|---|---|
| `capture` | no — never spends, never touches a listing | `.claude/skills/app-capture/scripts/capture.sh` |
| `attach`  | **yes** — opens a moderator-reviewed shadow revision | `.claude/skills/app-capture/scripts/attach.sh` |

The logic lives in three **pure** scripts under `.claude/skills/app-capture/scripts/`, so it
tests with no browser: `plan.py` turns *recipe + observed state* into an ordered list of bridge
commands, `frame.py` measures/crops/gates an image, `evidence.py` turns *DOM + drained probe*
into a per-state artifact. `capture.sh` executes what they print and decides nothing.

## Run it

```bash
SK=.claude/skills/app-capture/scripts
$SK/capture.sh $SK/recipes/custom-generators.json --instance work --out /tmp/cg
```

Add an app = add a recipe. Nothing else changes.
`--tab <id>` attaches to a tab the operator already has in front (no `open`, never closes it);
`--no-foreground` is diagnostics only.

🔴 **Two founding claims are RETRACTED — do not re-derive them.** An App Block *does* boot
hidden (4/4), and the screenshot discriminator is *not* occlusion: `captureVisibleTab` can
**HANG** rather than reject, so the `catch` that falls through to CDP never ran. ✅ Fixed in the
BRIDGE (devrc #797) — **nothing here changed**, so `ACTIVATE_REASONS`, G11 and M59–M64 are the
shipped design, not dead code. 🔴 **Deployed ≠ running:** the MV3 worker serves old code until
Brave FULLY restarts (↻ often no-ops), so a run can still hit the 18 s hang;
`browser --instance <key> ping` → **`buildMarker`** is the only field describing RUNNING code,
and staleness is **per profile**.

🔴 **The raise is withheld, but `activate` is NOT a no-op.** Every capture-path activate
passes `--no-focus`, so the i3 raise answers `i3: "withheld"` (a **fourth** value beside
`applied|skipped|failed`) — and that gate covers the `i3-msg` ONLY. 🔴 **Corrected
2026-08-28: OMITTING the flag would not withhold anything** — the CLI defaults it ON when
stdout is a TTY, so the old "`capture.sh` never passes `--focus`" derivation was wrong and
the property rested on `run_step`'s command substitution. Now declared and gated
(`activate_unconsented`); `spend` is exempt. The extension also calls
`chrome.windows.update({focused: true})`, granted under i3's default `smart` from a window on
the **active** workspace: a **residual** screen-take whenever Brave is already on the visible
workspace, **unmeasured in both directions**. `activate` also makes the tab its window's
**ACTIVE TAB** — what routes a capture onto `captureVisibleTab`, where a background tab takes
CDP. Removing the steps is optional cleanup, not a fix.

Measurements, corrections, and what was NOT established:
`claudedocs/app-capture-occlusion-refutation-2026-08-24.md` (the hang, the raise) ·
`claudedocs/app-capture-hidden-tab-boot-2026-08-24.md` (hidden boot 4/4)

🔴 **Foregrounding is NOT the spend path — two separate guards, neither able to cover the
other.** `activate` is confined to four declared positions (`ACTIVATE_REASONS`); `plan.py`
separately refuses **any** step carrying `xdotool`/`--clearmodifiers` without `--trusted`
(`actuation_without_trusted`), a check deliberately blind to `activate`. Each placement clause
raises its OWN code, or a mutant dies to its neighbour and the battery records coverage that
does not exist. Gates **G2** and **G11** prove it.

🔴 **Every state opens with an APP-READY gate** — a recipe must declare a `ready` anchor
(`no_ready_gate`), and it must be something only the **booted** app renders. Without one, a
click fired into a still-booting app is discarded and the *next* wait times out naming the
control: a defect report about the wrong component.

**One failure, one exit code, one sentence** — a code once carried several, twice. All of them,
because a partial list sends you reading the script: `2` refused before anything was driven (a
`plan.py` REFUSE, an unknown flag, no such recipe) · `3` the **bridge or the tab**, never the
app · `4` a recipe action failed · `5` a state's crop was REFUSED · `6` every state measured
the **same box** — the cropper is reading page furniture · `7` render failed · `8` the
candidates violate the store bounds · `9` the app-frame probe could not be **BUILT**
(`guard_rect_js`) · `10` evidence refused · `11` the app never booted (**CONFOUND** only when
the anchor is ABSENT *and* the tab is not visible) · `12` the screenshot op returned no path —
a **bridge** failure, never the recipe's · `13` the host-side window raise reported `failed` ·
`14` the **browser window is not the one this recipe's `crop.rect` was measured in**.
Gate **D8** pins the **5/9/14** split (a bad crop vs a probe that could not be built vs a wrong
window — 5 and 9 were once one code). ⚠️ `0` is not always a shoot: no imagemagick, and
`--no-frame`, both exit 0 unrendered.

🔴 **14 is not a defect report — it is the one code that says nothing is broken.** It carries two
refusals, `viewport_of_record` and `frame_of_record`, because they ask the operator for the same
thing (restore the geometry, or re-measure). A declared
`crop.rect` is ABSOLUTE unless anchored, so it only describes the viewport it was measured at; the recipe records
that in `crop._measuredGeometry.viewport` and `frame.py` refuses (`viewport_of_record`) when the
capture disagrees by more than 2 px. **Resize the window back, or re-measure the rect and its
record together** — never edit the record alone to make a run go green. Until 2026-09-02 nothing
compared the two: `app_frame_scale` checks the probe against the capture, which agree in ANY
window, so a rect measured at 1709x1255 applied to a 3431x1286 capture photographed the LEFT HALF
and **exited 0**. Gates **C5** (the incident, with the pristine module's `fill.w` 0.4937 as its
control) and **G20** (end to end, exit 14).

✅ Exit 12's message was rewritten 2026-08-25: it names the unbounded fast path, sends you to `browser --instance <key> ping` → `buildMarker`, and states what was NOT
established. **G14 pins its whole body VERBATIM** — a reword fails the suite on purpose, because
this one message has been allowed to name a wrong variable three times and two keyword guards
were each walked.

The measurements, the activate-vs-actuation trade, the two tab modes, the `ready` schema and
the failure sentences: `.claude/skills/app-capture/reference/foreground-and-spend.md`

## `--evidence` — capture what a screenshot cannot carry

A picture cannot be analysed. `--evidence` records per state: the app frame's **DOM**,
**console** messages with level, **failed network requests** with status, a deterministic
**a11y** summary, and the **`data-testid` inventory** — the anchor resolving a DOM node back to
app source, since these apps ship no source maps but carry dense testids.

```bash
SK=.claude/skills/app-capture/scripts
$SK/capture.sh $SK/recipes/custom-generators.json --evidence --no-frame --out /tmp/before
python3 $SK/evidence.py diff /tmp/before/discover.evidence.json /tmp/after/discover.evidence.json
```

`--no-frame` skips the crop/render pipeline, and **with `--evidence` it also skips the
screenshot** — that pair, and only that pair, discards the picture; a bare `--no-frame` run
still captures and can still fail with exit 12. `diff` ignores volatile `meta` fields and the
raw DOM hash (it moves on every honest re-run).

🔴 **`diff` EXITS 1 ON ANY `changed`, WHICH IS WIDER THAN "a defect appeared or disappeared" —
that older wording was wrong, corrected 2026-09-06 by measurement.** The code is
`return 1 if d["changed"] else 0`, and an added or removed **testid ID** sets `changed` even
when every defect category is empty. Measured on `playable-collections` 0.2.8 → 0.2.9, a
colour-only skin whose sole structural addition was a header mark: `discover` and `mine` both
returned **`regressed: 0, fixed: 0`** with `a11y`/`console`/`networkFailures`/`emptyState` all
`added: [], removed: []` — and **exit 1**, on `testids.added: ["brand-mark"]` alone. (`player`,
which added no testid, returned `changed: false` and exit 0 — the control that isolates it.)
**So a shipped feature reads as a red diff.** Occurrence COUNTS are deliberately excluded from
`changed` — the code says so, because a live grid moves between honest runs — but the ID SET is
not. **Gate on the `regressed` / `fixed` fields, not on the exit code**, and read `testids.added`
before calling a red diff a regression.

🔴 **A zero is never shipped alone.** The probe pushes a sentinel through its own console hook
at install; if it does not come back, `analyze` **refuses** (`probe_selftest_failed`) rather
than print "0 console errors" from a hook that was never listening. **`--evidence` adds no
spend path** (`probe_actuates`). Occurrence deltas (`byId`), `emptyState` as a defect, the
probe-reuse block, the five live-measured probe facts, the schema and every refusal:
`.claude/skills/app-capture/reference/evidence-mode.md`

Attaching is a second, explicit step and refuses to do anything without `--confirm`:

```bash
SK=.claude/skills/app-capture/scripts
$SK/attach.sh --app custom-generators --screenshot /tmp/cg/discover-framed.png \
  --caption "Browse generators other people have published." \
  --changelog "Refreshed store screenshots" --confirm
```

Tests are offline (no browser, no imagemagick): `tests/run-tests-app-capture.sh`, plus the
mutation battery `tests/mutants-app-capture.sh`. 🔴 **They differ in cost by two orders of
magnitude — a full sweep is HOURS**, so after touching one guard re-measure only its own with
`MUTANTS_ONLY=`. Cost, the PARTIAL banner, and why exit 3 is never a claim about a mutant:
`.claude/skills/app-capture/reference/tests-and-mutants.md`

## Which apps are worth shooting at all

🔴 **The ceiling is CONTENT, not tooling.** Surveyed live across all seven first-party apps,
only **model-benchmarking** had content worth photographing — a well-framed capture of a
near-empty app makes a listing look worse than one shot. 🔴 **Per-app verdicts DECAY —
re-measure before acting on one** (2026-08-24: `app-requests` went 6 testids/0 requests → 19/3
in five days). Per-app detail and the three traps it hit:
`.claude/skills/app-capture/reference/per-app-content-2026-08-16.md`

## Recipe schema

```json
{
  "slug": "custom-generators",
  "frameHost": "custom-generators.civit.ai",
  "url": "https://civitai.com/apps/run/custom-generators",
  "crop": { "chromeTop": 182, "footer": 110, "right": 70, "fromAppFrame": true },
  "ready": { "testid": "discover-list", "loadingTestid": "app-loading", "timeoutMs": 45000 },
  "clickable": [ "#tab-discover" ],
  "states": [
    { "name": "discover", "caption": "...",
      "actions": [ { "click": "#tab-discover" }, { "waitForText": "Discover" } ] }
  ]
}
```

🔴 **`clickable` is a LEDGER, not a detector.** Every selector a recipe may *activate* —
`click`, `clickIfPresent`, and `key` (Enter submits the form its input sits in) — must be
listed once, or `plan.py` refuses (`click_unledgered` / `no_click_ledger` / `clickable_unused`).
It buys **reviewability, not detection**: a mutating control cannot be detected, so adding one
is a second deliberate edit that grows the ledger *in the diff*. `ready` is **mandatory**.
The ledger's full rationale, the action verbs and `KNOWN_ACTIONS`, the one-shot-exit-status
rule, and when to use `clickIfPresent`:
`.claude/skills/app-capture/reference/recipe-schema-and-actions.md`

## 🔴 The bridge facts, encoded as guards

Driven through the browser bridge at `<devrc>/scripts/browser-bridge/browser`. The four that
bite hardest: App Blocks render in a **cross-origin iframe**, so every DOM op carries
`--frame` (`dom_op_unscoped` — a SAFETY guard, since a top-frame `click` is `trusted:true`);
the **frame id changes every load**, so a `nav` ends the plan; **tabs are created hidden and
throttled**, so `wake` follows every view change; and **logged out, `/apps/run/<slug>` is a
plain 404** that crops and frames just as well as a real app, so that check runs first.
All seven, each a refusal in `plan.py` rather than advice — **numbered as an API, do not
renumber**: `.claude/skills/app-capture/reference/bridge-facts.md`

## 🔴 The spend path (`--trusted`)

A synthetic in-frame click does **nothing at all** on a money button, so `trustedKey` fires a
real OS keypress on the focused control, bracketed by save/restore of the operator's window.
Unreachable without `--trusted`.

🔴 **The OBSERVATION stands; the "spend path rejects untrusted events" EXPLANATION is
RETRACTED — measured 2026-08-30, do not re-derive it.** There is no `isTrusted` /
`userActivation` / transient-activation check anywhere on the spend path: `isTrusted` and
`userActivation` return **zero** matches across `<civitai>/src/components/AppBlocks`,
`blocks.router.ts` and `src/server/services/blocks` (positive control: `isTrusted` DOES match
elsewhere in `src`, so the zero is a measurement, not a broken search), and
`blocks.submitWorkflow` is a **`publicProcedure`** taking the block JWT as an *input*, not a
cookie — a curl from outside any browser submits fine. What actually gates spend is **token
scopes, `buzzBudget`, the author capability and the Buzz caps**. The likely source of the
false belief: `openBuzzPurchaseGate.ts` and `requestConsentGate.ts` gate on handshake
**readiness**, and the SDK bans the `allow-top-navigation-by-user-activation` sandbox token —
all *about* user activation, none an `isTrusted` check, none on the spend path. The sensei
repo recorded the same retraction independently
(`<civitai-app-sensei>/claudedocs/handoff-civitai-sensei-bridge.md`: *"Don't burn another
session on trusted-click theories"*), where the real blocker was a throttled background tab.

🔴 **So the CAUSE of the dead in-frame click is NOT established** — only that it is not an
untrusted-event rejection. **Keep using `trustedKey`**: the operational rule is unchanged and
rests on the reproducible observation, not on the retracted mechanism. And the security
corollary now that the mechanism is known: **a non-browser client with a valid scoped token
can drive this path**, so "it came from a browser" is not a boundary here.

🔴 **TWO REFUSERS, NOT ONE** — "capture.sh emits no bridge op of its own" is retracted. It
emits lifecycle/observe ops plus **one** DOM op (the top-frame rect probe), refused by
`frame.py`'s `guard_rect_js`, not `plan.py`. Neither covers the other's ops — quote both.
⚠️ **Never verify a spend by a Buzz-balance delta** (some apps bill per GPU second *on
completion*) — a `trustedKey` action must carry `verifyLabel`. Full mechanics and the
panorama-360 selector trap: `.claude/skills/app-capture/reference/cropping-and-attaching.md`

## 🔴 Cropping, store bounds, attaching

Content bounds come from differencing against the flat page background, and **three regions
must be excluded first** (top chrome, footer, right-edge furniture) or the detector silently
returns the whole frame — a no-op crop that still prints plausible numbers. Two independent
detectors catch it: **full-frame refusal** at ≥97% on **either** axis, and **identical boxes
across states** (which is why `capture.sh` reloads the app before every state).

🔴 **A FIXED `chromeTop` IS UNSATISFIABLE HERE — recipes derive it (`crop.fromAppFrame`)**: a
*conditional* rewards banner gives one app on one viewport two layouts whose valid windows are
**disjoint**. `capture.sh` measures the app iframe's own rect — a **top-frame** probe, the one
DOM op that must not carry `--frame` — and `frame.py` takes the **max** of each band with the
recipe's, never the min. 🔴 **A DECLARED `crop.rect` makes the identical-box check INERT and
narrows `full_frame` to an AND on both axes, so those crops are verified BY EYE.** Three forms,
mutually exclusive by refusal: detect; an **absolute** rect, no `fromAppFrame` (**no shipped
recipe** — sensei was the last and converted 2026-08-27, its `y` measured 44px ABOVE the iframe);
and a **frame-relative** rect — `"yFrom": "appFrame"` **with** `fromAppFrame` — anchoring `y`
to the iframe's top edge, so the TOP edge is right in both banner layouts. 🔴 The bottom edge is too
only for a **top-aligned** app: sensei is bottom-anchored, so its fixed `h` is right in the layout it
was measured in and silently short in the other. Check that before adopting the form.

🔴 **The rect can also be anchored HORIZONTALLY (2026-09-02), which is what makes it survive a
re-tiled window** — the operator's viewport went 1709 → 3431 → 1135 device px in one session.
`"xFrom": "appFrame"` measures `x` right from the frame's LEFT edge; `"wFrom": "appFrameRight"`
**re-reads `w` as a gap from the frame's RIGHT edge**, so the pair becomes (left inset, right
inset) and the box carries no absolute horizontal coordinate at all. That needed a **probe
change**: the answer is now six numbers, `top,bottomGap,rightGap,vw,vh,leftInset` — the first
five could place the frame's top/bottom/right but **never its left edge or its width**, which is
why `x`/`w` had no live witness. 🔴 **`wFrom` requires `xFrom`** (a far-edge width against an
absolute left edge hides the drift it looks like it removes), the two marker VALUES are
deliberately different tokens, and **every half-specified spelling REFUSES rather than falling
back to absolute**. 🔴 **No shipped recipe uses it yet** — converting one needs a live capture, so
it is a documented procedure, not a done migration (and gate **P18** is a **tripwire** for it, not
an implementation: it refuses a shipped recipe in this form and says what to teach it). Gates
**F14** (two window widths, byte-identical crops) and **G21** (end to end: exit 14 on a wrong app
frame, exit 5 on a stale five-field probe).

Store bounds live only in `.claude/skills/app-capture/scripts/store-bounds.json`; renders target **1200×778**; an **icon
is re-encoded server-side**, so one can pass locally and still be refused on attach. Attaching
opens a **shadow revision** (hence the mandatory `--changelog`) and the returned ids are
**re-keyed onto the clone, not echoes**. Measured windows, band values, why sensei DOES now use
`fromAppFrame`, and the full attach semantics:
`.claude/skills/app-capture/reference/cropping-and-attaching.md`

### 🔴 What NOT to shoot — a frame's shelf life is its least durable pixel

Photograph the product's **structure**, never a specific dataset, the operator's account state
(the header Buzz chip is the one everyone misses), or an empty state. 🔴 **Before dropping one
shot to fix a drift defect, check the OTHER shots for the same defect** — and since
`--caption` exists only on `add-screenshot`, any change is remove + re-add, so **partial
curation costs two moderator reviews to reach what one would have given.** The measurement,
the checklist, and what to do when an app is too broken to re-shoot:
`.claude/skills/app-capture/reference/shelf-life-and-what-not-to-shoot.md`

### 🔴 OFFSITE apps — `attach.sh` cannot reach them, `attach-offsite.py` can

`civitai app listing …` exits **4** for a `kind: offsite` app. Use
`.claude/skills/app-capture/scripts/attach-offsite.py` (same safety contract: dry-run by
default, `--changelog` mandatory, targets the SHADOW never the parent). The CLI's refusal
overstates the case: `.claude/skills/app-capture/reference/attach-offsite.md`

**Authoring the icon/cover in the first place is the `listing-media` skill**, not this one.

## Adding an app (`discover`)

Author the recipe once, with the agent driving the bridge by hand: `open` the app, poll
`frames`, `text --annotated` inside the app frame to get real selectors, then write a recipe and
run `capture.sh --state <name>` per state until each one frames cleanly. Execution after that is
always deterministic — the agent is not in the loop of a capture run.

🔴 **This is the ONE path where `site_notes` applies — read it before the first op.** Every
bridge envelope from a `<slug>.civit.ai` host names `<devrc>/scripts/browser-bridge/reference/sites/civit.ai.md`,
which carries the same platform facts this skill encodes as refusals, written for driving a
block **by hand**. A frame-scoped op reports the FRAME's url, so it is the in-iframe ops — all
of them — that carry the pointer. **`capture.sh` deliberately ignores it**: a deterministic run
must not acquire a second, prose input the guards cannot see.
