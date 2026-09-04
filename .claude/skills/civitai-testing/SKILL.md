---
name: civitai-testing
description: Deep reference for running and writing tests in the main Civitai app — Vitest worker-count sizing and the queued-run gotcha, why `vi.mock` should spread `importOriginal`, how to check that a reverted fix FAILS legibly instead of hanging, and the browser-test self-deleting-state race. Use when writing or debugging a test, sizing a test run, or reviewing test quality. The hard rules (`--project 'unit*'`, never under `src/pages`, the convention guards) stay in CLAUDE.md.
---

# Civitai testing reference

CLAUDE.md carries the suite list and the non-negotiable rules. This file carries the measurements and
the failure modes behind them.

#### Worker count: uncapped by default, `VITEST_MAX_WORKERS` / `--max-workers` to size it
A suite uses Vitest's own worker count (`cpus - 1` in run mode, `floor(cpus / 2)` in watch; the browser pool `min(12, cpus - 1)`).

```bash
VITEST_MAX_WORKERS=8 pnpm exec vitest run --project 'unit*'   # direct run (BOTH unit projects)
pnpm run test:unit:run --max-workers=8                     # through the dev-server queue
```

🔴 **The env var does not reach a queued run.** With `CIVITAI_TEST_QUEUE` set, `test:unit:run` hands the run to the dev-server daemon, which spawns it with **its own** environment — so `VITEST_MAX_WORKERS=8 pnpm run test:unit:run` silently runs at the full pool while you believe you capped it. The CLI flag is forwarded and does work (verified: 3 distinct `VITEST_POOL_ID`s from a 40-file probe run through the queue with `--max-workers=3`).

⚠️ Either knob sets the count for **every** project, browser included, and it is **not clamped** to the browser pool's 12 — `getThreadsCount` returns it unchanged, so `--max-workers=16` launches 16 Chromium instances, past what upstream calls safe. It sizes the pool; it does not only shrink it.

