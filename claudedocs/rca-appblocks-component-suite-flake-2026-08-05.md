# RCA — the App Blocks component-suite flake: an unwinnable race on a self-deleting state

**Date:** 2026-08-05 · **PR:** #3645 · **Status:** one defect fixed; the class is open.

`preview / component-tests` had been intermittently red with no PR to blame — two pipeline
runs on **byte-identical trees** (the second an empty commit on the first) produced opposite
results. It is a **report-only, non-blocking** gate, the combination that trains everyone to
click through, and it had already pushed two merge decisions in opposite directions in a day.

---

## 1. The mechanism

`AppsSubmitEditView.browser.test.tsx` → *"retry RE-ARMS a fresh ceiling"* awaited a state
that **deletes itself** `loaderCeilingMs` after the click:

```tsx
await page.getByTestId('apps-offsite-edit-retry').click();
await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
```

`expect.element` polls — first attempt immediate, then every 50ms, 15s budget.

> 🔴 **The invariant.** Waiting for a state to **ARRIVE** is safe: load only makes it arrive
> later and the matcher keeps polling. Waiting for a state that will **LEAVE** is a race the
> matcher cannot win — once it is gone it never comes back, so *every* remaining poll is also
> too late. The failure is **unwinnable**, so it burns the **full 15s budget**.

**That 15s burn is the search key for this whole class**: a ~15.0s failing test inside an
otherwise-healthy ~80s suite. A test failing *fast* is a different shape.

### Traced timeline (component instrumented with `performance.now()`)

At the shipped `loaderCeilingMs={200}`, on an idle box:

```
t=805.1   HANDLE-RETRY            <- click lands; spinner appears
t=807.0   effect re-arms ceiling
          first poll reads here   <- click RTT 40-78ms, spinner still present
t=1007.2  timer fires             <- spinner DELETES ITSELF
```

The observable window is exactly `loaderCeilingMs` (202ms measured) and the assertion reads
**40–78ms** into it — a **~150ms margin**, on a shared CI box whose cold module `import`
costs 228s against 0.3s locally.

At `loaderCeilingMs={1}` the window measured **3.3ms** and the assertion missed it, failing at
14986–15021ms — byte-identical to the CI signature.

🔴 The shipped `200` was itself a **previous widening** of this window. It treated the knob.

---

## 2. 🔴 The measurement trap that sent a whole round of this investigation the wrong way

An earlier round reported the `loaderCeilingMs={1}` control as **3/3 GREEN**, concluded "the
ceiling does not govern the outcome", declared the mechanism refuted, and moved on to a
different hypothesis. Re-measured, `{1}` is **8 of 12 RED**.

The likely cause: **Vitest's summary lines are ANSI-prefixed**, so a `grep` for the verdict
silently matches nothing and a RED run reads as "no failures". This is written down in our own
gotchas and it still bit — and it bit *twice*, because the first re-measurement this session
made the same mistake before ANSI was stripped (`sed 's/\x1b\[[0-9;]*m//g'`).

**What actually settled it was instrumenting the component and reading a *timeline*, not
re-running the knob.** A knob re-run only ever yields another pass/fail to misread; the
timeline shows the window directly.

Also refuted along the way: the "the awaited `.click()` resolves without its React handler
taking effect" hypothesis — `refetchCalls=1` in **100% of runs including every red**, so the
click always lands. Container count was always 1, so it is not a cleanup/container-leak either.

---

## 3. The fix

Split into two tests so **every awaited state is absorbing**. Production source unchanged.

1. **`retry RE-ARMS the loader`** — widen the ceiling via `rerender` so the returning spinner
   *cannot* delete itself, then assert it. Includes a **negative control**: after the widening
   the spinner must still be absent, so the spinner in the final step is attributable to the
   retry and not to the prop change re-running the effect.
2. **`retry re-arms a FRESH ceiling`** — never assert the transient at all. Await the absorbing
   end-state (the re-armed ceiling elapsing back to the alert) and pin that the click landed
   via the refetch call count.

🔴 No timeout, `retry`, or matcher window was widened. Those convert a fast failure into a slow
one and leave the race unwinnable whenever the machine is slow enough — i.e. exactly in CI.

### Evidence the fix is structural, not a wider margin

**Accelerated control.** The failure condition is `RPC return leg > window`, so shrinking the
window is equivalent to lengthening the leg — deterministic instead of a load lottery. Every
ceiling in the file set to 1ms; **load 99–114 on both sides** (24-core box):

| variant | runs | result | wall | slowest test |
|---|---|---|---|---|
| before | 12 | **8 RED / 4 green** | 19–20s on reds | ~15.0s |
| after | 12 | **12 / 12 GREEN** | 4.8–6.1s | 0.9–1.6s |

Stated in advance: *NEW going red would have refuted the fix.* It did not.

