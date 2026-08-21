# RCA — the App Blocks component-suite flake: an unwinnable race on a self-deleting state

**Date:** 2026-08-05 · **PR:** #3645 · **Status:** one defect fixed; the class is open.

`preview / component-tests` had been intermittently red with no PR to blame — two pipeline
runs on **byte-identical trees** (the second an empty commit on the first) produced opposite
results. It is a **report-only, non-blocking** gate, the combination that trains everyone to
click through, and it had already pushed two merge decisions in opposite directions in a day.

---

## 1. The mechanism

`AppsSubmitEditView.browser.test.tsx` → _"retry RE-ARMS a fresh ceiling"_ awaited a state
that **deletes itself** `loaderCeilingMs` after the click:

```tsx
await page.getByTestId('apps-offsite-edit-retry').click();
await expect.element(page.getByTestId('apps-offsite-edit-loading')).toBeInTheDocument();
```

`expect.element` polls — first attempt immediate, then every 50ms, 15s budget.

> 🔴 **The invariant.** Waiting for a state to **ARRIVE** is safe: load only makes it arrive
> later and the matcher keeps polling. Waiting for a state that will **LEAVE** is a race the
> matcher cannot win — once it is gone it never comes back, so _every_ remaining poll is also
> too late. The failure is **unwinnable**, so it burns the **full 15s budget**.

### ⚠️ The ~15s wall is a CANDIDATE FILTER, not a diagnosis

An earlier draft of this document promoted "a ~15.0s failing test" to a triage heuristic for
this class. **That under-discriminates badly, and the correction is measured:**

- **All four** mutation-injected failures used to verify this fix — none of which is a race —
  also failed at **14.97–15.09s**. Any never-satisfied `expect.element` burns the full budget.
- Two **healthy, passing** tests legitimately run **15.06s / 15.26s**
  (`IframeHostReadyTransition` and `PageBlockHostLaunchReveal` `no_token` terminals, which
  `vi.waitFor` out a real `TOKEN_WAIT_TIMEOUT_MS = 15s`).

So the signature is **necessary but nowhere near sufficient**. It tells you only that _some_
matcher was never satisfied. Use it to shortlist, never to conclude.

**To actually discriminate a self-deleting state from a never-arriving one:**

1. **Read the observable synchronously immediately after the action**, before the matcher
   polls — _present-then-gone_ is a self-deleting state; _never present_ is a state that
   never arrived. (This is what `PROBE-T` did; see Appendix B for the shape.)
2. **Enlarge the component's own window** — the ceiling/debounce/timeout driving the state —
   by orders of magnitude. If the failure disappears, the state was self-deleting; if it
   persists, it never arrived. Diagnostic only: shipping that widening is the papering-over
   this document argues against.
3. Best of all, **instrument the component with `performance.now()` timestamps** and read the
   timeline. That is what settled this case when re-running knobs did not.

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