**Why uncapped is the default.** A flat cap of 8 lived in `vitest.config.mts` (#3900) because several agents each running a full suite at once saturated the box. The dev-server test queue now serialises `test:unit:run` at concurrency 1 (#3947). Measured on a 32-core Windows box, alternating runs through that queue: **8 workers 507.3s / 526.9s, uncapped (31 workers) 281.4s / 295.8s** — 1.79x on the means. Nothing changes on GitHub CI, which runs on 4-vCPU `ubuntu-latest`, where the old cap's `cpus > 9` guard already made it inert.

⚠️ Only `test:unit:run` is queued. `test:component`, `test:packages:run`, `test:apps:run` and `test:lint-rules` call `vitest` directly, so a queued unit run and an unqueued component run still overlap — 31 workers plus 12 Chromium instances, where the old config bounded the pair at 8 + 6. Cap one of them by hand if you are sharing the box.

⚠️ More workers is not monotonically better once other pool settings move: with `--no-isolate` the same box measured 119s at 8 workers and 1025s at 31. Measure both ends before changing one.

⚠️ In a container limited by a **CPU quota** rather than a cpuset, `os.availableParallelism()` reports the host's cores, so an uncapped run resolves to host-cores-1 workers under a much smaller budget. Nothing in this repo invokes Vitest that way — the only CI that does is `ubuntu-latest` — but a pipeline defined outside it should set `VITEST_MAX_WORKERS` explicitly.


#### Prefer `importOriginal` over hand-listed `vi.mock` exports
A `vi.mock` that lists exports by hand couples the test to the **entire transitive import graph** of the thing under test, and nothing warns you when that graph grows. Adding one service import can drag in a module that builds `pLimit`/prom collectors at load (e.g. `~/server/search-index` → `meilisearch/client`), and the suite then fails to load with an error far from the change — `pnpm typecheck` and `pnpm lint` stay green, so **only CI catches it**. Spread the real module and override only what you need:
```ts
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
```
Use a top-level `import type * as PromClient` — an inline `typeof import('...')` trips `consistent-type-imports`.

**Before widening a mock, check whether the import edge is needed at all.** A failing suite may be telling you the code pulled in a dependency it doesn't want, not that the mock is too narrow, and widening it would hide that. (Bit us twice in one day, Aug 2026, on two branches; one of those three suites was fixed by extracting the helpers into their own module instead.)


#### A passing test says nothing about how it FAILS — check the revert
**"The tests would catch a regression here" is a claim about the failure mode, not about coverage.** A green
suite proves current behaviour. Whether a revert is *legible* is a separate property, and it is the one that
decides if the test protects anything. Review your own tests by asking what a reverted fix would look like:
an assertion message, a timeout, or nothing at all.

🔴 **Proving a property by absence of termination is not proof — a test runner cannot observe it.** A fake
that drives a loop and never terminates turns a regression into an infinite loop of `await`-on-already-resolved
promises. That is a pure **microtask** loop: it starves the macrotask queue, and vitest's `testTimeout` is
`setTimeout`-based, so **it never fires**. Measured: 4,194,305 iterations in 4 s with a 300 ms `setTimeout`
that never ran. CI hangs until the job is killed — no assertion failure, no timeout, nothing to read.

So **any fake driving a bounded loop must terminate on its own**, and the test must assert the loop stopped
early. Capping a cursor fake at 50 pages turns an unreportable hang into `expected 51 to be less than 5` in
under a second. Same rule as sizing a slow-path regression test so a revert *fails fast* rather than wedging
the runner — see the `n = 10_000` cap in `session-invalidation.test.ts` and the terminating pages beside it.

Two things this does NOT cover, stated so a green run isn't over-read: the paging guard in
`test:lint-rules` catches cursor-shaped fakes only, so it reduces this class rather than closing it; and a
loop driven by something other than a cursor is still on you to bound.

(The formulation above is @ivy's, from reviewing PR #3756 — where the assertions were all correct and the
failure mode was a hang. Both reviewers checked the assertions; neither asked what a revert would print.)


#### Never `await` a browser-test state that DELETES ITSELF
`expect.element` polls — first attempt immediate, then every **50 ms** — against the test's remaining budget (browser-mode `testTimeout` defaults to **15 s**, and the `component` project does not override it). Awaiting a state to **arrive** is safe: load only makes it arrive later and the matcher keeps polling. Awaiting a state that will **leave** — a spinner on a ceiling, a debounce window, anything a component tears down on a timer — is a race the matcher cannot win: once the state is gone it never comes back, so every remaining poll is also too late. Such a test is green on a quiet box, red on a busy one, and has no PR to blame.

Fix it structurally, in this order:
1. **Make the state absorbing** — drive the component so nothing can take the state away (e.g. `rerender` with a window so large the timer can never fire), *then* assert it. Add a negative control proving the prop change alone did not produce the state.
2. **Don't assert the transient at all** — await the absorbing end-state, and pin that the intermediate step happened via a non-DOM observable (a mock call count).

🔴 Do **not** widen the matcher budget, add a `retry`, or enlarge the component's own timeout instead. Those convert a fast failure into a slow one and leave the race unwinnable whenever the machine is slow enough — which is exactly when CI runs.

⚠️ **A ~15 s failing test is a candidate filter, NOT a diagnosis.** It means only that some `expect.element` was never satisfied: four *non-race* mutations all failed at 14.97–15.09 s, and two **healthy, passing** tests legitimately run 15.06 s / 15.26 s waiting out a real 15 s product timeout. To tell a self-deleting state from one that never arrived, read the observable **synchronously right after the action** (present-then-gone vs never-present), or **enlarge the component's own window** and see whether the failure disappears — diagnostic only, since shipping that widening is what this rule forbids.

Worked examples of both fixes: the two retry tests in `src/components/Apps/AppsSubmitEditView.browser.test.tsx`. Measurements behind every number above: `claudedocs/rca-appblocks-component-suite-flake-2026-08-05.md` (PR #3645).