**Shipped settings under 48 synthetic CPU burners** (load 100–160): after = **11/11 GREEN**.
Before, at shipped settings, was **12/12 GREEN at load up to 121** — i.e. the natural red was
never reproduced locally; see §6.

**Mutation checks** — each guard dies for *its own* reason and is *not* killed by the other's,
so neither passes for the other's reason:

| mutation | test 1 | test 2 |
|---|---|---|
| delete `setLoaderExpired(false)` from `handleRetry` | **3/3 RED** — `Cannot find element … apps-offsite-edit-loading` | green (test 1 owns it) |
| drop `retryNonce` from the effect deps | green (correctly unaffected) | **3/3 RED** — `Cannot find element … apps-offsite-edit-not-found` |

---

## 4. 🔴 This is a CLASS, not one defect

Measured gate health: **3 fails / 19 recent PRs carrying a `component-tests` check (~16%)** —
a *lower bound*, since it reads each PR's latest run and a PR retried until green counts as a
pass.

### Confirmed member #2 — `AppListingsMarketplaceBody.browser.test.tsx:221` (NOT fixed)

*"the search box does NOT write the URL per keystroke — only the debounced value"*

```
AssertionError: expected [ { query: 'mat' } ] to have a length of +0 but got 1
```

Wall **1521ms**, not ~15s — a different *shape*, but the **same family, inverted**: it asserts
a 300ms debounce has **not yet** elapsed (racing an arrival) where ours asserted a state was
**still** present (racing a deletion). Both depend on wall-clock timing against a component
timer.

🔴 **It has already been "fixed" once by widening the margin** — its own comment (lines
206–215) records reducing six `fill()`s to two so they sit "well inside the window on any
machine". CI has now falsified "any machine". This is the strongest available argument for not
papering over this class.

**Follow-up plan (deliberately deferred — it cannot be verified to the N≥10 + mutation bar
without its own cycle):**
- The timing-independent intent is the END state: after the debounce settles there is exactly
  one write carrying the final value — already asserted at lines 224–228.
- Line 221 is the racing assertion. Deleting it keeps the per-keystroke mutation killed:
  straight-through wiring produces TWO writes, so `toHaveLength(1)` never passes and the
  `vi.waitFor` times out red.
- ⚠️ **Close one vacuity first:** `toHaveLength(1)` can be satisfied *transiently* on the way
  to 2, so a "debounce fires twice" bug could slip through. Re-assert the count after the
  `waitFor` settles, or drive the debounce with fake timers.
- Verify with the same instrument: shrink the debounce (accelerated control), N≥10 each side,
  plus a mutation that wires the input straight through.

### Strongly suspected further members

A paired full-suite control (§5) showed failures **on both refs** at **~15.2–15.8s** — the
full-matcher-budget signature — in files nobody has examined:
`the icon form is the one SHOWN at 280 and the text form at 460`,
`the Generations label stays unambiguous even with the Runs tooltip mounted`,
`does NOT clobber a name the user already typed`,
`selecting a category shows "Explore all apps"`.

**Use "failing test at ~15.0s" as the search key rather than chasing test names.**

### Same shape, but NOT at risk — and the discriminator is the MARGIN, not the shape

`PageBlockHost.browser.test.tsx:616,641,773` and `PageBlockHostAutoRetry.browser.test.tsx:728`
all do `click Retry` → assert a loading state. Their state is also technically self-deleting,
but the window is `BLOCK_READY_TIMEOUT_MS = 10s` (`pageBlockHostLogic.ts:571`) — a **~128×
margin** over the measured 40–78ms poll, against the **~2.6×** that actually lost.
**Deliberately not changed**: no evidence of failure, and touching them is speculative churn.

---

## 5. Control — the fix does not destabilise the rest of the suite

A full-suite run at HEAD showed ~12 failures and briefly looked like collateral damage. It is
not. Whole 125-file `component` suite at BASE and at HEAD, back-to-back, same box:

| ref | failing tests | wall | load at start |
|---|---|---|---|
| BASE `54c2ff8e4b` | 12 | 153s | 98.87 |
| HEAD (this PR) | 12 | 139s | 77.59 |

**9 of the 12 are the same tests on both refs**, including one that lives in the edited file
but was never touched. **Neither rewritten test appears in either failure list.** At load
80–120 with other processes competing, this suite flakes ~12 tests per run regardless of ref.

*Instrument caveat:* the runner's `Tests` summary line did not survive the capture, so these
are counts of `×` lines. Both sides were counted identically, so the comparison holds, but
suite totals cannot be quoted from it.

---

## 6. Honest limits

- **No natural red was reproduced at the shipped ceiling** — 12/12 green at load up to 121.
  The reds are the accelerated control plus CI observations. This box could not be starved as
  hard as the shared CI container.
