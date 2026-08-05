# Working notes — App Blocks component-suite intermittent failures

**COMMITTED DELIBERATELY as the investigation record** (it was an untracked scratch file for
two sessions, which in a repo with 220+ shared worktrees is one stray checkout away from
deletion). Fold the durable parts into the PR body and delete this file in the final commit
of the arc — but never leave it as the *only* copy again.

Branch `zach/appblocks-component-suite-stability`, base `origin/main` @ `54c2ff8e4b`.

---

## 1. What is failing (CI evidence, read from task pod logs)

The `component-tests` Tekton task is **report-only** — the TaskRun reports `Succeeded`
even when the suite fails. The verdict is the `Tests N failed | M passed` line in the pod
log and the GitHub `preview / component-tests` check.

| PR | run | failing test | test wall | suite wall |
|---|---|---|---|---|
| #3591 | `pr-preview-3591-k85dc` | `AppsSubmitEditView.browser.test.tsx:195` — *retry RE-ARMS a fresh ceiling* | — | 93.07s (`1 failed \| 1246 passed`) |
| #3591 | `pr-preview-3591-k782l` | **same test** | 15858ms | 119.34s (`1 failed \| 123 passed` files) |
| #3592 | `pr-preview-3592-87trh` | `MySubmissionsList.browser.test.tsx:908` — *History button opens the moderation timeline* | 15524ms | 78.03s |

Both failures are `VitestBrowserElementError: Cannot find element with locator: …` →
`Caused by: Error: Matcher did not succeed in time.`

**Wall-time discriminator:** the failing test burns ~15.5–15.9s (the `expect.element`
matcher timeout) and the *suite* still finishes in 78–119s against a 25-minute budget.
So this is a **fast, bounded failure inside an otherwise healthy run — a race, not
contention dragging toward the ceiling.**

Failure DOM for #3591 shows the **not-found alert** rendered where the spinner was
expected — i.e. the state the test wanted had already been replaced.

## 2. Hypothesis under test (H1)

`src/components/Apps/AppsSubmitEditView.browser.test.tsx:187,194-195`

```
renderWithProviders(<AppsSubmitEditView listingId="apl_1" loaderCeilingMs={200} />);
...
await page.getByTestId('apps-offsite-edit-retry').click();      // line 194
await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();  // line 195
```

Component: `src/components/Apps/AppsSubmitEditView.tsx:61-72,83-87`.
`handleRetry` sets `loaderExpired=false` + bumps `retryNonce`; the effect re-arms
`setTimeout(() => setLoaderExpired(true), loaderCeilingMs)`.

**H1: line 195 asserts a TRANSIENT state that deletes itself `loaderCeilingMs` (200ms)
after the click.** The assertion holds only if `click()` resolving **plus** the matcher's
first poll both complete within that 200ms wall-clock window. Both are cross-process
RPC round-trips to the browser; under CI contention they exceed 200ms, the spinner is
already gone, every subsequent poll is also too late → **unwinnable**, and it burns the
full ~15s matcher budget before failing. That matches the observed 15.5–15.9s exactly.