📌 **Correction (audit).** An earlier draft claimed the shipped `200` was itself a _previous
widening_ of this window. **Git contradicts that**: `loaderCeilingMs={200}` was introduced
_with the test_ at `eab627cdac` (#3432), commented "A comfortable ceiling…", and was never
raised from a smaller value; the earlier flake fix `72b1485034` (#3544) **deleted** a racing
assertion rather than widening one. The "widening loses eventually" argument is still sound,
but it rests on the marketplace example in §4 — which genuinely was widened and lost again —
**not** on this test.

---

## 2. 🔴 The measurement trap that sent a whole round of this investigation the wrong way

An earlier round reported the `loaderCeilingMs={1}` control as **3/3 GREEN**, concluded "the
ceiling does not govern the outcome", declared the mechanism refuted, and moved on to a
different hypothesis. Re-measured, `{1}` is **8 of 12 RED**.

The likely cause: **Vitest's summary lines are ANSI-prefixed**, so a `grep` for the verdict
silently matches nothing and a RED run reads as "no failures". This is written down in our own
gotchas and it still bit — and it bit _twice_, because the first re-measurement this session
made the same mistake before ANSI was stripped (`sed 's/\x1b\[[0-9;]*m//g'`).

**What actually settled it was instrumenting the component and reading a _timeline_, not
re-running the knob.** A knob re-run only ever yields another pass/fail to misread; the
timeline shows the window directly.

Also refuted along the way: the "the awaited `.click()` resolves without its React handler
taking effect" hypothesis — `refetchCalls=1` in **100% of runs including every red**, so the
click always lands. Container count was always 1, so it is not a cleanup/container-leak either.

---

## 3. The fix

Split into two tests so **every awaited state is absorbing**. Production source unchanged.

1. **`retry RE-ARMS the loader`** — widen the ceiling via `rerender` so the returning spinner
   _cannot_ delete itself, then assert it. Includes a **negative control**: after the widening
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

| variant | runs | result              | wall           | slowest test |
| ------- | ---- | ------------------- | -------------- | ------------ |
| before  | 12   | **8 RED / 4 green** | 19–20s on reds | ~15.0s       |
| after   | 12   | **12 / 12 GREEN**   | 4.8–6.1s       | 0.9–1.6s     |

Stated in advance: _NEW going red would have refuted the fix._ It did not.

**Shipped settings under 48 synthetic CPU burners** (load 100–160): after = **11/11 GREEN**.
Before, at shipped settings, was **12/12 GREEN at load up to 121** — i.e. the natural red was
never reproduced locally; see §6.

**Mutation checks** — each guard dies for _its own_ reason and is _not_ killed by the other's,
so neither passes for the other's reason:

| mutation                                                 | test 1                                                          | test 2                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| M1 · delete `setLoaderExpired(false)` from `handleRetry` | **3/3 RED** — `Cannot find element … apps-offsite-edit-loading` | green (test 1 owns it)                                            |
| M2 · drop `retryNonce` from the effect deps              | green (correctly unaffected)                                    | **3/3 RED** — `Cannot find element … apps-offsite-edit-not-found` |

Two further axes, constructed by an independent audit rather than by me — both reproduce the
separation and one closes a gap I had left open:

| mutation                                                              | test 1                                                   | test 2      | what it proves                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| M3 · unconditional `setLoaderExpired(false)` at the top of the effect | **3/3 RED**, in the **negative control's own assertion** | green       | the negative control in test 1 is load-bearing, not decorative                |
| M4 · `setRetryNonce((n) => n)` — deps correct, value never changes    | green                                                    | **3/3 RED** | test 2 pins the nonce's _value changing_, not merely its presence in the deps |

M3 matters because a negative control is the easiest thing in a test to write and never
exercise; it now has a killing mutation of its own.

🔴 **I re-ran M3 and M4 myself rather than citing them, and M4's reported result was
incomplete.** M4 reds **two** tests, not one: test 2 _and_ the pre-existing
`error retry shows a disabled "Retrying…" state … (isFetching)`, which also depends on the
nonce bump forcing a re-render (with `(n) => n` React bails out of the re-render, so the
in-flight state never paints). The _separation_ claim is unaffected — test 1 survives M4 —
but M4 is not a single-test discriminator, and a summary saying it "reds test 2" understates
its blast radius. Verified: M3 `1 failed | 9 passed` ×3; M4 `2 failed | 8 passed` ×3.

Independent verification also confirmed every awaited state in both tests as absorbing against
`AppsSubmitEditView.tsx:63-70`, ran the whole `component` project green at HEAD
(**1254/1254**), and recorded the split as **faster** than what it replaced:
**113 + 147 ms vs 450–494 ms**.

---

## 4. 🔴 This is a CLASS, not one defect

Measured gate health: **3 fails / 19 recent PRs carrying a `component-tests` check (~16%)** —
a _lower bound_, since it reads each PR's latest run and a PR retried until green counts as a
pass.

### Confirmed member #2 — `AppListingsMarketplaceBody.browser.test.tsx:221` (NOT fixed)

_"the search box does NOT write the URL per keystroke — only the debounced value"_

```
AssertionError: expected [ { query: 'mat' } ] to have a length of +0 but got 1
```

Wall **1521ms**, not ~15s — a different _shape_, but the **same family, inverted**: it asserts
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
- ⚠️ **Close one vacuity first:** `toHaveLength(1)` can be satisfied _transiently_ on the way
  to 2, so a "debounce fires twice" bug could slip through. Re-assert the count after the
  `waitFor` settles, or drive the debounce with fake timers.
- Verify with the same instrument: shrink the debounce (accelerated control), N≥10 each side,
  plus a mutation that wires the input straight through.

### ~~Strongly suspected further members~~ — 📌 RETRACTED (audit)

An earlier draft listed four tests as suspected further members purely because they appeared
at ~15.2–15.8s in the §5 run: `the icon form is the one SHOWN at 280 and the text form at
460`, `the Generations label stays unambiguous even with the Runs tooltip mounted`, `does NOT
clobber a name the user already typed`, `selecting a category shows "Explore all apps"`.

**On a clean re-run all four pass, at 27 / 330 / 325 / 240 ms.** Given §1's correction — the
~15s wall does not imply a race — naming them as suspects on that evidence was unjustified.
**No further live member is known.**

### 🔴 An independently-constructed sweep found no additional member either

My own sweep grepped for the _ceiling-prop spelling_, which finds only one shelf of the
hazard — a real weakness. An adversarial audit built the inverse instrument: enumerate
**167 timer-owning modules** → **18** browser tests whose component owns a wall-clock timer →
read every short-window candidate by hand (`ReportTabs.tsx:745`, the scan badge,
`DeleteCard.tsx:57`, `BaseModelInput.tsx:193`, `PageBlockHost`, the four 300ms debounce
components), with a positive control proving the instrument could see a known member.

**Result: no additional live member.** A differently-constructed instrument reaching the same
answer is the strongest form this claim can take — but note it is a claim about _current_
members, not that the class is closed.

### ~~Same shape, but NOT at risk — and the discriminator is the MARGIN, not the shape~~ — 🔴 RETRACTED 2026-08-06, THE WRONG CONSTANT

> **Original claim, preserved:** `PageBlockHost.browser.test.tsx:616,641,773` and
> `PageBlockHostAutoRetry.browser.test.tsx:728` all do `click Retry` → assert a loading state.
> Their state is also technically self-deleting, but the window is `BLOCK_READY_TIMEOUT_MS = 10s`
> (`pageBlockHostLogic.ts:571`) — a **~128× margin** over the measured 40–78ms poll, against the
> **~2.6×** that actually lost. **Deliberately not changed**: no evidence of failure, and touching
> them is speculative churn.

**That is the wrong window, and this paragraph is why the flake survived three more fixes.**

After `driveToFatal()` the host is in a **terminal** state, not `loading`. The timer armed there
is the auto-retry backoff — `AUTO_RETRY_BACKOFF_MS[0] = 2000ms` (`pageBlockHostLogic.ts:577`) —
not `BLOCK_READY_TIMEOUT_MS`. The margin is therefore **~26×**, not ~128×, and it is measured
against a **Playwright driver round-trip**, which this same RCA measured at 40–78ms _on an idle
box_ and elsewhere describes as erased under CI load.

`PageBlockHostAutoRetry.browser.test.tsx:728` subsequently failed in CI on
`pr-preview-3679-lt4xt` (PR #3679) with:

```
AssertionError: expected 'Retrying automatically… (attempt 2 of…' to contain 'attempt 1 of 2'
```

and was reproduced deterministically by inserting a 2.1s sleep before the click — the
byte-identical message, at a comparable runtime (12632ms local vs 13230ms in CI). Fixed by
moving it to the virtual clock + a DOM click.

🔴 **The four `PageBlockHost.browser.test.tsx` sites cleared above are still live members** and
are NOT fixed by that change. The cleanest of them is `error (mint failure): Retry calls
onRetryToken AND returns to loading` — an AUTH terminal, so the automatic attempt _re-mints_,
flipping `expect(onRetryToken).not.toHaveBeenCalled()` to 1 and
`toHaveBeenCalledTimes(1)` to 2.

**Lesson for this document's own method:** the margin argument was sound; the constant fed into
it was not. When clearing a test by margin, name the state the component is actually IN at the
assertion and the timer armed by THAT state — not the most prominent timeout in the file.

---

## 5. Control — the fix does not destabilise the rest of the suite

**Conclusion: confirmed. The supporting numbers: do not quote them forward.**

A full-suite run at HEAD showed ~12 failures and briefly looked like collateral damage. It is
not — but my measurement of _how much_ ambient flake there is did not hold up.

I ran the whole 125-file suite at BASE and at HEAD back-to-back and counted 12 failures each,
9 of them the same tests, with neither rewritten test in either list. I noted at the time that
the runner's `Tests` summary line "did not survive the capture" and counted `×` lines instead.

🔴 **That workaround was the bug. Diagnosed properly on re-run: the summary line was never
printed because THE RUN NEVER FINISHED.** The full-suite run aborts partway with

```
Caused by: Error: [birpc] rpc is closed, cannot call "resolveManualMock"
```

— the browser↔runner WebSocket closes mid-run. Measured on a clean re-capture: **0 summary
lines, only 44 of 125 test files reported, 10 `×` lines.** So my §5 "control" compared two
**truncated, crashing** runs covering roughly a third of the suite, and the `×` counts were
never a failure total at all.

📌 An independent clean run at HEAD reported **`1254/1254` passing at load 64**. That is the
real number. **The "~12 ambient flakes per run" figure is withdrawn — do not cite it.**

**The transferable lesson, which is stronger than the original one:** "count the tests, never
read the exit code" is necessary but not sufficient — _a **missing** summary line is itself
the signal that the run did not complete._ Treating its absence as a capture nuisance to be
worked around, rather than as a failure, is what produced a confident comparison between two
partial runs. Assert the summary line exists **and** that the file count matches expectation
before believing any suite-level number.

⚠️ Scope of the damage: this affects **only** the §5 full-suite control. Every other figure in
this document comes from single-file runs that printed a proper `Tests N passed` line, which
was read directly — the accelerated matrix, the mutation tables, and the MySubmissionsList
hunt are unaffected.

What survives, and is now confirmed from two directions: **this PR does not destabilise the
suite.** The whole `component` project is green at HEAD.

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
- 🔴 **The before-rate is load-dependent and is NOT a general figure.** I measured **8/12 red**
  at load 99–114; an independent reproduction measured **2/12** at load 65–75. Direction and
  signature match exactly (both reds are the racing test at ~15.0s; zero reds on the
  after-set), and the gap is what the load-dependence thesis predicts — but **quote it as
  "8/12 under contention at load 99–114", never as "the flake rate".**
- **Test 2 does not `await` its `renderWithProviders(...)`** (`:257`) while test 1 does
  (`:216`), and `render` in `vitest-browser-react@2.2.0` is async. The bare form is the
  repo-wide norm (~1021 bare vs 62 awaited) so this is not a defect introduced here, but it
  is the mechanism by which test 2's terminal assertion could read a not-yet-committed DOM.
  Worth fixing if that test is ever touched again.

---

## 7. Recommendations

1. **Do not make the gate blocking yet.** Two known defects are still live; flipping it now
   would block merges on known-unfixed intermittent failures. Sequence: fix
   `AppListingsMarketplaceBody` (diagnosed above) → diagnose `MySubmissionsList` → soak
   report-only until clean over a defined window → then flip.
2. **Use the ~15.0s wall to shortlist, not to diagnose** (see §1). It only means some matcher
   was never satisfied — four non-race mutations produce it, and two healthy tests hit ~15s
   and pass. Discriminate with a synchronous read right after the action, or by enlarging the
   component's own window and seeing whether the failure disappears.
3. **Retain CI task logs (or ship the failure summary into the check) long enough to attribute
   a flake.** Two of three failures here were unattributable purely because logs aged out.
4. ✅ **DONE — the absorbing-state rule is documented in `CLAUDE.md`** under `### Testing`,
   alongside the other harness lessons. See Appendix A.

---

## Appendix A — the `CLAUDE.md` addition (✅ APPLIED)

**Applied 2026-08-06** to the root `CLAUDE.md`, as the last `####` block of `### Testing`
(after _Convention guards run as tests_). The applied text is a condensed form of the draft
below — `CLAUDE.md` is loaded every session, so it carries the imperative, the two fixes, the
anti-fix, and the ~15 s correction, and links back here for the evidence. The poll interval
(50 ms) and the 15 s browser-mode `testTimeout` default were re-derived from the installed
`vitest@4.0.18` before shipping. The draft is retained for the record: it is the source the
applied wording was cut down from, not a pending proposal.

```markdown
#### Never `await` a browser-test state that DELETES ITSELF

`expect.element` polls (first attempt immediate, then every 50ms, 15s budget). Waiting for a state to **arrive** is safe — load only makes it arrive later and the matcher keeps polling. Waiting for a state that will **leave** is a race the matcher cannot win: once the state is gone it never comes back, so every remaining poll is also too late. Such a test is red on a busy box, green on a quiet one, and has no PR to blame.

Measured on `AppsSubmitEditView` (component instrumented with `performance.now()` timestamps): after an awaited `.click()`, a state the component deletes `N` ms later is observable for **exactly** `N` ms, and the matcher's first poll lands **40–78ms** into that window on an idle box. A test asserting it at `N=200` therefore ran on a ~150ms margin, which a saturated CI box erases. Shrinking `N` to 1ms is an accelerated equivalent (the failure condition is `RPC return leg > window`) and reproduced the CI failure exactly: **8 of 12 runs red at ~15.0s under contention (load 99–114)**, versus **12 of 12 green at ~1s** after the fix.

⚠️ **A ~15s failing test is a candidate filter, NOT a diagnosis.** It means only that some `expect.element` was never satisfied. Measured: four _non-race_ mutations all failed at 14.97–15.09s, and two **healthy, passing** tests legitimately run 15.06s/15.26s waiting out a real 15s product timeout. To tell a self-deleting state from one that never arrived: read the observable **synchronously right after the action** (present-then-gone vs never-present), or **enlarge the component's own window** and see whether the failure disappears — as a diagnostic only, since shipping that widening is what this rule forbids.

Fixes, in order of preference:

1. **Make the state absorbing** — drive the component so nothing can take it away (e.g. `rerender` with a ceiling so large the timer can never fire), _then_ assert it. Include a negative control proving the prop change alone did not produce the state.
2. **Don't assert the transient at all** — await the absorbing end-state instead, and pin that the intermediate step happened via a non-DOM observable (a mock call count).

🔴 Do **not** widen the matcher budget, add a `retry`, or enlarge the component's timeout instead. Those convert a fast failure into a slow one and leave the race unwinnable whenever the machine is slow enough — which is exactly when CI runs. The two retry tests in `src/components/Apps/AppsSubmitEditView.browser.test.tsx` are worked examples of both fixes.
```

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