- **`MySubmissionsList.browser.test.tsx` (the other observed CI failure) is unreproduced** —
  **14/14 green at load 152–186**, and unreproduced across two sessions. Its awaited state (the
  moderation-history modal) is **absorbing** — the mocked query returns items synchronously and
  nothing removes them — so it **cannot** be this race. No speculative fix was shipped. Next
  step is CI-side evidence, not more local load.
- **Only 1 of 3 recent CI failures could be attributed to a test**; the other two task pods had
  aged out. So the current mix of causes is not known.
- Verification ran at base `54c2ff8e4b`, not on the merged tree. Mitigating: neither edited
  file, nor `test/component-setup.tsx`, changed on `main` in the intervening commits.

---

## 7. Recommendations

1. **Do not make the gate blocking yet.** Two known defects are still live; flipping it now
   would block merges on known-unfixed intermittent failures. Sequence: fix
   `AppListingsMarketplaceBody` (diagnosed above) → diagnose `MySubmissionsList` → soak
   report-only until clean over a defined window → then flip.
2. **Adopt the ~15.0s triage heuristic** — a component test failing at the full matcher budget
   is almost certainly an unwinnable race, not a slow test.
3. **Retain CI task logs (or ship the failure summary into the check) long enough to attribute
   a flake.** Two of three failures here were unattributable purely because logs aged out.
4. **Consider documenting the absorbing-state rule in `CLAUDE.md`** under `### Testing`, which
   already carries comparable harness lessons. A draft is in Appendix A — **not applied**; that
   call belongs to the repo owners.

---

## Appendix A — proposed `CLAUDE.md` addition (NOT applied)

````markdown
#### Never `await` a browser-test state that DELETES ITSELF
`expect.element` polls (first attempt immediate, then every 50ms, 15s budget). Waiting for a state to **arrive** is safe — load only makes it arrive later and the matcher keeps polling. Waiting for a state that will **leave** is a race the matcher cannot win: once the state is gone it never comes back, so every remaining poll is also too late. The test then burns the **full 15s budget** before failing — that ~15.0s failing test inside an otherwise-healthy ~80s suite is the signature. It is red on a busy box, green on a quiet one, and has no PR to blame.

Measured on `AppsSubmitEditView` (component instrumented with `performance.now()` timestamps): after an awaited `.click()`, a state the component deletes `N` ms later is observable for **exactly** `N` ms, and the matcher's first poll lands **40–78ms** into that window on an idle box. A test asserting it at `N=200` therefore ran on a ~150ms margin, which a saturated CI box erases. Shrinking `N` to 1ms is an accelerated equivalent (the failure condition is `RPC return leg > window`) and reproduced the CI failure exactly: **8 of 12 runs red at ~15.0s**, versus **12 of 12 green at ~1s** after the fix.

Fixes, in order of preference:
1. **Make the state absorbing** — drive the component so nothing can take it away (e.g. `rerender` with a ceiling so large the timer can never fire), *then* assert it. Include a negative control proving the prop change alone did not produce the state.
2. **Don't assert the transient at all** — await the absorbing end-state instead, and pin that the intermediate step happened via a non-DOM observable (a mock call count).

🔴 Do **not** widen the matcher budget, add a `retry`, or enlarge the component's timeout instead. Those convert a fast failure into a slow one and leave the race unwinnable whenever the machine is slow enough — which is exactly when CI runs. The two retry tests in `src/components/Apps/AppsSubmitEditView.browser.test.tsx` are worked examples of both fixes.
````

## Appendix B — probe instrumentation for continuing the `MySubmissionsList` hunt

Temporary; must not ship. Reports, on failure, whether the click's side effect occurred —
which discriminates "the modal never opened" from "it opened empty".

```tsx
// in the failing test, wrap the assertion:
try {
  await expect.element(page.getByText('Reported for policy')).toBeInTheDocument();
} catch (e) {
  const q = (s: string) => document.querySelectorAll(`[data-testid="${s}"]`).length;
  throw new Error(
    `PROBE-B ariaExpanded=${document
      .querySelector('[data-testid="apps-submissions-section-mod-removed-toggle"]')
      ?.getAttribute('aria-expanded')}` +
      ` historyBtn=${q('apps-onsite-history-gone-app')}` +
      ` list=${q('apps-onsite-history-list')} empty=${q('apps-onsite-history-empty')}` +
      ` entries=${q('apps-onsite-history-entry')}` +
      ` items=${mocks.historyItems.length}` +
      ` || ${String(e).slice(0, 160)}`
  );
}
```

Reading it: `list>=1` with a ~15.0s wall would mean the content appeared and left (absorbing is
wrong). `historyBtn=1, list=0, empty=0` means the modal never opened — a different fix.
Note the `apps-onsite-history-{list,empty,entry}` testids are built from a `${testIdPrefix}`
template in `ownerListingModals.tsx`, so grepping `MySubmissionsList.tsx` for them finds
nothing and wrongly suggests the probe is inert.