This is the *same class* that `72b1485034` (#3544) already fixed in the **sibling** test
in this file (lines 130-164) by DELETING a pre-ceiling assertion — its comment says the
30ms window was "unwinnable … burned the full ~14.9s budget". **The fix was applied to
one test and not to the other.** The remaining test then got a *widened* window (200ms)
rather than a structural fix — i.e. the knob, not the cause.

### What would REFUTE H1
- Shrinking `loaderCeilingMs` **below any achievable round-trip latency** and still
  seeing the test pass → the asserted state is not actually transient, H1 is wrong.
- A red observed with the spinner PRESENT in the failure DOM → not a missed window.

### Window-scaling control — variants and their predictions (stated BEFORE the result)
| variant | `loaderCeilingMs` | prediction if H1 true | prediction if H1 false |
|---|---|---|---|
| A (shipped) | 200 | passes when latency < 200ms, fails when > | outcome unrelated to the value |
| B | 20 | fails **only** if round-trip > 20ms | passes |
| C | 0–1 | **fails ~always** (window < any latency) | passes |
| D | 5000 | passes even under heavy load | outcome unrelated |

🔴 The control is only meaningful if C fails AND D passes. B passing is NOT a refutation
on its own — it just means the local round-trip is under 20ms.

## 2a-BIS. 🔴🔴 SESSION 2 — §2b BELOW IS RETRACTED. **H1 IS CONFIRMED.**

The "variant C 3/3 GREEN" result in §2b is **WRONG** and everything derived from it
(H3, "the ceiling knob does not govern the outcome") is withdrawn. Re-measured
2026-08-05 with the component itself instrumented.

**Direct measurement beats inference.** Instead of re-running the knob, `performance.now()`
was taken either side of the `.click()` and `console.log` timestamps were added inside
`AppsSubmitEditView` on HANDLE-RETRY / EFFECT / TIMER-FIRE / EFFECT-CLEANUP.

**Traced timeline, `loaderCeilingMs={200}` (the shipped value), green run:**
```
t=805.1  HANDLE-RETRY          <- click lands; setLoaderExpired(false) -> SPINNER APPEARS
t=807.0  EFFECT nonce=1        <- fresh 200ms ceiling armed
         PROBE-T clickRttMs=63.9 immediateLoading=1   <- matcher reads here, spinner PRESENT
t=1007.2 TIMER-FIRE nonce=1    <- SPINNER DELETES ITSELF
```
The observable window is **`[HANDLE-RETRY, HANDLE-RETRY + loaderCeilingMs]` = 202ms**, and
the assertion reads **40–78ms** into it. Margin ~150ms — not the "comfortable" window the
code comment claims.

**Traced timeline, `loaderCeilingMs={1}` (variant C), RED run:**
```
t=685.1  HANDLE-RETRY
t=688.4  TIMER-FIRE nonce=1    <- window was 3.3ms
         PROBE-T clickRttMs=78.0 immediateLoading=0 immediateNotFound=1  <- MISSED
t=15561  EFFECT-CLEANUP        <- 15.0s of futile polling, then fail
```
Variant C measured this session: **`-t`-filtered 2/2 RED (14986ms, 15021ms); full-file
1/3 RED (15004ms)** = **3 of 5 RED**, failure message and ~15.0s burn **byte-identical to
CI**. The knob absolutely governs the outcome.

🔴 **Why §2b got the opposite answer — the likely cause, and it is a documented trap.**
Vitest's summary lines are ANSI-prefixed, so a `grep` for the verdict silently matches
nothing and a RED run reads as "no failures". My own first variant-C batch hit exactly
this: I grepped `Tests +[0-9]+ (passed|failed)`, got no match, and had no verdict at all.
Stripping ANSI (`sed 's/\x1b\[[0-9;]*m//g'`) before grepping is mandatory here.

**Mechanism, stated precisely (this is the root cause):**
the assertion awaits a state that **DELETES ITSELF** `loaderCeilingMs` after the click.
The matcher's first poll lands `returnLeg` ms into the window. If `returnLeg >
loaderCeilingMs` the state is already gone — and because it **never comes back**, every
subsequent 50ms poll is also too late. The failure is **unwinnable**, which is why it
burns the *full* 15s matcher budget rather than failing fast. That is the CI signature
(~15.0s failing test inside an otherwise-healthy 78–119s suite) and it explains why the
flake is load-dependent and PR-independent.

`refetchCalls=1` in **100% of runs, including every red** → **H3 is refuted**: the click
always takes effect. `containers=1` always → not the cleanup/container-leak class either.

### The invariant to hold (the generalisable lesson)
**Awaiting a state to ARRIVE is safe — load only makes it arrive later, and the matcher
waits. Awaiting a state that will LEAVE is a race the matcher cannot win.** Every awaited
state must be ABSORBING. This is the same principle #3544 applied to the sibling test at
lines 130-164; it was applied to one test in the file and not the other.

### Sibling sweep for this class
`grep -rn "CeilingMs|TimeoutMs=|DelayMs=|DurationMs=" src --include=*.browser.test.tsx`
over all **125** `*.browser.test.tsx` files returns hits in **this file only** (lines 160,
187, 239, 255). Of those, 160 and 239/255 await only absorbing states (alert / form stub)
and are safe. **Line 187 is the last instance of the class.** Honest limit: this greps the
*ceiling-prop* variant; a self-deleting state driven by some other mechanism would not be
caught, and I did not build a general detector.

### The fix (shipped) and how it is verified
Split the one racing test into two, so **every awaited state is absorbing**:
1. `retry RE-ARMS the loader…` — ceiling 30ms → alert; `rerender` to `NEVER_ELAPSES_MS`
   (600s) so the spinner, once back, cannot delete itself; **then** click retry and assert
   the spinner. Carries a NEGATIVE CONTROL: after the widening rerender the spinner must
   still be ABSENT, so the spinner in step 3 is attributable to the retry and not to the
   prop change re-running the effect.
2. `retry re-arms a FRESH ceiling…` — ceiling stays 30ms and is never changed, so the
   timer that fires can only be one the retry armed. The transient spinner is **not
   asserted at all**; the awaited end-state is the returning alert, which is absorbing.

Mutation results (each guard must die for ITS OWN reason — measured, not asserted):
| mutation | test 1 | test 2 |
|---|---|---|
| delete `setLoaderExpired(false)` from `handleRetry` | **3/3 RED** `Cannot find element … apps-offsite-edit-loading` | green (vacuous here — test 1 owns it) |
| drop `retryNonce` from the effect dep array | green (correctly unaffected) | **3/3 RED** `Cannot find element … apps-offsite-edit-not-found` |

Clean separation: neither test is killed by the other's mutation, so neither is passing
for the other's reason.

### 🔴 Accelerated control — stated BEFORE running
A load lottery is a weak instrument (OLD survived 9/9 at load ~85). The mechanism is
`returnLeg > window`, so **shrinking the window is equivalent to lengthening the return
leg**, and it is deterministic. Set EVERY `loaderCeilingMs` in the file to `1` and run
both variants:
- **Prediction if the fix is structural:** OLD@1 mostly RED, NEW@1 **10/10 GREEN**.
- **What REFUTES the fix:** NEW@1 goes red. That would mean a self-deleting-state
  dependency survives somewhere in my rewrite and I have only moved the race.
- **What would make the control meaningless:** OLD@1 also green — then the knob doesn't
  discriminate and the whole model is wrong.

---

## 2b. ~~H1 IS REFUTED~~ — 🔴 RETRACTED, SEE §2a-BIS ABOVE. Left for the audit trail only.

**Variant C (`loaderCeilingMs={1}`, i.e. a 1-millisecond transient window): 3/3 GREEN**
(2785ms, 2823ms, 4030ms).

Under H1 a 1ms window is smaller than any achievable browser round-trip, so the assertion
should have failed essentially always. It did not. **The value of `loaderCeilingMs` does
not govern the outcome, so "the matcher missed a 200ms window" is NOT the mechanism.**
Widening the window (which is what the shipped 200ms already is) would therefore have
been treating a knob that does not control the failure — worth recording, because that
knob is exactly what an unverified "fix" would have reached for.

**But the assertion is NOT vacuous.** Mutation check — delete `setLoaderExpired(false)`
from `handleRetry` (`AppsSubmitEditView.tsx:84`):
- **2/2 RED**, 17753ms / 17840ms wall, failing test 14999ms / 15013ms,
  `Cannot find element with locator: getByTestId('apps-offsite-edit-loading')`
  — **byte-identical failure signature to CI.**

So line 195 genuinely pins the retry→spinner transition, and the CI red means the spinner
really was absent. The open question is *why it is absent under load*, given the ceiling
is irrelevant.

### H3 (current working hypothesis, replaces H1)
The awaited `.click()` resolves **without its React handler having taken effect**, so the
retry never happens. This would unify BOTH failing tests — each is "click, then
immediately assert the consequence of the click", and each fails exactly as if the click
never landed.

**Probe installed in both tests** (temporary, must be removed before commit): on failure,
report whether the click's side effect occurred.
- `PROBE-A` reports `refetchCalls` / `loading` / `notfound` / `retryBtn` / `containers`.
- `PROBE-B` reports `ariaExpanded` / `historyBtn` / `list` / `empty` / `entries` /
  `items` / `portals` / `containers`.

**Probe positive control** (instrument proven able to observe and report, run under the
known mutation above): `PROBE-A refetchCalls=1 loading=0 notfound=1 retryBtn=1
containers=1`. So a red where the click DID land looks like `refetchCalls=1`.

**Discriminator, stated in advance:**
- natural red with `refetchCalls=0` → **H3 confirmed** (click did not take effect);
- natural red with `refetchCalls=1, loading=0` → click landed, spinner genuinely never
  rendered or was already gone → H3 refuted, look at the effect/timer path instead;
- `containers=2` → the async-`cleanup()` container-leak class (harness fact 6) instead.

## 3. Observations so far (run counts, honest)

- **Local baseline, quiet box:** `AppsSubmitEditView.browser.test.tsx` 9/9 passed,
  failing test 486ms, suite 9.64s. (1 run)
- **Local RED reproduced once**: load 40 synthetic workers + background load ~64.
  `run 1 RED 59767ms | Tests 1 failed | 8 passed (9)` — failing test **15106ms**,
  `Cannot find element with locator: getByTestId('apps-offsite-edit-loading')`,
  `Matcher did not succeed in time`. **Identical signature to CI.** Runs 2-6 green.
  → **1 red / 6 runs.**
- **Warm-cache matrix, load 64** (12 planned): killed at 11 min, **0 reds** observed.
  Warm cache is the wrong regime — CI containers are always cold (CI log shows
  `import 228.35s`).
- **Cold-cache matrix, load 24** (4 planned): killed at ~12 min, **0 reds** observed.
- **Variant B (`loaderCeilingMs=20`), box NOT quiet (other agents running the same
  browser project + load avg ~73):** B1 **passed**, B2 **passed**, B3 cut off by a
  10-minute tool timeout. → does not refute H1 (see note above); need variant C.

⚠️ Measurement hazard actually hit: a second agent is running the **same `component`
project** in `/home/zach/workspace/civit/civitai-blockrenders`. Vitest **auto-incremented
to port 63316** rather than attaching to my server (checked with `ss -lptn`), so no
cross-talk — but it is uncontrolled CPU contention in every timing number above.

## 4. Second failure — MySubmissionsList (NOT yet diagnosed)

`src/components/Apps/MySubmissionsList.browser.test.tsx:906-908`
```
await page.getByTestId('apps-submissions-section-mod-removed-toggle').click();
await page.getByTestId('apps-onsite-history-gone-app').click();
await expect.element(page.getByText('Reported for policy')).toBeInTheDocument();   // FAILS
```
The row lives in a **default-collapsed** `StatusSection`
(`src/components/Apps/submissionsTableUi.tsx:232` — `<Collapse in={open}>`), so the second
click goes through a Mantine height animation.

**Structural finding:** a scan of all 124 `*.browser.test.tsx` files found **exactly two**
tests that click a section/expand toggle and then immediately click an element *inside*
that collapsing section:
- `src/components/Apps/MySubmissionsList.browser.test.tsx:906-907` (the observed failure)
- `src/components/Apps/OffsiteSubmissionsList.browser.test.tsx:383-384` (identical shape,
  sibling exposure — same test, offsite list)

Competing hypotheses, NOT yet discriminated:
- **H2a** the second click does not take effect → modal never opens.
- **H2b** the modal opens but renders the empty state (`historyItems` empty).

The CI failure DOM is truncated (`<div … />`) and cannot distinguish them. **A probe is
required** (assert on `apps-onsite-history-list` vs `-history-empty` vs neither) before
any fix. Note Playwright's `locator.click()` (via `@vitest/browser-playwright`
`dist/index.js:178` → `tester.locator(selector).click()`) has full actionability
auto-waiting, which argues *against* a naive "clicked mid-animation" story — so H2a needs
real evidence, not plausibility.

**Not reproduced locally at all yet.** If it stays unreproduced, say so and do not ship a
speculative fix for it.

## 5. Planned fix for H1 (structural, no window widening)

Split the one test into two, so that **every awaited state is ABSORBING** (nothing can
take it away), instead of racing a self-deleting window:

1. *spinner returns on retry* — start `loaderCeilingMs={30}` → alert; `rerender` with a
   never-elapsing ceiling; **then** click retry → the spinner is absorbing → assert it.
   Includes a **negative control**: assert the spinner is still absent immediately after
   the ceiling widening, so the spinner in step 3 is attributable to the retry and not to
   the prop change re-running the effect.
2. *the re-armed ceiling still elapses* — ceiling stays 30ms and is never changed, so the
   timer that fires is genuinely the re-armed one; both awaited states (alert before the
   click, alert after) are absorbing. This is the test that pins `retryNonce`: drop the
   nonce from the effect deps and the spinner never leaves → deterministic red.

Draft text: `/tmp/claude-1000/.../scratchpad/fix-appssubmit.txt`.

Mutation checks required before shipping:
- delete `setLoaderExpired(false)` from `handleRetry` → test 1 must fail.
- delete `retryNonce` from the effect dep array → test 2 must fail.
- (assert the specific failing message each time, not just "a test failed")

## 6. Bar for shipping
- N ≥ 10 consecutive green post-fix, under the same load regime that produced a red.
- Report base red rate honestly (currently 1/6 observed locally + 2/3 in CI on #3591).
- Do NOT change pipeline blocking behaviour in this PR.

## 7. Housekeeping
- `src/components/Apps/__screenshots__/` gets written on failure — **gitignored, never commit**.
- Delete this notes file before committing.
- `loaderCeilingMs={200}` in the test was temporarily edited to `{20}` for variant B —
  **must be restored** (or replaced wholesale by the fix).

## 8. APPENDIX A — proposed `CLAUDE.md` addition (NOT applied; awaiting review)

Reverted from the working tree pending a decision. Recorded here so it survives.
Rationale: the repo already keeps hard-won test-harness lessons as `####` blocks
under `### Testing`, and this defect class is not specific to the two tests fixed.

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index 1af9e0912f..9acfd405da 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -74,6 +74,17 @@ Use a top-level `import type * as PromClient` — an inline `typeof import('...'
 
 **Before widening a mock, check whether the import edge is needed at all.** A failing suite may be telling you the code pulled in a dependency it doesn't want, not that the mock is too narrow, and widening it would hide that. (Bit us twice in one day, Aug 2026, on two branches; one of those three suites was fixed by extracting the helpers into their own module instead.)
 
+#### Never `await` a browser-test state that DELETES ITSELF
+`expect.element` polls (first attempt immediate, then every 50ms, 15s budget). Waiting for a state to **arrive** is safe — load only makes it arrive later and the matcher keeps polling. Waiting for a state that will **leave** is a race the matcher cannot win: once the state is gone it never comes back, so every remaining poll is also too late. The test then burns the **full 15s budget** before failing — that ~15.0s failing test inside an otherwise-healthy ~80s suite is the signature. It is red on a busy box, green on a quiet one, and has no PR to blame.
+
+Measured on `AppsSubmitEditView` (component instrumented with `performance.now()` timestamps): after an awaited `.click()`, a state the component deletes `N` ms later is observable for **exactly** `N` ms, and the matcher's first poll lands **40–78ms** into that window on an idle box. A test asserting it at `N=200` therefore ran on a ~150ms margin, which a saturated CI box erases. Shrinking `N` to 1ms is an accelerated equivalent (the failure condition is `RPC return leg > window`) and reproduced the CI failure exactly: **8 of 12 runs red at ~15.0s**, versus **12 of 12 green at ~1s** after the fix.
+
+Fixes, in order of preference:
+1. **Make the state absorbing** — drive the component so nothing can take it away (e.g. `rerender` with a ceiling so large the timer can never fire), *then* assert it. Include a negative control proving the prop change alone did not produce the state.
+2. **Don't assert the transient at all** — await the absorbing end-state instead, and pin that the intermediate step happened via a non-DOM observable (a mock call count).
+
+🔴 Do **not** widen the matcher budget, add a `retry`, or enlarge the component's timeout instead. Those convert a fast failure into a slow one and leave the race unwinnable whenever the machine is slow enough — which is exactly when CI runs. The two retry tests in `src/components/Apps/AppsSubmitEditView.browser.test.tsx` are worked examples of both fixes.
+
 ### Database
 ```bash
 pnpm run db:migrate:empty  # Create an empty migration file
```

## 9. APPENDIX B — the temporary PROBE-B instrumentation (MySubmissionsList)

Still uncommitted in the working tree; MUST NOT ship. Recorded so a stray checkout
cannot destroy it while the MySubmissionsList arc is still open.

```diff
diff --git a/src/components/Apps/MySubmissionsList.browser.test.tsx b/src/components/Apps/MySubmissionsList.browser.test.tsx
index 94e30484e0..13c1daf0e6 100644
--- a/src/components/Apps/MySubmissionsList.browser.test.tsx
+++ b/src/components/Apps/MySubmissionsList.browser.test.tsx
@@ -905,7 +905,24 @@ describe('MySubmissionsList — P4 onsite unpublish / republish / history', () =
     // Expand the default-collapsed moderator-removed section to reach the row.
     await page.getByTestId('apps-submissions-section-mod-removed-toggle').click();
     await page.getByTestId('apps-onsite-history-gone-app').click();
-    await expect.element(page.getByText('Reported for policy')).toBeInTheDocument();
+    // TEMP PROBE — remove before commit
+    try {
+      await expect.element(page.getByText('Reported for policy')).toBeInTheDocument();
+    } catch (e) {
+      const q = (s: string) => document.querySelectorAll(`[data-testid="${s}"]`).length;
+      throw new Error(
+        `PROBE-B ariaExpanded=${document
+          .querySelector('[data-testid="apps-submissions-section-mod-removed-toggle"]')
+          ?.getAttribute('aria-expanded')}` +
+          ` historyBtn=${q('apps-onsite-history-gone-app')}` +
+          ` list=${q('apps-onsite-history-list')} empty=${q('apps-onsite-history-empty')}` +
+          ` entries=${q('apps-onsite-history-entry')}` +
+          ` items=${mocks.historyItems.length}` +
+          ` portals=${document.querySelectorAll('[data-portal="true"]').length}` +
+          ` containers=${document.body.querySelectorAll(':scope > div:not([data-portal])').length}` +
+          ` || ${String(e).slice(0, 160)}`
+      );
+    }
     await expect.element(page.getByText('Delisted')).toBeInTheDocument();
     await expect.element(page.getByText('Unpublished by you')).toBeInTheDocument();
     expect(page.getByTestId('apps-onsite-history-entry').elements().length).toBeGreaterThanOrEqual(2);
```
